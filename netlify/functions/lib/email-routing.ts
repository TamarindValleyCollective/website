// Test-mode bookings (Razorpay test keys — see event_payments.mode) must
// never email real guests or Linger: every email about one goes to this
// single inbox instead, with a [TEST] subject prefix, so the whole flow can
// be exercised end to end without side effects.
export const TEST_INBOX = 'contact@tvc.farm';

export function routeEmail<T extends { to: string[]; cc?: string[]; subject: string }>(isTest: boolean, email: T): T {
  if (!isTest) return email;
  return { ...email, to: [TEST_INBOX], cc: undefined, subject: `[TEST] ${email.subject}` };
}
