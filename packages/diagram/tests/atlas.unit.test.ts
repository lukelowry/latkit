import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeRasterizer } from './fixtures/text-rasterizer.js';
import { Atlas, canvasRasterizer } from '../src/text/atlas.js';
import { GLYPH_WIDE } from '../src/webgpu/buffers.js';

/** `count` distinct narrow graphemes. */
function narrow(count: number, from = 0x100): string[] {
  return Array.from({ length: count }, (_, i) => String.fromCodePoint(from + i));
}

/** The texel at `(x, y)` inside cell `cell`. */
function texel(atlas: Atlas, cell: number, x: number, y: number): number {
  const index = cell & ~GLYPH_WIDE;
  const x0 = (index % atlas.cols) * atlas.cellWidth;
  const y0 = Math.floor(index / atlas.cols) * atlas.cellHeight;
  return atlas.pixels[(y0 + y) * atlas.width + x0 + x]!;
}

describe('Atlas', () => {
  it('sizes fixed monospace cells from the font and SDF sizes', () => {
    const atlas = new Atlas(fakeRasterizer(), 'mono');
    expect(atlas.fontPx).toBe(40);
    expect(atlas.sdfPx).toBe(6);
    expect(atlas.cellWidth).toBe(36);
    expect(atlas.cellHeight).toBe(62);
    expect(atlas.cols).toBe(28);
    expect(atlas.width).toBe(1024);
    expect(atlas.height).toBe(256);
    expect(atlas.pixels.length).toBe(1024 * 256);
    expect(atlas.fontFamily).toBe('mono');
    // A new atlas is dirty whole, so a first upload sends every row.
    expect([atlas.dirtyFrom, atlas.dirtyTo]).toEqual([0, 256]);
  });

  it('answers the blank cell for whitespace without rasterizing', () => {
    const raster = fakeRasterizer();
    const atlas = new Atlas(raster, 'mono');
    expect(atlas.cell(' ')).toBe(0);
    expect(atlas.cell(' ')).toBe(0);
    expect(atlas.cell('')).toBe(0);
    expect(raster.draws).toEqual([]);
  });

  it('rasterizes a grapheme once, into the next cell, as a signed distance field', () => {
    const raster = fakeRasterizer();
    const atlas = new Atlas(raster, 'mono');
    atlas.clean();
    const a = atlas.cell('a');
    expect(a).toBe(1);
    expect(atlas.cell('b')).toBe(2);
    expect(atlas.cell('a')).toBe(1);
    expect(raster.draws).toEqual([
      { text: 'a', font: '40px mono', width: 36, height: 62 },
      { text: 'b', font: '40px mono', width: 36, height: 62 },
    ]);
    // The box's middle is deep inside; the cell's corner is far outside; cell 0 stays blank.
    expect(texel(atlas, a, 18, 31)).toBe(255);
    expect(texel(atlas, a, 0, 0)).toBe(0);
    expect(atlas.pixels.subarray(0, 36).every((v) => v === 0)).toBe(true);
    expect([atlas.dirtyFrom, atlas.dirtyTo]).toEqual([0, 62]);
    expect(atlas.version).toBe(0);
  });

  it('merges dirty rows across cells until cleaned', () => {
    const atlas = new Atlas(fakeRasterizer(), 'mono');
    atlas.clean();
    for (const g of narrow(30)) atlas.cell(g);
    expect([atlas.dirtyFrom, atlas.dirtyTo]).toEqual([0, 124]);
    atlas.clean();
    expect(atlas.dirtyFrom >= atlas.dirtyTo).toBe(true);
    atlas.cell('z');
    expect([atlas.dirtyFrom, atlas.dirtyTo]).toEqual([62, 124]);
  });

  it('grows by doubling its height, keeping every cell', () => {
    const atlas = new Atlas(fakeRasterizer(), 'mono');
    const first = atlas.cell('a');
    // Four rows of 28 cells fit 256 px; cell 0 is blank, so the 112th glyph needs a fifth row.
    for (const g of narrow(110)) atlas.cell(g);
    const before = atlas.pixels.slice();
    expect(atlas.height).toBe(256);
    expect(atlas.version).toBe(0);
    atlas.clean();
    expect(atlas.cell('grow')).toBe(112);
    expect(atlas.height).toBe(512);
    expect(atlas.version).toBe(1);
    expect(atlas.pixels.length).toBe(1024 * 512);
    expect([atlas.dirtyFrom, atlas.dirtyTo]).toEqual([0, 512]);
    expect(atlas.pixels.subarray(0, before.length).every((v, i) => v === before[i])).toBe(true);
    expect(texel(atlas, first, 18, 31)).toBe(255);
  });

  it('stops at 4096 px and then answers the blank cell', () => {
    const raster = fakeRasterizer();
    const atlas = new Atlas(raster, 'mono');
    // 4096 px hold 66 rows of 28 cells; cell 0 is blank.
    const capacity = Math.floor(4096 / 62) * 28 - 1;
    const cells = narrow(capacity).map((g) => atlas.cell(g));
    expect(cells[capacity - 1]).toBe(capacity);
    expect(atlas.height).toBe(4096);
    expect(atlas.version).toBe(4);
    const draws = raster.draws.length;
    expect(atlas.cell('overflow')).toBe(0);
    expect(atlas.cell('overflow')).toBe(0);
    expect(atlas.cell('一')).toBe(0);
    expect(atlas.height).toBe(4096);
    expect(raster.draws.length).toBe(draws);
  });

  it('gives a wide glyph two adjacent cells of one row', () => {
    const raster = fakeRasterizer();
    const atlas = new Atlas(raster, 'mono');
    const wide = atlas.cell('漢');
    expect(wide).toBe((1 | GLYPH_WIDE) >>> 0);
    expect(raster.draws[0]).toEqual({ text: '漢', font: '40px mono', width: 72, height: 62 });
    expect(atlas.cell('a')).toBe(3);
    // The box spans both cells: deep inside at the seam between them.
    expect(texel(atlas, wide, 36, 31)).toBe(255);
  });

  it('keeps a last-column cell a wide glyph skipped for the next narrow glyph', () => {
    const atlas = new Atlas(fakeRasterizer(), 'mono');
    for (const g of narrow(26)) atlas.cell(g);
    // The next free cell is 27, the last column: a wide glyph starts the next row instead.
    expect(atlas.cell('漢')).toBe((28 | GLYPH_WIDE) >>> 0);
    expect(atlas.cell('a')).toBe(27);
    expect(atlas.cell('b')).toBe(30);
  });

  it('answers the blank cell for everything without a rasterizer', () => {
    const atlas = new Atlas(null, 'mono');
    expect(atlas.cell('a')).toBe(0);
    expect(atlas.cell('漢')).toBe(0);
    expect(atlas.version).toBe(0);
    expect(atlas.height).toBe(256);
  });

  it('clears every cell on a font change and rasterizes again', () => {
    const raster = fakeRasterizer();
    const atlas = new Atlas(raster, 'mono');
    for (const g of narrow(120)) atlas.cell(g);
    expect(atlas.height).toBe(512);
    const version = atlas.version;
    atlas.clean();
    atlas.setFont('serif');
    expect(atlas.fontFamily).toBe('serif');
    expect(atlas.version).toBe(version + 1);
    expect(atlas.generation).toBe(1);
    expect(atlas.height).toBe(256);
    expect(atlas.pixels.every((v) => v === 0)).toBe(true);
    expect([atlas.dirtyFrom, atlas.dirtyTo]).toEqual([0, 256]);
    expect(atlas.cell(String.fromCodePoint(0x110))).toBe(1);
    expect(raster.draws.at(-1)!.font).toBe('40px serif');
  });
});

