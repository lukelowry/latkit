import {
  type Gpu,
  type Point,
  type RGBA,
  type TextAlign,
  type TextBaseline,
  kit,
  type Viewport,
} from '@latkit/gpu';
import { buffer } from './rendering/painter.js';
import type { Domain } from '@latkit/model';
import type { Style } from './config.js';
import { insets } from './config.js';
import { ticks } from './ticks.js';
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
export function plot(view: Viewport, options: Style): Plot {
  const [top, right, bottom, left] = insets(options.paddingPx),
    size = options.fontSizePx;
  const x = left + (options.valueAxis === null ? 0 : Math.max(64, size * 7)),
    y = top + (options.valueAxis?.label ? size * 1.8 : 0);
  return {
    x,
    y,
    width: Math.max(1, view.width - x - right),
    height: Math.max(
      1,
      view.height - y - bottom - (options.coordinateAxis === null ? 0 : size * 3),
    ),
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
    grid: number[] = [],
    // Tick labels skip where one already placed would overlap them.
    occupied = new kit.Occupancy();
  const sx = kit.resolveScale({ range: [area.x, area.x + area.width] }, x),
    sy = kit.resolveScale({ range: [area.y + area.height, area.y] }, y),
    size = options.fontSizePx;
  const line = (a: number, b: number, c: number, d: number, color: RGBA) =>
    (color === options.gridColor ? grid : lines).push(a, b, c, d, ...color);
  /** `value` with its `align` side and `baseline` at `at`; with `spacing`, only where it is free. */
  const label = async (
    key: string,
    value: string,
    at: Point,
    align: TextAlign,
    baseline: TextBaseline,
    spacing?: number,
  ) => {
    const layout = await gpu.layoutText(
      { text: value, font: options.font, size, color: options.textColor },
      { signal },
    );
    if (spacing === undefined) text.add(key, layout, kit.textOrigin(layout, at, align, baseline));
    else text.place(key, layout, [[at[0], at[1], align, baseline]], occupied, { margin: spacing });
  };
  if (options.coordinateAxis !== null) {
    const axis = options.coordinateAxis,
      t = ticks(x, area.width, axis);
    line(
      area.x,
      area.y + area.height,
      area.x + area.width,
      area.y + area.height,
      options.axisColor,
    );
    for (const tick of t.items) {
      const px = kit.scaleValue(tick.value, sx)!;
      if (axis.grid !== false) line(px, area.y, px, area.y + area.height, options.gridColor);
      const value = tick.label ?? String(tick.value);
      await label('x' + value, value, [px, area.y + area.height + size * 0.5], 'center', 'top', 3);
    }
    const caption = [axis.label, t.offset ? '+' + String(t.offset) : ''].filter(Boolean).join('  ');
    if (caption)
      await label(
        'x caption',
        caption,
        [area.x + area.width, view.height - 4],
        'end',
        'alphabetic',
      );
  }
  if (options.valueAxis !== null) {
    const axis = options.valueAxis,
      t = ticks(y, area.height, { minSpacingPx: 40, ...axis });
    line(area.x, area.y, area.x, area.y + area.height, options.axisColor);
    for (const tick of t.items) {
      const py = kit.scaleValue(tick.value, sy)!;
      if (axis.grid !== false) line(area.x, py, area.x + area.width, py, options.gridColor);
      const value = tick.label ?? String(tick.value);
      await label('y' + value, value, [area.x - 8, py], 'end', 'middle');
    }
    const caption = [axis.label, t.offset ? '+' + String(t.offset) : ''].filter(Boolean).join('  ');
    if (caption)
      await label(
        'y caption',
        caption,
        [area.x, Math.max(size, area.y - 8)],
        'start',
        'alphabetic',
      );
  }
  return {
    plot: area,
    text: text.flush(),
    lines: buffer(new Float32Array([...grid, ...lines]), 'monitor axes'),
    gridCount: grid.length / 8,
    lineCount: lines.length / 8,
  };
}
