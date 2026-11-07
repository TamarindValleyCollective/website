// Orchestrates a statement import (docs/finance/sessions/03-statement-import.md). It owns no storage: everything that
// touches Supabase or R2 goes through an `ImportStore`, so the whole flow is testable with a fake. The rules
// themselves live in scripts/lib/finance-*.mjs (pure, tested): parsing a file (step 1) is kept apart from planning
// and storing the normalised lines (step 2), so another source, such as a bank API later, could feed step 2.
//
// preview: parse and plan, write nothing. commit: the same plan, then store what is acceptable. A file that is
// blocked (broken balance chain, a year that does not meet its neighbour, a conflicting overlap, an unreadable file)
// is reported and skipped; the other files in the same upload still go through.
import { createHash, randomUUID } from 'node:crypto';
import { readWorkbook } from '../../../scripts/lib/finance-xlsx.mjs';
import { parseAxisStatement } from '../../../scripts/lib/finance-axis-statement.mjs';
import { parsePaytmExport } from '../../../scripts/lib/finance-paytm.mjs';
import { coverageOf, planBankImport } from '../../../scripts/lib/finance-import-plan.mjs';
import { isBhimText, parseBhimStatement } from '../../../scripts/lib/finance-bhim.mjs';
import { linkUpiToBank, planBhimImport, planUpiImport, reconciliationSummary } from '../../../scripts/lib/finance-upi-plan.mjs';
import { extractText, getDocumentProxy } from 'unpdf';

export type Account = { id: string; label: string; last4: string | null; upiLabel: string | null };
type Held = { batches: { fileHash: string; from: string; to: string; openingPaise: number; closingPaise: number }[]; lines: { tranDate: string; dedupeKey: string }[] };

export interface ImportStore {
  entity(): Promise<{ id: string; circleTag: string }>;
  accounts(): Promise<Account[]>;
  heldBank(accountId: string, from: string, to: string): Promise<Held>;
  heldHashes(hashes: string[]): Promise<string[]>;
  heldUpiRefs(refs: string[]): Promise<string[]>;
  putRaw(key: string, bytes: Uint8Array): Promise<void>;
  deleteRaw(key: string): Promise<void>;
  storeBank(batch: Record<string, unknown>, lines: Record<string, unknown>[]): Promise<number>;
  storeUpi(batch: Record<string, unknown>, lines: Record<string, unknown>[]): Promise<number>;
  unlinkedUpi(): Promise<{ id: string; upiRef: string; amountPaise: number; direction: string }[]>;
  bankLinesByRrn(rrns: string[]): Promise<{ id: string; upiRrn: string; amountPaise: number; direction: string }[]>;
  link(links: { upiId: string; bankId: string }[]): Promise<number>;
  reconciliationData(): Promise<{ upiLines: { paidAt: string; amountPaise: number; bankLineId: string | null }[]; bankLines: { tranDate: string; upiRrn: string | null; linked: boolean }[]; lastBankDate: string | null; firstUpiDate: string | null }>;
  audit(entry: { actorId: string; action: string; entityId: string; detail: Record<string, unknown> }): Promise<void>;
  heldBatchSpans(): Promise<{ accountId: string; from: string; to: string }[]>;
}

export type UploadedFile = { name: string; bytes: Uint8Array };

type Parsed =
  | { kind: 'axis_statement'; statement: ReturnType<typeof parseAxisStatement> }
  | { kind: 'paytm_upi'; parsed: ReturnType<typeof parsePaytmExport> }
  | { kind: 'bhim_upi'; parsed: ReturnType<typeof parseBhimStatement> };

// The file types the importer knows. One entry per source: how to tell the file is one of these, and how to read it.
// Adding a source is one entry here plus its pure parser (scripts/lib/finance-*.mjs) and tests.
export const FILE_TYPES = [
  { kind: 'axis_statement', label: 'Axis Bank statement', accepts: ['.xlsx'] },
  { kind: 'paytm_upi', label: 'Paytm UPI export', accepts: ['.xlsx'] },
  { kind: 'bhim_upi', label: 'BHIM transaction history', accepts: ['.pdf'] },
] as const;

const isPdf = (bytes: Uint8Array) => bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF"

