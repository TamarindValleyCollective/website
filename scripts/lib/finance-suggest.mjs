// Suggesting a category, a party and "what it was for" for a bank line (docs/finance/FINANCE.md, "Suggestions"). Pure and
// I/O-free so it is tested directly (finance-suggest.test.mjs); the Function loads the lines, rules, parties and history and
// calls it. It only ever proposes: a person posts, and a suggestion never creates anything by itself.
//
// Where the clues come from, strongest first:
//   1. a rule a director wrote (finance-rules.mjs);
//   2. what was posted before for the same party or the same name, in the same direction;
//   3. the bank's own entries (charges, tax on charges, interest, cash), matched to a category by name;
//   4. the narration itself: the counterparty's name, and the remark the payer typed.
// Nothing is invented: a party is only suggested when the name matches the register exactly or as the bank's shortened form
// of exactly one party; a name that is not in the register is offered as a NEW party for a person to add.
import { applyRules } from './finance-rules.mjs';
import { periodOf } from './finance-allocation.mjs';

const BANK_WORDS = /bank|\bbk\b|^[A-Z]{4}0[A-Z0-9]{6}$|^(sbi|hdfc|icici|axis|ifsc)\b/i;
const GENERIC_REMARK = /^(upi|na|nil|none|-+|\.+)$/i;

function titleCaseIfShouting(text) {
  if (/[a-z]/.test(text)) return text;
  return text
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length <= 4 && /^[a-z]+$/.test(w) && text.split(' ').find((x) => x.toLowerCase() === w)?.length <= 4 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** A name as a person would write it: spaces tidied, trailing reference digits dropped, SHOUTING made readable. */
function cleanName(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[A-Z]{2,4}\*/, '').replace(/^WWW\s+/i, '').replace(/\s*\d{5,}$/, '').trim();
  if (!s || /^[\d\s.-]+$/.test(s)) return null;
  return s.length < 3 ? null : titleCaseIfShouting(s);
}

const cleanRemark = (raw) => {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return s.length < 3 || GENERIC_REMARK.test(s) || BANK_WORDS.test(s) || !/[a-z]{3}/i.test(s) ? null : s;
};

/**
 * Read a bank narration. Returns { mode, counterparty, remark } where mode is one of upi, neft, imps, card, charges,
 * charges_tax, interest, cash_out, cash_in, other. The shapes are the real statement's: the name is in a fixed part.
 */
