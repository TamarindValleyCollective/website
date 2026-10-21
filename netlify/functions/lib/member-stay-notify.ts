// Emails for a member's own stay booked or cancelled in the portal (members-me.mts: /stays, /stays/cancel).
// Who is told: the core team and Madhavan (so the calendar and the farm are ready), and the member who
// booked, as their receipt. Best-effort and never throws: the booking is already saved, so a failed email
// is logged and does not undo it. In test mode (Razorpay test keys) sendEmail routes everything to the
// test inbox. WhatsApp for stays follows once the Meta templates are approved (docs/plans/member-portal.md).
import { checkOut } from '../../../scripts/lib/member-stay.mjs';
import { escapeHtml, detailRow, detailTable, renderBrandedEmail, renderStaffEmail } from './email-layout';
import { sendEmail } from './booking-notify';

const STAFF_EMAILS = ['core-team@tvc.farm', 'madhavan@tvc.farm'];

export interface StayEmail {
  farmUnit: string;
  memberName: string;
  memberEmail: string | null;
  startDate: string;
  nights: number;
  guestCount: number;
  party: { name: string; ageGroup: string; guest: boolean; stayRequirements?: string }[];
  note: string;
}

function when(stay: StayEmail): string {
  return `${stay.startDate} to ${checkOut(stay.startDate, stay.nights)} (${stay.nights} night${stay.nights === 1 ? '' : 's'})`;
}

function who(stay: StayEmail): string {
  return stay.party.map((p) => `${p.name}${p.ageGroup === 'Child' ? ' (child)' : ''}${p.guest ? ' (paying guest)' : ''}`).join(', ');
}

// Food or allergy needs for this stay only, one line per person who has one ("no onions"). Their standing
// allergies and preferences are on their guest directory record, which Madhavan sees when he allocates tents.
function needs(stay: StayEmail): string {
  return stay.party.filter((p) => p.stayRequirements).map((p) => `${p.name}: ${p.stayRequirements}`).join('; ');
}

async function tell(kind: 'booked' | 'cancelled' | 'needs', stay: StayEmail): Promise<void> {
  if (kind === 'needs') {
    // The member changed food needs for a stay already booked: the core team and Madhavan hear it, nobody else.
    await sendEmail({
      to: STAFF_EMAILS,
      subject: `Food needs changed — ${stay.farmUnit} ${stay.startDate}`,
      html: renderStaffEmail(`  <p style="margin-top:0;">${escapeHtml(stay.memberName)} (${escapeHtml(stay.farmUnit)}) changed food or allergy needs for the stay on ${escapeHtml(when(stay))}. Their standing allergies and preferences are unchanged.</p>
  ${detailTable(stay.party.map((p, i) => detailRow(escapeHtml(p.name), escapeHtml(p.stayRequirements || 'No special needs for this stay'), { last: i === stay.party.length - 1 })).join(''))}`),
    });
    return;
  }
  const verb = kind === 'booked' ? 'booked' : 'cancelled';
  const rows =
    detailRow('Unit', escapeHtml(stay.farmUnit)) +
    detailRow('Booked by', escapeHtml(stay.memberName)) +
    detailRow('Dates', escapeHtml(when(stay))) +
    detailRow('People', escapeHtml(who(stay))) +
    (needs(stay) ? detailRow('Food needs this stay', escapeHtml(needs(stay))) : '') +
    detailRow('Paying guests', String(stay.guestCount), { last: !stay.note }) +
    (stay.note ? detailRow('Note', escapeHtml(stay.note), { last: true }) : '');
  const staff = sendEmail({
    to: STAFF_EMAILS,
    subject: `Member stay ${verb} — ${stay.farmUnit} ${stay.startDate}`,
    html: renderStaffEmail(`  <p style="margin-top:0;">${escapeHtml(stay.memberName)} (${escapeHtml(stay.farmUnit)}) ${verb} a stay in the member portal. ${kind === 'booked' ? 'It is on the accommodation calendar with no tents yet: Madhavan, please allocate tents there. Guests are told when it is finalized.' : 'It has been removed from the accommodation calendar.'}</p>
  ${detailTable(rows)}`),
  });
  const first = stay.memberName.trim().split(/\s+/)[0] || 'there';
  const member = stay.memberEmail
    ? sendEmail({
        to: [stay.memberEmail],
        replyTo: 'core-team@tvc.farm',
        subject: kind === 'booked' ? 'Your stay at the farm is booked' : 'Your stay at the farm is cancelled',
        html: renderBrandedEmail(`        <p style="margin-top:0;">Hi ${escapeHtml(first)},</p>
        <p>${kind === 'booked' ? 'Your stay is booked. Madhavan will allocate your tents and the core team will be in touch if anything needs sorting out.' : 'Your stay has been cancelled. Here is what was cancelled.'}</p>
        ${detailTable(detailRow('Dates', escapeHtml(when(stay))) + detailRow('People', escapeHtml(who(stay)), { last: true }))}
        <p style="font-size:13px; margin-bottom:0;">To change anything, reply to this email and the core team will sort it out.</p>`),
      })
    : Promise.resolve(false);
  await Promise.all([staff, member]);
}

export async function sendMemberStayBooked(stay: StayEmail): Promise<void> {
  try {
    await tell('booked', stay);
  } catch (err) {
    console.error('[member-stay-notify] booked email failed', err);
  }
}

export async function sendMemberStayRequirementsUpdated(stay: StayEmail): Promise<void> {
  try {
    await tell('needs', stay);
  } catch (err) {
    console.error('[member-stay-notify] needs email failed', err);
  }
}

export async function sendMemberStayCancelled(stay: StayEmail): Promise<void> {
  try {
    await tell('cancelled', stay);
  } catch (err) {
    console.error('[member-stay-notify] cancelled email failed', err);
  }
}
