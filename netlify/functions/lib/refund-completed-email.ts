// "Refund processed" email to the guest. Sent by whichever path first
// confirms a refund (the refund.processed webhook, or event-payments-admin.mts
// when Razorpay's own create-refund response already says 'processed' — test
// mode refunds are instant); the confirm update is idempotent, so only the
// call that actually flips the row sends it.
import { routeEmail } from './email-routing';
import { EMAIL_COLORS, emailLink, escapeHtml, renderBrandedEmail } from './email-layout';

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'Tamarind Valley Collective <noreply@tvc.farm>';
const RECEIPT_CC = ['core-team@tvc.farm', 'stay@linger.in'];

export async function sendRefundCompletedEmail(params: { to: string; eventTitle: string; refundAmount: number; currency: string; paymentId: string; refundId: string; isTest?: boolean }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[refund-completed-email] RESEND_API_KEY is not set — cannot send refund completed email');
    return;
  }
  const amount = params.refundAmount / 100;
  const formatted = params.currency === 'INR' ? `₹${amount.toLocaleString('en-IN')}` : `${amount.toLocaleString('en-IN')} ${params.currency}`;
  const html = renderBrandedEmail(`        <p style="margin-top:0;">Your refund of <strong>${formatted}</strong> for <strong>${escapeHtml(params.eventTitle)}</strong> has been processed.</p>
        <p>It has been sent to your original payment method. Depending on your bank it can take a few more business days to show up in your account.</p>
        <p style="font-size:13px; color:${EMAIL_COLORS.muted};">Payment ID ${escapeHtml(params.paymentId)} · Refund ID ${escapeHtml(params.refundId)}</p>
        <p style="margin-bottom:0;">Questions? Reply to this email or reach us at ${emailLink('mailto:core-team@tvc.farm', 'core-team@tvc.farm')}.</p>`);
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, html, ...routeEmail(Boolean(params.isTest), { to: [params.to], cc: RECEIPT_CC, subject: `Refund processed — ${params.eventTitle}` }) }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}
