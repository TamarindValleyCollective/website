// The switch for risk-based publishing, and what the staff panel shows about how the assessment has done.
// Pure: netlify/functions/members-admin.mts and the daily job read and write the rows with these.
//
// mode "shadow": every story is assessed and shown to the core team with what the assessment would
//   have done, but a person still approves everything and nothing is published or emailed by itself.
// mode "live": a low-risk story is approved at once, a high-risk one is held and the core team emailed,
//   and a daily job starts the site build when approved public stories are waiting.
// `paused` stops the daily build and the automatic approvals without leaving live mode: anything
//   submitted while paused waits for a person.

export const SETTING_KEY = 'story_autopublish';
export const MODES = ['shadow', 'live'];

export function parseSettings(row) {
  const v = row && typeof row === 'object' ? row.value ?? row : null;
  return { mode: v?.mode === 'live' ? 'live' : 'shadow', paused: v?.paused === true };
}

// Whether a new submission is approved and emailed by the system, or left for a person.
export const actsAutomatically = (settings) => settings.mode === 'live' && !settings.paused;

/**
 * How the assessment has done against the core team's own decisions, from assessment rows.
 * "agreed" means the person did what the assessment would have: approved a story it called low, or
 * did not approve one unchanged that it called high. The one that matters is `missed`: a story it
 * called low that a person then rejected, which is what the rules have to be tightened for.
 */
export function shadowStats(rows) {
  const out = { assessed: rows.length, low: 0, high: 0, decided: 0, missed: 0, overHeld: 0 };
  for (const r of rows) {
    if (r.level === 'low') out.low++;
    else out.high++;
    if (r.decision === 'approved' || r.decision === 'rejected') {
      out.decided++;
      if (r.level === 'low' && r.decision === 'rejected') out.missed++;
      if (r.level === 'high' && r.decision === 'approved') out.overHeld++;
    }
  }
  return out;
}
