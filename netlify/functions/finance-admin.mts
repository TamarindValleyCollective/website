// Netlify Function (v2 API) behind the finance module (docs/finance/DESIGN.md). Session 01 ships only the
// skeleton: an overview that proves the access rules and reports what exists (no data yet). Imports, the ledger,
// requests and payroll arrive in later sessions as further routes here.
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
import { payeeFieldVisibility } from '../../scripts/lib/finance-access.mjs';
import { PARTY_ID, addPayeeAccount, createParty, listParties, retirePayeeAccount, revealPayeeAccount, reviewParty, updateParty, verifyPayeeAccount } from './lib/finance-parties';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// A count without fetching the rows: PostgREST answers with Content-Range "0-0/N" (or "*/N").
async function countRows(table: string, filter = ''): Promise<number> {
  const res = await rest(`/${table}?select=id${filter}&limit=1`, { headers: { Prefer: 'count=exact' } });
  const total = res.headers.get('content-range')?.split('/')[1];
  return total && /^\d+$/.test(total) ? Number(total) : 0;
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
    return jsonResponse({
      entity: entities[0]?.name ?? null,
      role: staff.role,
      capabilities,
      visibility: payeeFieldVisibility(capabilities),
      counts: { bankAccounts, categories, openPeriods },
      hasData: false, // nothing is imported yet; later sessions replace this with real figures
    });
  } catch (err) {
    console.error('[finance-admin] overview failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

export default async (req: Request): Promise<Response> => {
  const { pathname } = new URL(req.url);
  const route = pathname.replace('/api/finance-admin', '');
  if (route === '/overview' && req.method === 'GET') return handleOverview(req);
  if (route === '/parties' && req.method === 'GET') return listParties(req);
  if (route === '/parties' && req.method === 'POST') return createParty(req);
  const party = /^\/parties\/([^/]+)(\/accounts|\/review)?$/.exec(route);
  if (party && PARTY_ID.test(party[1])) {
    if (!party[2] && req.method === 'PATCH') return updateParty(req, party[1]);
    if (party[2] === '/accounts' && req.method === 'POST') return addPayeeAccount(req, party[1]);
    if (party[2] === '/review' && req.method === 'POST') return reviewParty(req, party[1]);
  }
  const account = /^\/accounts\/([^/]+)\/(reveal|verify|retire)$/.exec(route);
  if (account && PARTY_ID.test(account[1]) && req.method === 'POST') {
    if (account[2] === 'reveal') return revealPayeeAccount(req, account[1]);
    if (account[2] === 'retire') return retirePayeeAccount(req, account[1]);
    return verifyPayeeAccount(req, account[1]);
  }
  return jsonResponse({ error: 'Not found' }, 404);
};

export const config = { path: ['/api/finance-admin/overview', '/api/finance-admin/parties', '/api/finance-admin/parties/*', '/api/finance-admin/accounts/*'] };
