import { expect, it } from 'vitest';
import { createGpu } from '../src/index.js';
import { Feedback, lineStyle, projectedStyle, resolveStyle, resolveViewStyle } from '../src/kit.js';
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
