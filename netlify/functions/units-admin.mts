// Netlify Function (v2 API) behind the Units screen: the super admin's view of the units Linger can sell. Members
// offer a unit in the member portal; here an offer is enabled once the contract is signed, a unit is paused,
// resumed or offboarded, and its tags, cluster, capacity and private note are edited. Backs /internal/units.
// Plan: docs/plans/accommodation-member-units.md. The rules (what an offer may contain, what enabling creates, when
// a unit may be offboarded) are in scripts/lib/member-units.mjs and tested there.
//
// Who may use it: super admins only. Reading needs a signed-in super admin; every change goes through
// requireAccessAdmin (lib/staff-admin-guard.ts), the same second-factor step-up as the Access page. Each change is
// written to staff_audit_log *before* it is made and refused if the log can't be written. The log holds unit ids,
// types and field names, never the farm manager's note or any member's details.
import { requireSuperAdmin, logStaffAction, type SuperAdmin } from './lib/staff-access';
import { requireAccessAdmin, stepUpIsValid } from './lib/staff-admin-guard';
import { MfaNotConfiguredError } from './lib/staff-mfa-crypto';
import { mfaSummary, rest } from './lib/staff-mfa-store';
import { enablePlan, offboardProblem, offerProblem, editPatch, statusChange } from '../../scripts/lib/member-units.mjs';
import { validateShare, validateRecord, enableProblem, contractForAdmin, documentKey } from '../../scripts/lib/member-contract.mjs';
import { putContractDocument, signedContractUrl } from './lib/contract-storage';
import { payoutForAdmin, validateVerification } from '../../scripts/lib/member-payout.mjs';
import { decryptPayoutText } from './lib/staff-mfa-crypto';
import { FEATURES, validateAccess } from '../../scripts/lib/member-features.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFBOARD_REASONS = ['member_withdrew', 'contract_ended', 'not_suitable', 'other'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function audit(admin: SuperAdmin, action: string, detail: Record<string, unknown>): Promise<boolean> {
  try {
    await logStaffAction({ actorId: admin.id, action, module: 'accommodation', detail });
    return true;
  } catch (err) {
    console.error('Failed to write staff audit log', err);
    return false;
  }
}

const inList = (values: string[]) => `in.(${values.map((v) => encodeURIComponent(v)).join(',')})`;
const todayInIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

type UnitRow = {
  id: string;
  name: string;
  kind: string;
  capacity: number;
  owner_type: string;
  owner_farm_unit: string | null;
  pool_id: string | null;
  status: string;
  manager: string;
  listing_shape: string | null;
  cluster: string | null;
  tags: string[];
  note: string | null;
  request_mode: string;
  ignores_farm_closure: boolean;
  sort_order: number;
};

const UNIT_SELECT = 'id,name,kind,capacity,owner_type,owner_farm_unit,pool_id,status,manager,listing_shape,cluster,tags,note,request_mode,ignores_farm_closure,sort_order';

async function getUnit(id: string): Promise<UnitRow | null> {
  const res = await rest(`/accommodation_units?id=eq.${encodeURIComponent(id)}&select=${UNIT_SELECT}`);
  return ((await res.json()) as UnitRow[])[0] ?? null;
}

// The bookings of a unit that have not ended: any whose stay runs past today.
async function futureBookingsFor(unitId: string): Promise<{ id: string; label: string | null; startDate: string; nights: number }[]> {
  const range = encodeURIComponent(`[${todayInIst()},2100-01-01)`);
  const res = await rest(`/accommodation_tent_assignments?tent_id=eq.${encodeURIComponent(unitId)}&stay_range=ov.${range}&select=booking_id`);
  const ids = [...new Set(((await res.json()) as { booking_id: string }[]).map((r) => r.booking_id))];
  if (!ids.length) return [];
  const rows = (await (await rest(`/accommodation_bookings?id=${inList(ids)}&select=id,label,event_title,start_date,nights&order=start_date.asc`)).json()) as { id: string; label: string | null; event_title: string | null; start_date: string; nights: number }[];
  return rows.map((b) => ({ id: b.id, label: b.event_title ?? b.label, startDate: b.start_date, nights: b.nights }));
}

