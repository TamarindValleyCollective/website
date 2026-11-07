// The UPI view (/internal/finance/upi/): every UPI row from the BHIM history and the Paytm export, whether
// each is joined to a bank line, and the circle spend per calendar month against the allowance. Read-only; the rules are
// in scripts/lib/finance-upi-circle.mjs. Rows ignored at import (an account that is not ours) are not shown.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { loadNotes } from './finance-notes';
import { CIRCLE_CAP_PAISE, bankWithoutUpiRow, circleMonths, matchState } from '../../../scripts/lib/finance-upi-circle.mjs';

type Json = Record<string, any>;
const PAGE = 1000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function all(path: string): Promise<Json[]> {
  const out: Json[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = (await (await rest(`${path}&limit=${PAGE}&offset=${offset}`)).json()) as Json[];
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

export async function listUpiLines(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  try {
    const [upi, bank, last, accounts, notes] = await Promise.all([
      all('/fin_upi_lines?select=id,paid_at,paid_time,app,counterparty,remarks,tag,amount_paise,direction,is_circle,upi_ref,bank_account_id,bank_line_id&ignored=eq.false&order=paid_at.desc,paid_time.desc.nullslast,id.asc'),
      all('/fin_bank_lines?select=id,bank_account_id,tran_date,direction,amount_paise,upi_rrn&upi_rrn=not.is.null&order=tran_date.asc,id.asc'),
      rest('/fin_bank_lines?select=tran_date&order=tran_date.desc&limit=1').then((r) => r.json() as Promise<Json[]>),
      all('/fin_bank_accounts?select=id,label&order=created_at.asc'),
      loadNotes(),
    ]);
    const lastBankDate: string | null = last[0]?.tran_date ?? null;
    // A UPI app can pay from any linked account, so a row's account is its own when the file named it, else the account of
    // the bank line it is joined to; a row with neither (its statement not imported yet) has no account yet.
    const accountName = new Map(accounts.map((a) => [a.id as string, a.label as string]));
    const bankAccount = new Map(bank.map((b) => [b.id as string, b.bank_account_id as string]));
    const lines = upi.map((u) => ({
      id: u.id as string, paidAt: u.paid_at as string, time: (u.paid_time as string | null)?.slice(0, 5) ?? null, app: u.app as 'bhim' | 'paytm',
      counterparty: u.counterparty as string | null, remark: u.remarks as string | null, amountPaise: Number(u.amount_paise), direction: u.direction as 'debit' | 'credit',
      isCircle: Boolean(u.is_circle), upiRef: u.upi_ref as string, note: notes.get(`upi:${u.upi_ref}`) ?? null, account: accountName.get((u.bank_account_id ?? bankAccount.get(u.bank_line_id)) as string) ?? null, bankLineId: u.bank_line_id as string | null,
    }));
    const withState = lines.map((l) => ({ ...l, state: matchState(l, lastBankDate) as 'matched' | 'waiting' | 'unmatched' }));
    const linkedIds = new Set(lines.map((l) => l.bankLineId).filter(Boolean) as string[]);
    const firstUpiDate = lines.reduce<string | null>((m, l) => (m === null || l.paidAt < m ? l.paidAt : m), null);
    return json({
      canEdit: (capabilitiesForRole('finance', auth.staff.role) as string[]).includes('allocate'),
      lines: withState,
      months: circleMonths(lines),
      capPaise: CIRCLE_CAP_PAISE,
      lastBankDate,
      bankWithoutRow: bankWithoutUpiRow(
        bank.map((b) => ({ id: b.id, tranDate: b.tran_date, direction: b.direction, amountPaise: Number(b.amount_paise), upiRrn: b.upi_rrn })), linkedIds, firstUpiDate,
      ),
    });
  } catch (err) {
    console.error('[finance-upi-view] list failed', err instanceof Error ? err.message : err);
    return json({ error: 'Server error' }, 500);
  }
}
