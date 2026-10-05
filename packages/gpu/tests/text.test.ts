import { expect, it, vi } from 'vitest';
import { createGpu, kit, type TextRasterizer } from '../src/index.js';
import { type TextPage, type TextRun } from '../src/kit.js';
import { distanceField } from '../src/text/distance-field.js';
import { bytes, deferred, fakeDevice } from './fixtures/device.js';
import { draw, renderer, target } from './fixtures/render.js';

function rasterizer(): TextRasterizer & {
  rasterize: ReturnType<typeof vi.fn<TextRasterizer['rasterize']>>;
} {
  return {
    rasterize: vi.fn<TextRasterizer['rasterize']>(async (input) => ({
      width: 8,
      height: 8,
      coverage: new Uint8Array(64).fill(255),
      advance: input.text.length / 2,
      left: -0.1,
      top: -0.75,
      ascent: 0.75,
      descent: 0.2,
    })),
  };
}
const run = (text = 'office العربية'): TextRun => ({
  text,
  size: 16,
  position: [20, 40],
  anchor: 42,
  color: [0.25, 0.5, 1, 0.8],
});

it('shares glyphs, atlas regions, and text geometry across strings, views, and frames', async () => {
  const fake = fakeDevice(),
    raster = rasterizer(),
    gpu = await createGpu({ device: fake.device, text: { rasterizer: raster, atlasSize: 64 } });
  const runs = [run()];
  let pages: readonly TextPage[] = [];
  const a = renderer(async (frame) => {
    pages = await frame.text({ runs });
  });
  const b = renderer(async (frame) => {
    await frame.text({ runs });
  });
  await gpu.render({
    timeMs: 0,
    views: [
      { renderer: a, target: target(fake.device) },
      { renderer: b, target: target(fake.device) },
    ],
  });
  await gpu.idle();
  // One raster and one atlas region per distinct grapheme.
  const graphemes = new Set(runs[0].text);
  expect(raster.rasterize).toHaveBeenCalledTimes(graphemes.size);
  expect(fake.queue.writeTexture).toHaveBeenCalledTimes(graphemes.size);
  // Both views share the one text geometry: its pages upload once.
  expect(gpu.stats().uploads).toBe(graphemes.size + pages.length);
  const layout = await gpu.layoutText({ text: 'ice', size: 10 });
  // Layout measures the font once, from its capital H.
  expect(raster.rasterize).toHaveBeenCalledTimes(graphemes.size + 1);
  expect(layout.width).toBe(15);
  expect(layout.runs).toEqual([
    expect.objectContaining({ text: 'ice', size: 10, position: [0, 7.5] }),
  ]);
  const before = gpu.stats();
  await draw(gpu, async (frame) => {
    pages = await frame.text({ runs });
  });
  expect(gpu.stats().uploadedBytes).toBe(before.uploadedBytes);
  const descriptor = (pages[0].bindGroup as unknown as { descriptor: GPUBindGroupDescriptor })
    .descriptor;
  const binding = [...descriptor.entries][0].resource as GPUBufferBinding,
    data = bytes(binding);
  expect(new Uint32Array(data.buffer, data.byteOffset)[12]).toBe(42);
  expect(new Float32Array(data.buffer, data.byteOffset)[8]).toBe(0.25);
  gpu.destroy();
  expect(gpu.stats().gpuBytes).toBe(0);
  expect(gpu.stats().entries).toBe(0);
});

it('appends nonoverlapping atlas regions while prior frames remain in flight', async () => {
  const fake = fakeDevice({ deferCompletion: true }),
    gpu = await createGpu({
      device: fake.device,
      text: { rasterizer: rasterizer(), atlasSize: 64 },
    });
  for (const text of ['first', 'second'])
    await gpu.render({
      timeMs: 0,
      views: [
        {
          target: target(fake.device),
          renderer: renderer(async (frame) => {
            await frame.text({ runs: [run(text)] });
          }),
        },
      ],
    });
  const writes = fake.queue.writeTexture.mock.calls;
  expect(writes).toHaveLength(new Set('firstsecond').size);
  expect(writes[0][0].texture).toBe(writes[1][0].texture);
  expect(writes[0][0].origin).not.toEqual(writes[1][0].origin);
  fake.finish();
  await gpu.idle();
  gpu.destroy();
});

