/**
 * The semantic layer: gestures and key intents become selection, drag previews, camera moves, and
 * proposal events, by interaction mode. Pure logic over an injected context, so it runs without a
 * DOM or a device.
 */

import type { Events } from './controller.js';
import type { Focus } from './focus.js';
import { snapTo, type Rect } from './geometry.js';
import type { Gesture } from './input/gestures.js';
import type { KeyIntent } from './input/keyboard.js';
import type { Interaction } from './options.js';
import {
  PART_BLOCK,
  PART_GROUP,
  PART_NET,
  PART_PORT,
  partId,
  partIndex,
  partKind,
  partOf,
} from './part.js';
import { FLOW_IN, NONE, type Prepared } from './prepare.js';
import type { Scene } from './scene.js';
import { VISUAL } from './visual.js';

/** The events an interaction emits. */
export type InteractionEvent =
  'select' | 'open' | 'connect' | 'move' | 'delete' | 'contextmenu' | 'hover';

/** Everything the interactor reads and drives; the controller provides it. */
export interface InteractionContext {
  /** The live `interaction` option. */
  mode(): Interaction;
  /** The live `snap` option. */
  snap(): boolean;
  /** Whether motion is reduced right now. */
  reduced(): boolean;
  /** The loaded netlist, prepared, or null. */
  prepared(): Prepared | null;
  /** Canvas-local CSS px to diagram units. */
  toDiagram(sx: number, sy: number): readonly [number, number];
  /** CSS pixels per diagram unit. */
  zoom(): number;
  /** The canvas size in CSS px. */
  viewport(): { readonly w: number; readonly h: number };
  /** The canvas's client rectangle, read fresh: where client coordinates meet canvas-local ones. */
  rect(): Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>;
  /** The live `pickRadiusPx` option: the radius a pointer context request picks within. */
  pickRadiusPx(): number;
  /** Part ids under a canvas-local point, in priority order. */
  pick(sx: number, sy: number, radiusPx: number): readonly number[];
  /** A part's anchor in canvas-local CSS px, as `Diagram.locate` finds it, or null. */
  locate(id: number): readonly [number, number] | null;
  /** Blocks intersecting a diagram rectangle. */
  marquee(x0: number, y0: number, x1: number, y1: number): Uint32Array;
  /**
   * The compatible drop target near a diagram point for a wire from `from` (replacing
   * `replaces`, `NONE` for a new wire), as a part id, or null. `radius` is in diagram units.
   */
  target(from: number, replaces: number, x: number, y: number, radius: number): number | null;
  /** Every port/net part id a wire from `from` could land on (for the glow). */
  compatible(from: number, replaces: number): Iterable<number>;
  /** The scene the drags move. */
  scene: Scene;
  /** Hover, selection, and glow. */
  focus: Focus;
  /** Camera moves, in CSS px about canvas-local points. */
  camera: {
    panBy(dx: number, dy: number): void;
    zoomAt(factor: number, sx: number, sy: number): void;
    fit(): void;
  };
  /** Overlay shapes in diagram units; null removes one. The wire target highlights by focus. */
  overlay: {
    marquee(r: Rect | null): void;
    preview(points: Float32Array | null): void;
  };
  /**
   * A route for the wire preview from a port to a free point or a target part id, as `x, y`
   * points (reuses the orthogonal rules).
   */
  previewRoute(from: number, x: number, y: number, target: number | null): Float32Array;
  /**
   * Show a picked-up port's wire detached: route its net as if `port` were off it while the wire
   * is carried elsewhere; null routes it whole again.
   */
  detach(port: number | null): void;
  /** Deliver an event to the host. */
  emit: <K extends InteractionEvent>(event: K, payload: Events[K]) => void;
  /** Schedule a frame. */
  repaint(): void;
}

/** What the drag in flight does. */
type Drag = 'none' | 'pan' | 'wire' | 'move' | 'marquee';

/** Grid steps one large (Shift) arrow nudge moves blocks. */
const NUDGE_LARGE = 4;

/** Longest frame gap one auto-pan step integrates, in ms, so a stalled tab never lurches. */
const AUTO_PAN_STEP_MS = 100;

const NO_BLOCKS = new Uint32Array(0);