async function handleOverview(req: Request, admin: SuperAdmin): Promise<Response> {
  const today = todayInIst();
  const range = encodeURIComponent(`[${today},2100-01-01)`);
  const [unitsRes, poolsRes, offersRes, aheadRes] = await Promise.all([
    rest(`/accommodation_units?select=${UNIT_SELECT}&order=sort_order.asc,id.asc`),
    rest('/accommodation_unit_pools?select=id,name,owner_type,sort_order&active=eq.true&order=sort_order.asc'),
    rest('/member_unit_offers?status=eq.interested&select=id,household_id,requested_by,shape,type_id,delegate_to_tvc,created_at&order=created_at.asc'),
    rest(`/accommodation_tent_assignments?stay_range=ov.${range}&select=tent_id,booking_id`),
  ]);
  const units = (await unitsRes.json()) as UnitRow[];
  const pools = (await poolsRes.json()) as { id: string; name: string; owner_type: string }[];
  const offers = (await offersRes.json()) as { id: string; household_id: string; requested_by: string | null; shape: string; type_id: string; delegate_to_tvc: boolean; created_at: string }[];
  const ahead = (await aheadRes.json()) as { tent_id: string; booking_id: string }[];
  const aheadCount = new Map<string, Set<string>>();
  for (const a of ahead) aheadCount.set(a.tent_id, (aheadCount.get(a.tent_id) ?? new Set()).add(a.booking_id));

  // Who owns a member unit, and who is asking: shown by name to a super admin, never by contact detail.
  const householdIds = [...new Set(offers.map((o) => o.household_id))];
  const farmUnits = [...new Set(units.map((u) => u.owner_farm_unit).filter((f): f is string => Boolean(f)))];
  const [offerHouseholds, unitHouseholds] = await Promise.all([
    householdIds.length ? rest(`/member_households?id=${inList(householdIds)}&select=id,farm_unit,house_no,cluster`).then((r) => r.json()) : [],
    farmUnits.length ? rest(`/member_households?farm_unit=${inList(farmUnits)}&select=id,farm_unit`).then((r) => r.json()) : [],
  ]);
  const hhById = new Map<string, { id: string; farm_unit: string; house_no: string | null; cluster: string | null }>((offerHouseholds as any[]).map((h) => [h.id, h]));
  const hhByFarmUnit = new Map<string, string>((unitHouseholds as any[]).map((h) => [h.farm_unit, h.id]));
  const ownerHouseholdIds = [...hhByFarmUnit.values()];
  const owners = ownerHouseholdIds.length ? ((await (await rest(`/member_household_members?household_id=${inList(ownerHouseholdIds)}&role=eq.owner&select=household_id,person_id`)).json()) as { household_id: string; person_id: string }[]) : [];
  const personIds = [...new Set([...owners.map((o) => o.person_id), ...offers.map((o) => o.requested_by).filter((p): p is string => Boolean(p))])];
  const people = personIds.length ? ((await (await rest(`/member_people?id=${inList(personIds)}&select=id,full_name`)).json()) as { id: string; full_name: string }[]) : [];
  const nameOf = new Map(people.map((p) => [p.id, p.full_name]));
  const offerIds = offers.map((o) => o.id);
  const contracts = offerIds.length ? ((await (await rest(`/member_unit_contracts?offer_id=${inList(offerIds)}&select=${CONTRACT_SELECT}`)).json()) as ContractRow[]) : [];
  const contractOf = new Map(contracts.map((c) => [c.offer_id, c]));

  // Payout accounts: masked ("ending 4821") and never decrypted here; revealing one is its own audited, step-up call.
  const payoutRows = (await (await rest('/member_payout_accounts?select=household_id,payee_name,method,details_last4,pan_last4,status,tds_applies,tds_rate,verified_at,updated_at&order=updated_at.desc')).json()) as any[];
  const payoutHouseholds = payoutRows.length ? ((await (await rest(`/member_households?id=${inList(payoutRows.map((r) => r.household_id))}&select=id,farm_unit,house_no`)).json()) as { id: string; farm_unit: string; house_no: string | null }[]) : [];
  const farmUnitOf = new Map(payoutHouseholds.map((h) => [h.id, h.farm_unit]));
  const houseNoOf = new Map(payoutHouseholds.map((h) => [h.id, h.house_no]));

  // Early access: who may use a feature that is not on for everyone. `everyone` says the Netlify flag already is. The
  // picker lists every household by its owners' names, so a member is chosen, not a number typed.
  const accessRows = (await (await rest('/member_feature_access?select=household_id,feature,created_at&order=created_at.asc')).json()) as { household_id: string; feature: string; created_at: string }[];
  const allHouseholds = (await (await rest('/member_households?select=id,farm_unit,house_no,cluster&order=house_no.asc')).json()) as { id: string; farm_unit: string; house_no: string | null; cluster: string | null }[];
  const allOwners = (await (await rest('/member_household_members?role=eq.owner&select=household_id,person_id')).json()) as { household_id: string; person_id: string }[];
  const ownerPeople = allOwners.length ? ((await (await rest(`/member_people?id=${inList([...new Set(allOwners.map((o) => o.person_id))])}&select=id,full_name`)).json()) as { id: string; full_name: string }[]) : [];
  const personName = new Map(ownerPeople.map((p) => [p.id, p.full_name]));
  const ownerNamesOf = (householdId: string) => allOwners.filter((o) => o.household_id === householdId).map((o) => personName.get(o.person_id) ?? '').filter(Boolean);
  const householdOf = new Map(allHouseholds.map((h) => [h.id, h]));

  let stepUpValid = false;
  try {
    stepUpValid = stepUpIsValid(req, admin.id);
  } catch (err) {
    if (!(err instanceof MfaNotConfiguredError)) throw err;
  }
  const mfa = await mfaSummary(admin.id);

  return jsonResponse({
    me: { id: admin.id, ready: mfa.ready, hasPasskey: mfa.passkey, stepUpValid },
    types: pools.map((p) => ({ id: p.id, label: p.name, ownerType: p.owner_type })),
    access: {
      features: Object.entries(FEATURES).map(([id, f]) => ({ id, label: f.label, everyone: process.env[f.env] === 'true' })),
      // Only a household with a home (a house number) can rent one out, so only those are offered.
      members: allHouseholds.filter((h) => h.house_no).map((h) => ({ householdId: h.id, farmUnit: h.farm_unit, houseNo: h.house_no, names: ownerNamesOf(h.id) })).filter((m) => m.names.length),
      grants: accessRows.map((r) => ({ householdId: r.household_id, farmUnit: householdOf.get(r.household_id)?.farm_unit ?? '', houseNo: householdOf.get(r.household_id)?.house_no ?? null, names: ownerNamesOf(r.household_id), feature: r.feature, since: r.created_at })),
    },
    payouts: payoutRows.map((r) => ({ ...payoutForAdmin(r), farmUnit: farmUnitOf.get(r.household_id) ?? '', houseNo: houseNoOf.get(r.household_id) ?? null })),
    units: units.map((u) => ({
      id: u.id,
      name: u.name,
      type: u.pool_id ?? '',
      kind: u.kind,
      capacity: u.capacity,
      ownerType: u.owner_type,
      ownerFarmUnit: u.owner_farm_unit,
      ownerNames: u.owner_farm_unit ? owners.filter((o) => o.household_id === hhByFarmUnit.get(u.owner_farm_unit!)).map((o) => nameOf.get(o.person_id) ?? '').filter(Boolean) : [],
      manager: u.manager,
      status: u.status,
      listingShape: u.listing_shape,
      cluster: u.cluster,
      tags: u.tags ?? [],
      note: u.note,
      requestMode: u.request_mode,
      ignoresFarmClosure: u.ignores_farm_closure,
      bookingsAhead: aheadCount.get(u.id)?.size ?? 0,
    })),
    offers: offers.map((o) => ({
      id: o.id,
      farmUnit: hhById.get(o.household_id)?.farm_unit ?? '',
      houseNo: hhById.get(o.household_id)?.house_no ?? null,
      cluster: hhById.get(o.household_id)?.cluster ?? null,
      memberName: o.requested_by ? (nameOf.get(o.requested_by) ?? '') : '',
      shape: o.shape,
      typeId: o.type_id,
      delegateToTvc: o.delegate_to_tvc,
      createdAt: o.created_at,
      contract: contractForAdmin(contractOf.get(o.id) ?? null),
    })),
  });
}

