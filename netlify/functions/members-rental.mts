// Netlify Function (v2 API) behind "My rental" in the member portal (members.tvc.farm): a member offers their unit to
// guests who book through Linger, then manages it. Plan: docs/plans/accommodation-member-units.md; the rules are in
// scripts/lib/member-rental.mjs (and member-units.mjs, shared with the admin Units screen) and tested there.
//
//   GET  /api/members-me/rental                 where their rental stands, and their unit's stays and blocked dates
//   POST /api/members-me/rental/offer           offer a unit (whole or a room); TVC and Linger are told
//   POST /api/members-me/rental/withdraw        take back an offer that is still waiting for a contract
//   POST /api/members-me/rental/settings        how requests are answered (when they manage the unit), and whether the unit
//                                               stays open when the farm is closed
//   POST /api/members-me/rental/blocks          mark nights unavailable (a `unit-closure` booking, so a guest's nights cannot be
//                                               blocked and the calendar and partner availability follow)
//   POST /api/members-me/rental/blocks/remove   take back a block they made
//
// Only an owner who can sign in may use it, and only for their own household's unit. Every change is written to
// member_audit_log before it is made (ids and field names only, never a name or an email). The whole feature is dark until
// MEMBER_RENTAL_ENABLED=true, so it can be shipped before Linger is ready to talk to members.
import { requireMember, type MemberSession } from './lib/member-access';
import { privacyNoticeRequired } from '../../scripts/lib/member-privacy.mjs';
import { restHeaders } from '../../scripts/lib/supabase.mjs';
import { createBooking, deleteBooking, getBookingById, listBookingsForUnit } from '../../scripts/lib/accommodation-db.mjs';
import { validateOffer, validateSettings, validateBlock, canRemoveBlock, rentalState, shapeUnitBookings, offerNotice } from '../../scripts/lib/member-rental.mjs';
import { recordPartnerEvent, sendOfferNotice } from './lib/linger-notify';
import { checkFile, contractForMember, documentKey } from '../../scripts/lib/member-contract.mjs';
import { getContractDocument, putContractDocument } from './lib/contract-storage';
import { needsPayout, payoutForMember, validatePayout } from '../../scripts/lib/member-payout.mjs';
import { encryptPayoutText } from './lib/staff-mfa-crypto';

const OWNERS_ONLY = 'Only the owners of a unit can offer it to guests.';
const todayInIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const enabled = () => process.env.MEMBER_RENTAL_ENABLED === 'true';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function readJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function base(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('Missing SUPABASE_URL');
  return `${url}/rest/v1`;
}

async function select(table: string, query: string): Promise<any[]> {
  const res = await fetch(`${base()}/${table}?${query}`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`${table} select failed: ${res.status}`);
  return res.json();
}

