// Netlify's `ignore` command (netlify.toml, [build]): exit 0 SKIPS the build, any other exit builds. A production deploy costs
// 15 Netlify credits, so a merge that only touches documentation or the change log should not make one.
//
// It compares the commit being built with the last commit Netlify deployed (CACHED_COMMIT_REF) and skips only when every changed
// file is documentation (scripts/lib/netlify-ignore.mjs holds the rule). If anything is missing or goes wrong (no previous deploy,
// a commit Netlify did not fetch, git failing) it exits 1 and the build runs: skipping is the exception, never the fallback.
import { execFileSync } from 'node:child_process';
import { onlyDocsChanged } from './lib/netlify-ignore.mjs';

const from = process.env.CACHED_COMMIT_REF;
const to = process.env.COMMIT_REF || 'HEAD';
const build = (why) => {
  console.log(`[ignore-build] building: ${why}`);
  process.exit(1);
};

if (!from) build('no previous deploy to compare with');
try {
  const out = execFileSync('git', ['diff', '--name-only', '-z', from, to], { encoding: 'utf8' });
  const files = out.split('\0').filter(Boolean);
  if (onlyDocsChanged(files)) {
    console.log(`[ignore-build] skipping: only documentation changed (${files.length} ${files.length === 1 ? 'file' : 'files'}), nothing in the site can differ`);
    process.exit(0);
  }
  build(files.length ? `${files.filter((f) => !onlyDocsChanged([f])).length} of ${files.length} changed files can affect the site` : 'no changed files (a rebuild of the same commit)');
} catch (err) {
  build(`could not compare the commits (${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'})`);
}
