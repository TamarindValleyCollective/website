// Netlify Function (v2 API) backing the two enquiry forms on /contact
// (membership enquiry, general enquiry). Netlify Forms already handles the
// actual email — both forms submit natively (data-netlify="true"), and
// core-team@tvc.farm is added as a notification recipient for each form in the
// Netlify dashboard, same as the existing Visit inquiry form. This Function
// exists purely for the second requirement neither Netlify Forms nor any
// other piece of this site already does: logging each enquiry as a row in a
// Google Sheet. Rather than duplicating the whole submission as a second,
// competing form post, the page's <script> fires this alongside the native
// submission via navigator.sendBeacon — a fire-and-forget POST designed
// specifically to survive the page navigating away right after, which a
// plain fetch() issued in the same submit handler isn't guaranteed to do.
import { appendSheetRow } from '../../scripts/lib/google-drive.mjs';

interface EnquiryPayload {
  formType?: string;
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  botField?: string;
}

const SHEETS: Record<string, { envVar: string; range: string }> = {
  membership: { envVar: 'MEMBERSHIP_ENQUIRY_SHEET_ID', range: 'Sheet1!A:E' },
  general: { envVar: 'GENERAL_ENQUIRY_SHEET_ID', range: 'Sheet1!A:E' },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let payload: EnquiryPayload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  // Honeypot — a real submitter never sees or fills this field. Silent
  // no-op rather than an error, so a bot can't tell its submission was
  // dropped, matching the honeypot's purpose on every other form here.
  if (payload.botField) return jsonResponse({ ok: true });

  const sheet = payload.formType ? SHEETS[payload.formType] : undefined;
  if (!sheet) return jsonResponse({ error: 'formType must be "membership" or "general"' }, 400);

  const name = (payload.name ?? '').trim();
  const email = (payload.email ?? '').trim();
  const message = (payload.message ?? '').trim();
  if (!name || !email || !message) {
    return jsonResponse({ error: 'name, email, and message are required' }, 400);
  }
  const phone = (payload.phone ?? '').trim();

  const sheetId = process.env[sheet.envVar];
  if (!sheetId) {
    console.error(`Missing ${sheet.envVar}`);
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    await appendSheetRow(sheetId, sheet.range, [new Date().toISOString(), name, email, phone, message]);
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('Failed to append enquiry row', err);
    // The Netlify Forms submission (email) still went through independently
    // of this call, so a Sheets outage here doesn't lose the enquiry
    // entirely — just the row for it. 502 rather than 200 so this is still
    // visible in function logs/monitoring.
    return jsonResponse({ error: 'Failed to reach Google Sheets' }, 502);
  }
};

export const config = {
  path: '/api/enquiry',
};