const CONTRACT_SELECT = 'id,offer_id,household_id,farm_unit,status,terms_version,type_id,shape,manager,member_pct,tvc_pct,linger_pct,member_payout,settlement_cycle,linger_contract_ref,linger_property_ref,linger_room_ref,signed_on,effective_from,ends_on,notice_days,contract_doc,signed_doc,shared_at,signed_uploaded_at';
type ContractRow = {
  id: string;
  offer_id: string;
  household_id: string;
  farm_unit: string;
  status: string;
  terms_version: string;
  type_id: string;
  shape: string;
  manager: string;
  member_pct: number | null;
  tvc_pct: number | null;
  linger_pct: number | null;
  member_payout: string;
  settlement_cycle: string;
  linger_contract_ref: string | null;
  linger_property_ref: string | null;
  linger_room_ref: string | null;
  signed_on: string | null;
  effective_from: string | null;
  ends_on: string | null;
  notice_days: number | null;
  contract_doc: string;
  signed_doc: string | null;
  shared_at: string;
  signed_uploaded_at: string | null;
};

async function getContractForOffer(offerId: string): Promise<ContractRow | null> {
  const res = await rest(`/member_unit_contracts?offer_id=eq.${offerId}&select=${CONTRACT_SELECT}`);
  return ((await res.json()) as ContractRow[])[0] ?? null;
}

