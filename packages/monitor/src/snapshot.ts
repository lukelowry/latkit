import type { GlyphSnapshot } from '@latkit/gpu';
import type { Series } from '@latkit/model';
import type { Options } from './options.js';
/** A monitor's fixed appearance and borrowed series. */
export interface Scene {
  readonly kind: 'monitor';
  readonly series: Series;
  readonly signal: number;
  readonly options?: Omit<Options, 'devices' | 'colormap'>;
  readonly colormap?: Uint8Array;
  /** Prepared SDF glyphs preserve the source font in an export worker. */
  readonly glyphs?: GlyphSnapshot;
  /** WGSL is preserved; JavaScript tick hooks are frozen at snapshot time. */
  readonly shade?: { readonly wgsl: string; readonly uniforms: Float32Array };
  readonly selected?: number | null;
  readonly viewport?: readonly [number, number];
  /** Show the shared simulation playhead. Defaults to true. */
  readonly cursor?: boolean;
}
