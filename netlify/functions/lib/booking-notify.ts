// Notifications for the approval-gated booking flow (event-booking.mts,
// event-booking-approval.mts). Every send is best-effort and never throws:
// the request is already saved, and a missed notification must not turn into
// a failed booking. Test-mode Razorpay keys route everything to the test
// inbox / WHATSAPP_TEST_NUMBER (see email-routing.ts), so the whole flow can
// be exercised without messaging Linger or a real guest.
import { escapeHtml, formatAmount, detailRow, detailTable, emailLink, EMAIL_COLORS, renderBrandedEmail, renderStaffEmail } from './email-layout';
import { routeEmail } from './email-routing';
import { sendWhatsAppTemplate, firstNameOf, formatEventDate } from './whatsapp-send';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'Tamarind Valley Collective <noreply@tvc.farm>';
// Linger run the property and do the pre-booking conversation, so they get
// every request; TVC core team is copied.
const APPROVER_EMAILS = ['core-team@tvc.farm', 'stay@linger.in'];
const SITE_ORIGIN = 'https://tvc.farm';

export function isTestMode(): boolean {
  return (process.env.RAZORPAY_KEY_ID ?? '').startsWith('rzp_test_');
}

export function approvalUrl(token: string): string {
  return `${SITE_ORIGIN}/approve-booking?token=${encodeURIComponent(token)}`;
}

async function sendEmail(opts: { to: string[]; cc?: string[]; subject: string; html: string; replyTo?: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[booking-notify] RESEND_API_KEY is not set — cannot send email');
    return false;
  }
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        html: opts.html,
        ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
        ...routeEmail(isTestMode(), { to: opts.to, cc: opts.cc, subject: opts.subject }),
      }),
    });
    if (!res.ok) {
      console.error('[booking-notify] Resend send failed', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[booking-notify] Resend send threw', err);
    return false;
  }
}

export interface BookingRequestSummary {
  event_title: string;
  event_date: string | null;
  name: string;
  email: string;
  phone: string;
  attendee_count: number;
  whatsapp_opt_in: boolean;
}

