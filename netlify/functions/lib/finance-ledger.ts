// The ledger routes behind /api/finance-admin (docs/finance/sessions/05-ledger-and-review.md): bank lines and their
// allocations, the review queue, categorisation rules, categories and period close.
// Rules of the game live in scripts/lib/finance-allocation.mjs and finance-rules.mjs (pure, tested); the database repeats the
// money rules (supabase/migrations/0083_finance_ledger.sql) so a bug here cannot post a line that does not add up.
//
// What is audited: every save, review decision, rule change, category change and period close, with ids and counts only
// (never a name, narration or amount). The audit row is written BEFORE the change; if it cannot be written, nothing changes.
import { requireStaff } from './staff-access';
import { rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { logFinanceAction } from './finance-audit';
import { financialYearOf, lineState, periodOf, periodWriteDecision, planPosting, planReversal } from '../../../scripts/lib/finance-allocation.mjs';
import { REVIEW_REASONS, partyNeeded, reviewReasons, validateRule } from '../../../scripts/lib/finance-rules.mjs';
import { buildHistory, suggest } from '../../../scripts/lib/finance-suggest.mjs';
import { SORT_KEYS, compareRows, describeCondition, matchAmount, matchDate, matchText, parseAmount, parseDate, parseText } from '../../../scripts/lib/finance-columns.mjs';

type Json = Record<string, any>;
export const LEDGER_ID = /^[0-9a-f-]{36}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const CATEGORY_TYPES = ['opex', 'capex', 'revenue', 'member_contribution', 'sinking_fund', 'interest', 'tax', 'reimbursement', 'transfer'];
const PAGE = 100;

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (error: string, status = 400, extra: Json = {}) => jsonResponse({ error, ...extra }, status);
const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];

// Supabase's API returns at most 1,000 rows per request, whatever `limit` is asked for, so anything that may hold more
// (bank lines, allocations) is read a page at a time. `path` must carry its own `order=` ending in a unique column, or the
// pages can overlap or skip rows. Never rely on `limit=` above 1000 in this file.
const PAGE_SIZE = 1000;
// The first three pages are asked for together (each round trip to the database costs 200-500 ms), so up to 3,000 rows take
// one wait instead of three; anything beyond that is read a page at a time.
const FIRST_PAGES = 3;
async function rowsAll(path: string): Promise<Json[]> {
  const first = await Promise.all(Array.from({ length: FIRST_PAGES }, (_, i) => rows(`${path}&limit=${PAGE_SIZE}&offset=${i * PAGE_SIZE}`)));
  const out: Json[] = [];
  for (const page of first) {
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
  for (let offset = FIRST_PAGES * PAGE_SIZE; ; offset += PAGE_SIZE) {
    const page = await rows(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
}

// Reference data that changes rarely (categories, parties, projects, rules, account states, bank accounts) is kept for a few
// seconds, so a burst of sorting, searching and paging does not re-read it every time. Any write through finance-admin clears it
// (clearLedgerCache, called from finance-admin.mts); another warm instance may serve it for up to CACHE_MS after a write.
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
export const clearLedgerCache = () => cache.clear();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}
const rpc = async (name: string, body: Json) => (await rest(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) })).json();

async function readBody(req: Request): Promise<Json | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Json) : null;
  } catch {
    return null;
  }
}
async function entityId(): Promise<string> {
  const e = await rows('/fin_entities?select=id&order=created_at.asc&limit=1');
  if (!e[0]) throw new Error('no entity');
  return e[0].id as string;
}
const serverError = (err: unknown, what: string) => {
  console.error(`[finance-admin] ${what} failed`, err instanceof Error ? err.message : err);
  return jsonResponse({ error: 'Server error' }, 500);
};
const audit = (actorId: string, entity: string, action: string, target: string | undefined, detail?: Json) =>
  logFinanceAction({ actorId, entityId: entity, action, target, detail });

// Everything a screen needs to fill its pickers. Names only; no bank details.
const lookups = () => cached('lookups', loadLookups);
async function loadLookups() {
  const [categories, parties, projects, entities, closed, households, residents] = await Promise.all([
    rows('/fin_categories?select=id,name,type,active&order=type.asc,name.asc'),
    // former_since exists once migration 0085 is applied; until then the old list is read, so an unapplied migration never breaks the ledger.
    rowsAll('/fin_parties?select=id,name,kind,household_id,former_since&active=eq.true&merged_into=is.null&order=name.asc,id.asc').catch(() => rowsAll('/fin_parties?select=id,name,kind,household_id&active=eq.true&merged_into=is.null&order=name.asc,id.asc')),
    rows('/fin_projects?select=id,name,kind,financial_year,status&order=financial_year.desc,name.asc'),
    rows('/fin_entities?select=id,requester_party_id&order=created_at.asc&limit=1'),
    rows('/fin_periods?select=month&status=eq.closed'),
    rowsAll('/member_households?select=id,farm_unit,house_no&order=farm_unit.asc,id.asc'),
    // The people in each unit, so a unit can be found by a member's name. A failure here only loses that convenience.
    rowsAll('/member_household_members?select=household_id,member_people(full_name,active)&order=household_id.asc').catch(() => [] as Json[]),
  ]);
  const peopleOf = new Map<string, string[]>();
  for (const r of residents) {
    const person = r.member_people as { full_name?: string; active?: boolean } | null;
    if (person?.active && person.full_name) peopleOf.set(r.household_id as string, [...(peopleOf.get(r.household_id as string) ?? []), person.full_name]);
  }
  return {
    households: households.map((x) => ({ id: x.id as string, label: [x.farm_unit, x.house_no].filter(Boolean).join(' · '), people: (peopleOf.get(x.id as string) ?? []).sort((a, b) => a.localeCompare(b)) })),
    categories,
    parties,
    projects,
    requesterPartyId: (entities[0]?.requester_party_id as string | null) ?? null,
    closedMonths: closed.map((p) => p.month as string),
  };
}

// ---------------------------------------------------------------- list
type LineRow = { id: string; entity_id: string; bank_account_id: string; tran_date: string; narration: string; direction: string; amount_paise: number };

