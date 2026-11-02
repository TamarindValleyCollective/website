// A small reader for .xlsx workbooks, server-side only (the finance importers). An .xlsx is a zip of XML parts; this
// reads the sheet list, the shared strings and the cells' values, and nothing else (no styles, formulas or
// formatting). It exists instead of a spreadsheet library because the two files we read are plain single-purpose
// tables, and the popular library on npm is unmaintained there with known advisories. fflate does the unzipping.
//
// Cell values come back as a string, a number, a boolean or null. A date stored as a real Excel date arrives as its
// serial number: the importers decide what a column means (see finance-cells.mjs).
import { unzipSync, strFromU8 } from 'fflate';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

const decode = (s) =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};

// Joined text of every <t> in a fragment (a rich-text string has several runs).
const textOf = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');

// "AB12" -> zero-based column 27
const columnIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function sharedStrings(files) {
  const part = files['xl/sharedStrings.xml'];
  if (!part) return [];
  return [...strFromU8(part).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

function parseSheet(xml, strings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rowMatch[1], 'r')) || rows.length + 1;
    const row = [];
    let next = 0;
    for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      const type = attr(c[1], 't');
      const inner = c[2] ?? '';
      const v = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
      let value = null;
      if (type === 'inlineStr') value = textOf(inner);
      else if (v) {
        const raw = decode(v[1]);
        if (type === 's') value = strings[Number(raw)] ?? null;
        else if (type === 'str' || type === 'e') value = raw;
        else if (type === 'b') value = raw === '1';
        else value = raw === '' ? null : Number(raw);
      }
      row[col] = value;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows[rowNumber - 1] = row;
  }
  // Fill holes so a missing cell is null, not undefined, and index lookups are stable.
  return rows.map((r) => Array.from({ length: r.length }, (_, i) => r[i] ?? null));
}

// -> [{ name, rows: (string|number|boolean|null)[][] }] in workbook order.
export function readWorkbook(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 4 || ZIP_MAGIC.some((b, i) => u8[i] !== b)) throw new Error('This is not an Excel (.xlsx) file.');
  let files;
  try {
    files = unzipSync(u8);
  } catch {
    throw new Error('This is not an Excel (.xlsx) file.');
  }
  const book = files['xl/workbook.xml'];
  if (!book) throw new Error('This is not an Excel (.xlsx) file.');
  const rels = new Map();
  for (const m of strFromU8(files['xl/_rels/workbook.xml.rels'] ?? new Uint8Array()).matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    rels.set(attr(m[1], 'Id'), attr(m[1], 'Target'));
  }
  const strings = sharedStrings(files);
  const out = [];
  for (const m of strFromU8(book).matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const target = rels.get(attr(m[1], 'r:id') ?? attr(m[1], 'id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const part = files[path];
    if (!part) continue;
    out.push({ name: attr(m[1], 'name') ?? '', rows: parseSheet(strFromU8(part), strings) });
  }
  return out;
}
