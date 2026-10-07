import { appendData, createData, textColumn, type Data, type Schema } from '@latkit/model';
import { describe, expect, it, vi } from 'vitest';
import { createGpu, kit, type Point } from '@latkit/gpu';
import { createMonitor, type Monitor, type MonitorConfig } from '../src/index.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';

const index = { source: 'picking', type: 'Bus', version: '1' };
const schema: Schema = {
  axis: { name: 'time' },
  types: { Bus: { fields: { Vm: { type: 'float64', sampled: true } } } },
};
/** Rows sampled at `coordinates`, a list of values each; NaN where a sample is missing. */
function signals(coordinates: readonly number[], rows: readonly (readonly number[])[]): Data {
  const count = rows.length,
    values = new Float64Array(coordinates.length * count);
  coordinates.forEach((_, f) => rows.forEach((row, r) => (values[f * count + r] = row[f])));
  const range = { kind: 'range', offset: 0, count } as const;
  const base = createData(schema, [
    {
      kind: 'rows',
      index,
      rows: range,
      ids: textColumn(rows.map((_, r) => 'Bus/' + r)),
      columns: {},
    },
  ]);
  return appendData(base, [
    {
      kind: 'samples',
      index,
      rows: range,
      firstFrame: 0,
      coordinates: Float64Array.from(coordinates),
      columns: {
        Vm: {
          kind: 'numeric',
          values,
          offset: 0,
          length: values.length,
          rowStride: 1,
          frameStride: count,
        },
      },
    },
  ]);
}
/** A monitor 100 by 100 pixels whose plot spans it all: coordinates 0 to 10 across, values 0 to 2 up. */
async function plotted(source: Data, trace: Partial<MonitorConfig['traces'][string]> = {}) {
  const fake = fakeDevice();
  const encoder = fake.native.createCommandEncoder.getMockImplementation()!;
  fake.native.createCommandEncoder.mockImplementation(() =>
    Object.assign(encoder(), {
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    }),
  );
  Object.assign(fake.native, { createPipelineLayout: () => ({}) });
  const gpu = await createGpu({ device: fake.device });
  const target = kit.createTextureTarget(gpu, { width: 100, height: 100 });
  const monitor = createMonitor(gpu, {
    source,
    traces: { a: { from: 'Bus', y: 'Vm', ...trace } },
    camera: { x: [0, 10], y: [0, 2] },
    xAxis: false,
    yAxis: false,
    paddingPx: 0,
    hover: 'on',
  });
  const render = (at?: number) =>
    gpu.render({
      views: [{ renderer: kit.rendererOf(monitor), target, at }],
      timeMs: 0,
      completion: 'complete',
    });
  await render();
  const pick = (point: Point, radiusPx = 2) => monitor.pick(point, { radiusPx });
  return {
    gpu,
    monitor,
    render,
    pick,
    close() {
      monitor.destroy();
      target.destroy();
      gpu.destroy();
    },
  };
}
const as = <T>(monitor: Monitor) => monitor as unknown as T;

describe('picking', () => {
  it('hits a line between samples farther apart than the pick radius, reading the nearer one', async () => {
    const m = await plotted(signals([0, 10], [[1, 1]]));
    expect(await m.pick([50, 50])).toHaveLength(1);
    expect(await m.pick([30, 50])).toMatchObject([{ frame: 0, value: 1, coordinate: 0 }]);
    expect(await m.pick([70, 50])).toMatchObject([{ frame: 1, value: 1, coordinate: 10 }]);
    m.close();
  });
  it('hits a lone sample as the dot it draws', async () => {
    const m = await plotted(signals([5], [[1]]));
    expect(await m.pick([50, 50])).toMatchObject([{ frame: 0 }]);
    m.close();
  });
  it('finds each row once, not the samples near the pointer', async () => {
    const m = await plotted(signals([4.8, 4.9, 5, 5.1, 5.2], [Array(5).fill(1), Array(5).fill(1)]));
    const hits = await m.pick([50, 50]);
    expect(hits.map((hit) => hit.row).sort()).toEqual([0, 1]);
    m.close();
  });
  it('hits steps where they draw, never their diagonal', async () => {
    const before = await plotted(signals([0, 10], [[0, 2]]), { interpolation: 'step-before' });
    expect(await before.pick([50, 0])).toMatchObject([{ frame: 1, value: 2 }]);
    expect(await before.pick([0, 50])).toHaveLength(1);
    expect(await before.pick([50, 50])).toHaveLength(0);
    before.close();
    const after = await plotted(signals([0, 10], [[0, 2]]), { interpolation: 'step-after' });
    expect(await after.pick([50, 100])).toMatchObject([{ frame: 0, value: 0 }]);
    expect(await after.pick([50, 50])).toHaveLength(0);
    after.close();
  });
  it('joins no samples across a missing one, but holds a step after it', async () => {
    const linear = await plotted(signals([0, 5, 10], [[1, Number.NaN, 1]]));
    expect(await linear.pick([25, 50])).toHaveLength(0);
    linear.close();
    const held = await plotted(signals([0, 5, 10], [[1, Number.NaN, 1]]), {
      interpolation: 'step-after',
    });
    expect(await held.pick([25, 50])).toMatchObject([{ frame: 0, value: 1 }]);
    expect(await held.pick([75, 50])).toHaveLength(0);
    held.close();
  });
  it('hits a wide line across its stroke, and none of a line past the values shown', async () => {
    const thin = await plotted(signals([0, 10], [[1, 1]]));
    expect(await thin.pick([50, 58])).toHaveLength(0);
    thin.close();
    const wide = await plotted(signals([0, 10], [[1, 1]]), { widthPx: 20 });
    expect(await wide.pick([50, 58])).toHaveLength(1);
    wide.close();
    const above = await plotted(signals([0, 10], [[2.04, 2.04]]));
    expect(await above.pick([50, 0])).toHaveLength(0);
    above.close();
  });
  it('answers again without reading while the drawn lines stand, as through playback', async () => {
    const m = await plotted(signals([0, 5, 10], [[1, 1, 1]]));
    const first = await m.pick([30, 50]),
      read = () => m.gpu.stats().queries + m.gpu.stats().queryHits,
      before = read();
    await m.render(2);
    expect(await m.pick([30, 50])).toEqual(first);
    expect(read()).toBe(before);
    m.close();
  });
  it('selects a line, wherever along it a click lands, and hovers each reading along it', async () => {
    const m = await plotted(signals([0, 5, 10], [[1, 1, 1]]));
    const [hit] = await m.pick([30, 50]);
    m.monitor.select([hit]);
    const click = as<{ click(point: Point, modifiers: object): Promise<void> }>(m.monitor);
    // A toggle on another part of the selected line deselects it.
    await click.click([90, 50], { shift: true, control: false, meta: false, alt: false });
    expect(m.monitor.selection).toEqual([]);
    const hovered = vi.fn<(reading: { readonly frame: number } | null) => void>();
    m.monitor.on('hover', hovered);
    const pointer = as<{ pointer(point: Point): void }>(m.monitor),
      settle = () => new Promise((resolve) => setTimeout(resolve, 10));
    // Hover lands a frame after its search.
    for (const at of [5, 95]) {
      pointer.pointer([at, 50]);
      await m.render();
      await settle();
      await m.render();
    }
    expect(hovered.mock.calls.map(([reading]) => reading?.frame)).toEqual([0, 2]);
    m.close();
  });
});
