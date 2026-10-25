// Guest + admin notifications for accommodation allocations, sent by an admin
// member from the accommodation calendar once an allocation is finalized
// (accommodation-admin.mts: /bookings/notify, and /bookings/delete for
// cancellations). Never automatic: saving a booking sends nothing. Like
// booking-notify.ts, every send is best-effort and never throws, and test-mode
// (Razorpay test keys) routes email to the test inbox and WhatsApp to
// WHATSAPP_TEST_NUMBER, so this can be exercised without messaging a member.
//
// A guest is messaged on every channel we have for them: WhatsApp if a mobile
// is on file (STOP opt-outs are still honoured by sendWhatsAppTemplate; there
// is no per-guest opt-in field, by decision 2026-10-12), email if one is.
import { diffNotices, snapshotOf, checkOutDate } from '../../../scripts/lib/stay-notice.mjs';
import { getPeopleByIds, getUnitLabels } from '../../../scripts/lib/accommodation-db.mjs';
import { escapeHtml, detailRow, detailTable, EMAIL_COLORS, renderBrandedEmail, renderStaffEmail } from './email-layout';
import { sendEmail, isTestMode } from './booking-notify';
import { sendWhatsAppTemplate, sendStaffWhatsAppAlert, firstNameOf, formatEventDate, cleanTemplateParam } from './whatsapp-send';
import type { WhatsAppTemplateName } from './whatsapp-templates';

const STAFF_EMAILS = ['core-team@tvc.farm', 'stay@linger.in'];
// Unit names come from the units table (members' units are not in code); loaded at the start of each send.
let UNIT_LABELS = new Map<string, string>();

type Kind = 'confirmed' | 'updated' | 'cancelled';
interface Snapshot {
  startDate: string;
  nights: number;
  assignments: { personId: string; tentId: string }[];
}

interface Person {
  id: string;
  name: string;
  mobileNumber?: string;
  email?: string;
}

export interface GuestOutcome {
  name: string;
  kind: Kind;
  whatsapp: 'sent' | 'skipped' | 'failed';
  email: 'sent' | 'none' | 'failed';
}

const GUEST_TEMPLATE: Record<Kind, WhatsAppTemplateName> = {
  confirmed: 'tvc_stay_confirmed',
  updated: 'tvc_stay_updated',
  cancelled: 'tvc_stay_cancelled',
};

function tentLabels(snapshot: Snapshot, personId: string): string {
  const labels = snapshot.assignments.filter((a) => a.personId === personId).map((a) => UNIT_LABELS.get(a.tentId) ?? a.tentId);
  return labels.join(' and ') || 'the farm';
}

function guestEmailHtml(kind: Kind, firstName: string, where: string, checkIn: string, checkOut: string): { subject: string; html: string } {
  const details = detailTable(
    detailRow('Where', escapeHtml(where), { bold: true }) + detailRow('Check-in', escapeHtml(checkIn)) + detailRow('Check-out', escapeHtml(checkOut), { last: true }),
  );
  const outro = `<p style="font-size:13px; color:${EMAIL_COLORS.muted}; margin-bottom:0;">Questions? Just reply to this email.</p>`;
  if (kind === 'cancelled') {
    return {
      subject: 'Your stay at the farm is cancelled',
      html: renderBrandedEmail(`        <p style="margin-top:0;">Hi ${escapeHtml(firstName)},</p>
        <p>Your stay at the farm from <strong>${escapeHtml(checkIn)}</strong> has been cancelled.</p>
        <p>If you weren't expecting this, or you'd like to rebook, just reply to this email and we'll sort it out.</p>`),
    };
  }
  const updated = kind === 'updated';
  return {
    subject: updated ? 'Your stay at the farm has changed' : 'Your stay at the farm is confirmed',
    html: renderBrandedEmail(`        <p style="margin-top:0;">Hi ${escapeHtml(firstName)},</p>
        <p>${updated ? "There's been a change to your stay at the farm. This replaces what we told you before." : 'Your stay at the farm is confirmed.'}</p>
        ${details}
        <p><a href="https://tvc.farm/visit/how-to-reach">Directions to the farm</a></p>
        ${outro}`),
  };
}

