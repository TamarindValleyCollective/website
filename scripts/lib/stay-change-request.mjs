// Turns a proposed change to a stay into short lines an admin can read before approving it: what the booking says now
// against what the request would make it. Pure, so the Stays page and its tests share one definition.
import { checkOutDate } from './stay-notice.mjs';

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
const names = (tents) => tents.flatMap((t) => t.guests ?? []);
const key = (g) => g.personId || (g.name ?? '').trim().toLowerCase();

/**
 * @param {any} current the booking as it is (type, label, note, startDate, nights, tents with guests)
 * @param {any} proposed the requested booking, the same fields
 * @param {Map<string, string>} labels unit id -> display name
 * @returns {string[]} one line per difference; empty when nothing a person would see changes
 */
export function describeChange(current, proposed, labels = new Map()) {
  const lines = [];
  const unit = (id) => labels.get(id) ?? id;

  if (current.startDate !== proposed.startDate || current.nights !== proposed.nights) {
    const span = (b) => `${b.startDate} to ${checkOutDate(b.startDate, b.nights)} (${plural(b.nights, 'night')})`;
    lines.push(`Dates: ${span(current)} → ${span(proposed)}`);
  }

  const before = [...new Set(current.tents.map((t) => unit(t.tentId)))].sort();
  const after = [...new Set((proposed.tents ?? []).map((t) => unit(t.tentId)))].sort();
  if (before.join('|') !== after.join('|')) lines.push(`Tent: ${before.join(', ') || 'none'} → ${after.join(', ') || 'none'}`);

  const was = new Map(names(current.tents).map((g) => [key(g), g]));
  const now = new Map(names(proposed.tents ?? []).map((g) => [key(g), g]));
  const added = [...now].filter(([k]) => !was.has(k)).map(([, g]) => g.name);
  const removed = [...was].filter(([k]) => !now.has(k)).map(([, g]) => g.name);
  if (added.length) lines.push(`Guests added: ${added.join(', ')}`);
  if (removed.length) lines.push(`Guests removed: ${removed.join(', ')}`);
  for (const [k, g] of now) {
    const old = was.get(k);
    if (!old) continue;
    if ((old.name ?? '') !== (g.name ?? '')) lines.push(`Guest renamed: ${old.name} → ${g.name}`);
    if ((old.ageGroup ?? '') !== (g.ageGroup ?? '')) lines.push(`${g.name}: age group ${old.ageGroup || 'none'} → ${g.ageGroup || 'none'}`);
    // Preferences can be withheld from the person reading, so only compare them when both sides carry the field.
    if ('preferences' in old && 'preferences' in g && (old.preferences ?? '') !== (g.preferences ?? '')) {
      lines.push(`${g.name}: food needs "${old.preferences ?? ''}" → "${g.preferences ?? ''}"`);
    }
  }

  if ((current.label ?? '') !== (proposed.label ?? '')) lines.push(`Label: "${current.label ?? ''}" → "${proposed.label ?? ''}"`);
  if ((current.note ?? '') !== (proposed.note ?? '')) lines.push(`Note: "${current.note ?? ''}" → "${proposed.note ?? ''}"`);
  if (current.type !== proposed.type) lines.push(`Type: ${current.type} → ${proposed.type}`);
  return lines;
}