function peopleLabel(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

// To Linger (+ TVC): a guest wants a spot — talk to them, then approve.
export async function notifyApprovers(req: BookingRequestSummary, token: string, requestId: string): Promise<void> {
  const url = approvalUrl(token);
  const numbers = (process.env.WHATSAPP_BOOKING_APPROVER_NUMBERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  await Promise.all([
    ...numbers.map((to) =>
      sendWhatsAppTemplate({
        template: 'tvc_booking_approval_request',
        to,
        params: [req.event_title, req.name, String(req.attendee_count), req.phone, url],
        isTest: isTestMode(),
      }),
    ),
    sendEmail({
      to: APPROVER_EMAILS,
      subject: `Booking request — ${req.event_title} (${req.name})`,
      replyTo: req.email,
      html: renderStaffEmail(`  <p style="margin-top:0;">A guest has asked to book <strong>${escapeHtml(req.event_title)}</strong>. Please speak to them before approving — the payment link is only sent once you approve.</p>
  ${detailTable(
    detailRow('Guest', escapeHtml(req.name), { bold: true }) +
      detailRow('Phone', escapeHtml(req.phone)) +
      detailRow('Email', escapeHtml(req.email)) +
      detailRow('People', String(req.attendee_count)) +
      detailRow('Event date', escapeHtml(formatEventDate(req.event_date)), { last: true }),
  )}
  <p><a href="${url}" style="display:inline-block; padding:10px 18px; background:#1f4d2b; color:#ffffff; border-radius:8px; text-decoration:none; font-weight:600;">Review &amp; approve</a></p>
  <p style="font-size:13px; color:#57604f;">Request ${escapeHtml(requestId)}. Anyone with this link can approve or decline, so please don't forward it.</p>`),
    }),
  ]);
}

// To the guest, straight after they submit: what happens next.
export async function sendRequestAcknowledgement(req: BookingRequestSummary): Promise<void> {
  await sendEmail({
    to: [req.email],
    subject: `We've received your request — ${req.event_title}`,
    replyTo: 'core-team@tvc.farm',
    html: renderBrandedEmail(`        <p style="margin-top:0;">Hi ${escapeHtml(firstNameOf(req.name))},</p>
        <p>Thanks for your interest in <strong>${escapeHtml(req.event_title)}</strong>. We've received your request for ${peopleLabel(req.attendee_count)}.</p>
        <p><strong>Your spot isn't confirmed yet.</strong> Someone from our team will get in touch with you shortly to answer any questions and confirm the details, such as exactly where the farm is and how to get there. Once they've confirmed with you, we'll send you a payment link, and you'll only be charged after that.</p>
        <p style="font-size:13px; color:${EMAIL_COLORS.muted}; margin-bottom:0;">Questions in the meantime? Just reply to this email.</p>`),
  });
}

// To the guest, after approval: the payment link, on WhatsApp (if they opted
// in) and by email. Returns whether at least one channel went out.
export async function sendPaymentLinkToGuest(
  req: BookingRequestSummary & { id: string },
  link: { url: string; amount: number; currency: string },
): Promise<boolean> {
  const total = formatAmount(link.amount, link.currency);
  const [wa, mail] = await Promise.all([
    sendWhatsAppTemplate({
      template: 'tvc_booking_payment_link',
      to: req.phone,
      params: [firstNameOf(req.name), req.event_title, formatEventDate(req.event_date), String(req.attendee_count), total, link.url],
      isTest: isTestMode(),
      optIn: req.whatsapp_opt_in,
    }),
    sendEmail({
      to: [req.email],
      cc: ['core-team@tvc.farm'],
      subject: `Complete your booking — ${req.event_title}`,
      replyTo: 'core-team@tvc.farm',
      html: renderBrandedEmail(`        <p style="margin-top:0;">Hi ${escapeHtml(firstNameOf(req.name))},</p>
        <p>Thanks for speaking with us. Your booking for <strong>${escapeHtml(req.event_title)}</strong> is approved. Pay below to confirm your spot.</p>
        ${detailTable(
          detailRow('Event', escapeHtml(req.event_title), { bold: true }) +
            detailRow('Date', escapeHtml(formatEventDate(req.event_date))) +
            detailRow('People', String(req.attendee_count)) +
            detailRow('Total', `<strong style="font-size:1.1rem;">${total}</strong>`, { last: true }),
        )}
        <p><a href="${escapeHtml(link.url)}" style="display:inline-block; padding:12px 22px; background:#e8651a; color:#1c1c1c; border-radius:999px; text-decoration:none; font-weight:700;">Pay ${total}</a></p>
        <p style="font-size:13px; color:${EMAIL_COLORS.muted};">This link is valid for 48 hours. Our ${emailLink(`${SITE_ORIGIN}/refund-policy`, 'cancellation &amp; refund policy')} applies once you've paid.</p>
        <p style="font-size:13px; color:${EMAIL_COLORS.muted}; margin-bottom:0;">Questions? Just reply to this email.</p>`),
    }),
  ]);
  return wa === 'sent' || mail;
}

// To the guest, if staff decline: kind and short, no reason is shared.
export async function sendDeclineToGuest(req: BookingRequestSummary): Promise<void> {
  await sendEmail({
    to: [req.email],
    cc: ['core-team@tvc.farm'],
    subject: `About your request — ${req.event_title}`,
    replyTo: 'core-team@tvc.farm',
    html: renderBrandedEmail(`        <p style="margin-top:0;">Hi ${escapeHtml(firstNameOf(req.name))},</p>
        <p>Thanks for your interest in <strong>${escapeHtml(req.event_title)}</strong>. Unfortunately we aren't able to take this booking forward, and you haven't been charged anything.</p>
        <p style="margin-bottom:0;">If you'd like to talk it through, or hear about other dates and events, just reply to this email.</p>`),
  });
}
