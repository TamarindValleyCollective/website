// Admins' Google profile pictures (supabase/migrations/0059_staff_google_picture.sql).
//
// Both functions are best effort and never throw: if the column hasn't been applied yet, or Supabase hiccups,
// the admin portal carries on and just shows initials. That is deliberate, because these run beside the
// sign-in path and must never be able to break it (so `google_picture_url` is never added to the main
// staff_users selects, only read and written here, on their own).
import { pictureChange, safeGooglePicture, sizedPicture } from '../../../scripts/lib/member-google-picture.mjs';
import { rest } from './staff-mfa-store';

/** Records the picture seen on this person's token if it differs from the one kept (or clears it). */
export async function keepStaffPicture(staffId: string, seen: string | null): Promise<void> {
  try {
    const res = await rest(`/staff_users?id=eq.${staffId}&select=google_picture_url`);
    const stored = ((await res.json()) as { google_picture_url: string | null }[])[0]?.google_picture_url ?? null;
    const change = pictureChange({ stored, seen });
    if (!change.write) return;
    await rest(`/staff_users?id=eq.${staffId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ google_picture_url: change.value }),
    });
  } catch (err) {
    console.error('[staff-picture] could not keep the Google picture', err);
  }
}

/** staffId -> a 96px picture address, for the people who have one kept. Empty if none or unavailable. */
export async function loadStaffPictures(): Promise<Map<string, string>> {
  const pictures = new Map<string, string>();
  try {
    const res = await rest('/staff_users?select=id,google_picture_url&google_picture_url=not.is.null');
    for (const row of (await res.json()) as { id: string; google_picture_url: string }[]) {
      const url = sizedPicture(row.google_picture_url, 96);
      if (url) pictures.set(row.id, url);
    }
  } catch (err) {
    console.error('[staff-picture] could not read the Google pictures', err);
  }
  return pictures;
}

export { safeGooglePicture, sizedPicture };
