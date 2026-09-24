/**
 * A hand-written interaction context for `Interactor` tests: a camera over an 800 x 600 canvas
 * (identity at rest, so canvas-local points are diagram points), a geometric picker over the
 * fake scene's positions, and fakes of the `Scene` and `Focus` members the interactor uses, each
 * recording what it was asked to do.
 */

import type { Netlist } from '@latkit/model';

import type { Focus } from '../../src/focus.js';
import type { Rect } from '../../src/geometry.js';
import type { InteractionContext, InteractionEvent } from '../../src/interact.js';
import type { Interaction } from '../../src/options.js';
import {
  PART_BLOCK,
  PART_GROUP,
  PART_NET,
  PART_PORT,
  partId,
  partIndex,
  partKind,
  partOf,
  type Part,
} from '../../src/part.js';
import { NONE, prepare, type Prepared } from '../../src/prepare.js';
import type { Scene } from '../../src/scene.js';

export const GRID = 8;
export const WIDTH = 800;
export const HEIGHT = 600;
/** The canvas's client top-left. */
export const LEFT = 100;
export const TOP = 50;

export const block = (index: number): number => partId(PART_BLOCK, index);
export const port = (index: number): number => partId(PART_PORT, index);
export const net = (index: number): number => partId(PART_NET, index);
export const group = (index: number): number => partId(PART_GROUP, index);

/** Selection, hover, glow, and dragging, as the real focus keeps them, minus the mirror. */
export class FakeFocus {
  hover: number | null = null;
  readonly selection = new Set<number>();
  readonly glow: (readonly [number[] | null, number | null])[] = [];
  readonly dragging: (number[] | null)[] = [];

  setHover(id: number | null): boolean {
    const changed = id !== this.hover;
    this.hover = id;
    return changed;
  }

  select(ids: Iterable<number>): boolean {
    const next = [...new Set(ids)];
    const prev = [...this.selection];
    const changed = next.length !== prev.length || next.some((id, i) => id !== prev[i]);
    this.selection.clear();
    for (const id of next) this.selection.add(id);
    return changed;
  }

  toggle(id: number): void {
    if (!this.selection.delete(id)) this.selection.add(id);
  }

  parts(): Part[] {
    return [...this.selection].map(partOf);
  }

  selectedBlocks(): Uint32Array {
    return Uint32Array.from(
      [...this.selection].filter((id) => partKind(id) === PART_BLOCK).map(partIndex),
    );
  }

  setGlow(compatible: Iterable<number> | null, target: number | null): void {
    this.glow.push([compatible ? [...compatible] : null, target]);
  }

  setDragging(blocks: Uint32Array | null): void {
    this.dragging.push(blocks ? Array.from(blocks) : null);
  }
}

/** Placements plus a drag offset, as the real scene composes effective positions. */
export class FakeScene {
  readonly base: Float32Array;
  readonly positions: Float32Array;
  readonly hidden = new Set<number>();
  readonly drags: (readonly [number[] | null, number, number])[] = [];
  readonly nudges: (readonly [number[], number, number])[] = [];
  commits = 0;
  private dragged: Uint32Array | null = null;
  private dx = 0;
  private dy = 0;

  constructor(
    readonly prepared: Prepared | null,
    placed: readonly number[],
  ) {
    this.base = Float32Array.from(placed);
    this.positions = Float32Array.from(placed);
  }

  drag(blocks: Uint32Array | null, dx: number, dy: number): void {
    this.drags.push([blocks ? Array.from(blocks) : null, dx, dy]);
    this.dragged = blocks;
    this.dx = blocks ? dx : 0;
    this.dy = blocks ? dy : 0;
    this.compose();
  }

  commitDrag(): { readonly blocks: Uint32Array; readonly positions: Float32Array } | null {
    const blocks = this.dragged;
    if (!blocks) return null;
    this.commits++;
    for (const b of blocks) {
      this.base[2 * b]! += this.dx;
      this.base[2 * b + 1]! += this.dy;
    }
    this.dragged = null;
    this.compose();
    return { blocks: Uint32Array.from(blocks), positions: this.at(blocks) };
  }

