// Run with: node --test scripts/lib/admin-primitives.test.mjs
//
// The admin shell (src/layouts/StaffLayout.astro) owns the card surface, the line under a page title, small
// notes, error text, the page's vertical rhythm, text-style buttons, visually hidden labels and the button
// modifiers. Pages use them and do not redefine them. This is what keeps nine pages from drifting back into
// nine dialects (seven of them had copied `.card` and `.section.wrapper` before this).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const pagesDir = new URL('../../src/pages/internal/', import.meta.url);
const shell = readFileSync(new URL('../../src/layouts/StaffLayout.astro', import.meta.url), 'utf8');
const pages = readdirSync(pagesDir).filter((f) => f.endsWith('.astro'));

const SHARED = ['.card', '.hint', '.note', '.error', '.section.wrapper', '[hidden]', '.visually-hidden', '.link-button', '.button--primary', '.button--danger', '.button--danger-outline', '.button--small', '.field', '.segmented', '.list', '.row', '.pill', '.sheet', '.toast', '.crit-row', '.button--icon', '.inline-form', '.stack-form'];

// A page may add to a shared rule; this lists the only ones that do, and what they may set.
const ADDITIONS = {
  'WhatsAppInbox.astro': { '.card': ['padding', 'overflow'] },
  'members.astro': { '.link-button': ['padding'] },
  'usage.astro': { '.link-button': ['padding'] },
};

// Members and Usage write global styles under their own root class (`.members .card`); read those as the plain selector.
const ROOT_PREFIX = /^(#staff-main )?\.(members|usage) /;

function topLevelRules(source) {
  const style = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const rules = [];
  for (const m of style.matchAll(/^ {2}(\S[^{\n]*?) \{\n((?: {4}[^\n]*\n|\n)*?) {2}\}$/gm)) {
    const props = [...m[2].matchAll(/^ {4}([a-z-]+):/gm)].map((p) => p[1]);
    rules.push({ selector: m[1].trim().replace(ROOT_PREFIX, ''), props });
  }
  return rules;
}

// The search field, segmented control and grouped list are shared with the member portal, so they live in
// styles/portal-look.css (plain `main .x` rules) rather than in the admin shell.
const IN_PORTAL_LOOK = ['.field', '.segmented', '.list', '.row'];
const portalLook = readFileSync(new URL('../../src/styles/portal-look.css', import.meta.url), 'utf8');

test('the shell defines every shared primitive', () => {
  for (const sel of SHARED) {
    const escaped = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (IN_PORTAL_LOOK.includes(sel)) assert.match(portalLook, new RegExp(`^main ${escaped}[ ,{:]`, 'm'), `portal-look.css has no rule for ${sel}`);
    else assert.match(shell, new RegExp(`main :global\\(${escaped}\\)`), `StaffLayout.astro has no rule for ${sel}`);
  }
});

// The WhatsApp inbox is a component shared by several screens, so it is held to the same rule as a page.
const components = [['WhatsAppInbox.astro', new URL('../../src/components/whatsapp/WhatsAppInbox.astro', import.meta.url)]];

test('no page redefines a shared primitive', () => {
  for (const [page, url] of [...pages.map((f) => [f, new URL(f, pagesDir)]), ...components]) {
    const allowed = ADDITIONS[page] ?? {};
    for (const rule of topLevelRules(readFileSync(url, 'utf8'))) {
      if (!SHARED.includes(rule.selector)) continue;
      const extra = allowed[rule.selector];
      assert.ok(extra && rule.props.every((p) => extra.includes(p)), `${page} redefines ${rule.selector} (${rule.props.join(', ')}); it lives in StaffLayout.astro`);
    }
  }
});
