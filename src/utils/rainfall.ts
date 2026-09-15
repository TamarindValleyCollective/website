// Client-side fetch + chart geometry for the rainfall chart/table/monsoon
// stat on the Weather page. Mirrors weather.ts's fetch + localStorage-cache
// shape (see fetchWeather()), but a much longer TTL — the source Sheet is
// filled in by hand at most once a day, so there's no benefit to re-fetching
// more often than this within a single visitor's session.
const CACHE_KEY = 'tvc-rainfall-cache';
const CACHE_TTL_MS = 60 * 60 * 1000;

export const CALENDAR_MONTH_ORDER = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface CalendarMonthEntry {
  month: string;
  mm: number | null;
}

export interface CalendarYearSeries {
  year: number;
  monthly: CalendarMonthEntry[];
}

// Running year-to-date total per year, for the chart's cumulative view.
// Once a null month is hit (not yet reached, or before the Sheet's history
// starts), every month after it stays null too — a "total so far" can't
// exist past the point where the underlying data stops.
export function toCumulative(calendarYears: CalendarYearSeries[]): CalendarYearSeries[] {
  return calendarYears.map((y) => {
    let running = 0;
    let stopped = false;
    const monthly: CalendarMonthEntry[] = y.monthly.map((m) => {
      if (stopped || m.mm == null) {
        stopped = true;
        return { month: m.month, mm: null };
      }
      running += m.mm;
      return { month: m.month, mm: running };
    });
    return { year: y.year, monthly };
  });
}

export interface DailyMonthEntry {
  month: string;
  days: number[]; // index 0 = day 1
}

export interface DailyCalendarYear {
  year: number;
  months: DailyMonthEntry[];
}

export interface RainfallData {
  asOf: string;
  calendarYears: CalendarYearSeries[];
  dailyByCalendarYear: DailyCalendarYear[];
  monsoonToDate: number | null;
  sameSpanLastYear: number | null;
  cutoffMonth: string;
  cutoffDay: number;
  cutoffCalendarYear: number;
}

export async function fetchRainfall(): Promise<RainfallData> {
  const cached = localStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS) return parsed.data;
    } catch {
      // fall through to a fresh fetch
    }
  }

  const res = await fetch('/api/rainfall');
  if (!res.ok) throw new Error(`Rainfall API error ${res.status}`);
  const data: RainfallData = await res.json();

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {
    // caching is a nice-to-have, not a requirement
  }

  return data;
}

export interface LinePoint {
  x: number;
  y: number;
  month: string;
  mm: number;
}

export interface YearLine {
  year: number;
  // CSS custom property name (e.g. '--series-1') the chart's <style> block
  // defines — see the dataviz skill's fixed categorical hue order. Assigned
  // by chronological position among the years actually shown, never by
  // value, so a series keeps its color as new years arrive.
  colorVar: string;
  points: LinePoint[]; // only real (non-null) months, in calendar order
  pathD: string; // smoothed (Catmull-Rom) SVG path through `points`
  endPoint: LinePoint | null; // last real point — where the line's drawing stops
}

export interface MonthBound {
  left: number;
  right: number;
}

export interface LineChartGeometry {
  chartWidth: number;
  chartHeight: number;
  chartPadLeft: number;
  chartPadTop: number;
  plotWidth: number;
  plotHeight: number;
  maxMm: number;
  yTicks: number[];
  monthX: number[]; // x position per calendar-month index (0=Jan..11=Dec) — a point on the line, not a band
  // Each month's band for area/region marks (monsoon shading, hover hit-targets):
  // centered on that month's point in monthX, spanning to the midpoint with
  // its neighbors (or the chart edge for Jan/Dec) — so a mark built from
  // this actually covers "the month of X", not "X's point to the next
  // point's point".
  monthBounds: MonthBound[];
  years: YearLine[];
}

const SERIES_COLOR_VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];

// Rounds the axis ceiling up to the next multiple of 50 above the peak
// month (with 5% headroom so the tallest point isn't flush with the top),
// rather than a value hardcoded for whichever year happened to be current
// when this was written — a future year with a bigger monsoon (this Sheet
// has single months over 250mm in its history) still renders correctly.
function niceMax(peak: number): number {
  return Math.max(50, Math.ceil((peak * 1.05) / 50) * 50);
}