async function classify(bytes: Uint8Array): Promise<Parsed> {
  if (isPdf(bytes)) {
    // pdf.js empties the buffer it is given, and the caller still has to store these bytes, so hand it a copy.
    const pdf = await getDocumentProxy(bytes.slice());
    const { text } = await extractText(pdf, { mergePages: true });
    const joined = Array.isArray(text) ? text.join('\n') : text;
    if (isBhimText(joined)) return { kind: 'bhim_upi', parsed: parseBhimStatement(joined) };
    throw new Error('This PDF is not a BHIM transaction history (no Transaction History heading and Payment ID/Reference Number column).');
  }
  const sheets = readWorkbook(bytes);
  const names = sheets.map((s) => s.name.trim().toLowerCase());
  if (names.includes('summary') && names.some((n) => n.startsWith('passbook'))) return { kind: 'paytm_upi', parsed: parsePaytmExport(sheets) };
  const first = sheets.find((s) => s.rows.some((r) => String(r[0] ?? '').trim().toLowerCase() === 's.no'));
  if (first) return { kind: 'axis_statement', statement: parseAxisStatement(first.rows) };
  throw new Error('This is not a file the importer knows: an Axis statement (Excel), a Paytm UPI export (Excel) or a BHIM transaction history (PDF).');
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const safeName = (n: string) => n.split(/[\\/]/).pop()!.replace(/[^\w.\- ()']/g, '_').slice(0, 120) || 'upload.xlsx';

export type FileResult = {
  name: string;
  kind: 'axis_statement' | 'paytm_upi' | 'bhim_upi' | 'unknown';
  status: 'ok' | 'blocked' | 'duplicate_file' | 'unreadable';
  accountLabel?: string;
  message?: string;
  errors?: unknown[];
  boundaries?: unknown[];
  counts?: Record<string, number>;
  period?: { from: string | null; to: string | null };
  firstDate?: string | null;
  lastDate?: string | null;
  ignored?: unknown;
  failed?: unknown[];
  wouldLink?: number;
  unsuccessful?: { count: number; totalPaise: number };
  stored?: boolean;
};

export async function runImport(args: { store: ImportStore; files: UploadedFile[]; commit: boolean; actorId: string }) {
  const { store, files, commit, actorId } = args;
  const entity = await store.entity();
  const accounts = await store.accounts();
  const results: FileResult[] = files.map((f) => ({ name: safeName(f.name), kind: 'unknown', status: 'unreadable' }));

  // 1. Parse each file on its own; one bad file never fails the rest.
  const axis: { index: number; id: string; fileHash: string; statement: ReturnType<typeof parseAxisStatement>; account?: Account }[] = [];
  const paytm: { index: number; id: string; fileHash: string; parsed: ReturnType<typeof parsePaytmExport> }[] = [];
  const bhim: { index: number; id: string; fileHash: string; parsed: ReturnType<typeof parseBhimStatement> }[] = [];
  for (const [index, f] of files.entries()) {
    try {
      const p = await classify(f.bytes);
      results[index].kind = p.kind;
      const base = { index, id: String(index), fileHash: sha256(f.bytes) };
      if (p.kind === 'axis_statement') axis.push({ ...base, statement: p.statement });
      else if (p.kind === 'bhim_upi') bhim.push({ ...base, parsed: p.parsed });
      else paytm.push({ ...base, parsed: p.parsed });
    } catch (err) {
      results[index].message = err instanceof Error ? err.message : 'The file could not be read.';
    }
  }

  // 2. Bank statements: group by account, plan each group against what that account holds.
  const coverage: { accountId: string; label: string; intervals: { from: string; to: string }[]; gaps: { from: string; to: string }[] }[] = [];
  const storedBank: { index: number; plan: any; account: Account; batchId: string }[] = [];
  const groups = new Map<string, typeof axis>();
  for (const a of axis) {
    const account = accounts.find((x) => x.last4 && x.last4 === a.statement.accountLast4);
    if (!account) {
      Object.assign(results[a.index], {
        status: 'blocked',
        errors: [{ type: 'account_not_registered', last4: a.statement.accountLast4 }],
        message: 'No bank account is registered with this statement’s last four digits. Add the account first.',
      });
      continue;
    }
    a.account = account;
    groups.set(account.id, [...(groups.get(account.id) ?? []), a]);
  }
  for (const [accountId, group] of groups) {
    const account = group[0].account!;
    const from = group.reduce((m, g) => (g.statement.from < m ? g.statement.from : m), group[0].statement.from);
    const to = group.reduce((m, g) => (g.statement.to > m ? g.statement.to : m), group[0].statement.to);
    const held = await store.heldBank(accountId, from, to);
    const plan = planBankImport({ accountId, incoming: group.map((g) => ({ id: g.id, fileHash: g.fileHash, statement: g.statement })), held });
    coverage.push({ accountId, label: account.label, ...plan.coverage });
    for (const b of plan.batches) {
      const g = group.find((x) => x.id === b.id)!;
      Object.assign(results[g.index], {
        status: b.status,
        accountLabel: account.label,
        errors: b.errors,
        boundaries: b.boundaries,
        counts: b.counts,
        period: { from: b.period.from, to: b.period.to },
        firstDate: b.firstDate,
        lastDate: b.lastDate,
      });
      if (b.status === 'ok') storedBank.push({ index: g.index, plan: b, account, batchId: randomUUID() });
    }
  }

  // 3. Paytm exports.
  const accountsWithUpi = accounts.filter((a) => a.upiLabel);
  const storedUpi: { index: number; plan: any; batchId: string; source: 'paytm_upi' | 'bhim_upi' }[] = [];
  const hashHeld = new Set(await store.heldHashes([...paytm, ...bhim].map((p) => p.fileHash)));
  const refsInUpload = [...new Set([...paytm, ...bhim].flatMap((p) => p.parsed.lines.map((l: { upiRef: string | null }) => l.upiRef).filter(Boolean) as string[]))];
  const heldRefs = new Set(await store.heldUpiRefs(refsInUpload));
  const refsTaken = new Set<string>();
  for (const p of paytm) {
    const plan = planUpiImport({
      file: { id: p.id, fileHash: p.fileHash, parsed: p.parsed },
      accounts: accountsWithUpi,
      circleTag: entity.circleTag,
      held: { fileHashes: [...hashHeld], refs: [...heldRefs, ...refsTaken] },
    });
    plan.newLines.forEach((l: { upiRef: string }) => refsTaken.add(l.upiRef));
    Object.assign(results[p.index], {
      status: plan.status,
      counts: plan.counts,
      period: plan.period,
      firstDate: plan.firstDate,
      lastDate: plan.lastDate,
      ignored: plan.ignored,
      failed: plan.failed,
      errors: plan.errors,
    });
    if (plan.status === 'ok') {
      hashHeld.add(p.fileHash);
      storedUpi.push({ index: p.index, plan, batchId: randomUUID(), source: 'paytm_upi' });
    }
  }

  // 3b. BHIM histories (PDF). Their rows are UPI rows too; a reference Paytm already holds is counted, not stored twice.
  for (const b of bhim) {
    const plan = planBhimImport({
      file: { id: b.id, fileHash: b.fileHash, parsed: b.parsed },
      accounts,
      held: { fileHashes: [...hashHeld], refs: [...heldRefs, ...refsTaken] },
    });
    plan.newLines.forEach((l: { upiRef: string }) => refsTaken.add(l.upiRef));
    Object.assign(results[b.index], {
      status: plan.status,
      counts: plan.counts,
      period: plan.period,
      firstDate: plan.firstDate,
      lastDate: plan.lastDate,
      ignored: plan.ignored,
      failed: plan.failed,
      errors: plan.errors,
      unsuccessful: plan.unsuccessful,
    });
    if (plan.status === 'ok') {
      hashHeld.add(b.fileHash);
      storedUpi.push({ index: b.index, plan, batchId: randomUUID(), source: 'bhim_upi' });
    }
  }

  // What the new UPI rows would link to right now (shown on the preview; the real linking happens after commit).
  for (const u of storedUpi) {
    const kept = u.plan.newLines.filter((l: { ignored: boolean }) => !l.ignored);
    const bank = await store.bankLinesByRrn(kept.map((l: { upiRef: string }) => l.upiRef));
    results[u.index].wouldLink = linkUpiToBank({ upiLines: kept.map((l: any) => ({ id: l.upiRef, upiRef: l.upiRef, amountPaise: l.amountPaise, direction: l.direction })), bankLines: bank }).links.length;
  }

  if (!commit) return { mode: 'preview' as const, files: results, coverage, reconciliation: null };

  // 4. Commit. The audit entry comes first: nothing changes in the ledger tables without a record that it was asked for.
  const planned = [...storedBank, ...storedUpi];
  if (planned.length) {
    await store.audit({
      actorId,
      action: 'finance.import_committed',
      entityId: entity.id,
      detail: { files: planned.map((p) => ({ source: results[p.index].kind, ...(results[p.index].counts ?? {}) })) },
    });
  }
  for (const b of storedBank) {
    const key = `finance/imports/${b.batchId}.xlsx`;
    await store.putRaw(key, files[b.index].bytes);
    try {
      await store.storeBank(
        {
          id: b.batchId, entity_id: entity.id, bank_account_id: b.account.id, file_name: results[b.index].name, file_hash: b.plan.fileHash, r2_key: key,
          period_from: b.plan.period.from, period_to: b.plan.period.to, opening_paise: b.plan.period.openingPaise, closing_paise: b.plan.period.closingPaise,
          first_line_date: b.plan.firstDate, last_line_date: b.plan.lastDate, duplicate_count: b.plan.counts.alreadyHeld, boundaries: b.plan.boundaries, imported_by: actorId,
        },
        b.plan.newLines.map((l: any) => ({ tran_date: l.tranDate, value_date: l.valueDate, narration: l.narration, direction: l.direction, amount_paise: l.amountPaise, balance_paise: l.balancePaise, upi_rrn: l.upiRrn, dedupe_key: l.dedupeKey })),
      );
      results[b.index].stored = true;
    } catch (err) {
      await store.deleteRaw(key).catch(() => {});
      results[b.index].status = 'blocked';
      results[b.index].message = 'The file could not be saved; nothing was stored from it.';
      console.error('[finance-import] storeBank failed', err instanceof Error ? err.message : err);
    }
  }
  for (const u of storedUpi) {
    const key = `finance/imports/${u.batchId}.${u.source === 'bhim_upi' ? 'pdf' : 'xlsx'}`;
    await store.putRaw(key, files[u.index].bytes);
    try {
      await store.storeUpi(
        {
          id: u.batchId, entity_id: entity.id, source: u.source, file_name: results[u.index].name, file_hash: u.plan.fileHash, r2_key: key, period_from: u.plan.period.from, period_to: u.plan.period.to,
          first_line_date: u.plan.firstDate, last_line_date: u.plan.lastDate, inserted_count: u.plan.counts.new, duplicate_count: u.plan.counts.alreadyHeld,
          ignored_count: u.plan.counts.ignored, ignored_total_paise: u.plan.ignored.totalPaise, failed_count: u.plan.counts.failed, failed_rows: u.plan.failed, imported_by: actorId,
        },
        u.plan.newLines.map((l: any) => ({ bank_account_id: l.accountId, paid_at: l.paidAt, paid_time: l.time, details: l.details, counterparty: l.counterparty, account_label: l.accountLabel, direction: l.direction, amount_paise: l.amountPaise, upi_ref: l.upiRef, order_id: l.orderId, remarks: l.remarks, tag: l.tag, is_circle: l.isCircle, ignored: l.ignored, ignored_reason: l.ignoredReason, app: l.app ?? 'paytm' })),
      );
      results[u.index].stored = true;
    } catch (err) {
      await store.deleteRaw(key).catch(() => {});
      results[u.index].status = 'blocked';
      results[u.index].message = 'The file could not be saved; nothing was stored from it.';
      console.error('[finance-import] storeUpi failed', err instanceof Error ? err.message : err);
    }
  }

  // 5. Join UPI rows and bank lines by reference, whichever arrived last.
  let linked = 0;
  if (results.some((r) => r.stored)) {
    const awaiting = await store.unlinkedUpi();
    const bank = await store.bankLinesByRrn(awaiting.map((u) => u.upiRef));
    const { links } = linkUpiToBank({ upiLines: awaiting, bankLines: bank });
    if (links.length) linked = await store.link(links);
  }
  const reconciliation = { linkedNow: linked, ...(await reconciliationOf(store)) };
  return { mode: 'commit' as const, files: results, coverage, reconciliation };
}

export async function reconciliationOf(store: ImportStore) {
  return reconciliationSummary(await store.reconciliationData());
}

// Coverage per account as held now, for the imports page (no upload involved).
export async function heldCoverage(store: ImportStore) {
  const accounts = await store.accounts();
  const spans = await store.heldBatchSpans();
  return accounts
    .filter((a) => spans.some((s) => s.accountId === a.id))
    .map((a) => ({ accountId: a.id, label: a.label, ...coverageOf(spans.filter((s) => s.accountId === a.id)) }));
}
