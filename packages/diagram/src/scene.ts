import type { Netlist } from '@latkit/model';

import type { Channels } from './channels.js';
import { netLabelBox, textWidth, type Rect } from './geometry.js';
import { arrangeAll, arrangeUnits } from './layout/arrange.js';
import { placeNew } from './layout/pack.js';
import { laneShifts } from './layout/shapes.js';
import type { Routing } from './options.js';
import type { Part } from './part.js';
import { Picker, type PickSource } from './pick/picker.js';
import { NONE, prepare, STYLE_WIRE, type Prepared } from './prepare.js';
import { Routes, type RouteContext } from './route/index.js';
import {
  layoutBases,
  WIRE_EMPTY,
  WIRE_SEGMENT,
  WIRE_WORDS,
  writeStructure,
  type Mirror,
  type Mirrors,
} from './webgpu/buffers.js';

/** Blocks a move left somewhere, and their new top-left corners. */
export interface Moved {
  readonly blocks: Uint32Array;
  readonly positions: Float32Array;
}

/** How a flush keeps the picker current: block by block, all at once, or not until later. */
type PickUpdate = 'incremental' | 'rebuild' | 'skip';

/** An arrangement easing its blocks from where they were drawn to their new automatic spots. */
interface Tween {
  /** Automatic top-lefts as drawn when it started, 2 per block. */
  readonly from: Float32Array;
  /** The blocks whose automatic spot changed. */
  readonly blocks: Uint32Array;
  readonly start: number;
  readonly durationMs: number;
  /** The nets hidden until it lands, too slow to route every frame, or null for none. */
  readonly hidden: Uint32Array | null;
  /**
   * Whether `hidden` holds every net it moves: then no frame routes anything, and the picker
   * waits for it to land instead of following every frame.
   */
  readonly still: boolean;
}

// Per-item pending bits.
/** A block the picker has not re-indexed since it moved. */
const PENDING_PICK = 1;
/** A block or net not yet reported by `drain`. */
const PENDING_DRAIN = 2;
/** A net waiting to be re-routed. */
const PENDING_ROUTE = 1;

/** No blocks. */
const NO_BLOCKS = new Uint32Array(0);

/**
 * Most blocks a drag keeps out of the pick index. Every obstacle query tests those one by one,
 * and a drag re-routes their nets every frame, so the cost grows with the square of a larger
 * drag; one re-indexes its blocks as they move instead.
 */
const MOVING_BLOCKS = 64;

/**
 * Most ports a move re-routes on every step: the ports of the nets it touches, summed, so one
 * net of thousands of readers counts as much as a thousand small ones. A move over the budget
 * hides its nets and routes them once it ends. Small nets route at about a microsecond per port,
 * so the budget holds a step to several milliseconds, near what counting 2048 nets allowed.
 */
export const LIVE_ROUTE_PORTS = 8192;

/**
 * Most ports a single net may have and still re-route on every step of a move. A wide net's
 * branches run far across the diagram, so its cost per port grows with its width: a net of 512
 * readers spread over a large diagram already takes a few milliseconds a step. A move within
 * `LIVE_ROUTE_PORTS` hides only its nets wider than this, and routes them once it ends.
 */
export const LIVE_NET_PORTS = 512;

/**
 * Quiet time after a nudge before the nets a burst of nudges hid route again, in ms: longer than
 * the gap between key repeats, so a held arrow key routes once, when it is let go.
 */
export const NUDGE_SETTLE_MS = 160;

/** Cubic in-out: slow start, slow finish. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** `list` with room for `size` items, contents kept. */
function room(list: Uint32Array, size: number): Uint32Array {
  if (list.length >= size) return list;
  const grown = new Uint32Array(Math.max(size, 2 * list.length, 16));
  grown.set(list);
  return grown;
}

/**
 * The CPU-side diagram: the prepared netlist, automatic positions, the effective positions (the
 * layout mirror), group bounds, routes, tweens, and ghosts.
 *
 * @remarks
 * A block's effective position is its placement pair (the `blockPosition` channel) when finite,
 * else its automatic position as drawn (eased during an arrangement), plus the drag offset while
 * it is dragged. A group's bounds are the union of its visible members' rectangles with extents
 * and of the routed wires and drawn labels of its internal nets, padded by `groupPad`, with
 * `groupHeader` on top; NaN when no member shows. A drag, tween, or burst of nudges hides the
 * nets it would re-route too slowly on every step, and routes them once it ends: all of its nets
 * when they hold more than `liveRoutePorts` ports, else those of more than `liveNetPorts`.
 * Removed blocks leave ghosts fading to 0 over `animationMs`, none when motion is off.
 *
 * Every change is carried through at once: the picker learns where moved blocks are (they are
 * re-indexed before routing asks it for obstacles), touched nets re-route, and group frames
 * follow, so a pick right after a move finds blocks where they are drawn. After a load or a large
 * move the picker is marked for a rebuild instead, which its next query makes. `drain` reports
 * the same changes to anyone else who follows them; the picker needs nothing from it.
 */
export class Scene implements PickSource {
  /** Effective positions, group bounds, and net anchors. */
  readonly layout: Mirror;
  /** Routed net geometry. */
  readonly wires: Mirror;
  /** Every net's route, in per-net slots of `wires`. */
  readonly routes: Routes;
  /** The spatial index over this scene, kept current by every move and re-route. */
  readonly picker: Picker;
  /**
   * Duration of arrangement tweens and ghost fades, in ms; `0` moves at once and leaves no
   * ghosts. @defaultValue `300`
   */
  animationMs = 300;
  /**
   * Whether motion is allowed; false means no tweens and no ghosts, and a tween in flight lands
   * on the next tick. `load` sets it too. @defaultValue `true`
   */
  motion = true;
  /**
   * Most ports a move re-routes on every step, summed over the nets it touches; a drag, tween,
   * or burst of nudges over it hides those nets until it ends. @defaultValue `LIVE_ROUTE_PORTS`
   */
  liveRoutePorts = LIVE_ROUTE_PORTS;
  /**
   * Most ports one net may have and still re-route on every step of a move; a move within
   * `liveRoutePorts` hides only its nets wider than this until it ends.
   * @defaultValue `LIVE_NET_PORTS`
   */
  liveNetPorts = LIVE_NET_PORTS;

  private readonly structure: Mirror;
  private readonly channels: Channels;
  private readonly obstacles: RouteContext['obstacles'];
  private current: Prepared | null = null;
  /** Per block: the lane shift its routes read (`laneShifts`); empty before a load. */
  private shifts: Uint8Array = new Uint8Array(0);
  private mode: Routing = 'orthogonal';
  private settles = 0;
  private groupBase = 0;
  private anchorBase = 0;
  /** Per net: the width of the label drawn over its wire, `0` for none (tag nets included). */
  private labelWidth: Float32Array = new Float32Array(0);
  /** Nets in no group whose labels `bounds` adds; the rest are inside their groups' frames. */
  private looseLabels: Uint32Array = new Uint32Array(0);

