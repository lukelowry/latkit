import type { Document } from '@latkit/model';
import type { ChannelBindings, GlyphSnapshot } from '@latkit/gpu';
import type { Camera } from './controller.js';
import type { Channel } from './channels.js';
import type { Options } from './options.js';

/** A portable diagram view. Static data is owned; series are borrowed. */
export interface Scene {
  readonly kind: 'diagram';
  readonly netlist: Document.Netlist;
  readonly channels?: ChannelBindings<Channel>;
  readonly options?: Omit<Options, 'devices' | 'colormap'>;
  readonly colormap?: Uint8Array;
  readonly camera?: Camera | null;
  readonly viewport?: readonly [number, number];
  readonly selected?: readonly Document.Part[];
  readonly glyphs?: GlyphSnapshot;
  /** WGSL is preserved; JavaScript tick hooks are frozen at snapshot time. */
  readonly shade?: { readonly wgsl: string; readonly uniforms: Float32Array };
}
