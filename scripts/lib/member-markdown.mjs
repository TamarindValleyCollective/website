// The small piece of Markdown a member can use in "What you do today" and "Family": **bold**,
// *italic*, [words](https://address) links, and line breaks (a blank line starts a new paragraph).
// Nothing else is Markdown here: no headings, lists, images or HTML, so "<" is just a character.
//
// Pure, so the editor, the directory, the admin queue, the public export and the public Members page
// all read a story the same way. The parser makes a small tree; callers turn it into DOM nodes or HTML
// themselves (renderBlocks), so there is one place that decides what a link is.

export const MAX_LINKS = 10;
const URL_MAX = 300;
const WORDCH = /[\p{L}\p{N}]/u;

// What a member pastes into the address box -> an https address, or a plain-language error.
// A missing "https://" is added for them: nobody should have to type a scheme.
/** @param {unknown} input @returns {{ ok: true, url: string } | { ok: false, error: string }} */
export function normalizeUrl(input) {
  let s = typeof input === 'string' ? input.trim() : '';
  /** @type {{ ok: false, error: string }} */
  const bad = { ok: false, error: 'That does not look like a web address. Copy it from your browser\'s address bar.' };
  if (!s) return { ok: false, error: 'Paste the web address first.' };
  if (/\s/.test(s)) return { ok: false, error: 'A web address has no spaces. Paste just the address.' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^https?:\/\//i.test(s)) return { ok: false, error: 'Use a web address that starts with https://' };
  if (!/^https?:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let url;
  try {
    url = new URL(s);
  } catch {
    return bad;
  }
  if (!url.hostname.includes('.') || url.username || url.password) return bad;
  // Brackets and parentheses would end a Markdown link early, so they are written as %-codes.
  const href = url.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\[/g, '%5B').replace(/\]/g, '%5D');
  if (href.length > URL_MAX) return { ok: false, error: 'That address is too long.' };
  return { ok: true, url: href };
}

// An address that may be rendered as a link: explicit http(s), a real host, not too long.
function hrefOf(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw) || raw.length > URL_MAX) return '';
  try {
    const u = new URL(raw);
    return u.hostname.includes('.') && !u.username && !u.password ? u.href : '';
  } catch {
    return '';
  }
}

// The index of the closing `marker` at or after `from`, or -1. The text between must not be empty and
// must not start or end with a space (so a stray "*" in "3 * 4" stays a "*").
function closer(s, from, marker) {
  let j = from;
  for (;;) {
    j = s.indexOf(marker, j);
    if (j < 0) return -1;
    if (s[j - 1] === '\\') { j += 1; continue; }
    const inner = s.slice(from, j);
    if (!inner || /^\s/.test(inner) || /\s$/.test(inner)) { j += 1; continue; }
    return j;
  }
}

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