describe('canvasRasterizer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is null without OffscreenCanvas or a document', () => {
    expect(canvasRasterizer()).toBeNull();
  });

  it('is null when the canvas has no 2D context', () => {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext(): null {
          return null;
        }
      },
    );
    expect(canvasRasterizer()).toBeNull();
  });

  it('draws centered text on an OffscreenCanvas and returns its alpha channel', () => {
    const calls: unknown[][] = [];
    const state: Record<string, unknown> = {};
    const context = {
      clearRect: (...args: unknown[]) => calls.push(['clearRect', ...args]),
      fillText: (...args: unknown[]) => calls.push(['fillText', ...args, { ...state }]),
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(4 * w * h);
        for (let i = 0; i < w * h; i++) data[4 * i + 3] = i;
        return { data };
      },
    };
    const canvases: { width: number; height: number }[] = [];
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
          canvases.push(this);
        }
        getContext(): unknown {
          return new Proxy(context, {
            set: (_target, key, value) => {
              state[String(key)] = value;
              return true;
            },
          });
        }
      },
    );
    const raster = canvasRasterizer()!;
    expect(raster).not.toBeNull();
    const alpha = raster.draw('a', '40px mono', 4, 3);
    expect(canvases[0]).toMatchObject({ width: 4, height: 3 });
    expect(Array.from(alpha)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(calls).toEqual([
      ['clearRect', 0, 0, 4, 3],
      [
        'fillText',
        'a',
        2,
        1.5,
        { font: '40px mono', textAlign: 'center', textBaseline: 'middle', fillStyle: '#000' },
      ],
    ]);
  });
});