type Offer = { id: string; household_id: string; shape: string; type_id: string; delegate_to_tvc: boolean; status: string };

async function getOffer(id: string): Promise<Offer | null> {
  const res = await rest(`/member_unit_offers?id=eq.${id}&select=id,household_id,shape,type_id,delegate_to_tvc,status`);
  return ((await res.json()) as Offer[])[0] ?? null;
}

async function handleEnable(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ offerId?: string; typeId?: string; delegateToTvc?: unknown }>(req);
  if (!body || !UUID.test(body.offerId ?? '')) return jsonResponse({ error: 'offerId must be a UUID' }, 400);
  const offer = await getOffer(body.offerId!);
  if (!offer) return jsonResponse({ error: 'Offer not found' }, 404);
  const hh = ((await (await rest(`/member_households?id=eq.${offer.household_id}&select=id,farm_unit,cluster`)).json()) as { id: string; farm_unit: string; cluster: string | null }[])[0];
  const existing = hh ? await getUnit(hh.farm_unit) : null;
  const maxRes = (await (await rest('/accommodation_units?select=sort_order&order=sort_order.desc&limit=1')).json()) as { sort_order: number }[];
  const typeId = typeof body.typeId === 'string' ? body.typeId : offer.type_id;
  const delegateToTvc = body.delegateToTvc === undefined ? offer.delegate_to_tvc : body.delegateToTvc === true;
  const plan = enablePlan({ offer, household: hh, existing, typeId, delegateToTvc, nextSortOrder: (maxRes[0]?.sort_order ?? 0) + 1 });
  if ('error' in plan) return jsonResponse({ error: plan.error }, 400);
  // The contract was shared for a particular type and manager; enabling on different terms would not match what was signed.
  const contract = await getContractForOffer(offer.id);
  const gate = enableProblem(contract);
  if (gate) return jsonResponse({ error: gate }, 400);
  if (contract!.type_id !== typeId || contract!.manager !== plan.unit.manager) return jsonResponse({ error: 'The signed contract is for a different type or manager. Share a new contract before changing them.' }, 400);

  if (!(await audit(admin, 'units.offer_enabled', { offerId: offer.id, unitId: plan.unit.id, typeId, manager: plan.unit.manager, shape: offer.shape, contractId: contract!.id }))) {
    return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  }
  // Claim the offer first, so two admins enabling it at once cannot both create a unit.
  const claimed = (await (await rest(`/member_unit_offers?id=eq.${offer.id}&status=eq.interested`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'enabled', type_id: typeId, delegate_to_tvc: delegateToTvc, decided_by: admin.id, decided_at: new Date().toISOString() }) })).json()) as unknown[];
  if (!claimed.length) return jsonResponse({ error: 'This offer has already been dealt with.' }, 409);
  try {
    if (plan.reuse) {
      await rest(`/accommodation_units?id=eq.${encodeURIComponent(plan.unit.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(plan.unit) });
    } else {
      await rest('/accommodation_units', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(plan.unit) });
    }
  } catch (err) {
    // Put the offer back so it can be tried again.
    await rest(`/member_unit_offers?id=eq.${offer.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'interested', decided_by: null, decided_at: null }) }).catch(() => {});
    throw err;
  }
  await rest(`/member_unit_contracts?id=eq.${contract!.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'active', activated_by: admin.id, activated_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return jsonResponse({ ok: true, unitId: plan.unit.id });
}

// Shares the electronic copy of the contract with the member, who then signs it and uploads their copy.
async function handleContractShare(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<Record<string, unknown> & { offerId?: string }>(req);
  if (!body || !UUID.test(body.offerId ?? '')) return jsonResponse({ error: 'offerId must be a UUID' }, 400);
  const offer = await getOffer(body.offerId!);
  if (!offer) return jsonResponse({ error: 'Offer not found' }, 404);
  // The admin may change the type or the manager before sharing; the contract is for what is chosen here.
  const chosen = { ...offer, type_id: typeof body.typeId === 'string' ? body.typeId : offer.type_id, delegate_to_tvc: body.delegateToTvc === undefined ? offer.delegate_to_tvc : body.delegateToTvc === true };
  const problem = offerProblem({ shape: chosen.shape, typeId: chosen.type_id, delegateToTvc: chosen.delegate_to_tvc });
  if (problem) return jsonResponse({ error: problem }, 400);
  const checked = validateShare(body, chosen);
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  if (await getContractForOffer(offer.id)) return jsonResponse({ error: 'A contract has already been shared for this offer.' }, 409);
  const id = crypto.randomUUID();
  const key = documentKey(offer.household_id, id, 'contract', checked.file.ext);
  const hh = ((await (await rest(`/member_households?id=eq.${offer.household_id}&select=farm_unit`)).json()) as { farm_unit: string }[])[0];
  if (!hh) return jsonResponse({ error: 'Household not found' }, 404);
  if (!(await audit(admin, 'units.contract_shared', { offerId: offer.id, contractId: id, termsVersion: checked.row.terms_version }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  await putContractDocument(key, Buffer.from((body.file as { base64: string }).base64, 'base64'), checked.file.mime);
  await rest('/member_unit_contracts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ id, offer_id: offer.id, household_id: offer.household_id, farm_unit: hh.farm_unit, contract_doc: key, shared_by: admin.id, ...checked.row }) });
  return jsonResponse({ ok: true });
}

// Dates, notice and Linger's references, recorded before the unit is enabled.
async function handleContractRecord(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<Record<string, unknown> & { offerId?: string }>(req);
  if (!body || !UUID.test(body.offerId ?? '')) return jsonResponse({ error: 'offerId must be a UUID' }, 400);
  const contract = await getContractForOffer(body.offerId!);
  if (!contract) return jsonResponse({ error: 'No contract has been shared for this offer.' }, 404);
  if (contract.status !== 'shared' && contract.status !== 'signed') return jsonResponse({ error: 'This contract can no longer be changed here.' }, 409);
  const { offerId: _ignored, ...fields } = body;
  const rec = validateRecord(fields);
  if ('error' in rec) return jsonResponse({ error: rec.error }, 400);
  if (!(await audit(admin, 'units.contract_recorded', { contractId: contract.id, fields: Object.keys(rec.patch) }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  await rest(`/member_unit_contracts?id=eq.${contract.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...rec.patch, updated_at: new Date().toISOString() }) });
  return jsonResponse({ ok: true });
}

