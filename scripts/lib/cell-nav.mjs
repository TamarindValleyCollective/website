// Keyboard movement between the cells of an admin table, the same on the shared tables (data-table-ui.mjs) and the Ledger (finance/ledger.astro).
// The table has ONE Tab stop, its cursor cell (a "roving tabindex"); the arrow keys move the cursor, the Menu key or Shift+F10 opens the cell's menu
// (filter to / out of its value, group by its column; scripts/lib/admin-menu.mjs), and Enter does what clicking the cell does. Pure and I/O-free so the
// movement is tested directly (cell-nav.test.mjs); the pages do the focusing.

export const PAGE = 10;

/**
 * Where a key takes the cursor. `pos` is { row, col }: a row index and a column id. `shape` is { rows, cols }: how many rows there are and the ids of the columns
 * showing, left to right. Returns the new position (the same one at an edge), or null when the key is not a movement key or there is nowhere to go.
 * A column no longer showing counts as the first, a row past the end as the last.
 *
 * @param {{ row: number, col: string }} pos
 * @param {string} key
 * @param {{ ctrl?: boolean }} options
 * @param {{ rows: number, cols: string[] }} shape
 * @returns {{ row: number, col: string } | null}
 */
export function moveCursor(pos, key, { ctrl = false } = {}, { rows, cols }) {
  if (!rows || !cols.length) return null;
  const c = Math.max(0, cols.indexOf(pos.col));
  const r = Math.min(Math.max(pos.row, 0), rows - 1);
  const at = (row, col) => ({ row, col: cols[col] });
  switch (key) {
    case 'ArrowLeft': return at(r, Math.max(c - 1, 0));
    case 'ArrowRight': return at(r, Math.min(c + 1, cols.length - 1));
    case 'ArrowUp': return at(Math.max(r - 1, 0), c);
    case 'ArrowDown': return at(Math.min(r + 1, rows - 1), c);
    case 'PageUp': return at(Math.max(r - PAGE, 0), c);
    case 'PageDown': return at(Math.min(r + PAGE, rows - 1), c);
    case 'Home': return ctrl ? at(0, 0) : at(r, 0);
    case 'End': return ctrl ? at(rows - 1, cols.length - 1) : at(r, cols.length - 1);
    default: return null;
  }
}

/**
 * The Menu key, or Shift+F10: what a keyboard sends for a right-click.
 * @param {{ key: string, shiftKey?: boolean }} e
 */
export const isMenuKey = (e) => e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');

/**
 * What a screen reader is told when the cursor cell takes focus. `opens` says what Enter does there, when it does anything.
 * @param {string} [opens]
 */
export const cellHintText = (opens = '') => `Arrow keys move between cells. Menu key or Shift+F10 opens filter and group options for this cell.${opens ? ` Enter ${opens}.` : ''}`;
