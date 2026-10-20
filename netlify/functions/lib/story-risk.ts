// Risk-based publishing of member stories (docs/plans/member-portal.md, "Risk-based publishing").
// When a member submits a public story it is assessed (scripts/lib/member-risk.mjs: fixed rules plus
// the model's judgement) and the assessment is recorded in member_story_assessments.
//
// In SHADOW mode (the default, member_settings key story_autopublish) that is all that happens: a person
// still approves everything and the staff queue shows what the assessment would have done, so it can be
// compared with the core team's own decisions before it is trusted.
// In LIVE mode, and not paused, a low-risk story is approved here at once and a high-risk one is held
// and the core team is emailed with a summary. A story that is not going on the public site is always low.
import { restHeaders } from '../../../scripts/lib/supabase.mjs';
import { callAnthropic } from './anthropic';
import { checkDailyCap } from './rate-limit';
import { sendStaffAlert } from './refund-alert';
import { escapeHtml } from './email-layout';
import { deleteMemberPhoto } from './member-photo-storage';
import { isUploadedPhoto } from '../../../scripts/lib/member-photo.mjs';
import { RISK_SYSTEM, assessRules, combine, describeChange, outcomeFor, parseModelRisk, riskPrompt } from '../../../scripts/lib/member-risk.mjs';
import { SETTING_KEY, actsAutomatically, parseSettings } from '../../../scripts/lib/member-autopublish.mjs';

const RISK_MODEL = process.env.STORY_RISK_MODEL || process.env.STORY_REVIEW_MODEL || 'claude-sonnet-5';
const RISK_STORE = 'member-story-risk';
const RISK_GLOBAL_DAILY = 200;
const RISK_TIMEOUT_MS = 15_000;
const QUEUE_URL = 'https://tvc.farm/internal/members/';

function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return url;
}

async function sb(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<{ ok: boolean; status: number; rows: any[] }> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: restHeaders(init.prefer ? { Prefer: init.prefer } : {}),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const rows = res.ok ? await res.json().catch(() => []) : [];
  return { ok: res.ok, status: res.status, rows: Array.isArray(rows) ? rows : [] };
}

export async function loadSettings() {
  const r = await sb(`member_settings?select=value&key=eq.${SETTING_KEY}`);
  if (!r.ok) throw new Error(`settings load failed: ${r.status}`);
  return parseSettings(r.rows[0]);
}

export type StoryRow = { person_id: string; draft?: any; submitted: any; submitted_public: boolean; submitted_at: string; approved: any; approved_public: boolean | null };

// The model's view, or null when it was not run or did not give a usable answer (which the rules treat as "held for a person").
async function askModel(row: StoryRow): Promise<{ level: string; reasons: string[] } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    if (!(await checkDailyCap(RISK_STORE, 'all', RISK_GLOBAL_DAILY))) return null;
    const reply = await Promise.race([
      callAnthropic({ apiKey, model: RISK_MODEL, maxTokens: 300, system: [{ type: 'text', text: RISK_SYSTEM }], messages: [{ role: 'user', content: riskPrompt({ submitted: row.submitted, approved: row.approved }) }] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RISK_TIMEOUT_MS)),
    ]);
    return reply && reply.ok ? parseModelRisk(reply.text) : null;
  } catch (err) {
    console.error('[story-risk] model call failed', err);
    return null;
  }
}

export function assess(row: StoryRow, model: { level: string; reasons: string[] } | null) {
  const rules = assessRules({ submitted: row.submitted, submittedPublic: !!row.submitted_public, approved: row.approved, approvedPublic: row.approved_public });
  return combine(rules, model, { public: !!row.submitted_public });
}

async function record(row: StoryRow, a: ReturnType<typeof assess>, mode: string) {
  const r = await sb('member_story_assessments?on_conflict=person_id,submitted_at', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: { person_id: row.person_id, submitted_at: row.submitted_at, is_public: !!row.submitted_public, level: a.level, reasons: a.reasons, assessed_by: a.assessedBy, mode, outcome: outcomeFor(a), decision: null, decided_at: null },
  });
  if (!r.ok) console.error('[story-risk] could not record the assessment', r.status);
}