// A link to the shared or signed copy that works for 60 seconds. Logged, and behind the same step-up as a change.
async function handleContractLink(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ offerId?: string; which?: string }>(req);
  if (!body || !UUID.test(body.offerId ?? '') || (body.which !== 'contract' && body.which !== 'signed')) return jsonResponse({ error: 'offerId and which (contract or signed) are required' }, 400);
  const contract = await getContractForOffer(body.offerId!);
  const key = body.which === 'signed' ? contract?.signed_doc : contract?.contract_doc;
  if (!contract || !key) return jsonResponse({ error: 'That document is not there yet.' }, 404);
  if (!(await audit(admin, 'units.contract_opened', { contractId: contract.id, which: body.which }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  return jsonResponse({ url: await signedContractUrl(key) });
}

async function handleDecline(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ offerId?: string }>(req);
  if (!body || !UUID.test(body.offerId ?? '')) return jsonResponse({ error: 'offerId must be a UUID' }, 400);
  const offer = await getOffer(body.offerId!);
  if (!offer) return jsonResponse({ error: 'Offer not found' }, 404);
  if (offer.status !== 'interested') return jsonResponse({ error: 'This offer has already been dealt with.' }, 409);
  if (!(await audit(admin, 'units.offer_declined', { offerId: offer.id }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  const done = (await (await rest(`/member_unit_offers?id=eq.${offer.id}&status=eq.interested`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'declined', decided_by: admin.id, decided_at: new Date().toISOString() }) })).json()) as unknown[];
  if (!done.length) return jsonResponse({ error: 'This offer has already been dealt with.' }, 409);
  await rest(`/member_unit_contracts?offer_id=eq.${offer.id}&status=in.(shared,signed)`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() }) });
  return jsonResponse({ ok: true });
}