  /** Automatic top-lefts: where the last arrangement put every block, 2 per block. */
  private auto: Float32Array = new Float32Array(0);
  /** Automatic top-lefts as drawn: `auto`, or on the way there during a tween. */
  private shown: Float32Array = new Float32Array(0);
  /** A view of the layout mirror's positions, refreshed when the mirror grows. */
  private view: Float32Array = new Float32Array(0);
  /** Group `g` owns the nets `groupNets[groupNetStart[g]]` up to `groupNetStart[g + 1]`. */
  private groupNetStart: Uint32Array = new Uint32Array(1);
  private groupNets: Uint32Array = new Uint32Array(0);
  /** Visibility as last routed, so a visibility change re-routes only what flipped. */
  private blockShows: Uint8Array = new Uint8Array(0);
  private netShows: Uint8Array = new Uint8Array(0);

  // Pending work, as flag arrays plus lists so a change costs what it touches.
  private blockState: Uint8Array = new Uint8Array(0);
  private pickList: Uint32Array = new Uint32Array(0);
  private pickCount = 0;
  private drainBlocks: Uint32Array = new Uint32Array(0);
  private drainBlockCount = 0;
  private drainAllBlocks = false;
  private netState: Uint8Array = new Uint8Array(0);
  private routeList: Uint32Array = new Uint32Array(0);
  private routeCount = 0;
  private drainNets: Uint32Array = new Uint32Array(0);
  private drainNetCount = 0;
  private drainAllNets = false;
  private groupDirty: Uint8Array = new Uint8Array(0);
  private groupList: Uint32Array = new Uint32Array(0);
  private groupCount = 0;
  /** Per net: the moves hiding it; it routes again when the last one ends. */
  private hideCount: Uint8Array = new Uint8Array(0);
  private hiddenTotal = 0;
  /** Per net: the last `netsOf` call that counted it. */
  private netStamp: Uint32Array = new Uint32Array(0);
  private stamp = 0;
  /** Ports of the nets the last `netsOf` call found. */
  private netsPorts = 0;

  // The drag in flight.
  private dragSource: Uint32Array | null = null;
  private dragBlocks: Uint32Array | null = null;
  private dragged: Uint8Array = new Uint8Array(0);
  private dragX = 0;
  private dragY = 0;
  private dragNets: Uint32Array = NO_BLOCKS;
  /** The drag's nets it hides from its first offset to its end; see `quiet`. */
  private dragQuiet: Uint32Array = NO_BLOCKS;
  private dragHidden = false;
  /** Whether the dragged blocks are out of the pick index, tested where they are drawn. */
  private dragOut = false;

  private tween: Tween | null = null;
  private detached = NONE;

  // Nets a burst of nudges hid, each once, until the nudges stop.
  private nudgeHeld: Uint8Array = new Uint8Array(0);
  private nudgeNets: Uint32Array = new Uint32Array(0);
  private nudgeCount = 0;
  /** When a tick first saw the burst's latest nudge, or NaN until one does. */
  private nudgeSeen = Number.NaN;

  // Ghosts: a rectangle, a start time, and the alpha of the last tick each.
  private ghostRects: Float32Array = new Float32Array(0);
  private ghostStart: Float64Array = new Float64Array(0);
  private ghostAlpha: Float32Array = new Float32Array(0);
  private ghostCount = 0;

  // Scratch: a slot record, a resting position, a bounds box, and a label's box, so no step
  // allocates per item.
  private readonly slotScratch = { start: 0, count: 0 };
  private restX = 0;
  private restY = 0;
  private readonly box = new Float64Array(4);
  private readonly labelBox = new Float64Array(4);

  constructor(mirrors: Mirrors, channels: Channels) {
    this.layout = mirrors.layout;
    this.wires = mirrors.wires;
    this.structure = mirrors.structure;
    this.channels = channels;
    this.routes = new Routes(mirrors.wires, mirrors.layout);
    this.picker = new Picker(this);
    // The picker's query reads `this`; the router calls it bare.
    this.obstacles = this.picker.obstacles.bind(this.picker);
  }

  /** The loaded netlist, prepared, or null before a load. */
  get prepared(): Prepared | null {
    return this.current;
  }

  /** Per block: the lane shift every route of the loaded netlist reads; see `laneShifts`. */
  get laneShift(): Uint8Array {
    return this.shifts;
  }

  /** Effective top-lefts (a view of the layout mirror), 2 per block. */
  get positions(): Float32Array {
    const words = 2 * (this.current?.blockCount ?? 0);
    const f32 = this.layout.f32;
    if (this.view.buffer !== f32.buffer || this.view.length !== words) {
      this.view = f32.subarray(0, words);
    }
    return this.view;
  }

  /**
   * A count bumped whenever blocks come to rest somewhere new: a load or grid change placing
   * them, an arrangement landing (at once or at the end of its tween), a committed drag, a
   * nudge, or a placement write that moved one. Text follows its anchors on the GPU, but runs
   * that moved into view get glyphs only on a forced label update; force one when this changes.
   */
  get settled(): number {
    return this.settles;
  }

  /**
   * Whether a tween, a ghost fade, or a burst of nudges holding nets back is in flight; `tick`
   * carries each to its end.
   */
  get animating(): boolean {
    return this.tween !== null || this.ghostCount > 0 || this.nudgeCount > 0;
  }

  /**
   * Load: prepare, carry automatic positions and placements and return the survivor map (per new
   * block, its old block or NONE); writes the structure mirror; places or arranges; routes all.
   *
   * @remarks
   * A block survives when its `blockKey` was loaded before; it keeps its automatic position and
   * its placement pair in the `blockPosition` channel. New blocks land beside what they connect
   * to, clear of where the survivors are drawn (a wholly new unit `UNIT_GAP` clear of every
   * unit's rectangle, as a packing keeps it), with a NaN placement pair; when nothing survives
   * (a first load, or netlists without keys) everything is arranged and no placement carries
   * over. Every other channel resets (indices changed), the drag, tween, nudge hold, and
   * detached port end, and when some block survived, the removed ones leave ghosts. The netlist
   * must be valid.
   *
   * @param grid - The grid pitch in diagram units.
   * @param motion - Whether motion is allowed; stored in `motion`.
   * @param now - The time ghosts start fading, in ms.
   */
  load(netlist: Netlist, grid: number, motion: boolean, now: number): Uint32Array {
    const next = prepare(netlist, grid);
    const prev = this.current;
    const survivors = new Uint32Array(next.blockCount).fill(NONE);
    let kept = 0;
    if (prev?.keys && next.keys) {
      const keys = next.netlist.blockKey!;
      for (let block = 0; block < next.blockCount; block++) {
        const was = prev.keys.get(keys[block]!);
        if (was === undefined) continue;
        survivors[block] = was;
        kept++;
      }
    }

    let auto: Float32Array;
    let placement: Float32Array | null = null;
    if (kept === 0) auto = arrangeAll(next);
    else {
      const drawn = this.positions;
      const placed = this.channels.values('blockPosition');
      auto = new Float32Array(2 * next.blockCount).fill(Number.NaN);
      const occupied = new Float32Array(2 * next.blockCount).fill(Number.NaN);
      if (placed) placement = new Float32Array(2 * next.blockCount).fill(Number.NaN);
      for (let block = 0; block < next.blockCount; block++) {
        const was = survivors[block]!;
        if (was === NONE) continue;
        auto[2 * block] = this.auto[2 * was]!;
        auto[2 * block + 1] = this.auto[2 * was + 1]!;
        occupied[2 * block] = drawn[2 * was]!;
        occupied[2 * block + 1] = drawn[2 * was + 1]!;
        if (placed && placement) {
          placement[2 * block] = placed[2 * was]!;
          placement[2 * block + 1] = placed[2 * was + 1]!;
        }
      }
      if (kept < next.blockCount) placeNew(next, auto, occupied);
    }

    this.motion = motion;
    if (prev && kept > 0 && motion && this.animationMs > 0) this.addGhosts(prev, survivors, now);
    this.bind(next, auto, true, placement);
    return survivors;
  }

