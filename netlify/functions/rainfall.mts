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
//  - "Rain data monthly": one row per month, one column per calendar year
//    (e.g. "2025") — the monthly totals used directly for the chart's
//    per-year lines and the table (see buildCalendarYears() below).
//  - "Daily rain data": a flat table, one row per calendar year+month
//    (e.g. "2025"/"April"), with day-of-month columns (1-31) — only this
//    tab has enough resolution to compare "this monsoon so far" against
//    the *same* stretch last year (Apr 1 through today's date in both
//    years), rather than comparing a partial year against another year's
//    full total.
import { getSheetValues } from '../../scripts/lib/google-drive.mjs';

// Agricultural year runs April through March.
const MONTHS_AGRI_ORDER = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
const CALENDAR_MONTH_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

// Calendar month number for agriYearLabel() — the Sheet's "Daily rain data"
// rows carry a plain calendar year (e.g. "2025"), not an agricultural-year
// label, so a row's agricultural year has to be derived from year + month.
const MONTH_CALENDAR_NUM: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

function agriYearLabel(calendarYear: number, calendarMonth1to12: number): string {
  const startYear = calendarMonth1to12 >= 4 ? calendarYear : calendarYear - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function shiftAgriYearLabel(label: string, delta: number): string {
  const start = Number(label.split('-')[0]) + delta;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

interface CalendarMonthEntry {
  month: string;
  mm: number | null;
}

interface CalendarYearSeries {
  year: number;
  monthly: CalendarMonthEntry[];
}

// "Rain data monthly" tab: row 1 is a header of plain calendar years (e.g.
// "2025"), each following row is a month (in whatever order the Sheet has
// them) until a trailing "Total" row, which is skipped — normalizeMonth()
// returns null for it, same as it does for blank rows.
function parseMonthlyTab(rows: string[][]): Record<string, Record<string, number>> {
  const byYear: Record<string, Record<string, number>> = {};
  if (rows.length === 0) return byYear;

  const header = rows[0];
  const yearCols = header.slice(1).map((y) => String(y ?? '').trim()).filter(Boolean);
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

// Reshapes the monthly totals into one Jan-Dec series per calendar year, for
// the chart's per-year lines. A month is `null` (rather than 0) once it's in
// the future — the Sheet's own not-yet-reached cells (2027 onward, at the
// time of writing) are pre-filled with a literal "0" rather than left
// blank, so a real dry-season 0 and "hasn't happened yet" can only be told
// apart by date, not by cell contents. A year that's entirely future (every
// month null) is dropped rather than drawing an empty line.
function buildCalendarYears(
  monthlyByYear: Record<string, Record<string, number>>,
  nowYear: number,
  nowMonth: number
): CalendarYearSeries[] {
  const years = Object.keys(monthlyByYear)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);

  const series: CalendarYearSeries[] = [];
  for (const year of years) {
    const yearLabel = String(year);
    const monthly: CalendarMonthEntry[] = CALENDAR_MONTH_ORDER.map((month) => {
      const calMonthNum = MONTH_CALENDAR_NUM[month];
      const isFuture = year > nowYear || (year === nowYear && calMonthNum > nowMonth);
      if (isFuture) return { month, mm: null };
      return { month, mm: monthlyByYear[yearLabel]?.[month] ?? 0 };
    });

    if (monthly.some((m) => m.mm !== null)) series.push({ year, monthly });
  }

  return series;
}

interface DailyMonthBlock {
  month: string;
  days: number[]; // index 0 = day 1
  total: number;
}

// "Daily rain data" tab: a flat table, header row ["Year", "Month", "1",
// "2", ..., "31"], then one row per calendar year+month with day-of-month
// values in columns C-AG. Rows for months not yet reached are present but
// empty, not absent — normalizeMonth() returns null for the header row
// (month "Month" isn't a valid alias) and any blank rows, so they're
// skipped the same way.
function parseDailyTab(rows: string[][]): Record<string, DailyMonthBlock[]> {
  const blocks: Record<string, DailyMonthBlock[]> = {};

  for (const row of rows) {
    const yearRaw = String(row[0] ?? '').trim();
    if (!/^\d{4}$/.test(yearRaw)) continue; // header row or blank row

    const monthAbbr = normalizeMonth(String(row[1] ?? ''));
    if (!monthAbbr) continue;

    const agriYear = agriYearLabel(Number(yearRaw), MONTH_CALENDAR_NUM[monthAbbr]);
    const days = row.slice(2, 33).map((v) => (v === undefined || v === '' ? 0 : Number(v) || 0));
    const total = days.reduce((a, b) => a + b, 0);

    (blocks[agriYear] ??= []).push({ month: monthAbbr, days, total });
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

    const calendarYears = buildCalendarYears(monthlyByYear, nowYear, nowMonth);

    const monsoonToDate = sumToDate(dailyByYear[currentYear], cutoffMonth, nowDay);
    const sameSpanLastYear = sumToDate(dailyByYear[chartYear], cutoffMonth, nowDay);

    return jsonResponse({
      asOf: new Date().toISOString(),
      chartYear,
      currentYear,
      calendarYears,
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
