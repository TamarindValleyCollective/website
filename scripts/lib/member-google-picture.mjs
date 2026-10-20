// The profile picture Google shows for a member's account, shown on their card in the staff member register.
//
// It arrives in the Google sign-in token (`picture`) and is kept on member_people.google_picture_url, refreshed
// each time the member signs in (so removing it from their Google account removes it here too). It is only ever
// kept for someone who has accepted a privacy notice that says so, and only ever sent to core-team staff who may
// see names (never to other members, and not at all to a read-only role). Pure: the Functions call these.

const HOSTS = [/\.googleusercontent\.com$/i, /\.ggpht\.com$/i];
const MAX_LENGTH = 500;

/** The address if it is an https picture from Google's own image hosts, otherwise null. */
export function safeGooglePicture(value) {
  if (typeof value !== 'string' || value.length > MAX_LENGTH) return null;
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !HOSTS.some((h) => h.test(u.hostname))) return null;
  return u.href;
}

/** The same picture at a given size in pixels (Google serves `=s96-c` style sizes), or null. */
export function sizedPicture(value, px) {
  const url = safeGooglePicture(value);
  if (!url) return null;
  return /=s\d+(-c)?$/.test(url) ? url.replace(/=s\d+(-c)?$/, `=s${px}-c`) : `${url}=s${px}-c`;
}

/**
 * Whether to write the picture seen at sign-in: only once the member has accepted a notice that covers it
 * (`acceptedVersion` is the version they last accepted, `requiredVersion` the one that mentions it), and only
 * if it differs from what is stored (a missing picture clears the stored one).
 */
export function pictureUpdate({ stored, seen, acceptedVersion, requiredVersion }) {
  if (!(Number.isInteger(acceptedVersion) && acceptedVersion >= requiredVersion)) return { write: false };
  const next = safeGooglePicture(seen);
  const current = safeGooglePicture(stored);
  return next === current ? { write: false } : { write: true, value: next };
}