it('font revision invalidates shaping and an aborted reader does not cancel another reader', async () => {
  const fake = fakeDevice(),
    gate = deferred<void>(),
    raster = rasterizer();
  raster.rasterize.mockImplementationOnce(async () => {
    await gate.promise;
    return {
      width: 1,
      height: 1,
      coverage: Uint8Array.of(255),
      left: 0,
      top: 0,
      advance: 1,
      ascent: 1,
      descent: 0,
    };
  });
  const gpu = await createGpu({ device: fake.device, text: { rasterizer: raster, atlasSize: 64 } }),
    controller = new AbortController();
  const first = gpu.layoutText({ ...run(), text: 'x' }, { signal: controller.signal }),
    second = gpu.layoutText({ ...run(), text: 'x' });
  const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await rejection;
  gate.resolve();
  await second;
  // The font's H, measured once for every reader, then x.
  expect(raster.rasterize).toHaveBeenCalledTimes(2);
  await gpu.layoutText({ ...run(), text: 'x', font: { family: 'sans-serif', revision: '2' } });
  expect(raster.rasterize).toHaveBeenCalledTimes(4);
  gpu.destroy();
});

it('evicts bounded text caches and rebuilds cleanly after trim', async () => {
  const fake = fakeDevice(),
    raster = rasterizer(),
    gpu = await createGpu({
      device: fake.device,
      text: { rasterizer: raster, atlasSize: 64 },
      budget: { gpuBytes: 65536 },
    });
  const runs = [run()];
  await draw(gpu, async (frame) => {
    await frame.text({ runs });
  });
  gpu.trim();
  expect(gpu.stats().gpuBytes).toBe(0);
  const glyphs = raster.rasterize.mock.calls.length;
  await draw(gpu, async (frame) => {
    await frame.text({ runs });
  });
  expect(raster.rasterize.mock.calls.length).toBeGreaterThan(glyphs);
  gpu.destroy();
});

it('distance fields preserve inside/outside, antialiasing, and transparent padding', () => {
  const field = distanceField(Uint8Array.of(255, 128, 0), 3, 1, 2);
  expect(field[2 * 7 + 2]).toBeGreaterThan(128);
  expect(field[2 * 7 + 3]).toBeCloseTo(128, 0);
  expect(field[2 * 7 + 4]).toBeLessThan(128);
  expect(field[0]).toBe(0);
});

it('rejects a renderer that leaves asynchronous text preparation unawaited', async () => {
  const fake = fakeDevice(),
    gate = deferred<void>(),
    raster = rasterizer();
  raster.rasterize.mockImplementationOnce(async () => {
    await gate.promise;
    return {
      width: 1,
      height: 1,
      coverage: Uint8Array.of(255),
      left: 0,
      top: 0,
      advance: 1,
      ascent: 1,
      descent: 0,
    };
  });
  const gpu = await createGpu({ device: fake.device, text: { rasterizer: raster, atlasSize: 64 } });
  await expect(
    draw(gpu, (frame) => {
      void frame.text({ runs: [run()] }).catch(() => {});
    }),
  ).rejects.toMatchObject({ code: 'invalid-input' });
  expect(fake.queue.submit).not.toHaveBeenCalled();
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  gpu.destroy();
});

