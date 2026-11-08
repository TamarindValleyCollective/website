// Netlify Function (v2 API) behind the finance module (docs/finance/DESIGN.md). Session 01 shipped the skeleton: an
// overview that proves the access rules. Session 03 adds statement import (bank statement files, one per year, and the
// Paytm UPI export): preview and commit, the imports list, and registering a bank account. The ledger, requests and
// payroll arrive in later sessions as further routes here. Session 05 adds the ledger: lines and their allocations, the
// review queue, rules, categories and period close (lib/finance-ledger.ts).
//
// Auth: Google Sign-In client-side; requireStaff (lib/staff-access.ts) on every request. Holding `finance-requests`
// grants nothing here: requireStaff looks up the role in the `finance` module only, and an auditor's grant stops
// working when its expires_at passes.
//
// Auditors (read_only) are watched: each time one opens the overview it is written to fin_audit_log, and if the log
// cannot be written the page is refused rather than shown unrecorded.
import { requireStaff } from './lib/staff-access';
import { logFinanceAction } from './lib/finance-audit';
import { rest } from './lib/staff-mfa-store';
import { capabilitiesForRole } from './lib/staff-registry';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { payeeFieldVisibility } from '../../scripts/lib/finance-access.mjs';
import { todayIST } from '../../scripts/lib/finance-parties.mjs';
import { attentionOf } from '../../scripts/lib/finance-attention.mjs';
import { lookupIfsc } from '../../scripts/lib/finance-ifsc.mjs';
import { PARTY_ID, addEvidence, addMissingIfsc, getEvidence, listEvidence, addVendor, addPayeeAccount, createParty, listParties, mergeParty, retirePayeeAccount, revealPayeeAccount, reviewParty, unmergeParty, updateParty, verifyPayeeAccount } from './lib/finance-parties';
import { REQUEST_ID, addVoucher, cancelOrDecide, listFiles, createRecord, getVoucher, listMine, listRequests, matchRecord, reviewRecord, unmatchRecord } from './lib/finance-requests';
import { listUpiLines } from './lib/finance-upi-view';
import { setPaymentNote } from './lib/finance-notes';
import { heldCoverage, reconciliationOf, runImport } from './lib/finance-import';
import { supabaseImportStore } from './lib/finance-import-store';
import { LEDGER_ID, clearLedgerCache, closePeriod, ledgerAll, ledgerCounts, ledgerLine, listLedger, listPeriods, listRules, missingParties, postBatch, recategorise, reviewAllocation, saveAllocations, saveCategory, saveRule, setAllocationParties, setAllocationParty, setRequester } from './lib/finance-ledger';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// A count without fetching the rows: PostgREST answers with Content-Range "0-0/N" (or "*/N").
async function countRows(table: string, filter = ''): Promise<number> {
  const res = await rest(`/${table}?select=id${filter}&limit=1`, { headers: { Prefer: 'count=exact' } });
  const total = res.headers.get('content-range')?.split('/')[1];
  return total && /^\d+$/.test(total) ? Number(total) : 0;
}

// Which bank and branch an IFSC names (free Razorpay directory; only the IFSC is sent, never an account number).
async function handleIfsc(req: Request, code: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  return jsonResponse(await lookupIfsc(code));
}

