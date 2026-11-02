// Where the raw statement files are kept: the same PRIVATE Cloudflare R2 bucket as contracts and land documents, under
// finance/imports/<batch uuid>.xlsx. Nothing is public and no link is ever handed out. The file is kept so a parser
// bug can be fixed and the file re-read, and as the evidence behind the lines.
import { r2Config } from './land-doc-storage';

const KEY = /^finance\/imports\/[0-9a-f-]{36}\.xlsx$/;
const urlFor = (base: string, key: string) => {
  if (!KEY.test(key)) throw new Error('Invalid storage key');
  return `${base}/${key}`;
};

export async function putFinanceImport(key: string, bytes: Uint8Array): Promise<void> {
  const { client, base } = r2Config();
  const res = await client.fetch(urlFor(base, key), {
    method: 'PUT',
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new Error(`R2 put failed: ${res.status}`);
}

export async function deleteFinanceImport(key: string): Promise<void> {
  const { client, base } = r2Config();
  const res = await client.fetch(urlFor(base, key), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: ${res.status}`);
}
