// What the Usage page's "WhatsApp account health" shows at a glance: how many message templates there are, how many
// are approved, which ones need attention, and whether the phone number is in good standing.
//
// Meta never lists templates to us; it pushes notices (the whatsapp_health_events table, written by
// whatsapp-webhook.mts). So the numbers combine three things we do have:
//   defined   the templates the site can send (WHATSAPP_TEMPLATES in netlify/functions/lib/whatsapp-templates.ts)
//   approved  the ones listed in the WHATSAPP_APPROVED_TEMPLATES setting (the site only sends those)
//   events    Meta's notices, newest first; the newest notice about a template decides whether it has a problem
// A template with no notice at all is taken as fine. That is the honest limit of this view, and the page says so.

// "Template rejected: tvc_x" -> the status word and the name. Titles come from classifyHealthEvent.
const TEMPLATE_TITLE = /^Template (approved|reinstated|rejected|flagged|paused|disabled|quality (?:green|yellow|red)): (.+)$/;
const BAD = new Set(['rejected', 'flagged', 'paused', 'disabled', 'quality yellow', 'quality red']);

// events: [{ title, detail, severity, created_at }] newest first
export function summarizeWhatsAppHealth(defined, approvedSetting, events) {
  const approved = new Set(approvedSetting);
  const newest = new Map(); // template name -> its newest notice
  let phone = null;
  for (const e of events) {
    const hit = TEMPLATE_TITLE.exec(e.title ?? '');
    if (hit) {
      if (!newest.has(hit[2])) newest.set(hit[2], { status: hit[1], event: e });
    } else if (phone === null && /^(Phone number flagged|Phone number no longer flagged|Messaging limit (lowered|raised))/.test(e.title ?? '')) {
      phone = e;
    }
  }

  const templates = defined.map((name) => {
    const notice = newest.get(name);
    const problem = notice && BAD.has(notice.status) ? notice.event : null;
    const state = problem ? 'attention' : approved.has(name) ? 'approved' : 'waiting';
    return { name, state, note: problem ? `${problem.title.replace(/^Template /, '')}${problem.detail ? ` (${problem.detail})` : ''}` : null, at: problem?.created_at ?? null };
  });

  const count = (state) => templates.filter((t) => t.state === state).length;
  return {
    total: templates.length,
    approved: count('approved'),
    waiting: count('waiting'),
    attention: count('attention'),
    templates,
    phone: phone
      ? { state: phone.severity === 'info' ? 'ok' : 'attention', title: phone.title, detail: phone.detail, at: phone.created_at }
      : { state: 'quiet', title: null, detail: null, at: null },
  };
}
