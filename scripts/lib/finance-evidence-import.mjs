// Loading the old transfer sheet's payment screenshots as evidence against payee accounts, once
// (docs/finance/FINANCE.md, "Evidence"; scripts/import-fin-evidence.mjs does the reading and writing). Pure and I/O-free
// (finance-evidence-import.test.mjs). Nothing from the real sheet is kept in this repository.
//
// The pictures are NOT in the cell values: they are floating pictures anchored over cells, which only the .xlsx export carries
// (xl/media/*, placed by xl/drawings/drawingN.xml). A picture belongs to the sheet row it is anchored on. The row names the payee's
// account number, which is matched to a saved account by the same keyed fingerprint the payee import uses, so a picture lands on the
// exact account it paid, never on a name guess.
import { createHash } from 'node:crypto';
import { sniffVoucher } from './finance-requests.mjs';

const text = (bytes) => new TextDecoder().decode(bytes);
const attr = (xml, name) => new RegExp(`${name}="([^"]*)"`).exec(xml)?.[1] ?? null;
// Relationship id -> target, for a .rels file (attribute order is not fixed).
function relsOf(bytes) {
  const out = new Map();
  for (const m of text(bytes).matchAll(/<Relationship\b[^>]*\/?>/g)) out.set(attr(m[0], 'Id'), attr(m[0], 'Target'));
  return out;
}
// "../drawings/drawing1.xml" relative to "xl/worksheets/sheet1.xml" -> "xl/drawings/drawing1.xml"
function resolveTarget(from, target) {
  const parts = from.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * `files` is the unzipped workbook ({ path: Uint8Array }). Returns the pictures anchored on the named sheet:
 * [{ row (1-based, as in the sheet), col (0-based), bytes }], or null when there is no such sheet.
 */
export function readPictures(files, sheetName) {
  const get = (path) => files[path] ?? null;
  const workbook = get('xl/workbook.xml');
  const workbookRels = get('xl/_rels/workbook.xml.rels');
  if (!workbook || !workbookRels) return null;
  const sheet = [...text(workbook).matchAll(/<sheet\b[^>]*\/?>/g)].map((m) => m[0]).find((tag) => attr(tag, 'name') === sheetName);
  if (!sheet) return null;
  const sheetPath = resolveTarget('xl/workbook.xml', relsOf(workbookRels).get(attr(sheet, 'r:id')) ?? '');
  const sheetRels = get(sheetPath.replace(/([^/]+)$/, '_rels/$1.rels'));
  if (!sheetRels) return [];
  const drawingTarget = [...relsOf(sheetRels).values()].find((t) => /drawings\/drawing\d+\.xml$/.test(t ?? ''));
  if (!drawingTarget) return [];
  const drawingPath = resolveTarget(sheetPath, drawingTarget);
  const drawing = get(drawingPath);
  const drawingRels = get(drawingPath.replace(/([^/]+)$/, '_rels/$1.rels'));
  if (!drawing || !drawingRels) return [];
  const rels = relsOf(drawingRels);
  const pictures = [];
  for (const m of text(drawing).matchAll(/<xdr:(oneCellAnchor|twoCellAnchor|absoluteAnchor)\b[\s\S]*?<\/xdr:\1>/g)) {
    const anchor = m[0];
    const from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(anchor)?.[1];
    const embed = /<a:blip\b[^>]*\br:embed="([^"]+)"/.exec(anchor)?.[1];
    if (!from || !embed) continue;
    const row = Number(/<xdr:row>(\d+)<\/xdr:row>/.exec(from)?.[1]);
    const col = Number(/<xdr:col>(\d+)<\/xdr:col>/.exec(from)?.[1]);
    const bytes = get(resolveTarget(drawingPath, rels.get(embed) ?? ''));
    if (Number.isInteger(row) && Number.isInteger(col) && bytes) pictures.push({ row: row + 1, col, bytes });
  }
  return pictures;
}

/**
 * The id a picture is stored under, taken from its content: the same screenshot is therefore the same object however many times
 * the import runs (re-running adds nothing), and the object key and the file row share it. Looks like a uuid.
 */
export function evidenceId(bytes) {
  const h = createHash('sha256').update(bytes).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// The numbers a sheet's account cell may stand for: as typed, and with the leading zero an 8-digit old account was given by the
// payee import (finance-party-import.mjs pads those to nine). Anything shorter than eight digits cannot be a bank account.
export function accountCandidates(digits) {
  if (!/^[0-9]{8,18}$/.test(digits)) return [];
  return /^[0-9]{8}$/.test(digits) ? [digits, `0${digits}`] : [digits];
}

/**
 * `records`: parseTransferTab(...).records ({ line, account }) - only completed transfers, so a failed one never contributes.
 * `pictures`: readPictures(...). `byFingerprint(candidate)` -> the ids of the SAVED, still usable accounts with that number
 * (superseded and retired ones are left out by the caller). `existingIds`: evidence ids already stored.
 * Returns { items, skipped }: items = [{ id, accountId, line, mime, ext, bytes }] in sheet order, skipped = counts by reason.
 */
export function planEvidence({ records, pictures, byFingerprint, existingIds = new Set() }) {
  const skipped = { notOnATransferRow: 0, notAnImage: 0, noUsableAccountNumber: 0, noSavedAccount: 0, ambiguousAccount: 0, alreadyStored: 0, sameImageAgain: 0 };
  const rowOf = new Map(records.map((r) => [r.line, r]));
  const seen = new Set();
  const items = [];
  for (const picture of [...pictures].sort((a, b) => a.row - b.row || a.col - b.col)) {
    const record = rowOf.get(picture.row);
    if (!record) { skipped.notOnATransferRow += 1; continue; }
    const sniffed = sniffVoucher(picture.bytes);
    if (!sniffed) { skipped.notAnImage += 1; continue; }
    const candidates = accountCandidates(record.account ?? '');
    if (!candidates.length) { skipped.noUsableAccountNumber += 1; continue; }
    const found = [...new Set(candidates.flatMap((c) => byFingerprint(c)))];
    if (!found.length) { skipped.noSavedAccount += 1; continue; }
    if (found.length > 1) { skipped.ambiguousAccount += 1; continue; }
    const id = evidenceId(picture.bytes);
    if (existingIds.has(id)) { skipped.alreadyStored += 1; continue; }
    if (seen.has(id)) { skipped.sameImageAgain += 1; continue; }
    seen.add(id);
    items.push({ id, accountId: found[0], line: record.line, mime: sniffed.mime, ext: sniffed.ext, bytes: picture.bytes });
  }
  return { items, skipped };
}