/**
 * The interaction state machine: one press becomes a wire, a move, a marquee, or a pan by mode
 * and target; taps select and cycle; keys nudge, step, walk, open, cancel, and delete; drags near
 * an edge auto-pan.
 *
 * @remarks
 * `hover` and `hoverEnd` gestures are the controller's: it resolves the latest probe in the frame
 * while `active` is false. A drag clears hover when it starts. Nothing here emits from `tick`, so
 * the frame never calls a host handler.
 */
export class Interactor {
  /** What the drag in flight does. */
  private drag: Drag = 'none';
  /** Whether a press awaits its tap or drag; a cancel abandons its drag. */
  private pressed = false;
  /** The press: canvas-local point, button, pointer, Shift, any modifier, and pick radius. */
  private pressSx = 0;
  private pressSy = 0;
  private pressButton = 0;
  private pressTouch = false;
  private pressShift = false;
  private pressModifier = false;
  private pressPx = 0;
  /** The dragging pointer, canvas-local CSS px. */
  private pointerSx = 0;
  private pointerSy = 0;
  /** Where the drag started, in diagram units; it stays under the pointer through auto-pan. */
  private anchorX = 0;
  private anchorY = 0;
  /** Blocks a move carries and their offset, snapped when `snap` is on. */
  private blocks: Uint32Array = NO_BLOCKS;
  private offsetX = 0;
  private offsetY = 0;
  /** A wire's fixed end, the port it replaces (`NONE` for a new wire), its glow, and target. */
  private from = NONE;
  private replaces = NONE;
  private compatible: readonly number[] = [];
  private target: number | null = null;
  /** Whether a marquee adds to the selection. */
  private additive = false;
  /**
   * Whether Space is held: a primary drag pans in `edit`. Only its release clears it, which the
   * keyboard adapter also reports as it is torn down, so it never disagrees with the key.
   */
  private space = false;
  /** Whether a wheel or pinch navigation is in flight. */
  private navigating = false;
  /** Whether the last tap toggled with a modifier, so a double tap leaves the selection alone. */
  private toggled = false;
  /** The last auto-pan step's timestamp; NaN while not auto-panning. */
  private autoPanAt = Number.NaN;

  constructor(private readonly ctx: InteractionContext) {}

  /** Whether a drag, wire, marquee, pan, or a wheel or pinch navigation is in flight. */
  get active(): boolean {
    return this.drag !== 'none' || this.navigating;
  }

  /**
   * Whether a pointer drag is in flight: a move, wire, marquee, or pan. A wheel or pinch
   * navigation is not one; the gesture adapter holds no drag of it for a cancel to end.
   */
  get dragging(): boolean {
    return this.drag !== 'none';
  }

  /** Handle one pointer, wheel, or touch gesture. */
  gesture(g: Gesture): void {
    const mode = this.ctx.mode();
    if (mode === 'none') return;
    switch (g.kind) {
      case 'press':
        this.pressed = true;
        this.pressSx = g.sx;
        this.pressSy = g.sy;
        this.pressButton = g.button;
        this.pressTouch = g.pointerType === 'touch';
        this.pressShift = g.shift;
        this.pressModifier = g.shift || g.mod;
        this.pressPx = g.targetPx;
        return;
      case 'dragStart':
        this.begin(mode);
        return;
      case 'dragMove':
        this.dragMove(g.sx, g.sy, g.dx, g.dy);
        return;
      case 'dragEnd':
        this.dragEnd(g.sx, g.sy, g.clientX, g.clientY, g.cancelled);
        return;
      case 'tap':
        this.pressed = false;
        this.tap(g.sx, g.sy, g.targetPx, g.shift || g.mod);
        return;
      case 'doubleTap':
        this.pressed = false;
        this.doubleTap(mode, g.sx, g.sy, g.targetPx);
        return;
      case 'zoom':
        if (!navigable(mode)) return;
        this.ctx.camera.zoomAt(g.factor, g.sx, g.sy);
        this.follow();
        this.ctx.repaint();
        return;
      case 'pan':
        if (!navigable(mode)) return;
        this.ctx.camera.panBy(g.dx, g.dy);
        this.follow();
        this.ctx.repaint();
        return;
      case 'contextmenu':
        this.contextMenu(g.event, g.keyboard);
        return;
      case 'navigationStart':
        this.navigating = true;
        this.clearHover();
        return;
      case 'navigationEnd':
        // The controller schedules the frame that picks hover again, now the camera rests.
        this.navigating = false;
        return;
      case 'hover':
      case 'hoverEnd':
        // The controller resolves hover in the frame, from the latest probe.
        return;
      default:
        /* v8 ignore next -- compile-time exhaustive gesture guard. */
        g satisfies never;
    }
  }

