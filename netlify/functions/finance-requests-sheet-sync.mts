// Netlify scheduled function (daily, 07:00 IST; no HTTP path) — reads the "Fund Transfer Request" Google Sheet and adds any
// new rows to payment requests / spend logs, so the UPI page and the ledger keep pulling their purposes from the sheet while
// people still fill it in. Insert-only and idempotent (scripts/lib/finance-requests-sheet-sync.mjs, shared with the operator
// script scripts/load-fin-requests-history.mjs): a row already loaded is skipped, and a row edited after loading is not updated.
//
// Needs FIN_REQUESTS_SHEET_ID (the spreadsheet id, kept out of the repo) in Netlify, the sheet shared with the Drive service
// account, and the same Supabase / payee-key variables the finance functions already hold. Without the sheet id it does nothing.
// Failures are recorded in fin_audit_log (finance.requests_sheet_sync_failed) and in the function log; counts only, never content.
import type { Config } from '@netlify/functions';
import { syncRequestsSheet } from '../../scripts/lib/finance-requests-sheet-sync.mjs';
import { restHeaders } from '../../scripts/lib/supabase.mjs';

async function recordFailure(message: string) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_audit_log`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ action: 'finance.requests_sheet_sync_failed', detail: { error: message.slice(0, 200) } }),
    });
  } catch (err) {
    console.error('[finance-requests-sheet-sync] could not record the failure', err);
  }
}

export default async (): Promise<Response> => {
  const sheetId = process.env.FIN_REQUESTS_SHEET_ID;
  if (!sheetId) {
    console.warn('[finance-requests-sheet-sync] FIN_REQUESTS_SHEET_ID is not set; nothing to do');
    return new Response(JSON.stringify({ ok: true, skipped: 'no sheet id' }), { status: 200 });
  }
  try {
    const r = await syncRequestsSheet({ sheetId, apply: true, auditAction: 'finance.requests_sheet_synced' });
    console.log(`[finance-requests-sheet-sync] inserted ${r.written} (${r.requests} requests, ${r.logs} logs); already loaded ${r.duplicates}; no name ${r.noName}`);
    return new Response(JSON.stringify({ ok: true, inserted: r.written }), { status: 200 });
  } catch (err: any) {
    console.error('[finance-requests-sheet-sync] failed', err);
    await recordFailure(String(err?.message ?? err));
    return new Response('Sync failed', { status: 500 });
  }
};

export const config: Config = {
  schedule: '30 1 * * *', // 01:30 UTC = 07:00 IST
};
