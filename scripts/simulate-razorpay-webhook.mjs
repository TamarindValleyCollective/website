// Delivers a Razorpay webhook to the LOCAL dev server (netlify dev, port 8888)
// for a real TEST-mode payment or refund, since Razorpay's test mode has no
// webhook pointing at a local machine. It fetches the real entity from the
// Razorpay test API, wraps it exactly as Razorpay would, signs it with the
// local RAZORPAY_WEBHOOK_SECRET, and POSTs it to /api/razorpay-webhook.
// Refuses to run against live keys. Run with Netlify's env injected (nothing
// secret is printed):
//   netlify dev:exec node scripts/simulate-razorpay-webhook.mjs payment pay_xxx
//   netlify dev:exec node scripts/simulate-razorpay-webhook.mjs refund rfnd_xxx
import { createHmac } from 'node:crypto';

const [kind, entityId] = process.argv.slice(2);
const keyId = process.env.RAZORPAY_KEY_ID ?? '';
const secret = process.env.RAZORPAY_KEY_SECRET ?? '';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
if (!keyId.startsWith('rzp_test_')) {
  console.error('Refusing to run: RAZORPAY_KEY_ID is not a rzp_test_ key.');
  process.exit(1);
}
if (!['payment', 'refund'].includes(kind) || !entityId) {
  console.error('Usage: simulate-razorpay-webhook.mjs payment <pay_id> | refund <rfnd_id>');
  process.exit(1);
}
if (!webhookSecret) {
  console.error('RAZORPAY_WEBHOOK_SECRET is not available in this environment.');
  process.exit(1);
}
const headers = { Authorization: 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64') };
const get = async (path) => {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, { headers });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${body.error?.description ?? res.status}`);
  return body;
};

let payload;
if (kind === 'payment') {
  const payment = await get(`/payments/${entityId}`);
  // The payment link a checkout payment came from: payments made through a
  // Payment Link carry its invoice/order, and the link itself is found by
  // order id.
  const links = await get(`/payment_links?count=100`);
  const link = links.payment_links.find((l) => l.order_id === payment.order_id || (l.payments ?? []).some((p) => p.payment_id === entityId));
  if (!link) throw new Error(`No Payment Link found for ${entityId} (order ${payment.order_id}).`);
  payload = { event: 'payment_link.paid', payload: { payment_link: { entity: link }, payment: { entity: payment } } };
} else {
  const refund = await get(`/refunds/${entityId}`);
  payload = { event: 'refund.processed', payload: { refund: { entity: refund } } };
}

const raw = JSON.stringify(payload);
const signature = createHmac('sha256', webhookSecret).update(raw, 'utf8').digest('hex');
const res = await fetch('http://localhost:8888/api/razorpay-webhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
  body: raw,
});
console.log(`${payload.event} → ${res.status} ${await res.text()}`);
