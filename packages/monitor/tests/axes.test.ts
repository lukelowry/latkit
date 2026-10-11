import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  kit,
  type Gpu,
  type Point,
  type TextLayout,
  type TextLayoutInput,
  type Viewport,
} from '@latkit/gpu';
import type { Domain } from '@latkit/model';
import { axes, plot } from '../src/axes.js';
import { resolveStyle, VIEW_DEFAULTS } from '../src/config.js';
import type { MonitorStyle } from '../src/options.js';
import { ticks } from '../src/ticks.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';

// The WebGPU usage flags text pages are made with.
beforeEach(() => void fakeDevice());

/** Text 0.6 of its size wide a character, as a monospace face lays it. */
const layoutText = (input: TextLayoutInput): Promise<TextLayout> => {
  const size = input.size ?? 12;
  return Promise.resolve({
    runs: [
      { text: input.text, font: input.font, color: input.color, size, position: [0, size * 0.8] },
    ],
    width: [...input.text].length * 0.6 * size,
    height: size,
    baseline: size * 0.8,
    lineHeight: size,
    capHeight: size * 0.7,
    align: input.align ?? 'start',
  });
};
const gpu = { layoutText } as unknown as Gpu,
  view: Viewport = { width: 400, height: 200, pixelRatio: 1 },
  // The default font size and padding.
  size = 12,
  pad = 12;
const style = (config: MonitorStyle) =>
  resolveStyle(config, kit.resolveViewStyle({}, VIEW_DEFAULTS));
interface Shown {
  readonly text: string;
  readonly box: kit.Bounds2D;
}
/** What the axes draw over a window and values: the plot, line counts, and each text by key. */
async function draw(config: MonitorStyle, x: Domain = [0, 10], y: Domain = [0, 1]) {
  const bank = new kit.TextBank({ label: 'axes' }),
    add = vi.spyOn(bank, 'add'),
    drawn = await axes(gpu, view, x, y, style(config), new AbortController().signal, bank);
  const shown = new Map<string, Shown>(
    add.mock.calls.map(([key, layout, origin]) => [
      key as string,
      { text: layout.runs[0].text, box: kit.textBox(layout, origin as Point) },
    ]),
  );
  return { ...drawn, shown };
}
const overlaps = (a: kit.Bounds2D, b: kit.Bounds2D) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

