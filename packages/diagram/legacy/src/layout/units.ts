/**
 * Arrangement units: the pieces a layout lays out one at a time and packs side by side. A group is
 * one unit, so a plant keeps its frame; ungrouped blocks join the units their wires reach.
 */

import { NONE, STYLE_WIRE, type Prepared } from '../prepare.js';

/**
 * Arrangement units: a group when blocks have one, else a component over wired (style 0) nets
 * among ungrouped blocks; an isolated block is its own unit. Deterministic order: by lowest block.
 */
export interface Units {
  /** Number of units. */
  readonly count: number;
  /** Unit `u` holds blocks `blocks[start[u]]` up to `blocks[start[u + 1]]`, ascending. */
  readonly start: Uint32Array;
  readonly blocks: Uint32Array;
  /** Per block: its unit. */
  readonly unitOf: Uint32Array;
}

/**
 * Partition a prepared netlist's blocks into arrangement units.
 *
 * @remarks
 * A wire between a grouped and an ungrouped block, or between two groups, joins nothing: groups
 * stay whole and an ungrouped block wired only into groups is its own unit. Empty groups have no
 * unit. Linear in blocks plus net ports.
 */
export function units(prepared: Prepared): Units {
  const { blockCount, blockGroup, groupCount, groupStart, groupBlocks, netCount, netStyle } =
    prepared;
  const { portBlock } = prepared;
  const { netStart, netPorts } = prepared.netlist;

  // Union-find over blocks, halving paths as it walks.
  const parent = new Uint32Array(blockCount);
  for (let block = 0; block < blockCount; block++) parent[block] = block;
  const find = (block: number): number => {
    let at = block;
    while (parent[at] !== at) {
      const up = parent[parent[at]!]!;
      parent[at] = up;
      at = up;
    }
    return at;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra < rb) parent[rb] = ra;
    else if (rb < ra) parent[ra] = rb;
  };

  for (let group = 0; group < groupCount; group++) {
    const first = groupStart[group]!;
    for (let at = first + 1; at < groupStart[group + 1]!; at++) {
      join(groupBlocks[first]!, groupBlocks[at]!);
    }
  }
  for (let net = 0; net < netCount; net++) {
    if (netStyle[net] !== STYLE_WIRE) continue;
    let anchor = NONE;
    for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
      const block = portBlock[netPorts[at]!]!;
      if (blockGroup[block] !== NONE) continue;
      if (anchor === NONE) anchor = block;
      else join(anchor, block);
    }
  }

  // Number units as their lowest block appears, then bucket blocks by unit in ascending order.
  const unitOf = new Uint32Array(blockCount);
  const unitOfRoot = new Uint32Array(blockCount).fill(NONE);
  let count = 0;
  for (let block = 0; block < blockCount; block++) {
    const root = find(block);
    if (unitOfRoot[root] === NONE) unitOfRoot[root] = count++;
    unitOf[block] = unitOfRoot[root]!;
  }
  const start = new Uint32Array(count + 1);
  for (let block = 0; block < blockCount; block++) start[unitOf[block]! + 1]!++;
  for (let unit = 0; unit < count; unit++) start[unit + 1]! += start[unit]!;
  const blocks = new Uint32Array(blockCount);
  const fill = start.slice(0, count);
  for (let block = 0; block < blockCount; block++) blocks[fill[unitOf[block]!]!++] = block;
  return { count, start, blocks, unitOf };
}
