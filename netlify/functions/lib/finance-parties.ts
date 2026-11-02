// The parties directory and payee-account routes behind /api/finance-admin (docs/finance/sessions/04-parties-and-payees.md).
// Rules live in scripts/lib/finance-parties.mjs (pure, tested); this file does the encrypting, reading and writing.
//
// What leaves the server: names, kinds and "ending 0123" to anyone with `finance` view. The full details leave only
// through `reveal`, which needs `verify-payee` AND the MFA step-up, and is written to fin_audit_log BEFORE the numbers
// are returned (if the log fails, nothing is returned). Nothing returns the ciphertext or the fingerprint.
import { requireStaff } from './staff-access';
import { stepUpIsValid } from './staff-admin-guard';
import { decryptFinanceText, encryptFinanceText, fingerprintFinanceText, MfaNotConfiguredError } from './staff-mfa-crypto';
import { mfaSummary, rest } from './staff-mfa-store';
import { capabilitiesForRole } from './staff-registry';
import { logFinanceAction } from './finance-audit';
import {
  PARTY_KINDS,
  auditDetailIsSafe,
  canVerifyAccount,
  partyForResponse,
  planDetailsChange,
  sharedAccountFlags,
  validatePartyChange,
  validateParty,
  validatePayeeDetails,
} from '../../../scripts/lib/finance-parties.mjs';
import { fingerprintText } from '../../../scripts/lib/finance-party-import.mjs';

type Json = Record<string, any>;
const ID = /^[\w-]{1,64}$/;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
const fail = (error: string, status = 400, code?: string) => jsonResponse({ error, ...(code ? { code } : {}) }, status);

async function readBody(req: Request): Promise<Json | null> {
  try {
    const body = await req.json();
    return body && typeof body === 'object' ? (body as Json) : null;
  } catch {
    return null;
  }
}

const rows = async (path: string): Promise<Json[]> => (await (await rest(path)).json()) as Json[];

// The audit detail is checked before it is written: a number or UPI id in it is a bug, and the write is refused.
async function audit(actorId: string, entityId: string, action: string, target: string, detail?: Json) {
  if (!auditDetailIsSafe(detail ?? null)) throw new Error('refusing to write sensitive data to the audit log');
  await logFinanceAction({ actorId, entityId, action, target, detail });
}

async function entityId(): Promise<string> {
  const e = await rows('/fin_entities?select=id&order=created_at.asc&limit=1');
  if (!e[0]) throw new Error('no entity');
  return e[0].id as string;
}

const ACCOUNT_COLUMNS = 'id,party_id,method,last4,status,fingerprint,created_by,created_at,verified_at';

// Encrypts and stores new details as an unverified row. `existing` are the party's current account rows.
async function addAccount(partyId: string, entity: string, actorId: string, payee: Json, existing: Json[]) {
  const checked = validatePayeeDetails(payee);
  if (checked.error || !checked.details) return { error: (checked.error ?? 'Enter the details.') as string };
  const details = checked.details;
  const fingerprint = fingerprintFinanceText(fingerprintText(details));
  const plan = planDetailsChange(existing, details.method, fingerprint);
  if (plan.action === 'unchanged') return { unchanged: true as const };
  // Supersede first: if the insert then fails, the party is left with no usable account (safe), never two.
  if (plan.supersedeIds.length) {
    await rest(`/fin_party_accounts?id=in.(${plan.supersedeIds.join(',')})`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'superseded', superseded_at: new Date().toISOString() }),
    });
  }
  const res = await rest('/fin_party_accounts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      entity_id: entity,
      party_id: partyId,
      method: details.method,
      details_enc: encryptFinanceText(JSON.stringify(details)),
      last4: checked.last4,
      fingerprint,
      created_by: actorId,
    }),
  });
  const [created] = (await res.json()) as Json[];
  return { created, superseded: plan.supersedeIds.length, method: details.method as string };
}