// The whole ledger is a few thousand lines, so state is worked out here instead of in SQL; the page is capped.
// Kept for a few seconds like the reference data, so typing in a column search or changing the sort does not re-read every line each time.
const loadLedger = (from: string | null, to: string | null) => cached(`ledger:${from}:${to}`, () => readLedger(from, to));
async function readLedger(from: string | null, to: string | null) {
  const range = `${from ? `&tran_date=gte.${from}` : ''}${to ? `&tran_date=lte.${to}` : ''}`;
  const [lines, allocations] = await Promise.all([
    rowsAll(`/fin_bank_lines?select=id,entity_id,bank_account_id,tran_date,narration,direction,amount_paise&order=tran_date.desc,created_at.desc,id.asc${range}`) as Promise<LineRow[]>,
    rowsAll('/fin_allocations?select=bank_line_id,amount_paise,review_state,posted_at,party_id,category_id,nature,reverses_allocation_id,household_id,maintenance_year&order=id.asc'),
  ]);
  const byLine = new Map<string, Json[]>();
  for (const a of allocations) byLine.set(a.bank_line_id, [...(byLine.get(a.bank_line_id) ?? []), a]);
  return { lines, byLine };
}

// What can be searched under a column header, and how each is read (scripts/lib/finance-columns.mjs).
const COLUMNS = { date: 'Date', narration: 'Narration', amount: 'Amount', category: 'Category', party: 'Party', nature: 'Wording' } as const;
type Column = keyof typeof COLUMNS;
const PARSERS: Record<Column, (raw: string) => Json | null> = { date: parseDate, narration: parseText, amount: parseAmount, category: parseText, party: parseText, nature: parseText };
const dateLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// The list: every line, narrowed by the chip (to allocate, to review, all), the search box and a condition per column, then sorted,
// then one page of it. Category, party and wording match what a posted line was allocated to, or, while it is unposted, what is
// suggested for it, so "Category = Bank charges" finds the lines that look like bank charges and can be filled in together.
export async function listLedger(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const url = new URL(req.url);
    const filter = ['unallocated', 'review', 'noparty', 'all'].includes(url.searchParams.get('filter') ?? '') ? url.searchParams.get('filter')! : 'unallocated';
    const iso = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get(k) ?? '') ? url.searchParams.get(k) : null);
    const q = (url.searchParams.get('q') ?? '').toLowerCase().trim().slice(0, 60);
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const sortKey = SORT_KEYS.includes(url.searchParams.get('sort') ?? '') ? url.searchParams.get('sort')! : 'date';
    const dir = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';

    // Conditions typed under the headers. One that cannot be understood is reported and left out, never silently ignored.
    const conds: Partial<Record<Column, Json>> = {};
    const filterErrors: Record<string, string> = {};
    const breadcrumb: { column: Column; text: string }[] = [];
    for (const col of Object.keys(COLUMNS) as Column[]) {
      const parsed = PARSERS[col]((url.searchParams.get(`f_${col}`) ?? '').slice(0, 80));
      if (!parsed) continue;
      if (parsed.error) filterErrors[col] = parsed.error as string;
      else {
        conds[col] = parsed;
        breadcrumb.push({ column: col, text: describeCondition(COLUMNS[col], parsed) });
      }
    }

    // The ledger, the pickers and the bank accounts are independent, so they are read together.
    const [{ lines, byLine }, ctx, accounts, households] = await Promise.all([
      loadLedger(iso('from'), iso('to')),
      lookups(),
      cached('bank-accounts', () => rows('/fin_bank_accounts?select=id,label')),
      cached('households', () => rowsAll('/member_households?select=id,farm_unit,house_no&order=id.asc')),
    ]);
    const sc = await cached(`sc:${iso('from')}:${iso('to')}`, () => suggestionContext(lines, byLine, ctx));
    const categoryById = new Map(ctx.categories.map((c) => [c.id as string, c]));
    const householdLabel = new Map(households.map((x) => [x.id as string, [x.farm_unit, x.house_no].filter(Boolean).join(' · ')]));
    const summarise = (l: LineRow) => {
      const allocs = byLine.get(l.id) ?? [];
      const posted = allocs.some((a) => a.posted_at);
      // Posted, and a row that should name a party does not: the payer of maintenance, a salary's employee, a bill's vendor...
      const missingParty = allocs.some((a) => a.posted_at && !a.reverses_allocation_id && !a.party_id && partyNeeded(categoryById.get(a.category_id)));
      return { state: posted ? 'allocated' : lineState(l, allocs), review: allocs.some((a) => a.review_state !== 'ok'), missingParty };
    };

    // The cheap conditions first (they need only the line itself).
    const cheap = lines.filter(
      (l) => matchDate(conds.date, l.tran_date, dateLabel(l.tran_date)) && matchText(conds.narration, l.narration) && matchAmount(conds.amount, l.amount_paise) && (!q || l.narration.toLowerCase().includes(q)),
    );

    // Category, party and wording need what each line was posted to, or is suggested: only worked out for all lines when a condition or the
    // sort needs it; otherwise just for the page being shown.
    const categoryName = new Map(ctx.categories.map((c) => [c.id as string, c.name as string]));
    const partyName = new Map(ctx.parties.map((x) => [x.id as string, x.name as string]));
    const needsEffective = Boolean(conds.category || conds.party || conds.nature) || ['category', 'party', 'nature'].includes(sortKey);
    const upiOf = new Map<string, Json>();
    const fetchUpi = async () => {
      const found = await cached('upi-linked', () => rowsAll('/fin_upi_lines?select=bank_line_id,counterparty,remarks,is_circle&bank_line_id=not.is.null&order=id.asc'));
      for (const u of found) upiOf.set(u.bank_line_id as string, u);
    };
    const effective = new Map<string, { category: string; party: string; nature: string }>();
    if (needsEffective) {
      await fetchUpi();
      for (const l of cheap) {
        const posted = postedSummary(byLine.get(l.id) ?? []);
        if (posted) effective.set(l.id, { category: categoryName.get(posted.categoryId) ?? '', party: posted.partyId ? partyName.get(posted.partyId) ?? '' : '', nature: posted.nature ?? '' });
        else {
          const sg = suggestFor(l, upiOf.get(l.id) ?? null, ctx, sc);
          effective.set(l.id, { category: sg.categoryId ? categoryName.get(sg.categoryId) ?? '' : '', party: sg.partyId ? partyName.get(sg.partyId) ?? '' : sg.newParty?.name ?? '', nature: sg.nature ?? '' });
        }
      }
    }
    const base = needsEffective
      ? cheap.filter((l) => {
          const e = effective.get(l.id)!;
          return matchText(conds.category, e.category) && matchText(conds.party, e.party) && matchText(conds.nature, e.nature);
        })
      : cheap;

    // The chips count what is left after the column conditions, so they say how many of THESE lines still need you.
    const counts = { unallocated: 0, review: 0, noparty: 0, all: base.length };
    for (const l of base) {
      const st = summarise(l);
      if (st.state !== 'allocated') counts.unallocated++;
      if (st.review) counts.review++;
      if (st.missingParty) counts.noparty++;
    }
    const keyed = base
      .filter((l) => {
        const st = summarise(l);
        return filter === 'all' || (filter === 'unallocated' ? st.state !== 'allocated' : filter === 'noparty' ? st.missingParty : st.review);
      })
      .map((l) => {
        const e = effective.get(l.id);
        const st = summarise(l);
        return { l, r: { id: l.id, date: l.tran_date, narration: l.narration, amount: l.amount_paise, category: e?.category ?? '', party: e?.party ?? '', nature: e?.nature ?? '', status: st.review ? 'review' : st.state } };
      });
    const compare = compareRows(sortKey, dir);
    keyed.sort((x, y) => compare(x.r, y.r));
    const matched = keyed.map((k) => k.l);

    const page = matched.slice(offset, offset + PAGE);
    if (!needsEffective) await fetchUpi();
    const accountLabel = new Map(accounts.map((a) => [a.id as string, a.label as string]));
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    return jsonResponse({
      canAllocate: capabilities.includes('allocate'),
      canClose: capabilities.includes('close-period'),
      counts,
      total: matched.length,
      offset,
      sort: { key: sortKey, dir },
      breadcrumb,
      filterErrors,
      lines: page.map((l) => ({
        id: l.id,
        date: l.tran_date,
        narration: l.narration,
        direction: l.direction,
        amountPaise: l.amount_paise,
        account: accountLabel.get(l.bank_account_id) ?? '',
        remark: upiOf.get(l.id)?.remarks ?? null,
        counterparty: upiOf.get(l.id)?.counterparty ?? null,
        isCircle: Boolean(upiOf.get(l.id)?.is_circle),
        allocatedPaise: (byLine.get(l.id) ?? []).reduce((n, a) => n + a.amount_paise, 0),
        ...summarise(l),
        suggestion: summarise(l).state === 'allocated' ? null : compactSuggestion(suggestFor(l, upiOf.get(l.id) ?? null, ctx, sc)),
        // What a posted line was allocated to (the first row, and how many there are), so the table can show it.
        allocation: (() => {
          const a = postedSummary(byLine.get(l.id) ?? []);
          return a ? { ...a, householdLabel: a.householdId ? householdLabel.get(a.householdId as string) ?? null : null } : null;
        })(),
      })),
      lookups: ctx,
      reasons: REVIEW_REASONS,
    });
  } catch (err) {
    return serverError(err, 'ledger list');
  }
}