// Uniform Catmull-Rom spline through `points`, converted to cubic Bezier
// segments (tension 1/6) — a smooth curve that still passes through every
// real data point, unlike a fitted approximation. Points with no data
// (months not yet reached, or before the Sheet's history starts) are
// already filtered out by the caller, so this only ever draws through
// real values — never interpolates across a gap.
//
// Catmull-Rom isn't monotonicity-preserving: swinging from a high peak
// month down to a near-zero month can push a control point's y past the
// real data point on either side, which for a peak-to-trough swing means
// past the mm=0 baseline — the curve visibly dips into "negative rainfall"
// between two valid, non-negative data points. Clamping each control point
// to the plot's y-range keeps the curve passing exactly through every real
// value while stopping it from overshooting past axes that bound all real
// rainfall data (never negative, never above the chart's max).
function smoothPath(points: { x: number; y: number }[], yMin: number, yMax: number): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  const clampY = (y: number) => Math.min(yMax, Math.max(yMin, y));

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = clampY(p2.y - (p3.y - p1.y) / 6);
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

// Pure chart-frame math (dimensions, month tick positions, month bands) —
// identical for the plain monthly geometry and the day-granular cumulative
// geometry below, since both always draw the same 12 month ticks on the
// x-axis regardless of how many real data points make up each year's line.
function computeChartFrame() {
  const chartWidth = 720;
  const chartHeight = 240;
  const chartPadLeft = 36;
  const chartPadTop = 24;
  const chartPadRight = 16;
  const chartPadBottom = 26;
  const plotWidth = chartWidth - chartPadLeft - chartPadRight;
  const plotHeight = chartHeight - chartPadTop - chartPadBottom;

  const monthX = CALENDAR_MONTH_ORDER.map((_, i) => chartPadLeft + (plotWidth * i) / (CALENDAR_MONTH_ORDER.length - 1));
  const monthBounds: MonthBound[] = monthX.map((x, i) => {
    const prev = monthX[i - 1];
    const next = monthX[i + 1];
    const left = prev !== undefined ? (prev + x) / 2 : chartPadLeft;
    const right = next !== undefined ? (x + next) / 2 : chartWidth - chartPadRight;
    return { left, right };
  });

  return { chartWidth, chartHeight, chartPadLeft, chartPadTop, chartPadRight, plotWidth, plotHeight, monthX, monthBounds };
}

export function buildLineChartGeometry(calendarYears: CalendarYearSeries[]): LineChartGeometry {
  const { chartWidth, chartHeight, chartPadLeft, chartPadTop, plotWidth, plotHeight, monthX, monthBounds } = computeChartFrame();

  let peak = 0;
  for (const y of calendarYears) for (const m of y.monthly) if (m.mm != null) peak = Math.max(peak, m.mm);
  const maxMm = niceMax(peak);
  const yTicks = [0, maxMm / 4, maxMm / 2, (maxMm * 3) / 4].map((n) => Math.round(n));

  const toY = (mm: number) => chartPadTop + (plotHeight - (mm / maxMm) * plotHeight);

  const years: YearLine[] = calendarYears.map((y, idx) => {
    const points: LinePoint[] = [];
    y.monthly.forEach((m, i) => {
      if (m.mm == null) return;
      points.push({ x: monthX[i], y: toY(m.mm), month: m.month, mm: m.mm });
    });
    return {
      year: y.year,
      colorVar: SERIES_COLOR_VARS[idx % SERIES_COLOR_VARS.length],
      points,
      pathD: smoothPath(
        points.map((p) => ({ x: p.x, y: p.y })),
        chartPadTop,
        chartPadTop + plotHeight
      ),
      endPoint: points.length ? points[points.length - 1] : null,
    };
  });

  return { chartWidth, chartHeight, chartPadLeft, chartPadTop, plotWidth, plotHeight, maxMm, yTicks, monthX, monthBounds, years };
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate();
}

