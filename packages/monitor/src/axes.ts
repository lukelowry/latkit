import { type Gpu, type RGBA, kit } from '@latkit/gpu';
import { buffer } from './segments.js';
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
  runs: readonly kit.TextRun[];
  lines: kit.BufferData;
  lineCount: number;
  gridCount: number;
}
export function plot(view: kit.Viewport, options: Style): Plot {
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
export async function axes(
  gpu: Gpu,
  view: kit.Viewport,
  x: Domain,
  y: Domain,
  options: Style,
  signal: AbortSignal,
): Promise<Axes> {
  const area = plot(view, options),
    runs: kit.TextRun[] = [],
    lines: number[] = [],
    grid: number[] = [];
  const sx = kit.resolveScale({ range: [area.x, area.x + area.width] }, x),
    sy = kit.resolveScale({ range: [area.y + area.height, area.y] }, y),
    size = options.fontSizePx;
  const line = (a: number, b: number, c: number, d: number, color: RGBA) =>
    (color === options.gridColor ? grid : lines).push(a, b, c, d, ...color);
  const label = async (
    text: string,
    px: number,
    py: number,
    align: 'left' | 'center' | 'right',
  ) => {
    const metric = await gpu.measureText({ text, font: options.font }, { signal }),
      width = metric.advance * size;
    runs.push({
      text,
      font: options.font,
      size,
      position: [px - (align === 'center' ? width / 2 : align === 'right' ? width : 0), py],
      color: options.textColor,
    });
    return width;
  };
  if (options.coordinateAxis !== null) {
    const axis = options.coordinateAxis,
      t = ticks(x, area.width, axis);
    let end = -Infinity;
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
      const text = tick.label ?? String(tick.value),
        metric = await gpu.measureText({ text, font: options.font }, { signal }),
        width = metric.advance * size;
      if (px - width / 2 >= end + 6) {
        await label(text, px, area.y + area.height + size * 1.5, 'center');
        end = px + width / 2;
      }
    }
    const caption = [axis.label, t.offset ? '+' + String(t.offset) : ''].filter(Boolean).join('  ');
    if (caption) await label(caption, area.x + area.width, view.height - 4, 'right');
  }
  if (options.valueAxis !== null) {
    const axis = options.valueAxis,
      t = ticks(y, area.height, { minSpacingPx: 40, ...axis });
    line(area.x, area.y, area.x, area.y + area.height, options.axisColor);
    for (const tick of t.items) {
      const py = kit.scaleValue(tick.value, sy)!;
      if (axis.grid !== false) line(area.x, py, area.x + area.width, py, options.gridColor);
      await label(tick.label ?? String(tick.value), area.x - 8, py + size * 0.3, 'right');
    }
    const caption = [axis.label, t.offset ? '+' + String(t.offset) : ''].filter(Boolean).join('  ');
    if (caption) await label(caption, area.x, Math.max(size, area.y - 8), 'left');
  }
  return {
    plot: area,
    runs,
    lines: buffer(new Float32Array([...grid, ...lines]), 'monitor axes'),
    gridCount: grid.length / 8,
    lineCount: lines.length / 8,
  };
}