function serverError(err: unknown, what: string): Response {
  if (err instanceof MfaNotConfiguredError) return jsonResponse({ error: 'Payee storage is not configured yet (STAFF_MFA_KEY).' }, 500);
  console.error(`[finance-admin] ${what} failed`, err);
  return jsonResponse({ error: 'Server error' }, 500);
}

// ---------------------------------------------------------------- list
export async function listParties(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'view');
  if (!auth.ok) return fail(auth.error, auth.status);
  const { staff } = auth;
  try {
    const q = (new URL(req.url).searchParams.get('q') ?? '').replace(/[*,()%]/g, ' ').trim().slice(0, 60);
    const parties = await rows(`/fin_parties?select=id,name,kind,active,household_id&order=name.asc${q ? `&name=ilike.*${encodeURIComponent(q)}*` : ''}`);
    const accounts = await rows(`/fin_party_accounts?select=${ACCOUNT_COLUMNS}&order=created_at.asc`);
    const flags = sharedAccountFlags(accounts);
    const capabilities = capabilitiesForRole('finance', staff.role) as string[];
    const canVerify = capabilities.includes('verify-payee');
    let me: Json | null = null;
    if (canVerify) {
      const mfa = await mfaSummary(staff.id);
      me = { id: staff.id, ready: mfa.ready, hasPasskey: mfa.passkey, stepUpValid: stepUpIsValid(req, staff.id) };
    }
    return jsonResponse({
      kinds: PARTY_KINDS,
      canEdit: capabilities.includes('allocate'),
      canVerify,
      me,
      parties: parties.map((p) => partyForResponse(p, accounts.filter((a) => a.party_id === p.id), flags)),
    });
  } catch (err) {
    return serverError(err, 'list parties');
  }
}

// -------------------------------------------------------------- create
export async function createParty(req: Request): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const { staff } = auth;
  const body = await readBody(req);
  if (!body) return fail('Send the party as JSON.');
  const checked = validateParty(body);
  if (checked.error || !checked.party) return fail(checked.error ?? 'Enter the party.');
  // Validate the payee before writing anything, so a bad number leaves no half-made party.
  if (body.payee !== undefined && body.payee !== null) {
    const p = validatePayeeDetails(body.payee);
    if (p.error) return fail(p.error);
  }
  try {
    let householdId: string | null = null;
    if (body.householdId !== undefined && body.householdId !== null) {
      if (checked.party.kind !== 'member' || typeof body.householdId !== 'string' || !ID.test(body.householdId)) return fail('Only a member can be linked to a household.');
      const h = await rows(`/member_households?id=eq.${body.householdId}&select=id`);
      if (!h[0]) return fail('That household does not exist.');
      householdId = body.householdId;
    }
    const entity = await entityId();
    const res = await rest('/fin_parties', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ entity_id: entity, ...checked.party, household_id: householdId, created_by: staff.id }),
    });
    const [party] = (await res.json()) as Json[];
    let added: Awaited<ReturnType<typeof addAccount>> | null = null;
    if (body.payee) added = await addAccount(party.id, entity, staff.id, body.payee, []);
    await audit(staff.id, entity, 'finance.party_created', party.id, { kind: party.kind, linkedHousehold: Boolean(householdId), withPayee: Boolean(body.payee) });
    if (added && 'created' in added && added.created) await audit(staff.id, entity, 'finance.payee_added', added.created.id, { partyId: party.id, method: added.method });
    const accounts = await rows(`/fin_party_accounts?party_id=eq.${party.id}&select=${ACCOUNT_COLUMNS}`);
    return jsonResponse({ party: partyForResponse(party, accounts, new Map()) }, 201);
  } catch (err) {
    return serverError(err, 'create party');
  }
}

