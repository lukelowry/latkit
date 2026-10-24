/**
 * What every piece of the gallery shares: its frame, its ground and type, and what a piece is.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Camera, Fit, Patch, Scene } from 'latkit';

/** Pixels written. Views lay out half as many CSS pixels, drawn twice as sharp. */
export const SIZE = [1600, 1000] as const;
export const SCALE = 2;

/** Every piece's ground and type: latkit's dark theme, a deeper ground, no label halos. */
export const THEME = {
  base: 'dark',
  background: '#0b0f14',
  text: { color: '#c3ccd6', font: 'sans-serif', size: 12, halo: 0 },
} as const;

/**
 * A fit of `box`, a drawing's least and greatest x and y with y up, into the picture: centered,
 * with an even margin around.
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

/** A dataset as a file the CLI reads as it is: GeoJSON names its dataset. */
export interface File {
  readonly name: string;
  readonly file: string;
}

/** One picture of the gallery: its datasets, its scene, and how the view looks at it. */
export interface Piece {
  /** The picture's name: `docs/images/NAME.png`. */
  readonly name: string;
  /** What it shows, for its alt text. */
  readonly alt: string;
  readonly data: readonly (Patch | File)[];
  readonly scene: Scene;
  /** Pixels written, when not `SIZE`: the hero is a banner. */
  readonly size?: readonly [number, number];
  /** The camera; without one the view frames everything drawn. */
  readonly camera?: Camera;
  /** What a view without a camera frames: everything drawn unless set. */
  readonly fit?: Fit;
  /** Seconds of effects shown: where flowing comets are. */
  readonly elapsed?: number;
  /** The axis coordinate shown, where sampled fields are read. */
  readonly at?: number;
}

/** `n` values of `f(i)`, as 32-bit floats. */
export function floats(n: number, f: (i: number) => number): Float32Array {
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) values[i] = f(i);
  return values;
}

/** Row ids `0..n` named by a function of the row, for a reference field. */
export function rows(n: number, f: (i: number) => number): Uint32Array {
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) ids[i] = f(i);
  return ids;
}

export const TAU = 2 * Math.PI;

/** A map the example suite ships, inflated to `target/gallery` for the CLI to read as GeoJSON. */
export function worldMap(name: string): string {
  const out = fileURLToPath(new URL(`../../target/gallery/${name}.geojson`, import.meta.url));
  const source = fileURLToPath(
    new URL(`../../npm/examples/public/maps/${name}.geojson.gz`, import.meta.url),
  );
  fs.writeFileSync(out, gunzipSync(fs.readFileSync(source)));
  return out;
}