  /** Handle one key intent; returns whether it was used, so an unused Tab leaves the canvas. */
  key(k: KeyIntent): boolean {
    const ctx = this.ctx;
    const mode = ctx.mode();
    if (k.kind === 'space') {
      // A release lands in every mode: the key was pressed in `edit`, and the mode may have moved
      // on (to `none` as well) while it was held.
      this.space = k.down && mode === 'edit';
      return mode === 'edit';
    }
    if (mode === 'none') return false;
    if (k.kind === 'escape') {
      if (this.abort()) return true;
      if (ctx.focus.selection.size === 0) return false;
      ctx.focus.select([]);
      ctx.repaint();
      this.emitSelection();
      return true;
    }
    // Everything else waits for the drag to end, and keeps the page from reacting meanwhile.
    if (this.drag !== 'none') return true;
    const prepared = ctx.prepared();
    if (!prepared) return false;
    switch (k.kind) {
      case 'arrow':
        return this.arrow(mode, prepared, k.dx, k.dy, k.large);
      case 'zoom': {
        if (mode === 'inspect') return false;
        const { w, h } = ctx.viewport();
        ctx.camera.zoomAt(k.factor, w / 2, h / 2);
        ctx.repaint();
        return true;
      }
      case 'fit':
        if (mode === 'inspect') return false;
        ctx.camera.fit();
        ctx.repaint();
        return true;
      case 'tab':
        return this.walk(prepared, k.back);
      case 'open': {
        const first = firstOf(ctx.focus.selection);
        if (first === undefined) return false;
        ctx.emit('open', partOf(first));
        return true;
      }
      case 'delete':
        if (mode !== 'edit' || ctx.focus.selection.size === 0) return false;
        ctx.emit('delete', ctx.focus.parts());
        return true;
      default:
        /* v8 ignore next -- compile-time exhaustive key guard. */
        k satisfies never;
        return false;
    }
  }

  /**
   * Abandon whatever is in flight, restoring what it previewed: the drag, and a pending press,
   * whose drag then does nothing (released in place, it still taps what lies there now). A held
   * Space stays held, since the key is still down. A wheel or pinch navigation is forgotten: its
   * adapter may go away without reporting the end, and one that ends early only lets hover
   * resolve sooner.
   */
  cancel(): void {
    this.abort();
    this.pressed = false;
    this.navigating = false;
    this.toggled = false;
  }

  /** Advance auto-pan; true while it runs. */
  tick(now: number): boolean {
    const drag = this.drag;
    if ((drag !== 'move' && drag !== 'wire' && drag !== 'marquee') || this.ctx.reduced()) {
      return this.stopAutoPan();
    }
    const { w, h } = this.ctx.viewport();
    if (!(w > 0 && h > 0)) return this.stopAutoPan();
    const vx = edgeSpeed(this.pointerSx, w);
    const vy = edgeSpeed(this.pointerSy, h);
    if (vx === 0 && vy === 0) return this.stopAutoPan();
    const last = this.autoPanAt;
    this.autoPanAt = now;
    // The first frame in the zone only starts the clock.
    const dt = Number.isNaN(last) ? 0 : Math.min(Math.max(now - last, 0), AUTO_PAN_STEP_MS);
    if (dt > 0) {
      this.ctx.camera.panBy((vx * dt) / 1000, (vy * dt) / 1000);
      this.follow();
    }
    return true;
  }