  /**
   * Forget the netlist and everything derived from it: routes, the pick index, the drag, tween,
   * nudge hold, detached port, and ghosts. The structure, layout, and wires mirrors give their
   * memory back and bump their versions. Channels are the caller's to reset.
   */
  clear(): void {
    this.current = null;
    this.forgetMoves();
    this.sizeTables(0, 0, 0);
    this.ghostCount = 0;
    this.ghostRects = new Float32Array(0);
    this.ghostStart = new Float64Array(0);
    this.ghostAlpha = new Float32Array(0);
    this.auto = new Float32Array(0);
    this.shown = new Float32Array(0);
    this.view = new Float32Array(0);
    this.shifts = new Uint8Array(0);
    this.groupBase = 0;
    this.anchorBase = 0;
    this.labelWidth = new Float32Array(0);
    this.looseLabels = new Uint32Array(0);
    this.groupNetStart = new Uint32Array(1);
    this.groupNets = new Uint32Array(0);
    this.blockShows = new Uint8Array(0);
    this.netShows = new Uint8Array(0);
    this.routes.reset(null);
    this.picker.rebuild();
    this.structure.release();
    this.layout.release();
    this.wires.release();
  }

  /** The placement channel changed (or cleared): recompute effective positions, re-route touched. */
  placementChanged(): void {
    const p = this.current;
    if (!p) return;
    const placement = this.channels.values('blockPosition');
    let moved = 0;
    for (let block = 0; block < p.blockCount; block++) {
      if (this.placeBlock(block, placement)) moved++;
    }
    if (moved === 0) return;
    this.flush(this.large(moved) ? 'rebuild' : 'incremental');
    this.settles++;
  }

  /** Visibility channels changed: re-route touched nets and refresh the frames of touched groups. */
  visibilityChanged(): void {
    const p = this.current;
    if (!p) return;
    const blocks = this.channels.values('blockVisible');
    const nets = this.channels.values('netVisible');
    const { blockNetStart, blockNets, blockGroup, netGroup } = p;
    for (let block = 0; block < p.blockCount; block++) {
      const shows = visibleAt(blocks, block) ? 1 : 0;
      if (shows === this.blockShows[block]) continue;
      this.blockShows[block] = shows;
      this.markGroup(blockGroup[block]!);
      for (let at = blockNetStart[block]!; at < blockNetStart[block + 1]!; at++) {
        this.markRoute(blockNets[at]!);
      }
    }
    for (let net = 0; net < p.netCount; net++) {
      const shows = visibleAt(nets, net) ? 1 : 0;
      if (shows === this.netShows[net]) continue;
      this.netShows[net] = shows;
      this.markRoute(net);
      this.markGroup(netGroup[net]!);
    }
    this.flush('incremental');
  }

  /**
   * Drag offset for `blocks` (diagram units, already snapped as the caller wants); null ends it,
   * returning the blocks to where they were. Safe with no drag in flight.
   *
   * @remarks
   * The dragged blocks leave the pick index at once and are tested where they are drawn, by
   * picks and by the router's obstacle query, until the drag ends; a drag of more than 64 blocks
   * stays in the index and is re-indexed as it moves. The nets it would re-route too slowly
   * (all of them past `liveRoutePorts` ports, else those past `liveNetPorts`) hide from its
   * first offset to its end.
   */
  drag(blocks: Uint32Array | null, dx: number, dy: number): void {
    const p = this.current;
    if (!p) return;
    if (blocks === null) {
      this.endDrag(false);
      return;
    }
    if (!this.dragBlocks || !this.sameDrag(blocks)) {
      this.endDrag(false);
      this.startDrag(p, blocks);
    }
    if (dx === this.dragX && dy === this.dragY) return;
    if (!this.dragHidden && this.dragQuiet.length > 0) {
      this.hide(this.dragQuiet);
      this.dragHidden = true;
    }
    this.dragX = dx;
    this.dragY = dy;
    const placement = this.channels.values('blockPosition');
    for (const block of this.dragBlocks!) this.placeBlock(block, placement);
    this.flush('incremental');
  }

  /**
   * Commit the current drag as placements (writes the blockPosition snapshot); returns the
   * moved blocks and their new top-lefts, or null with no drag in flight. Ends the drag.
   */
  commitDrag(): Moved | null {
    return this.endDrag(true);
  }

  /**
   * Nudge blocks by a delta as placements (writes the blockPosition snapshot); returns the valid
   * blocks, each once, and their new top-lefts.
   *
   * @remarks
   * The nets a nudge would re-route too slowly (all of them past `liveRoutePorts` ports, else
   * those past `liveNetPorts`) hide, and stay hidden through every nudge that follows within
   * `NUDGE_SETTLE_MS` of the last, as a held arrow key repeats; `tick` routes them once the
   * nudges stop.
   */
  nudge(blocks: Uint32Array, dx: number, dy: number): Moved {
    const p = this.current;
    if (!p) return { blocks: new Uint32Array(0), positions: new Float32Array(0) };
    const moved = this.unique(p, blocks);
    const nets = this.netsOf(p, moved, null);
    const quiet = this.quiet(p, nets);
    if (quiet.length > 0) this.holdNudged(quiet);
    // Any nudge while nets are held carries the burst on.
    if (this.nudgeCount > 0) this.nudgeSeen = Number.NaN;
    const placement = this.writablePlacement(p);
    const positions = new Float32Array(2 * moved.length);
    for (let i = 0; i < moved.length; i++) {
      const block = moved[i]!;
      this.rest(block, placement);
      placement[2 * block] = this.restX + dx;
      placement[2 * block + 1] = this.restY + dy;
      positions[2 * i] = placement[2 * block]!;
      positions[2 * i + 1] = placement[2 * block + 1]!;
    }
    let changed = 0;
    for (const block of moved) if (this.placeBlock(block, placement)) changed++;
    if (changed > 0) {
      this.flush(this.large(changed) ? 'rebuild' : 'incremental');
      this.settles++;
    }
    return { blocks: moved, positions };
  }

