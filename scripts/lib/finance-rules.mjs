// Categorisation rules and review flags for the ledger (docs/finance/DESIGN.md, "Allocation and review"). Pure and
// I/O-free so they are tested directly (finance-rules.test.mjs); the Function loads rules and lines and calls these.
//
// A rule's matcher is a set of conditions that must ALL hold; a rule with none never matches (it would swallow every
// line). Conditions: narrationContains (text in the bank narration), payeeVpa (the UPI id on the Paytm row),
// remarkKeywords (ANY of these words in the farm manager's UPI remark), direction, minPaise, maxPaise.
// The lowest priority number wins; ties go to the oldest rule (id order is stable, so the result never flips).
import { periodOf } from './finance-allocation.mjs';

const lower = (s) => String(s ?? '').toLowerCase();

export function matchRule(rule, line, upi) {
  if (!rule.active) return false;
  const m = rule.matcher ?? {};
  let conditions = 0;
  if (m.narrationContains) {
    conditions++;
    if (!lower(line.narration).includes(lower(m.narrationContains))) return false;
  }
  if (m.payeeVpa) {
    conditions++;
    if (!upi || lower(upi.vpa) !== lower(m.payeeVpa)) return false;
  }
  if (m.remarkKeywords?.length) {
    conditions++;
    const remarks = lower(upi?.remarks);
    if (!m.remarkKeywords.some((k) => remarks.includes(lower(k)))) return false;
  }
  if (m.direction) {
    conditions++;
    if (line.direction !== m.direction) return false;
  }
  if (m.minPaise != null) {
    conditions++;
    if (line.amount_paise < m.minPaise) return false;
  }
  if (m.maxPaise != null) {
    conditions++;
    if (line.amount_paise > m.maxPaise) return false;
  }
  return conditions > 0;
}

/** The winning rule for a line (and why it won), or null. */
export function applyRules(rules, line, upi) {
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
  const rule = ordered.find((r) => matchRule(r, line, upi));
  return rule ? { rule } : null;
}

function fillTemplate(template, upi) {
  return String(template)
    .replaceAll('{counterparty}', upi?.counterparty ?? '')
    .replaceAll('{remark}', upi?.remarks ?? '')
    .trim();
}

/**
 * What to propose for a line: party, category and nature from the winning rule; failing that, the farm manager's own UPI
 * remark seeds the nature (and a payment to the requester's own party is a reimbursement). Returns null when nothing
 * at all is known. Never posts anything: the person reviews a proposal.
 * opts: { requesterPartyIds, partyId (the party the line is to, if known), reimbursementCategoryId }.
 */
export function proposeAllocation(line, upi, rules, opts = {}) {
  const base = { amountPaise: line.amount_paise, period: periodOf(line.tran_date), lineId: line.id };
  const hit = applyRules(rules, line, upi);
  if (hit) {
    const r = hit.rule;
    return {
      ...base,
      source: 'rule',
      ruleId: r.id,
      partyId: r.party_id ?? opts.partyId ?? null,
      categoryId: r.category_id ?? null,
      nature: r.nature_template ? fillTemplate(r.nature_template, upi) : String(upi?.remarks ?? '').trim(),
      needsReview: Boolean(r.needs_review),
    };
  }
  const remark = String(upi?.remarks ?? '').trim();
  const reimbursement = line.direction === 'debit' && Boolean(opts.partyId) && (opts.requesterPartyIds ?? []).includes(opts.partyId);
  if (!remark && !reimbursement) return null;
  return {
    ...base,
    source: 'upi_remark',
    ruleId: null,
    partyId: opts.partyId ?? null,
    categoryId: reimbursement ? (opts.reimbursementCategoryId ?? null) : null,
    nature: remark,
    needsReview: false,
    ...(reimbursement ? { reimbursement: true } : {}),
  };
}

// Plain-words labels for the review queue; the keys are what is stored in fin_allocations.review_reason.
export const REVIEW_REASONS = {
  unexplained: 'Nothing explains this line yet',
  circle_to_requester: 'A circle payment to the requester\'s own name',
  new_payee_account: 'Paid to an account that is new, changed or not yet verified',
  reimbursement_without_bill: 'A reimbursement with no bill attached',
  rule_requires_review: 'A rule that is always reviewed',
};

/**
 * Why a proposed or posted allocation needs a person. Empty = fine to post.
 * ctx: { line, upi, proposal, requesterPartyIds, partyAccountState ('verified' | 'unverified' | 'none'), categoryType,
 *        hasVoucher }.
 */
export function reviewReasons(ctx) {
  const { line, upi, proposal } = ctx;
  if (!proposal || !proposal.categoryId) return ['unexplained'];
  const reasons = [];
  if (upi?.is_circle && proposal.partyId && (ctx.requesterPartyIds ?? []).includes(proposal.partyId)) reasons.push('circle_to_requester');
  if (line.direction === 'debit' && proposal.partyId && ctx.partyAccountState && ctx.partyAccountState !== 'verified') reasons.push('new_payee_account');
  if (ctx.categoryType === 'reimbursement' && !ctx.hasVoucher) reasons.push('reimbursement_without_bill');
  if (proposal.needsReview) reasons.push('rule_requires_review');
  return reasons;
}

/** Validate a rule a director is saving. */
export function validateRule(body) {
  const errors = [];
  const m = body.matcher ?? {};
  const text = String(m.narrationContains ?? '').trim();
  if (text && text.length < 3) errors.push('Narration text must be at least three characters, or it will match almost everything.');
  const keywords = (m.remarkKeywords ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (keywords.some((k) => k.length < 3)) errors.push('Keywords must be at least three characters.');
  if (m.direction && !['debit', 'credit'].includes(m.direction)) errors.push('Direction must be debit or credit.');
  for (const key of ['minPaise', 'maxPaise']) {
    if (m[key] != null && !(Number.isSafeInteger(m[key]) && m[key] >= 0)) errors.push('Amounts must be whole paise.');
  }
  if (m.minPaise != null && m.maxPaise != null && m.minPaise > m.maxPaise) errors.push('The smallest amount is more than the largest.');
  const conditions = [text, m.payeeVpa, keywords.length ? 'k' : '', m.direction, m.minPaise != null ? 'min' : '', m.maxPaise != null ? 'max' : ''].filter(Boolean);
  if (!conditions.length) errors.push('Say what to match: some narration text, a UPI id, a keyword, a direction or an amount.');
  if (!body.categoryId) errors.push('Choose the category the rule gives.');
  if (body.priority != null && !(Number.isInteger(body.priority) && body.priority >= 1 && body.priority <= 1000)) errors.push('Priority is a whole number from 1 to 1000.');
  return { ok: errors.length === 0, errors };
}
