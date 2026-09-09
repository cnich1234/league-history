/**
 * Fails if any prerendered page is actually Next's error page.
 *
 * `next build` exits 0 and prints a normal route table even when a page throws
 * during prerender -- it just writes an error document instead. That shipped a
 * broken build to production once: Next 16 made `params` a Promise, every
 * dynamic route threw, and /owner/[slug] and /writeups/[slug] became 404s while
 * the build reported success.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'out';
const bad = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith('.html')) {
      if (readFileSync(full, 'utf8').includes('__next_error__')) bad.push(full);
    }
  }
}

walk(ROOT);

if (bad.length) {
  console.error(`\n${bad.length} page(s) prerendered as an error page:\n`);
  for (const f of bad) console.error(`  ${f}`);
  console.error('\nThe build "succeeded" but these pages are broken. Do not deploy.\n');
  process.exit(1);
}

console.log('Build verified: no error pages.');
