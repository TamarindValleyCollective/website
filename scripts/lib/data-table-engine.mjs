// The engine of TVC's admin data table: one TanStack table-core instance per table, so the table's state (sorting, column filters,
// and from here on column order, visibility and pinning) lives in the same model the Ledger uses. The ledger's own column syntax
// (finance-columns.mjs, via data-table.mjs) is plugged in as the filter and sort functions; nothing here touches the DOM, so it is
// tested directly (data-table-engine.test.mjs). data-table-ui.mjs is the DOM around it.
//
//   const engine = createTableEngine({ columns, filters, searchText });
//   const { rows, errors } = engine.run({ rows, chips, words, cols, sort: [columnId | null, 1 | -1] });
//   engine.setLayout({ order, hidden });   which columns show and in what order; engine.visibleColumnIds() says what to draw
//
// `columns` and `filters` are the page's own descriptions (see data-table-ui.mjs). Chip filters are not tied to one column, so they
// narrow the rows before the table sees them; everything else is TanStack's own filtering and sorting.
import { createTable, getCoreRowModel, getFilteredRowModel, getSortedRowModel } from '@tanstack/table-core';
import { cleanLayout, matchColumn, parseColumnFilter, passesWords } from './data-table.mjs';

const empty = (v) => v == null || v === '';

// Sorts numbers as numbers and anything else as lower-cased text. Empty cells never reach it: they are `undefined`, which
// `sortUndefined: 'last'` puts at the end whichever way the column is sorted.
const compareCells = (rowA, rowB, id) => {
  const x = rowA.getValue(id);
  const y = rowB.getValue(id);
  return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).toLowerCase().localeCompare(String(y).toLowerCase());
};

export function createTableEngine({ columns, filters = [], searchText = () => '' }) {
  const defs = columns.map((c) => {
    const type = c.type ?? 'text';
    const sortGet = c.sortValue ?? c.value;
    const filterGet = c.filterValue ?? c.value;
    return {
      id: c.id,
      header: c.label ?? c.id,
      accessorFn: (row) => {
        const v = sortGet(row);
        return empty(v) ? undefined : v;
      },
      enableSorting: c.sortable !== false,
      enableHiding: !c.fixed,
      enableColumnFilter: c.filter !== 'none' && type !== 'none',
      sortUndefined: 'last',
      sortingFn: compareCells,
      // The filter value is the parsed condition, so a row costs one match, not one parse.
      filterFn: (row, _id, cond) => matchColumn(type, cond, filterGet(row.original)),
    };
  });

  const table = createTable({
    data: [],
    columns: defs,
    state: {},
    onStateChange: () => {},
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getColumnCanGlobalFilter: () => true,
    globalFilterFn: (row, _id, words) => passesWords(searchText(row.original), words),
    enableMultiSort: false,
    enableSortingRemoval: true,
  });

  const ids = columns.map((c) => c.id);
  const fixed = columns.filter((c) => c.fixed).map((c) => c.id);
  let state = { ...table.initialState };
  let current = [];
  const apply = (data) => {
    current = data;
    table.setOptions((prev) => ({
      ...prev,
      data,
      state,
      onStateChange: (updater) => {
        state = typeof updater === 'function' ? updater(state) : updater;
      },
    }));
  };

  apply([]);
  const allColumnIds = () => table.getAllLeafColumns().map((c) => c.id);

  return {
    /** The rows that pass, in order, and `errors`: column id -> why a typed condition could not be read (that column is then left unfiltered). */
    run({ rows, chips = [], words = [], cols = {}, sort = [null, 1] }) {
      // Chips of one `group` (BHIM and Paytm, say) are alternatives: a row passes if it passes any of them. Different groups all have to pass.
      const byGroup = new Map();
      for (const id of chips) {
        const f = filters.find((x) => x.id === id);
        if (f) byGroup.set(f.group ?? f.id, [...(byGroup.get(f.group ?? f.id) ?? []), f.test]);
      }
      const tests = [...byGroup.values()].map((list) => (r) => list.some((t) => t(r)));
      const data = tests.length ? rows.filter((r) => tests.every((t) => t(r))) : rows;

      const errors = {};
      const columnFilters = [];
      for (const c of columns) {
        const typed = cols[c.id];
        if (!typed || c.filter === 'none') continue;
        const cond = parseColumnFilter(c.type ?? 'text', typed);
        if (cond?.error) errors[c.id] = cond.error;
        else if (cond) columnFilters.push({ id: c.id, value: cond });
      }
      state = {
        ...state,
        columnFilters,
        globalFilter: words.length ? words : undefined,
        sorting: sort[0] ? [{ id: sort[0], desc: sort[1] < 0 }] : [],
      };
      apply(data);
      return { rows: table.getRowModel().rows.map((r) => r.original), errors };
    },
    /** Which columns show and in what order. Anything unknown is dropped, new columns follow, a `fixed` column stays shown and in place; no layout is the default. */
    setLayout(raw) {
      const clean = cleanLayout(raw, ids, fixed);
      state = { ...state, columnOrder: clean.order, columnVisibility: Object.fromEntries(clean.hidden.map((id) => [id, false])) };
      apply(current);
    },
    layout: () => ({ order: allColumnIds(), hidden: table.getAllLeafColumns().filter((c) => !c.getIsVisible()).map((c) => c.id) }),
    visibleColumnIds: () => table.getVisibleLeafColumns().map((c) => c.id),
    allColumnIds,
    defaultOrder: ids,
    fixedIds: fixed,
    table,
  };
}
