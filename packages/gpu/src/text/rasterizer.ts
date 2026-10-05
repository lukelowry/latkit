import { interruptible, failure } from '@latkit/model';
import type { TextRasterizer } from './text.js';

/** Uses the browser's shaping engine, including ligatures, fallback fonts and bidirectional runs. */
export function createTextRasterizer(): TextRasterizer {
  let surface:
    | {
        readonly canvas: OffscreenCanvas | HTMLCanvasElement;
        readonly context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      }
    | undefined;
  return {
    async rasterize(input, options) {
      const { pixelsPerEm, maxWidth, maxHeight, signal } = options;
      signal.throwIfAborted();
      if (input.text.length > 4096 || /[\r\n]/u.test(input.text))
        throw failure('invalid-input', 'Text runs must be bounded single lines');
      const font = `${input.font?.style ?? 'normal'} ${input.font?.weight ?? 400} ${pixelsPerEm}px ${input.font?.family ?? 'sans-serif'}`;
      const fonts =
        (globalThis as typeof globalThis & { fonts?: FontFaceSet }).fonts ??
        globalThis.document?.fonts;
      if (fonts) await interruptible(fonts.load(font, input.text), signal);
      surface ??= canvas2d();
      const { canvas, context } = surface;
      const configure = (): void => {
        context.font = font;
        context.textAlign = 'left';
        context.textBaseline = 'alphabetic';
        context.direction = input.direction ?? 'ltr';
        context.fillStyle = '#fff';
      };
      configure();
      const metrics = context.measureText(input.text);
      const left = Math.floor(-metrics.actualBoundingBoxLeft),
        top = Math.floor(-metrics.actualBoundingBoxAscent);
      const width = Math.max(1, Math.ceil(metrics.actualBoundingBoxRight) - left),
        height = Math.max(1, Math.ceil(metrics.actualBoundingBoxDescent) - top);
      if (width > maxWidth || height > maxHeight)
        throw failure(
          'resource-limit',
          'Shaped text exceeds the atlas page; split long lines before preparing text',
        );
      canvas.width = width;
      canvas.height = height;
      configure();
      context.fillText(input.text, -left, -top);
      const rgba = context.getImageData(0, 0, width, height).data,
        coverage = new Uint8Array(width * height);
      for (let i = 0; i < coverage.length; i++) coverage[i] = rgba[i * 4 + 3];
      signal.throwIfAborted();
      return {
        width,
        height,
        coverage,
        left: left / pixelsPerEm,
        top: top / pixelsPerEm,
        advance: metrics.width / pixelsPerEm,
        // The font's line, not this glyph's ink: every string of a font shares one baseline.
        ascent: metrics.fontBoundingBoxAscent / pixelsPerEm,
        descent: metrics.fontBoundingBoxDescent / pixelsPerEm,
      };
    },
  };
}

/** One canvas a rasterizer draws every run on. */
function canvas2d() {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1)
      : globalThis.document?.createElement('canvas');
  if (!canvas)
    throw failure('unavailable', 'Supply a TextRasterizer in environments without Canvas2D');
  const context = canvas.getContext('2d', { willReadFrequently: true }) as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw failure('unavailable', 'Canvas2D text rasterization is unavailable');
  return { canvas, context };
}
