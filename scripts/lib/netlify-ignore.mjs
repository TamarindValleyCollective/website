// Which changes cannot affect the built site, so Netlify can skip the build (and the 15 credits a production deploy costs).
// scripts/netlify-ignore-build.mjs is the command `netlify.toml` runs; this is its rule, kept pure so it is tested
// (netlify-ignore.test.mjs). The rule is an ALLOWLIST: a change skips the build only if every changed file is one of the
// kinds below. Anything else, anything unexpected, and an empty or unreadable change list all build.
//
// What is deliberately NOT here, because the build reads it:
//   * src/content/**/*.md   the site's own content (events, partners, photos...) is markdown inside src/
//   * docs/site-map/**      src/lib/staff-demo.ts imports these JSON files, so they end up in the bundle
//   * anything else under src/, public/, netlify/, scripts/, package files, netlify.toml, .github/...

/** Root-level markdown (README.md, ARCHITECTURE.md, CHANGELOG.md, the *.md notes): no slash in the path. */
const isRootMarkdown = (file) => !file.includes('/') && file.endsWith('.md');

/** The docs that are only documentation. docs/site-map is excluded: the build imports it. */
const isPlainDocs = (file) => file.startsWith('docs/') && !file.startsWith('docs/site-map/');

/** The monthly change log files. */
const isChangeLog = (file) => file.startsWith('CHANGELOG/');

export const canSkipBuild = (file) => isRootMarkdown(file) || isChangeLog(file) || isPlainDocs(file);

/**
 * `files`: the paths changed since the last deploy. -> true only when there is at least one and every one of them is a kind that
 * cannot change the site. An empty list builds: that is a rebuild of the same commit (an environment variable was changed, say).
 */
export function onlyDocsChanged(files) {
  return files.length > 0 && files.every(canSkipBuild);
}
