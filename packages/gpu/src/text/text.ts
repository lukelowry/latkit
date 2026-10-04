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
/** Text to lay out in the units of `size`, as a view sizes its labels. */
export interface TextLayoutInput extends TextInput {
  readonly size: number;
  readonly color?: RGBA;
  /** Lines longer than this wrap or end in an ellipsis. */
  readonly maxWidth?: number;
  /** `ellipsis` by default; `wrap` breaks between words, and inside one only when it alone is too long. */
  readonly overflow?: 'wrap' | 'ellipsis';
}
/** Laid-out lines in the units of the input's `size`, the first line's top at zero. */
export interface TextLayout {
  /** One run per line, positioned at its baseline. */
  readonly runs: readonly TextRun[];
  readonly width: number;
  readonly height: number;
  readonly ascent: number;
  readonly descent: number;
}
export interface TextRequest {
  /** Immutable identity caches geometry. Moving a view/anchor does not rebuild text. */
  readonly runs: readonly TextRun[];
}
export interface TextPage {
  readonly bindGroup: GPUBindGroup;
  readonly count: number;
}
/** Rasterizes one grapheme at a time; the atlas keeps each once per font. Coverage is monochrome. */
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
