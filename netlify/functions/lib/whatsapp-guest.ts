// Pure helpers for the inbox's guest panel and "Needs reply" filter (used by
// whatsapp-admin.mts): who still owes a reply, and how bookings and stays are
// summarised for staff. No I/O, so they can be tested directly.
import { classifyKeyword } from './whatsapp-optout';
import { ACCOMMODATION_UNITS } from '../../../scripts/lib/accommodation.mjs';

export interface RecentMessage {
  direction: 'inbound' | 'outbound';
  body: string;
}

// True when the guest's latest message is still waiting for a person to answer.
// `recentNewestFirst` is the last few messages, newest first. Automatic replies
// (the out-of-hours acknowledgement, the STOP confirmation) don't count as an
// answer, a STOP / START isn't something a person needs to answer, and a blocked
// contact never waits on us.
export function needsReply(recentNewestFirst: RecentMessage[], blocked = false): boolean {
  if (blocked) return false;
  for (const m of recentNewestFirst) {
    if (m.direction === 'outbound' && m.body.startsWith('[Auto-reply]')) continue;
    if (m.direction === 'outbound') return false;
    return classifyKeyword(m.body) === null;
  }
  return false;
}

export interface BookingRow {
  event_title: string;
  event_date: string | null;
  attendee_count: number | null;
  amount: number;
  currency: string;
  mode: 'test' | 'live' | null;
  whatsapp_opt_in: boolean | null;
  refunded_at: string | null;
  refund_initiated_at: string | null;
  refund_status: string | null;
  cancellation_requested_at: string | null;
  cancellation_declined_at: string | null;
  created_at: string;
}

// What state the booking is in, in the words admins use on the Event Payments page.
export function bookingStatus(row: BookingRow): string {
  if (row.refunded_at) return 'Refunded';
  if (row.refund_initiated_at) return row.refund_status === 'failed' ? 'Refund failed' : 'Refund started';
  if (row.cancellation_requested_at && !row.cancellation_declined_at) return 'Cancellation requested';
  return 'Paid';
}

const TEMPLATE_LABELS: Record<string, string> = {
  tvc_booking_confirmed: 'Confirmation',
  tvc_event_reminder: 'Reminder',
  tvc_event_cancelled: 'Event cancelled notice',
  tvc_refund_initiated: 'Refund started notice',
  tvc_refund_processed: 'Refund processed notice',
  tvc_cancellation_declined: 'Cancellation declined notice',
};

export interface TemplateSend {
  event_payment_id: string;
  template: string;
  status: string;
  created_at: string;
}

// The latest status of each kind of WhatsApp message sent about one booking
// ("Confirmation: delivered"). `accepted` (Meta took it, no receipt yet) reads as "sent".
export function messageSummary(sends: TemplateSend[]): Array<{ label: string; status: string }> {
  const latest = new Map<string, TemplateSend>();
  for (const s of sends) {
    const key = s.template.replace(/_v2$/, '');
    const prev = latest.get(key);
    if (!prev || prev.created_at <= s.created_at) latest.set(key, s);
  }
  return [...latest.entries()].map(([key, s]) => ({
    label: TEMPLATE_LABELS[key] ?? key.replace(/^tvc_/, '').replace(/_/g, ' '),
    status: s.status === 'accepted' ? 'sent' : s.status,
  }));
}

const STAY_KINDS: Record<string, string> = {
  'public-event': 'Event stay',
  'private-event': 'Private event',
  'casual-stay': 'Stay',
  'member-stay': 'Member stay',
};

const UNIT_LABELS = new Map<string, string>(ACCOMMODATION_UNITS.map((u: { id: string; label: string }) => [u.id, u.label]));

export interface StayRow {
  startDate: string;
  nights: number;
  tentId: string;
  type: string;
  label?: string;
  eventTitle?: string;
}

// `labels` is the unit-name lookup from the units table; the built-in names are the fallback for a caller without it.
export function shapeStay(s: StayRow, labels?: Map<string, string>): { startDate: string; nights: number; unit: string; kind: string; title: string | null } {
  return {
    startDate: s.startDate,
    nights: s.nights,
    unit: labels?.get(s.tentId) ?? UNIT_LABELS.get(s.tentId) ?? s.tentId,
    kind: STAY_KINDS[s.type] ?? 'Stay',
    title: s.eventTitle ?? s.label ?? null,
  };
}