async function handleOverview(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  const { staff } = auth;

  try {
    if (staff.role === 'read_only') {
      await logFinanceAction({ actorId: staff.id, action: 'finance.overview_viewed' });
    }
    const entities = (await (await rest('/fin_entities?select=id,name&order=created_at.asc&limit=1')).json()) as { id: string; name: string }[];
    const [bankAccounts, categories, openPeriods] = await Promise.all([
      countRows('fin_bank_accounts', '&active=eq.true'),
      countRows('fin_categories', '&active=eq.true'),
      countRows('fin_periods', '&status=eq.open'),
    ]);
    const capabilities = capabilitiesForRole('finance', staff.role);
    // What is waiting for a person: counts and labels only (scripts/lib/finance-attention.mjs).
    const rows = async (path: string) => (await (await rest(path)).json()) as Record<string, any>[];
    const store = supabaseImportStore();
    const [parties, accounts, batches, coverage, reconciliation] = await Promise.all([
      rows('/fin_parties?select=id,merged_into'),
      rows('/fin_party_accounts?select=id,party_id,method,status,fingerprint,created_at,retired_on,valid_from,has_ifsc,reviewed_at'),
      rows('/fin_import_batches?select=created_at&order=created_at.desc&limit=1'),
      heldCoverage(store),
      reconciliationOf(store),
    ]);
    const ledger = await ledgerCounts().catch(() => ({ unallocated: 0, review: 0 }));
    const attention = { ...attentionOf({ parties, accounts, coverage, reconciliation, batches, bankAccountCount: bankAccounts, today: todayIST() }), toAllocate: ledger.unallocated, toReview: ledger.review };
    return jsonResponse({
      entity: entities[0]?.name ?? null,
      role: staff.role,
      capabilities,
      visibility: payeeFieldVisibility(capabilities),
      counts: { bankAccounts, categories, openPeriods },
      attention,
      hasData: attention.parties > 0 || batches.length > 0,
    });
  } catch (err) {
    console.error('[finance-admin] overview failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// Statement files are small (a year of an account is tens of KB), and a Netlify Function request is capped near 6 MB.
const MAX_FILES = 12;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

async function handleImportList(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  try {
    const store = supabaseImportStore();
    const capabilities = capabilitiesForRole('finance', auth.staff.role);
    const accounts = (await (await rest('/fin_bank_accounts?select=id,label,last4,upi_label,badge_key&active=eq.true&kind=eq.bank&order=created_at.asc')).json()) as { id: string; label: string; last4: string | null; upi_label: string | null; badge_key: string | null }[];
    const bankBadges = (await (await rest('/fin_source_badges?select=key,label&kind=eq.bank&active=eq.true&order=sort.asc')).json()) as { key: string; label: string }[];
    const batches = await (
      await rest('/fin_import_batches?select=id,source,file_name,period_from,period_to,first_line_date,last_line_date,inserted_count,duplicate_count,ignored_count,failed_count,created_at&order=created_at.desc&limit=60')
    ).json();
    return jsonResponse({
      canImport: capabilities.includes('import'),
      canConfigure: capabilities.includes('configure'),
      accounts: accounts.map((a) => ({ id: a.id, label: a.label, last4: a.last4, hasUpiLabel: Boolean(a.upi_label), badgeKey: a.badge_key })),
      bankBadges,
      batches,
      coverage: await heldCoverage(store),
      reconciliation: await reconciliationOf(store),
    });
  } catch (err) {
    console.error('[finance-admin] imports list failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function handleImport(req: Request, commit: boolean): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'import');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ error: 'Send the files as a form upload.' }, 400);
  }
  const uploads = form.getAll('files').filter((f): f is File => typeof f !== 'string');
  if (uploads.length === 0) return jsonResponse({ error: 'Choose at least one file.' }, 400);
  if (uploads.length > MAX_FILES) return jsonResponse({ error: `Upload at most ${MAX_FILES} files at a time.` }, 400);
  if (uploads.some((f) => f.size > MAX_FILE_BYTES) || uploads.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
    return jsonResponse({ error: 'These files are too large to upload together. Upload fewer at a time.' }, 413);
  }
  try {
    const files = await Promise.all(uploads.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    return jsonResponse(await runImport({ store: supabaseImportStore(), files, commit, actorId: auth.staff.id }));
  } catch (err) {
    console.error('[finance-admin] import failed', err instanceof Error ? err.message : err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// Registering a bank account is a configuration act (directors only). Only the last four digits are ever stored, and
// `upiLabel` is the text the Paytm export uses for the account (for example "Bank name - 99").
async function handleAddBankAccount(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'configure');
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  let body: { label?: unknown; last4?: unknown; upiLabel?: unknown; badgeKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid request' }, 400);
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const last4 = typeof body.last4 === 'string' ? body.last4.trim() : '';
  const upiLabel = typeof body.upiLabel === 'string' && body.upiLabel.trim() ? body.upiLabel.trim() : null;
  if (!label || label.length > 60) return jsonResponse({ error: 'Give the account a short name.' }, 400);
  if (!/^\d{4}$/.test(last4)) return jsonResponse({ error: 'Enter the last four digits of the account number, and no more.' }, 400);
  if (upiLabel && upiLabel.length > 60) return jsonResponse({ error: 'The Paytm account label is too long.' }, 400);
  const badgeKey = typeof body.badgeKey === 'string' && body.badgeKey ? body.badgeKey : null;
  try {
    if (badgeKey && !/^[a-z][a-z0-9_]{1,30}$/.test(badgeKey)) return jsonResponse({ error: 'Choose the bank from the list.' }, 400);
    if (badgeKey && ((await (await rest(`/fin_source_badges?key=eq.${badgeKey}&kind=eq.bank&active=eq.true&select=key`)).json()) as unknown[]).length === 0) return jsonResponse({ error: 'Choose the bank from the list.' }, 400);
    const entities = (await (await rest('/fin_entities?select=id&order=created_at.asc&limit=1')).json()) as { id: string }[];
    if (!entities[0]) return jsonResponse({ error: 'Server error' }, 500);
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/fin_bank_accounts`, {
      method: 'POST',
      headers: restHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify({ entity_id: entities[0].id, label, last4, upi_label: upiLabel, kind: 'bank', badge_key: badgeKey }),
    });
    if (res.status === 409) return jsonResponse({ error: 'An account with that name already exists.' }, 409);
    if (!res.ok) throw new Error(`insert failed: ${res.status}`);
    const [created] = (await res.json()) as { id: string }[];
    await logFinanceAction({ actorId: auth.staff.id, action: 'finance.bank_account_added', entityId: entities[0].id, target: created.id });
    return jsonResponse({ id: created.id }, 201);
  } catch (err) {
    console.error('[finance-admin] add bank account failed', err instanceof Error ? err.message : err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

// Any write drops the ledger's short-lived reference cache (before, so the work sees fresh data; after, so the next read does).
export default async (req: Request): Promise<Response> => {
  const writes = req.method !== 'GET' && req.method !== 'HEAD';
  // A read can ask for fresh data (`fresh=1`): the pages do after a post, which another warm instance may not have seen yet.
  if (writes || new URL(req.url).searchParams.get('fresh') === '1') clearLedgerCache();
  try {
    return await dispatch(req);
  } finally {
    if (writes) clearLedgerCache();
  }
};

const dispatch = async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  const route = pathname.replace('/api/finance-admin', '');
  if (route === '/overview' && req.method === 'GET') return handleOverview(req);
  // Statement import and bank accounts (session 03)
  if (route === '/imports' && req.method === 'GET') return handleImportList(req);
  if (route === '/imports/preview' && req.method === 'POST') return handleImport(req, false);
  if (route === '/imports/commit' && req.method === 'POST') return handleImport(req, true);
  if (route === '/bank-accounts' && req.method === 'POST') return handleAddBankAccount(req);
  // Parties and payee accounts (session 04)
  const ifsc = /^\/ifsc\/([A-Za-z0-9]{1,11})$/.exec(route);
  if (ifsc && req.method === 'GET') return handleIfsc(req, ifsc[1]);
  if (route === '/parties' && req.method === 'GET') return listParties(req);
  if (route === '/parties' && req.method === 'POST') return createParty(req);
  const party = /^\/parties\/([^/]+)(\/accounts|\/review|\/merge|\/unmerge)?$/.exec(route);
  if (party && PARTY_ID.test(party[1])) {
    if (!party[2] && req.method === 'PATCH') return updateParty(req, party[1]);
    if (party[2] === '/accounts' && req.method === 'POST') return addPayeeAccount(req, party[1]);
    if (party[2] === '/review' && req.method === 'POST') return reviewParty(req, party[1]);
    if (party[2] === '/merge' && req.method === 'POST') return mergeParty(req, party[1]);
    if (party[2] === '/unmerge' && req.method === 'POST') return unmergeParty(req, party[1]);
  }
  const evidenceOf = /^\/accounts\/([^/]+)\/evidence$/.exec(route);
  if (evidenceOf && PARTY_ID.test(evidenceOf[1])) {
    if (req.method === 'POST') return addEvidence(req, evidenceOf[1]);
    if (req.method === 'GET') return listEvidence(req, evidenceOf[1]);
  }
  const evidenceFile = /^\/evidence\/([^/]+)$/.exec(route);
  if (evidenceFile && PARTY_ID.test(evidenceFile[1]) && req.method === 'GET') return getEvidence(req, evidenceFile[1]);
  const account = /^\/accounts\/([^/]+)\/(reveal|verify|retire|ifsc)$/.exec(route);
  if (account && PARTY_ID.test(account[1]) && req.method === 'POST') {
    if (account[2] === 'reveal') return revealPayeeAccount(req, account[1]);
    if (account[2] === 'retire') return retirePayeeAccount(req, account[1]);
    if (account[2] === 'ifsc') return addMissingIfsc(req, account[1]);
    return verifyPayeeAccount(req, account[1]);
  }
  // Payment requests and spend logs (session 08)
  if (route === '/requests/mine' && req.method === 'GET') return listMine(req);
  if (route === '/requests' && req.method === 'GET') return listRequests(req);
  if (route === '/requests' && req.method === 'POST') return createRecord(req);
  if (route === '/vendors' && req.method === 'POST') return addVendor(req);
  const voucher = /^\/vouchers\/([^/]+)$/.exec(route);
  if (voucher && REQUEST_ID.test(voucher[1]) && req.method === 'GET') return getVoucher(req, voucher[1]);
  const files = /^\/requests\/([^/]+)\/files$/.exec(route);
  if (files && REQUEST_ID.test(files[1]) && req.method === 'GET') return listFiles(req, files[1]);
  const request = /^\/requests\/([^/]+)\/(vouchers|decide|match|unmatch|review)$/.exec(route);
  if (request && REQUEST_ID.test(request[1]) && req.method === 'POST') {
    if (request[2] === 'vouchers') return addVoucher(req, request[1]);
    if (request[2] === 'decide') return cancelOrDecide(req, request[1]);
    if (request[2] === 'match') return matchRecord(req, request[1]);
    if (request[2] === 'unmatch') return unmatchRecord(req, request[1]);
    return reviewRecord(req, request[1]);
  }
  // Ledger and review (session 05)
  if (route === '/upi-lines' && req.method === 'GET') return listUpiLines(req);
  if (route === '/payment-note' && req.method === 'POST') return setPaymentNote(req);
  if (route === '/ledger' && req.method === 'GET') return listLedger(req);
  if (route === '/ledger/all' && req.method === 'GET') return ledgerAll(req);
  if (route === '/ledger/post' && req.method === 'POST') return postBatch(req);
  if (route === '/ledger/missing-parties' && req.method === 'GET') return missingParties(req);
  if (route === '/allocations/parties' && req.method === 'POST') return setAllocationParties(req);
  const line = /^\/ledger\/([^/]+)(\/allocations)?$/.exec(route);
  if (line && LEDGER_ID.test(line[1])) {
    if (!line[2] && req.method === 'GET') return ledgerLine(req, line[1]);
    if (line[2] && req.method === 'POST') return saveAllocations(req, line[1]);
  }
  const review = /^\/allocations\/([^/]+)\/review$/.exec(route);
  if (review && LEDGER_ID.test(review[1]) && req.method === 'POST') return reviewAllocation(req, review[1]);
  const setParty = /^\/allocations\/([^/]+)\/party$/.exec(route);
  if (setParty && LEDGER_ID.test(setParty[1]) && req.method === 'POST') return setAllocationParty(req, setParty[1]);
  if (route === '/rules' && req.method === 'GET') return listRules(req);
  if (route === '/rules' && req.method === 'POST') return saveRule(req, null);
  const rule = /^\/rules\/([^/]+)$/.exec(route);
  if (rule && LEDGER_ID.test(rule[1]) && req.method === 'PATCH') return saveRule(req, rule[1]);
  if (route === '/categories' && req.method === 'POST') return saveCategory(req, null, null);
  if (route === '/categories/recategorise' && req.method === 'POST') return recategorise(req);
  const category = /^\/categories\/([^/]+)(\/merge)?$/.exec(route);
  if (category && LEDGER_ID.test(category[1])) {
    if (!category[2] && req.method === 'PATCH') return saveCategory(req, category[1], null);
    if (category[2] && req.method === 'POST') return saveCategory(req, category[1], 'merge');
  }
  if (route === '/settings/requester' && req.method === 'POST') return setRequester(req);
  if (route === '/periods' && req.method === 'GET') return listPeriods(req);
  const period = /^\/periods\/(\d{4}-\d{2}-\d{2})\/close$/.exec(route);
  if (period && req.method === 'POST') return closePeriod(req, period[1]);
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = {
  path: [
    '/api/finance-admin/overview',
    '/api/finance-admin/imports',
    '/api/finance-admin/imports/preview',
    '/api/finance-admin/imports/commit',
    '/api/finance-admin/bank-accounts',
    '/api/finance-admin/ifsc/*',
    '/api/finance-admin/parties',
    '/api/finance-admin/parties/*',
    '/api/finance-admin/accounts/*',
    '/api/finance-admin/evidence/*',
    '/api/finance-admin/upi-lines',
    '/api/finance-admin/requests',
    '/api/finance-admin/requests/*',
    '/api/finance-admin/vendors',
    '/api/finance-admin/vouchers/*',
    '/api/finance-admin/payment-note',
    '/api/finance-admin/ledger',
    '/api/finance-admin/ledger/*',
    '/api/finance-admin/allocations/*',
    '/api/finance-admin/rules',
    '/api/finance-admin/rules/*',
    '/api/finance-admin/categories',
    '/api/finance-admin/categories/*',
    '/api/finance-admin/settings/*',
    '/api/finance-admin/periods',
    '/api/finance-admin/periods/*',
  ],
};