// One point per logged day for months the "Daily rain data" sheet actually
// covers, so the line's height at any x position is a real day-accurate
// running total (matching sumToDate() on the server) instead of only being
// trustworthy at month boundaries — a past year's position at "today's
// date" then reads as a same-day cutoff, not that month's full total.
// Months without day-level data still contribute a single end-of-month
// jump using that month's already-known total, same as before this
// existed, so coverage can be partial (e.g. only the last year or two)
// without breaking older years' lines. `monthPos` follows the same convention
// as buildLineChartGeometry's monthX indices — monthPos i means "cumulative
// through end of calendar month i" — so day d of D in month i lands at
// i - 1 + d/D, reaching exactly i on the month's last day.
export function buildDailyCumulativePoints(
  year: number,
  monthly: CalendarMonthEntry[],
  dailyMonths: DailyMonthEntry[] | undefined
): { monthPos: number; mm: number }[] {
  const dailyByMonth = new Map((dailyMonths ?? []).map((m) => [m.month, m.days]));
  const points: { monthPos: number; mm: number }[] = [];
  let running = 0;

  for (let i = 0; i < CALENDAR_MONTH_ORDER.length; i++) {
    const entry = monthly[i];
    if (entry.mm == null) break; // future / no data — stop, same rule as toCumulative()

    const days = dailyByMonth.get(CALENDAR_MONTH_ORDER[i]);
    if (days && days.length > 0) {
      const totalDays = daysInMonth(year, i);
      for (let d = 0; d < days.length; d++) {
        running += days[d];
        points.push({ monthPos: i - 1 + (d + 1) / totalDays, mm: running });
      }
    } else {
      running += entry.mm;
      points.push({ monthPos: i, mm: running });
    }
  }

  return points;
}

// Cumulative-mode counterpart to buildLineChartGeometry(): same chart frame
// and output shape, but each year's line is built from real day-by-day
// data where available (see buildDailyCumulativePoints) rather than one
// point per month — falls back to the plain monthly jump wherever a year
// has no daily coverage, so it's safe to call even if the Sheet's "Daily
// rain data" tab has no history at all.
export function buildCumulativeLineChartGeometry(
  calendarYears: CalendarYearSeries[],
  dailyByCalendarYear: DailyCalendarYear[]
): LineChartGeometry {
  const { chartWidth, chartHeight, chartPadLeft, chartPadTop, chartPadRight, plotWidth, plotHeight, monthX, monthBounds } = computeChartFrame();
  const dailyByYear = new Map(dailyByCalendarYear.map((y) => [y.year, y.months]));

  const perYearPoints = calendarYears.map((y) => buildDailyCumulativePoints(y.year, y.monthly, dailyByYear.get(y.year)));

  let peak = 0;
  for (const points of perYearPoints) for (const p of points) peak = Math.max(peak, p.mm);
  const maxMm = niceMax(peak);
  const yTicks = [0, maxMm / 4, maxMm / 2, (maxMm * 3) / 4].map((n) => Math.round(n));

  // Daily points can land fractionally outside [0, 11] at the very edges
  // (e.g. day 1 of a month with day-level data sits just shy of the
  // previous month's tick) — clamped to the plot's actual x-range so a
  // point never renders outside the chart.
  const toX = (monthPos: number) =>
    Math.min(chartWidth - chartPadRight, Math.max(chartPadLeft, chartPadLeft + (plotWidth * monthPos) / (CALENDAR_MONTH_ORDER.length - 1)));
  const toY = (mm: number) => chartPadTop + (plotHeight - (mm / maxMm) * plotHeight);

  const years: YearLine[] = calendarYears.map((y, idx) => {
    const points: LinePoint[] = perYearPoints[idx].map((p) => ({
      x: toX(p.monthPos),
      y: toY(p.mm),
      month: CALENDAR_MONTH_ORDER[Math.min(11, Math.max(0, Math.ceil(p.monthPos - 1e-9)))],
      mm: p.mm,
    }));
    return {
      year: y.year,
      colorVar: SERIES_COLOR_VARS[idx % SERIES_COLOR_VARS.length],
      points,
      pathD: smoothPath(
        points.map((p) => ({ x: p.x, y: p.y })),
        chartPadTop,
        chartPadTop + plotHeight
      ),
      endPoint: points.length ? points[points.length - 1] : null,
    };
  });

  return { chartWidth, chartHeight, chartPadLeft, chartPadTop, plotWidth, plotHeight, maxMm, yTicks, monthX, monthBounds, years };
}
