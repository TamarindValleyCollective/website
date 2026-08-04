// Netlify Function (v2 API) backing the rainfall chart/table/monsoon stat on
// /ecosystem/weather. The numbers used to be a hand-copied snapshot baked
// into WeatherView.astro's frontmatter, updated by hand whenever someone
// remembered to; this reads the community's live "Tvc rain data" Google
// Sheet on every page view instead, so a new row logged in the Sheet shows
// up on the site without a code change or a rebuild. Read-only — reuses
// google-drive.mjs's existing service-account auth (Sheets scope already
// granted for photo-pool.mts/enquiry.mts), no new credentials needed as
// long as the Sheet is shared (view access) with GDRIVE_SERVICE_ACCOUNT_EMAIL.
//
// The Sheet has two relevant tabs (a third, "Graph", is a chart the sheet
// owner built for themselves and isn't read here):
//  - "Rain data monthly": one row per month (Apr..Mar), one column per
//    agricultural year (e.g. "2025-26") — the monthly totals used for the
//    bar chart and the two-column table.
//  - "Daily rain data": one block per agricultural year, day-of-month
//    columns (1-31) per month row — only this tab has enough resolution to
//    compare "this monsoon so far" against the *same* stretch last year
//    (Apr 1 through today's date in both years), rather than comparing a
//    partial year against a other year's full total.
import { getSheetValues } from '../../scripts/lib/google-drive.mjs';

// Agricultural year runs April through March.
const MONTHS_AGRI_ORDER = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

// The Sheet spells months inconsistently ("April" in one tab, "Jun" in
// another, a trailing space on "May " in one row) — normalize everything
// to the same 3-letter key before using it.
const MONTH_ALIASES: Record<string, string> = {
  apr: 'Apr', april: 'Apr',
  may: 'May',
  jun: 'Jun', june: 'Jun',
  jul: 'Jul', july: 'Jul',
  aug: 'Aug', august: 'Aug',
  sep: 'Sep', sept: 'Sep', september: 'Sep',
  oct: 'Oct', october: 'Oct',
  nov: 'Nov', november: 'Nov',
  dec: 'Dec', december: 'Dec',
  jan: 'Jan', january: 'Jan',
  feb: 'Feb', february: 'Feb',
  mar: 'Mar', march: 'Mar',
};

function normalizeMonth(raw: string): string | null {
  return MONTH_ALIASES[raw.trim().toLowerCase()] ?? null;
}

