/**
 * The documentation's gallery, drawn by latkit. Each piece writes its datasets with `Patch`, as
 * latkit's bytes, and its scene as a typed `Scene`; the `latkit` command line draws it into
 * `docs/images/NAME.png`, with nothing done to the picture after.
 *
 *   cargo build --locked -p latkit-cli --profile cli
 *   cargo xtask wasm                  # the package `latkit/core` comes from
 *   node docs/gallery/render.ts [name...]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCALE, SIZE, type Piece } from './look.ts';

/** Every piece, in the gallery's order. */
export const PIECES = [
  'opening',
  'grid',
  'texas',
  'frequency',
  'globe',
  'diagram',
  'helios',
  'torus',
  'terrain',
  'clifford',
  'bloom',
  'currents',
  'tides',
] as const;

const root = fileURLToPath(new URL('../..', import.meta.url));
const work = path.join(root, 'target/gallery');
const cli = process.env.LATKIT_CLI ?? path.join(root, 'target/cli/latkit');
const fonts = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf'].map((f) =>
  path.join(root, 'docs/_static/fonts', f),
);

async function render(name: string): Promise<void> {
  const { default: make } = (await import(`./${name}.ts`)) as { default: () => Piece };
  const piece = make();
  const file = (suffix: string) => path.join(work, `${piece.name}.${suffix}`);
  fs.writeFileSync(file('scene.json'), JSON.stringify(piece.scene));
  const data = piece.data.flatMap((d, i) => {
    if ('file' in d) return ['--data', `${d.name}=${d.file}`];
    fs.writeFileSync(file(`${i}.bin`), d.toBytes());
    return ['--data', file(`${i}.bin`)];
  });
  const output = path.join(root, 'docs/images', `${piece.name}.png`);
  const args = [
    'render',
    file('scene.json'),
    ...data,
    '--output',
    output,
    '--size',
    (piece.size ?? SIZE).join('x'),
    '--scale',
    String(SCALE),
    ...fonts.flatMap((f) => ['--font', f]),
  ];
  if (piece.camera) {
    fs.writeFileSync(file('camera.json'), JSON.stringify(piece.camera));
    args.push('--camera', file('camera.json'));
  }
  if (piece.fit) args.push('--fit', JSON.stringify(piece.fit));
  if (piece.elapsed !== undefined) args.push('--elapsed', String(piece.elapsed));
  if (piece.at !== undefined) args.push('--at', String(piece.at));
  execFileSync(cli, args, { stdio: 'inherit', timeout: 180_000 });
  console.log(`${path.relative(root, output)}  ${(fs.statSync(output).size / 1024).toFixed(0)} KB`);
}

const only = process.argv.slice(2);
const unknown = only.filter((name) => !(PIECES as readonly string[]).includes(name));
if (unknown.length)
  throw new Error(`no piece ${unknown.join(', ')}; there are ${PIECES.join(', ')}`);
fs.mkdirSync(work, { recursive: true });
for (const name of only.length ? only : PIECES) await render(name);
