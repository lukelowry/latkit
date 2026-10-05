import { describe, expect, it } from 'vitest';
import { gauge, icon, pie, pulse, shape, type MarkerImage } from '../src/index.js';
import { kit } from '../src/index.js';

/** The failure code a call throws, or undefined when it returns. */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}
/** Decoded pixels, as an `ImageData` holds them. */
const pixels = (width: number, height: number, rgba: readonly number[]): MarkerImage =>
  ({
    width,
    height,
    data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => rgba[i % 4]!),
  }) as unknown as MarkerImage;

describe('markers', () => {
  it('draws the shared shapes and markers by code, in CSS pixels', () => {
    expect(kit.SHAPES).toEqual(['rounded', 'rectangle', 'ellipse', 'diamond']);
    const shapes = kit.shapeShader();
    kit.SHAPES.forEach((name, i) =>
      expect(shapes).toContain(`const SHAPE_${name.toUpperCase()}: u32 = ${i}u;`),
    );
    expect(shape().wgsl).toContain('shapeDistance(2u, f.p, vec2f(f.radiusPx)');
    expect(shape('diamond').wgsl).toContain('shapeDistance(3u');
    expect(gauge({ fill: 'load', shape: 'rounded', ringPx: 3, gapPx: 0.5 })).toMatchObject({
      inputs: { fill: 'load' },
      wgsl: expect.stringContaining('gaugeMarker(f, 0u, f.fill, 3.0, 0.5)') as string,
    });
    const chart = pie({
      slices: ['a', 'b'],
      colors: [
        [1, 0, 0, 1],
        [0, 0, 1, 1],
      ],
      hole: 0.5,
    });
    expect(chart.inputs).toEqual({ s0: 'a', s1: 'b' });
    expect(chart.wgsl).toContain('array<f32, 8>(f.s0, f.s1, 0.0');
    expect(chart.wgsl).toContain('2u,\n    0.5,');
    // An image's index steps between images; every other input eases.
    expect(icon({ images: [pixels(1, 1, [255, 0, 0, 255])], image: 'kind' })).toMatchObject({
      inputs: { image: 'kind' },
      steps: ['image'],
    });
  });

  it('rejects markers a view cannot draw', () => {
    const wgsl =
      'fn marker(f: MarkerFragment) -> MarkerColor { return MarkerColor(f.color, 0.0); }';
    expect(codeOf(() => kit.checkMarker({ wgsl }))).toBeUndefined();
    expect(codeOf(() => kit.checkMarker({ wgsl: 'fn other() {}' }))).toBe('invalid-input');
    expect(codeOf(() => kit.checkMarker({ wgsl, inputs: { p: 'x' } }))).toBe('invalid-input');
    expect(codeOf(() => kit.checkMarker({ wgsl, inputs: { Bad: 'x' } }))).toBe('invalid-input');
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['v' + i, 'x']));
    expect(codeOf(() => kit.checkMarker({ wgsl, inputs: nine }))).toBe('invalid-input');
    expect(codeOf(() => kit.checkMarker({ wgsl, inputs: { a: 'x' }, steps: ['b'] }))).toBe(
      'invalid-input',
    );
    expect(
      codeOf(() => kit.checkMarker({ wgsl, images: [{ width: 0, height: 1 } as MarkerImage] })),
    ).toBe('invalid-input');
    expect(codeOf(() => gauge({ fill: 'x', ringPx: -1 }))).toBe('invalid-input');
    expect(codeOf(() => shape('star' as 'ellipse'))).toBe('invalid-input');
    expect(codeOf(() => pie({ slices: ['a'], colors: [] }))).toBe('invalid-input');
    expect(codeOf(() => pie({ slices: ['a'], colors: [[1, 1, 1, 1]], hole: 1 }))).toBe(
      'invalid-input',
    );
  });

  it('builds a module that reads each input from its lane and binds the atlas where asked', () => {
    const module = kit.markerShader(
      { wgsl: shape().wgsl, inputs: { load: 'a', kind: 'b', ...{ c: 'c', d: 'd', e: 'e' } } },
      { group: 0, binding: 11, columns: 2 },
    );
    expect(module.startsWith('diagnostic(off, derivative_uniformity);')).toBe(true);
    expect(module).toContain('  load: f32,\n  kind: f32,');
    expect(module).toContain(
      'MarkerFragment(p, radiusPx, color, background, a.x, a.y, a.z, a.w, b.x)',
    );
    expect(module).toContain('@group(0) @binding(11) var markerAtlas');
    expect(module).toContain('@group(0) @binding(12) var markerSampler');
    expect(module).toContain('const MARKER_COLUMNS: f32 = 2.0;');
    // Layers keep the outline's coverage out of their alpha, so the view applies it once.
    expect(module).toContain('alpha / max(coverage(outline), 0.000001)');
    expect(codeOf(() => kit.markerShader({ wgsl: '' }, { group: 0, binding: 0, columns: 1 }))).toBe(
      'invalid-input',
    );
  });

  it('lays images into square cells, fitted, centered, averaged, and premultiplied', () => {
    const wide = pixels(4, 2, [255, 0, 0, 255]),
      half = pixels(2, 2, [0, 0, 255, 128]);
    const atlas = kit.markerAtlas([wide, half, wide], 4);
    expect(atlas).toMatchObject({ width: 8, height: 8, columns: 2 });
    const at = (x: number, y: number) => [
      ...atlas.data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4),
    ];
    // The wide image fills its cell's width and the middle of its height.
    expect(at(0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(0, 1)).toEqual([255, 0, 0, 255]);
    expect(at(3, 2)).toEqual([255, 0, 0, 255]);
    expect(at(0, 3)).toEqual([0, 0, 0, 0]);
    // Half-covered blue, premultiplied.
    expect(at(4, 0)).toEqual([0, 0, 128, 128]);
    // The third image starts the second row; the last cell stays clear.
    expect(at(0, 5)).toEqual([255, 0, 0, 255]);
    expect(at(6, 6)).toEqual([0, 0, 0, 0]);
  });

  it('pulses rows with a positive shade, every frame', () => {
    const shade = pulse({ periodMs: 1000, strength: 0.5, color: [1, 0, 0] }),
      parameters = new Float32Array(64);
    expect(shade.wgsl).toContain('fn shade(f: ShadeFragment) -> vec4f');
    expect(
      shade.tick!(parameters, {
        timeMs: 0,
        pointerPx: null,
        viewport: { width: 1, height: 1, pixelRatio: 1 },
      }),
    ).toBe(true);
    expect([...parameters.subarray(0, 8)]).toEqual([1000, 0.5, 0, 0, 1, 0, 0, 1]);
    expect(codeOf(() => pulse({ periodMs: 0 }))).toBe('invalid-input');
    expect(codeOf(() => pulse({ strength: 2 }))).toBe('invalid-input');
    expect(codeOf(() => pulse({ color: [2, 0, 0] }))).toBe('invalid-input');
  });
});
