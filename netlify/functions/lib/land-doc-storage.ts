// Where uploaded land documents are kept: a PRIVATE Cloudflare R2 bucket, reached over its
// S3-compatible API with a token that can only touch that bucket. Everything that stores,
// reads, links or deletes a file goes through this module, so the store can be swapped
// without touching the callers. The object key (member_land_documents.storage_path) is the
// only thing the database holds about a file.
//
// Nothing is ever public: the bucket has no public access or custom domain, and staff open a
// file through a presigned link that expires after 60 seconds (members-admin.mts, logged).
//
// Env (Netlify): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
import { AwsClient } from 'aws4fetch';

function config() {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = process.env;
  if (!account || !accessKeyId || !secretAccessKey || !bucket) throw new Error('Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY or R2_BUCKET');
  return { client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }), base: `https://${account}.r2.cloudflarestorage.com/${bucket}` };
}

// Keys are `<household uuid>/<document uuid>.<ext>`; refuse anything else so a bad value can
// never address another path in the bucket.
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}(-shape)?\.(pdf|jpg|png)$/;
const urlFor = (base: string, key: string) => {
  if (!KEY.test(key)) throw new Error('Invalid storage key');
  return `${base}/${key}`;
};

export async function putLandDocument(key: string, bytes: Uint8Array, mime: string): Promise<void> {
  const { client, base } = config();
  const res = await client.fetch(urlFor(base, key), { method: 'PUT', headers: { 'content-type': mime }, body: bytes });
  if (!res.ok) throw new Error(`R2 put failed: ${res.status}`);
}

export async function getLandDocument(key: string): Promise<Uint8Array | null> {
  const { client, base } = config();
  const res = await client.fetch(urlFor(base, key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteLandDocument(key: string): Promise<void> {
  const { client, base } = config();
  const res = await client.fetch(urlFor(base, key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: ${res.status}`);
}

// A link that works for `seconds` and only for GET on this one object.
export async function signedLandDocumentUrl(key: string, seconds = 60): Promise<string> {
  const { client, base } = config();
  const url = new URL(urlFor(base, key));
  url.searchParams.set('X-Amz-Expires', String(seconds));
  const signed = await client.sign(url.toString(), { method: 'GET', aws: { signQuery: true } });
  return signed.url;
}

// The parcel outline taken from a single-survey document's field sketch sits beside the file:
// "<household>/<document>.pdf" -> "<household>/<document>-shape.png".
export const landShapeKey = (storagePath: string): string => storagePath.replace(/\.pdf$/, '-shape.png');

// The outlines of these documents as data URLs, for the ones that have one. `extracted.hasShape`
// is set by the background reader when it stored one. A missing or unreadable file is skipped.
export async function loadLandShapes(docs: { id: string; storage_path: string; extracted: any }[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    docs
      .filter((d) => d.extracted?.hasShape === true)
      .map(async (d) => {
        try {
          const bytes = await getLandDocument(landShapeKey(d.storage_path));
          if (bytes) out[d.id] = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
        } catch (err) {
          console.error('[land-doc-storage] could not load a shape', err);
        }
      }),
  );
  return out;
}
