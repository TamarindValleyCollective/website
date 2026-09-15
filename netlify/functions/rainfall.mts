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
//    tab has enough resolution to compare "this year so far" against the
//    *same* stretch last year (Jan 1 through today's date in both years),
//    rather than comparing a partial year against another year's full
//    total.
//
// Both "this year so far" and the chart's cumulative line are calendar-year
// (1 Jan) based, on purpose — an earlier agricultural-year (1 Apr) framing
// for the stat and a calendar-year framing for the chart produced two
// different "same stretch last year" numbers on the same page, which read
// as a bug rather than two deliberately different metrics.
import { getSheetValues } from '../../scripts/lib/google-drive.mjs';

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

const MONTH_CALENDAR_NUM: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

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

interface CalendarDailyMonthEntry {
  month: string;
  days: number[]; // index 0 = day 1
}

// Raw daily rows, keyed by plain calendar year — feeds both the chart's
// cumulative line (so it can trace an actual day-by-day trajectory instead
// of jumping straight from one month-end total to the next) and
// sumCalendarYearToDate() below (so "this year so far" and "same stretch
// last year" are day-matched, not a partial year against another year's
// full total). A month not yet fully reached in the current year is
// truncated to only the days already elapsed, so nothing implies data for
// days that haven't happened yet; a month that hasn't started at all is
// dropped.
function parseDailyTabByCalendarYear(
  rows: string[][],
  nowYear: number,
  nowMonth: number,
  nowDay: number
): Record<number, CalendarDailyMonthEntry[]> {
  const byYear: Record<number, CalendarDailyMonthEntry[]> = {};

  for (const row of rows) {
    const yearRaw = String(row[0] ?? '').trim();
    if (!/^\d{4}$/.test(yearRaw)) continue; // header row or blank row
    const year = Number(yearRaw);

    const monthAbbr = normalizeMonth(String(row[1] ?? ''));
    if (!monthAbbr) continue;
    const calMonthNum = MONTH_CALENDAR_NUM[monthAbbr];

    if (year > nowYear || (year === nowYear && calMonthNum > nowMonth)) continue; // hasn't started

    let days = row.slice(2, 33).map((v) => (v === undefined || v === '' ? 0 : Number(v) || 0));
    if (year === nowYear && calMonthNum === nowMonth) days = days.slice(0, nowDay);

    (byYear[year] ??= []).push({ month: monthAbbr, days });
  }

  return byYear;
}

// Sum of rainfall from Jan 1 of `year` through a cutoff day within
// cutoffMonth — day-level figures from dailyByCalendarYear wherever a month
// has them, that month's own already-known total from monthlyByYear
// otherwise (matches buildDailyCumulativePoints() in src/utils/rainfall.ts,
// so this server-side total and the chart's client-side line agree
// exactly). The cutoff month itself must have real day-level data, or there
// is no honest way to say how much of it counts — no source, no claim,
// rather than guessing from that month's eventual full total.
function sumCalendarYearToDate(
  year: number,
  monthlyByYear: Record<string, Record<string, number>>,
  dailyByCalendarYear: Record<number, CalendarDailyMonthEntry[]>,
  cutoffMonth: string,
  cutoffDay: number
): number | null {
  const monthlyForYear = monthlyByYear[String(year)];
  const dailyForYear = new Map((dailyByCalendarYear[year] ?? []).map((m) => [m.month, m.days]));
  const cutoffDays = dailyForYear.get(cutoffMonth);
  if (!cutoffDays || cutoffDays.length === 0) return null;

  let sum = cutoffDays.slice(0, cutoffDay).reduce((a, b) => a + b, 0);
  const cutoffIdx = CALENDAR_MONTH_ORDER.indexOf(cutoffMonth);
  for (let i = 0; i < cutoffIdx; i++) {
    const month = CALENDAR_MONTH_ORDER[i];
    const days = dailyForYear.get(month);
    if (days && days.length > 0) sum += days.reduce((a, b) => a + b, 0);
    else if (monthlyForYear) sum += monthlyForYear[month] ?? 0;
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
    const cutoffMonth = CALENDAR_MONTH_ORDER[nowMonth - 1];

    const calendarYears = buildCalendarYears(monthlyByYear, nowYear, nowMonth);
    const dailyByCalendarYear = parseDailyTabByCalendarYear(dailyRows, nowYear, nowMonth, nowDay);

    const monsoonToDate = sumCalendarYearToDate(nowYear, monthlyByYear, dailyByCalendarYear, cutoffMonth, nowDay);
    const sameSpanLastYear = sumCalendarYearToDate(nowYear - 1, monthlyByYear, dailyByCalendarYear, cutoffMonth, nowDay);

    return jsonResponse({
      asOf: new Date().toISOString(),
      dailyByCalendarYear: Object.entries(dailyByCalendarYear).map(([year, months]) => ({ year: Number(year), months })),
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
