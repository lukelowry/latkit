/**
 * Settings and helpers shared by the gallery's pieces: picture size, theme, framing, and the
 * `Piece` type.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Camera, Fit, Patch, Scene } from 'latkit';

/** Picture size in pixels. Views lay out at half this size in CSS pixels and draw at `SCALE`. */
export const SIZE = [1600, 1000] as const;
export const SCALE = 2;

/** The theme of every piece: latkit's dark theme with a darker background and no label halos. */
export const THEME = {
  base: 'dark',
  background: '#0b0f14',
  text: { color: '#c3ccd6', font: 'sans-serif', size: 12, halo: 0 },
} as const;

/**
 * Fits a box into the picture, centered with a margin of at least 7% on each side. The box is a
 * drawing's `[minX, minY, maxX, maxY]`, with y up.
 */
export function framed([x0, y0, x1, y1]: readonly [number, number, number, number]): Fit {
  const aspect = SIZE[0] / SIZE[1];
  const room = 1 - 2 * 0.07;
  const height = Math.max((y1 - y0) / room, (x1 - x0) / (room * aspect));
  const width = height * aspect;
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  return {
    bounds: {
      min: [cx - width / 2, cy - height / 2, 0],
      max: [cx + width / 2, cy + height / 2, 0],
    },
  };
}

/** A dataset file the CLI reads directly, such as GeoJSON, loaded as the dataset `name`. */
export interface File {
  readonly name: string;
  readonly file: string;
}

/** One picture of the gallery: its datasets, its scene, and its view settings. */
export interface Piece {
  /** The picture's name. It is written to `docs/images/NAME.png`. */
  readonly name: string;
  /** The picture's alt text. */
  readonly alt: string;
  readonly data: readonly (Patch | File)[];
  readonly scene: Scene;
  /** Picture size in pixels, if not `SIZE`. The hero is a wide banner. */
  readonly size?: readonly [number, number];
  /** The camera. Without one, the view frames `fit`. */
  readonly camera?: Camera;
  /** What a view without a camera frames. Defaults to everything drawn. */
  readonly fit?: Fit;
  /** Elapsed seconds of effects, which sets where flowing comets are. */
  readonly elapsed?: number;
  /** The axis coordinate shown, at which sampled fields are read. */
  readonly at?: number;
}

/** `n` values of `f(i)`, as 32-bit floats. */
export function floats(n: number, f: (i: number) => number): Float32Array {
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = f(i);
  return values;
}

/** `n` row ids, `f(i)` for each row `i`, as a reference field's values. */
export function rows(n: number, f: (i: number) => number): Uint32Array {
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) ids[i] = f(i);
  return ids;
}

export const TAU = 2 * Math.PI;

/** Decompresses a map the example suite ships into `target/gallery` as GeoJSON for the CLI, and
 * returns its path. */
export function worldMap(name: string): string {
  const out = fileURLToPath(new URL(`../../target/gallery/${name}.geojson`, import.meta.url));
  const source = fileURLToPath(
    new URL(`../../npm/examples/public/maps/${name}.geojson.gz`, import.meta.url),
  );
  fs.writeFileSync(out, gunzipSync(fs.readFileSync(source)));
  return out;
}
