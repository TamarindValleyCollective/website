// The UPI view (/internal/finance/upi/): every UPI row from the BHIM history and the Paytm export, whether
// each is joined to a bank line, and the circle spend per calendar month against the allowance. Read-only; the rules are
// in scripts/lib/finance-upi-circle.mjs. Rows ignored at import (an account that is not ours) are not shown.
// Each row also says whether the person behind it is in the Parties register (scripts/lib/finance-upi-parties.mjs); the one write here is the
// reviewed add of the people who are not (addUpiParties), through the same party helpers the Parties page uses.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { fingerprintFinanceText } from './staff-mfa-crypto';
import { addUpiParty, attachUpiToParty } from './finance-parties';
import { logFinanceAction } from './finance-audit';
import { partyStateFor } from '../../../scripts/lib/finance-upi-parties.mjs';
import { PARTY_KINDS } from '../../../scripts/lib/finance-parties.mjs';
import { loadNotes } from './finance-notes';
import { loadPurposes } from './finance-requests';
import { loadDelegateLinks, loadDelegates } from './finance-delegates';
import { loadOperators } from './finance-upi-operators';
import { readVpaAnswers } from './finance-vpa';
import { payeeFieldVisibility } from '../../../scripts/lib/finance-access.mjs';
import { vpaFieldsFor, vpaIn } from '../../../scripts/lib/finance-vpa.mjs';
import { attribute, delegateLabel } from '../../../scripts/lib/finance-delegates.mjs';
import { pairReversals } from '../../../scripts/lib/finance-reversals.mjs';
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

// operator_id exists once migration 0101 is applied; before that the rows load without it.
const withOperator = (path: string) => all(path.replace('select=', 'select=operator_id,')).catch(() => all(path));

// The register and the saved UPI ID lookups, in the shape partyStateFor wants. The UPI IDs parties already hold are compared by their keyed
// fingerprint, never decrypted. Before migration 0102 there are no lookups, and without the finance key no fingerprints: both just mean fewer matches.
async function loadPartyContext() {
  const [parties, accounts, answers] = await Promise.all([
    all('/fin_parties?select=id,name,kind&active=eq.true&merged_into=is.null&order=id.asc').catch(() => [] as Json[]),
    all('/fin_party_accounts?select=party_id,fingerprint,verified_name&method=eq.upi&status=neq.superseded&order=id.asc')
      .catch(() => all('/fin_party_accounts?select=party_id,fingerprint&method=eq.upi&status=neq.superseded&order=id.asc'))
      .catch(() => [] as Json[]),
    readVpaAnswers().catch(() => ({ names: {} as Record<string, string>, known: new Set<string>() })),
  ]);
  const fingerprintOf = (vpa: string): string | null => {
    try {
      return fingerprintFinanceText(vpa);
    } catch {
      return null;
    }
  };
  const byFingerprint = new Map(accounts.map((a) => [a.fingerprint as string, { partyId: a.party_id as string, verifiedName: (a.verified_name as string | null) ?? null }]));
  return { parties: parties as { id: string; name: string; kind?: string }[], byFingerprint, fingerprintOf, answers };
}

