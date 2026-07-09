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

function normalizeLinkTarget(target, file) {
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

  const referenceAbsolute = path.resolve(referenceRoot, pathname);
  if (!existsSync(referenceAbsolute)) return normalized;

  const relative = toPosixPath(path.relative(path.dirname(file), referenceAbsolute));
  return `${relative || path.basename(referenceAbsolute)}${hash}`;
}

function normalizeLinkTargets(markdown, file) {
  return markdown.replace(/\]\(([^)\n]+)\)/g, (match, target) => {
    const normalized = normalizeLinkTarget(target, file);
    return normalized === target ? match : `](${normalized})`;
  });
}

for await (const file of markdownFiles(referenceRoot)) {
  const before = await readFile(file, 'utf8');
  const after = normalizeLinkTargets(before, file);
  if (after !== before) await writeFile(file, after);
}
