/**
 * Whole arrangements: every unit laid out once per shape and packed, or some units re-laid out
 * where they stand. The scene's entry points; the public subpath exports only `arrange`.
 */

import { ceilTo, snapTo } from '../geometry.js';
import type { Prepared } from '../prepare.js';
import { Frames, packUnits, Shelf, SHELF_TRIES, UNIT_GAP } from './pack.js';
import { Layouts } from './shapes.js';
import { units } from './units.js';

/**
 * Arrange every unit and pack the units: every block's top-left, 2 floats per block.
 *
 * @remarks
 * Units of one shape share one layout, computed on first sight. Units pack in unit order, six
 * grid steps apart; a unit's rectangle holds its wires, their labels, and its group's frame, so
 * no two frames come closer. Every top-left is a grid multiple.
 */
export function arrangeAll(prepared: Prepared): Float32Array {
  const g = prepared.metrics.grid;
  const positions = new Float32Array(2 * prepared.blockCount);
  const all = units(prepared);
  const lay = new Layouts(prepared);
  const widths = new Float32Array(all.count);
  const heights = new Float32Array(all.count);
  for (let unit = 0; unit < all.count; unit++) {
    const layout = lay.place(all.blocks, all.start[unit]!, all.start[unit + 1]!, positions);
    widths[unit] = layout.width;
    heights[unit] = layout.height;
  }
  const origins = packUnits(widths, heights, UNIT_GAP * g);
  for (let unit = 0; unit < all.count; unit++) {
    const x = origins[2 * unit]!;
    const y = origins[2 * unit + 1]!;
    for (let at = all.start[unit]!; at < all.start[unit + 1]!; at++) {
      const block = all.blocks[at]!;
      positions[2 * block]! += x;
      positions[2 * block + 1]! += y;
    }
  }
  return positions;
}

/**
 * Re-lay out the units containing `blocks`, each anchored at its current top-left in
 * `positions` (in-out).
 *
 * @remarks
 * A unit's top-left is where its blocks' extents start: the least `x - left` and `y - top` over
 * its blocks with a finite position, so re-laying out an arranged unit leaves it in place. Other
 * units never move, and a re-laid unit keeps `UNIT_GAP` grid steps between its rectangle and the
 * rectangle every other unit is drawn in (`Frames`), as a packing keeps them: one that grew into
 * that gap slides down from its anchor a pitch at a time, up to 64, until it clears it. One that
 * finds no room there, or has no finite position, lands on a shelf below everything else.
 */
export function arrangeUnits(
  prepared: Prepared,
  positions: Float32Array,
  blocks: Uint32Array,
): void {
  const { blockCount, extent } = prepared;
  const g = prepared.metrics.grid;
  const all = units(prepared);
  const touched = new Uint8Array(all.count);
  let any = false;
  for (const block of blocks) {
    if (block >= blockCount) continue;
    touched[all.unitOf[block]!] = 1;
    any = true;
  }
  if (!any) return;
  const lay = new Layouts(prepared);
  // The untouched units, where they stand; each re-laid unit joins them once it lands.
  const frames = new Frames(prepared, all);
  frames.addDrawn(lay, positions, touched);
  const relative = new Float32Array(2 * blockCount);
  const land = (unit: number, x: number, y: number, width: number, height: number): void => {
    for (let at = all.start[unit]!; at < all.start[unit + 1]!; at++) {
      const block = all.blocks[at]!;
      positions[2 * block] = x + relative[2 * block]!;
      positions[2 * block + 1] = y + relative[2 * block + 1]!;
    }
    frames.add(unit, x, y, x + width, y + height);
  };
  const shelved: number[] = [];
  for (let unit = 0; unit < all.count; unit++) {
    if (!touched[unit]) continue;
    const from = all.start[unit]!;
    const to = all.start[unit + 1]!;
    const { width, height } = lay.place(all.blocks, from, to, relative);
    let anchorX = Infinity;
    let anchorY = Infinity;
    let startX = Infinity;
    let startY = Infinity;
    for (let at = from; at < to; at++) {
      const block = all.blocks[at]!;
      const left = ceilTo(extent[4 * block]!, g);
      const top = ceilTo(extent[4 * block + 1]!, g);
      startX = Math.min(startX, relative[2 * block]! - left);
      startY = Math.min(startY, relative[2 * block + 1]! - top);
      const x = positions[2 * block]!;
      const y = positions[2 * block + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      anchorX = Math.min(anchorX, x - left);
      anchorY = Math.min(anchorY, y - top);
    }
    const originX = snapTo(anchorX - startX, g);
    const originY =
      anchorX !== Infinity
        ? frames.slide(unit, originX, snapTo(anchorY - startY, g), width, height)
        : Number.NaN;
    if (Number.isNaN(originY)) shelved.push(unit);
    else land(unit, originX, originY, width, height);
  }
  if (shelved.length === 0) return;
  const shelf = new Shelf(frames.bounds, UNIT_GAP * g, 0, g);
  for (const unit of shelved) {
    const { width, height } = lay.place(
      all.blocks,
      all.start[unit]!,
      all.start[unit + 1]!,
      relative,
    );
    for (let tries = 0; ; tries++) {
      shelf.place(width, height);
      if (frames.clear(unit, shelf.x, shelf.y, shelf.x + width, shelf.y + height)) break;
      if (tries === SHELF_TRIES) break;
    }
    land(unit, shelf.x, shelf.y, width, height);
  }
}
