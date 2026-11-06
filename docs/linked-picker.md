# Linked picker

One field for choosing a value that lives under other values: **Maintenance › 2026-27 › F-01 · H-10**, **Vendors › BSNL**. It replaces a long
drop-down, and any flat list is just the simplest case of it. Plain DOM, no framework, no dependencies, so any page's script can use it.

- Component: `scripts/lib/linked-picker.mjs` (`linkedPicker`). Styles: `src/styles/linked-picker.css` (import it in the page's frontmatter).
- Rules (navigation, search, paths), pure and tested: `scripts/lib/linked-picker-core.mjs`, `linked-picker-core.test.mjs`.
- A flat list: `combo()` in `scripts/lib/finance-ui.mjs` is a thin wrapper over it.
- The ledger's trees: `scripts/lib/finance-picker-nodes.mjs` (category > year > unit or project; party kind > party), tested.

## How it behaves

1. It looks like a text field. Focus or click opens a list of one level.
2. A row marked **⟹** goes down a level. The levels above stay on screen as header lines (click one to go back), and the next level is listed under them.
3. A row that ends the path closes the list, and the field shows the whole path (`Maintenance › 2026-27 › F-01 · H-10`).
4. **Typing searches only the rows being shown**, never deeper levels. A node can carry extra `search` words (the people living in a unit) so it is found without being named.
5. Keys: Up/Down move, Enter chooses or enters, Right enters, Left (or Backspace on an empty box) goes up, Escape closes, Tab closes.
6. The list opens beside the field outside any scrolling table (inside a `<dialog>` it stays in the dialog), flips above when there is no room below, and
   never scrolls the page.
7. Optional last row **Add …: "what you typed"** (`addNew`), which can be blocked at a level with a note (`blockedAt`), for lists that must not grow by typing.

## Using it

```js
import { linkedPicker } from '../../scripts/lib/linked-picker.mjs';

const field = linkedPicker({
  nodes: [
    { value: 'fuel', label: 'Fuel' },
    { value: 'maint', label: 'Maintenance', children: (path) => years.map((y) => ({ value: y, label: y, children: () => unitNodes })) },
  ],
  blank: 'Choose…',            // the "none" row and the empty field
  ariaLabel: 'Category',
  rootLabel: 'All categories',  // the top header line when browsing below the top
});
field.addEventListener('change', () => use(field.path)); // ['maint', '2026-27', 'unit-id']
field.path = ['fuel'];                                   // set from outside (does not fire change)
```

A **node** is `{ value, label, sub?, search?, group?, selectable?, children? }`.

| Field | Meaning |
|---|---|
| `value` | what is stored (a string) |
| `label` | what it is called |
| `sub` | small right-hand note ("F-01 · H-10", "the payer's unit") |
| `search` | extra words that find it without being its name |
| `group` | a heading shown when it changes between neighbouring rows |
| `children` | the next level: an array, or `(path) => array` built only when opened (long lists) |
| `selectable` | with `children`: it can also be picked as it is, as a row above "label ⟹" |
| `pickSub`, `enterLabel` | with `selectable`: the small note on the "pick as it is" row (e.g. "no project"), and the label of the "enter" row (e.g. "Equipment · choose a project"), so the two rows read differently |

Options: `path`, `blank`, `placeholder` (what an empty field says, e.g. a suggestion), `display` (`'path'` or `'leaf'`), `separator`, `matcher`,
`startAt: () => path | null` (where to open), `addNew: { label, depth, onAdd(typed, path), blockedAt(path) }`.
Methods: `.path`, `.value` (the last part), `.input`, `.setNodes(list)`, `.setPlaceholder(text)`, `.setBlank(text)`, `.setStartAt(fn)`, `.focus()`; a `change` event on choosing.

## Where the tree comes from

The component does not know where its tree comes from: it is handed one. Keep the link logic in a small builder next to the data, not in the page.
What the database already links (a party's kind, a member's unit through `household_id`, a unit's people through `member_household_members`, an allocation's
project) should be read from there. Links that are only a convention, such as "Maintenance leads to a year and a unit", belong in the builder until they are made data
(see FINANCE.md, "How a line is described"). Test the builder with invented data; the component's own rules are tested in `linked-picker-core.test.mjs`.

## Not done on purpose

Search does not look into deeper levels (decided 2026-11-06): it only filters the visible list. Multi-select is not supported.
