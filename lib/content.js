import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'content', 'writeups');

/**
 * Writeups are markdown files committed to the repo, named
 * <type>-week-<n>.md or draft-recap.md. There is no CMS and no database --
 * the site is a static export, so content ships with the build.
 */
function parse(filename) {
  const raw = readFileSync(join(DIR, filename), 'utf8');
  const draft = /^draft-recap\.md$/.test(filename);
  const m = /^(preview|recap)-week-(\d+)\.md$/.exec(filename);
  if (!draft && !m) return null;

  // The first H1 is the title; everything after it is the body.
  const lines = raw.split(/\r?\n/);
  const h1 = lines.findIndex((l) => l.startsWith('# '));
  const title = h1 >= 0 ? lines[h1].slice(2).trim() : filename;
  const body = (h1 >= 0 ? lines.slice(h1 + 1) : lines).join('\n').trim();

  return {
    slug: filename.replace(/\.md$/, ''),
    type: draft ? 'draft' : m[1],
    week: draft ? 0 : Number(m[2]),
    title,
    body,
    wordCount: body.split(/\s+/).filter(Boolean).length,
  };
}

export function getWriteups() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.md'))
    .map(parse)
    .filter(Boolean)
    // Newest first: highest week, and within a week the recap follows the preview.
    .sort((a, b) => b.week - a.week || (a.type === 'recap' ? -1 : 1));
}

export function getWriteup(slug) {
  return getWriteups().find((w) => w.slug === slug) ?? null;
}
