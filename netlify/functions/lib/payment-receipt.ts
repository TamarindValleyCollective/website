// Payment-receipt email, built once and reused for every event's Razorpay
// payment (see razorpay-webhook.mts) — takes only what's already on the
// webhook payload/DB row, no per-event template. Brand shell lives in
// email-layout.ts.
import { EMAIL_COLORS, detailRow, detailTable, emailLink, escapeHtml, formatAmount, renderBrandedEmail } from './email-layout';

export interface ReceiptParams {
  eventTitle: string;
  amount: number; // paise
  currency: string;
  attendeeCount: number;
  payerName?: string | null;
  paymentId: string;
  paidAt: Date;
}

export function buildReceiptSubject({ eventTitle }: ReceiptParams): string {
  return `Your payment for ${eventTitle} — receipt`;
}

export function buildReceiptHtml(params: ReceiptParams): string {
  const { eventTitle, amount, currency, attendeeCount, payerName, paymentId, paidAt } = params;
  const greetingName = payerName ? escapeHtml(payerName.split(' ')[0]) : 'there';
  const paidAtStr = paidAt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

  return renderBrandedEmail(`        <p style="margin-top:0;">Hi ${greetingName},</p>
        <p>Thanks for your payment — you're confirmed for <strong>${escapeHtml(eventTitle)}</strong>. Here's your receipt.</p>
        ${detailTable(
          detailRow('Event', escapeHtml(eventTitle), { bold: true }) +
            detailRow('People', String(attendeeCount), { bold: true }) +
            detailRow('Amount paid', `<strong style="font-size:1.1rem;">${formatAmount(amount, currency)}</strong>`) +
            detailRow('Paid on', `${paidAtStr} IST`) +
            detailRow('Payment ID', `<span style="font-family:ui-monospace,monospace; font-size:12px;">${escapeHtml(paymentId)}</span>`, { last: true }),
        )}
        <p style="font-size:13px; color:${EMAIL_COLORS.muted};">We'll be in touch on WhatsApp with logistics closer to the day. Questions in the meantime? Just reply to this email.</p>
        <p style="font-size:12px; color:${EMAIL_COLORS.muted}; margin-bottom:0;">Need to cancel? ${emailLink(`https://tvc.farm/cancel-booking?paymentId=${encodeURIComponent(paymentId)}`, 'Request a cancellation')} — see our ${emailLink('https://tvc.farm/refund-policy', 'cancellation &amp; refund policy')} for how refunds work.</p>`);
}