  nudge(
    blocks: Uint32Array,
    dx: number,
    dy: number,
  ): { readonly blocks: Uint32Array; readonly positions: Float32Array } {
    this.nudges.push([Array.from(blocks), dx, dy]);
    for (const b of blocks) {
      this.base[2 * b]! += dx;
      this.base[2 * b + 1]! += dy;
    }
    this.compose();
    return { blocks: Uint32Array.from(blocks), positions: this.at(blocks) };
  }

  blockVisible(b: number): boolean {
    return !this.hidden.has(b);
  }

  private at(blocks: Uint32Array): Float32Array {
    const out = new Float32Array(2 * blocks.length);
    blocks.forEach((b, i) => {
      out[2 * i] = this.positions[2 * b]!;
      out[2 * i + 1] = this.positions[2 * b + 1]!;
    });
    return out;
  }

  private compose(): void {
    this.positions.set(this.base);
    if (!this.dragged) return;
    for (const b of this.dragged) {
      this.positions[2 * b]! += this.dx;
      this.positions[2 * b + 1]! += this.dy;
    }
  }
}

/** One emitted event. */
export interface Emitted {
  readonly event: InteractionEvent;
  readonly payload: unknown;
}

/** Press options; a mouse primary press with the default pick radius unless given. */
export interface PressOptions {
  readonly button?: number;
  readonly pointerType?: string;
  readonly shift?: boolean;
  readonly mod?: boolean;
  readonly targetPx?: number;
}

