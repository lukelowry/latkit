import type { RGBA } from '../colors/color.js';
/** Font identity includes a revision for an application replacing a loaded font face. */
export interface TextFont {
  readonly family: string;
  readonly weight?: number;
  readonly style?: 'normal' | 'italic' | 'oblique';
  readonly revision?: string;
}
export interface TextInput {
  readonly text: string;
  readonly font?: TextFont;
  readonly direction?: 'ltr' | 'rtl';
}
/** Metrics in em units. Positions use a left-origin, alphabetic baseline, y down. */
export interface TextMetrics {
  readonly advance: number;
  readonly ascent: number;
  readonly descent: number;
}
export interface TextRun extends TextInput {
  readonly position: readonly [number, number];
  readonly size: number;
  /** sRGB-encoded straight RGBA. The shader returns premultiplied color. */
  readonly color?: RGBA;
  /** Renderer-local anchor identifier; a shader may use it to apply a dynamic transform. */
  readonly anchor?: number;
}
export interface TextRequest {
  /** Immutable identity caches geometry. Moving a view/anchor does not rebuild text. */
  readonly runs: readonly TextRun[];
}
export interface TextPage {
  readonly bindGroup: GPUBindGroup;
  readonly count: number;
}
/** Rasterizers preserve shaping within each whole, single-line run. Coverage is monochrome. */
export interface TextRasterizer {
  rasterize(
    input: TextInput,
    options: {
      readonly pixelsPerEm: number;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly signal: AbortSignal;
    },
  ): Promise<TextBitmap>;
}
export interface TextBitmap extends TextMetrics {
  readonly width: number;
  readonly height: number;
  readonly coverage: Uint8Array;
  /** Upper-left ink position, in em units, relative to the run baseline. */
  readonly left: number;
  readonly top: number;
}

export interface TextOptions {
  readonly rasterizer?: TextRasterizer;
  readonly atlasSize?: number;
}