  /**
   * A press crossed its drag threshold: decide what the drag does by mode and target. The adapter
   * only starts a drag it pressed, so one without a press is what a cancel (a load, a grid
   * change, a mode change) left of it: abandoned, it does nothing, rather than panning a drag
   * aimed at a block, a port, or a marquee.
   */
  private begin(mode: Interaction): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.abort();
    if (!navigable(mode)) return;
    this.pointerSx = this.pressSx;
    this.pointerSy = this.pressSy;
    const [x, y] = this.ctx.toDiagram(this.pressSx, this.pressSy);
    this.anchorX = x;
    this.anchorY = y;
    const selected = this.start(mode);
    this.ctx.repaint();
    // The host hears of it once the drag is under way, so a handler that loads cancels it cleanly.
    this.clearHover();
    if (selected) this.emitSelection();
  }

  /**
   * Start the drag a press makes, by mode and pressed part; true when the pressed block became
   * the selection.
   */
  private start(mode: Interaction): boolean {
    if (this.pressButton !== 0 || (mode === 'edit' && this.space)) {
      this.drag = 'pan';
      return false;
    }
    if (mode === 'navigate') {
      if (this.pressShift && !this.pressTouch) this.startMarquee(true);
      else this.drag = 'pan';
      return false;
    }
    const prepared = this.ctx.prepared();
    const top = prepared ? this.ctx.pick(this.pressSx, this.pressSy, this.pressPx)[0] : undefined;
    const kind = top === undefined ? -1 : partKind(top);
    if (kind === PART_BLOCK) return this.startBlockMove(top!);
    if (kind === PART_PORT) this.startWire(prepared!, partIndex(top!));
    else if (kind === PART_GROUP) this.startGroupMove(prepared!, partIndex(top!));
    else if (this.pressTouch) this.drag = 'pan';
    else this.startMarquee(this.pressShift);
    return false;
  }

  /**
   * Draw a wire from `port`, or pick up its wire when it is an `in` port wired to others: the
   * fixed end is then the net's driver, else another port on it.
   */
  private startWire(prepared: Prepared, port: number): void {
    let from = port;
    let replaces = NONE;
    const net = prepared.portNet[port]!;
    if (net !== NONE && prepared.netlist.portFlow[port] === FLOW_IN) {
      const fixed = fixedEnd(prepared, net, port);
      if (fixed !== NONE) {
        from = fixed;
        replaces = port;
      }
    }
    this.from = from;
    this.replaces = replaces;
    this.target = null;
    this.compatible = Array.from(this.ctx.compatible(from, replaces));
    this.drag = 'wire';
    this.ctx.focus.setGlow(this.compatible, null);
    if (replaces !== NONE) this.ctx.detach(replaces);
    this.follow();
  }

  /**
   * Move the selected blocks, making the pressed block the selection when it is not in it; true
   * when it did, for the caller to announce.
   */
  private startBlockMove(id: number): boolean {
    const focus = this.ctx.focus;
    const selected = !focus.selection.has(id) && focus.select([id]);
    this.startMove(focus.selectedBlocks());
    return selected;
  }

  /** Move every member of a group pressed on its frame outside any block. */
  private startGroupMove(prepared: Prepared, group: number): void {
    const { groupStart, groupBlocks } = prepared;
    this.startMove(groupBlocks.slice(groupStart[group]!, groupStart[group + 1]!));
  }

  private startMove(blocks: Uint32Array): void {
    if (blocks.length === 0) return;
    this.blocks = blocks;
    this.offsetX = 0;
    this.offsetY = 0;
    this.drag = 'move';
    this.ctx.focus.setDragging(blocks);
    // The scene learns the dragged set at once: it may hide their nets and exclude them from picks.
    this.ctx.scene.drag(blocks, 0, 0);
  }

  private startMarquee(additive: boolean): void {
    this.additive = additive;
    this.drag = 'marquee';
    this.follow();
  }

  private dragMove(sx: number, sy: number, dx: number, dy: number): void {
    if (this.drag === 'none') return;
    this.pointerSx = sx;
    this.pointerSy = sy;
    if (this.drag === 'pan') this.ctx.camera.panBy(dx, dy);
    else this.follow();
    this.ctx.repaint();
  }

  private dragEnd(
    sx: number,
    sy: number,
    clientX: number,
    clientY: number,
    cancelled: boolean,
  ): void {
    const drag = this.drag;
    if (drag === 'none') return;
    if (cancelled) {
      this.abort();
      return;
    }
    this.pointerSx = sx;
    this.pointerSy = sy;
    if (drag === 'move') this.endMove();
    else if (drag === 'wire') this.endWire(sx, sy, clientX, clientY);
    else if (drag === 'marquee') this.endMarquee();
    else this.reset();
  }

  /** Commit a move where the pointer let go; a move back to where it started changes nothing. */
  private endMove(): void {
    const ctx = this.ctx;
    this.follow();
    const still = this.offsetX === 0 && this.offsetY === 0;
    this.reset();
    ctx.focus.setDragging(null);
    let moved: Events['move'] | null = null;
    if (still) ctx.scene.drag(null, 0, 0);
    else moved = ctx.scene.commitDrag();
    ctx.repaint();
    if (moved) ctx.emit('move', moved);
  }

  /**
   * Propose the wire where it was released: onto a compatible target, or onto empty canvas
   * (`to: null`); over anything else, the replaced port included, it is dropped.
   */
  private endWire(sx: number, sy: number, clientX: number, clientY: number): void {
    const ctx = this.ctx;
    const { from, replaces } = this;
    const [x, y] = ctx.toDiagram(sx, sy);
    const target = ctx.target(from, replaces, x, y, this.targetRadius());
    let to: Events['connect']['to'] | undefined;
    if (target !== null) {
      const kind = partKind(target);
      if (kind === PART_PORT) to = { kind: 'port', index: partIndex(target) };
      else if (kind === PART_NET) to = { kind: 'net', index: partIndex(target) };
    } else if (this.overCanvas(sx, sy)) {
      to = null;
    }
    const point = this.snapped(x, y);
    this.reset();
    this.clearWire(replaces);
    ctx.repaint();
    if (to === undefined) return;
    ctx.emit('connect', {
      from,
      to,
      replaces: replaces === NONE ? null : replaces,
      point,
      clientX,
      clientY,
    });
  }

  /** Select the blocks a marquee touches, after the selection when it adds. */
  private endMarquee(): void {
    const ctx = this.ctx;
    const [x0, y0, x1, y1] = this.marqueeRect();
    const additive = this.additive;
    this.reset();
    ctx.overlay.marquee(null);
    const ids = new Set<number>(additive ? ctx.focus.selection : []);
    for (const block of ctx.marquee(x0, y0, x1, y1)) ids.add(partId(PART_BLOCK, block));
    const changed = ctx.focus.select(ids);
    ctx.repaint();
    if (changed) this.emitSelection();
  }

  /** End the drag in flight without proposing anything; false when there was none. */
  private abort(): boolean {
    const ctx = this.ctx;
    const drag = this.drag;
    if (drag === 'none') return false;
    const replaces = this.replaces;
    this.reset();
    if (drag === 'move') {
      ctx.scene.drag(null, 0, 0);
      ctx.focus.setDragging(null);
    } else if (drag === 'wire') {
      this.clearWire(replaces);
    } else if (drag === 'marquee') {
      ctx.overlay.marquee(null);
    }
    ctx.repaint();
    return true;
  }

  /** Forget the drag in flight; its shapes are the caller's to clear. */
  private reset(): void {
    this.drag = 'none';
    this.blocks = NO_BLOCKS;
    this.compatible = [];
    this.target = null;
    this.autoPanAt = Number.NaN;
  }

  private clearWire(replaces: number): void {
    this.ctx.focus.setGlow(null, null);
    this.ctx.overlay.preview(null);
    if (replaces !== NONE) this.ctx.detach(null);
  }

  /** Bring the drag's preview to the pointer: after a move, a camera change, or auto-pan. */
  private follow(): void {
    const ctx = this.ctx;
    switch (this.drag) {
      case 'move': {
        const [x, y] = ctx.toDiagram(this.pointerSx, this.pointerSy);
        let dx = x - this.anchorX;
        let dy = y - this.anchorY;
        const prepared = ctx.prepared();
        if (prepared && ctx.snap()) {
          dx = snapTo(dx, prepared.metrics.grid);
          dy = snapTo(dy, prepared.metrics.grid);
        }
        if (dx === this.offsetX && dy === this.offsetY) return;
        this.offsetX = dx;
        this.offsetY = dy;
        ctx.scene.drag(this.blocks, dx, dy);
        return;
      }
      case 'wire': {
        const [x, y] = ctx.toDiagram(this.pointerSx, this.pointerSy);
        const target = ctx.target(this.from, this.replaces, x, y, this.targetRadius());
        if (target !== this.target) {
          this.target = target;
          ctx.focus.setGlow(this.compatible, target);
        }
        const [px, py] = this.snapped(x, y);
        ctx.overlay.preview(ctx.previewRoute(this.from, px, py, target));
        return;
      }
      case 'marquee':
        ctx.overlay.marquee(this.marqueeRect());
        return;
      default:
        return;
    }
  }

  /** The marquee from its anchor to the pointer, in diagram units. */
  private marqueeRect(): Rect {
    const [x, y] = this.ctx.toDiagram(this.pointerSx, this.pointerSy);
    return [
      Math.min(this.anchorX, x),
      Math.min(this.anchorY, y),
      Math.max(this.anchorX, x),
      Math.max(this.anchorY, y),
    ];
  }

  /** A wire finds its target within `max(16, pick radius)` CSS px, in diagram units. */
  private targetRadius(): number {
    return Math.max(VISUAL.wireTargetPx, this.pressPx) / this.ctx.zoom();
  }

  /** A diagram point on the grid when `snap` is on. */
  private snapped(x: number, y: number): readonly [number, number] {
    const prepared = this.ctx.prepared();
    if (!prepared || !this.ctx.snap()) return [x, y];
    return [snapTo(x, prepared.metrics.grid), snapTo(y, prepared.metrics.grid)];
  }

  /** Whether a canvas-local point is empty canvas: inside it, over nothing but group frames. */
  private overCanvas(sx: number, sy: number): boolean {
    const { w, h } = this.ctx.viewport();
    if (!(sx >= 0 && sy >= 0 && sx <= w && sy <= h)) return false;
    for (const id of this.ctx.pick(sx, sy, this.pressPx)) {
      if (partKind(id) !== PART_GROUP) return false;
    }
    return true;
  }

  /**
   * Select the first part under a tap, or toggle it with a modifier. A plain tap on the one
   * selected part moves on to the next in the stack; a plain tap on empty canvas clears.
   */
  private tap(sx: number, sy: number, targetPx: number, modifier: boolean): void {
    const focus = this.ctx.focus;
    const hits = this.ctx.pick(sx, sy, targetPx);
    this.toggled = modifier;
    let changed: boolean;
    if (hits.length === 0) {
      changed = !modifier && focus.select([]);
    } else if (modifier) {
      focus.toggle(hits[0]!);
      changed = true;
    } else {
      changed = focus.select([cycle(hits, focus.selection)]);
    }
    if (!changed) return;
    this.ctx.repaint();
    this.emitSelection();
  }

  /**
   * Open the top part under a double tap, or fit over empty canvas. The top part becomes the
   * selection, announced only when that changes it, unless either click carried a modifier: the
   * selection the first one toggled then stands.
   */
  private doubleTap(mode: Interaction, sx: number, sy: number, targetPx: number): void {
    const ctx = this.ctx;
    const top = ctx.pick(sx, sy, targetPx)[0];
    if (top === undefined) {
      if (mode === 'inspect') return;
      ctx.camera.fit();
      ctx.repaint();
      return;
    }
    if (!this.toggled && !this.pressModifier && ctx.focus.select([top])) {
      ctx.repaint();
      this.emitSelection();
    }
    ctx.emit('open', partOf(top));
  }

  /**
   * A context request: at the pointer with what lies there, or, from the keyboard, at the first
   * selected part (the canvas center without one) kept inside the canvas, about the selection.
   */
  private contextMenu(event: MouseEvent, keyboard: boolean): void {
    const ctx = this.ctx;
    const rect = ctx.rect();
    if (keyboard) {
      const first = firstOf(ctx.focus.selection);
      const at = first === undefined ? null : ctx.locate(first);
      const [clientX, clientY] = clampInside(
        at ? [rect.left + at[0], rect.top + at[1]] : null,
        rect,
      );
      ctx.emit('contextmenu', { event, keyboard, clientX, clientY, parts: ctx.focus.parts() });
      return;
    }
    const { clientX, clientY } = event;
    const ids = ctx.pick(clientX - rect.left, clientY - rect.top, ctx.pickRadiusPx());
    ctx.emit('contextmenu', { event, keyboard, clientX, clientY, parts: ids.map(partOf) });
  }

  /** Nudge the selected blocks in `edit`, step the selection in `inspect`, else pan. */
  private arrow(
    mode: Interaction,
    prepared: Prepared,
    dx: number,
    dy: number,
    large: boolean,
  ): boolean {
    const ctx = this.ctx;
    if (mode === 'inspect') {
      this.step(prepared, dx, dy);
      return true;
    }
    if (mode === 'edit') {
      const blocks = ctx.focus.selectedBlocks();
      if (blocks.length > 0) {
        const d = prepared.metrics.grid * (large ? NUDGE_LARGE : 1);
        const moved = ctx.scene.nudge(blocks, dx * d, dy * d);
        ctx.repaint();
        ctx.emit('move', moved);
        return true;
      }
    }
    // An arrow reveals what lies in its direction: the content moves the other way.
    ctx.camera.panBy(0 - dx * VISUAL.keyPanPx, 0 - dy * VISUAL.keyPanPx);
    ctx.repaint();
    return true;
  }

  /**
   * Step the selection to the block lying most in a screen direction among the first selected
   * block's neighbors, or, with no block selected, to the block nearest the viewport center.
   */
  private step(prepared: Prepared, dx: number, dy: number): void {
    const focus = this.ctx.focus;
    const from = focus.selectedBlocks()[0];
    const next =
      from === undefined ? this.nearestToCenter(prepared) : this.stepAlong(prepared, from, dx, dy);
    if (next === NONE || !focus.select([partId(PART_BLOCK, next)])) return;
    this.ctx.repaint();
    this.emitSelection();
  }

  /** The visible block on a net of `from` whose center lies most in the direction, or `NONE`. */
  private stepAlong(prepared: Prepared, from: number, dx: number, dy: number): number {
    const scene = this.ctx.scene;
    const positions = scene.positions;
    const { size, portBlock, blockNetStart, blockNets } = prepared;
    const { netStart, netPorts } = prepared.netlist;
    const length = Math.hypot(dx, dy);
    if (length === 0) return NONE;
    const ux = dx / length;
    const uy = dy / length;
    // The camera neither rotates nor mirrors, so a diagram direction is the screen direction.
    const ox = positions[2 * from]! + size[2 * from]! / 2;
    const oy = positions[2 * from + 1]! + size[2 * from + 1]! / 2;
    let best = NONE;
    let bestCos = 0;
    for (let i = blockNetStart[from]!; i < blockNetStart[from + 1]!; i++) {
      const net = blockNets[i]!;
      for (let j = netStart[net]!; j < netStart[net + 1]!; j++) {
        const block = portBlock[netPorts[j]!]!;
        if (block === from || !scene.blockVisible(block)) continue;
        const vx = positions[2 * block]! + size[2 * block]! / 2 - ox;
        const vy = positions[2 * block + 1]! + size[2 * block + 1]! / 2 - oy;
        const distance = Math.hypot(vx, vy);
        const cos = distance > 0 ? (vx * ux + vy * uy) / distance : 0;
        if (cos > bestCos) {
          best = block;
          bestCos = cos;
        }
      }
    }
    return best;
  }

  /** The visible block whose center is nearest the viewport center, or `NONE`. */
  private nearestToCenter(prepared: Prepared): number {
    const scene = this.ctx.scene;
    const positions = scene.positions;
    const size = prepared.size;
    const { w, h } = this.ctx.viewport();
    const [cx, cy] = this.ctx.toDiagram(w / 2, h / 2);
    let best = NONE;
    let bestDistance = Infinity;
    for (let block = 0; block < prepared.blockCount; block++) {
      if (!scene.blockVisible(block)) continue;
      const vx = positions[2 * block]! + size[2 * block]! / 2 - cx;
      const vy = positions[2 * block + 1]! + size[2 * block + 1]! / 2 - cy;
      const distance = vx * vx + vy * vy;
      if (distance < bestDistance) {
        best = block;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Select the visible block after (or, with `back`, before) the first selected block in reading
   * order: effective top-left y, then x, then index. False past the end, so focus leaves.
   */
  private walk(prepared: Prepared, back: boolean): boolean {
    const scene = this.ctx.scene;
    const positions = scene.positions;
    const current = this.ctx.focus.selectedBlocks()[0];
    const hasCurrent = current !== undefined;
    const cx = hasCurrent ? positions[2 * current]! : 0;
    const cy = hasCurrent ? positions[2 * current + 1]! : 0;
    let best = NONE;
    let bx = 0;
    let by = 0;
    for (let block = 0; block < prepared.blockCount; block++) {
      if (!scene.blockVisible(block)) continue;
      const x = positions[2 * block]!;
      const y = positions[2 * block + 1]!;
      if (hasCurrent) {
        const after = before(cx, cy, current, x, y, block);
        if (back ? after || block === current : !after) continue;
      }
      const better =
        best === NONE ||
        (back ? before(bx, by, best, x, y, block) : before(x, y, block, bx, by, best));
      if (!better) continue;
      best = block;
      bx = x;
      by = y;
    }
    if (best === NONE) return false;
    if (this.ctx.focus.select([partId(PART_BLOCK, best)])) {
      this.ctx.repaint();
      this.emitSelection();
    }
    return true;
  }

  private emitSelection(): void {
    this.ctx.emit('select', this.ctx.focus.parts());
  }

  /** Clear hover as a drag or a navigation starts, telling the host when it was set. */
  private clearHover(): void {
    if (!this.ctx.focus.setHover(null)) return;
    this.ctx.repaint();
    this.ctx.emit('hover', null);
  }

  private stopAutoPan(): false {
    this.autoPanAt = Number.NaN;
    return false;
  }
}

/** Whether a mode moves the camera and drags: `edit` and `navigate`. */
function navigable(mode: Interaction): boolean {
  return mode === 'edit' || mode === 'navigate';
}

/**
 * The fixed end of a wire picked up at `port` on `net`: the driver, else the first other port;
 * `NONE` when the port is alone on its net.
 */
function fixedEnd(prepared: Prepared, net: number, port: number): number {
  const driver = prepared.netDriver[net]!;
  if (driver !== NONE && driver !== port) return driver;
  const { netStart, netPorts } = prepared.netlist;
  for (let i = netStart[net]!; i < netStart[net + 1]!; i++) {
    if (netPorts[i] !== port) return netPorts[i]!;
  }
  return NONE;
}

/** The next part of a tapped stack: after the one selected part when it is in it, else the top. */
function cycle(hits: readonly number[], selection: ReadonlySet<number>): number {
  if (selection.size === 1) {
    const index = hits.indexOf(firstOf(selection)!);
    if (index >= 0) return hits[(index + 1) % hits.length]!;
  }
  return hits[0]!;
}

function firstOf(ids: ReadonlySet<number>): number | undefined {
  for (const id of ids) return id;
  return undefined;
}

/** Whether block `a` at `(xa, ya)` comes before block `b` at `(xb, yb)`: y, then x, then index. */
function before(xa: number, ya: number, a: number, xb: number, yb: number, b: number): boolean {
  if (ya !== yb) return ya < yb;
  if (xa !== xb) return xa < xb;
  return a < b;
}

/**
 * Auto-pan content speed for a pointer coordinate along a canvas side of `size` CSS px: toward
 * the near edge, scaled by depth into its zone and clamped at the edge; 0 outside both zones.
 */
function edgeSpeed(s: number, size: number): number {
  const zone = VISUAL.autoPanZonePx;
  const near = Math.min(1, Math.max(0, (zone - s) / zone));
  const far = Math.min(1, Math.max(0, (s - (size - zone)) / zone));
  return (near - far) * VISUAL.autoPanSpeedPx;
}

/** A client point kept `contextInsetPx` inside a rectangle; its center when there is none. */
function clampInside(
  point: readonly [number, number] | null,
  rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>,
): readonly [number, number] {
  const [x, y] = point ?? [rect.left + rect.width / 2, rect.top + rect.height / 2];
  if (rect.width <= 0 || rect.height <= 0) return [x, y];
  const insetX = Math.min(VISUAL.contextInsetPx, rect.width / 2);
  const insetY = Math.min(VISUAL.contextInsetPx, rect.height / 2);
  return [
    Math.min(rect.left + rect.width - insetX, Math.max(rect.left + insetX, x)),
    Math.min(rect.top + rect.height - insetY, Math.max(rect.top + insetY, y)),
  ];
}