// Every line in one response, with what each was posted to or is suggested, for pages that sort and search in the browser (the
// prototype ledger). One wave of reads, no filtering or paging: the browser does that instantly with scripts/lib/finance-columns.mjs.
export async function ledgerAll(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const [{ lines, byLine }, ctx, accounts, households, upis] = await Promise.all([
      loadLedger(null, null),
      lookups(),
      cached('bank-accounts', () => rows('/fin_bank_accounts?select=id,label')),
      cached('households', () => rowsAll('/member_households?select=id,farm_unit,house_no&order=id.asc')),
      cached('upi-linked', () => rowsAll('/fin_upi_lines?select=bank_line_id,counterparty,remarks,is_circle&bank_line_id=not.is.null&order=id.asc')),
      reviewRef(), // started now so the suggestion context below does not wait for it
    ]);
    const sc = await suggestionContext(lines, byLine, ctx);
    const upiOf = new Map(upis.map((u) => [u.bank_line_id as string, u]));
    const categoryById = new Map(ctx.categories.map((c) => [c.id as string, c]));
    const partyName = new Map(ctx.parties.map((x) => [x.id as string, x.name as string]));
    const householdLabel = new Map(households.map((x) => [x.id as string, [x.farm_unit, x.house_no].filter(Boolean).join(' · ')]));
    const accountLabel = new Map(accounts.map((a) => [a.id as string, a.label as string]));
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    const out = lines.map((l) => {
      const allocs = byLine.get(l.id) ?? [];
      const posted = allocs.some((a) => a.posted_at);
      const state = posted ? 'allocated' : lineState(l, allocs);
      const missingParty = allocs.some((a) => a.posted_at && !a.reverses_allocation_id && !a.party_id && partyNeeded(categoryById.get(a.category_id)));
      const upi = upiOf.get(l.id) ?? null;
      const summary = postedSummary(allocs);
      const sg = posted ? null : suggestFor(l, upi, ctx, sc);
      const effective = summary
        ? { category: categoryById.get(summary.categoryId)?.name ?? '', party: summary.partyId ? partyName.get(summary.partyId) ?? '' : '', nature: summary.nature ?? '' }
        : { category: sg?.categoryId ? categoryById.get(sg.categoryId)?.name ?? '' : '', party: sg?.partyId ? partyName.get(sg.partyId) ?? '' : sg?.newParty?.name ?? '', nature: sg?.nature ?? '' };
      return {
        id: l.id,
        date: l.tran_date,
        narration: l.narration,
        direction: l.direction,
        amountPaise: l.amount_paise,
        account: accountLabel.get(l.bank_account_id) ?? '',
        remark: upi?.remarks ?? null,
        counterparty: upi?.counterparty ?? null,
        isCircle: Boolean(upi?.is_circle),
        allocatedPaise: allocs.reduce((n, a) => n + a.amount_paise, 0),
        state,
        review: allocs.some((a) => a.review_state !== 'ok'),
        missingParty,
        suggestion: sg ? compactSuggestion(sg) : null,
        allocation: summary ? { ...summary, householdLabel: summary.householdId ? householdLabel.get(summary.householdId as string) ?? null : null } : null,
        effective,
      };
    });
    return jsonResponse({ canAllocate: capabilities.includes('allocate'), canClose: capabilities.includes('close-period'), lines: out, lookups: ctx });
  } catch (err) {
    return serverError(err, 'ledger all');
  }
}

