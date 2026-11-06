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
  validateRetirement,
  validateVerification,
  validateMerge,
  foldMerged,
  validateEffectiveOn,
  todayIST,
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

const ACCOUNT_COLUMNS = 'id,party_id,method,last4,status,fingerprint,created_by,created_at,verified_at,verified_by,verification_method,verification_note,valid_from,retired_on,has_ifsc,reviewed_at';

// Encrypts and stores new details as an unverified row. `existing` are the party's current account rows.
async function addAccount(partyId: string, entity: string, actorId: string, payee: Json, existing: Json[], effectiveOn: string | null = null) {
  const checked = validatePayeeDetails(payee);
  if (checked.error || !checked.details) return { error: (checked.error ?? 'Enter the details.') as string };
  const details = checked.details;
  const fingerprint = fingerprintFinanceText(fingerprintText(details));
  const sameDetails = (row: Json) => {
    if (!row.details_enc) return true;
    const old = JSON.parse(decryptFinanceText(row.details_enc));
    return old.account === details.account && (old.ifsc ?? '') === (details.ifsc ?? '') && old.upi === details.upi;
  };
  const plan: Json = planDetailsChange(existing, details.method, fingerprint, sameDetails, effectiveOn);
  if (plan.action === 'unchanged') return { unchanged: true as const };
  const retireIds: string[] = plan.retireIds ?? [];
  // Supersede first: if the insert then fails, the party is left with no usable account (safe), never two.
  if (plan.supersedeIds.length) {
    await rest(`/fin_party_accounts?id=in.(${plan.supersedeIds.join(',')})`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'superseded', superseded_at: new Date().toISOString() }),
    });
  }
  // With an effective date the old account stays payable until that day (it is retired from it); the new one starts then.
  if (retireIds.length) {
    await rest(`/fin_party_accounts?id=in.(${retireIds.join(',')})`, {
      method: 'PATCH',
      body: JSON.stringify({ retired_on: effectiveOn, retired_at: new Date().toISOString(), retired_by: actorId, retire_reason: `Replaced by new details from ${effectiveOn}` }),
    });
  }
  const res = await rest('/fin_party_accounts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      entity_id: entity,
      party_id: partyId,
      has_ifsc: details.method === 'bank' ? Boolean(details.ifsc) : true,
      valid_from: plan.validFrom ?? null,
      method: details.method,
      details_enc: encryptFinanceText(JSON.stringify(details)),
      last4: checked.last4,
      fingerprint,
      created_by: actorId,
    }),
  });
  const [created] = (await res.json()) as Json[];
  return { created, superseded: plan.supersedeIds.length as number, retiring: retireIds.length, method: details.method as string };
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
    const q = (new URL(req.url).searchParams.get('q') ?? '').replace(/[*,()%]/g, ' ').trim().slice(0, 60).toLowerCase();
    // Every party is read so that a party merged into another folds into it, whatever the search text matches.
    // former_since exists once migration 0085 is applied; until then it is simply not read.
    const allParties = await rows('/fin_parties?select=id,name,kind,active,household_id,merged_into,former_since&order=name.asc').catch(() => rows('/fin_parties?select=id,name,kind,active,household_id,merged_into&order=name.asc'));
    const accounts = await rows(`/fin_party_accounts?select=${ACCOUNT_COLUMNS}&order=created_at.asc`);
    const { visible, accountsOf, mergedCount, canonicalOf } = foldMerged(allParties, accounts);
    const flags = sharedAccountFlags(accounts, canonicalOf);
    // Who verified what: names for the verifiers' ids (a name, never an email).
    const verifierIds = [...new Set(accounts.map((a) => a.verified_by as string).filter(Boolean))];
    const names = new Map<string, string>();
    if (verifierIds.length) {
      for (const u of await rows(`/staff_users?id=in.(${verifierIds.join(',')})&select=id,name`)) if (u.name) names.set(u.id as string, u.name as string);
    }
    const capabilities = capabilitiesForRole('finance', staff.role) as string[];
    const canVerify = capabilities.includes('verify-payee');
    let me: Json | null = null;
    if (canVerify) {
      const mfa = await mfaSummary(staff.id);
      me = { id: staff.id, ready: mfa.ready, hasPasskey: mfa.passkey, stepUpValid: stepUpIsValid(req, staff.id) };
    }
    const shown = visible
      .filter((p: Json) => !q || p.name.toLowerCase().includes(q))
      .map((p: Json) => partyForResponse(p, accountsOf(p.id), flags, todayIST(), mergedCount(p.id), names));
    return jsonResponse({
      kinds: PARTY_KINDS,
      canEdit: capabilities.includes('allocate'),
      canVerify,
      me,
      parties: shown,
      needsReviewCount: shown.filter((p: Json) => p.needsReview).length,
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
  const body = await readBody(req);
  if (!body) return fail('Send the details as JSON.');
  // Changing an account on a date retires the old one on that date, which is a verifier's decision (verify-payee and the
  // step-up). Without a date the old details are replaced at once, which anyone who can enter details may do: that only
  // stops the old account being paid until the new one is verified.
  const dated = body.effectiveOn !== undefined && body.effectiveOn !== null && body.effectiveOn !== '';
  let actorId: string;
  let effectiveOn: string | null = null;
  if (dated) {
    const gate = await requireVerifier(req);
    if (!gate.staff) return gate.response;
    actorId = gate.staff.id;
    const checked = validateEffectiveOn(body.effectiveOn);
    if (checked.error || !checked.effectiveOn) return fail(checked.error ?? 'Enter the date as a real date.');
    effectiveOn = checked.effectiveOn;
  } else {
    const auth = await requireStaff(req, 'finance', 'allocate');
    if (!auth.ok) return fail(auth.error, auth.status);
    actorId = auth.staff.id;
  }
  try {
    const [party] = await rows(`/fin_parties?id=eq.${partyId}&select=id,merged_into`);
    if (!party) return fail('Not found', 404);
    if (party.merged_into) return fail('This party was merged into another. Add the details to the main party.');
    const mergedIn = (await rows(`/fin_parties?merged_into=eq.${partyId}&select=id`)).map((p) => p.id as string);
    const existing = await rows(`/fin_party_accounts?party_id=in.(${[partyId, ...mergedIn].join(',')})&select=${ACCOUNT_COLUMNS},details_enc`);
    const entity = await entityId();
    const result = await addAccount(partyId, entity, actorId, body, existing, effectiveOn);
    if ('error' in result) return fail(result.error ?? 'Enter the details.');
    if ('unchanged' in result) return jsonResponse({ unchanged: true });
    await audit(actorId, entity, 'finance.payee_changed', result.created.id, { partyId, method: result.method, superseded: result.superseded, retiring: result.retiring, ...(effectiveOn ? { effectiveOn } : {}) });
    return jsonResponse({ ok: true, status: 'unverified', superseded: result.superseded, retiring: result.retiring }, 201);
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
    const [account] = await rows(`/fin_party_accounts?id=eq.${accountId}&select=id,party_id,status,created_by,entity_id,details_enc,retired_on`);
    if (!account) return fail('Not found', 404);
    if (account.status !== 'unverified') return fail('Only unverified details can be verified.');
    if (account.retired_on && account.retired_on <= todayIST()) return fail('This account is already retired and cannot be verified.');
    const stored = JSON.parse(decryptFinanceText(account.details_enc));
    if (stored.method === 'bank' && !stored.ifsc) return fail('These bank details have no IFSC code. Add it with "Add or change details" first.');
    const verdict = canVerifyAccount(account, staff.id);
    if (!verdict.ok) return fail(verdict.error ?? 'Not allowed.', 403);
    // How it was checked is recorded with who and when (the database refuses a verification without it).
    const how = validateVerification((await readBody(req)) ?? {});
    if (how.error || !how.method) return fail(how.error ?? 'Say how you checked these details.');
    await rest(`/fin_party_accounts?id=eq.${accountId}&status=eq.unverified`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'verified', verified_by: staff.id, verified_at: new Date().toISOString(), verification_method: how.method, verification_note: how.note }),
    });
    // The method goes in the audit log; the free-text note stays on the row.
    await audit(staff.id, account.entity_id, 'finance.payee_verified', account.id, { partyId: account.party_id, method: how.method });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'verify payee account');
  }
}