function agriYearLabel(calendarYear: number, calendarMonth1to12: number): string {
  const startYear = calendarMonth1to12 >= 4 ? calendarYear : calendarYear - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function shiftAgriYearLabel(label: string, delta: number): string {
  const start = Number(label.split('-')[0]) + delta;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

interface MonthlyEntry {
  month: string;
  mm: number;
}

// "Rain data monthly" tab: row 1 is a year header (first cell blank), each
// following row is a month (until a trailing "Tot" row, which is skipped —
// normalizeMonth() returns null for it, same as it does for blank rows).
function parseMonthlyTab(rows: string[][]): Record<string, Record<string, number>> {
  if (rows.length === 0) return {};
  const header = rows[0];
  const yearCols = header.slice(1).map((y) => String(y ?? '').trim()).filter(Boolean);
  const byYear: Record<string, Record<string, number>> = {};
  for (const yearLabel of yearCols) byYear[yearLabel] = {};

  for (const row of rows.slice(1)) {
    const monthAbbr = normalizeMonth(String(row[0] ?? ''));
    if (!monthAbbr) continue;
    yearCols.forEach((yearLabel, i) => {
      const raw = row[i + 1];
      const mm = raw === undefined || raw === '' ? 0 : Number(raw);
      byYear[yearLabel][monthAbbr] = Number.isFinite(mm) ? mm : 0;
    });
  }
  return byYear;
}

interface DailyMonthBlock {
  month: string;
  days: number[]; // index 0 = day 1
  total: number;
}

// "Daily rain data" tab: a year label only appears in the top-left cell of
// its merged header row (column A), so it's detected once per block — by
// the header row's day-1 column reading "1" — rather than re-read from
// every month row underneath it, which the Sheets API returns blank for.
function parseDailyTab(rows: string[][]): Record<string, DailyMonthBlock[]> {
  const blocks: Record<string, DailyMonthBlock[]> = {};
  let currentYear: string | null = null;

  for (const row of rows) {
    const label = String(row[0] ?? '').trim();
    const dayOneCell = String(row[2] ?? '').trim();

    if (/^\d{4}-\d{2}$/.test(label) && dayOneCell === '1') {
      currentYear = label;
      blocks[currentYear] = [];
      continue;
    }

    if (!currentYear) continue;
    const monthAbbr = normalizeMonth(String(row[1] ?? ''));
    if (!monthAbbr) continue; // the blank row separating year blocks

    const days = row.slice(2, 33).map((v) => (v === undefined || v === '' ? 0 : Number(v) || 0));
    const totalRaw = row[33];
    const total = totalRaw === undefined || totalRaw === '' ? days.reduce((a, b) => a + b, 0) : Number(totalRaw) || 0;
    blocks[currentYear].push({ month: monthAbbr, days, total });
  }

  return blocks;
}

// Sum of rainfall from the start of the agricultural year (April 1) through
// a given cutoff day within cutoffMonth, using each month's own logged
// total for months already fully in the past and day-level data only for
// the cutoff month itself.
function sumToDate(block: DailyMonthBlock[] | undefined, cutoffMonth: string, cutoffDay: number): number | null {
  if (!block || block.length === 0) return null;
  const cutoffIdx = MONTHS_AGRI_ORDER.indexOf(cutoffMonth);
  let sum = 0;
  for (const entry of block) {
    const idx = MONTHS_AGRI_ORDER.indexOf(entry.month);
    if (idx < 0) continue;
    if (idx < cutoffIdx) sum += entry.total;
    else if (idx === cutoffIdx) sum += entry.days.slice(0, cutoffDay).reduce((a, b) => a + b, 0);
  }
  return sum;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);

  const sheetId = process.env.RAINFALL_SHEET_ID;
  if (!sheetId) {
    console.error('Missing RAINFALL_SHEET_ID');
    return jsonResponse({ error: 'Server misconfigured' }, 500);
  }

  try {
    const [monthlyRows, dailyRows] = await Promise.all([
      getSheetValues(sheetId, "'Rain data monthly'!A1:Z60"),
      getSheetValues(sheetId, "'Daily rain data'!A1:AH200"),
    ]);

    const monthlyByYear = parseMonthlyTab(monthlyRows);
    const dailyByYear = parseDailyTab(dailyRows);

    // The farm is IST — compute "today" in that zone rather than the
    // Function's own (UTC) clock, same reasoning as formatFarmTime() in
    // src/utils/weather.ts.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date())
        .map((p) => [p.type, p.value])
    );
    const nowYear = Number(parts.year);
    const nowMonth = Number(parts.month);
    const nowDay = Number(parts.day);

    const currentYear = agriYearLabel(nowYear, nowMonth);
    const chartYear = shiftAgriYearLabel(currentYear, -1);
    const cutoffMonth = MONTHS_AGRI_ORDER[(nowMonth - 4 + 12) % 12];
    const cutoffIdx = MONTHS_AGRI_ORDER.indexOf(cutoffMonth);

    const chartMonthly: MonthlyEntry[] = MONTHS_AGRI_ORDER.map((month) => ({
      month,
      mm: monthlyByYear[chartYear]?.[month] ?? 0,
    }));

    // Only months reached so far this agricultural year — mirrors how the
    // page used to stop its in-progress-year column at the current month
    // rather than showing unreached months as zero.
    const currentMonthly: MonthlyEntry[] = MONTHS_AGRI_ORDER.slice(0, cutoffIdx + 1).map((month) => ({
      month,
      mm: monthlyByYear[currentYear]?.[month] ?? 0,
    }));

    const monsoonToDate = sumToDate(dailyByYear[currentYear], cutoffMonth, nowDay);
    const sameSpanLastYear = sumToDate(dailyByYear[chartYear], cutoffMonth, nowDay);

    return jsonResponse({
      asOf: new Date().toISOString(),
      chartYear,
      currentYear,
      monthly: { [chartYear]: chartMonthly, [currentYear]: currentMonthly },
      monsoonToDate,
      sameSpanLastYear,
      cutoffMonth,
      cutoffDay: nowDay,
      cutoffCalendarYear: nowYear,
    });
  } catch (err) {
    console.error('Failed to read rainfall sheet', err);
    return jsonResponse({ error: 'Failed to reach Google Sheets' }, 502);
  }
};

export const config = {
  path: '/api/rainfall',
};