// ---------------------------------------------------------------- one line
// Posted allocations on lines going the other way, with how much of each is still unreversed: what a refund can undo.
async function reversibleFor(line: Json): Promise<Json[]> {
  const opposite = line.direction === 'debit' ? 'credit' : 'debit';
  const lineIds = await rowsAll(`/fin_bank_lines?select=id,tran_date&direction=eq.${opposite}&order=tran_date.desc,id.asc`);
  if (!lineIds.length) return [];
  const dateOf = new Map(lineIds.map((l) => [l.id as string, l.tran_date as string]));
  const allocs = await rowsAll('/fin_allocations?select=id,bank_line_id,party_id,category_id,amount_paise,nature,period,reverses_allocation_id&posted_at=not.is.null&order=id.asc');
  const reversed = new Map<string, number>();
  for (const a of allocs) if (a.reverses_allocation_id) reversed.set(a.reverses_allocation_id, (reversed.get(a.reverses_allocation_id) ?? 0) + a.amount_paise);
  return allocs
    .filter((a) => dateOf.has(a.bank_line_id) && !a.reverses_allocation_id && a.amount_paise - (reversed.get(a.id) ?? 0) > 0)
    .map((a) => ({ id: a.id, date: dateOf.get(a.bank_line_id), partyId: a.party_id, categoryId: a.category_id, nature: a.nature, remainingPaise: a.amount_paise - (reversed.get(a.id) ?? 0) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 300);
}

// What the server would suggest for a line, and why it would need a person. Shared by the detail view and by save.
// What the suggestion engine needs besides the line: the rules, the account states, and an index of what was posted before.
async function suggestionContext(lines: LineRow[], byLine: Map<string, Json[]>, ctx: Awaited<ReturnType<typeof lookups>>) {
  const rc = await reviewContext(ctx);
  const past: Json[] = [];
  for (const l of lines) {
    for (const a of byLine.get(l.id) ?? []) {
      if (a.posted_at && !a.reverses_allocation_id) past.push({ narration: l.narration, direction: l.direction, party_id: a.party_id, category_id: a.category_id, nature: a.nature });
    }
  }
  const requesterIds: string[] = ctx.requesterPartyId ? [ctx.requesterPartyId] : [];
  return { rc, history: buildHistory(past), requesterIds };
}
type SuggestionContext = Awaited<ReturnType<typeof suggestionContext>>;

const suggestFor = (line: Json, upi: Json | null, ctx: Awaited<ReturnType<typeof lookups>>, sc: SuggestionContext): Json =>
  suggest({ line, upi, rules: sc.rc.rules, parties: ctx.parties, categories: ctx.categories, history: sc.history, requesterPartyIds: sc.requesterIds }) as Json;

// The short form shown in the list: no reasons (the line's own sheet has those).
const postedSummary = (allocs: Json[]) => {
  const posted = allocs.filter((a) => a.posted_at && !a.reverses_allocation_id);
  return posted.length ? { categoryId: posted[0].category_id, partyId: posted[0].party_id, nature: posted[0].nature, count: posted.length, householdId: posted[0].household_id ?? null, maintenanceYear: posted[0].maintenance_year ?? null } : null;
};

const compactSuggestion = (x: Json) =>
  x.categoryId || x.partyId || x.nature || x.newParty
    ? { categoryId: x.categoryId, partyId: x.partyId, nature: x.nature, confidence: x.confidence, newPartyName: x.newParty?.name ?? null }
    : null;

const reviewRef = () =>
  cached('review-ref', () =>
    Promise.all([
      rows('/fin_rules?select=id,priority,matcher,party_id,category_id,nature_template,needs_review,active&active=eq.true'),
      rowsAll('/fin_party_accounts?select=party_id,status,retired_on&status=neq.superseded&order=id.asc'),
    ]),
  );
async function reviewContext(ctx: Awaited<ReturnType<typeof lookups>>) {
  const [rules, allAccounts] = await reviewRef();
  const today = new Date().toISOString().slice(0, 10);
  const stateOfParty = (partyId: string | null): 'verified' | 'unverified' | 'none' => {
    if (!partyId) return 'none';
    const live = allAccounts.filter((a) => a.party_id === partyId && !(a.retired_on && a.retired_on <= today));
    if (live.some((a) => a.status === 'verified')) return 'verified';
    return live.length ? 'unverified' : 'none';
  };
  const reimbursement = ctx.categories.find((c) => c.type === 'reimbursement' && c.active);
  return { rules, stateOfParty, reimbursementCategoryId: (reimbursement?.id as string | undefined) ?? null };
}

export async function ledgerLine(req: Request, lineId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const [line] = await rows(`/fin_bank_lines?id=eq.${lineId}&select=id,bank_account_id,tran_date,narration,direction,amount_paise`);
    if (!line) return fail('That line does not exist.', 404);
    const [upi] = await rows(`/fin_upi_lines?bank_line_id=eq.${lineId}&select=counterparty,remarks,is_circle,upi_ref`);
    const allocations = await rows(`/fin_allocations?bank_line_id=eq.${lineId}&select=id,party_id,category_id,project_id,amount_paise,period,nature,remarks,source,rule_id,review_state,review_reason,reverses_allocation_id,reversal_reason,household_id,maintenance_year,posted_at&order=created_at.asc`);
    const ctx = await lookups();
    const { lines: everyLine, byLine } = await loadLedger(null, null);
    const sc = await suggestionContext(everyLine, byLine, ctx);
    const posted = allocations.some((a) => a.posted_at);
    let proposal = null as Json | null;
    let suggestion = null as Json | null;
    let reasons: string[] = [];
    if (!posted && allocations.length === 0) {
      suggestion = suggestFor(line, upi ?? null, ctx, sc);
      if (suggestion.categoryId || suggestion.partyId || suggestion.nature) {
        proposal = { categoryId: suggestion.categoryId, partyId: suggestion.partyId, nature: suggestion.nature, amountPaise: line.amount_paise, period: suggestion.period, source: suggestion.source, ruleId: suggestion.ruleId };
      }
      if (suggestion.categoryId) {
        const category = ctx.categories.find((c) => c.id === suggestion!.categoryId);
        reasons = reviewReasons({ line, upi, proposal: { partyId: suggestion.partyId, categoryId: suggestion.categoryId, source: suggestion.source, needsReview: suggestion.needsReview }, requesterPartyIds: sc.requesterIds, partyAccountState: sc.rc.stateOfParty(suggestion.partyId), categoryType: category?.type, hasVoucher: false, partyNeeded: partyNeeded(category) });
      } else reasons = ['unexplained'];
    }
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    return jsonResponse({
      canAllocate: capabilities.includes('allocate'),
      line: { id: line.id, date: line.tran_date, narration: line.narration, direction: line.direction, amountPaise: line.amount_paise },
      upi: upi ? { counterparty: upi.counterparty, remark: upi.remarks, isCircle: upi.is_circle } : null,
      state: posted ? 'allocated' : lineState(line, allocations),
      allocations: allocations.map((a) => ({
        id: a.id,
        partyId: a.party_id,
        categoryId: a.category_id,
        projectId: a.project_id,
        amountPaise: a.amount_paise,
        period: a.period,
        nature: a.nature,
        remarks: a.remarks,
        source: a.source,
        reviewState: a.review_state,
        reviewReason: a.review_reason,
        householdId: a.household_id ?? null,
        maintenanceYear: a.maintenance_year ?? null,
        reversesAllocationId: a.reverses_allocation_id,
        reversalReason: a.reversal_reason,
        posted: Boolean(a.posted_at),
      })),
      proposal,
      suggestion,
      reasons,
      reversible: capabilities.includes('allocate') && !posted ? await reversibleFor(line) : [],
      lookups: ctx,
      reasonLabels: REVIEW_REASONS,
    });
  } catch (err) {
    return serverError(err, 'ledger line');
  }
}

// ---------------------------------------------------------------- save
type SaveResult = { ok: true; saved: number; posted: boolean; override: boolean; flagged: number } | { ok: false; status: number; error: string };

// What saveLine needs besides the rows, read once when many lines are saved together (a batch of 15 would otherwise read the
// lookups, rules and accounts 15 times and run out of time).
type SharedSave = { ctx: Awaited<ReturnType<typeof lookups>>; rc: Awaited<ReturnType<typeof reviewContext>>; lines: Map<string, Json>; byLine: Map<string, Json[]>; upiOf: Map<string, Json> };

// Validates a person's rows for one line, works out the review flags, writes the audit row, then saves through the database
// function (which checks the sums again). `input`: { rows, post, overrideReason }.
async function saveLine(staff: { id: string }, capabilities: string[], lineId: string, input: Json, shared?: SharedSave): Promise<SaveResult> {
  const line = shared?.lines.get(lineId) ?? (await rows(`/fin_bank_lines?id=eq.${lineId}&select=id,entity_id,tran_date,direction,amount_paise`))[0];
  if (!line) return { ok: false, status: 404, error: 'That line does not exist.' };
  const existing = shared ? shared.byLine.get(lineId) ?? [] : await rows(`/fin_allocations?bank_line_id=eq.${lineId}&select=id,posted_at`);
  if (existing.some((a) => a.posted_at)) return { ok: false, status: 409, error: 'This line is already posted. Correct it with a refund or reversal, not by editing.' };
  const post = Boolean(input.post);
  const inputRows: Json[] = Array.isArray(input.rows) ? input.rows : [];
  if (inputRows.length > 40) return { ok: false, status: 400, error: 'That is too many rows for one line.' };

  const ctx = shared?.ctx ?? (await lookups());
  const categoryById = new Map(ctx.categories.map((c) => [c.id as string, c]));
  const partyIds = new Set(ctx.parties.map((p) => p.id as string));
  const projectIds = new Set(ctx.projects.map((p) => p.id as string));
  const householdIds = new Set(ctx.households.map((x) => x.id as string));
  const upi = shared ? shared.upiOf.get(lineId) : (await rows(`/fin_upi_lines?bank_line_id=eq.${lineId}&select=counterparty,remarks,is_circle`))[0];
  const rc = shared?.rc ?? (await reviewContext(ctx));
  const requesterIds = ctx.requesterPartyId ? [ctx.requesterPartyId] : [];

  // Reversal rows take their category and party from the allocation they undo.
  const prepared: Json[] = [];
  const reversalChecks: string[] = [];
  for (const [i, r] of inputRows.entries()) {
    if (r.reversesAllocationId) {
      if (!LEDGER_ID.test(String(r.reversesAllocationId))) return { ok: false, status: 400, error: `Row ${i + 1}: choose what to reverse.` };
      const [orig] = await rows(`/fin_allocations?id=eq.${r.reversesAllocationId}&select=id,party_id,category_id,project_id,amount_paise,nature,reverses_allocation_id,posted_at,bank_line_id,household_id,maintenance_year`);
      if (!orig || !orig.posted_at) return { ok: false, status: 400, error: `Row ${i + 1}: that allocation cannot be reversed.` };
      const [origLine] = await rows(`/fin_bank_lines?id=eq.${orig.bank_line_id}&select=direction`);
      const prior = await rows(`/fin_allocations?reverses_allocation_id=eq.${orig.id}&select=amount_paise`);
      const siblings = prepared.filter((p) => p.reversesAllocationId === orig.id).reduce((n, p) => n + p.amountPaise, 0);
      const check = planReversal({ ...orig, direction: origLine?.direction }, [...prior, { amount_paise: siblings }], line, { amountPaise: r.amountPaise, reason: r.reversalReason });
      if (!check.ok) return { ok: false, status: 400, error: `Row ${i + 1}: ${check.errors[0]}` };
      reversalChecks.push(orig.id);
      prepared.push({ ...r, categoryId: orig.category_id, partyId: orig.party_id, projectId: orig.project_id, householdId: orig.household_id, maintenanceYear: orig.maintenance_year, nature: String(r.nature ?? '').trim() || `Reversal: ${orig.nature}`, source: 'manual' });
    } else prepared.push({ ...r, source: ['manual', 'rule', 'upi_remark'].includes(r.source) ? r.source : 'manual' });
  }

  const plan = planPosting(line, prepared, { allowRemainder: !post }) as { ok: boolean; errors: string[]; rows: Json[] };
  if (!plan.ok) return { ok: false, status: 400, error: plan.errors[0] };
  for (const [i, r] of plan.rows.entries()) {
    const category = categoryById.get(r.categoryId);
    if (!category || (!category.active && !r.reversesAllocationId)) return { ok: false, status: 400, error: `Row ${i + 1}: choose an active category.` };
    if (r.partyId && !partyIds.has(r.partyId) && !r.reversesAllocationId) return { ok: false, status: 400, error: `Row ${i + 1}: that party is not in the register.` };
    if (r.projectId && !projectIds.has(r.projectId)) return { ok: false, status: 400, error: `Row ${i + 1}: that project does not exist.` };
    if (r.householdId && !r.reversesAllocationId && !householdIds.has(r.householdId)) return { ok: false, status: 400, error: `Row ${i + 1}: that unit does not exist.` };
    if (r.maintenanceYear && !/^\d{4}-\d{2}$/.test(String(r.maintenanceYear))) return { ok: false, status: 400, error: `Row ${i + 1}: the maintenance year looks like 2025-26.` };
  }

  // A closed month needs close-period and a reason.
  const months = [...new Set(plan.rows.map((r) => r.period as string))];
  const closed = new Set(ctx.closedMonths.map((m) => String(m).slice(0, 10)));
  let override = false;
  for (const m of months) {
    const d = periodWriteDecision(closed.has(m) ? 'closed' : 'open', capabilities, String(input.overrideReason ?? ''));
    if (!d.ok) return { ok: false, status: 403, error: d.error ?? 'That month is closed.' };
    if (d.override) override = true;
  }

  // Review flags per row, from the same pure rules the screen showed.
  const reasonCounts: Record<string, number> = {};
  const dbRows = plan.rows.map((r) => {
    let reasons: string[] = [];
    if (!r.reversesAllocationId) {
      const rule = r.ruleId ? rc.rules.find((x) => x.id === r.ruleId) : null;
      reasons = reviewReasons({
        line,
        upi: upi ?? null,
        proposal: { partyId: r.partyId ?? null, categoryId: r.categoryId, source: r.source, needsReview: Boolean(rule?.needs_review), householdId: r.householdId ?? null },
        requesterPartyIds: requesterIds,
        partyAccountState: rc.stateOfParty(r.partyId ?? null),
        categoryType: categoryById.get(r.categoryId)?.type,
        hasVoucher: false,
        partyNeeded: partyNeeded(categoryById.get(r.categoryId)),
        unitNeeded: categoryById.get(r.categoryId)?.type === 'member_contribution',
      });
    }
    for (const x of reasons) reasonCounts[x] = (reasonCounts[x] ?? 0) + 1;
    return {
      party_id: r.partyId ?? null,
      category_id: r.categoryId,
      project_id: r.projectId ?? null,
      amount_paise: r.amountPaise,
      period: r.period,
      nature: r.nature,
      remarks: r.remarks ? String(r.remarks).slice(0, 300) : null,
      source: r.source,
      rule_id: r.source === 'rule' && r.ruleId && LEDGER_ID.test(r.ruleId) ? r.ruleId : null,
      review_state: reasons.length ? 'needs_review' : 'ok',
      review_reason: reasons.length ? reasons.join(',') : null,
      reverses_allocation_id: r.reversesAllocationId ?? null,
      reversal_reason: r.reversesAllocationId ? r.reason ?? r.reversalReason : null,
      household_id: r.householdId || null,
      maintenance_year: r.maintenanceYear ? String(r.maintenanceYear) : null,
    };
  });

  await audit(staff.id, line.entity_id, post ? 'finance.allocations_posted' : 'finance.allocations_drafted', lineId, {
    rows: dbRows.length,
    reversals: reversalChecks.length,
    override,
    reviewReasons: reasonCounts,
    periods: months,
  });
  try {
    await rpc('fin_save_allocations', { p_line_id: lineId, p_rows: dbRows, p_actor: staff.id, p_post: post, p_override: override });
  } catch (err) {
    console.error('[finance-admin] save allocations failed', err instanceof Error ? err.message : err);
    return { ok: false, status: 409, error: 'This line changed while you were editing it, or does not add up. Reload and try again.' };
  }
  for (const id of new Set(dbRows.map((r) => r.rule_id).filter((x): x is string => Boolean(x)))) {
    if (post) {
      const [rule] = await rows(`/fin_rules?id=eq.${id}&select=hit_count`);
      if (rule) await rest(`/fin_rules?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ hit_count: rule.hit_count + 1 }) });
    }
  }
  return { ok: true, saved: dbRows.length, posted: post, override, flagged: dbRows.filter((r) => r.review_state !== 'ok').length };
}

export async function saveAllocations(req: Request, lineId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body) return fail('Invalid request');
  try {
    const result = await saveLine(auth.staff, capabilitiesForRole('finance', auth.staff.role) as string[], lineId, body);
    return result.ok ? jsonResponse({ saved: result.saved, posted: result.posted }) : fail(result.error, result.status);
  } catch (err) {
    return serverError(err, 'save allocations');
  }
}

// Post many lines at once, each in full to its own category, party and wording: what the table's "Post N ready" sends. The
// client only says which lines and what to put on them (the same trust as posting by hand); the amount is always the line's.
// A line that cannot be posted (already posted, a closed month, a retired category) is left alone and reported with its reason.
// At most BATCH_MAX a request, because each save is an audit write and a database call and a function has a time limit.
const BATCH_MAX = 15;
export async function postBatch(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  const items: Json[] = Array.isArray(body?.items) ? body!.items : [];
  if (!body || !items.length || items.length > BATCH_MAX || !items.every((i) => i && LEDGER_ID.test(String(i.lineId)))) return fail(`Send between 1 and ${BATCH_MAX} lines.`);
  if (new Set(items.map((i) => i.lineId)).size !== items.length) return fail('A line was sent twice.');
  try {
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    const ctx = await lookups();
    const rc = await reviewContext(ctx);
    const lineIds = items.map((i) => i.lineId as string);
    const found = await rows(`/fin_bank_lines?id=in.(${lineIds.join(',')})&select=id,entity_id,tran_date,direction,amount_paise`);
    const existing = await rows(`/fin_allocations?bank_line_id=in.(${lineIds.join(',')})&select=bank_line_id,id,posted_at`);
    const upi = await rows(`/fin_upi_lines?bank_line_id=in.(${lineIds.join(',')})&select=bank_line_id,counterparty,remarks,is_circle`);
    const byLine = new Map<string, Json[]>();
    for (const a of existing) byLine.set(a.bank_line_id, [...(byLine.get(a.bank_line_id) ?? []), a]);
    const shared: SharedSave = { ctx, rc, lines: new Map(found.map((l) => [l.id as string, l])), byLine, upiOf: new Map(upi.map((u) => [u.bank_line_id as string, u])) };
    const failed: { lineId: string; error: string }[] = [];
    let posted = 0;
    let flagged = 0;
    for (const item of items) {
      const line = shared.lines.get(item.lineId);
      if (!line) {
        failed.push({ lineId: item.lineId, error: 'No such line.' });
        continue;
      }
      const result = await saveLine(
        auth.staff, capabilities, item.lineId,
        { post: true, overrideReason: body.overrideReason, rows: [{ amountPaise: line.amount_paise, categoryId: item.categoryId, partyId: item.partyId || null, projectId: item.projectId || null, householdId: item.householdId || null, maintenanceYear: item.maintenanceYear || null, nature: item.nature, period: item.period || undefined, source: 'manual' }] },
        shared,
      );
      if (result.ok) {
        posted++;
        flagged += result.flagged;
      } else failed.push({ lineId: item.lineId, error: result.error });
    }
    return jsonResponse({ posted, flagged, failed });
  } catch (err) {
    return serverError(err, 'post batch');
  }
}

// ---------------------------------------------------------------- review
export async function reviewAllocation(req: Request, allocationId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body || !['resolve', 'flag'].includes(body.action)) return fail('Say whether to resolve or flag it.');
  try {
    const [a] = await rows(`/fin_allocations?id=eq.${allocationId}&select=id,entity_id,review_state,review_reason,posted_at,created_by`);
    if (!a) return fail('That allocation does not exist.', 404);
    if (body.action === 'resolve' && a.review_state === 'ok') return fail('Nothing to resolve: it is already clear.', 409);
    // Whoever saved the allocation does not clear its review (maker is not checker), unless they are a director.
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    if (body.action === 'resolve' && a.created_by === auth.staff.id && !capabilities.includes('approve')) {
      return fail('Someone else needs to review this. You entered it.', 403);
    }
    await audit(auth.staff.id, a.entity_id, body.action === 'resolve' ? 'finance.review_resolved' : 'finance.review_flagged', allocationId, { was: a.review_state });
    const patch = body.action === 'resolve'
      ? { review_state: 'ok', reviewed_by: auth.staff.id, reviewed_at: new Date().toISOString() }
      : { review_state: 'flagged', review_reason: a.review_reason ?? 'manual', reviewed_by: null, reviewed_at: null };
    await rest(`/fin_allocations?id=eq.${allocationId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'review');
  }
}

// ---------------------------------------------------------------- fill a missing party
// A posted allocation with no party can be given one (a reversal cannot, and a party already there is never replaced:
// that is a reversal). Nothing else on the row changes. A closed month needs close-period and a reason, like any write.
export async function setAllocationParty(req: Request, allocationId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body || !LEDGER_ID.test(String(body.partyId ?? ''))) return fail('Choose a party.');
  try {
    const [a] = await rows(`/fin_allocations?id=eq.${allocationId}&select=id,entity_id,party_id,period,posted_at,reverses_allocation_id`);
    if (!a) return fail('That allocation does not exist.', 404);
    if (!a.posted_at) return fail('Only a posted line is changed here; edit a draft in the line itself.', 409);
    if (a.reverses_allocation_id) return fail('A refund takes the party of what it refunds.', 409);
    if (a.party_id) return fail('It already has a party. To change it, reverse the line and post it again.', 409);
    if (!(await lookups()).parties.some((p) => p.id === body.partyId)) return fail('That party is not in the register.');
    const [closed] = await rows(`/fin_periods?entity_id=eq.${a.entity_id}&month=eq.${String(a.period).slice(0, 10)}&status=eq.closed&select=month`);
    const decision = periodWriteDecision(closed ? 'closed' : 'open', capabilitiesForRole('finance', auth.staff.role) as string[], String(body.overrideReason ?? ''));
    if (!decision.ok) return fail(decision.error ?? 'That month is closed.', 403);
    await audit(auth.staff.id, a.entity_id, 'finance.allocation_party_set', allocationId, { partyId: body.partyId, override: Boolean(decision.override) });
    const changed = Number(await rpc('fin_set_allocation_party', { p_id: allocationId, p_party: body.partyId, p_actor: auth.staff.id }));
    if (!changed) return fail('This line changed while you were looking at it. Reload and try again.', 409);
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'set allocation party');
  }
}

// ---------------------------------------------------------------- rules
const ruleForResponse = (r: Json) => ({
  id: r.id, priority: r.priority, matcher: r.matcher, partyId: r.party_id, categoryId: r.category_id,
  natureTemplate: r.nature_template, needsReview: r.needs_review, hitCount: r.hit_count, active: r.active,
});

export async function listRules(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    const rules = await rows('/fin_rules?select=id,priority,matcher,party_id,category_id,nature_template,needs_review,hit_count,active&order=priority.asc,created_at.asc');
    return jsonResponse({ canConfigure: capabilities.includes('configure'), rules: rules.map(ruleForResponse), lookups: await lookups() });
  } catch (err) {
    return serverError(err, 'rules list');
  }
}

