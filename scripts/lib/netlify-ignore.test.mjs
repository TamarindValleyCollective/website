// Run with: node --test scripts/lib/netlify-ignore.test.mjs
// The rule that lets Netlify skip a build for documentation-only changes, and the command that applies it. Files are invented
// except for the real folder names the rule has to get right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canSkipBuild, onlyDocsChanged } from './netlify-ignore.mjs';

test('documentation, the change log and root markdown can be skipped', () => {
  for (const f of ['CHANGELOG/2026-11.md', 'CHANGELOG.md', 'README.md', 'ARCHITECTURE.md', 'docs/finance/FINANCE.md', 'docs/design-language.md', 'docs/finance/mockups/dashboards.html', 'docs/adr/0001-example.md']) {
    assert.ok(canSkipBuild(f), f);
  }
});

test('anything the build reads is never skipped: site content markdown, the site-map data, code, config, public files', () => {
  for (const f of ['src/content/events/foraging-day.md', 'src/content/partners/x.md', 'docs/site-map/plan-plot-lines.json', 'docs/site-map/layout-frozen-2026-10-29.json', 'src/pages/index.astro', 'src/styles/global.css', 'scripts/lib/data-table.mjs', 'netlify/functions/finance-admin.mts', 'netlify.toml', 'package.json', 'package-lock.json', 'public/robots.txt', '.github/workflows/test.yml', 'supabase/migrations/0100_x.sql', 'DOCS/x.md', 'docsx/y.md']) {
    assert.equal(canSkipBuild(f), false, f);
  }
});

test('a change skips the build only when every file in it is documentation', () => {
  assert.equal(onlyDocsChanged(['CHANGELOG/2026-11.md']), true);
  assert.equal(onlyDocsChanged(['CHANGELOG/2026-11.md', 'docs/finance/FINANCE.md', 'ARCHITECTURE.md']), true);
  assert.equal(onlyDocsChanged(['CHANGELOG/2026-11.md', 'src/pages/index.astro']), false, 'one site file is enough to build');
  assert.equal(onlyDocsChanged(['docs/finance/FINANCE.md', 'docs/site-map/plot-outlines.json']), false);
  assert.equal(onlyDocsChanged([]), false, 'no changed files is a rebuild of the same commit: build');
});

// ---- the command itself, in a throwaway repository with the same folder names
const script = resolve('scripts/netlify-ignore-build.mjs');
const lib = resolve('scripts/lib/netlify-ignore.mjs');
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'netlify-ignore-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' } }).trim();
  git('init', '-q');
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
  writeFileSync(join(dir, 'scripts/netlify-ignore-build.mjs'), execFileSync('cat', [script], { encoding: 'utf8' }));
  writeFileSync(join(dir, 'scripts/lib/netlify-ignore.mjs'), execFileSync('cat', [lib], { encoding: 'utf8' }));
  const write = (file, text) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write('src/pages/index.astro', 'one');
  write('docs/finance/FINANCE.md', 'one');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  return { dir, git, write, head: () => git('rev-parse', 'HEAD') };
}
const run = (dir, env) => spawnSync('node', ['scripts/netlify-ignore-build.mjs'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('the command exits 0 (skip) for a docs-only commit and 1 (build) for a site change', () => {
  const r = repo();
  const deployed = r.head();
  r.write('docs/finance/FINANCE.md', 'two');
  r.write('CHANGELOG/2026-11.md', 'a line');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'docs');
  const docsOnly = run(r.dir, { CACHED_COMMIT_REF: deployed, COMMIT_REF: r.head() });
  assert.equal(docsOnly.status, 0, docsOnly.stdout);
  assert.match(docsOnly.stdout, /skipping/);
  r.write('src/pages/index.astro', 'two');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'site');
  const site = run(r.dir, { CACHED_COMMIT_REF: deployed, COMMIT_REF: r.head() });
  assert.equal(site.status, 1, 'docs and a site file together: the range since the last deploy includes the site file');
  assert.match(site.stdout, /can affect the site/);
});

test('the command builds whenever it cannot be sure: no previous deploy, an unknown commit, or no change at all', () => {
  const r = repo();
  r.write('docs/finance/FINANCE.md', 'two');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'docs');
  assert.equal(run(r.dir, { COMMIT_REF: r.head() }).status, 1, 'no CACHED_COMMIT_REF (the first build)');
  assert.equal(run(r.dir, { CACHED_COMMIT_REF: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', COMMIT_REF: r.head() }).status, 1, 'a commit that is not in this clone');
  assert.equal(run(r.dir, { CACHED_COMMIT_REF: r.head(), COMMIT_REF: r.head() }).status, 1, 'the same commit again (a rebuild, e.g. after an environment variable changed)');
});
