// Shared by src/pages/events/index.astro and src/pages/events/[slug].astro
// so date-range formatting and the day/overnight tag can't drift between
// the listing and detail pages.

const DAY_MS = 86_400_000;

const dateOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
const dayMonthOpts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-IN', dateOpts);
}

// Total days the event spans, inclusive of both endpoints. A single-day
// event (no endDate, or endDate === date) is 1 day.
export function durationDays(date: Date, endDate?: Date): number {
  if (!endDate) return 1;
  return Math.round((endDate.getTime() - date.getTime()) / DAY_MS) + 1;
}

export function durationTag(date: Date, endDate?: Date): string {
  const days = durationDays(date, endDate);
  return days <= 1 ? 'Day event' : `Overnight event (${days} days)`;
}

// A real date range for multi-day events ("27–28 August 2022" or, when the
// range crosses a month, "31 October – 1 November 2020") instead of a
// single date that would silently drop the end date.
export function formatDateRange(date: Date, endDate?: Date): string {
  if (!endDate || durationDays(date, endDate) <= 1) return formatDate(date);
  const sameMonth = date.getMonth() === endDate.getMonth() && date.getFullYear() === endDate.getFullYear();
  if (sameMonth) {
    return `${date.getDate()}–${formatDate(endDate)}`;
  }
  const sameYear = date.getFullYear() === endDate.getFullYear();
  if (sameYear) {
    return `${date.toLocaleDateString('en-IN', dayMonthOpts)} – ${formatDate(endDate)}`;
  }
  return `${formatDate(date)} – ${formatDate(endDate)}`;
}

// Days from `today` until the event starts - 0 for today, negative for past
// events. Used for the Upcoming countdown.
export function daysUntil(date: Date, today: Date): number {
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfEvent = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((startOfEvent.getTime() - startOfToday.getTime()) / DAY_MS);
}

export function countdownLabel(daysAway: number): string {
  if (daysAway <= 0) return 'Today';
  if (daysAway === 1) return 'Tomorrow';
  return `${daysAway} days to go`;
}