const payoutRowFor = async (householdId: string) => ((await (await rest(`/member_payout_accounts?household_id=eq.${householdId}&select=*`)).json()) as any[])[0] ?? null;

// Marks a payout account verified (after a small test transfer to it) and records whether TDS is deducted.
async function handlePayoutVerify(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<Record<string, unknown> & { householdId?: string }>(req);
  if (!body || !UUID.test(body.householdId ?? '')) return jsonResponse({ error: 'householdId must be a UUID' }, 400);
  const row = await payoutRowFor(body.householdId!);
  if (!row) return jsonResponse({ error: 'No payout details for that household.' }, 404);
  const checked = validateVerification(body);
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  if (!(await audit(admin, 'units.payout_verified', { householdId: row.household_id, tdsApplies: checked.verification.tds_applies }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  await rest(`/member_payout_accounts?household_id=eq.${row.household_id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...checked.verification, status: 'verified', verified_by: admin.id, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
  return jsonResponse({ ok: true });
}

// Decrypts one payout account for a super admin who has to make the payment. Behind the step-up; audited with the
// household and the fact of the reveal, never the values. The response is not cached.
async function handlePayoutReveal(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ householdId?: string }>(req);
  if (!body || !UUID.test(body.householdId ?? '')) return jsonResponse({ error: 'householdId must be a UUID' }, 400);
  const row = await payoutRowFor(body.householdId!);
  if (!row) return jsonResponse({ error: 'No payout details for that household.' }, 404);
  if (!(await audit(admin, 'units.payout_revealed', { householdId: row.household_id }))) return jsonResponse({ error: 'Could not write the audit log; nothing was shown.' }, 500);
  return jsonResponse({ payeeName: row.payee_name, method: row.method, details: JSON.parse(decryptPayoutText(row.details_enc)), pan: decryptPayoutText(row.pan_enc) });
}

// Adds a household to a feature's early-access list, or takes it off.
async function handleAccess(req: Request, admin: SuperAdmin): Promise<Response> {
  const checked = validateAccess(await readJson(req));
  if ('error' in checked) return jsonResponse({ error: checked.error }, 400);
  const { householdId, feature, enabled } = checked.access;
  const hh = ((await (await rest(`/member_households?id=eq.${householdId}&select=id`)).json()) as { id: string }[])[0];
  if (!hh) return jsonResponse({ error: 'That member was not found.' }, 404);
  if (!(await audit(admin, enabled ? 'units.access_granted' : 'units.access_removed', { householdId: hh.id, feature }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  if (enabled) await rest('/member_feature_access?on_conflict=household_id,feature', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify({ household_id: hh.id, feature, granted_by: admin.id }) });
  else await rest(`/member_feature_access?household_id=eq.${hh.id}&feature=eq.${feature}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return jsonResponse({ ok: true });
}

async function handleStatus(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ unitId?: string; status?: string }>(req);
  if (!body || typeof body.unitId !== 'string' || !body.unitId) return jsonResponse({ error: 'unitId is required' }, 400);
  const unit = await getUnit(body.unitId);
  const change = statusChange(unit, body.status);
  if ('error' in change) return jsonResponse({ error: change.error }, unit ? 400 : 404);
  if (!(await audit(admin, change.status === 'paused' ? 'units.paused' : 'units.resumed', { unitId: unit!.id }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  await rest(`/accommodation_units?id=eq.${encodeURIComponent(unit!.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: change.status }) });
  return jsonResponse({ ok: true });
}

async function handleOffboard(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<{ unitId?: string; reason?: string }>(req);
  if (!body || typeof body.unitId !== 'string' || !body.unitId) return jsonResponse({ error: 'unitId is required' }, 400);
  if (!OFFBOARD_REASONS.includes(body.reason ?? '')) return jsonResponse({ error: 'Choose a reason.' }, 400);
  const unit = await getUnit(body.unitId);
  if (!unit) return jsonResponse({ error: 'Unit not found' }, 404);
  if (unit.status === 'offboarded') return jsonResponse({ error: 'This unit has already been offboarded.' }, 409);
  const future = await futureBookingsFor(unit.id);
  const problem = offboardProblem(future);
  if (problem) return jsonResponse({ error: problem, bookings: future }, 409);
  if (!(await audit(admin, 'units.offboarded', { unitId: unit.id, reason: body.reason }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  await rest(`/accommodation_units?id=eq.${encodeURIComponent(unit.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'offboarded' }) });
  return jsonResponse({ ok: true });
}

async function handleEdit(req: Request, admin: SuperAdmin): Promise<Response> {
  const body = await readJson<Record<string, unknown> & { unitId?: string }>(req);
  if (!body || typeof body.unitId !== 'string' || !body.unitId) return jsonResponse({ error: 'unitId is required' }, 400);
  const unit = await getUnit(body.unitId);
  if (!unit) return jsonResponse({ error: 'Unit not found' }, 404);
  const { unitId: _ignored, ...fields } = body;
  const edit = editPatch(fields);
  if ('error' in edit) return jsonResponse({ error: edit.error }, 400);
  if (!(await audit(admin, 'units.edited', { unitId: unit.id, fields: Object.keys(edit.patch) }))) return jsonResponse({ error: 'Could not write the audit log; nothing was changed.' }, 500);
  await rest(`/accommodation_units?id=eq.${encodeURIComponent(unit.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(edit.patch) });
  return jsonResponse({ ok: true });
}

export default async (req: Request): Promise<Response> => {
  const p = new URL(req.url).pathname;
  const m = req.method;
  const writes: Record<string, (req: Request, admin: SuperAdmin) => Promise<Response>> = {
    '/api/units-admin/offers/enable': handleEnable,
    '/api/units-admin/offers/decline': handleDecline,
    '/api/units-admin/contracts/share': handleContractShare,
    '/api/units-admin/contracts/record': handleContractRecord,
    '/api/units-admin/contracts/link': handleContractLink,
    '/api/units-admin/access': handleAccess,
    '/api/units-admin/payouts/verify': handlePayoutVerify,
    '/api/units-admin/payouts/reveal': handlePayoutReveal,
    '/api/units-admin/units/status': handleStatus,
    '/api/units-admin/units/offboard': handleOffboard,
    '/api/units-admin/units/edit': handleEdit,
  };
  const isRead = p === '/api/units-admin/overview' && m === 'GET';
  const write = m === 'POST' ? writes[p] : undefined;
  if (!isRead && !write) return jsonResponse({ error: 'Not found' }, 404);

  try {
    if (isRead) {
      const auth = await requireSuperAdmin(req);
      if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);
      return await handleOverview(req, auth.admin);
    }
    const auth = await requireAccessAdmin(req);
    if (!auth.ok) return jsonResponse({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    return await write!(req, auth.admin);
  } catch (err) {
    if (err instanceof MfaNotConfiguredError) {
      console.error('Second factors are not configured:', err.message);
      return jsonResponse({ error: 'Second-factor storage is not configured yet (STAFF_MFA_KEY).', code: 'MFA_NOT_CONFIGURED' }, 500);
    }
    console.error('units-admin request failed', err);
    return jsonResponse({ error: 'Server error' }, 500);
  }
};

export const config = {
  path: [
    '/api/units-admin/overview',
    '/api/units-admin/offers/enable',
    '/api/units-admin/offers/decline',
    '/api/units-admin/contracts/share',
    '/api/units-admin/contracts/record',
    '/api/units-admin/contracts/link',
    '/api/units-admin/access',
    '/api/units-admin/payouts/verify',
    '/api/units-admin/payouts/reveal',
    '/api/units-admin/units/status',
    '/api/units-admin/units/offboard',
    '/api/units-admin/units/edit',
  ],
};
