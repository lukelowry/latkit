import { kit, type Modifiers, type ViewInput } from '@latkit/gpu';
import type { ConnectProposal, DiagramEvents, MoveProposal } from './diagram.js';
import type { DiagramItem, DiagramRow, Point } from './data.js';
import { itemKey } from './data.js';
import type { Style } from './config.js';
import { ConnectSession } from './connect.js';
import type { Scene } from './scene.js';
import type { Overlay } from './painter.js';

export interface DiagramInput extends ViewInput {
  /** Primary mouse drag on empty canvas. Touch continues to pan. Default: select in edit mode. */
  readonly backgroundDrag?: 'pan' | 'select';
  readonly dragThresholdPx?: number;
  readonly touchDragThresholdPx?: number;
  readonly connectRadiusPx?: number;
  readonly autoPan?: boolean;
  readonly autoPanMarginPx?: number;
  readonly autoPanSpeedPx?: number;
  /** Additional application policy, after native port type/direction checks. Must be synchronous. */
  readonly canConnect?: (proposal: ConnectProposal) => boolean;
}
type Mode = NonNullable<ViewInput['mode']>;
/** What a diagram's own gestures drive; the view implements it. */
export interface Controls {
  emit<K extends 'connect' | 'move' | 'delete'>(event: K, value: DiagramEvents[K]): void;
  selection(): readonly DiagramItem[];
  /** Select as the user did, reporting a change. */
  choose(items: readonly DiagramItem[]): void;
  /** Select what a click hits, as every item view does. */
  click(point: Point, modifiers: Modifiers, touch: boolean): void;
  revision(): number;
  scene(): Scene | undefined;
  options(): Style;
  world(point: Point): Point | null;
  marquee(a: Point, b: Point): readonly DiagramItem[];
  preview(items: readonly DiagramItem[], delta: Point | null): void;
  move(items: readonly DiagramItem[], delta: Point): MoveProposal | undefined;
  overlay(value: Overlay | null): void;
  /** Hits near a canvas point, nearest first. */
  hits(point: Point, radiusPx?: number): readonly DiagramItem[];
  pan(dx: number, dy: number): void;
  /** Stop fitting: the camera stays where it is shown. */
  stay(): void;
  reveal(item: DiagramItem): void;
  invalidated(listener: () => void): () => void;
}
/** A diagram's gestures on one canvas: the view forwards presses, keys, and Escape to them. */
export interface Gestures {
  /** Take a press that moves, wires, or marquee-selects; the view clicks, pans, and pinches the rest. */
  grab(event: PointerEvent, point: Point): kit.Grab | undefined;
  /** Handle a key before the shared ones; true when handled. */
  key(event: KeyboardEvent): boolean;
  /** End a gesture in progress; true when one ended. */
  cancel(): boolean;
  detach(): void;
}
interface Drag {
  id: number;
  start: Point;
  last: Point;
  world: Point;
  kind: 'move' | 'marquee' | 'connect';
  moved: boolean;
  threshold: number;
  additive: boolean;
  /** How the press began, for the click it makes if it never moves. */
  modifiers: Modifiers;
  touch: boolean;
  hit?: DiagramItem;
  selection: readonly DiagramItem[];
  revision: number;
  session?: ConnectSession;
  target: DiagramItem | null;
  blocked: boolean;
}
/**
 * Drag moves, wires, or marquee-selects. Clicks, pans, pinches, hover, wheel, double clicks, context
 * menus, and the shared keys belong to the view.
 */
