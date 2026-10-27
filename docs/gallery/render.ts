/**
 * Draws the documentation's gallery with latkit. Each piece's default export builds its datasets
 * with `Data` and returns its picture, or a promise of it: a scene, and how to look at it. The
 * `latkit` CLI draws each piece to
 * `docs/images/NAME.png`, from the datasets the scene's tables belong to, with no editing of the
 * picture afterwards.
 *
 *   cargo build --locked -p latkit-cli --profile cli
 *   cargo xtask wasm                  # builds the `latkit` package the pieces import
 *   node docs/gallery/render.ts [name...]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dataset, Table, load, type Camera, type Fit, type Scene, type Source } from 'latkit';
import { SIZE } from './look.ts';

/** What a piece returns: its scene, and how the view looks at it. */
export interface Picture {
  readonly scene: Scene;
  /** The camera. Without one, the view frames `fit`. */
  readonly camera?: Camera;
  /** What a view without a camera frames. Defaults to everything drawn. */
  readonly fit?: Fit;
  /** Elapsed seconds of effects, which sets where flowing comets are. */
  readonly elapsed?: number;
  /** The axis coordinate shown, at which sampled fields are read. */
  readonly at?: number;
  /** Picture size in pixels, if not `SIZE`. The hero is a wide banner. */
  readonly size?: readonly [number, number];
}

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

/** Pixels per CSS pixel. */
const SCALE = 2;

const root = fileURLToPath(new URL('../..', import.meta.url));
const work = path.join(root, 'target/gallery');
const cli = process.env.LATKIT_CLI ?? path.join(root, 'target/cli/latkit');
const fonts = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf'].map((f) =>
  path.join(root, 'docs/_static/fonts', f),
);

async function render(name: string): Promise<void> {
  const { default: draw } = (await import(`./${name}.ts`)) as {
    default: () => Picture | Promise<Picture>;
  };
  const picture = await draw();
  const file = (suffix: string) => path.join(work, `${name}.${suffix}`);
  // The datasets of the tables the scene names, collected as a view collects them.
  const datasets = new Set<Source>();
  const scene = JSON.stringify(
    picture.scene,
    function (this: Record<string, unknown>, key, value: unknown) {
      const held = this[key];
      if (held instanceof Table) datasets.add(held.source);
      return value;
    },
  );
  fs.writeFileSync(file('scene.json'), scene);
  const data = [...datasets].flatMap((dataset, i) => {
    if (!(dataset instanceof Dataset)) throw new Error(`${name}: the CLI draws no tiles`);
    fs.writeFileSync(file(`${i}.latk`), dataset.toBytes());
    dataset.destroy();
    return ['--data', file(`${i}.latk`)];
  });
  const output = path.join(root, 'docs/images', `${name}.png`);
  const args = [
    'render',
    file('scene.json'),
    ...data,
    '--output',
    output,
    '--size',
    (picture.size ?? SIZE).join('x'),
    '--scale',
    String(SCALE),
    ...fonts.flatMap((f) => ['--font', f]),
  ];
  if (picture.camera) {
    fs.writeFileSync(file('camera.json'), JSON.stringify(picture.camera));
    args.push('--camera', file('camera.json'));
  }
  if (picture.fit) args.push('--fit', JSON.stringify(picture.fit));
  if (picture.elapsed !== undefined) args.push('--elapsed', String(picture.elapsed));
  if (picture.at !== undefined) args.push('--at', String(picture.at));
  execFileSync(cli, args, { stdio: 'inherit', timeout: 180_000 });
  console.log(`${path.relative(root, output)}  ${(fs.statSync(output).size / 1024).toFixed(0)} KB`);
}

const only = process.argv.slice(2);
const unknown = only.filter((name) => !(PIECES as readonly string[]).includes(name));
if (unknown.length)
  throw new Error(`no piece ${unknown.join(', ')}; there are ${PIECES.join(', ')}`);
await load({
  wasm: new WebAssembly.Module(fs.readFileSync(new URL(import.meta.resolve('latkit/wasm')))),
});
fs.mkdirSync(work, { recursive: true });
for (const name of only.length ? only : PIECES) await render(name);
