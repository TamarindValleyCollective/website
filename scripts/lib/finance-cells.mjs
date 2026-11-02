// Reading spreadsheet cells for the finance importers. Excel gives the same value as text ("1,23,456.78",
// "05/03/2026") or as a number (123456.78, a date serial) depending on how the file was made, so both are handled.
// Money is integer paise, never a float; anything unreadable throws rather than being guessed.

// -> integer paise. Accepts a number or text with commas (Indian or Western grouping), an optional sign and an
// optional rupee marker.
export function parsePaise(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a valid amount: ${value}`);
    const paise = Math.round(value * 100);
    if (Math.abs(value * 100 - paise) > 1e-6) throw new Error(`Not a valid amount (more than two decimals): ${value}`);
    return paise;
  }
  if (typeof value !== 'string') throw new Error(`Not a valid amount: ${value === null || value === undefined ? 'empty' : String(value)}`);
  const text = value.replace(/₹|Rs\.?/gi, '').replace(/\s+/g, '');
  const m = text.match(/^([+-]?)(\d+|\d{1,3}(?:,\d{2,3})+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`Not a valid amount: "${value}"`);
  const rupees = Number(m[2].replace(/,/g, ''));
  const paise = rupees * 100 + (m[3] ? Number(m[3].padEnd(2, '0')) : 0);
  if (!Number.isSafeInteger(paise)) throw new Error(`Not a valid amount: "${value}"`);
  return m[1] === '-' ? -paise : paise;
}

const iso = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) throw new Error(`Not a valid date: ${y}-${m}-${d}`);
  return t.toISOString().slice(0, 10);
};

// Excel counts days from 1899-12-30 (this is right for every date after March 1900).
export function excelSerialToIso(serial) {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000).toISOString().slice(0, 10);
}

// -> 'YYYY-MM-DD' from dd/mm/yyyy text, ISO text, or an Excel date serial.
export function parseDateCell(value) {
  if (typeof value === 'number') {
    if (value < 25569 || value > 80000) throw new Error(`Not a valid date: ${value}`);
    return excelSerialToIso(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    let m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
    m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  throw new Error(`Not a valid date: ${value === null || value === undefined || value === '' ? 'empty' : `"${value}"`}`);
}

export const nextDay = (isoDate) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