function inline(s, inLink) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', s: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && /[\\*_[\]()]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === '[' && !inLink) {
      const m = LINK.exec(s.slice(i));
      const href = m ? hrefOf(m[2]) : '';
      if (m && href) { flush(); out.push({ t: 'a', href, c: inline(m[1], true) }); i += m[0].length; continue; }
    }
    if (ch === '*' && s[i + 1] === '*') {
      const j = closer(s, i + 2, '**');
      if (j > 0) { flush(); out.push({ t: 'strong', c: inline(s.slice(i + 2, j), inLink) }); i = j + 2; continue; }
    }
    if ((ch === '*' && s[i + 1] !== '*') || (ch === '_' && (i === 0 || !WORDCH.test(s[i - 1])))) {
      const j = closer(s, i + 1, ch);
      if (j > 0 && (ch === '*' || !WORDCH.test(s[j + 1] ?? ''))) { flush(); out.push({ t: 'em', c: inline(s.slice(i + 1, j), inLink) }); i = j + 1; continue; }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// The text as paragraphs of inline nodes: { t: 'text', s } | { t: 'br' } | { t: 'strong' | 'em', c } | { t: 'a', href, c }.
export function parseMarkdown(src) {
  const text = typeof src === 'string' ? src.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return [];
  return text.split(/\n{2,}/).map((para) => {
    const out = [];
    para.split('\n').forEach((line, i) => {
      if (i > 0) out.push({ t: 'br' });
      out.push(...inline(line, false));
    });
    return out;
  });
}

// Turns the tree into whatever the caller builds (DOM nodes, an HTML string). `r` supplies
// text(s, inLink), strong(kids), em(kids), a(href, kids) and br(); each returns one item, and
// `join(items)` combines a paragraph's items. Paragraphs are returned as an array.
/** @param {string} src @param {{ text: (s: string, inLink: boolean) => any, strong: (k: any[]) => any, em: (k: any[]) => any, a: (href: string, k: any[]) => any, br: () => any }} r @returns {any[][]} */
export function renderBlocks(src, r) {
  const go = (nodes, inLink) => nodes.map((n) => (n.t === 'text' ? r.text(n.s, inLink) : n.t === 'br' ? r.br() : n.t === 'strong' ? r.strong(go(n.c, inLink)) : n.t === 'em' ? r.em(go(n.c, inLink)) : r.a(n.href, go(n.c, true))));
  return parseMarkdown(src).map((p) => go(p, false));
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An HTML string for the text. `textHtml(piece, inLink)` renders a plain piece of text (default: escaped), so a caller
// can still bold names inside it (and knows not to nest a link in a link); `linkClass` is put on every link. Paragraphs are separated by a blank line.
/** @param {string} src @param {{ textHtml?: (s: string, inLink: boolean) => string, linkClass?: string }} [opts] @returns {string} */
export function toHtml(src, { textHtml = esc, linkClass = '' } = {}) {
  const paras = renderBlocks(src, {
    text: textHtml,
    strong: (k) => `<strong>${k.join('')}</strong>`,
    em: (k) => `<em>${k.join('')}</em>`,
    a: (href, k) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow"${linkClass ? ` class="${linkClass}"` : ''}>${k.join('')}</a>`,
    br: () => '<br>',
  });
  return paras.map((p) => p.join('')).join('<br><br>');
}

// The words without the marks, on one line: for card snippets, search and the writing check's length.
export function toPlain(src) {
  const flat = (nodes) => nodes.map((n) => (n.t === 'text' ? n.s : n.t === 'br' ? ' ' : flat(n.c))).join('');
  return parseMarkdown(src).map(flat).join(' ').replace(/\s+/g, ' ').trim();
}

// Every link in the text, as { label, href }, for the admin queue and for counting.
export function linksIn(src) {
  const out = [];
  const walk = (nodes) => nodes.forEach((n) => {
    if (n.t === 'a') out.push({ label: n.c.map((c) => (c.t === 'text' ? c.s : '')).join(''), href: n.href });
    else if (n.c) walk(n.c);
  });
  parseMarkdown(src).forEach(walk);
  return out;
}

// The link written in `value` that covers the selection [from, to], so the editor can offer to change or
// remove it when the cursor is inside one. { start, end, label, url } or null.
export function linkAt(value, from, to = from) {
  const re = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
  for (const m of value.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    if (from >= start && to <= end && hrefOf(m[2])) return { start, end, label: m[1], url: m[2] };
  }
  return null;
}

// Wraps the selection in `mark` (for ** and *), or takes the mark off if it is already there. Returns
// { value, from, to } with the selection kept on the same words.
export function toggleMark(value, from, to, mark) {
  const n = mark.length;
  if (value.slice(from - n, from) === mark && value.slice(to, to + n) === mark) {
    return { value: value.slice(0, from - n) + value.slice(from, to) + value.slice(to + n), from: from - n, to: to - n };
  }
  const sel = value.slice(from, to);
  return { value: value.slice(0, from) + mark + sel + mark + value.slice(to), from: from + n, to: to + n };
}

// Writes [label](url) over the selection, or over the whole link when editing one.
export function setLink(value, from, to, url) {
  const existing = linkAt(value, from, to);
  const start = existing ? existing.start : from;
  const end = existing ? existing.end : to;
  const label = existing ? existing.label : value.slice(from, to).replace(/[[\]]/g, '');
  const md = `[${label}](${url})`;
  return { value: value.slice(0, start) + md + value.slice(end), from: start, to: start + md.length };
}

// Takes the link off, keeping its words.
export function removeLink(value, from, to) {
  const existing = linkAt(value, from, to);
  if (!existing) return { value, from, to };
  return { value: value.slice(0, existing.start) + existing.label + value.slice(existing.end), from: existing.start, to: existing.start + existing.label.length };
}

/**
 * A person's profile link written into the text, on their first name where it first appears (the bio, then the family
 * text), so it can be seen, changed or removed like any other link in the story and no separate field is needed. A mention
 * that is already a link is skipped. Returns { bio, family, social }, with `social` cleared once the link has been written
 * in; if the name is not in the text, or the address cannot be used, nothing changes and the old link stays.
 * @param {{ bio: string, family: string, social: string }} draft
 * @param {string} firstName
 */
export function foldProfileLink(draft, firstName) {
  const url = draft.social.trim();
  if (!url) return draft;
  const href = normalizeUrl(url);
  if (!href.ok) return draft;
  const name = new RegExp(`(?<![\\p{L}\\p{N}_])${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu');
  for (const field of ['bio', 'family']) {
    const text = draft[field];
    for (const m of text.matchAll(name)) {
      if (linkAt(text, m.index, m.index + m[0].length)) continue;
      return { ...draft, [field]: `${text.slice(0, m.index)}[${m[0]}](${href.url})${text.slice(m.index + m[0].length)}`, social: '' };
    }
  }
  return draft;
}