  /**
   * Re-arrange the units touching `blocks`, or everything with null; blocks without a placement
   * move there, eased when `animate` and motion allows. Returns every block's automatic
   * top-left, a new array.
   *
   * @remarks
   * Units re-laid out keep their automatic top-left while that keeps them `UNIT_GAP` clear of every
   * other unit's rectangle, and slide down or shelve when it does not (`arrangeUnits`); a full
   * arrangement repacks every unit.
   * Placements never change. A tween hides the nets of its moving blocks it would re-route too
   * slowly on every frame (all of them past `liveRoutePorts` ports, else those past
   * `liveNetPorts`) until it lands, then routes them once.
   *
   * @param now - The time a tween starts, in ms, on the clock `tick` receives.
   */
  arrange(blocks: Uint32Array | null, animate: boolean, now: number): Float32Array {
    const p = this.current;
    if (!p) return new Float32Array(0);
    let target: Float32Array;
    if (blocks === null) target = arrangeAll(p);
    else {
      target = this.auto.slice();
      arrangeUnits(p, target, blocks);
    }
    this.auto = target;

    const shown = this.shown;
    let count = 0;
    for (let block = 0; block < p.blockCount; block++) {
      if (
        shown[2 * block] !== target[2 * block] ||
        shown[2 * block + 1] !== target[2 * block + 1]
      ) {
        count++;
      }
    }
    const moving = new Uint32Array(count);
    count = 0;
    for (let block = 0; block < p.blockCount; block++) {
      if (
        shown[2 * block] !== target[2 * block] ||
        shown[2 * block + 1] !== target[2 * block + 1]
      ) {
        moving[count++] = block;
      }
    }

    const prior = this.tween;
    this.tween = null;
    if (prior?.hidden) this.unhide(prior.hidden);
    const placement = this.channels.values('blockPosition');

    if (animate && this.motion && this.animationMs > 0 && moving.length > 0) {
      // Only blocks without a placement are seen moving; only their nets go quiet.
      const nets = this.netsOf(p, moving, placement);
      const quiet = this.quiet(p, nets);
      if (quiet.length > 0) this.hide(quiet);
      this.tween = {
        from: shown.slice(),
        blocks: moving,
        start: now,
        durationMs: this.animationMs,
        hidden: quiet.length > 0 ? quiet : null,
        still: quiet.length > 0 && quiet.length === nets.length,
      };
      // Hidden nets leave the pick index and their frames now; a cut-short tween's nets return,
      // and the blocks a still one moved without re-indexing are indexed where they stopped.
      this.flush(prior?.still ? 'rebuild' : 'incremental');
      return target.slice();
    }

    // Blocks a cut-short tween left on the way are among the moving: drawn spots differ.
    shown.set(target);
    let changed = 0;
    for (const block of moving) if (this.placeBlock(block, placement)) changed++;
    const rebuild = this.large(changed) || prior?.still === true;
    this.flush(rebuild ? 'rebuild' : 'incremental');
    if (changed > 0) this.settles++;
    return target.slice();
  }

