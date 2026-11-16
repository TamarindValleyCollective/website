// SPIKE (not for merge): the Rules table as a React island on Material React Table, to see what a batteries-included grid costs here.
// Invented data only. Column order, visibility, sorting and density persist in localStorage, which is the point of the spike.
import { useEffect, useMemo, useState } from 'react';
import { MaterialReactTable, useMaterialReactTable, type MRT_ColumnDef, type MRT_ColumnOrderState, type MRT_VisibilityState, type MRT_SortingState } from 'material-react-table';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import Chip from '@mui/material/Chip';

type Rule = { id: string; priority: number; when: string; category: string; party: string; wording: string; used: number; active: boolean; review: boolean };

const RULES: Rule[] = [
  { id: 'r1', priority: 10, when: 'Narration contains "gas agency"', category: 'Running costs', party: 'Sample Gas Agency', wording: 'Cooking gas refill', used: 24, active: true, review: false },
  { id: 'r2', priority: 20, when: 'Narration contains "bank charges"', category: 'Bank charges', party: '', wording: 'Bank charges', used: 61, active: true, review: false },
  { id: 'r3', priority: 30, when: 'UPI remark has "petrol", debit', category: 'Reimbursements', party: 'Farm manager', wording: 'Petrol purchase', used: 38, active: true, review: true },
  { id: 'r4', priority: 40, when: 'Credit from 4,000 to 6,000', category: 'Member contributions', party: '', wording: 'Monthly maintenance', used: 102, active: true, review: false },
  { id: 'r5', priority: 50, when: 'Narration contains "electricity"', category: 'Running costs', party: 'Sample Power Board', wording: 'Electricity bill', used: 12, active: true, review: false },
  { id: 'r6', priority: 60, when: 'UPI remark has "labour"', category: 'Wages', party: '', wording: 'Day labour', used: 77, active: false, review: true },
  { id: 'r7', priority: 70, when: 'Narration contains "nursery"', category: 'Plants and seeds', party: 'Sample Nursery', wording: '', used: 9, active: true, review: false },
];

const KEY = 'tvc-spike-rules-grid';
const ALL = ['priority', 'when', 'category', 'party', 'wording', 'used', 'state', 'mrt-row-actions'];
const read = <T,>(name: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(`${KEY}:${name}`);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

// The TVC tokens, as CSS variables, so the grid follows global.css instead of MUI's own blue.
const theme = createTheme({
  palette: { primary: { main: '#3d6e52' }, text: { primary: '#22291f', secondary: '#57604f' }, divider: '#e2ddc9' },
  typography: { fontFamily: 'Inter, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif', fontSize: 14 },
  shape: { borderRadius: 6 },
});

export default function RulesGrid() {
  // Read the saved layout after mount so the first render is always the default.
  const [ready, setReady] = useState(false);
  const [columnOrder, setColumnOrder] = useState<MRT_ColumnOrderState>(ALL);
  const [columnVisibility, setColumnVisibility] = useState<MRT_VisibilityState>({});
  const [sorting, setSorting] = useState<MRT_SortingState>([{ id: 'priority', desc: false }]);
  useEffect(() => {
    setColumnOrder(read('order', ALL));
    setColumnVisibility(read('visibility', {}));
    setSorting(read('sorting', [{ id: 'priority', desc: false }]));
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(`${KEY}:order`, JSON.stringify(columnOrder));
      localStorage.setItem(`${KEY}:visibility`, JSON.stringify(columnVisibility));
      localStorage.setItem(`${KEY}:sorting`, JSON.stringify(sorting));
    } catch {
      /* blocked storage: the layout just does not persist */
    }
  }, [ready, columnOrder, columnVisibility, sorting]);

  const columns = useMemo<MRT_ColumnDef<Rule>[]>(
    () => [
      { accessorKey: 'priority', header: 'Priority', size: 90 },
      { accessorKey: 'when', header: 'When', size: 260 },
      { accessorKey: 'category', header: 'Suggest category' },
      { accessorKey: 'party', header: 'For party' },
      { accessorKey: 'wording', header: 'What it was for', Cell: ({ cell }) => cell.getValue<string>() || <em>From the UPI remark</em> },
      { accessorKey: 'used', header: 'Used', size: 80 },
      {
        id: 'state',
        header: 'State',
        accessorFn: (r) => (r.active ? 'On' : 'Off'),
        Cell: ({ row }) => (
          <>
            <Chip size="small" label={row.original.active ? 'On' : 'Off'} color={row.original.active ? 'primary' : 'default'} />
            {row.original.review ? <Chip size="small" label="Always reviewed" sx={{ ml: 0.5 }} /> : null}
          </>
        ),
      },
    ],
    [],
  );

  const table = useMaterialReactTable({
    columns,
    data: RULES,
    enableColumnOrdering: true,
    enableHiding: true,
    enableColumnPinning: true,
    enableGrouping: true,
    enableDensityToggle: true,
    enablePagination: false,
    enableRowActions: true,
    renderRowActions: () => (
      <button type="button" className="button button--outline button--small">
        Change
      </button>
    ),
    positionActionsColumn: 'last',
    displayColumnDefOptions: { 'mrt-row-actions': { header: 'Actions' } },
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    state: { columnOrder, columnVisibility, sorting },
    initialState: { density: 'compact' },
    muiTablePaperProps: { elevation: 0, sx: { border: '1px solid #e2ddc9' } },
  });

  return (
    <ThemeProvider theme={theme}>
      <MaterialReactTable table={table} />
    </ThemeProvider>
  );
}