async function notifyGuest(person: Person, kind: Kind, snapshot: Snapshot): Promise<GuestOutcome> {
  const first = firstNameOf(person.name);
  const where = tentLabels(snapshot, person.id);
  const checkIn = formatEventDate(snapshot.startDate);
  const checkOut = formatEventDate(checkOutDate(snapshot.startDate, snapshot.nights));
  const params = kind === 'cancelled' ? [first, checkIn] : [first, where, checkIn, checkOut];
  const mail = guestEmailHtml(kind, first, where, checkIn, checkOut);

  const [wa, mailOk] = await Promise.all([
    person.mobileNumber
      ? sendWhatsAppTemplate({ template: GUEST_TEMPLATE[kind], to: person.mobileNumber, params: params.map((p) => cleanTemplateParam(p)), isTest: isTestMode() })
      : Promise.resolve('skipped' as const),
    person.email ? sendEmail({ to: [person.email], replyTo: 'core-team@tvc.farm', ...mail }) : Promise.resolve(null),
  ]);
  return { name: person.name, kind, whatsapp: wa, email: mailOk === null ? 'none' : mailOk ? 'sent' : 'failed' };
}

async function notifyStaff(action: Kind, member: string, snapshot: Snapshot, outcomes: GuestOutcome[], people: Map<string, Person>): Promise<void> {
  const checkOutIso = checkOutDate(snapshot.startDate, snapshot.nights);
  const dates = `${snapshot.startDate} to ${checkOutIso}`;
  const guests = outcomes
    .map((o) => {
      const id = [...people.values()].find((p) => p.name === o.name)?.id;
      return `${o.name} (${id ? tentLabels(snapshot, id) : 'removed'}) - ${o.kind}`;
    })
    .join(', ');
  await Promise.all([
    sendStaffWhatsAppAlert('tvc_stay_staff_alert', [action, cleanTemplateParam(member), dates, cleanTemplateParam(guests)]),
    sendEmail({
      to: STAFF_EMAILS,
      subject: `Stay allocation ${action} — ${member}`,
      html: renderStaffEmail(`  <p style="margin-top:0;">A stay allocation for <strong>${escapeHtml(member)}</strong> was <strong>${action}</strong> from the accommodation calendar.</p>
  ${detailTable(
    detailRow('Dates', escapeHtml(dates)) +
      outcomes
        .map((o, i) =>
          detailRow(escapeHtml(o.name), `${o.kind} · WhatsApp ${o.whatsapp} · email ${o.email}`, { last: i === outcomes.length - 1 }),
        )
        .join(''),
  )}`),
    }),
  ]);
}

// Sends whatever the diff between what guests were last told (null = never
// finalized) and the booking as it stands now calls for. Returns the outcomes
// (no contact details) so the page can show who was reached.
export async function sendStayNotices(booking: any, previous: Snapshot | null): Promise<{ current: Snapshot; outcomes: GuestOutcome[] }> {
  UNIT_LABELS = await getUnitLabels();
  const current: Snapshot = snapshotOf(booking);
  const changes = diffNotices(previous, current) as { personId: string; kind: Kind }[];
  const people = new Map<string, Person>();
  for (const t of booking.tents) for (const g of t.guests) if (g.personId) people.set(g.personId, { id: g.personId, name: g.name, mobileNumber: g.mobileNumber, email: g.email });
  const missing = changes.filter((c) => !people.has(c.personId)).map((c) => c.personId);
  for (const [id, p] of await getPeopleByIds(missing)) people.set(id, p);

  const outcomes: GuestOutcome[] = [];
  for (const c of changes) {
    const person = people.get(c.personId);
    // A removed guest is told about the stay they had; everyone else about the new one.
    if (person) outcomes.push(await notifyGuest(person, c.kind, c.kind === 'cancelled' ? (previous as Snapshot) : current));
  }
  if (outcomes.length > 0) await notifyStaff(previous ? 'updated' : 'confirmed', booking.label ?? 'Member stay', current, outcomes, people);
  return { current, outcomes };
}

// The whole booking is being cancelled: tell everyone the last notice named.
export async function sendStayCancellation(booking: any, previous: Snapshot): Promise<GuestOutcome[]> {
  UNIT_LABELS = await getUnitLabels();
  const ids = [...new Set(previous.assignments.map((a) => a.personId))];
  const people = await getPeopleByIds(ids);
  const outcomes: GuestOutcome[] = [];
  for (const id of ids) {
    const person = people.get(id);
    if (person) outcomes.push(await notifyGuest(person, 'cancelled', previous));
  }
  if (outcomes.length > 0) await notifyStaff('cancelled', booking.label ?? 'Member stay', previous, outcomes, people);
  return outcomes;
}
