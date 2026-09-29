import type { Model } from '@latkit/model';
import type { ChannelBindings } from '@latkit/gpu';
import type { Channel } from './channels.js';
import type { Camera } from './controller.js';
import type { Options } from './options.js';
import type { Borders } from './borders/index.js';

/** A network's renderable state. Static buffers are owned; bound series are borrowed. */
export interface Scene {
  readonly kind: 'network';
  readonly topology: Model.Topology;
  readonly channels?: ChannelBindings<Channel>;
  readonly camera?: Camera | null;
  readonly viewport?: readonly [number, number];
  readonly options?: Omit<Options, 'devices' | 'colormap'>;
  readonly colormap?: Uint8Array;
  readonly borders?: Borders | null;
  readonly selected?: Model.Item | null;
  readonly orbit?: boolean;
  /** Frozen host uniforms: JavaScript shade callbacks are not part of a snapshot. */
  readonly shade?: { readonly wgsl: string; readonly uniforms: Float32Array };
}