export function listen(
  canvas: HTMLCanvasElement,
  input: kit.CanvasInput,
  mode: Mode,
  options: DiagramInput,
  api: Controls,
): Gestures {
  const threshold = options.dragThresholdPx ?? 4,
    touchThreshold = options.touchDragThresholdPx ?? 8,
    targetRadius = options.connectRadiusPx ?? 18,
    margin = options.autoPanMarginPx ?? 32,
    speed = options.autoPanSpeedPx ?? 480;
  const view = canvas.ownerDocument.defaultView!;
  const { signal } = input;
  const originalCursor = canvas.style.cursor;
  let drag: Drag | undefined,
    space = false,
    closed = false;
  let raf = 0,
    lastPan = 0;
  const merge = (a: readonly DiagramItem[], b: readonly DiagramItem[]) => [
    ...new Map([...a, ...b].map((item) => [itemKey(item), item])).values(),
  ];
  /** End any gesture; true when one was in progress. */
  const cancel = () => {
    if (raf) view.cancelAnimationFrame(raf);
    raf = 0;
    lastPan = 0;
    const current = drag;
    drag = undefined;
    if (current?.kind === 'move' && current.moved) api.preview([], null);
    api.overlay(null);
    canvas.style.cursor = originalCursor;
    if (current) input.release(current.id);
    return !!current;
  };
  const snapped = (point: Point): Point => {
    const { snap, gridPitch } = api.options();
    return snap
      ? [Math.round(point[0] / gridPitch) * gridPitch, Math.round(point[1] / gridPitch) * gridPitch]
      : point;
  };
  const follow = () => {
    const current = drag,
      world = current && api.world(current.last);
    if (!current?.moved || !world) return;
    if (current.kind === 'move') {
      api.preview(
        current.selection,
        snapped([world[0] - current.world[0], world[1] - current.world[1]]),
      );
    } else if (current.kind === 'marquee') {
      api.overlay({
        box: [
          Math.min(current.world[0], world[0]),
          Math.min(current.world[1], world[1]),
          Math.max(current.world[0], world[0]),
          Math.max(current.world[1], world[1]),
        ],
      });
    } else if (current.kind === 'connect' && current.session) {
      const session = current.session;
      const hits = api.hits(current.last, Math.max(targetRadius, current.threshold * 2));
      const ports = hits.filter((hit) => hit.kind === 'port');
      const candidates = ports.length ? ports : hits;
      const target =
        candidates.find(
          (hit) =>
            session.accepts(hit) &&
            (options.canConnect?.(session.proposal(hit, snapped(world), current.last)) ?? true),
        ) ?? null;
      current.target = target;
      current.blocked = !target && hits.some((hit) => hit.kind !== 'group');
      canvas.style.cursor = current.blocked ? 'not-allowed' : 'crosshair';
      api.overlay({
        wire: session.preview(snapped(world), target, signal),
        compatible: session.compatible,
        target,
        muted: session.detached,
        invalid: current.blocked,
      });
    }
  };
  const velocity = (p: number, size: number) => {
    const zone = Math.min(margin, size / 3);
    if (p < zone) return speed * Math.min(1, (zone - p) / zone);
    if (p > size - zone) return -speed * Math.min(1, (p - size + zone) / zone);
    return 0;
  };
  const panAtEdge = (now: number) => {
    raf = 0;
    const current = drag;
    if (
      !current?.moved ||
      !['move', 'marquee', 'connect'].includes(current.kind) ||
      options.autoPan === false
    )
      return;
    const dx = velocity(current.last[0], canvas.clientWidth),
      dy = velocity(current.last[1], canvas.clientHeight);
    if (!dx && !dy) {
      lastPan = 0;
      return;
    }
    const dt = lastPan ? Math.min(32, Math.max(0, now - lastPan)) / 1000 : 0;
    lastPan = now;
    if (dt) {
      api.pan(dx * dt, dy * dt);
      follow();
    }
    raf = view.requestAnimationFrame(panAtEdge);
  };
  /** A press the diagram drags itself: on a port to wire, on a block to move, or to marquee-select. */
  const grab = (event: PointerEvent, p: Point): kit.Grab | undefined => {
    if (mode === 'inspect' || event.button !== 0 || space || drag) return undefined;
    const world = api.world(p);
    if (!world) return undefined;
    const touch = event.pointerType === 'touch';
    const hit = api.hits(p, touch ? 22 : undefined)[0];
    const kind: Drag['kind'] | undefined =
      mode === 'edit' && (hit?.kind === 'port' || (event.altKey && hit?.kind === 'vertex'))
        ? 'connect'
        : mode === 'edit' && (hit?.kind === 'vertex' || hit?.kind === 'group')
          ? 'move'
          : !touch &&
              (event.shiftKey ||
                (mode === 'edit' && (options.backgroundDrag ?? 'select') === 'select'))
            ? 'marquee'
            : undefined;
    if (!kind) return undefined;
    const current: Drag = {
      id: event.pointerId,
      start: p,
      last: p,
      world,
      kind,
      moved: false,
      threshold: touch ? touchThreshold : threshold,
      additive: event.shiftKey || event.ctrlKey || event.metaKey,
      modifiers: kit.inputModifiers(event),
      touch,
      hit,
      selection: api.selection(),
      revision: api.revision(),
      target: null,
      blocked: false,
    };
    drag = current;
    return {
      move: (p) => {
        if (drag !== current) return;
        if (
          !current.moved &&
          Math.hypot(p[0] - current.start[0], p[1] - current.start[1]) > current.threshold
        ) {
          current.moved = true;
          api.stay();
          if (current.kind === 'move' && current.hit) {
            if (!current.selection.some((item) => itemKey(item) === itemKey(current.hit!)))
              current.selection = current.additive
                ? merge(current.selection, [current.hit])
                : [current.hit];
            api.choose(current.selection);
          }
          if (
            current.kind === 'connect' &&
            current.hit &&
            current.hit.kind !== 'group' &&
            api.scene()
          )
            current.session = new ConnectSession(api.scene()!, current.hit, api.options());
          canvas.style.cursor = current.kind === 'move' ? 'grabbing' : 'crosshair';
        }
        if (!current.moved) return;
        current.last = p;
        follow();
        if (!raf) raf = view.requestAnimationFrame(panAtEdge);
      },
      end: (p) => {
        if (drag !== current) return;
        if (!p) {
          cancel();
          return;
        }
        current.last = p;
        follow();
        const world = api.world(p);
        cancel();
        if (!current.moved) api.click(p, current.modifiers, current.touch);
        else if (
          current.kind === 'connect' &&
          current.session &&
          world &&
          !current.blocked &&
          p[0] >= 0 &&
          p[1] >= 0 &&
          p[0] <= canvas.clientWidth &&
          p[1] <= canvas.clientHeight
        ) {
          const proposal = current.session.proposal(current.target, snapped(world), p);
          if (options.canConnect?.(proposal) ?? true) api.emit('connect', proposal);
        } else if (current.kind === 'move' && world) {
          const delta = snapped([world[0] - current.world[0], world[1] - current.world[1]]);
          if (delta[0] || delta[1]) {
            const proposal = api.move(current.selection, delta);
            if (proposal) api.emit('move', proposal);
          }
        } else if (current.kind === 'marquee' && world) {
          const items = api.marquee(current.world, world);
          api.choose(current.additive ? merge(current.selection, items) : items);
        }
      },
    };
  };
  if (options.keyboard !== false) {
    canvas.addEventListener(
      'keyup',
      (event) => {
        if (event.key === ' ') space = false;
      },
      { signal },
    );
    canvas.addEventListener(
      'blur',
      () => {
        space = false;
        cancel();
      },
      { signal },
    );
  }
  const off = api.invalidated(() => {
    if (drag && api.revision() !== drag.revision) cancel();
  });
  /** Space pans; Delete proposes removal; Tab visits; arrows nudge or pan. */
  const key = (event: KeyboardEvent): boolean => {
    const items = api.selection(),
      key = event.key;
    if (key === ' ') space = true;
    else if ((key === 'Delete' || key === 'Backspace') && mode === 'edit')
      api.emit(
        'delete',
        items.filter((item): item is DiagramRow => item.kind === 'vertex' || item.kind === 'edge'),
      );
    else if (key === 'Tab') {
      const vertices = api.scene()?.vertices.filter((n) => n.visible) ?? [],
        at = vertices.findIndex((n) => items[0] && itemKey(n.hit) === itemKey(items[0])),
        next =
          vertices[
            at < 0 ? (event.shiftKey ? vertices.length - 1 : 0) : at + (event.shiftKey ? -1 : 1)
          ];
      if (!next) return false;
      api.choose([next.hit]);
      api.reveal(next.hit);
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
      const step = api.options().gridPitch * (event.shiftKey ? 4 : 1),
        dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
        dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      if (mode === 'edit' && items.some((i) => i.kind === 'vertex' || i.kind === 'group')) {
        const proposal = api.move(items, [dx, dy]);
        if (proposal) api.emit('move', proposal);
      } else if (mode !== 'inspect') api.pan(-dx * 4, -dy * 4);
      else return false;
    } else return false;
    return true;
  };
  return {
    grab,
    key,
    cancel,
    detach() {
      if (closed) return;
      closed = true;
      off();
      cancel();
    },
  };
}
