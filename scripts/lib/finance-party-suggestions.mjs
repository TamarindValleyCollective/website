// Suggested changes for the Parties table: rename, merge, set the kind. Pure and I/O-free (finance-party-suggestions.test.mjs).
//
// The evidence is only what a person has typed or the books already hold: the name the bank showed when an account was verified
// (`verifiedName`), the names of the other parties, and what the party's posted payments were booked under. Nothing reads a
// screenshot, and nothing here changes anything: the page offers each suggestion, and accepting one goes through the normal
// rename / kind / merge routes with their own rules and audit entries.
//
// A party is { id, name, kind, active, householdId, personId, accounts: [{ verifiedName }], stats: { postings, direction, categoryName,
// categoryType, categoryShare } | null }, where stats describe the party's posted lines (the dominant category, and how much of the
// whole it is, 0..1).
import { validateMerge } from './finance-parties.mjs';

const FILLER = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'and', 'the', 'mr', 'mrs', 'ms', 'shri', 'smt', 'dr', 'm', 's']);
const core = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !FILLER.has(w));
const joined = (name) => core(name).join('');

// Edits to turn a into b; two letters swapped ("electrcials") is one slip, not two.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The same name allowing a small spelling slip ("Electrcials"): one slip per eight letters, never on short names. */
export function sameName(a, b) {
  const x = joined(a);
  const y = joined(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 7) return false;
  return editDistance(x, y) <= Math.max(1, Math.floor(Math.min(x.length, y.length) / 8));
}

/** Every word of the shorter name is a word of the longer one, so "Sri Lakshmi Hardware" fits "Sri Lakshmi Hardware and Paints". */
export function nameWithin(a, b) {
  const x = core(a);
  const y = core(b);
  if (!x.length || !y.length) return false;
  const inside = (small, big) => small.length >= 2 && small.every((w) => big.includes(w));
  return inside(x, y) || inside(y, x);
}

const shouting = (s) => s === s.toUpperCase() && /[A-Z]{3}/.test(s);
export function niceName(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!shouting(s)) return s;
  const small = new Set(['and', 'of', 'the', 'for', 'in', 'at']);
  return s.toLowerCase().replace(/(^|[\s.&'-])([a-z]+)/g, (m, p, w, at) => (at > 0 && small.has(w) ? m : p + w[0].toUpperCase() + w.slice(1)));
}

const bankNames = (p) => [...new Set((p.accounts ?? []).map((a) => a.verifiedName).filter(Boolean))];
const caseSame = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Which of two duplicates to keep: the one holding the payment details, then the one with more postings, then one that is not "Other".
function keeper(a, b) {
  const score = (p) => (p.accounts?.length ? 4 : 0) + (p.stats?.postings ? 2 : 0) + (p.kind !== 'other' ? 1 : 0);
  const [x, y] = [score(a), score(b)];
  if (x !== y) return x > y ? [a, b] : [b, a];
  const [m, n] = [a.stats?.postings ?? 0, b.stats?.postings ?? 0];
  return m >= n ? [a, b] : [b, a];
}

const KIND_FROM = (s) => {
  if (!s || s.postings < 2 || s.categoryShare < 0.8) return null;
  const n = String(s.categoryName ?? '');
  if (s.direction === 'debit' && /salar|wage|payroll|stipend/i.test(n)) return ['employee', `${s.postings} payments, mostly under ${n}.`];
  if (s.direction === 'debit' && (s.categoryType === 'opex' || s.categoryType === 'capex')) return ['vendor', `${s.postings} payments, mostly under ${n}.`];
  if (s.direction === 'credit' && s.categoryType === 'revenue') return ['customer', `${s.postings} receipts, mostly under ${n}.`];
  if (s.direction === 'debit' && s.categoryType === 'tax') return ['government', `${s.postings} payments, mostly under ${n}.`];
  return null;
};

/**
 * The suggestions for a list of parties, most useful first: merges, then renames, then kinds. Each is
 * { id, type: 'merge'|'rename'|'kind', partyId, targetId?, to?, what, why }. A party that is the source of a merge gets nothing else.
 */
// A party named as the company itself, or as the bank's shortened form of it ("... PRIVATE" for "... Private Limited"), is us, not
// a payee, so it is never suggested a kind, a rename or a merge. selfNames are the company's own names; three words at least.
const words = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
export function isSelf(name, selfNames) {
  const w = words(name);
  return w.length >= 3 && selfNames.some((own) => { const o = words(own); return w.length <= o.length && w.every((x, i) => x === o[i]); });
}

export function suggestChanges(parties, { kindLabels = {}, selfNames = [] } = {}) {
  const live = parties.filter((p) => p.active !== false && !isSelf(p.name, selfNames));
  const out = [];
  const absorbed = new Set();

  // Merge: two parties that are one payee. Their names match (allowing a slip), or the bank showed one name for both.
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const [a, b] = [live[i], live[j]];
      if (a.kind === 'member' && b.kind === 'member') continue; // two relatives can share a name
      const fits = (n, name) => sameName(n, name) || nameWithin(n, name);
      const viaBank = [...bankNames(a), ...bankNames(b)].some((n) => fits(n, a.name) && fits(n, b.name));
      if (!sameName(a.name, b.name) && !viaBank) continue;
      const [keep, drop] = keeper(a, b);
      if (absorbed.has(drop.id) || absorbed.has(keep.id)) continue;
      if (!validateMerge({ id: drop.id, household_id: drop.householdId }, { id: keep.id }).ok) continue;
      absorbed.add(drop.id);
      const bank = bankNames(keep)[0] ?? bankNames(drop)[0];
      out.push({
        id: `merge:${drop.id}:${keep.id}`,
        type: 'merge',
        partyId: drop.id,
        targetId: keep.id,
        what: `Merge “${drop.name}” into “${keep.name}”`,
        why: `The two names are the same payee${bank ? `, and the bank showed “${bank}”` : ''}. ${keep.accounts?.length ? 'Keeps the payment details' : 'Keeps the entry with the most history'}; nothing is deleted.`,
      });
    }
  }

  // Rename: a name the bank showed on a verified account, when ours is a different spelling or a shortening of it.
  for (const p of live) {
    if (absorbed.has(p.id) || p.kind === 'member' || p.householdId || p.personId) continue; // a member's name is matched to the member records
    for (const bank of bankNames(p)) {
      if (caseSame(bank, p.name) || caseSame(niceName(bank), p.name)) continue;
      if (!sameName(bank, p.name) && !nameWithin(bank, p.name)) continue;
      const to = niceName(bank);
      if (live.some((q) => q.id !== p.id && caseSame(q.name, to))) break; // the new name is taken: that is a merge, not a rename
      out.push({ id: `rename:${p.id}`, type: 'rename', partyId: p.id, to, what: `Rename “${p.name}” to “${to}”`, why: `The bank showed “${bank}” when an account was verified. The name is only a label, so this is safe to change.` });
      break;
    }
  }

  // Kind: only for "Other", from what the party's posted payments were booked under.
  for (const p of live) {
    if (absorbed.has(p.id) || p.kind !== 'other' || p.householdId || p.personId) continue;
    const found = KIND_FROM(p.stats);
    if (!found) continue;
    const [kind, why] = found;
    out.push({ id: `kind:${p.id}`, type: 'kind', partyId: p.id, to: kind, what: `Set “${p.name}” to ${kindLabels[kind] ?? kind}`, why });
  }
  const order = { merge: 0, rename: 1, kind: 2 };
  return out.sort((a, b) => order[a.type] - order[b.type]);
}

