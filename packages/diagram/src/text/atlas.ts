/**
 * The runtime glyph atlas. Diagram text is monospace, so every glyph fits one fixed cell (a wide
 * glyph two adjacent ones) and a cell index is all a glyph instance needs: the glyph pass finds
 * the cell's texels from `atlas_cols` and `atlas_cell` alone.
 */

import { GLYPH_WIDE } from '../webgpu/buffers.js';
import { ADVANCE, isWide, LINE } from './metrics.js';
import { sdf } from './sdf.js';

/** Draws single glyphs for the atlas. */
export interface Rasterizer {
  /** Draw one glyph centered in a cell of `width` x `height` px with the given font; alpha. */
  draw(text: string, font: string, width: number, height: number): Uint8ClampedArray;
}

/** A 2D context either canvas kind gives; the rasterizer uses only what both share. */
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A Canvas2D rasterizer (OffscreenCanvas, else a detached canvas); null without either. */
export function canvasRasterizer(): Rasterizer | null {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  let context: Context2D | null;
  if (typeof OffscreenCanvas === 'function') {
    const offscreen = new OffscreenCanvas(1, 1);
    canvas = offscreen;
    context = offscreen.getContext('2d', { willReadFrequently: true });
  } else if (typeof document !== 'undefined') {
    const element = document.createElement('canvas');
    canvas = element;
    context = element.getContext('2d', { willReadFrequently: true });
  } else {
    return null;
  }
  if (!context) return null;
  const ctx = context;
  return {
    draw(text, font, width, height) {
      // Resizing resets the context state, so the text state is set after it on every draw.
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.clearRect(0, 0, width, height);
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#000';
      ctx.fillText(text, width / 2, height / 2);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const alpha = new Uint8ClampedArray(width * height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[4 * i + 3]!;
      return alpha;
    },
  };
}

/** Font px glyphs are rasterized at. */
const FONT_PX = 40;
/** SDF radius in px; also the margin around a glyph's advance box in its cell. */
const SDF_PX = 6;
/** Atlas texture width in px. */
const WIDTH = 1024;
/** Initial atlas height in px: four rows of cells, room for printable ASCII. */
const MIN_HEIGHT = 256;
/** Largest atlas height in px; a full atlas answers the blank cell. */
const MAX_HEIGHT = 4096;
/** The blank cell: all texels zero, far outside every glyph. */
const BLANK = 0;

/**
 * The runtime glyph atlas: one SDF cell per grapheme, rasterized on first use into an r8 texture
 * that grows by doubling, with the dirty rows a renderer uploads.
 *
 * @remarks
 * Cell `c` sits at column `c % cols`, row `floor(c / cols)`; its texels start at
 * `(column * cellWidth, row * cellHeight)`. A wide glyph takes cells `c` and `c + 1` of one row and
 * answers `c | GLYPH_WIDE`. Cell 0 is blank, and so is every whitespace grapheme.
 */
export class Atlas {
  /** Font px glyphs are rasterized at (40). */
  readonly fontPx: number = FONT_PX;
  /** The SDF radius in px (6). */
  readonly sdfPx: number = SDF_PX;
  /** Atlas texture width in px (1024). */
  readonly width: number = WIDTH;
  /** Cell width in px: `ceil(ADVANCE * fontPx) + 2 * sdfPx`, rounded up to 4. */
  readonly cellWidth: number = Math.ceil((Math.ceil(ADVANCE * FONT_PX) + 2 * SDF_PX) / 4) * 4;
  /** Cell height in px: `ceil(LINE * fontPx) + 2 * sdfPx`. */
  readonly cellHeight: number = Math.ceil(LINE * FONT_PX) + 2 * SDF_PX;
  /** Cells per atlas row. */
  readonly cols: number = Math.floor(WIDTH / this.cellWidth);
  /** Atlas texture height in px, growing by doubling to 4096. */
  height = MIN_HEIGHT;
  /** r8 texels, `width * height`, row-major. */
  pixels: Uint8Array<ArrayBuffer> = new Uint8Array(WIDTH * MIN_HEIGHT);
  /** Bumped when the texture grows or the font changes; a renderer then reallocates and uploads all. */
  version = 0;
  /** Bumped when the font changes: every cell index handed out before is stale. */
  generation = 0;
  /** Dirty texel rows `[dirtyFrom, dirtyTo)` since the last upload; empty when equal. */
  dirtyFrom = 0;
  dirtyTo = MIN_HEIGHT;

  private readonly rasterizer: Rasterizer | null;
  private family: string;
  private readonly cells = new Map<string, number>();
  /** The next unused cell. */
  private next = 1;
  /** Last-column cells wide glyphs skipped, for narrow ones. */
  private readonly spares: number[] = [];

  constructor(rasterizer: Rasterizer | null, fontFamily: string) {
    this.rasterizer = rasterizer;
    this.family = fontFamily;
  }

  /** The font family glyphs are rasterized in. */
  get fontFamily(): string {
    return this.family;
  }

  /** Forget the dirty rows after an upload. */
  clean(): void {
    this.dirtyFrom = 0;
    this.dirtyTo = 0;
  }

  /**
   * The cell of a grapheme, rasterizing it on first use; bit 31 marks a wide (two-cell) glyph;
   * a blank cell (0, the space) when the atlas is full or no rasterizer exists.
   */
  cell(grapheme: string): number {
    const known = this.cells.get(grapheme);
    if (known !== undefined) return known;
    const cell = this.rasterize(grapheme);
    this.cells.set(grapheme, cell);
    return cell;
  }

  /**
   * Switch fonts: clears every cell, shrinks back to the initial height, and bumps the version
   * and the generation. The same family rasterizes again, for a web font that finished loading.
   */
  setFont(fontFamily: string): void {
    this.family = fontFamily;
    this.cells.clear();
    this.next = 1;
    this.spares.length = 0;
    this.height = MIN_HEIGHT;
    this.pixels = new Uint8Array(WIDTH * MIN_HEIGHT);
    this.version++;
    this.generation++;
    this.dirtyFrom = 0;
    this.dirtyTo = MIN_HEIGHT;
  }

  /** Allocate and fill the cell of a grapheme not seen since the last font change. */
  private rasterize(grapheme: string): number {
    if (!this.rasterizer || grapheme.trim() === '') return BLANK;
    const wide = isWide(grapheme.codePointAt(0)!);
    const cell = this.allocate(wide);
    if (cell === BLANK) return BLANK;
    const span = wide ? 2 : 1;
    const w = span * this.cellWidth;
    const h = this.cellHeight;
    const font = `${this.fontPx}px ${this.family}`;
    const field = sdf(this.rasterizer.draw(grapheme, font, w, h), w, h, this.sdfPx);
    const x0 = (cell % this.cols) * this.cellWidth;
    const y0 = Math.floor(cell / this.cols) * h;
    for (let y = 0; y < h; y++) {
      this.pixels.set(field.subarray(y * w, (y + 1) * w), (y0 + y) * WIDTH + x0);
    }
    this.touchRows(y0, y0 + h);
    return wide ? (cell | GLYPH_WIDE) >>> 0 : cell;
  }

  /** The first free cell (two in one row when `wide`), growing the texture; blank when full. */
  private allocate(wide: boolean): number {
    if (!wide && this.spares.length > 0) return this.spares.pop()!;
    let cell = this.next;
    if (!this.reserve(cell)) return BLANK;
    if (wide && cell % this.cols === this.cols - 1) {
      // A wide glyph cannot straddle rows: keep the last column for a narrow glyph.
      this.spares.push(cell);
      this.next = ++cell;
      if (!this.reserve(cell)) return BLANK;
    }
    this.next = cell + (wide ? 2 : 1);
    return cell;
  }

  /** Grow the texture until it has cell `cell`'s row; false when it cannot grow that far. */
  private reserve(cell: number): boolean {
    const row = Math.floor(cell / this.cols);
    while (row >= Math.floor(this.height / this.cellHeight)) {
      if (this.height >= MAX_HEIGHT) return false;
      this.grow();
    }
    return true;
  }

  /** Double the texture height, keeping every cell. */
  private grow(): void {
    const height = Math.min(this.height * 2, MAX_HEIGHT);
    const pixels = new Uint8Array(WIDTH * height);
    pixels.set(this.pixels);
    this.pixels = pixels;
    this.height = height;
    this.version++;
    this.dirtyFrom = 0;
    this.dirtyTo = height;
  }

  /** Mark texel rows `[from, to)` for upload, merged with what is already dirty. */
  private touchRows(from: number, to: number): void {
    if (this.dirtyFrom >= this.dirtyTo) {
      this.dirtyFrom = from;
      this.dirtyTo = to;
      return;
    }
    if (from < this.dirtyFrom) this.dirtyFrom = from;
    if (to > this.dirtyTo) this.dirtyTo = to;
  }
}