function ruleFromBody(body: Json) {
  const m = (body.matcher ?? {}) as Json;
  const matcher: Json = {};
  if (String(m.narrationContains ?? '').trim()) matcher.narrationContains = String(m.narrationContains).trim();
  const keywords = (Array.isArray(m.remarkKeywords) ? m.remarkKeywords : []).map((k: unknown) => String(k).trim()).filter(Boolean);
  if (keywords.length) matcher.remarkKeywords = keywords;
  if (m.direction) matcher.direction = m.direction;
  if (m.minPaise != null && m.minPaise !== '') matcher.minPaise = m.minPaise;
  if (m.maxPaise != null && m.maxPaise !== '') matcher.maxPaise = m.maxPaise;
  return { matcher, categoryId: body.categoryId, partyId: body.partyId || null, natureTemplate: String(body.natureTemplate ?? '').slice(0, 200), needsReview: Boolean(body.needsReview), priority: body.priority == null ? 100 : Number(body.priority) };
}

export async function saveRule(req: Request, ruleId: string | null): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body) return fail('Invalid request');
  try {
    const entity = await entityId();
    if (ruleId && body.active !== undefined && Object.keys(body).length === 1) {
      await audit(auth.staff.id, entity, body.active ? 'finance.rule_enabled' : 'finance.rule_disabled', ruleId);
      await rest(`/fin_rules?id=eq.${ruleId}`, { method: 'PATCH', body: JSON.stringify({ active: Boolean(body.active) }) });
      return jsonResponse({ ok: true });
    }
    const r = ruleFromBody(body);
    const checked = validateRule(r);
    if (!checked.ok) return fail(checked.errors[0]);
    const ctx = await lookups();
    if (!ctx.categories.some((c) => c.id === r.categoryId && c.active)) return fail('Choose an active category.');
    if (r.partyId && !ctx.parties.some((p) => p.id === r.partyId)) return fail('That party is not in the register.');
    const row = { matcher: r.matcher, category_id: r.categoryId, party_id: r.partyId, nature_template: r.natureTemplate, needs_review: r.needsReview, priority: r.priority };
    if (ruleId) {
      await audit(auth.staff.id, entity, 'finance.rule_changed', ruleId);
      await rest(`/fin_rules?id=eq.${ruleId}`, { method: 'PATCH', body: JSON.stringify(row) });
      return jsonResponse({ id: ruleId });
    }
    await audit(auth.staff.id, entity, 'finance.rule_added', undefined);
    const res = await rest('/fin_rules', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, entity_id: entity, created_by: auth.staff.id }) });
    const [created] = (await res.json()) as Json[];
    return jsonResponse({ id: created.id }, 201);
  } catch (err) {
    return serverError(err, 'save rule');
  }
}