it('wraps between words, ellipsizes by advances, and breaks lines', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({
      device: fake.device,
      text: { rasterizer: rasterizer(), atlasSize: 64 },
    });
  // Every grapheme advances half an em: 5 units at size 10.
  const lines = (layout: { runs: readonly TextRun[] }) => layout.runs.map((r) => r.text);
  expect(
    lines(await gpu.layoutText({ text: 'aa bb cc', size: 10, maxWidth: 25, overflow: 'wrap' })),
  ).toEqual(['aa bb', 'cc']);
  expect(
    lines(await gpu.layoutText({ text: 'abcdefgh', size: 10, maxWidth: 20, overflow: 'wrap' })),
  ).toEqual(['abcd', 'efgh']);
  const cut = await gpu.layoutText({ text: 'abcdefgh', size: 10, maxWidth: 20 });
  expect(lines(cut)).toEqual(['abc…']);
  expect(cut.width).toBe(20);
  const two = await gpu.layoutText({ text: 'a\nbc', size: 10 });
  expect(lines(two)).toEqual(['a', 'bc']);
  expect(two.runs[1].position[1]).toBeGreaterThan(two.runs[0].position[1]);
  // Each line is the font's ascent and descent tall.
  expect(two.lineHeight).toBeCloseTo(10 * (0.75 + 0.2));
  expect(two.height).toBeCloseTo(2 * two.lineHeight);
  expect((await gpu.layoutText({ text: '', size: 10 })).runs).toEqual([]);
  gpu.destroy();
});

it('places every string of a font on one baseline, centered by its capitals', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({
      device: fake.device,
      text: { rasterizer: rasterizer(), atlasSize: 64 },
    });
  const short = await gpu.layoutText({ text: 'in', size: 10 }),
    tall = await gpu.layoutText({ text: 'Hg', size: 10, align: 'center' });
  expect(short.baseline).toBe(tall.baseline);
  expect(short.capHeight).toBeCloseTo(7.5);
  // Middle puts the point halfway up the capitals; the other sides and heights are exact.
  const [x, y] = kit.textOrigin(short, [100, 50], 'center', 'middle');
  expect(x).toBeCloseTo(100 - short.width / 2);
  expect(y + short.baseline - short.capHeight / 2).toBeCloseTo(50);
  expect(kit.textOrigin(short, [100, 50], 'end', 'bottom')).toEqual([
    100 - short.width,
    50 - short.height,
  ]);
  expect(kit.textOrigin(short, [100, 50], 'start', 'alphabetic')).toEqual([
    100,
    50 - short.baseline,
  ]);
  expect(kit.textBox(short, [1, 2], 1)).toEqual([0, 1, 2 + short.width, 3 + short.height]);
  gpu.destroy();
});

it('keeps the runs of a bank key and moves only its anchor, placing where nothing overlaps', async () => {
  const fake = fakeDevice(),
    gpu = await createGpu({
      device: fake.device,
      text: { rasterizer: rasterizer(), atlasSize: 64 },
    });
  const label = await gpu.layoutText({ text: 'ab', size: 10 }),
    other = await gpu.layoutText({ text: 'cd', size: 10 });
  const bank = new kit.TextBank('test text', true);
  bank.add('a', label, [100, 200], 7);
  const [first] = bank.flush();
  expect(first.origin).toEqual([100, 200]);
  expect(first.runs).toEqual([expect.objectContaining({ text: 'ab', anchor: 0 })]);
  const anchors = () =>
    new Float32Array(first.anchors.bytes.buffer, first.anchors.bytes.byteOffset, 4);
  // The anchor is relative to the page; its slot is stored one up, so zero hides it.
  expect([...anchors()]).toEqual([0, 0, 0, 8]);
  bank.hide();
  bank.add('a', label, [110, 205], 7, 0.5);
  const [moved] = bank.flush();
  expect(moved.runs).toBe(first.runs);
  expect([...anchors()]).toEqual([10, 5, 0.5, 8]);
  bank.hide();
  expect([...bank.flush()[0].anchors.bytes.slice(12, 16)]).toEqual([0, 0, 0, 0]);
  // Placement takes the first candidate whose box is free, and claims it.
  const occupied = new kit.Occupancy(16);
  occupied.add([0, 0, 50, 50]);
  const at = bank.place(
    'b',
    other,
    [
      [10, 10, 'start', 'top'],
      [60, 10, 'start', 'top'],
    ],
    occupied,
    2,
  );
  expect(at).toEqual([60, 10]);
  expect(bank.place('c', other, [[61, 11, 'start', 'top']], occupied)).toBeNull();
  expect(bank.flush()[0].runs).toHaveLength(2);
  gpu.destroy();
});
