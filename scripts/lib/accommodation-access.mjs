// Access-control lookup for the accommodation-calendar admin tool
// (netlify/functions/accommodation-admin.mts). Kept in its own module,
// separate from that Function, specifically so it can be swapped for a
// Supabase-backed lookup later without touching any caller. The parked idea
// from the 2026-08-31 admin-console design session was a shared
// `admin_access(email, tool, role, allowed_types)` table across all internal
// tools (photo-pool, WhatsApp, accommodation-calendar) - deferred on
// Sharath's explicit call ("I will pick this in a separate session later").
// getAccessRecord()'s return shape below is already that table's shape for
// one (email, tool) row, so migrating later is: create the table, backfill
// its rows from this Sheet, and rewrite loadAccessTable()/getAccessRecord()
// to a PostgREST query against it (accommodation-db.mjs already has the
// restFetch/callRpc pattern to copy) - accommodation-admin.mts's
// authenticate() and everything downstream of it never has to change.
//
// Source of truth today: the "Accommodation Calendar - Allowed Emails"
// Google Sheet (ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID), columns
// Email | Role | Allowed Types:
//   - role "admin" (or blank/unrecognized, so existing rows with only an
//     email keep working unchanged): full read/write on every booking type.
//   - role "restricted": read everything, write only the booking types
//     listed in Allowed Types (comma-separated BookingType values, e.g.
//     "casual-stay,public-event").
//   - role "viewer": read everything, no writes at all. Allowed Types is
//     ignored.
import { getSheetValues } from './google-drive.mjs';

export const ROLES = ['admin', 'restricted', 'viewer'];

const TTL_MS = 2 * 60 * 1000;
let cache = null; // { byEmail: Map<string, AccessRecord>, expiresAt }

function parseRow([, roleRaw, allowedTypesRaw]) {
  const role = ROLES.includes(roleRaw?.trim().toLowerCase()) ? roleRaw.trim().toLowerCase() : 'admin';
  const allowedTypes =
    role === 'restricted'
      ? String(allowedTypesRaw ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : null;
  return { role, allowedTypes };
}

async function loadAccessTable(sheetId) {
  const rows = await getSheetValues(sheetId, 'Sheet1!A:C');
  const byEmail = new Map();
  for (const row of rows.slice(1)) {
    // header row
    const email = row[0]?.trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, parseRow(row));
  }
  return byEmail;
}

// Returns null if the email isn't allow-listed at all (today's 403 case).
// Otherwise { role, allowedTypes }: allowedTypes is null for admin/viewer
// (role alone fully determines access) and a string[] of BookingType values
// for restricted.
export async function getAccessRecord(email) {
  const sheetId = process.env.ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID;
  if (!sheetId) throw new Error('Missing ACCOMMODATION_ALLOWED_EMAILS_SHEET_ID');
  if (!cache || cache.expiresAt <= Date.now()) {
    cache = { byEmail: await loadAccessTable(sheetId), expiresAt: Date.now() + TTL_MS };
  }
  return cache.byEmail.get(email.toLowerCase()) ?? null;
}
