// Builds "Add to calendar" links entirely at build time -- no client JS
// needed. ICS all-day events use an *exclusive* DTEND (the day after the
// last real day), unlike our content schema's endDate, which is inclusive
// -- addDays(endDate ?? date, 1) below is that conversion, not a bug.

const VENUE = 'Tamarind Valley Collective, Thaggatti village, Kanakapura, Karnataka, India';

function toIcsDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + days);
  return copy;
}

// RFC 5545 TEXT escaping: backslash, comma, semicolon, and literal newlines.
function escapeIcsText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

export interface CalendarEvent {
  uid: string;
  title: string;
  description: string;
  date: Date;
  endDate?: Date;
}

export function buildIcs(event: CalendarEvent): string {
  const dtStart = toIcsDate(event.date);
  const dtEnd = toIcsDate(addDays(event.endDate ?? event.date, 1));
  const dtStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tamarind Valley Collective//Events//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.uid}@tvc.farm`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART;VALUE=DATE:${dtStart}`,
    `DTEND;VALUE=DATE:${dtEnd}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    `LOCATION:${escapeIcsText(VENUE)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

export function icsDataUri(event: CalendarEvent): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcs(event))}`;
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const dtStart = toIcsDate(event.date);
  const dtEnd = toIcsDate(addDays(event.endDate ?? event.date, 1));
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${dtStart}/${dtEnd}`,
    details: event.description,
    location: VENUE,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