export async function listUpiLines(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  try {
    const [upi, bank, last, accounts, notes, purposeOf, delegates, picks, operators, partyCtx] = await Promise.all([
      withOperator('/fin_upi_lines?select=id,paid_at,paid_time,app,counterparty,remarks,tag,amount_paise,direction,is_circle,upi_ref,bank_account_id,bank_line_id&ignored=eq.false&order=paid_at.desc,paid_time.desc.nullslast,id.asc'),
      all('/fin_bank_lines?select=id,bank_account_id,tran_date,direction,amount_paise,upi_rrn&upi_rrn=not.is.null&order=tran_date.asc,id.asc'),
      rest('/fin_bank_lines?select=tran_date&order=tran_date.desc&limit=1').then((r) => r.json() as Promise<Json[]>),
      all('/fin_bank_accounts?select=id,label&order=created_at.asc'),
      loadNotes(),
      loadPurposes(),
      loadDelegates(),
      loadDelegateLinks(),
      loadOperators(),
      loadPartyContext(),
    ]);
    const vpaAnswers = partyCtx.answers;
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    const canSeeUpiIds = payeeFieldVisibility(capabilities).payeeBankDetails as boolean;
    const lastBankDate: string | null = last[0]?.tran_date ?? null;
    // A UPI app can pay from any linked account, so a row's account is its own when the file named it, else the account of
    // the bank line it is joined to; a row with neither (its statement not imported yet) has no account yet.
    const accountName = new Map(accounts.map((a) => [a.id as string, a.label as string]));
    const bankAccount = new Map(bank.map((b) => [b.id as string, b.bank_account_id as string]));
    const lines = upi.map((u) => ({
      id: u.id as string, paidAt: u.paid_at as string, time: (u.paid_time as string | null)?.slice(0, 5) ?? null, app: u.app as 'bhim' | 'paytm',
      counterparty: u.counterparty as string | null, remark: u.remarks as string | null, amountPaise: Number(u.amount_paise), direction: u.direction as 'debit' | 'credit',
      // The UPI ID in "Paid to" and the registered name Razorpay gave for it (src: scripts/lib/finance-vpa.mjs); derived, never stored on the row.
      ...(vpaFieldsFor(u.counterparty, vpaAnswers, canSeeUpiIds) as { upiId: string | null; vpaName: string | null; vpaState: 'named' | 'asked' | 'new' | null }),
      // Whether this person is in the Parties register, and what a reviewed add would do (scripts/lib/finance-upi-parties.mjs).
      party: partyStateFor({ counterparty: u.counterparty as string | null, direction: u.direction as string }, partyCtx) as Json,
      isCircle: Boolean(u.is_circle), operatorId: (u.operator_id as string | null) ?? null, upiRef: u.upi_ref as string, note: notes.get(`upi:${u.upi_ref}`) ?? null, purpose: purposeOf({ upiRef: u.upi_ref, upiLineId: u.id, bankLineId: u.bank_line_id }) as string | null, account: accountName.get((u.bank_account_id ?? bankAccount.get(u.bank_line_id)) as string) ?? null, bankLineId: u.bank_line_id as string | null,
    }));
    // Who each delegated payment belongs to: a pick, else the one delegate active that day (scripts/lib/finance-delegates.mjs).
    const byId = new Map(delegates.map((d) => [d.id, d]));
    const attributed = lines.map((l) => {
      const a = attribute(l, delegates, picks) as { delegateId: string | null; how: 'assigned' | 'auto' | 'ambiguous' | 'none' | null };
      const d = a.delegateId ? byId.get(a.delegateId) : undefined;
      return { ...l, delegateId: a.delegateId, delegate: d ? delegateLabel(d) : null, delegateHow: a.how };
    });
    const withState = attributed.map((l) => ({ ...l, state: matchState(l, lastBankDate) as 'matched' | 'waiting' | 'unmatched' }));
    const linkedIds = new Set(lines.map((l) => l.bankLineId).filter(Boolean) as string[]);
    const firstUpiDate = lines.reduce<string | null>((m, l) => (m === null || l.paidAt < m ? l.paidAt : m), null);
    const bankLines = bank.map((b) => ({ id: b.id as string, tranDate: b.tran_date as string, direction: b.direction as 'debit' | 'credit', amountPaise: Number(b.amount_paise), upiRrn: b.upi_rrn as string }));
    // A payment the bank reversed (a credit under the same reference) needs no UPI record.
    const reversed = pairReversals(bankLines.map((b) => ({ id: b.id, date: b.tranDate, direction: b.direction, amountPaise: b.amountPaise, upiRrn: b.upiRrn }))).byLine;
    return json({
      canEdit: capabilities.includes('allocate'),
      canConfigure: capabilities.includes('configure'),
      canSeeUpiIds,
      lines: withState,
      delegates,
      operators,
      // Delegated payments no delegate could be worked out for: two were active (pick one) or none was (add the delegate, or their dates).
      needsDelegate: attributed.filter((l) => l.delegateHow === 'ambiguous').length,
      notIdentified: attributed.filter((l) => l.delegateHow === 'none').length,
      months: circleMonths(attributed, CIRCLE_CAP_PAISE, delegates),
      capPaise: CIRCLE_CAP_PAISE,
      lastBankDate,
      bankWithoutRow: bankWithoutUpiRow(bankLines, linkedIds, firstUpiDate, new Set(reversed.keys())),
      reversedCount: reversed.size / 2,
    });
  } catch (err) {
    console.error('[finance-upi-view] list failed', err instanceof Error ? err.message : err);
    return json({ error: 'Server error' }, 500);
  }
}

