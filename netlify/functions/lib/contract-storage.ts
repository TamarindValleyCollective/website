// Where unit-rental contracts are kept: the same PRIVATE Cloudflare R2 bucket as the land documents (see
// land-doc-storage.ts), under keys of the form <household uuid>/<contract uuid>-(contract|signed).<ext>. Nothing is
// public. A member never gets a link: the server reads the file for them (their own contract only), and an admin opens
// a file through a presigned link that expires after 60 seconds (units-admin.mts, logged).
import { r2Config } from './land-doc-storage';
import { DOCUMENT_KEY } from '../../../scripts/lib/member-contract.mjs';

const urlFor = (base: string, key: string) => {
  if (!DOCUMENT_KEY.test(key)) throw new Error('Invalid storage key');
  return `${base}/contracts/${key}`;
};

export async function putContractDocument(key: string, bytes: Uint8Array, mime: string): Promise<void> {
  const { client, base } = r2Config();
  const res = await client.fetch(urlFor(base, key), { method: 'PUT', headers: { 'content-type': mime }, body: bytes as BodyInit });
  if (!res.ok) throw new Error(`R2 put failed: ${res.status}`);
}

export async function getContractDocument(key: string): Promise<Uint8Array | null> {
  const { client, base } = r2Config();
  const res = await client.fetch(urlFor(base, key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 get failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteContractDocument(key: string): Promise<void> {
  const { client, base } = r2Config();
  const res = await client.fetch(urlFor(base, key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: ${res.status}`);
}

export async function signedContractUrl(key: string, seconds = 60): Promise<string> {
  const { client, base } = r2Config();
  const url = new URL(urlFor(base, key));
  url.searchParams.set('X-Amz-Expires', String(seconds));
  const signed = await client.sign(url.toString(), { method: 'GET', aws: { signQuery: true } });
  return signed.url;
}
