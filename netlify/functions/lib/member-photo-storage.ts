// Where member story photos are kept: the same PRIVATE R2 bucket as the land documents, under
// member-photos/<person uuid>/<photo uuid>[-full].jpg. Nothing is public: the portal serves a photo
// only through members-me.mts / members-admin.mts, after checking who is asking
// (scripts/lib/member-photo.mjs, photoAccess). Keys are built from two uuids only.
import { r2Config } from './land-doc-storage';
import { photoKeys } from '../../../scripts/lib/member-photo.mjs';

export async function putMemberPhoto(personId: string, photoId: string, square: Uint8Array, full: Uint8Array): Promise<void> {
  const { client, base } = r2Config();
  const keys = photoKeys(personId, photoId);
  for (const [key, bytes] of [[keys.square, square], [keys.full, full]] as const) {
    const res = await client.fetch(`${base}/${key}`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: bytes });
    if (!res.ok) throw new Error(`R2 put failed: ${res.status}`);
  }
}

export async function getMemberPhoto(personId: string, photoId: string, size: 'square' | 'full'): Promise<Uint8Array | null> {
  const { client, base } = r2Config();
  const res = await client.fetch(`${base}/${photoKeys(personId, photoId)[size]}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Best effort: a failed delete only leaves an unreferenced file behind.
export async function deleteMemberPhoto(personId: string, photoId: string): Promise<void> {
  const { client, base } = r2Config();
  const keys = photoKeys(personId, photoId);
  for (const key of [keys.square, keys.full]) {
    const res = await client.fetch(`${base}/${key}`, { method: 'DELETE' }).catch(() => null);
    if (res && !res.ok && res.status !== 404) console.error('[member-photo-storage] delete failed', res.status);
  }
}