// Retire an account from a date, with a reason (verify-payee + step-up). From that day the account must not be paid
// (accountPayableOn). The free-text reason is kept on the row for the verifiers; the audit log gets the date only.
export async function retirePayeeAccount(req: Request, accountId: string): Promise<Response> {
  const gate = await requireVerifier(req);
  if (!gate.staff) return gate.response;
  const { staff } = gate;
  const body = await readBody(req);
  if (!body) return fail('Send the date and reason as JSON.');
  try {
    const [account] = await rows(`/fin_party_accounts?id=eq.${accountId}&select=id,party_id,status,retired_on,entity_id`);
    if (!account) return fail('Not found', 404);
    const checked = validateRetirement(body, account);
    if (checked.error || !checked.retiredOn) return fail(checked.error ?? 'Enter the date.');
    await rest(`/fin_party_accounts?id=eq.${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ retired_on: checked.retiredOn, retired_at: new Date().toISOString(), retired_by: staff.id, retire_reason: checked.reason }),
    });
    await audit(staff.id, account.entity_id, 'finance.payee_retired', account.id, { partyId: account.party_id, on: checked.retiredOn });
    return jsonResponse({ ok: true, retiredOn: checked.retiredOn });
  } catch (err) {
    return serverError(err, 'retire payee account');
  }
}

// "I looked, keeping both accounts is intended" (verify-payee + step-up). It holds until a NEWER account is added.
export async function reviewParty(req: Request, partyId: string): Promise<Response> {
  const gate = await requireVerifier(req);
  if (!gate.staff) return gate.response;
  const { staff } = gate;
  try {
    const [party] = await rows(`/fin_parties?id=eq.${partyId}&select=id`);
    if (!party) return fail('Not found', 404);
    const live = await rows(`/fin_party_accounts?party_id=eq.${partyId}&status=neq.superseded&select=id,entity_id`);
    if (!live.length) return fail('This party has no payment details to review.');
    await rest(`/fin_party_accounts?party_id=eq.${partyId}&status=neq.superseded`, {
      method: 'PATCH',
      body: JSON.stringify({ reviewed_by: staff.id, reviewed_at: new Date().toISOString() }),
    });
    await audit(staff.id, live[0].entity_id, 'finance.party_reviewed', partyId, { accounts: live.length });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'review party');
  }
}

// Two parties that are really one payee (verify-payee + step-up). Nothing is moved or deleted: the duplicate is marked
// merged into the main party, whose view then holds both sets of accounts and is reviewed as one.
export async function mergeParty(req: Request, sourceId: string): Promise<Response> {
  const gate = await requireVerifier(req);
  if (!gate.staff) return gate.response;
  const { staff } = gate;
  const body = await readBody(req);
  const intoId = typeof body?.into === 'string' ? body.into : '';
  if (!ID.test(intoId)) return fail('Choose the party to merge into.');
  try {
    const [source] = await rows(`/fin_parties?id=eq.${sourceId}&select=id,merged_into,household_id,entity_id`);
    const [target] = await rows(`/fin_parties?id=eq.${intoId}&select=id,merged_into`);
    if (!source || !target) return fail('Not found', 404);
    const mergedIn = await rows(`/fin_parties?merged_into=eq.${sourceId}&select=id`);
    const verdict = validateMerge(source, target, { sourceHasMergedIn: mergedIn.length > 0 });
    if (!verdict.ok) return fail(verdict.error ?? 'Cannot merge these.');
    const accounts = await rows(`/fin_party_accounts?party_id=eq.${sourceId}&select=id`);
    await rest(`/fin_parties?id=eq.${sourceId}`, { method: 'PATCH', body: JSON.stringify({ merged_into: intoId, updated_at: new Date().toISOString() }) });
    await audit(staff.id, source.entity_id, 'finance.party_merged', sourceId, { into: intoId, accounts: accounts.length });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'merge party');
  }
}

export async function unmergeParty(req: Request, sourceId: string): Promise<Response> {
  const gate = await requireVerifier(req);
  if (!gate.staff) return gate.response;
  const { staff } = gate;
  try {
    const [source] = await rows(`/fin_parties?id=eq.${sourceId}&select=id,merged_into,entity_id`);
    if (!source) return fail('Not found', 404);
    if (!source.merged_into) return fail('This party is not merged.');
    await rest(`/fin_parties?id=eq.${sourceId}`, { method: 'PATCH', body: JSON.stringify({ merged_into: null, updated_at: new Date().toISOString() }) });
    await audit(staff.id, source.entity_id, 'finance.party_unmerged', sourceId, { from: source.merged_into });
    return jsonResponse({ ok: true });
  } catch (err) {
    return serverError(err, 'unmerge party');
  }
}

export const PARTY_ID = ID;