// POST /upi-lines/add-parties { items: [{ rowId, name?, kind? }] }: the reviewed add. Each item names one UPI row; the server works out for itself
// what that row needs (never the page's say-so) and does only what its state allows: a person nobody matches is ADDED to Parties with the UPI
// ID attached unverified, and an ID whose name matches a party is ATTACHED to that party (unverified). A second admin verifies later. `name` and
// `kind` are what the reviewer edited the suggested ones to. Rows for the same person are done once. Audited with counts, never a name or ID.
export async function addUpiParties(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  let body: Json | null = null;
  try {
    body = (await req.json()) as Json;
  } catch {
    /* handled below */
  }
  const items = Array.isArray(body?.items) ? (body!.items as Json[]).filter((i) => i && typeof i.rowId === 'string' && /^[\w-]{1,64}$/.test(i.rowId)).slice(0, 100) : [];
  if (!items.length) return json({ error: 'Choose who to add.' }, 400);
  try {
    const rowIds = [...new Set(items.map((i) => i.rowId as string))];
    const [found, ctx] = await Promise.all([all(`/fin_upi_lines?select=id,counterparty,direction&id=in.(${rowIds.join(',')})&order=id.asc`), loadPartyContext()]);
    const byRow = new Map(found.map((r) => [r.id as string, r]));
    const result = { added: 0, attached: 0, skipped: 0, reasons: [] as string[] };
    const skip = (why: string) => {
      result.skipped++;
      if (!result.reasons.includes(why)) result.reasons.push(why);
    };
    const done = new Set<string>();
    for (const item of items) {
      const row = byRow.get(item.rowId as string);
      if (!row) {
        skip('A payment is no longer there.');
        continue;
      }
      const vpa = vpaIn(row.counterparty as string | null);
      const state = partyStateFor({ counterparty: row.counterparty as string | null, direction: row.direction as string }, ctx) as Json;
      const key = vpa ?? `name:${String(row.counterparty ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
      if (done.has(key)) continue;
      done.add(key);
      if (state.state === 'missing') {
        const name = typeof item.name === 'string' && item.name.trim() ? item.name : (state.name as string);
        const kind = typeof item.kind === 'string' && (PARTY_KINDS as string[]).includes(item.kind) && item.kind !== 'member' ? item.kind : (state.kind as string);
        const made = await addUpiParty(auth.staff.id, { name, kind, upi: vpa });
        if ('error' in made) skip(made.error);
        else result.added++;
      } else if (state.state === 'attach' && vpa) {
        const attached = await attachUpiToParty(auth.staff.id, state.partyId as string, vpa);
        if ('error' in attached) skip(attached.error);
        else result.attached++;
      } else {
        skip('Someone has already dealt with this one.');
      }
    }
    const entity = ((await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json()) as Json[])[0]?.id as string | undefined;
    await logFinanceAction({ actorId: auth.staff.id, entityId: entity, action: 'finance.upi_parties_added', target: 'upi-lines', detail: { added: result.added, attached: result.attached, skipped: result.skipped } });
    return json(result);
  } catch (err) {
    console.error('[finance-upi-view] add parties failed', err instanceof Error ? err.message : err);
    return json({ error: 'Server error' }, 500);
  }
}
