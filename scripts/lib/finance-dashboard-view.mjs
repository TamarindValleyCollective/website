// What the finance dashboard page (src/pages/internal/finance/dashboard.astro) shows, worked out from the payload of
// GET /api/finance-admin/dashboard: money formatting, chart markup and the view models for the tiles and lists. Pure and
// I/O-free so it is tested directly (finance-dashboard-view.test.mjs). The charts carry no colour of their own: every mark has a
// class (`bar-in`, `g-salary`, ...) that the page styles from the --tvc-chart-* tokens, so both appearances work. Markup is
// built from numbers and fixed words only (month names, group names); anything a person typed (a budget line's label) is
// placed by the page with textContent, never through here.

export const GROUPS = ['salary', 'farm', 'projects', 'company', 'sinking', 'other'];
export const GROUP_LABELS = { salary: 'Salary', farm: 'Farm and household', projects: 'Projects', company: 'Company', sinking: 'Sinking fund', other: 'Not yet explained' };
export const GROUP_CLASS = { salary: 'g-salary', farm: 'g-farm', projects: 'g-projects', company: 'g-company', sinking: 'g-saved', other: 'g-other' };
export const HEAD_LABELS = { company: 'Company', farm: 'Farm', projects: 'Projects', investment: 'Sinking fund', income: 'Income', maintenance: 'Maintenance' };
export const SPEND_HEADS = ['company', 'farm', 'projects', 'investment'];
export const STATUS = {
  within: { tone: 'ok', label: 'Within budget' },
  over_slight: { tone: 'warn', label: 'Slightly over' },
  over: { tone: 'crit', label: 'Over budget' },
  on_track: { tone: 'ok', label: 'On track' },
  watch: { tone: 'warn', label: 'Watch' },
  over_pace: { tone: 'crit', label: 'Over pace' },
  not_projected: { tone: 'neutral', label: 'Not projected' },
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthShort = (month) => MONTH_NAMES[Number(month.slice(5, 7)) - 1];

// 1 lakh = ₹1,00,000 = 1,00,00,000 paise.
export const toLakh = (paise) => paise / 10_000_000;
const minus = (n) => (n < 0 ? '−' : '');
/** '₹52.3 L', with a real minus sign for a negative. */
export const lakhText = (paise, digits = 1) => `${minus(paise)}₹${Math.abs(toLakh(paise)).toFixed(digits)} L`;
/** '+₹2.1 L' or '−₹0.4 L'. */
export const signedLakh = (paise) => `${paise < 0 ? '−' : '+'}₹${Math.abs(toLakh(paise)).toFixed(1)} L`;
/** '₹15,000' in Indian digit grouping, whole rupees. */
export const rupeesText = (paise) => `${minus(paise)}₹${Math.abs(Math.round(paise / 100)).toLocaleString('en-IN')}`;
export const percentText = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%');
export const monthsText = (m) => (m === null || m === undefined ? '–' : m.toFixed(1));

/** An axis from zero to a round top, about five gridlines at most. Values are in lakh. */
export function niceAxis(maxLakh) {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  const step = steps.find((s) => Math.ceil(maxLakh / s) <= 5) ?? 1000;
  const top = Math.max(step, Math.ceil(maxLakh / step) * step);
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Number(v.toFixed(2)));
  return { top, ticks };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f = (n) => Number(n.toFixed(1));
const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function roundTop(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return `M${f(x)} ${f(y + h)}V${f(y + rr)}Q${f(x)} ${f(y)} ${f(x + rr)} ${f(y)}H${f(x + w - rr)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + rr)}V${f(y + h)}Z`;
}
const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])} ${f(p[1])}`).join('');

function frame(w, h, m, top, ticks) {
  const y = scale(0, top, h - m.b, m.t);
  const grid = ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${f(y(t))}" y2="${f(y(t))}"/><text class="tick" x="${m.l - 8}" y="${f(y(t) + 4)}" text-anchor="end">${t}</text>`).join('');
  return { y, grid };
}
const svg = (w, h, label, body) => `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;
const monthLabel = (r) => `${monthShort(r.month)}${r.partial ? '*' : ''}`;
const tipMonth = (r) => `${monthShort(r.month)}${r.partial ? ' (so far)' : ''}`;
const hit = (x, y, w, h, tip) => `<rect class="hit" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" data-tip="${esc(tip)}"/>`;

