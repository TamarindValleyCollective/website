// The real ImportStore (finance-import.ts): Supabase over PostgREST with the service role, and the private R2 bucket.
// Writes go through the fin_store_* functions (migration 0080) so a file is stored whole or not at all.
import { rest } from './staff-mfa-store';
import { logFinanceAction } from './finance-audit';
import { deleteFinanceImport, putFinanceImport } from './finance-storage';
import type { Account, ImportStore } from './finance-import';

const PAGE = 1000;

async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = (await (await rest(`${path}&limit=${PAGE}&offset=${offset}`)).json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const rpc = async (name: string, body: unknown) => Number(await (await rest(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) })).json());

export function supabaseImportStore(): ImportStore {
  let entityId: string | null = null;
  return {
    async entity() {
      const rows = (await (await rest('/fin_entities?select=id,circle_tag&order=created_at.asc&limit=1')).json()) as { id: string; circle_tag: string }[];
      if (!rows[0]) throw new Error('No finance entity');
      entityId = rows[0].id;
      return { id: rows[0].id, circleTag: rows[0].circle_tag };
    },
    async accounts(): Promise<Account[]> {
      const rows = await all<{ id: string; label: string; last4: string | null; upi_label: string | null }>('/fin_bank_accounts?select=id,label,last4,upi_label&active=eq.true&kind=eq.bank&order=created_at.asc');
      return rows.map((r) => ({ id: r.id, label: r.label, last4: r.last4, upiLabel: r.upi_label }));
    },
    async heldBank(accountId, from, to) {
      const batches = await all<{ file_hash: string; period_from: string; period_to: string; opening_paise: number; closing_paise: number }>(
        `/fin_import_batches?select=file_hash,period_from,period_to,opening_paise,closing_paise&bank_account_id=eq.${accountId}&source=eq.axis_statement&order=period_from.asc`,
      );
      const lines = await all<{ tran_date: string; dedupe_key: string }>(
        `/fin_bank_lines?select=tran_date,dedupe_key&bank_account_id=eq.${accountId}&tran_date=gte.${from}&tran_date=lte.${to}&order=tran_date.asc,created_at.asc,id.asc`,
      );
      return {
        batches: batches.map((b) => ({ fileHash: b.file_hash, from: b.period_from, to: b.period_to, openingPaise: b.opening_paise, closingPaise: b.closing_paise })),
        lines: lines.map((l) => ({ tranDate: l.tran_date, dedupeKey: l.dedupe_key })),
      };
    },
    async heldHashes(hashes) {
      const out: string[] = [];
      for (const part of chunks(hashes, 40)) {
        const rows = (await (await rest(`/fin_import_batches?select=file_hash&file_hash=in.(${part.join(',')})`)).json()) as { file_hash: string }[];
        out.push(...rows.map((r) => r.file_hash));
      }
      return out;
    },
    async heldUpiRefs(refs) {
      const out: string[] = [];
      for (const part of chunks(refs, 80)) {
        const rows = (await (await rest(`/fin_upi_lines?select=upi_ref&upi_ref=in.(${part.join(',')})`)).json()) as { upi_ref: string }[];
        out.push(...rows.map((r) => r.upi_ref));
      }
      return out;
    },
    putRaw: putFinanceImport,
    deleteRaw: deleteFinanceImport,
    // One round trip per file (a single database function in one transaction), so thousands of lines are not a loop.
    storeBank: (batch, lines) => rpc('fin_store_bank_batch', { p_batch: batch, p_lines: lines }),
    storeUpi: (batch, lines) => rpc('fin_store_upi_batch', { p_batch: batch, p_lines: lines }),
    async unlinkedUpi() {
      const rows = await all<{ id: string; upi_ref: string; amount_paise: number; direction: string }>('/fin_upi_lines?select=id,upi_ref,amount_paise,direction&bank_line_id=is.null&ignored=eq.false&order=paid_at.asc,id.asc');
      return rows.map((r) => ({ id: r.id, upiRef: r.upi_ref, amountPaise: r.amount_paise, direction: r.direction }));
    },
    async bankLinesByRrn(rrns) {
      const out: { id: string; upiRrn: string; amountPaise: number; direction: string }[] = [];
      for (const part of chunks([...new Set(rrns)], 80)) {
        const rows = (await (await rest(`/fin_bank_lines?select=id,upi_rrn,amount_paise,direction&upi_rrn=in.(${part.join(',')})`)).json()) as { id: string; upi_rrn: string; amount_paise: number; direction: string }[];
        out.push(...rows.map((r) => ({ id: r.id, upiRrn: r.upi_rrn, amountPaise: r.amount_paise, direction: r.direction })));
      }
      return out;
    },
    async link(links) {
      let n = 0;
      for (const part of chunks(links, 500)) n += await rpc('fin_link_upi_lines', { p_links: part.map((l) => ({ upi_id: l.upiId, bank_id: l.bankId })) });
      return n;
    },
    async reconciliationData() {
      const upi = await all<{ paid_at: string; amount_paise: number; bank_line_id: string | null }>('/fin_upi_lines?select=paid_at,amount_paise,bank_line_id&ignored=eq.false&order=paid_at.asc,id.asc');
      const bank = await all<{ id: string; tran_date: string; upi_rrn: string }>('/fin_bank_lines?select=id,tran_date,upi_rrn&upi_rrn=not.is.null&order=tran_date.asc,id.asc');
      const linked = new Set((await all<{ bank_line_id: string }>('/fin_upi_lines?select=bank_line_id&bank_line_id=not.is.null&order=id.asc')).map((r) => r.bank_line_id));
      const last = (await (await rest('/fin_bank_lines?select=tran_date&order=tran_date.desc&limit=1')).json()) as { tran_date: string }[];
      const first = (await (await rest('/fin_upi_lines?select=paid_at&order=paid_at.asc&limit=1')).json()) as { paid_at: string }[];
      const since = (await (await rest('/fin_entities?select=paytm_since&order=created_at.asc&limit=1')).json()) as { paytm_since: string | null }[];
      return {
        upiLines: upi.map((u) => ({ paidAt: u.paid_at, amountPaise: u.amount_paise, bankLineId: u.bank_line_id })),
        bankLines: bank.map((b) => ({ tranDate: b.tran_date, upiRrn: b.upi_rrn, linked: linked.has(b.id) })),
        lastBankDate: last[0]?.tran_date ?? null,
        // The day Paytm came into use, when known; else the first row held. Earlier bank UPI debits have no Paytm row.
        firstUpiDate: since[0]?.paytm_since ?? first[0]?.paid_at ?? null,
      };
    },
    async audit(entry) {
      await logFinanceAction({ actorId: entry.actorId, action: entry.action, entityId: entry.entityId ?? entityId ?? undefined, detail: entry.detail });
    },
    async heldBatchSpans() {
      const rows = await all<{ bank_account_id: string; period_from: string; period_to: string }>('/fin_import_batches?select=bank_account_id,period_from,period_to&source=eq.axis_statement&order=period_from.asc');
      return rows.map((r) => ({ accountId: r.bank_account_id, from: r.period_from, to: r.period_to }));
    },
  };
}
