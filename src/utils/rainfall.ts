// Client-side fetch + chart geometry for the rainfall chart/table/monsoon
// stat on the Weather page. Mirrors weather.ts's fetch + localStorage-cache
// shape (see fetchWeather()), but a much longer TTL — the source Sheet is
// filled in by hand at most once a day, so there's no benefit to re-fetching
// more often than this within a single visitor's session.
const CACHE_KEY = 'tvc-rainfall-cache';
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface MonthlyEntry {
  month: string;
  mm: number;
}

export interface RainfallData {
  asOf: string;
  chartYear: string;
  currentYear: string;
  monthly: Record<string, MonthlyEntry[]>;
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

export interface ChartBar extends MonthlyEntry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChartGeometry {
  chartWidth: number;
  chartHeight: number;
  chartPadLeft: number;
  plotWidth: number;
  plotHeight: number;
  maxMm: number;
  yTicks: number[];
  peakMonth: MonthlyEntry;
  bars: ChartBar[];
}

// Rounds the axis ceiling up to the next multiple of 50 above the peak
// month (with 5% headroom so the tallest bar isn't flush with the top),
// rather than a value hardcoded for whichever year happened to be current
// when this was written — a future year with a bigger monsoon (this Sheet
// has single months over 250mm in its history) still renders correctly.
function niceMax(peak: number): number {
  return Math.max(50, Math.ceil((peak * 1.05) / 50) * 50);
}

export function buildChartGeometry(monthly: MonthlyEntry[]): ChartGeometry {
  const chartWidth = 720;
  const chartHeight = 220;
  const chartPadLeft = 36;
  const chartPadBottom = 26;
  const plotWidth = chartWidth - chartPadLeft - 12;
  const plotHeight = chartHeight - chartPadBottom - 10;

  const peakMonth = monthly.reduce((a, b) => (b.mm > a.mm ? b : a), monthly[0]);
  const maxMm = niceMax(peakMonth.mm);
  const yTicks = [0, maxMm / 4, maxMm / 2, (maxMm * 3) / 4].map((n) => Math.round(n));

  const bandWidth = plotWidth / monthly.length;
  const barWidth = Math.min(24, bandWidth * 0.55);

  const bars: ChartBar[] = monthly.map((d, i) => {
    const barHeight = (d.mm / maxMm) * plotHeight;
    return {
      ...d,
      x: chartPadLeft + i * bandWidth + (bandWidth - barWidth) / 2,
      y: 10 + (plotHeight - barHeight),
      width: barWidth,
      height: Math.max(barHeight, d.mm > 0 ? 2 : 0),
    };
  });

  return { chartWidth, chartHeight, chartPadLeft, plotWidth, plotHeight, maxMm, yTicks, peakMonth, bars };
}