/** Money in against money out for each month of the year (the cash view). */
export function barsInOutSvg(months, width) {
  const w = Math.max(280, width);
  const h = 260;
  const m = { l: 36, r: 8, t: 10, b: 26 };
  const { top, ticks } = niceAxis(Math.max(0, ...months.flatMap((r) => [toLakh(r.inPaise), toLakh(r.outPaise)])));
  const { y, grid } = frame(w, h, m, top, ticks);
  const slot = (w - m.l - m.r) / Math.max(1, months.length);
  const bw = Math.max(8, Math.min(26, slot * 0.34));
  const base = y(0);
  let body = grid;
  months.forEach((r, i) => {
    const cx = m.l + slot * (i + 0.5);
    const op = r.partial ? ' partial' : '';
    const tip = `${tipMonth(r)}\nIn ${lakhText(r.inPaise)} (maintenance ${lakhText(r.inMaintenancePaise)})\nOut ${lakhText(r.outPaise)}\nNet ${signedLakh(r.netPaise)}`;
    body += `<path class="bar-in${op}" d="${roundTop(cx - bw - 1, y(toLakh(r.inPaise)), bw, base - y(toLakh(r.inPaise)), 4)}"/>`;
    body += `<path class="bar-out${op}" d="${roundTop(cx + 1, y(toLakh(r.outPaise)), bw, base - y(toLakh(r.outPaise)), 4)}"/>`;
    body += `<text class="tick" x="${f(cx)}" y="${h - 8}" text-anchor="middle">${monthLabel(r)}</text>`;
    body += hit(cx - slot / 2, m.t, slot, h - m.t - m.b, tip);
  });
  body += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${f(base)}" y2="${f(base)}"/>`;
  return svg(w, h, 'Money in and out by month, in lakh rupees', body);
}

/** Money out by month, stacked by group, with a 2px gap between groups. The unexplained remainder is its own group. */
export function stackedSvg(months, width) {
  const w = Math.max(280, width);
  const h = 280;
  const m = { l: 36, r: 8, t: 10, b: 26 };
  const { top, ticks } = niceAxis(Math.max(0, ...months.map((r) => toLakh(r.outPaise))));
  const { y, grid } = frame(w, h, m, top, ticks);
  const slot = (w - m.l - m.r) / Math.max(1, months.length);
  const bw = Math.max(10, Math.min(34, slot * 0.58));
  const base = y(0);
  let body = grid;
  months.forEach((r, i) => {
    const cx = m.l + slot * (i + 0.5);
    const present = GROUPS.filter((g) => r.outByGroup[g] > 0);
    let cum = 0;
    let tip = tipMonth(r);
    present.forEach((g, j) => {
      const v = toLakh(r.outByGroup[g]);
      tip += `\n${GROUP_LABELS[g]} ${lakhText(r.outByGroup[g])}`;
      const y1 = y(cum + v);
      const hh = Math.max(1, y(cum) - y1 - (cum > 0 ? 2 : 0));
      const cls = `${GROUP_CLASS[g]}${r.partial ? ' partial' : ''}`;
      body += j === present.length - 1
        ? `<path class="${cls}" d="${roundTop(cx - bw / 2, y1, bw, hh, 4)}"/>`
        : `<rect class="${cls}" x="${f(cx - bw / 2)}" y="${f(y1)}" width="${f(bw)}" height="${f(hh)}"/>`;
      cum += v;
    });
    tip += `\nTotal ${lakhText(r.outPaise)}`;
    body += `<text class="tick" x="${f(cx)}" y="${h - 8}" text-anchor="middle">${monthLabel(r)}</text>`;
    body += hit(cx - slot / 2, m.t, slot, h - m.t - m.b, tip);
  });
  body += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${f(base)}" y2="${f(base)}"/>`;
  return svg(w, h, 'Money out by month, split into salary, farm and household, projects, company, sinking fund and money not yet explained', body);
}