/**
 * What the books say about each party, from posted allocations (not reversals): how many lines, the money paid out, the date of the
 * latest payment, and the category most of them were booked under (in the direction that has more lines). Parties merged into another
 * are counted under the main one. Returns Map(partyId -> { postings (in the dominant direction, for the kind suggestion), lines (all of them),
 * paidPaise, lastPaid, receivedPaise, lastReceived, direction, categoryName, categoryType,
 * categoryShare }). `allocations`: { bank_line_id, party_id, category_id, amount_paise }; `lines`: { id, tran_date, direction };
 * `categories`: { id, name, type }.
 */
export function postingStats(allocations, lines, categories, canonicalOf = new Map()) {
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  const catOf = new Map(categories.map((c) => [c.id, c]));
  const per = new Map();
  for (const a of allocations) {
    const line = lineOf.get(a.bank_line_id);
    if (!line || !a.party_id) continue;
    const id = canonicalOf.get(a.party_id) ?? a.party_id;
    const p = per.get(id) ?? { paidPaise: 0, lastPaid: null, receivedPaise: 0, lastReceived: null, debit: new Map(), credit: new Map() };
    const side = line.direction === 'credit' ? p.credit : p.debit;
    side.set(a.category_id, (side.get(a.category_id) ?? 0) + 1);
    if (line.direction === 'debit') {
      p.paidPaise += Number(a.amount_paise);
      if (!p.lastPaid || line.tran_date > p.lastPaid) p.lastPaid = line.tran_date;
    } else {
      p.receivedPaise += Number(a.amount_paise);
      if (!p.lastReceived || line.tran_date > p.lastReceived) p.lastReceived = line.tran_date;
    }
    per.set(id, p);
  }
  const out = new Map();
  for (const [id, p] of per) {
    const sum = (m) => [...m.values()].reduce((n, x) => n + x, 0);
    const direction = sum(p.debit) >= sum(p.credit) ? 'debit' : 'credit';
    const side = direction === 'debit' ? p.debit : p.credit;
    const total = sum(side);
    const [topId, topN] = [...side.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const cat = catOf.get(topId);
    out.set(id, { postings: total, lines: sum(p.debit) + sum(p.credit), paidPaise: p.paidPaise, lastPaid: p.lastPaid, receivedPaise: p.receivedPaise, lastReceived: p.lastReceived, direction, categoryName: cat?.name ?? null, categoryType: cat?.type ?? null, categoryShare: total ? topN / total : 0 });
  }
  return out;
}
