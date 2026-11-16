// Whether the person behind a UPI payment is in the Parties register, for the UPI table's Party column. Pure and I/O-free
// (finance-upi-parties.test.mjs); the endpoint (finance-upi-view.ts) supplies the register, the saved UPI ID lookups (finance-vpa.mjs) and the
// keyed fingerprints of the UPI IDs parties already hold.
//
// A UPI ID is matched by the ID first (a party holding that ID is the strongest evidence) and the name is then only a check on it: the registered
// name Razorpay gave for the ID against the party's name (or the name the bank showed when that account was verified). Without a party holding
// the ID, the registered name (or the name the app showed, when "Paid to" is a plain name) is matched to the register by name.
//
// states:
//   matches   the ID is on a party and Razorpay's name fits it (or a plain name matches one party by name)
//   onfile    the ID is on a party, but it has not been looked up, so the name is unchecked
//   differs   the ID is on a party, but Razorpay's registered name does not fit the party's name: to review
//   attach    no party holds the ID, but the registered name matches a party: the ID can be added to that party
//   missing   nobody matches: the person can be added to Parties
//   lookup    a UPI ID not looked up yet
//   noname    looked up, no name on file, no party holds the ID: cannot be added without a name
//   gateway   the UPI ID belongs to a payment gateway (Razorpay, PayU...): it names the gateway, not who was paid, so no name is taken from it, it
//             is never matched to a party or attached to one, and a person types the payee's name (one payment at a time: an ID serves many merchants)
//   unnamed   no name and no UPI ID at all
import { matchParty } from './finance-suggest.mjs';
import { namesResemble } from './finance-parties.mjs';
import { niceName } from './finance-party-suggestions.mjs';
import { isGatewayName, isGatewayVpa, vpaIn } from './finance-vpa.mjs';

/**
 * @param {{ counterparty?: string | null, direction?: string }} row  a UPI row ("Paid to" text and its direction)
 * @param {{
 *   parties: Array<{ id: string, name: string, kind?: string }>,
 *   byFingerprint: Map<string, { partyId: string, verifiedName: string | null }>,
 *   fingerprintOf: (vpa: string) => string | null,
 *   answers: { names: Record<string, string>, known: Set<string> },
 * }} ctx  the live parties, the UPI accounts parties hold (by keyed fingerprint), and the saved lookups
 */
export function partyStateFor(row, ctx) {
  const kind = row.direction === 'credit' ? 'customer' : 'vendor';
  const partyById = (id) => ctx.parties.find((p) => p.id === id) ?? null;
  const vpa = vpaIn(row.counterparty);
  if (vpa) {
    const registered = ctx.answers.names[vpa] ?? null;
    // A gateway's ID says nothing about the payee, even if a party was once given it: decided before any matching.
    if (isGatewayVpa(vpa) || isGatewayName(registered)) return { state: 'gateway', registeredName: registered ?? undefined, kind };
    const fp = ctx.fingerprintOf(vpa);
    const held = fp ? ctx.byFingerprint.get(fp) : null;
    const party = held ? partyById(held.partyId) : null;
    if (party) {
      if (!registered) return { state: 'onfile', partyId: party.id, partyName: party.name };
      const fits = namesResemble(party.name, registered) || Boolean(held?.verifiedName && namesResemble(held.verifiedName, registered));
      return { state: fits ? 'matches' : 'differs', partyId: party.id, partyName: party.name, registeredName: registered };
    }
    if (registered) {
      const m = matchParty(registered, ctx.parties);
      if (m) return { state: 'attach', partyId: m.partyId, partyName: partyById(m.partyId)?.name ?? '', registeredName: registered };
      return { state: 'missing', name: niceName(registered), kind, registeredName: registered };
    }
    return { state: ctx.answers.known.has(vpa) ? 'noname' : 'lookup' };
  }
  const appName = String(row.counterparty ?? '').replace(/\s+/g, ' ').trim();
  if (appName.length < 2) return { state: 'unnamed' };
  const m = matchParty(appName, ctx.parties);
  if (m) return { state: 'matches', partyId: m.partyId, partyName: partyById(m.partyId)?.name ?? '', by: 'name' };
  return { state: 'missing', name: niceName(appName), kind, by: 'name' };
}

/** What a reviewed add would do for a state, in words for the review list; null when nothing can be added from this row. */
export const addActionFor = (state) => (state === 'missing' || state === 'gateway' ? 'add' : state === 'attach' ? 'attach' : null);
