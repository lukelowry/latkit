/**
 * `@latkit/diagram/layout` -- the diagram's automatic layout without a device or a DOM, so a
 * worker computes exactly the positions the diagram shows.
 *
 * @packageDocumentation
 */

import { validateNetlist, type Netlist } from '@latkit/model';

import { prepare } from '../prepare.js';
import { arrangeAll } from './arrange.js';

/** The grid pitch `arrange` assumes, the diagram's own `gridPitch` default. */
const DEFAULT_GRID = 8;

/**
 * Arrange a netlist: every block's top-left corner, 2 floats per block, snapped to the grid.
 * Pure and deterministic, so a worker computes the same layout the diagram shows.
 *
 * @remarks
 * Blocks arrange in units (a group, or a component of wired ungrouped blocks), each laid out in
 * layers along its signal flow with feedback returning underneath, then packed in rows six grid
 * steps apart. A unit's rectangle holds its wires, their labels, and its group's frame. Units of
 * one shape share one layout.
 *
 * @param netlist - A netlist `validateNetlist` accepts.
 * @param options - `gridPitch` is the grid pitch the diagram draws at, in diagram units.
 *   @defaultValue `{ gridPitch: 8 }`
 * @throws Error when the netlist is invalid.
 * @throws RangeError when `gridPitch` is not a finite number greater than 0.
 */
export function arrange(netlist: Netlist, options?: { readonly gridPitch?: number }): Float32Array {
  const grid: unknown = options?.gridPitch ?? DEFAULT_GRID;
  if (typeof grid !== 'number' || !Number.isFinite(grid) || grid <= 0) {
    throw new RangeError('diagram arrange gridPitch must be a finite number greater than 0');
  }
  validateNetlist(netlist);
  return arrangeAll(prepare(netlist, grid));
}