// ---------------------------------------------------------------- categories and settings
export async function saveCategory(req: Request, categoryId: string | null, action: 'merge' | null): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body) return fail('Invalid request');
  try {
    const entity = await entityId();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!categoryId) {
      if (name.length < 3 || name.length > 60) return fail('Give the category a name of 3 to 60 characters.');
      if (!CATEGORY_TYPES.includes(body.type)) return fail('Choose what kind of category it is.');
      await audit(auth.staff.id, entity, 'finance.category_added', undefined, { type: body.type });
      const res = await rest('/fin_categories', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ entity_id: entity, name, type: body.type, budget_head: body.type !== 'transfer' }) });
      const [created] = (await res.json()) as Json[];
      return jsonResponse({ id: created.id }, 201);
    }
    if (action === 'merge') {
      if (!LEDGER_ID.test(String(body.into))) return fail('Choose the category to merge into.');
      const [from] = await rows(`/fin_categories?id=eq.${categoryId}&select=id,type`);
      const [into] = await rows(`/fin_categories?id=eq.${body.into}&select=id,type,active`);
      if (!from || !into) return fail('That category does not exist.', 404);
      if (from.id === into.id) return fail('Choose two different categories.');
      if (from.type !== into.type) return fail('Only categories of the same type can be merged, so no budget figure changes.', 409);
      if (!into.active) return fail('Merge into an active category.', 409);
      await audit(auth.staff.id, entity, 'finance.category_merged', categoryId, { into: body.into });
      const moved = Number(await rpc('fin_merge_category', { p_from: categoryId, p_to: body.into, p_actor: auth.staff.id }));
      return jsonResponse({ moved });
    }
    const patch: Json = {};
    if (name) {
      if (name.length < 3 || name.length > 60) return fail('Give the category a name of 3 to 60 characters.');
      patch.name = name;
    }
    if (typeof body.active === 'boolean') patch.active = body.active;
    if (!Object.keys(patch).length) return fail('Nothing to change.');
    await audit(auth.staff.id, entity, 'finance.category_changed', categoryId, { fields: Object.keys(patch) });
    const res = await rest(`/fin_categories?id=eq.${categoryId}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (!((await res.json()) as Json[]).length) return fail('That category does not exist.', 404);
    return jsonResponse({ ok: true });
  } catch (err) {
    if (err instanceof Error && /409/.test(err.message)) return fail('A category with that name already exists.', 409);
    return serverError(err, 'save category');
  }
}

// Move chosen posted allocations to another category (splitting a category). A change of type moves them between budget
// buckets, so it needs `confirmTypeChange`.
export async function recategorise(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  const ids: string[] = Array.isArray(body?.allocationIds) ? body!.allocationIds : [];
  if (!body || !ids.length || ids.length > 500 || !ids.every((i) => LEDGER_ID.test(String(i))) || !LEDGER_ID.test(String(body.to))) return fail('Choose the allocations and the category to move them to.');
  try {
    const entity = await entityId();
    const [to] = await rows(`/fin_categories?id=eq.${body.to}&select=id,type,active`);
    if (!to || !to.active) return fail('Choose an active category.');
    const current = await rows(`/fin_allocations?id=in.(${ids.join(',')})&select=category_id`);
    const types = new Map((await rows('/fin_categories?select=id,type')).map((c) => [c.id as string, c.type as string]));
    const changesType = current.some((a) => types.get(a.category_id) !== to.type);
    if (changesType && !body.confirmTypeChange) return fail('That changes the budget bucket of some of them. Confirm to go ahead.', 409, { needsConfirmation: true });
    await audit(auth.staff.id, entity, 'finance.allocations_recategorised', body.to, { count: ids.length, changesType });
    const moved = Number(await rpc('fin_recategorise_allocations', { p_ids: ids, p_to: body.to, p_actor: auth.staff.id }));
    return jsonResponse({ moved });
  } catch (err) {
    return serverError(err, 'recategorise');
  }
}

export async function setRequester(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return fail(auth.error, auth.status);
  const body = await readBody(req);
  if (!body || (body.partyId !== null && !LEDGER_ID.test(String(body.partyId)))) return fail('Choose a party, or none.');
  try {
    const entity = await entityId();
    if (body.partyId && !(await lookups()).parties.some((p) => p.id === body.partyId)) return fail('That party is not in the register.');
    await audit(auth.staff.id, entity, 'finance.requester_set', body.partyId ?? undefined);
    await rest(`/fin_entities?id=eq.${entity}`, { method: 'PATCH', body: JSON.stringify({ requester_party_id: body.partyId }) });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'set requester');
  }
}

// ---------------------------------------------------------------- periods
export async function listPeriods(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  try {
    const { lines, byLine } = await loadLedger(null, null);
    const periods = await rows('/fin_periods?select=month,status,closed_at');
    const allocations = await rowsAll('/fin_allocations?select=period,review_state&review_state=neq.ok&order=id.asc');
    const status = new Map(periods.map((p) => [String(p.month).slice(0, 10), p]));
    const months = new Map<string, { unallocated: number; review: number }>();
    const slot = (m: string) => months.get(m) ?? (months.set(m, { unallocated: 0, review: 0 }), months.get(m)!);
    for (const l of lines) {
      const allocs = byLine.get(l.id) ?? [];
      const m = periodOf(l.tran_date);
      slot(m);
      if (!allocs.some((a) => a.posted_at)) slot(m).unallocated++;
    }
    for (const a of allocations) slot(String(a.period).slice(0, 10)).review++;
    const capabilities = capabilitiesForRole('finance', auth.staff.role) as string[];
    return jsonResponse({
      canClose: capabilities.includes('close-period'),
      months: [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([month, c]) => ({ month, financialYear: financialYearOf(month), status: status.get(month)?.status ?? 'open', closedAt: status.get(month)?.closed_at ?? null, ...c })),
    });
  } catch (err) {
    return serverError(err, 'periods list');
  }
}

export async function closePeriod(req: Request, month: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'close-period');
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!MONTH.test(month)) return fail('That is not a month.');
  try {
    const entity = await entityId();
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const [lines, review, posted] = await Promise.all([
      rowsAll(`/fin_bank_lines?select=id&tran_date=gte.${month}&tran_date=lt.${next}&order=id.asc`),
      rowsAll(`/fin_allocations?select=id&period=eq.${month}&review_state=neq.ok&order=id.asc`),
      rowsAll('/fin_allocations?select=bank_line_id,id&posted_at=not.is.null&order=id.asc'),
    ]);
    const done = new Set(posted.map((a) => a.bank_line_id));
    const unallocated = lines.filter((l) => !done.has(l.id)).length;
    if (unallocated > 0 || review.length > 0) {
      return fail('This month is not ready to close.', 409, { unallocated, needsReview: review.length });
    }
    await audit(auth.staff.id, entity, 'finance.period_closed', month);
    await rpc('fin_close_period', { p_entity: entity, p_month: month, p_actor: auth.staff.id });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'close period');
  }
}

// For the Overview's "Needs you": how many lines are not posted yet and how many allocations wait for a second look.
export async function ledgerCounts(): Promise<{ unallocated: number; review: number }> {
  const { lines, byLine } = await loadLedger(null, null);
  let unallocated = 0;
  let review = 0;
  for (const l of lines) {
    const allocs = byLine.get(l.id) ?? [];
    if (!allocs.some((a) => a.posted_at)) unallocated++;
    if (allocs.some((a) => a.review_state !== 'ok')) review++;
  }
  return { unallocated, review };
}