describe('axes', () => {
  it('leave room only for what they write, whatever the window', async () => {
    const area = (config: MonitorStyle) => plot(view, style(config)),
      column = Math.max(64, size * 7);
    // Tick labels below and beside the plot.
    expect(area({})).toEqual({
      x: pad + column,
      y: pad,
      width: view.width - pad - column - pad,
      height: view.height - pad - pad - size * 1.8,
    });
    // Each label adds its row.
    const titled = area({ xAxis: 'Time', yAxis: 'Value' });
    expect(titled.y).toBeCloseTo(pad + size * 1.8);
    expect(titled.height).toBeCloseTo(view.height - pad - size * 1.8 - pad - size * 3);
    // Without tick labels an axis takes no room but its label's.
    expect(area({ xAxis: { tickLabels: false }, yAxis: { tickLabels: false } })).toEqual({
      x: pad,
      y: pad,
      width: view.width - 2 * pad,
      height: view.height - 2 * pad,
    });
    expect(area({ xAxis: { label: 'Time', tickLabels: false } }).height).toBeCloseTo(
      view.height - 2 * pad - size * 1.2,
    );
    expect(area({ xAxis: false, yAxis: false })).toEqual(
      area({ xAxis: { tickLabels: false }, yAxis: { tickLabels: false } }),
    );
    // Ticks far from zero share an offset, and the plot keeps its size.
    const far: Domain = [2 ** 40, 2 ** 40 + 1];
    expect((await draw({}, far, far)).plot).toEqual((await draw({})).plot);
  });

  it('keep an axis line and grid without tick labels', async () => {
    const labelled = await draw({}),
      bare = await draw({ xAxis: { tickLabels: false }, yAxis: { tickLabels: false } });
    expect(labelled.shown.size).toBeGreaterThan(0);
    expect(bare.shown.size).toBe(0);
    expect(bare.lineCount).toBe(2);
    expect(bare.gridCount).toBeGreaterThan(0);
    // A label stays without them.
    const titled = await draw({ xAxis: { label: 'Time', tickLabels: false }, yAxis: false });
    expect([...titled.shown.values()].map((s) => s.text)).toEqual(['Time']);
  });

  it('write a shared offset where the tick labels end, within their room', async () => {
    const far: Domain = [2 ** 40, 2 ** 40 + 1],
      { plot: area, shown } = await draw({}, far, far),
      bottom = area.y + area.height;
    const x = shown.get('x offset')!,
      y = shown.get('y offset')!;
    expect(x.text).toBe('+' + String(2 ** 40));
    expect(y.text).toBe('+' + String(2 ** 40));
    // The x offset ends the tick row at the plot's right, inside the room below the plot.
    expect(x.box[2]).toBeCloseTo(area.x + area.width);
    expect(x.box[1]).toBeGreaterThanOrEqual(bottom);
    expect(x.box[3]).toBeLessThanOrEqual(bottom + size * 1.8);
    // The y offset tops the tick column from its left edge, on the view.
    expect(y.box[0]).toBe(pad);
    expect(y.box[1]).toBe(area.y);
    // Ticks still label where neither offset lies, and none overlaps one.
    const ticks = [...shown].filter(([key]) => !key.endsWith('offset'));
    expect(ticks.some(([key]) => key.startsWith('x'))).toBe(true);
    expect(ticks.some(([key]) => key.startsWith('y'))).toBe(true);
    for (const [, tick] of ticks)
      for (const offset of [x, y]) expect(overlaps(tick.box, offset.box)).toBe(false);
    // A label keeps its own row.
    const titled = await draw({ xAxis: 'Time' }, far, far);
    expect(titled.shown.get('x caption')!.text).toBe('Time');
    expect(titled.shown.get('x offset')!.box[3]).toBeLessThanOrEqual(
      titled.shown.get('x caption')!.box[1],
    );
  });

  it('offset far ticks from a rounded start that stands as the window moves', async () => {
    const before = ticks([599998.97, 600001.03], 300, {}),
      after = ticks([599999.42, 600001.48], 300, {});
    expect(before.offset).toBe(599990);
    expect(after.offset).toBe(599990);
    // Ticks fall on their step, so those both windows show keep their labels.
    const kept = before.items.filter((tick) => after.items.some((t) => t.value === tick.value));
    expect(kept.length).toBeGreaterThan(1);
    for (const tick of kept)
      expect(after.items.find((t) => t.value === tick.value)!.label).toBe(tick.label);
    // Below zero, the offset reads as the number it is.
    const below = await draw({}, [0, 10], [-600001.03, -599998.97]);
    expect(below.shown.get('y offset')!.text).toBe('-600010');
  });

  it('outline the sides of the plot its axes leave open', async () => {
    const lines = async (config: MonitorStyle) => {
      const drawn = await draw(config),
        values = new Float32Array(
          drawn.lines.bytes.buffer,
          drawn.lines.bytes.byteOffset,
          (drawn.gridCount + drawn.lineCount) * 8,
        );
      // Axis lines follow the grid: each a segment and its color.
      return Array.from({ length: drawn.lineCount }, (_, i) =>
        Array.from(values.subarray((drawn.gridCount + i) * 8, (drawn.gridCount + i) * 8 + 4)),
      );
    };
    expect(await lines({})).toHaveLength(2);
    const framed = await lines({ outline: true }),
      area = plot(view, style({})),
      [right, bottom] = [area.x + area.width, area.y + area.height];
    expect(framed).toHaveLength(4);
    expect(framed).toContainEqual([area.x, area.y, right, area.y].map(Math.fround));
    expect(framed).toContainEqual([right, area.y, right, bottom].map(Math.fround));
    // Without axes, the outline closes every side.
    expect(await lines({ outline: true, xAxis: false, yAxis: false })).toHaveLength(4);
    expect(() => style({ outline: 1 as unknown as boolean })).toThrow('Invalid outline');
    expect(() => style({ xAxis: { tickLabels: 'no' as unknown as boolean } })).toThrow(
      'Invalid axis tickLabels',
    );
  });
});