/** The closing balance at each month end, and optionally the same with the sinking fund added. */
export function balanceSvg(months, width, { withFd = false, height = 240 } = {}) {
  const w = Math.max(280, width);
  const h = height;
  const m = { l: 36, r: 12, t: 22, b: 26 };
  const vals = months.flatMap((r) => [toLakh(r.closingPaise), ...(withFd ? [toLakh(r.closingPaise + r.fdPaise)] : [])]);
  const { top, ticks } = niceAxis(Math.max(0, ...vals));
  const { y, grid } = frame(w, h, m, top, ticks);
  const slot = (w - m.l - m.r) / Math.max(1, months.length);
  const X = (i) => m.l + slot * (i + 0.5);
  let body = grid;
  if (!months.length) return svg(w, h, 'Closing balance by month', body);
  const own = months.map((r, i) => [X(i), y(toLakh(r.closingPaise))]);
  const both = months.map((r, i) => [X(i), y(toLakh(r.closingPaise + r.fdPaise))]);
  const last = months.length - 1;
  if (withFd) {
    body += `<path class="line-fd" d="${line(both)}"/>`;
    body += `<circle class="dot-fd" cx="${f(both[last][0])}" cy="${f(both[last][1])}" r="5"/><text class="strong" x="${f(both[last][0])}" y="${f(both[last][1] - 10)}" text-anchor="end">${lakhText(months[last].closingPaise + months[last].fdPaise)}</text>`;
  }
  body += `<path class="line-balance" d="${line(own)}"/>`;
  body += `<circle class="dot-balance" cx="${f(own[last][0])}" cy="${f(own[last][1])}" r="5"/><text class="strong" x="${f(own[last][0])}" y="${f(own[last][1] + 20)}" text-anchor="end">${lakhText(months[last].closingPaise)}</text>`;
  months.forEach((r, i) => {
    const tip = `${r.partial ? 'So far in ' : ''}${monthShort(r.month)}${r.partial ? '' : ' end'}\nBank ${lakhText(r.closingPaise)}${withFd ? `\nSinking fund ${lakhText(r.fdPaise)}\nTogether ${lakhText(r.closingPaise + r.fdPaise)}` : ''}`;
    body += `<text class="tick" x="${f(X(i))}" y="${h - 8}" text-anchor="middle">${monthLabel(r)}</text>`;
    body += hit(X(i) - slot / 2, m.t, slot, h - m.t - m.b, tip);
  });
  return svg(w, h, 'Closing balance by month', body);
}

/** UPI circle spend per month against the monthly cap. history: [{ month: '2026-08', paise }]. */
export function circleBarsSvg(history, capPaise, width) {
  const w = Math.max(280, width);
  const h = 240;
  const m = { l: 44, r: 12, t: 16, b: 26 };
  const capK = capPaise / 100 / 1000;
  const top = Math.max(1, Math.ceil(Math.max(capK, ...history.map((r) => r.paise / 100 / 1000)) / 5) * 5 + 1);
  const ticks = [];
  for (let v = 0; v <= top; v += 5) ticks.push(v);
  const y = scale(0, top, h - m.b, m.t);
  let body = ticks.map((t) => `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${f(y(t))}" y2="${f(y(t))}"/><text class="tick" x="${m.l - 8}" y="${f(y(t) + 4)}" text-anchor="end">${t}k</text>`).join('');
  const slot = (w - m.l - m.r) / Math.max(1, history.length);
  const bw = Math.min(34, slot * 0.55);
  const base = y(0);
  history.forEach((r, i) => {
    const cx = m.l + slot * (i + 0.5);
    const v = r.paise / 100 / 1000;
    const label = `${monthShort(`${r.month}-01`)}`;
    body += `<path class="bar-in${r.paise > capPaise ? ' over' : ''}" d="${roundTop(cx - bw / 2, y(v), bw, base - y(v), 4)}"/>`;
    body += `<text class="tick" x="${f(cx)}" y="${h - 8}" text-anchor="middle">${label}</text>`;
    body += hit(cx - slot / 2, m.t, slot, h - m.t - m.b, `${label}\n${rupeesText(r.paise)} of ${rupeesText(capPaise)}`);
  });
  body += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${f(base)}" y2="${f(base)}"/>`;
  body += `<line class="cap" x1="${m.l}" x2="${w - m.r}" y1="${f(y(capK))}" y2="${f(y(capK))}"/><text class="strong" x="${m.l + 4}" y="${f(y(capK) - 6)}">Cap ${rupeesText(capPaise)}</text>`;
  return svg(w, h, 'UPI circle spend per month against the cap', body);
}

