/**
 * Sizing shared by layout, routing, picking, text, and the passes: every length a diagram draws
 * derives from one grid pitch, so a diagram at any pitch is the same diagram scaled.
 */

import { ADVANCE, columns, LINE } from './text/metrics.js';

/** An axis-aligned rectangle in diagram units: `[x0, y0, x1, y1]`, y down. */
export type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

/** Everything that sizes a diagram, derived from the grid pitch `g`; diagram units throughout. */
export interface Metrics {
  /** The grid pitch `g`: every top-left, port, and wire corner lands on it. */
  readonly grid: number;
  /** `2g`: port spacing and the block size quantum. */
  readonly pitch: number;
  /** `1.5g`: block title em size. */
  readonly titleEm: number;
  /** `1.25g`: em size of block labels, port labels, net labels, and tags. */
  readonly labelEm: number;
  /** `1.5g`: group label em size. */
  readonly groupEm: number;
  /** `g`: port marker extent. */
  readonly portSize: number;
  /** `0.75g`: a left or right port label's inset from the block edge. */
  readonly inset: number;
  /**
   * `2g`, one pitch: the strip inside a block's top or bottom edge that holds the labels of the
   * ports on that edge, tall enough for one label line. Side ports and the title sit between.
   */
  readonly band: number;
  /**
   * `g`: the clear space a block's title keeps from every other text of the block, and that
   * labels or tags along a top or bottom edge keep between neighbors.
   */
  readonly textGap: number;
  /** `0.5g`: block corner radius. */
  readonly radius: number;
  /** `2g`: straight run a wire keeps leaving or entering a port. */
  readonly stub: number;
  /** `2g`: tag pill height. */
  readonly tagHeight: number;
  /** `0.5g`: space between a port and its tag pill. */
  readonly tagGap: number;
  /** `0.5g`: text padding at each end of a tag pill. */
  readonly tagPad: number;
  /** `0.5g`: space between a block and the label under it. */
  readonly labelGap: number;
  /** `2g`: group frame padding around member extents. */
  readonly groupPad: number;
  /** `3g`: group frame header strip. */
  readonly groupHeader: number;
}

/** Every sizing constant for grid pitch `grid`. */
export function metrics(grid: number): Metrics {
  return Object.freeze({
    grid,
    pitch: 2 * grid,
    titleEm: 1.5 * grid,
    labelEm: 1.25 * grid,
    groupEm: 1.5 * grid,
    portSize: grid,
    inset: 0.75 * grid,
    band: 2 * grid,
    textGap: grid,
    radius: 0.5 * grid,
    stub: 2 * grid,
    tagHeight: 2 * grid,
    tagGap: 0.5 * grid,
    tagPad: 0.5 * grid,
    labelGap: 0.5 * grid,
    groupPad: 2 * grid,
    groupHeader: 3 * grid,
  });
}

/** Width of `text` at em size `em`, in diagram units: its columns times one advance. */
export function textWidth(text: string, em: number): number {
  return columns(text) * ADVANCE * em;
}

/**
 * The line box of the label drawn over a wired net whose anchor is at `(x, y)`, into `out` as
 * `[x0, y0, x1, y1]`: from half a grid step right of the anchor, `width` wide, with its bottom a
 * quarter grid step above the wire and `LINE * labelEm` tall. The text pass draws the run from the
 * box's top-left; group frames, fit bounds, and the layout's reach hold all of it, so all of them
 * place it here.
 *
 * @param width - The label's width: `textWidth(label, labelEm)`.
 * @returns `out`.
 */
export function netLabelBox<T extends Float64Array | number[]>(
  m: Metrics,
  x: number,
  y: number,
  width: number,
  out: T,
): T {
  const left = x + 0.5 * m.grid;
  const bottom = y - 0.25 * m.grid;
  out[0] = left;
  out[1] = bottom - LINE * m.labelEm;
  out[2] = left + width;
  out[3] = bottom;
  return out;
}

/**
 * `value` rounded up to a multiple of `quantum`. A value within float noise of a multiple stays
 * on it, so `columns * ADVANCE * em` never gains a spurious quantum.
 */
export function ceilTo(value: number, quantum: number): number {
  return multiple(Math.ceil(value / quantum - 1e-9), quantum);
}

/** `value` rounded to the nearest multiple of `quantum`. */
export function snapTo(value: number, quantum: number): number {
  return multiple(Math.round(value / quantum), quantum);
}

/** `steps` quanta, with a zero that is never `-0`. */
function multiple(steps: number, quantum: number): number {
  return steps === 0 ? 0 : steps * quantum;
}
