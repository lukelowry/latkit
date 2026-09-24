/**
 * An ASCII rendering of an arranged diagram, for eyeballing a layout in test output: boxes with
 * their titles and ports, block labels under them, tags above, and wires routed the way the
 * orthogonal router draws them (a trunk halfway to the nearest forward reader, U-turns through a
 * lane under the blocks).
 */

import { units } from '../../src/layout/units.js';
import {
  FLOW_BOTH,
  FLOW_IN,
  NONE,
  STYLE_TAG,
  STYLE_WIRE,
  type Prepared,
} from '../../src/prepare.js';

const H = 1;
const V = 2;

/**
 * Draw `blocks` (every block by default) at `positions`. One column is half a grid step and one
 * row a grid step, so boxes keep their aspect in a monospace font.
 */
export function ascii(
  prepared: Prepared,
  positions: Float32Array,
  blocks: ArrayLike<number> = Array.from({ length: prepared.blockCount }, (_, b) => b),
): string {
  const { size, extent, portOffset, portBlock, portNet, portSide, netDriver, netStyle } = prepared;
  const { portStart, portFlow, netStart, netPorts, blockTitle, blockLabel, netLabel } =
    prepared.netlist;
  const g = prepared.metrics.grid;
  const arranged = units(prepared);
  const drawn = new Set(Array.from(blocks));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let bottom = -Infinity;
  for (const b of drawn) {
    const x = positions[2 * b]!;
    const y = positions[2 * b + 1]!;
    x0 = Math.min(x0, x - extent[4 * b]! - 3 * g);
    y0 = Math.min(y0, y - extent[4 * b + 1]! - g);
    x1 = Math.max(x1, x + size[2 * b]! + extent[4 * b + 2]! + 3 * g);
    bottom = Math.max(bottom, y + size[2 * b + 1]! + extent[4 * b + 3]!);
  }
  const y1 = bottom + 8 * g;
  const col = (x: number): number => Math.round((x - x0) / (g / 2));
  const row = (y: number): number => Math.round((y - y0) / g);
  const cols = col(x1) + 1;
  const rows = row(y1) + 1;
  const text: string[][] = Array.from({ length: rows }, () => new Array<string>(cols).fill(''));
  const wire = new Uint8Array(rows * cols);
  const put = (r: number, c: number, s: string): void => {
    for (let i = 0; i < s.length; i++) {
      if (r >= 0 && r < rows && c + i >= 0 && c + i < cols) text[r]![c + i] = s[i]!;
    }
  };
  const segment = (ax: number, ay: number, bx: number, by: number): void => {
    const r0 = row(Math.min(ay, by));
    const r1 = row(Math.max(ay, by));
    const c0 = col(Math.min(ax, bx));
    const c1 = col(Math.max(ax, bx));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) wire[r * cols + c]! |= ay === by ? H : V;
    }
  };
  const portX = (p: number): number => positions[2 * portBlock[p]!]! + portOffset[2 * p]!;
  const portY = (p: number): number => positions[2 * portBlock[p]! + 1]! + portOffset[2 * p + 1]!;

  // Wires, as the router would run them.
  for (let net = 0; net < netStart.length - 1; net++) {
    if (netStyle[net] !== STYLE_WIRE) continue;
    const root = netDriver[net]!;
    if (root === NONE || !drawn.has(portBlock[root]!)) continue;
    const rx = portX(root);
    const ry = portY(root);
    let nearest = Infinity;
    for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
      const p = netPorts[at]!;
      if (p !== root && drawn.has(portBlock[p]!) && portX(p) >= rx + 2 * g) {
        nearest = Math.min(nearest, portX(p));
      }
    }
    const trunk = Math.round((rx + nearest) / 2 / g) * g;
    for (let at = netStart[net]!; at < netStart[net + 1]!; at++) {
      const p = netPorts[at]!;
      if (p === root || !drawn.has(portBlock[p]!)) continue;
      const px = portX(p);
      const py = portY(p);
      if (px >= rx + 2 * g) {
        segment(rx, ry, trunk, ry);
        segment(trunk, ry, trunk, py);
        segment(trunk, py, px, py);
      } else {
        // The lane runs under the root's unit's blocks between the two ends.
        let floor = Math.max(ry, py);
        const unit = arranged.unitOf[portBlock[root]!]!;
        for (const b of drawn) {
          if (arranged.unitOf[b] !== unit) continue;
          const bx = positions[2 * b]!;
          if (bx + size[2 * b]! + extent[4 * b + 2]! < px - 2 * g) continue;
          if (bx - extent[4 * b]! > rx + 2 * g) continue;
          floor = Math.max(floor, positions[2 * b + 1]! + size[2 * b + 1]! + extent[4 * b + 3]!);
        }
        const lane = floor + 2 * g * (1 + (net % 3));
        segment(rx, ry, rx + 2 * g, ry);
        segment(rx + 2 * g, ry, rx + 2 * g, lane);
        segment(rx + 2 * g, lane, px - 2 * g, lane);
        segment(px - 2 * g, lane, px - 2 * g, py);
        segment(px - 2 * g, py, px, py);
      }
    }
  }

  // Boxes over the wires, with titles, labels, ports and tags.
  for (const b of drawn) {
    const x = positions[2 * b]!;
    const y = positions[2 * b + 1]!;
    const c0 = col(x);
    const c1 = col(x + size[2 * b]!);
    const r0 = row(y);
    const r1 = row(y + size[2 * b + 1]!);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const edgeRow = r === r0 || r === r1;
        const edgeCol = c === c0 || c === c1;
        text[r]![c] = edgeRow && edgeCol ? '+' : edgeRow ? '-' : edgeCol ? '|' : ' ';
      }
    }
    const title = (blockTitle?.[b] ?? '').slice(0, c1 - c0 - 1);
    put((r0 + r1) >> 1, c0 + ((c1 - c0 + 1 - title.length) >> 1), title);
    const label = blockLabel?.[b] ?? '';
    if (label) put(r1 + 1, c0 + ((c1 - c0 + 1 - label.length) >> 1), label);
    for (let p = portStart[b]!; p < portStart[b + 1]!; p++) {
      const r = row(portY(p));
      const c = col(portX(p));
      const side = portSide[p]!;
      const flow = portFlow[p]!;
      const mark =
        flow === FLOW_BOTH
          ? 'o'
          : side === 2
            ? 'v'
            : side === 3
              ? '^'
              : (side === 0) === (flow === FLOW_IN)
                ? '>'
                : '<';
      put(r, c, mark);
      const net = portNet[p]!;
      if (net !== NONE && netStyle[net] === STYLE_TAG) {
        const tag = `[${netLabel?.[net] ?? ''}]`;
        if (side === 2) put(r - 2, c - (tag.length >> 1), tag);
        else if (side === 3) put(r + 2, c - (tag.length >> 1), tag);
        else if (side === 0) put(r, c - tag.length - 1, tag);
        else put(r, c + 2, tag);
      }
    }
  }

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const t = text[r]![c]!;
      const w = wire[r * cols + c]!;
      line += t !== '' ? t : w === (H | V) ? '+' : w === H ? '-' : w === V ? '|' : ' ';
    }
    lines.push(line.trimEnd());
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  return lines.join('\n');
}