/** A context over `netlist` with blocks at `placed` top-lefts, and everything it recorded. */
export function harness(netlist: Netlist | null, placed: readonly number[] = []) {
  const prepared = netlist ? prepare(netlist, GRID) : null;
  const scene = new FakeScene(prepared, placed);
  const focus = new FakeFocus();
  const events: Emitted[] = [];
  const camera = {
    cx: WIDTH / 2,
    cy: HEIGHT / 2,
    zoom: 1,
    pans: [] as (readonly [number, number])[],
    zooms: [] as (readonly [number, number, number])[],
    fits: 0,
  };
  const overlay = {
    marquees: [] as (Rect | null)[],
    previews: [] as (Float32Array | null)[],
  };
  const calls = {
    compatible: [] as (readonly [number, number])[],
    target: [] as (readonly [number, number, number, number, number])[],
    preview: [] as (readonly [number, number, number, number | null])[],
    detach: [] as (number | null)[],
    pick: [] as (readonly [number, number, number])[],
    repaints: 0,
  };
  const state = {
    mode: 'edit' as Interaction,
    snap: true,
    reduced: false,
    pickRadiusPx: 8,
    /** Replaces the geometric pick. */
    pick: null as ((sx: number, sy: number, radiusPx: number) => readonly number[]) | null,
    /** Replaces the geometric wire target. */
    target: null as ((x: number, y: number) => number | null) | null,
    /** Replaces `locate`. */
    locate: null as ((id: number) => readonly [number, number] | null) | null,
  };

  const toDiagram = (sx: number, sy: number): readonly [number, number] => [
    camera.cx + (sx - WIDTH / 2) / camera.zoom,
    camera.cy + (sy - HEIGHT / 2) / camera.zoom,
  ];
  const toScreen = (x: number, y: number): readonly [number, number] => [
    (x - camera.cx) * camera.zoom + WIDTH / 2,
    (y - camera.cy) * camera.zoom + HEIGHT / 2,
  ];

  /** A port's diagram position. */
  const portPosition = (p: number): readonly [number, number] => {
    const b = prepared!.portBlock[p]!;
    return [
      scene.positions[2 * b]! + prepared!.portOffset[2 * p]!,
      scene.positions[2 * b + 1]! + prepared!.portOffset[2 * p + 1]!,
    ];
  };

  /** A block's rectangle. */
  const blockRect = (b: number): Rect => {
    const x = scene.positions[2 * b]!;
    const y = scene.positions[2 * b + 1]!;
    return [x, y, x + prepared!.size[2 * b]!, y + prepared!.size[2 * b + 1]!];
  };

  /** A group's frame: members padded by `groupPad`, the header strip on top; null when empty. */
  const groupRect = (g: number): Rect | null => {
    const p = prepared!;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = p.groupStart[g]!; i < p.groupStart[g + 1]!; i++) {
      const [a, b, c, d] = blockRect(p.groupBlocks[i]!);
      x0 = Math.min(x0, a);
      y0 = Math.min(y0, b);
      x1 = Math.max(x1, c);
      y1 = Math.max(y1, d);
    }
    if (x0 === Infinity) return null;
    const pad = p.metrics.groupPad;
    return [x0 - pad, y0 - pad - p.metrics.groupHeader, x1 + pad, y1 + pad];
  };

  const inside = (r: Rect, x: number, y: number): boolean =>
    x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

  /** Nearest port within `max(radius, portSize)`, the block under the point, and its group. */
  const geometricPick = (sx: number, sy: number, radiusPx: number): number[] => {
    const p = prepared;
    if (!p) return [];
    const [x, y] = toDiagram(sx, sy);
    const reach = Math.max(radiusPx / camera.zoom, p.metrics.portSize);
    const hits: number[] = [];
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let q = 0; q < p.portCount; q++) {
      if (scene.hidden.has(p.portBlock[q]!)) continue;
      const [px, py] = portPosition(q);
      const d = Math.hypot(px - x, py - y);
      if (d <= reach && d < nearestDistance) {
        nearest = q;
        nearestDistance = d;
      }
    }
    if (nearest >= 0) hits.push(port(nearest));
    for (let b = 0; b < p.blockCount; b++) {
      if (!scene.hidden.has(b) && inside(blockRect(b), x, y)) {
        hits.push(block(b));
        break;
      }
    }
    for (let g = 0; g < p.groupCount; g++) {
      const r = groupRect(g);
      if (r && inside(r, x, y)) {
        hits.push(group(g));
        break;
      }
    }
    return hits;
  };

  /** Port `q` joins a wire from `f` replacing `r`: the union rule over ports and wired nets. */
  const outsOf = (members: Iterable<number>): number => {
    let outs = 0;
    for (const q of members) if (netlist!.portFlow[q] === 1) outs++;
    return outs;
  };
  const membersOf = (n: number): number[] =>
    Array.from(netlist!.netPorts.subarray(netlist!.netStart[n]!, netlist!.netStart[n + 1]!));
  const compatibleOf = (f: number, r: number): number[] => {
    const p = prepared!;
    const fromNet = p.portNet[f]!;
    const side = fromNet === NONE ? [f] : membersOf(fromNet).filter((q) => q !== r);
    const ids: number[] = [];
    for (let q = 0; q < p.portCount; q++) {
      if (q === f || q === r || p.portKind[q] !== p.portKind[f]) continue;
      if (fromNet !== NONE && p.portNet[q] === fromNet) continue;
      const other = p.portNet[q] === NONE ? [q] : membersOf(p.portNet[q]!);
      if (outsOf(side) + outsOf(other) <= 1) ids.push(port(q));
    }
    for (let n = 0; n < p.netCount; n++) {
      if (n === fromNet || p.netStyle[n] !== 0) continue;
      if (outsOf(side) + outsOf(membersOf(n)) <= 1) ids.push(net(n));
    }
    return ids;
  };

  const ctx: InteractionContext = {
    mode: () => state.mode,
    snap: () => state.snap,
    reduced: () => state.reduced,
    prepared: () => prepared,
    toDiagram,
    zoom: () => camera.zoom,
    viewport: () => ({ w: WIDTH, h: HEIGHT }),
    rect: () => ({ left: LEFT, top: TOP, width: WIDTH, height: HEIGHT }),
    pickRadiusPx: () => state.pickRadiusPx,
    pick(sx, sy, radiusPx) {
      calls.pick.push([sx, sy, radiusPx]);
      return state.pick ? state.pick(sx, sy, radiusPx) : geometricPick(sx, sy, radiusPx);
    },
    locate(id) {
      if (state.locate) return state.locate(id);
      if (partKind(id) === PART_BLOCK) {
        const [x0, y0, x1, y1] = blockRect(partIndex(id));
        return toScreen((x0 + x1) / 2, (y0 + y1) / 2);
      }
      if (partKind(id) === PART_PORT) return toScreen(...portPosition(partIndex(id)));
      return null;
    },
    marquee(x0, y0, x1, y1) {
      const blocks: number[] = [];
      for (let b = 0; b < (prepared?.blockCount ?? 0); b++) {
        const r = blockRect(b);
        if (!scene.hidden.has(b) && r[0] <= x1 && r[2] >= x0 && r[1] <= y1 && r[3] >= y0) {
          blocks.push(b);
        }
      }
      return Uint32Array.from(blocks);
    },
    target(from, replaces, x, y, radius) {
      calls.target.push([from, replaces, x, y, radius]);
      if (state.target) return state.target(x, y);
      let best: number | null = null;
      let bestDistance = Infinity;
      for (const id of compatibleOf(from, replaces)) {
        if (partKind(id) !== PART_PORT) continue;
        const [px, py] = portPosition(partIndex(id));
        const d = Math.hypot(px - x, py - y);
        if (d <= radius && d < bestDistance) {
          best = id;
          bestDistance = d;
        }
      }
      return best;
    },
    compatible(from, replaces) {
      calls.compatible.push([from, replaces]);
      return compatibleOf(from, replaces);
    },
    scene: scene as unknown as Scene,
    focus: focus as unknown as Focus,
    camera: {
      panBy(dx, dy) {
        camera.pans.push([dx, dy]);
        camera.cx -= dx / camera.zoom;
        camera.cy -= dy / camera.zoom;
      },
      zoomAt(factor, sx, sy) {
        camera.zooms.push([factor, sx, sy]);
        const [x, y] = toDiagram(sx, sy);
        camera.zoom *= factor;
        camera.cx = x - (sx - WIDTH / 2) / camera.zoom;
        camera.cy = y - (sy - HEIGHT / 2) / camera.zoom;
      },
      fit() {
        camera.fits++;
      },
    },
    overlay: {
      marquee: (r) => void overlay.marquees.push(r),
      preview: (points) => void overlay.previews.push(points),
    },
    previewRoute(from, x, y, target) {
      calls.preview.push([from, x, y, target]);
      const [fx, fy] = portPosition(from);
      return Float32Array.of(fx, fy, x, y);
    },
    detach: (p) => void calls.detach.push(p),
    emit: (event, payload) => void events.push({ event, payload }),
    repaint: () => void calls.repaints++,
  };

  return {
    ctx,
    prepared,
    scene,
    focus,
    events,
    camera,
    overlay,
    calls,
    state,
    toScreen,
    /** A port's canvas-local point. */
    portAt: (p: number): readonly [number, number] => toScreen(...portPosition(p)),
    /** A block's center, canvas-local. */
    centerOf: (b: number): readonly [number, number] => {
      const [x0, y0, x1, y1] = blockRect(b);
      return toScreen((x0 + x1) / 2, (y0 + y1) / 2);
    },
    groupRect,
    /** Emitted events of one name, payloads only. */
    emitted: (event: InteractionEvent): unknown[] =>
      events.filter((e) => e.event === event).map((e) => e.payload),
  };
}

export type Harness = ReturnType<typeof harness>;