export function parseNarration(narration, direction = 'debit') {
  const n = String(narration ?? '').trim();
  const seg = n.split('/').map((s) => s.trim());
  const result = (mode, counterparty = null, remark = null) => ({ mode, counterparty, remark });
  if (/^UPI\//i.test(n)) return result('upi', cleanName(seg[3]), cleanRemark(seg[5]));
  if (/^(INB\/)?(NEFT|RTGS)\//i.test(n)) {
    // The payee is the part after the transaction reference (letters then digits, or only digits), wherever that sits.
    const refAt = seg.findIndex((s, i) => i > 0 && /^([A-Z]{2,8}\d{8,}|\d{8,})$/i.test(s));
    const nameAt = refAt >= 0 ? refAt + 1 : -1;
    return result('neft', nameAt > 0 ? cleanName(seg[nameAt]) : null, nameAt > 0 ? cleanRemark(seg[nameAt + 1]) : null);
  }
  if (/^(INB\/)?IMPS\//i.test(n)) {
    const body = /^INB\//i.test(n) ? seg.slice(1) : seg;
    return result('imps', cleanName(body[3]), cleanRemark(body[5]));
  }
  if (/^(INB\/IFT|MOB\/TPFT)\//i.test(n)) return result('neft', cleanName(seg[2]), cleanRemark(seg[3]));
  if (/^(POS|ECOM PUR)\//i.test(n)) return result('card', cleanName(seg[1]), null);
  if (/GST\s*@/i.test(n)) return result('charges_tax');
  if (/(chrgs|charges|\bchrg\b|\bchgs\b|sms\s*(alert|chg))/i.test(n)) return result('charges');
  if (/INT\.?\s?PD|INTEREST/i.test(n) && direction === 'credit') return result('interest');
  if (/CASH\s*DEP|BY CASH/i.test(n)) return result('cash_in');
  if (/^(ATM|NFS|CASH\s*WDL)/i.test(n)) return result('cash_out');
  return result('other');
}

const SUFFIX_WORDS = new Set(['pvt', 'ltd', 'private', 'limited', 'llp', 'co', 'company', 'mr', 'mrs', 'ms', 'shri', 'smt', 'dr']);

/** A name for comparing: lower case, no punctuation, no company suffixes or titles. */
export function normaliseName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\bm\/s\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !SUFFIX_WORDS.has(w))
    .join(' ');
}

/**
 * Which party a name is. Exact (after normalising), or the shortened form a bank prints: every word is the start of a distinct
 * word of the party's name. Two parties that fit, or one short word, give null: a wrong guess puts money against the wrong person.
 */
export function matchParty(name, parties) {
  const n = normaliseName(name);
  if (!n) return null;
  const exact = parties.filter((p) => normaliseName(p.name) === n);
  if (exact.length === 1) return { partyId: exact[0].id, how: 'exact' };
  if (exact.length > 1) return null;
  const words = n.split(' ');
  if (words.length < 2 && words[0].length < 6) return null;
  const fits = parties.filter((p) => {
    const theirs = normaliseName(p.name).split(' ');
    if (theirs.length < words.length) return false;
    const used = new Set();
    return words.every((w) => {
      const i = theirs.findIndex((t, idx) => !used.has(idx) && t.startsWith(w));
      if (i < 0) return false;
      used.add(i);
      return true;
    });
  });
  return fits.length === 1 ? { partyId: fits[0].id, how: 'shortened' } : null;
}

// ---- what was posted before
function tally(map, key, categoryId, nature) {
  if (!key) return;
  const t = map.get(key) ?? { n: 0, cats: new Map() };
  const c = t.cats.get(categoryId) ?? { n: 0, natures: new Map() };
  c.n++;
  if (nature) c.natures.set(nature, (c.natures.get(nature) ?? 0) + 1);
  t.n++;
  t.cats.set(categoryId, c);
  map.set(key, t);
}

/**
 * Who a posted line with no party was paid to or received from, read from its bank narration and, where there is one, the
 * Paytm UPI counterparty. Only a sure answer is returned: the name must match exactly one party (exactly, or as the bank's
 * shortened form), and when the narration and the UPI report both name someone they must name the same party. Anything else
 * is null, to be left to a person. Returns { partyId, how, from } or null; from is the name that was matched.
 */
export function proposeMissingParty({ line, upi = null, parties }) {
  const names = [upi?.counterparty, parseNarration(line.narration, line.direction).counterparty].filter(Boolean);
  const found = names.map((name) => ({ name, hit: matchParty(name, parties) })).filter((x) => x.hit);
  if (!found.length) return null;
  if (found.some((x) => x.hit.partyId !== found[0].hit.partyId)) return null;
  return { partyId: found[0].hit.partyId, how: found.some((x) => x.hit.how === 'exact') ? 'exact' : 'shortened', from: found[0].name };
}

/**
 * Index earlier postings so a repeat is recognised. rows: posted, non-reversal allocations joined to their bank line:
 * { narration, direction, party_id, category_id, nature }. Matching is by party when the posting named one, and always by
 * the counterparty's name in the narration too, so history works before every payee is in the register.
 */
export function buildHistory(rows) {
  const byParty = new Map();
  const byName = new Map();
  for (const r of rows) {
    if (r.party_id) tally(byParty, `${r.direction}|${r.party_id}`, r.category_id, r.nature);
    const name = normaliseName(parseNarration(r.narration, r.direction).counterparty);
    if (name) tally(byName, `${r.direction}|${name}`, r.category_id, r.nature);
  }
  return {
    size: rows.length,
    /** The best earlier tally for this direction and party/name, or null. */
    lookup(direction, partyId, name) {
      return (partyId && byParty.get(`${direction}|${partyId}`)) || (name && byName.get(`${direction}|${normaliseName(name)}`)) || null;
    },
  };
}

function fromHistory(t) {
  if (!t) return null;
  const [categoryId, top] = [...t.cats.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  const share = top.n / t.n;
  if (share < 0.6) return null;
  const confidence = t.n >= 3 && share >= 0.8 ? 'high' : t.n >= 2 ? 'medium' : 'low';
  const [nature, count] = [...top.natures.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { categoryId, confidence, count: t.n, share, nature: nature && (count >= 2 || top.n === 1) ? nature : null };
}

// The bank's own entries and the seeded category each belongs in, found by name (a renamed category simply isn't suggested).
const BANK_ENTRY = {
  charges: { category: 'bank charges', nature: 'Bank charges', debitOnly: true },
  charges_tax: { category: 'bank charges', nature: 'GST on bank charges', debitOnly: true },
  interest: { category: 'interest income', nature: 'Bank interest' },
  cash_out: { category: 'petty cash', nature: 'Cash withdrawn', debitOnly: true },
};

export function describeMatcher(m = {}) {
  const parts = [
    m.narrationContains ? `the narration has "${m.narrationContains}"` : '',
    m.remarkKeywords?.length ? `the UPI remark has ${m.remarkKeywords.map((k) => `"${k}"`).join(' or ')}` : '',
    m.direction ? (m.direction === 'debit' ? 'a payment out' : 'money in') : '',
    m.minPaise != null || m.maxPaise != null ? 'in an amount range' : '',
  ].filter(Boolean);
  return parts.join(' and ');
}

const fill = (template, upi, parsed) =>
  String(template)
    .replaceAll('{counterparty}', upi?.counterparty ?? parsed.counterparty ?? '')
    .replaceAll('{remark}', upi?.remarks ?? parsed.remark ?? '')
    .trim();

/**
 * The suggestion for one bank line.
 * args: { line, upi, rules, parties, categories, history, requesterPartyIds }
 * Returns { categoryId, partyId, nature, newParty: {name, kind} | null, confidence: 'high'|'medium'|'low'|'none', reasons[],
 *           source: 'rule'|'history'|'bank_entry'|'narration'|'none', ruleId, needsReview, reimbursement, mode, amountPaise, period }
 */
export function suggest({ line, upi, rules, parties, categories, history, requesterPartyIds = /** @type {string[]} */ ([]) }) {
  const active = categories.filter((c) => c.active);
  const catById = new Map(active.map((c) => [c.id, c]));
  const partyById = new Map(parties.map((p) => [p.id, p]));
  const parsed = parseNarration(line.narration, line.direction);
  const reasons = [];
  const out = {
    categoryId: null, partyId: null, nature: '', newParty: null, confidence: 'none', reasons, source: 'none', ruleId: null,
    needsReview: false, reimbursement: false, mode: parsed.mode, amountPaise: line.amount_paise, period: periodOf(line.tran_date), lineId: line.id,
  };

  // Who: the register by name. The Paytm counterparty is the cleanest name, then the one in the narration.
  let how = null;
  for (const name of [upi?.counterparty, parsed.counterparty]) {
    const m = name ? matchParty(name, parties) : null;
    if (m) {
      out.partyId = m.partyId;
      how = m.how;
      break;
    }
  }
  if (out.partyId) reasons.push(how === 'exact' ? `The name matches ${partyById.get(out.partyId)?.name} in the register` : `The bank shortened the name; it looks like ${partyById.get(out.partyId)?.name}`);
  const remark = cleanRemark(upi?.remarks) ?? parsed.remark;

  // 1. A rule a director wrote.
  const hit = applyRules(rules, line, upi);
  if (hit) {
    const r = hit.rule;
    if (r.category_id && catById.has(r.category_id)) {
      out.categoryId = r.category_id;
      out.source = 'rule';
      out.ruleId = r.id;
      out.needsReview = Boolean(r.needs_review);
      out.confidence = 'high';
      out.partyId = r.party_id ?? out.partyId;
      out.nature = r.nature_template ? fill(r.nature_template, upi, parsed) : remark ?? '';
      reasons.unshift(`Rule: ${describeMatcher(r.matcher)}`);
      return out;
    }
  }

  // 2. What was posted before.
  const past = fromHistory(history.lookup(line.direction, out.partyId, upi?.counterparty ?? parsed.counterparty));
  if (past && catById.has(past.categoryId)) {
    out.categoryId = past.categoryId;
    out.confidence = past.confidence;
    out.source = 'history';
    out.nature = remark ?? past.nature ?? '';
    reasons.push(past.count === 1 ? `One earlier ${line.direction === 'debit' ? 'payment' : 'receipt'} like this was ${catById.get(past.categoryId).name}` : `${past.count} earlier ${line.direction === 'debit' ? 'payments' : 'receipts'} like this${past.share === 1 ? ' were all' : ' were mostly'} ${catById.get(past.categoryId).name}`);
    if (!remark && past.nature) reasons.push(`Usually described as "${past.nature}"`);
  }

  // The requester is paid back, not paid: a reimbursement.
  if (!out.categoryId && line.direction === 'debit' && out.partyId && requesterPartyIds.includes(out.partyId)) {
    const reimb = active.find((c) => c.type === 'reimbursement');
    if (reimb) {
      out.categoryId = reimb.id;
      out.reimbursement = true;
      out.confidence = 'medium';
      out.source = 'narration';
      out.nature = remark ?? '';
      reasons.push('Paid to the person who raises payment requests, so it is treated as a reimbursement');
    }
  }

  // 3. The bank's own entries.
  const entry = BANK_ENTRY[parsed.mode];
  if (!out.categoryId && entry && (!entry.debitOnly || line.direction === 'debit')) {
    const cat = active.find((c) => c.name.toLowerCase() === entry.category);
    out.nature = entry.nature;
    if (cat) {
      out.categoryId = cat.id;
      out.confidence = 'high';
      out.source = 'bank_entry';
      reasons.push(`A ${entry.nature.toLowerCase()} entry from the bank`);
    }
  }

  // 4. The narration alone: the wording the payer typed.
  if (!out.nature) out.nature = remark ?? '';
  if (out.source === 'none' && (out.partyId || out.nature)) {
    out.source = 'narration';
    out.confidence = 'low';
  }
  if (out.source === 'narration' && out.confidence === 'none') out.confidence = 'low';
  if (remark && out.nature === remark && !reasons.some((r) => r.startsWith('The payer'))) reasons.push(`The payer wrote "${remark}"`);

  // A named stranger is offered as a new party; nothing is created until a person says so.
  const stranger = upi?.counterparty ? cleanName(upi.counterparty) : parsed.counterparty;
  if (!out.partyId && stranger && ['upi', 'neft', 'imps', 'card'].includes(parsed.mode)) {
    out.newParty = { name: stranger, kind: line.direction === 'credit' ? 'customer' : 'vendor' };
    reasons.push(`"${stranger}" is not in the register yet`);
  }
  return out;
}