// What a person's approval does, done by the system for a low-risk story: the same change decideStory makes
// (members-admin.mts), filtered on the exact submission so a resubmission can never be approved by mistake.
async function approveBySystem(row: StoryRow): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await sb(`member_stories?person_id=eq.${row.person_id}&status=eq.in_review&submitted_at=eq.${encodeURIComponent(row.submitted_at)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { status: 'approved', approved: row.submitted, approved_public: row.submitted_public, approved_at: now, reviewed_by: null, reviewer_note: null, updated_at: now },
  });
  if (!r.ok || r.rows.length === 0) return false;
  // The live photo this replaces goes once no copy refers to it, as when a person approves.
  const replaced = row.approved?.photo;
  if (isUploadedPhoto(replaced) && replaced !== row.submitted?.photo && replaced !== row.draft?.photo) await deleteMemberPhoto(row.person_id, replaced).catch((err) => console.error('[story-risk] photo cleanup failed', err));
  await sb(`member_story_assessments?person_id=eq.${row.person_id}&submitted_at=eq.${encodeURIComponent(row.submitted_at)}`, { method: 'PATCH', prefer: 'return=minimal', body: { decision: 'auto_approved', decided_at: now } });
  return true;
}

function emailBody(name: string, a: ReturnType<typeof assess>, row: StoryRow): string {
  const change = describeChange({ submitted: row.submitted, approved: row.approved });
  const reasons = a.reasons.filter((r: any) => r.code !== 'unassessed').map((r: any) => `<li>${escapeHtml(r.text)}</li>`).join('');
  const fields = change.fields
    .map((f: any) => `<li><strong>${escapeHtml(f.label)}</strong>${f.was ? `<br><span style="color:#57604f;">Before: ${escapeHtml(f.was)}</span>` : ''}<br>Now: ${escapeHtml(f.now)}</li>`)
    .join('');
  const links = change.newLinks.map((l: any) => `<li>“${escapeHtml(l.label)}” → ${escapeHtml(l.href)}</li>`).join('');
  return `<p style="margin-top:0;"><strong>${escapeHtml(name)}</strong> has submitted a story for tvc.farm that needs a person to look at it. It has <strong>not</strong> been published, and the version already on the site is unchanged.</p>
  <p style="margin-bottom:4px;"><strong>Why it was held</strong></p><ul style="padding-left:18px;">${reasons}</ul>
  ${fields ? `<p style="margin-bottom:4px;"><strong>What changed</strong></p><ul style="padding-left:18px;">${fields}</ul>` : ''}
  ${links ? `<p style="margin-bottom:4px;"><strong>Links</strong></p><ul style="padding-left:18px;">${links}</ul>` : ''}
  ${change.photo ? `<p>Photo ${change.photo}. Open the queue to see it.</p>` : ''}
  <p style="margin-bottom:0;">Approve or send it back in the <a href="${QUEUE_URL}">member register</a>, under "Stories waiting for review". Nothing else needs doing: low-risk stories are published without an email.</p>`;
}

/**
 * Called after a story is submitted. Never throws: the member's submission has already succeeded, and a
 * problem here only means the story waits for a person, as it always has.
 * Returns whether the system approved it (so the caller can return the fresh state to the member).
 */
export async function assessSubmission(row: StoryRow, memberName: string): Promise<{ approved: boolean }> {
  try {
    const settings = await loadSettings();
    const model = row.submitted_public ? await askModel(row) : null;
    const a = assess(row, model);
    await record(row, a, settings.mode);
    if (!actsAutomatically(settings)) return { approved: false };

    if (outcomeFor(a) === 'publish') return { approved: await approveBySystem(row) };
    if (a.notify) {
      await sendStaffAlert(`A member story needs a look: ${memberName}`, emailBody(memberName, a, row)).catch((err) => console.error('[story-risk] alert email failed', err));
    }
    return { approved: false };
  } catch (err) {
    console.error('[story-risk] assessment failed', err);
    return { approved: false };
  }
}

// ---- the daily build ---------------------------------------------------------

const LAST_AUTO_KEY = 'last_auto_publish';

// When the public site was last rebuilt for stories: a person pressing the button (staff audit log) or the daily job.
export async function lastPublishAt(): Promise<string | null> {
  const [manual, auto] = await Promise.all([sb('staff_audit_log?select=at&action=eq.members.site.publish&order=at.desc&limit=1'), sb(`member_settings?select=value&key=eq.${LAST_AUTO_KEY}`)]);
  const times = [manual.rows[0]?.at, auto.rows[0]?.value?.at].filter(Boolean) as string[];
  return times.length ? times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] : null;
}

export async function recordAutoPublish(at: string): Promise<void> {
  await sb('member_settings?on_conflict=key', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { key: LAST_AUTO_KEY, value: { at }, updated_at: at } });
}

// Public stories approved since the last publish.
export async function waitingPublicStories(): Promise<number> {
  const last = await lastPublishAt();
  const r = await sb('member_stories?select=person_id,approved_at&approved_public=eq.true&limit=2000');
  return r.rows.filter((x) => !last || Date.parse(x.approved_at) > Date.parse(last)).length;
}
