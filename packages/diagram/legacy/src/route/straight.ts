/**
 * What every router shares: the writer a route goes to, the ports of a net that take part in its
 * route, and straight routing, the router with no rules beyond that.
 */

import {
  FLOW_IN,
  FLOW_OUT,
  NONE,
  SIDE_BOTTOM,
  SIDE_LEFT,
  SIDE_RIGHT,
  STYLE_WIRE,
  type Prepared,
} from '../prepare.js';
import type { RouteContext } from './index.js';

/** Where a router writes one net's route, in diagram units. */
export interface RouteWriter {
  /** A segment from `(ax, ay)` to `(bx, by)`, `along` the net's length from its root at `a`. */
  segment(ax: number, ay: number, bx: number, by: number, along: number): void;
  /** A junction dot where the route branches. */
  junction(x: number, y: number): void;
  /** An arrowhead with its tip at `(x, y)`, pointing along the unit direction `(dx, dy)`. */
  arrow(x: number, y: number, dx: number, dy: number): void;
  /** Where the net's label sits. */
  anchor(x: number, y: number): void;
}

/** Whether item `index` shows under a visibility channel: unbound, or any value but `0`. */
export function shown(values: Float32Array | null, index: number): boolean {
  return values === null || values[index] !== 0;
}

/** A port's outward normal along x: `-1` left, `1` right, `0` top or bottom. */
export function normalX(side: number): number {
  return side === SIDE_LEFT ? -1 : side === SIDE_RIGHT ? 1 : 0;
}

/** A port's outward normal along y (down): `-1` top, `1` bottom, `0` left or right. */
export function normalY(side: number): number {
  return side === SIDE_BOTTOM ? 1 : side === SIDE_LEFT || side === SIDE_RIGHT ? 0 : -1;
}

/** A port's x in diagram units, from its block's top-left. */
export function portX(prepared: Prepared, positions: Float32Array, port: number): number {
  return positions[2 * prepared.portBlock[port]!]! + prepared.portOffset[2 * port]!;
}

/** A port's y in diagram units, from its block's top-left. */
export function portY(prepared: Prepared, positions: Float32Array, port: number): number {
  return positions[2 * prepared.portBlock[port]! + 1]! + prepared.portOffset[2 * port + 1]!;
}

/**
 * The ports of the net being routed that take part in its route, in a scratch every router shares
 * and every `gather` overwrites.
 */
class Members {
  /** The ports, root first; valid up to `count`. */
  ports = new Uint32Array(16);
  /** Ports gathered by the last call. */
  count = 0;

  /**
   * Gather the ports of `net` that take part in its route: every port of a shown block, at a
   * finite position, but the detached one, when the net is shown and drawn as wires. The root
   * comes first: the driver when it takes part, else the first port in net order. Returns the
   * count; below two, nothing draws.
   */
  gather(ctx: RouteContext, net: number): number {
    this.count = 0;
    const { prepared, positions, blockVisible } = ctx;
    if (prepared.netStyle[net] !== STYLE_WIRE || !shown(ctx.netVisible, net)) return 0;
    const { netStart, netPorts, portFlow } = prepared.netlist;
    const detached = ctx.detached ?? NONE;
    const first = netStart[net]!;
    const end = netStart[net + 1]!;
    if (this.ports.length < end - first) this.ports = new Uint32Array(2 * (end - first));
    let count = 0;
    for (let i = first; i < end; i++) {
      const port = netPorts[i]!;
      if (port === detached) continue;
      const block = prepared.portBlock[port]!;
      if (!shown(blockVisible, block)) continue;
      if (!Number.isFinite(positions[2 * block]!) || !Number.isFinite(positions[2 * block + 1]!)) {
        continue;
      }
      this.ports[count] = port;
      // The driver swaps to the front; it is the only `out` port a net holds.
      if (portFlow[port] === FLOW_OUT && count > 0) {
        this.ports[count] = this.ports[0]!;
        this.ports[0] = port;
      }
      count++;
    }
    this.count = count;
    return count;
  }

  /** Take `ports` as the members, root first. */
  set(root: number, other: number): void {
    this.ports[0] = root;
    this.ports[1] = other;
    this.count = other === NONE ? 1 : 2;
  }
}

/** The one scratch every router gathers into; routing is synchronous, so one suffices. */
export const members = new Members();

/**
 * Route one net straight: a segment from the root port (the driver, else the first shown port)
 * to each other shown port, an arrow at each `in` port, no junctions, the anchor at the root.
 */
export function routeStraight(ctx: RouteContext, net: number, out: RouteWriter): void {
  const count = members.gather(ctx, net);
  if (count < 2) return;
  const { prepared, positions } = ctx;
  const flow = prepared.netlist.portFlow;
  const ports = members.ports;
  const root = ports[0]!;
  const ax = portX(prepared, positions, root);
  const ay = portY(prepared, positions, root);
  for (let i = 1; i < count; i++) {
    const port = ports[i]!;
    out.segment(ax, ay, portX(prepared, positions, port), portY(prepared, positions, port), 0);
  }
  for (let i = 0; i < count; i++) {
    const port = ports[i]!;
    if (flow[port] !== FLOW_IN) continue;
    const x = portX(prepared, positions, port);
    const y = portY(prepared, positions, port);
    const side = prepared.portSide[port]!;
    // A reader's arrow follows its wire; the root's (a reader whose driver is hidden) points in.
    let dx = x - ax;
    let dy = y - ay;
    const length = Math.hypot(dx, dy);
    if (i === 0 || length === 0) {
      dx = 0 - normalX(side);
      dy = 0 - normalY(side);
    } else {
      dx /= length;
      dy /= length;
    }
    out.arrow(x, y, dx, dy);
  }
  out.anchor(ax, ay);
}
