import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const referenceRoot = path.resolve('docs/api/reference');

async function* markdownFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* markdownFiles(fullPath);
    else if (entry.isFile() && entry.name.endsWith('.md')) yield fullPath;
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

/** MyST registers headings up to this depth as link targets (`myst_heading_anchors` in conf.py). */
const HEADING_ANCHOR_DEPTH = 3;

/** The slug MyST assigns a heading: lowercase, punctuation dropped, spaces to hyphens. */
function headingSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const headingCache = new Map();

/** The heading anchors a reference page exposes to cross-page links. */
async function headingAnchors(file) {
  let anchors = headingCache.get(file);
  if (!anchors) {
    anchors = new Set();
    const pattern = new RegExp(`^#{1,${HEADING_ANCHOR_DEPTH}}\\s+(.+?)\\s*#*$`, 'gm');
    for (const match of (await readFile(file, 'utf8')).matchAll(pattern)) {
      anchors.add(headingSlug(match[1].replace(/[`*_]/g, '')));
    }
    headingCache.set(file, anchors);
  }
  return anchors;
}

async function normalizeLinkTarget(target, file) {
  if (
    target.startsWith('#') ||
    target.startsWith('http:') ||
    target.startsWith('https:') ||
    target.startsWith('mailto:')
  ) {
    return target;
  }

  const normalized = target.replaceAll('\\', '/');
  const hashIndex = normalized.indexOf('#');
  const pathname = hashIndex >= 0 ? normalized.slice(0, hashIndex) : normalized;
  const hash = hashIndex >= 0 ? normalized.slice(hashIndex) : '';
  if (!pathname.endsWith('.md')) return normalized;

  const candidates = [
    path.resolve(path.dirname(file), pathname),
    path.resolve(referenceRoot, pathname),
  ];
  const referenceAbsolute = candidates.find(
    (candidate) => candidate.startsWith(referenceRoot) && existsSync(candidate),
  );
  if (!referenceAbsolute) return normalized;

  // TypeDoc anchors table rows with raw `<a id>` tags, which MyST does not resolve across
  // pages. Keep a fragment only when the target page has a heading for it; otherwise link
  // to the page.
  const fragment = hash && (await headingAnchors(referenceAbsolute)).has(hash.slice(1)) ? hash : '';
  const relative = toPosixPath(path.relative(path.dirname(file), referenceAbsolute));
  return `${relative || path.basename(referenceAbsolute)}${fragment}`;
}

async function normalizeLinkTargets(markdown, file) {
  const links = [...markdown.matchAll(/\]\(([^)\n]+)\)/g)];
  const targets = await Promise.all(links.map((link) => normalizeLinkTarget(link[1], file)));
  let index = 0;
  return markdown.replace(/\]\(([^)\n]+)\)/g, (match, target) => {
    const normalized = targets[index++];
    return normalized === target ? match : `](${normalized})`;
  });
}

for await (const file of markdownFiles(referenceRoot)) {
  const before = await readFile(file, 'utf8');
  const after = await normalizeLinkTargets(before, file);
  if (after !== before) await writeFile(file, after);
}
