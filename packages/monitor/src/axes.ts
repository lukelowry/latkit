import { type Gpu, type Point, type RGBA, kit, type Viewport } from '@latkit/gpu';
import { buffer } from './rendering/painter.js';
import type { Domain } from '@latkit/model';
import type { Style } from './config.js';
import { insets } from './config.js';
import { ticks, type Ticks } from './ticks.js';
export interface Plot {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Axes {
  plot: Plot;
  /** Tick labels and captions, as the monitor's text bank last placed them. */
  text: readonly kit.TextBankPage[];
  lines: kit.BufferData;
  lineCount: number;
  gridCount: number;
}
/**
 * The plot inside a view, less the room its axes write in: their tick labels where shown, and a
 * row for each label. The room follows from the options alone, never the window, so the plot and
 * its history keep their size as the window moves.
 */
export function plot(view: Viewport, options: Style): Plot {
  const [top, right, bottom, left] = insets(options.paddingPx),
    size = options.fontSizePx,
    { xAxis, yAxis } = options;
  const x = left + (yAxis && yAxis.tickLabels !== false ? Math.max(64, size * 7) : 0),
    y = top + (yAxis?.label ? size * 1.8 : 0),
    below =
      (xAxis && xAxis.tickLabels !== false ? size * 1.8 : 0) + (xAxis?.label ? size * 1.2 : 0);
  return {
    x,
    y,
    width: Math.max(1, view.width - x - right),
    height: Math.max(1, view.height - y - bottom - below),
  };
}
/** Whether a canvas point lies on a plot. */
export function onPlot(p: Plot, point: Point): boolean {
  return (
    point[0] >= p.x && point[0] <= p.x + p.width && point[1] >= p.y && point[1] <= p.y + p.height
  );
}
/** The canvas x of a coordinate on a plot of `window`, and its inverse. */
export function plotX(p: Plot, window: Domain, coordinate: number): number {
  return p.x + ((coordinate - window[0]) / (window[1] - window[0])) * p.width;
}
export function plotCoordinate(p: Plot, window: Domain, x: number): number {
  return window[0] + ((x - p.x) / p.width) * (window[1] - window[0]);
}
/** The canvas y of a value on a plot of `values`. */
export function plotY(p: Plot, values: Domain, value: number): number {
  return p.y + ((values[1] - value) / (values[1] - values[0])) * p.height;
}
export async function axes(
  gpu: Gpu,
  view: Viewport,
  x: Domain,
  y: Domain,
  options: Style,
  signal: AbortSignal,
  /** The monitor's labels by text, so ticks that stay keep their glyphs as the window moves. */
  text: kit.TextBank,
): Promise<Axes> {
  text.hide();
  const area = plot(view, options),
    lines: number[] = [],
    grid: number[] = [];
  const sx = kit.resolveScale({ range: [area.x, area.x + area.width] }, x),
    sy = kit.resolveScale({ range: [area.y + area.height, area.y] }, y),
    size = options.fontSizePx,
    right = area.x + area.width,
    bottom = area.y + area.height;
  const line = (a: number, b: number, c: number, d: number, color: RGBA) =>
    (color === options.gridColor ? grid : lines).push(a, b, c, d, ...color);
  /** `value` with its `align` side and `baseline` at `at`; with `room`, only where it is free. */
  const label = async (
    key: string,
    value: string,
    at: Point,
    align: kit.TextAlign,
    baseline: kit.TextBaseline,
    room?: kit.Occupancy,
  ) => {
    const layout = await gpu.layoutText(
      { text: value, font: options.font, size, color: options.textColor },
      { signal },
    );
    if (!room) text.add(key, layout, kit.textOrigin(layout, at, align, baseline));
    else text.place(key, layout, [[at[0], at[1], align, baseline]], room, { margin: 3 });
  };
  /**
   * An axis's tick labels at `places`, each where no other of its own lies. The offset they share
   * comes first, at `offset` on its `side`, so a tick it would cover goes unlabelled.
   */
  const tickLabels = async (
    name: string,
    t: Ticks,
    places: readonly Point[],
    align: kit.TextAlign,
    baseline: kit.TextBaseline,
    offset: Point,
    side: kit.TextAlign,
  ) => {
    const room = new kit.Occupancy();
    if (t.offset) {
      const value = (t.offset > 0 ? '+' : '') + String(t.offset);
      await label(name + ' offset', value, offset, side, 'top', room);
    }
    for (let i = 0; i < t.items.length; i++) {
      const value = t.items[i].label ?? String(t.items[i].value);
      await label(name + value, value, places[i], align, baseline, room);
    }
  };
  if (options.xAxis !== null) {
    const axis = options.xAxis,
      t = ticks(x, area.width, axis),
      at = t.items.map((tick) => kit.scaleValue(tick.value, sx)!),
      row = bottom + size * 0.5;
    line(area.x, bottom, right, bottom, options.axisColor);
    if (axis.grid !== false) for (const px of at) line(px, area.y, px, bottom, options.gridColor);
    if (axis.tickLabels !== false)
      // The offset ends the row at the plot's right.
      await tickLabels(
        'x',
        t,
        at.map((px): Point => [px, row]),
        'center',
        'top',
        [right, row],
        'end',
      );
    if (axis.label)
      await label('x caption', axis.label, [right, view.height - 4], 'end', 'alphabetic');
  }
  if (options.yAxis !== null) {
    const axis = options.yAxis,
      t = ticks(y, area.height, { minSpacingPx: 40, ...axis }),
      at = t.items.map((tick) => kit.scaleValue(tick.value, sy)!),
      column = area.x - 8;
    line(area.x, area.y, area.x, bottom, options.axisColor);
    if (axis.grid !== false) for (const py of at) line(area.x, py, right, py, options.gridColor);
    if (axis.tickLabels !== false)
      // The offset tops the column from its left edge, so a long one runs toward the plot, never
      // off the view.
      await tickLabels(
        'y',
        t,
        at.map((py): Point => [column, py]),
        'end',
        'middle',
        [insets(options.paddingPx)[3], area.y],
        'start',
      );
    if (axis.label)
      await label(
        'y caption',
        axis.label,
        [area.x, Math.max(size, area.y - 8)],
        'start',
        'alphabetic',
      );
  }
  // An outline closes the plot on the sides its axes leave open.
  if (options.outline) {
    line(area.x, area.y, right, area.y, options.axisColor);
    line(right, area.y, right, bottom, options.axisColor);
    if (options.xAxis === null) line(area.x, bottom, right, bottom, options.axisColor);
    if (options.yAxis === null) line(area.x, area.y, area.x, bottom, options.axisColor);
  }
  return {
    plot: area,
    text: text.flush(),
    lines: buffer(new Float32Array([...grid, ...lines]), 'monitor axes'),
    gridCount: grid.length / 8,
    lineCount: lines.length / 8,
  };
}