async function write(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<{ ok: boolean; status: number; rows: any[] }> {
  const res = await fetch(`${base()}/${path}`, { method, headers: restHeaders({ Prefer: 'return=representation' }), body: body === undefined ? undefined : JSON.stringify(body) });
  const rows = res.ok ? await res.json().catch(() => []) : [];
  return { ok: res.ok, status: res.status, rows };
}

async function logChange(personId: string, action: string, detail: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${base()}/member_audit_log`, { method: 'POST', headers: restHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ actor_person_id: personId, action, detail }) }).catch(() => null);
  return !!res && res.ok;
}

// Signed in, invited, past the privacy notice, an owner of their unit. Returns what the handlers need.
async function requireOwner(req: Request): Promise<{ error: Response } | { member: MemberSession; householdId: string }> {
  const auth = await requireMember(req);
  if (!auth.ok) return { error: jsonResponse({ error: auth.error }, auth.status) };
  if (privacyNoticeRequired(auth.member.privacyVersion)) return { error: jsonResponse({ error: 'Please read the privacy notice first.' }, 403) };
  const householdId = auth.member.householdIds[0];
  if (!householdId || auth.member.roles[householdId] !== 'owner') return { error: jsonResponse({ error: OWNERS_ONLY }, 403) };
  return { member: auth.member, householdId };
}

type Household = { id: string; farm_unit: string; cluster: string | null };
type Offer = { id: string; shape: string; type_id: string; delegate_to_tvc: boolean; status: string; created_at: string };
type Unit = { id: string; pool_id: string | null; listing_shape: string | null; manager: 'tvc' | 'member'; status: string; request_mode: string; ignores_farm_closure: boolean };

async function load(householdId: string) {
  const [household] = (await select('member_households', `id=eq.${householdId}&select=id,farm_unit,cluster`)) as Household[];
  if (!household) return null;
  const [[offer], [unit], types] = await Promise.all([
    select('member_unit_offers', `household_id=eq.${householdId}&order=created_at.desc&limit=1&select=id,shape,type_id,delegate_to_tvc,status,created_at`) as Promise<Offer[]>,
    select('accommodation_units', `id=eq.${encodeURIComponent(household.farm_unit)}&select=id,pool_id,listing_shape,manager,status,request_mode,ignores_farm_closure`) as Promise<Unit[]>,
    select('accommodation_unit_pools', 'owner_type=eq.member&active=eq.true&select=id,name&order=sort_order.asc') as Promise<{ id: string; name: string }[]>,
  ]);
  return { household, offer: offer ?? null, unit: unit ?? null, types };
}

type Contract = { id: string; status: string; terms_version: string; shared_at: string; contract_doc: string; signed_doc: string | null };

// The contract shared for the offer that is still waiting, if there is one.
async function openContract(offerId: string | undefined): Promise<Contract | null> {
  if (!offerId) return null;
  const rows = (await select('member_unit_contracts', `offer_id=eq.${offerId}&status=in.(shared,signed)&select=id,status,terms_version,shared_at,contract_doc,signed_doc`)) as Contract[];
  return rows[0] ?? null;
}

async function handleGet(req: Request): Promise<Response> {
  const auth = await requireMember(req);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
  if (!enabled()) return jsonResponse({ enabled: false });
  const householdId = auth.member.householdIds[0];
  if (!householdId || auth.member.roles[householdId] !== 'owner') return jsonResponse({ enabled: true, eligible: false });
  const data = await load(householdId);
  if (!data) return jsonResponse({ enabled: true, eligible: false });
  const { household, offer, unit, types } = data;
  const state = rentalState({ offer, unit });
  const today = todayInIst();
  const live = unit && unit.status !== 'offboarded';
  const bookings = live ? await listBookingsForUnit(unit.id, today) : [];
  const shaped = shapeUnitBookings(bookings, household.farm_unit, today);
  // A farm-wide closure only matters to a unit that does not stay open through it.
  const blocks = shaped.blocks.filter((b: { farm: boolean }) => !(b.farm && unit?.ignores_farm_closure));
  const contract = offer?.status === 'interested' ? await openContract(offer.id) : null;
  const [live_contract] = (await select('member_unit_contracts', `household_id=eq.${householdId}&status=in.(shared,signed,active)&select=member_payout,status&limit=1`)) as { member_payout: string; status: string }[];
  const [account] = (await select('member_payout_accounts', `household_id=eq.${householdId}&select=household_id,payee_name,method,details_last4,pan_last4,status,updated_at`)) as any[];
  return jsonResponse({
    contract: contractForMember(contract),
    payout: { needed: needsPayout(live_contract), maintenance: live_contract?.member_payout === 'maintenance_adjustment', account: payoutForMember(account) },
    enabled: true,
    eligible: true,
    farmUnit: household.farm_unit,
    state,
    types: types.map((t) => ({ id: t.id, label: t.name })),
    offer: offer && offer.status === 'interested' ? { shape: offer.shape, typeId: offer.type_id, delegateToTvc: offer.delegate_to_tvc, createdAt: offer.created_at } : null,
    unit: live ? { shape: unit.listing_shape, typeId: unit.pool_id, manager: unit.manager, status: unit.status, requestMode: unit.request_mode, ignoresFarmClosure: unit.ignores_farm_closure } : null,
    stays: live ? shaped.stays : [],
    blocks: live ? blocks : [],
  });
}

async function handleOffer(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const { member, householdId } = who;
  const body = await readJson(req);
  const checked = validateOffer(body);
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  const data = await load(householdId);
  if (!data) return jsonResponse({ error: 'Server error' }, 500);
  if (rentalState({ offer: data.offer, unit: data.unit }) !== 'none') return jsonResponse({ error: 'You already have an offer or a unit that is rentable.' }, 409);

  const { shape, typeId, delegateToTvc } = checked.offer;
  if (!(await logChange(member.personId, 'member.rental.offer', { householdId, shape, typeId, delegateToTvc }))) return jsonResponse({ error: 'Could not record your offer, so nothing was sent. Try again.' }, 500);
  const made = await write('POST', 'member_unit_offers', { household_id: householdId, requested_by: member.personId, shape, type_id: typeId, delegate_to_tvc: delegateToTvc });
  if (!made.ok) return jsonResponse({ error: made.status === 409 ? 'You already have an offer waiting.' : 'Server error' }, made.status === 409 ? 409 : 500);

  // Tell TVC and Linger. The event is recorded first so a later API push can use it; a failed email never undoes the offer.
  const typeLabel = data.types.find((t) => t.id === typeId)?.name ?? typeId;
  const [person] = await select('member_people', `id=eq.${member.personId}&select=full_name,email`);
  const notice = offerNotice({ farmUnit: data.household.farm_unit, cluster: data.household.cluster, shape, typeLabel, delegateToTvc, memberName: person?.full_name ?? member.name, memberEmail: person?.email ?? '' });
  const eventId = await recordPartnerEvent('linger', { type: 'unit.offered', subject: data.household.farm_unit, payload: { offerId: made.rows[0]?.id, farmUnit: data.household.farm_unit, cluster: data.household.cluster, shape, typeId, typeLabel, delegateToTvc, memberName: person?.full_name ?? member.name, memberEmail: person?.email ?? null } });
  const sent = await sendOfferNotice({ subject: notice.subject, rows: notice.rows as [string, string][] }, eventId);
  return jsonResponse({ ok: true, lingerTold: sent.linger });
}

async function handleWithdraw(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const { member, householdId } = who;
  const data = await load(householdId);
  if (!data?.offer || data.offer.status !== 'interested') return jsonResponse({ error: 'There is no offer waiting.' }, 409);
  if (!(await logChange(member.personId, 'member.rental.withdraw', { householdId }))) return jsonResponse({ error: 'Could not record the change. Try again.' }, 500);
  const done = await write('PATCH', `member_unit_offers?id=eq.${data.offer.id}&status=eq.interested`, { status: 'withdrawn', decided_at: new Date().toISOString() });
  if (!done.ok || !done.rows.length) return jsonResponse({ error: 'The offer has already been dealt with.' }, 409);
  await write('PATCH', `member_unit_contracts?offer_id=eq.${data.offer.id}&status=in.(shared,signed)`, { status: 'cancelled', updated_at: new Date().toISOString() });
  return jsonResponse({ ok: true });
}

// The member reads their own contract copy (the one shared with them, or the signed one they uploaded). The server reads
// the file and hands it over; the member is never given a storage link.
async function handleContractGet(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const which = new URL(req.url).searchParams.get('which') === 'signed' ? 'signed' : 'contract';
  const data = await load(who.householdId);
  const contract = await openContract(data?.offer?.status === 'interested' ? data.offer.id : undefined);
  const key = which === 'signed' ? contract?.signed_doc : contract?.contract_doc;
  if (!contract || !key) return jsonResponse({ error: 'That document is not there.' }, 404);
  const bytes = await getContractDocument(key);
  if (!bytes) return jsonResponse({ error: 'That document is not there.' }, 404);
  const ext = key.split('.').pop() as string;
  const mime = ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg';
  return jsonResponse({ mime, name: `tvc-rental-${which}.${ext}`, base64: Buffer.from(bytes).toString('base64') });
}

// The member uploads the copy they have signed. The admin then records the dates and enables the unit.
async function handleContractSigned(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const { member, householdId } = who;
  const body = await readJson<{ file?: { mime?: string; base64?: string } }>(req);
  const file = checkFile(body?.file);
  if ('error' in file) return jsonResponse({ error: file.error }, 400);
  const data = await load(householdId);
  const contract = await openContract(data?.offer?.status === 'interested' ? data.offer.id : undefined);
  if (!contract) return jsonResponse({ error: 'There is no contract waiting for you to sign.' }, 409);
  if (!(await logChange(member.personId, 'member.rental.contract_signed', { householdId, contractId: contract.id }))) return jsonResponse({ error: 'Could not record the upload, so nothing was saved. Try again.' }, 500);
  const key = documentKey(householdId, contract.id, 'signed', file.ext);
  await putContractDocument(key, Buffer.from(body!.file!.base64!, 'base64'), file.mime);
  const done = await write('PATCH', `member_unit_contracts?id=eq.${contract.id}&status=in.(shared,signed)`, { status: 'signed', signed_doc: key, signed_uploaded_by: member.personId, signed_uploaded_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  if (!done.ok || !done.rows.length) return jsonResponse({ error: 'The contract has already been dealt with.' }, 409);
  return jsonResponse({ ok: true });
}

// Where TVC pays the member. The details are encrypted before they are stored and are never sent back to a browser;
// only "ending 4821" is. A change sends the account back for verification (a small test transfer) before any payout.
async function handlePayout(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const { member, householdId } = who;
  const [contract] = (await select('member_unit_contracts', `household_id=eq.${householdId}&status=in.(shared,signed,active)&select=member_payout,status&limit=1`)) as { member_payout: string; status: string }[];
  if (!needsPayout(contract)) return jsonResponse({ error: 'Your contract does not pay you by transfer, so there is nothing to enter.' }, 409);
  const checked = validatePayout(await readJson(req));
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  const p = checked.payout;
  if (!(await logChange(member.personId, 'member.rental.payout_details', { householdId, method: p.method }))) return jsonResponse({ error: 'Could not record the change, so nothing was saved. Try again.' }, 500);
  const row = {
    payee_name: p.payeeName,
    method: p.method,
    details_enc: encryptPayoutText(JSON.stringify(p.details)),
    details_last4: p.detailsLast4,
    pan_enc: encryptPayoutText(p.pan),
    pan_last4: p.panLast4,
    status: 'submitted',
    tds_applies: null,
    tds_rate: null,
    verified_by: null,
    verified_at: null,
    entered_by: member.personId,
    updated_at: new Date().toISOString(),
  };
  const existing = await select('member_payout_accounts', `household_id=eq.${householdId}&select=id`);
  const done = existing.length ? await write('PATCH', `member_payout_accounts?household_id=eq.${householdId}`, row) : await write('POST', 'member_payout_accounts', { household_id: householdId, ...row });
  if (!done.ok) return jsonResponse({ error: 'Server error' }, 500);
  return jsonResponse({ ok: true });
}

async function handleSettings(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const { member, householdId } = who;
  const data = await load(householdId);
  const checked = validateSettings(await readJson(req), data?.unit && { status: data.unit.status, manager: data.unit.manager });
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  if (!(await logChange(member.personId, 'member.rental.settings', { householdId, fields: Object.keys(checked.patch) }))) return jsonResponse({ error: 'Could not record the change. Try again.' }, 500);
  const done = await write('PATCH', `accommodation_units?id=eq.${encodeURIComponent(data!.household.farm_unit)}`, checked.patch);
  if (!done.ok) return jsonResponse({ error: 'Server error' }, 500);
  return jsonResponse({ ok: true });
}

async function handleBlockAdd(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const { member, householdId } = who;
  const data = await load(householdId);
  if (!data?.unit || data.unit.status === 'offboarded') return jsonResponse({ error: 'You have no unit that is rentable yet.' }, 409);
  const checked = validateBlock(await readJson(req), todayInIst());
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  if (!(await logChange(member.personId, 'member.rental.block', { householdId, from: checked.from, nights: checked.nights }))) return jsonResponse({ error: 'Could not record the change. Try again.' }, 500);
  try {
    await createBooking({ type: 'unit-closure', label: 'Blocked by the member', startDate: checked.from, nights: checked.nights, tents: [{ tentId: data.household.farm_unit, guests: [] }], createdBy: `member:${member.personId}` } as Parameters<typeof createBooking>[0]);
    return jsonResponse({ ok: true });
  } catch (err) {
    if ((err as { status?: number }).status === 409) return jsonResponse({ error: 'A guest already has some of those nights, so they cannot be blocked.' }, 409);
    console.error('[members-rental] block failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

async function handleBlockRemove(req: Request): Promise<Response> {
  const who = await requireOwner(req);
  if ('error' in who) return who.error;
  const { member, householdId } = who;
  const body = await readJson<{ id?: string }>(req);
  if (!body || !/^[0-9a-f-]{36}$/i.test(body.id ?? '')) return jsonResponse({ error: 'Choose a block to remove.' }, 400);
  const data = await load(householdId);
  if (!data) return jsonResponse({ error: 'Server error' }, 500);
  const booking = await getBookingById(body.id);
  if (!canRemoveBlock(booking, data.household.farm_unit, todayInIst())) return jsonResponse({ error: 'That block is not yours to remove.' }, 403);
  if (!(await logChange(member.personId, 'member.rental.unblock', { householdId }))) return jsonResponse({ error: 'Could not record the change. Try again.' }, 500);
  try {
    await deleteBooking(body.id, { deletedBy: `member:${member.personId}`, reason: 'Removed by the member' });
    return jsonResponse({ ok: true });
  } catch (err) {
    console.error('[members-rental] unblock failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
}

export default async (req: Request): Promise<Response> => {
  const p = new URL(req.url).pathname;
  const m = req.method;
  const routes: Record<string, (req: Request) => Promise<Response>> = {
    '/api/members-me/rental/offer': handleOffer,
    '/api/members-me/rental/withdraw': handleWithdraw,
    '/api/members-me/rental/settings': handleSettings,
    '/api/members-me/rental/blocks': handleBlockAdd,
    '/api/members-me/rental/blocks/remove': handleBlockRemove,
    '/api/members-me/rental/contract/signed': handleContractSigned,
    '/api/members-me/rental/payout': handlePayout,
  };
  const write = m === 'POST' ? routes[p] : undefined;
  const read = m === 'GET' ? (p === '/api/members-me/rental' ? handleGet : p === '/api/members-me/rental/contract' ? handleContractGet : undefined) : undefined;
  if (!read && !write) return jsonResponse({ error: 'Not found' }, 404);
  // Dark until it is switched on; writes and the document answer as if the page did not exist.
  if (!enabled() && (write || p !== '/api/members-me/rental')) return jsonResponse({ error: 'Not found' }, 404);
  try {
    return write ? await write(req) : await read!(req);
  } catch (err) {
    console.error('[members-rental] request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = {
  path: ['/api/members-me/rental', '/api/members-me/rental/offer', '/api/members-me/rental/withdraw', '/api/members-me/rental/settings', '/api/members-me/rental/blocks', '/api/members-me/rental/blocks/remove', '/api/members-me/rental/contract', '/api/members-me/rental/contract/signed', '/api/members-me/rental/payout'],
};