  /** Switch how wires run and re-route everything. */
  setRouting(mode: Routing): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const p = this.current;
    if (!p) return;
    for (let net = 0; net < p.netCount; net++) this.markRoute(net);
    this.flush('incremental');
  }

  /**
   * Re-prepare and re-arrange at a new grid pitch; sizes change, so no automatic position is
   * kept. Channels keep their values (indices did not change); the drag, tween, nudge hold,
   * detached port, and ghosts end.
   */
  setGrid(grid: number): void {
    const p = this.current;
    if (!p || grid === p.metrics.grid) return;
    const next = prepare(p.netlist, grid);
    this.ghostCount = 0;
    this.bind(next, arrangeAll(next), false, null);
  }

  /**
   * Show a picked-up port's wire detached: route its net as if `port` were off it; null (or an
   * index naming no port) restores it.
   */
  detach(port: number | null): void {
    const p = this.current;
    if (!p) return;
    const next =
      port !== null && Number.isInteger(port) && port >= 0 && port < p.portCount ? port : NONE;
    if (next === this.detached) return;
    const was = this.detached;
    this.detached = next;
    if (was !== NONE) this.markRoute(p.portNet[was]!);
    if (next !== NONE) this.markRoute(p.portNet[next]!);
    this.flush('incremental');
  }

  /**
   * Advance tweens and ghost fades, and route the nets a burst of nudges held once it has been
   * quiet for `NUDGE_SETTLE_MS`; returns whether anything still animates.
   */
  tick(now: number): boolean {
    if (this.nudgeCount > 0) {
      if (Number.isNaN(this.nudgeSeen)) this.nudgeSeen = now;
      else if (now - this.nudgeSeen >= NUDGE_SETTLE_MS) this.releaseNudged();
    }
    const tween = this.tween;
    if (tween) {
      const t = (now - tween.start) / tween.durationMs;
      if (!this.motion || this.animationMs <= 0 || !(t < 1)) this.land();
      else {
        const e = ease(Math.max(0, t));
        const { from, blocks } = tween;
        const shown = this.shown;
        const to = this.auto;
        const placement = this.channels.values('blockPosition');
        for (const block of blocks) {
          const x = 2 * block;
          shown[x] = from[x]! + (to[x]! - from[x]!) * e;
          shown[x + 1] = from[x + 1]! + (to[x + 1]! - from[x + 1]!) * e;
          this.placeBlock(block, placement);
        }
        this.flush(tween.still ? 'skip' : 'incremental');
      }
    }
    this.fadeGhosts(now);
    return this.animating;
  }

  /**
   * Bounds of visible content, or null: shown blocks with their extents, group frames, routed
   * wires, and the labels drawn over the wires of nets in no group (a group's frame holds its
   * own nets' labels).
   */
  bounds(): Rect | null {
    const p = this.current;
    if (!p) return null;
    const box = emptyBox(this.box);
    const visible = this.channels.values('blockVisible');
    for (let block = 0; block < p.blockCount; block++) {
      if (visibleAt(visible, block)) this.addBlock(box, p, block);
    }
    for (let group = 0; group < p.groupCount; group++) this.addGroup(box, group);
    this.addEntries(box, 0, this.routes.capacity);
    for (const net of this.looseLabels) this.addLabel(box, p, net);
    return rectOf(box);
  }

  /**
   * Bounds of some parts, or null when none is valid and shown: a block with its extents, a port
   * with its marker, a net's shown ports and wires, a group's frame.
   */
  boundsOf(parts: readonly Part[]): Rect | null {
    const p = this.current;
    if (!p) return null;
    const box = emptyBox(this.box);
    for (const part of parts) {
      const index = part.index;
      if (!Number.isInteger(index) || index < 0) continue;
      switch (part.kind) {
        case 'block':
          if (index < p.blockCount && this.blockVisible(index)) this.addBlock(box, p, index);
          break;
        case 'port':
          if (index < p.portCount) this.addPort(box, p, index);
          break;
        case 'net': {
          if (index >= p.netCount || !this.netVisible(index)) break;
          const { netStart, netPorts } = p.netlist;
          for (let at = netStart[index]!; at < netStart[index + 1]!; at++) {
            this.addPort(box, p, netPorts[at]!);
          }
          const start = this.routes.slotStart(index);
          this.addEntries(box, start, start + this.routes.slotCount(index));
          break;
        }
        case 'group':
          if (index < p.groupCount) this.addGroup(box, index);
          break;
      }
    }
    return rectOf(box);
  }

  /**
   * Slot of a net: entries `[start, start + count)` in the wires mirror. The record is reused;
   * read it before the next call.
   */
  slot(net: number): { readonly start: number; readonly count: number } {
    const slot = this.slotScratch;
    slot.start = this.routes.slotStart(net);
    slot.count = this.routes.slotCount(net);
    return slot;
  }

  /** Whether a block is shown. */
  blockVisible(block: number): boolean {
    return visibleAt(this.channels.values('blockVisible'), block);
  }

  /** Whether a net is shown. */
  netVisible(net: number): boolean {
    return visibleAt(this.channels.values('netVisible'), net);
  }

  /**
   * Blocks whose effective position changed since the last drain, and nets re-routed (or
   * cleared); everything after a load. The picker is already current.
   */
  drain(visitBlock: (block: number) => void, visitNet: (net: number) => void): void {
    const p = this.current;
    const blockCount = p?.blockCount ?? 0;
    const netCount = p?.netCount ?? 0;
    const allBlocks = this.drainAllBlocks;
    const allNets = this.drainAllNets;
    const blocks = this.drainBlocks.slice(0, this.drainBlockCount);
    const nets = this.drainNets.slice(0, this.drainNetCount);
    for (const block of blocks) this.blockState[block]! &= ~PENDING_DRAIN;
    for (const net of nets) this.netState[net]! &= ~PENDING_DRAIN;
    this.drainAllBlocks = false;
    this.drainAllNets = false;
    this.drainBlockCount = 0;
    this.drainNetCount = 0;
    if (allBlocks) for (let block = 0; block < blockCount; block++) visitBlock(block);
    else for (const block of blocks) visitBlock(block);
    if (allNets) for (let net = 0; net < netCount; net++) visitNet(net);
    else for (const net of nets) visitNet(net);
  }

  /** Write every fading ghost's rectangle and its alpha as of the last tick. */
  overlayGhosts(
    write: (x0: number, y0: number, x1: number, y1: number, alpha: number) => void,
  ): void {
    const rects = this.ghostRects;
    for (let i = 0; i < this.ghostCount; i++) {
      write(
        rects[4 * i]!,
        rects[4 * i + 1]!,
        rects[4 * i + 2]!,
        rects[4 * i + 3]!,
        this.ghostAlpha[i]!,
      );
    }
  }

  // Binding a netlist.

  /**
   * Make `next` the scene with automatic positions `auto`: every table sized, the structure
   * written, positions and routes laid down, group frames computed, the pick index marked for a
   * rebuild. `resetChannels` resets every channel for new indices, binding `carried` (when
   * given) as the `blockPosition` channel.
   */
  private bind(
    next: Prepared,
    auto: Float32Array,
    resetChannels: boolean,
    carried: Float32Array | null,
  ): void {
    const { blockCount, portCount, netCount, groupCount } = next;
    // Shifts follow structure alone: a grid change keeps them.
    if (this.current?.netlist !== next.netlist) this.shifts = laneShifts(next);
    this.current = next;
    this.forgetMoves();
    this.auto = auto;
    this.shown = auto.slice();
    if (resetChannels) {
      this.channels.reset({ blocks: blockCount, ports: portCount, nets: netCount });
      if (carried) this.channels.set('blockPosition', carried);
    }
    writeStructure(this.structure, next);
    this.sizeTables(blockCount, netCount, groupCount);
    this.drainAllBlocks = true;
    this.drainAllNets = true;

    // Group -> internal nets, so a frame encloses the wires inside it.
    const groupNetStart = new Uint32Array(groupCount + 1);
    for (let net = 0; net < netCount; net++) {
      const group = next.netGroup[net]!;
      if (group !== NONE) groupNetStart[group + 1]!++;
    }
    for (let group = 0; group < groupCount; group++) {
      groupNetStart[group + 1]! += groupNetStart[group]!;
    }
    const groupNets = new Uint32Array(groupNetStart[groupCount]!);
    const fill = groupNetStart.slice(0, groupCount);
    for (let net = 0; net < netCount; net++) {
      const group = next.netGroup[net]!;
      if (group !== NONE) groupNets[fill[group]!++] = net;
    }
    this.groupNetStart = groupNetStart;
    this.groupNets = groupNets;
    this.measureLabels(next);

    const blocks = this.channels.values('blockVisible');
    const nets = this.channels.values('netVisible');
    this.blockShows = new Uint8Array(blockCount);
    for (let block = 0; block < blockCount; block++) {
      this.blockShows[block] = visibleAt(blocks, block) ? 1 : 0;
    }
    this.netShows = new Uint8Array(netCount);
    for (let net = 0; net < netCount; net++) {
      this.netShows[net] = visibleAt(nets, net) ? 1 : 0;
    }

    // Size the layout before routes bind: growing it replaces the store every view reads.
    const bases = layoutBases(next);
    this.groupBase = bases.group;
    this.anchorBase = bases.anchor;
    this.layout.resize(bases.words);
    const f32 = this.layout.f32;
    const placement = this.channels.values('blockPosition');
    for (let block = 0; block < blockCount; block++) {
      this.rest(block, placement);
      f32[2 * block] = this.restX;
      f32[2 * block + 1] = this.restY;
    }
    f32.fill(Number.NaN, bases.group, bases.anchor);
    this.routes.reset(next);
    // The routing below builds the block grid it asks for obstacles; the wire and group grids
    // wait for the first pick, so none of the drain and frame updates below touch the picker.
    this.picker.rebuild();
    this.routes.routeAll(this.context(next));
    this.routes.drain(this.visitRouted);
    for (let group = 0; group < groupCount; group++) this.markGroup(group);
    this.flushGroups('rebuild');
    this.layout.touchAll();
    this.settles++;
  }

  /**
   * Forget the drag, the tween, and the detached port; `sizeTables` forgets the nets they hid,
   * and the nudge hold with them.
   */
  private forgetMoves(): void {
    this.tween = null;
    this.dragSource = null;
    this.dragBlocks = null;
    this.dragX = 0;
    this.dragY = 0;
    this.dragNets = NO_BLOCKS;
    this.dragQuiet = NO_BLOCKS;
    this.dragHidden = false;
    this.dragOut = false;
    this.detached = NONE;
  }

  /**
   * Size the per-item pending-work tables for a netlist's counts, with nothing pending and no
   * net hidden.
   */
  private sizeTables(blockCount: number, netCount: number, groupCount: number): void {
    this.dragged = new Uint8Array(blockCount);
    this.blockState = new Uint8Array(blockCount);
    this.pickList = new Uint32Array(Math.min(blockCount, 64));
    this.pickCount = 0;
    this.drainBlocks = new Uint32Array(Math.min(blockCount, 64));
    this.drainBlockCount = 0;
    this.drainAllBlocks = false;
    this.netState = new Uint8Array(netCount);
    this.routeList = new Uint32Array(Math.min(netCount, 64));
    this.routeCount = 0;
    this.drainNets = new Uint32Array(Math.min(netCount, 64));
    this.drainNetCount = 0;
    this.drainAllNets = false;
    this.groupDirty = new Uint8Array(groupCount);
    this.groupList = new Uint32Array(groupCount);
    this.groupCount = 0;
    this.hideCount = new Uint8Array(netCount);
    this.hiddenTotal = 0;
    this.netStamp = new Uint32Array(netCount);
    this.stamp = 0;
    this.nudgeHeld = new Uint8Array(netCount);
    this.nudgeNets = new Uint32Array(Math.min(netCount, 64));
    this.nudgeCount = 0;
    this.nudgeSeen = Number.NaN;
  }

  /**
   * Measure the label drawn over each wired net, and list the labelled nets in no group, whose
   * labels `bounds` adds itself.
   */
  private measureLabels(p: Prepared): void {
    const labels = p.netlist.netLabel;
    this.labelWidth = new Float32Array(p.netCount);
    let loose = 0;
    if (labels) {
      for (let net = 0; net < p.netCount; net++) {
        const text = labels[net];
        if (p.netStyle[net] !== STYLE_WIRE || !text) continue;
        this.labelWidth[net] = textWidth(text, p.metrics.labelEm);
        if (p.netGroup[net] === NONE) loose++;
      }
    }
    this.looseLabels = new Uint32Array(loose);
    loose = 0;
    for (let net = 0; net < p.netCount; net++) {
      if (this.labelWidth[net]! > 0 && p.netGroup[net] === NONE) this.looseLabels[loose++] = net;
    }
  }

  /** Record ghosts for the blocks of `prev` that no survivor carries, where they were drawn. */
  private addGhosts(prev: Prepared, survivors: Uint32Array, now: number): void {
    const carried = new Uint8Array(prev.blockCount);
    for (const was of survivors) if (was !== NONE) carried[was] = 1;
    const drawn = this.positions;
    const visible = this.channels.values('blockVisible');
    const shows = (block: number): boolean =>
      visible === null || visible.length !== prev.blockCount || visibleAt(visible, block);
    for (let block = 0; block < prev.blockCount; block++) {
      if (carried[block] || !shows(block)) continue;
      const x = drawn[2 * block]!;
      const y = drawn[2 * block + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      this.pushGhost(x, y, x + prev.size[2 * block]!, y + prev.size[2 * block + 1]!, now);
    }
  }

  private pushGhost(x0: number, y0: number, x1: number, y1: number, now: number): void {
    const i = this.ghostCount;
    if (i === this.ghostStart.length) {
      const size = Math.max(16, 2 * i);
      const rects = new Float32Array(4 * size);
      rects.set(this.ghostRects);
      const start = new Float64Array(size);
      start.set(this.ghostStart);
      const alpha = new Float32Array(size);
      alpha.set(this.ghostAlpha);
      this.ghostRects = rects;
      this.ghostStart = start;
      this.ghostAlpha = alpha;
    }
    this.ghostRects[4 * i] = x0;
    this.ghostRects[4 * i + 1] = y0;
    this.ghostRects[4 * i + 2] = x1;
    this.ghostRects[4 * i + 3] = y1;
    this.ghostStart[i] = now;
    this.ghostAlpha[i] = 1;
    this.ghostCount = i + 1;
  }

  /** Fade every ghost linearly to 0 over `animationMs`, dropping the faded ones. */
  private fadeGhosts(now: number): void {
    if (!this.motion || this.animationMs <= 0) {
      this.ghostCount = 0;
      return;
    }
    const rects = this.ghostRects;
    let kept = 0;
    for (let i = 0; i < this.ghostCount; i++) {
      const alpha = 1 - (now - this.ghostStart[i]!) / this.animationMs;
      if (!(alpha > 0)) continue;
      if (kept !== i) {
        rects.copyWithin(4 * kept, 4 * i, 4 * i + 4);
        this.ghostStart[kept] = this.ghostStart[i]!;
      }
      this.ghostAlpha[kept] = Math.min(1, alpha);
      kept++;
    }
    this.ghostCount = kept;
  }

  // Moves.

  /** Whether a move of `blocks` blocks re-indexes more cheaply all at once. */
  private large(blocks: number): boolean {
    return blocks > 64 && blocks > (this.current?.blockCount ?? 0) / 4;
  }

  /**
   * Where block `b` rests without a drag, into `restX` and `restY`: its finite placement, else
   * its drawn automatic spot.
   */
  private rest(block: number, placement: Float32Array | null): void {
    if (placement) {
      const x = placement[2 * block]!;
      const y = placement[2 * block + 1]!;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        this.restX = x;
        this.restY = y;
        return;
      }
    }
    this.restX = this.shown[2 * block]!;
    this.restY = this.shown[2 * block + 1]!;
  }

  /** Write block `b`'s effective position; true when it moved. */
  private placeBlock(block: number, placement: Float32Array | null): boolean {
    this.rest(block, placement);
    let x = this.restX;
    let y = this.restY;
    if (this.dragged[block] === 1) {
      x = Math.fround(x + this.dragX);
      y = Math.fround(y + this.dragY);
    }
    const f32 = this.layout.f32;
    if (f32[2 * block] === x && f32[2 * block + 1] === y) return false;
    f32[2 * block] = x;
    f32[2 * block + 1] = y;
    this.layout.touch(2 * block, 2 * block + 2);
    this.markMoved(block);
    return true;
  }

  /** The placement snapshot to write placements into, binding a NaN-filled one when unbound. */
  private writablePlacement(p: Prepared): Float32Array {
    const bound = this.channels.values('blockPosition');
    if (bound) return bound;
    this.channels.set('blockPosition', new Float32Array(2 * p.blockCount).fill(Number.NaN));
    return this.channels.values('blockPosition')!;
  }

  /** The valid blocks of `blocks`, each once, in order. */
  private unique(p: Prepared, blocks: Uint32Array): Uint32Array {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const block of blocks) {
      if (block >= p.blockCount || seen.has(block)) continue;
      seen.add(block);
      out.push(block);
    }
    return Uint32Array.from(out);
  }

  /** Whether `blocks` names the drag in flight: the same array, or the same blocks. */
  private sameDrag(blocks: Uint32Array): boolean {
    if (blocks === this.dragSource) return true;
    const p = this.current!;
    const own = this.unique(p, blocks);
    const drag = this.dragBlocks!;
    if (own.length !== drag.length) return false;
    for (let i = 0; i < own.length; i++) if (own[i] !== drag[i]) return false;
    this.dragSource = blocks;
    return true;
  }

  private startDrag(p: Prepared, blocks: Uint32Array): void {
    const own = this.unique(p, blocks);
    this.dragSource = blocks;
    this.dragBlocks = own;
    this.dragX = 0;
    this.dragY = 0;
    this.dragHidden = false;
    for (const block of own) this.dragged[block] = 1;
    this.dragNets = this.netsOf(p, own, null);
    this.dragQuiet = this.quiet(p, this.dragNets);
    // Every obstacle query tests the blocks kept out of the index, so a larger drag stays in it
    // and is re-indexed as it moves instead.
    this.dragOut = own.length <= MOVING_BLOCKS;
    if (this.dragOut) this.picker.setMoving(own);
  }

  /**
   * End the drag in flight: its blocks rest at their placements (written first when `commit`),
   * else where they were. Returns what a commit moved, or null.
   */
  private endDrag(commit: boolean): Moved | null {
    const blocks = this.dragBlocks;
    const p = this.current;
    if (!blocks || !p) return null;
    let result: Moved | null = null;
    if (commit) {
      const placement = this.writablePlacement(p);
      const positions = new Float32Array(2 * blocks.length);
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]!;
        this.rest(block, placement);
        placement[2 * block] = this.restX + this.dragX;
        placement[2 * block + 1] = this.restY + this.dragY;
        positions[2 * i] = placement[2 * block]!;
        positions[2 * i + 1] = placement[2 * block + 1]!;
      }
      result = { blocks: blocks.slice(), positions };
    }
    for (const block of blocks) this.dragged[block] = 0;
    this.dragSource = null;
    this.dragBlocks = null;
    this.dragX = 0;
    this.dragY = 0;
    const placement = this.channels.values('blockPosition');
    for (const block of blocks) this.placeBlock(block, placement);
    // The resting positions are written, so the index takes the blocks back before routing asks
    // it for obstacles; it re-indexes their group frames lazily, after the flush writes them.
    if (this.dragOut) this.picker.setMoving(null);
    this.dragOut = false;
    if (this.dragHidden) this.unhide(this.dragQuiet);
    this.dragHidden = false;
    this.dragNets = NO_BLOCKS;
    this.dragQuiet = NO_BLOCKS;
    this.flush('incremental');
    if (commit) this.settles++;
    return result;
  }

  /** Land the tween in flight: every block at its automatic spot, hidden nets routed. */
  private land(): void {
    const tween = this.tween;
    if (!tween) return;
    this.tween = null;
    this.shown.set(this.auto);
    const placement = this.channels.values('blockPosition');
    for (const block of tween.blocks) this.placeBlock(block, placement);
    if (tween.hidden) this.unhide(tween.hidden);
    this.flush(tween.still ? 'rebuild' : 'incremental');
    this.settles++;
  }

  /**
   * The distinct wired nets of `blocks`, skipping blocks with a finite placement when
   * `placement` is given (they are not seen moving); their ports, summed, go to `netsPorts`.
   */
  private netsOf(p: Prepared, blocks: Uint32Array, placement: Float32Array | null): Uint32Array {
    if (++this.stamp === 0xffffffff) {
      this.netStamp.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const { blockNetStart, blockNets, netStyle } = p;
    const { netStart } = p.netlist;
    let list: Uint32Array = new Uint32Array(16);
    let count = 0;
    let ports = 0;
    for (const block of blocks) {
      if (
        placement &&
        Number.isFinite(placement[2 * block]!) &&
        Number.isFinite(placement[2 * block + 1]!)
      ) {
        continue;
      }
      for (let at = blockNetStart[block]!; at < blockNetStart[block + 1]!; at++) {
        const net = blockNets[at]!;
        if (netStyle[net] !== STYLE_WIRE || this.netStamp[net] === stamp) continue;
        this.netStamp[net] = stamp;
        list = room(list, count + 1);
        list[count++] = net;
        ports += netStart[net + 1]! - netStart[net]!;
      }
    }
    this.netsPorts = ports;
    return list.slice(0, count);
  }

  /**
   * The nets of a move (as `netsOf` just found them) that it would re-route too slowly on every
   * step: all of them when their ports sum past `liveRoutePorts`, else those with more than
   * `liveNetPorts` ports; none when every one routes live.
   */
  private quiet(p: Prepared, nets: Uint32Array): Uint32Array {
    if (this.netsPorts > this.liveRoutePorts) return nets;
    const { netStart } = p.netlist;
    const limit = this.liveNetPorts;
    let count = 0;
    for (const net of nets) if (netStart[net + 1]! - netStart[net]! > limit) count++;
    if (count === 0) return NO_BLOCKS;
    const wide = new Uint32Array(count);
    count = 0;
    for (const net of nets) if (netStart[net + 1]! - netStart[net]! > limit) wide[count++] = net;
    return wide;
  }

  /** Hold `nets` hidden for the burst of nudges in flight, each net once. */
  private holdNudged(nets: Uint32Array): void {
    const fresh = new Uint32Array(nets.length);
    let count = 0;
    for (const net of nets) {
      if (this.nudgeHeld[net] === 1) continue;
      this.nudgeHeld[net] = 1;
      fresh[count++] = net;
      this.nudgeNets = room(this.nudgeNets, this.nudgeCount + 1);
      this.nudgeNets[this.nudgeCount++] = net;
    }
    if (count > 0) this.hide(fresh.subarray(0, count));
  }

  /** End a burst of nudges: the nets it held route again, all at once. */
  private releaseNudged(): void {
    const nets = this.nudgeNets.subarray(0, this.nudgeCount);
    for (const net of nets) this.nudgeHeld[net] = 0;
    this.unhide(nets);
    this.nudgeCount = 0;
    this.nudgeSeen = Number.NaN;
    this.flush('incremental');
  }

  /** Hide nets for a large move; a net already hidden by another move stays hidden. */
  private hide(nets: Uint32Array): void {
    let fresh = 0;
    const clear = new Uint32Array(nets.length);
    for (const net of nets) {
      if (this.hideCount[net]!++ === 0) {
        clear[fresh++] = net;
        this.hiddenTotal++;
      }
    }
    if (fresh > 0) this.routes.hide(clear.subarray(0, fresh));
  }

  /** End one move's hold on nets; those no move hides any longer route again. */
  private unhide(nets: Uint32Array): void {
    for (const net of nets) {
      if (this.hideCount[net] === 0) continue;
      if (--this.hideCount[net]! === 0) {
        this.hiddenTotal--;
        this.markRoute(net);
      }
    }
  }

  // Pending work.

  /** Queue what follows a block's move: its re-index, its report, its group, its nets. */
  private markMoved(block: number): void {
    const p = this.current!;
    const state = this.blockState[block]!;
    if (!(state & PENDING_PICK)) {
      this.pickList = room(this.pickList, this.pickCount + 1);
      this.pickList[this.pickCount++] = block;
    }
    if (!this.drainAllBlocks && !(state & PENDING_DRAIN)) {
      this.drainBlocks = room(this.drainBlocks, this.drainBlockCount + 1);
      this.drainBlocks[this.drainBlockCount++] = block;
      this.blockState[block] = state | PENDING_PICK | PENDING_DRAIN;
    } else this.blockState[block] = state | PENDING_PICK;
    this.markGroup(p.blockGroup[block]!);
    for (let at = p.blockNetStart[block]!; at < p.blockNetStart[block + 1]!; at++) {
      this.markRoute(p.blockNets[at]!);
    }
  }

  /** Queue a wired net for re-routing. */
  private markRoute(net: number): void {
    const p = this.current!;
    if (net === NONE || net >= p.netCount || p.netStyle[net] !== STYLE_WIRE) return;
    if (this.netState[net]! & PENDING_ROUTE) return;
    this.netState[net]! |= PENDING_ROUTE;
    this.routeList = room(this.routeList, this.routeCount + 1);
    this.routeList[this.routeCount++] = net;
  }

  /** Queue a group's frame for recomputing. */
  private markGroup(group: number): void {
    if (group === NONE || group >= this.groupDirty.length || this.groupDirty[group] === 1) return;
    this.groupDirty[group] = 1;
    this.groupList[this.groupCount++] = group;
  }

  /** A net whose entries changed: the picker's wire index, the drain, and its group's frame. */
  private readonly visitRouted = (net: number): void => {
    this.picker.rerouted(net);
    if (!this.drainAllNets && !(this.netState[net]! & PENDING_DRAIN)) {
      this.netState[net]! |= PENDING_DRAIN;
      this.drainNets = room(this.drainNets, this.drainNetCount + 1);
      this.drainNets[this.drainNetCount++] = net;
    }
    this.markGroup(this.current!.netGroup[net]!);
  };

  /**
   * Carry every queued change through, in the order each step reads the last: the picker learns
   * where moved blocks are, touched nets re-route around them, and group frames enclose both.
   */
  private flush(pick: PickUpdate): void {
    const p = this.current;
    if (!p) return;
    if (pick === 'rebuild') this.picker.rebuild();
    for (let i = 0; i < this.pickCount; i++) {
      const block = this.pickList[i]!;
      this.blockState[block]! &= ~PENDING_PICK;
      if (pick === 'incremental') this.picker.moved(block);
    }
    this.pickCount = 0;

    let count = 0;
    const list = this.routeList;
    for (let i = 0; i < this.routeCount; i++) {
      const net = list[i]!;
      this.netState[net]! &= ~PENDING_ROUTE;
      if (this.hideCount[net] === 0) list[count++] = net;
    }
    this.routeCount = 0;
    if (count > 0) {
      const ctx = this.context(p);
      if (count > p.netCount / 2) {
        this.routes.routeAll(ctx);
        if (this.hiddenTotal > 0) this.routes.hide(this.hiddenNets(p));
      } else this.routes.reroute(list.subarray(0, count), ctx);
    }
    this.routes.drain(this.visitRouted);
    this.flushGroups(pick);
  }

  /** Every net a move hides. */
  private hiddenNets(p: Prepared): Uint32Array {
    const out = new Uint32Array(this.hiddenTotal);
    let count = 0;
    for (let net = 0; net < p.netCount; net++) if (this.hideCount[net]! > 0) out[count++] = net;
    return out.subarray(0, count);
  }

  /**
   * Recompute every queued group frame; an incremental update tells the picker which changed
   * (a rebuild re-indexes every frame anyway).
   */
  private flushGroups(pick: PickUpdate): void {
    const p = this.current!;
    const visible = this.channels.values('blockVisible');
    for (let i = 0; i < this.groupCount; i++) {
      const group = this.groupList[i]!;
      this.groupDirty[group] = 0;
      if (this.frameGroup(p, group, visible) && pick === 'incremental') this.picker.framed(group);
    }
    this.groupCount = 0;
  }

  /**
   * Write a group's frame: its shown members with extents and its internal nets' wires and
   * labels, padded, with the header on top; NaN when no member shows. True when it changed.
   */
  private frameGroup(p: Prepared, group: number, visible: Float32Array | null): boolean {
    const box = emptyBox(this.box);
    for (let at = p.groupStart[group]!; at < p.groupStart[group + 1]!; at++) {
      const block = p.groupBlocks[at]!;
      if (visibleAt(visible, block)) this.addBlock(box, p, block);
    }
    let x0 = Number.NaN;
    let y0 = Number.NaN;
    let x1 = Number.NaN;
    let y1 = Number.NaN;
    if (box[0]! <= box[2]!) {
      for (let at = this.groupNetStart[group]!; at < this.groupNetStart[group + 1]!; at++) {
        const net = this.groupNets[at]!;
        const start = this.routes.slotStart(net);
        this.addEntries(box, start, start + this.routes.slotCount(net));
        this.addLabel(box, p, net);
      }
      const { groupPad, groupHeader } = p.metrics;
      x0 = Math.fround(box[0]! - groupPad);
      y0 = Math.fround(box[1]! - groupPad - groupHeader);
      x1 = Math.fround(box[2]! + groupPad);
      y1 = Math.fround(box[3]! + groupPad);
    }
    const f32 = this.layout.f32;
    const at = this.groupBase + 4 * group;
    if (
      Object.is(f32[at], x0) &&
      Object.is(f32[at + 1], y0) &&
      Object.is(f32[at + 2], x1) &&
      Object.is(f32[at + 3], y1)
    ) {
      return false;
    }
    f32[at] = x0;
    f32[at + 1] = y0;
    f32[at + 2] = x1;
    f32[at + 3] = y1;
    this.layout.touch(at, at + 4);
    return true;
  }

  /** Grow `box` by a block's rectangle with its extents, when it has a position. */
  private addBlock(box: Float64Array, p: Prepared, block: number): void {
    const f32 = this.layout.f32;
    const x = f32[2 * block]!;
    const y = f32[2 * block + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const e = 4 * block;
    addPoint(box, x - p.extent[e]!, y - p.extent[e + 1]!);
    addPoint(
      box,
      x + p.size[2 * block]! + p.extent[e + 2]!,
      y + p.size[2 * block + 1]! + p.extent[e + 3]!,
    );
  }

  /** Grow `box` by a port's marker, when its block shows and has a position. */
  private addPort(box: Float64Array, p: Prepared, port: number): void {
    const block = p.portBlock[port]!;
    if (!this.blockVisible(block)) return;
    const f32 = this.layout.f32;
    const x = f32[2 * block]! + p.portOffset[2 * port]!;
    const y = f32[2 * block + 1]! + p.portOffset[2 * port + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const half = p.metrics.portSize / 2;
    addPoint(box, x - half, y - half);
    addPoint(box, x + half, y + half);
  }

  /** Grow `box` by a group's frame, when it has one. */
  private addGroup(box: Float64Array, group: number): void {
    const f32 = this.layout.f32;
    const at = this.groupBase + 4 * group;
    addPoint(box, f32[at]!, f32[at + 1]!);
    addPoint(box, f32[at + 2]!, f32[at + 3]!);
  }

  /**
   * Grow `box` by the label drawn over a net's wire, when the net shows, is routed (its anchor is
   * finite), and has a label: its `netLabelBox`, where the text pass draws it.
   */
  private addLabel(box: Float64Array, p: Prepared, net: number): void {
    const width = this.labelWidth[net]!;
    if (!(width > 0) || !this.netVisible(net)) return;
    const f32 = this.layout.f32;
    const x = f32[this.anchorBase + 2 * net]!;
    const y = f32[this.anchorBase + 2 * net + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const label = netLabelBox(p.metrics, x, y, width, this.labelBox);
    addPoint(box, label[0]!, label[1]!);
    addPoint(box, label[2]!, label[3]!);
  }

  /** Grow `box` by wire entries `[from, to)`: segments by both ends, the rest by their point. */
  private addEntries(box: Float64Array, from: number, to: number): void {
    const { f32, u32 } = this.wires;
    const end = Math.min(to, Math.floor(this.wires.words / WIRE_WORDS));
    for (let entry = from; entry < end; entry++) {
      const at = entry * WIRE_WORDS;
      const kind = u32[at + 5]!;
      if (kind === WIRE_EMPTY) continue;
      addPoint(box, f32[at]!, f32[at + 1]!);
      if (kind === WIRE_SEGMENT) addPoint(box, f32[at + 2]!, f32[at + 3]!);
    }
  }

  /** What the router reads now. */
  private context(p: Prepared): RouteContext {
    return {
      prepared: p,
      positions: this.positions,
      blockVisible: this.channels.values('blockVisible'),
      netVisible: this.channels.values('netVisible'),
      mode: this.mode,
      obstacles: this.obstacles,
      detached: this.detached,
      laneShift: this.shifts,
    };
  }
}

/** Reset a `[x0, y0, x1, y1]` box to hold nothing. */
function emptyBox(box: Float64Array): Float64Array {
  box[0] = Infinity;
  box[1] = Infinity;
  box[2] = -Infinity;
  box[3] = -Infinity;
  return box;
}

/** Grow a `[x0, y0, x1, y1]` box to hold a finite point. */
function addPoint(box: Float64Array, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < box[0]!) box[0] = x;
  if (y < box[1]!) box[1] = y;
  if (x > box[2]!) box[2] = x;
  if (y > box[3]!) box[3] = y;
}

/** Whether a visibility channel shows item `index`: unbound, or a value above zero. */
function visibleAt(values: Float32Array | null, index: number): boolean {
  return values === null || values[index]! > 0;
}

/** A box as a rectangle, or null when it holds nothing. */
function rectOf(box: Float64Array): Rect | null {
  return box[0]! <= box[2]! ? [box[0]!, box[1]!, box[2]!, box[3]!] : null;
}
