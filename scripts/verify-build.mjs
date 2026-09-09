/**
 * Fails if any prerendered page is actually Next's error page.
 *
 * `next build` exits 0 and prints a normal route table even when a page throws
 * during prerender -- it just writes an error document instead. That shipped a
 * broken build to production once: Next 16 made `params` a Promise, every
 * dynamic route threw, and /owner/[slug] and /writeups/[slug] became 404s while
 * the build reported success.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Static export wrote to out/; a server build prerenders into
// .next/server/app. Check whichever exists so dropping `output: 'export'`
// does not silently turn this verification off.
const ROOT = existsSync('out') ? 'out' : join('.next', 'server', 'app');
const bad = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    // Next ships its own error documents (_error, _global-error, 404, 500).
    // Those are SUPPOSED to carry the marker; flagging them would make this
    // check cry wolf and get ignored, which defeats the point.
    else if (entry.endsWith('.html') && !/^_?(global-error|error|404|500)\.html$/.test(entry)) {
      if (readFileSync(full, 'utf8').includes('__next_error__')) bad.push(full);
    }
  }
}

if (!existsSync(ROOT)) {
  console.error(`No build output at ${ROOT}. Run \`next build\` first.`);
  process.exit(1);
}
walk(ROOT);

if (bad.length) {
  console.error(`\n${bad.length} page(s) prerendered as an error page:\n`);
  for (const f of bad) console.error(`  ${f}`);
  console.error('\nThe build "succeeded" but these pages are broken. Do not deploy.\n');
  process.exit(1);
}

console.log('Build verified: no error pages.');