/** A small line for a tile. values in any unit. */
export function sparkSvg(values) {
  if (values.length < 2) return '';
  const w = 120;
  const h = 30;
  const x = scale(0, values.length - 1, 3, w - 6);
  const y = scale(Math.min(...values), Math.max(...values), h - 4, 4);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="spark" d="${line(values.map((v, i) => [x(i), y(v)]))}"/></svg>`;
}

/** The ring for the circle: how much of the month's cap is used, with a tick for an even pace. */
export function ringSvg(circle) {
  const r = 78;
  const c = 2 * Math.PI * r;
  const used = Math.min(1, Math.max(0, circle.pct));
  const tone = circle.pct > 0.9 ? 'crit' : circle.pct > 0.6 ? 'warn' : 'ok';
  const a = (circle.day / circle.daysInMonth) * 2 * Math.PI - Math.PI / 2;
  const x1 = 100 + Math.cos(a) * (r - 12);
  const y1 = 100 + Math.sin(a) * (r - 12);
  const x2 = 100 + Math.cos(a) * (r + 12);
  const y2 = 100 + Math.sin(a) * (r + 12);
  return `<svg viewBox="0 0 200 200" role="img" aria-label="${Math.round(circle.pct * 100)} percent of this month's cap used">` +
    `<circle class="ring-track" cx="100" cy="100" r="${r}"/>` +
    `<circle class="ring-fill ring-${tone}" cx="100" cy="100" r="${r}" stroke-dasharray="${f(c * used)} ${f(c)}" transform="rotate(-90 100 100)"/>` +
    `<line class="ring-pace" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>` +
    `<text class="ring-big" x="100" y="98" text-anchor="middle">${rupeesText(circle.spentPaise)}</text>` +
    `<text class="ring-small" x="100" y="120" text-anchor="middle">of ${rupeesText(circle.capPaise)}</text></svg>`;
}

/** What the Overview's four tiles say. */
export function tilesOf(data, attention) {
  const cf = data.cashflow;
  const last = cf[cf.length - 1];
  const b = data.budget;
  const spent = b.lines.reduce((n, l) => n + (SPEND_HEADS.includes(l.head) ? l.actualPaise : 0), 0) + b.notBudgeted.reduce((n, l) => n + l.actualPaise, 0);
  const budgeted = b.lines.reduce((n, l) => n + (SPEND_HEADS.includes(l.head) ? l.budgetPaise : 0), 0);
  const attentionCount = data.closed ? 0 : (data.health.unallocated.count + data.health.awaitingBank.count + (attention?.toVerify ?? 0) + (attention?.toReview ?? 0));
  const net = data.closed ? cf.reduce((n, r) => n + r.netPaise, 0) : last?.netPaise ?? 0;
  return {
    runway: { months: data.runway.runwayMonths, withFdMonths: data.runway.runwayWithFdMonths, averageSpendPaise: data.runway.averageSpendPaise },
    budget: { hasBudget: b.hasBudget, usedPct: budgeted > 0 ? spent / budgeted : null, spentPaise: spent, budgetPaise: budgeted, yearFraction: b.yearFraction },
    balance: { paise: data.runway.balancePaise, netPaise: net, series: cf.map((r) => toLakh(r.closingPaise)) },
    attention: { count: attentionCount },
  };
}

/** The Data health list: what is waiting, and whether it blocks closing a month. Counts only; each has a page to fix it. */
export function healthItems(data, attention) {
  const h = data.health;
  const items = [];
  const add = (count, title, detail, tone, href) => count > 0 && items.push({ count, title, detail, tone, href });
  add(attention?.toVerify ?? 0, (attention?.toVerify ?? 0) === 1 ? 'Payee in use that nobody has verified' : 'Payees in use that nobody has verified', 'Money goes to a payee whose bank details have not been checked', 'crit', '/internal/finance/parties/?filter=unverified');
  add(h.unallocated.count, h.unallocated.count === 1 ? 'Bank line not fully explained' : 'Bank lines not fully explained', h.unallocated.oldestDate ? `The oldest is from ${h.unallocated.oldestDate}` : '', 'warn', '/internal/finance/ledger/');
  add(attention?.toReview ?? 0, (attention?.toReview ?? 0) === 1 ? 'Ledger entry held for review' : 'Ledger entries held for review', 'Flagged for a second look', 'warn', '/internal/finance/ledger/?filter=review');
  add(h.awaitingBank.count, h.awaitingBank.count === 1 ? 'Approved request waiting for a bank line' : 'Approved requests waiting for a bank line', `${rupeesText(h.awaitingBank.totalPaise)} in all; the oldest was approved ${h.awaitingBank.oldestDays} days ago`, 'warn', '/internal/finance/requests/');
  add(attention?.statementGaps?.length ?? 0, 'Statement gaps', 'A period with no bank statement imported', 'warn', '/internal/finance/import/');
  return items;
}
