// Branded payment-receipt email, built once and reused for every event's
// Razorpay payment (see razorpay-webhook.mts) — takes only what's already
// on the webhook payload/DB row, no per-event template. Colors match the
// site's own brand tokens (src/styles/global.css's --tvc-* custom
// properties, hardcoded here since email HTML can't reference CSS vars),
// same reasoning as whatsapp-stale-alert.mts's inline-styled digest email.
import { LEGAL_ENTITY_NAME } from '../../../src/data/site-facts';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatAmount(amountPaise: number, currency: string): string {
  const amount = amountPaise / 100;
  if (currency === 'INR') return `₹${amount.toLocaleString('en-IN')}`;
  return `${amount.toLocaleString('en-IN')} ${currency}`;
}

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

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#22291f; background:#faf7ee; margin:0; padding:32px 16px;">
  <table role="presentation" width="100%" style="max-width:560px; margin:0 auto; background:#fff; border:1px solid #e2ddc9; border-radius:12px; overflow:hidden;">
    <tr>
      <td style="background:#3d6e52; padding:20px 28px;">
        <img src="https://tvc.farm/images/brand/tvc-logo-mark.png" width="32" height="32" alt="" style="vertical-align:middle; border-radius:50%; margin-right:10px;" />
        <span style="color:#fff; font-weight:700; font-size:1.1rem; vertical-align:middle;">Tamarind Valley Collective</span>
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
        <p style="margin-top:0;">Hi ${greetingName},</p>
        <p>Thanks for your payment — you're confirmed for <strong>${escapeHtml(eventTitle)}</strong>. Here's your receipt.</p>
        <table role="presentation" width="100%" style="margin:20px 0; border-collapse:collapse;">
          <tr>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; color:#57604f; font-size:13px;">Event</td>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; text-align:right; font-weight:600;">${escapeHtml(eventTitle)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; color:#57604f; font-size:13px;">People</td>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; text-align:right; font-weight:600;">${attendeeCount}</td>
          </tr>
          <tr>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; color:#57604f; font-size:13px;">Amount paid</td>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; text-align:right; font-weight:700; font-size:1.1rem;">${formatAmount(amount, currency)}</td>
          </tr>
          <tr>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; color:#57604f; font-size:13px;">Paid on</td>
            <td style="padding:10px 0; border-bottom:1px solid #e2ddc9; text-align:right;">${paidAtStr} IST</td>
          </tr>
          <tr>
            <td style="padding:10px 0; color:#57604f; font-size:13px;">Payment ID</td>
            <td style="padding:10px 0; text-align:right; font-family:ui-monospace,monospace; font-size:12px;">${escapeHtml(paymentId)}</td>
          </tr>
        </table>
        <p style="font-size:13px; color:#57604f;">We'll be in touch on WhatsApp with logistics closer to the day. Questions in the meantime? Just reply to this email.</p>
        <p style="font-size:12px; color:#57604f; margin-bottom:0;">Need to cancel? <a href="https://tvc.farm/cancel-booking?paymentId=${encodeURIComponent(paymentId)}" style="color:#3d6e52;">Request a cancellation</a> — see our <a href="https://tvc.farm/refund-policy" style="color:#3d6e52;">cancellation &amp; refund policy</a> for how refunds work.</p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 28px; background:#faf7ee; border-top:1px solid #e2ddc9; font-size:11px; color:#57604f;">
        Tamarind Valley Collective, operated by ${escapeHtml(LEGAL_ENTITY_NAME)}.
      </td>
    </tr>
  </table>
</body>
</html>`;
}
