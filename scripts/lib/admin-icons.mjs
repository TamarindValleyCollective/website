// Action icons for the admin pages' buttons, in the same stroke style as the sidebar's (src/lib/staff-icons.ts): 24x24, drawn with
// currentColor. An icon-only button is for a familiar, repeated action (change, columns); a primary or consequential action keeps its
// words (docs/design-language.md, "Icon buttons"). Every one carries an accessible name and a tooltip, because the icon alone is not enough.
//
//   iconButton({ name: 'edit', label: 'Change Fuel', tip: 'Change', onClick })
//
// Built with the DOM (createElementNS), never as HTML.
const SVG = 'http://www.w3.org/2000/svg';

// [tag, attributes] pieces of each icon.
export const ICONS = {
  // a pencil: change this
  edit: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z' }]],
  // a chevron pointing down: this opens a menu
  chevron: [['path', { d: 'M7 10l5 5 5-5' }]],
  // three columns in a frame: choose the table's columns
  columns: [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }], ['path', { d: 'M9 3v18M15 3v18' }]],
};

/**
 * @param {string} name
 * @param {number} [size]
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/**
 * `label` is what a screen reader says (be specific: "Change Fuel"); `tip` is the short tooltip (defaults to the label).
 * @param {{ name: string, label: string, tip?: string, onClick?: ((e: MouseEvent) => void) | null, cls?: string, attrs?: Record<string, string> }} options
 * @returns {HTMLButtonElement}
 */
export function iconButton({ name, label, tip = label, onClick = null, cls = '', attrs = {} }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `icon-btn${cls ? ` ${cls}` : ''}`;
  b.setAttribute('aria-label', label);
  b.title = tip;
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  b.append(icon(name));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
