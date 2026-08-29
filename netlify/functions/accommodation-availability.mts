// Netlify Function (v2 API), public, no auth - same shape as
// event-interest.mts. Backs the public accommodation calendar
// (src/components/views/AvailabilityView.astro) with hotel-booking-site-style
// aggregate availability: rooms/person-capacity free per day, never
// per-tent detail or guest data (see accommodation-admin.mts, which is the
// only place that data is readable). Reads the same
// `accommodation-bookings` Blobs store the admin Function writes to.
import { getStore } from '@netlify/blobs';
import { ACCOMMODATION_UNITS, TOTAL_ROOMS, TOTAL_CAPACITY, nightsForBooking, datesInMonth, bookingTouchesMonth } from '../../scripts/lib/accommodation.mjs';

type BookingType = 'public-event' | 'private-event' | 'casual-stay' | 'member-stay' | 'unit-closure' | 'farm-closure';

interface Booking {
  id: string;
  type: BookingType;
  eventTitle?: string;
  label?: string;
  exclusive?: boolean;
  startDate: string;
  nights: number;
  tents: { tentId: string }[];
}

interface DayAvailability {
  date: string;
  status: 'open' | 'limited' | 'full' | 'closed';
  roomsAvailable: number;
  totalRooms: number;
  capacityAvailable: number;
  totalCapacity: number;
  labels: string[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Public label per booking type - never the private `note` or any guest
// field, which don't even exist on this narrower Booking shape. casual-stay
// (via Linger) and member-stay (booked directly with Madhavan) read
// identically here on purpose: the booking channel isn't a public-facing
// distinction (see the design conversation's Q8/member-stay addendum).
function labelFor(b: Booking): string | null {
  switch (b.type) {
    case 'public-event':
      return b.eventTitle ?? b.label ?? 'Event';
    case 'private-event':
      return 'Private event';
    case 'casual-stay':
    case 'member-stay':
      return 'Booked';
    // unit-closure silently reduces capacity with no public label (a single
    // tent under repair isn't something a visitor needs an explanation
    // for); farm-closure is handled as a whole-day status, not a label.
    default:
      return null;
  }
}

// See accommodation-admin.mts's identical helper for why a single
// non-paginated list() call is sufficient at this farm's scale.
async function listAllBookings(): Promise<Booking[]> {
  const s = getStore('accommodation-bookings');
  const { blobs } = await s.list();
  const bookings = await Promise.all(blobs.map(({ key }) => s.get(key, { type: 'json' }) as Promise<Booking | null>));
  return bookings.filter((b): b is Booking => b !== null);
}

function computeDay(date: string, bookingsTouchingMonth: Booking[]): DayAvailability {
  const todaysBookings = bookingsTouchingMonth.filter((b) => nightsForBooking(b).includes(date));

  if (todaysBookings.some((b) => b.type === 'farm-closure')) {
    return { date, status: 'closed', roomsAvailable: 0, totalRooms: TOTAL_ROOMS, capacityAvailable: 0, totalCapacity: TOTAL_CAPACITY, labels: ['Closed'] };
  }

  const occupiedTentIds = new Set(todaysBookings.flatMap((b) => b.tents.map((t) => t.tentId)));
  const freeUnits = ACCOMMODATION_UNITS.filter((u) => !occupiedTentIds.has(u.id));
  const exclusiveBlock = todaysBookings.some((b) => b.type === 'private-event' && b.exclusive);

  const roomsAvailable = exclusiveBlock ? 0 : freeUnits.length;
  const capacityAvailable = exclusiveBlock ? 0 : freeUnits.reduce((sum, u) => sum + u.capacity, 0);

  const labels = [...new Set(todaysBookings.map(labelFor).filter((l): l is string => l !== null))];

  const status: DayAvailability['status'] = roomsAvailable === 0 ? 'full' : roomsAvailable < TOTAL_ROOMS ? 'limited' : 'open';

  return { date, status, roomsAvailable, totalRooms: TOTAL_ROOMS, capacityAvailable, totalCapacity: TOTAL_CAPACITY, labels };
}

async function handleAvailability(url: URL): Promise<Response> {
  const month = url.searchParams.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return jsonResponse({ error: 'month is required, as YYYY-MM' }, 400);

  try {
    const all = await listAllBookings();
    const relevant = all.filter((b) => bookingTouchesMonth(b, month));
    const days = datesInMonth(month).map((date) => computeDay(date, relevant));
    return jsonResponse({ month, totalRooms: TOTAL_ROOMS, totalCapacity: TOTAL_CAPACITY, days });
  } catch (err) {
    console.error('Failed to compute accommodation availability', err);
    return jsonResponse({ error: 'Failed to load availability' }, 502);
  }
}

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  if (req.method === 'GET') return handleAvailability(url);
  return jsonResponse({ error: 'Method not allowed' }, 405);
};

export const config = {
  path: '/api/accommodation-availability',
};