// -------------------------------------------------------------- update
export async function updateParty(req: Request, id: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const { staff } = auth;
  const body = await readBody(req);
  if (!body) return fail('Send the changes as JSON.');
  try {
    const [party] = await rows(`/fin_parties?id=eq.${id}&select=id,name,kind,active,household_id`);
    if (!party) return fail('Not found', 404);
    const change = validatePartyChange(party, body);
    if (change.error || !change.changed) return fail(change.error ?? 'Nothing to change.');
    if (!change.changed.length) return jsonResponse({ ok: true, changed: [] });
    await rest(`/fin_parties?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...change.patch, updated_at: new Date().toISOString() }) });
    await audit(staff.id, await entityId(), 'finance.party_updated', id, { changed: change.changed });
    return jsonResponse({ ok: true, changed: change.changed });
  } catch (err) {
    return serverError(err, 'update party');
  }
}

// ---------------------------------------------------- new/changed details
export async function addPayeeAccount(req: Request, partyId: string): Promise<Response> {
  const auth = await requireStaff(req, 'finance', 'allocate');
  if (!auth.ok) return fail(auth.error, auth.status);
  const { staff } = auth;
  const body = await readBody(req);
  if (!body) return fail('Send the details as JSON.');
  try {
    const [party] = await rows(`/fin_parties?id=eq.${partyId}&select=id`);
    if (!party) return fail('Not found', 404);
    const existing = await rows(`/fin_party_accounts?party_id=eq.${partyId}&select=${ACCOUNT_COLUMNS}`);
    const entity = await entityId();
    const result = await addAccount(partyId, entity, staff.id, body, existing);
    if ('error' in result) return fail(result.error ?? 'Enter the details.');
    if ('unchanged' in result) return jsonResponse({ unchanged: true });
    await audit(staff.id, entity, 'finance.payee_changed', result.created.id, { partyId, method: result.method, superseded: result.superseded });
    return jsonResponse({ ok: true, status: 'unverified', superseded: result.superseded }, 201);
  } catch (err) {
    return serverError(err, 'add payee account');
  }
}

// ----------------------------------------- reveal and verify (step-up)
async function requireVerifier(req: Request) {
  const auth = await requireStaff(req, 'finance', 'verify-payee');
  if (!auth.ok) return { response: fail(auth.error, auth.status) };
  try {
    if (!stepUpIsValid(req, auth.staff.id)) return { response: fail('Verify a second factor first.', 403, 'STEP_UP_REQUIRED') };
  } catch (err) {
    return { response: serverError(err, 'step-up check') };
  }
  return { staff: auth.staff };
}

export async function revealPayeeAccount(req: Request, accountId: string): Promise<Response> {
  const gate = await requireVerifier(req);
  if (!gate.staff) return gate.response;
  const { staff } = gate;
  try {
    const [account] = await rows(`/fin_party_accounts?id=eq.${accountId}&select=id,party_id,status,details_enc,entity_id`);
    if (!account) return fail('Not found', 404);
    // Logged first: if the log cannot be written, the numbers are not returned.
    await audit(staff.id, account.entity_id, 'finance.payee_revealed', account.id, { partyId: account.party_id });
    const details = JSON.parse(decryptFinanceText(account.details_enc));
    const [party] = await rows(`/fin_parties?id=eq.${account.party_id}&select=name`);
    return jsonResponse({ details, status: account.status, partyName: party?.name ?? null });
  } catch (err) {
    return serverError(err, 'reveal payee account');
  }
}

export async function verifyPayeeAccount(req: Request, accountId: string): Promise<Response> {
  const gate = await requireVerifier(req);
  if (!gate.staff) return gate.response;
  const { staff } = gate;
  try {
    const [account] = await rows(`/fin_party_accounts?id=eq.${accountId}&select=id,party_id,status,created_by,entity_id`);
    if (!account) return fail('Not found', 404);
    if (account.status !== 'unverified') return fail('Only unverified details can be verified.');
    const verdict = canVerifyAccount(account, staff.id);
    if (!verdict.ok) return fail(verdict.error ?? 'Not allowed.', 403);
    await rest(`/fin_party_accounts?id=eq.${accountId}&status=eq.unverified`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'verified', verified_by: staff.id, verified_at: new Date().toISOString() }),
    });
    await audit(staff.id, account.entity_id, 'finance.payee_verified', account.id, { partyId: account.party_id });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'verify payee account');
  }
}

export const PARTY_ID = ID;
