import type { Series } from '@latkit/model';
import type { Options } from './options.js';
/** A monitor's fixed appearance and borrowed series. */
export interface Scene {
  readonly kind: 'monitor';
  readonly series: Series;
  readonly signal: number;
  readonly options?: Omit<Options, 'devices' | 'colormap'>;
  readonly colormap?: Uint8Array;
  readonly selected?: number | null;
  readonly viewport?: readonly [number, number];
  /** Show the shared simulation playhead. Defaults to true. */
  readonly cursor?: boolean;
}
