// Creates (once) the TEST-mode base Payment Link behind the fake test event
// (src/content/events/2027-12-31-fake-test-event.md). Idempotent. Refuses to
// run against live keys. Run with Netlify's env injected, so no secret is
// ever printed or stored here:
//   netlify dev:exec node scripts/setup-fake-event.mjs
const REFERENCE_ID = 'fake-test-event';
const id = process.env.RAZORPAY_KEY_ID ?? '';
const secret = process.env.RAZORPAY_KEY_SECRET ?? '';
if (!id.startsWith('rzp_test_')) {
  console.error('Refusing to run: RAZORPAY_KEY_ID is not a rzp_test_ key.');
  process.exit(1);
}
const headers = { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'content-type': 'application/json' };

const existing = await (await fetch(`https://api.razorpay.com/v1/payment_links?reference_id=${REFERENCE_ID}`, { headers })).json();
if (existing.payment_links?.length) {
  const l = existing.payment_links[0];
  console.log(`Already exists: ${l.id} (status ${l.status}, ${l.amount / 100} ${l.currency} per person)`);
  process.exit(0);
}
const res = await fetch('https://api.razorpay.com/v1/payment_links', {
  method: 'POST',
  headers,
  body: JSON.stringify({
    amount: 10000, // ₹100 per person, matching the content file's price row
    currency: 'INR',
    reference_id: REFERENCE_ID,
    description: 'TEST ONLY — Fake Event',
    notes: { event: 'TEST ONLY — Fake Event' },
    accept_partial: false,
  }),
});
const body = await res.json();
if (!res.ok) {
  console.error('Failed:', body.error?.description ?? res.status);
  process.exit(1);
}
console.log(`Created ${body.id} (status ${body.status})`);
