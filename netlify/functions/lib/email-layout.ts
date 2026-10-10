// Shared branded shell for every guest-facing email (receipt, refund
// notices, cancellation replies): green header with the TVC mark, white body
// card, legal-entity footer. Callers pass only the inner body HTML. Internal
// staff emails use renderStaffEmail instead. The template itself lives in
// scripts/lib/email-layout.mjs (shared with the GitHub Actions scripts).
import { LEGAL_ENTITY_NAME } from '../../../src/data/site-facts';
import { escapeHtml, renderEmailShell } from '../../../scripts/lib/email-layout.mjs';

export { EMAIL_COLORS, escapeHtml, formatAmount, detailRow, detailTable, emailLink, renderStaffEmail } from '../../../scripts/lib/email-layout.mjs';

export function renderBrandedEmail(bodyHtml: string): string {
  return renderEmailShell(bodyHtml, `Tamarind Valley Collective, operated by ${escapeHtml(LEGAL_ENTITY_NAME)}.`);
}
