import { expect, it } from 'vitest';
import { createGpu, type ProjectedCamera } from '../src/index.js';
import {
  Feedback,
  Projector,
  gridLines,
  lineStyle,
  projectedStyle,
  resolveStyle,
  resolveViewStyle,
} from '../src/kit.js';
import { fakeDevice, type FakeBuffer } from './fixtures/device.js';

/** The failure code a call throws, or undefined when it returns. */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

it('resolves a style over its defaults, checking each option as its default and rules say', () => {
  const defaults = {
    ...lineStyle,
    ...projectedStyle,
    edgeColor: 'ends' as const,
    zScale: 1,
    poles: false,
    gap: 4,
    share: 0.5,
    shape: 'round',
  };
  const rules = {
    edgeColor: ['ends'],
    gap: 'positive',
    share: 'unit',
    shape: ['round', 'square'],
  } as const;
  const view = resolveViewStyle({});
  const style = resolveStyle({ fitBearing: -30, orbitRate: -2, zScale: 0 }, defaults, rules, view);
  expect([style.fitBearing, style.orbitRate, style.zScale, style.msaa]).toEqual([-30, -2, 0, 4]);
  expect(resolveStyle({ edgeColor: [1, 0, 0, 1] }, defaults, rules).edgeColor).toEqual([
    1, 0, 0, 1,
  ]);
  for (const config of [
    { zScale: -1 },
    { zScale: Infinity },
    { gap: 0 },
    { share: 1.5 },
    { poles: 1 },
    { shape: 'star' },
    { edgeColor: 'none' },
    { flowColor: [2, 0, 0, 1] },
    // A projected camera tilts at most 80 degrees, so a fit does too.
    { fitPitch: 85 },
  ])
    expect(codeOf(() => resolveStyle(config, defaults, rules))).toBe('invalid-input');
  expect(Object.isFrozen(style)).toBe(true);
});

it('checks the shared view style once, over a view’s own defaults', () => {
  expect(resolveViewStyle({}, { msaa: 1 }).msaa).toBe(1);
  expect(resolveViewStyle({ selectedColor: 'none' }).selectedColor).toBe('none');
  for (const config of [
    { msaa: 2 },
    { hover: 'always' },
    { motion: 'slow' },
    { font: {} },
    { hoverBudgetMs: 0 },
    { unselectedAlpha: 2 },
    { fitPaddingPx: [1, 2] },
  ])
    expect(codeOf(() => resolveViewStyle(config as never))).toBe('invalid-input');
});

it('reads words the GPU wrote back once a frame completes, never more than its ring holds', async () => {
  const fake = fakeDevice();
  const gpu = await createGpu({ device: fake.device });
  const reads: [number[], string][] = [];
  const feedback = new Feedback<string>(
    gpu,
    (words, frame) => reads.push([[...words], frame]),
    'test',
  );
  const source = fake.device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_SRC,
  }) as FakeBuffer;
  new Uint32Array(source.bytes.buffer).set([7, 9, 11]);
  const frame = (name: string) => {
    const encoder = fake.device.createCommandEncoder();
    feedback.encode(encoder, source, 12, name);
    fake.device.queue.submit([encoder.finish()]);
  };
  frame('a');
  feedback.submitted();
  await Promise.resolve();
  await Promise.resolve();
  expect(reads).toEqual([[[7, 9, 11], 'a']]);
  // Frames the GPU has yet to finish hold their staging buffers; past the ring, a frame copies none.
  for (const name of ['b', 'c', 'd', 'e']) frame(name);
  feedback.submitted();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reads.map(([, name]) => name)).toEqual(['a', 'b', 'c', 'd']);
  // A discarded frame's copy is never read.
  frame('f');
  feedback.discard();
  feedback.submitted();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reads).toHaveLength(4);
  feedback.destroy();
  gpu.destroy();
});

it('spaces a grid at the nicest step past its least spacing, and places it under the center', () => {
  const camera = (scale: number, center: readonly [number, number] = [0, 0]) =>
    ({ ...Projector.camera, scale, center }) as ProjectedCamera;
  // 64 CSS pixels at 1 pixel a unit wants 64 units: 100, of 1, 2, or 5 times a power of ten.
  expect(gridLines(camera(1), 64, false)[0]).toBe(100);
  expect(gridLines(camera(32), 64, false)[0]).toBe(2);
  expect(gridLines(camera(100), 64, false)[0]).toBe(1);
  expect(gridLines(camera(1000), 64, false)[0]).toBeCloseTo(0.1);
  // Degrees past 10 step 15, then 30 at most.
  expect(gridLines(camera(5), 64, true)[0]).toBe(15);
  expect(gridLines(camera(0.1), 64, true)[0]).toBe(30);
  // How far past a line the center lies, in steps, precisely at any distance from the origin.
  const [step, x, y] = gridLines(camera(1, [1e9 + 250, -30]), 64, false);
  expect([step, x]).toEqual([100, 0.5]);
  expect(y).toBeCloseTo(0.7);
});
