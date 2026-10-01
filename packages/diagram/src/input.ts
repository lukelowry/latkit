import { createCanvasInput, inputModifiers, wheelDelta } from '@latkit/gpu';
import type { Diagram, ConnectProposal } from './diagram.js';
import { interaction } from './diagram.js';
import type { DiagramItem, DiagramHit, Point } from './data.js';
import { itemKey } from './data.js';
import { positive } from './config.js';
import { ConnectSession } from './connect.js';

export interface InputOptions {
  readonly diagram: Diagram;
  readonly canvas: HTMLCanvasElement;
  readonly interaction?: 'edit' | 'navigate' | 'inspect' | 'none';
  readonly wheel?: 'zoom' | 'modifier';
  readonly keyboard?: boolean;
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
interface Drag {
  id: number;
  start: Point;
  last: Point;
  world: Point;
  kind: 'press' | 'pan' | 'move' | 'marquee' | 'connect';
  moved: boolean;
  threshold: number;
  additive: boolean;
  hit?: DiagramHit;
  selection: readonly DiagramItem[];
  revision: number;
  session?: ConnectSession;
  target: DiagramItem | null;
  blocked: boolean;
}
/** DOM ownership stays separate from rendering and application-owned mutations. */
export function attachDiagramInput(options: InputOptions): () => void {
  const { diagram, canvas } = options,
    mode = options.interaction ?? 'navigate';
  const threshold = positive(options.dragThresholdPx ?? 4, 'dragThresholdPx', true);
  const touchThreshold = positive(options.touchDragThresholdPx ?? 8, 'touchDragThresholdPx', true);
  const targetRadius = positive(options.connectRadiusPx ?? 18, 'connectRadiusPx');
  const margin = positive(options.autoPanMarginPx ?? 32, 'autoPanMarginPx');
  const speed = positive(options.autoPanSpeedPx ?? 480, 'autoPanSpeedPx', true);
  if (mode === 'none') return () => {};
  const api = interaction(diagram),
    view = canvas.ownerDocument.defaultView!;
  const input = createCanvasInput({
    canvas,
    keyboard: options.keyboard,
    touchAction: mode === 'inspect' ? 'pan-x pan-y' : 'none',
  });
  const { signal } = input;
  const originalCursor = canvas.style.cursor;
  let drag: Drag | undefined,
    space = false,
    closed = false;
  let longPress: ReturnType<typeof setTimeout> | undefined,
    raf = 0,
    lastPan = 0;
  const pointers = new Map<number, Point>();
  let pinch: { distance: number; center: Point } | undefined;
  const setSelection = (items: readonly DiagramItem[]) => {
    const before = api.selection();
    if (
      before.length === items.length &&
      before.every((item, i) => itemKey(item) === itemKey(items[i]))
    )
      return;
    diagram.select(items);
    api.emit('select', items);
  };
  const merge = (a: readonly DiagramItem[], b: readonly DiagramItem[]) => [
    ...new Map([...a, ...b].map((item) => [itemKey(item), item])).values(),
  ];
  const toggle = (hit: DiagramItem, add: boolean) => {
    if (!add) return [hit];
    const existing = api.selection(),
      key = itemKey(hit);
    return existing.some((item) => itemKey(item) === key)
      ? existing.filter((item) => itemKey(item) !== key)
      : [...existing, hit];
  };
  const cancel = () => {
    if (longPress) clearTimeout(longPress);
    longPress = undefined;
    if (raf) view.cancelAnimationFrame(raf);
    raf = 0;
    lastPan = 0;
    const current = drag;
    drag = undefined;
    if (current?.kind === 'move' && current.moved) api.preview([], null);
    api.overlay(null);
    canvas.style.cursor = originalCursor;
    if (current) input.release(current.id);
  };
  const context = (
    point: Point,
    event: MouseEvent | KeyboardEvent,
    trigger: 'pointer' | 'keyboard',
  ) =>
    api.emit('contextmenu', {
      point,
      items: diagram.hitTest(point),
      trigger,
      modifiers: inputModifiers(event),
    });
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
      const hits = diagram.hitTest(current.last, {
        radiusPx: Math.max(targetRadius, current.threshold * 2),
      });
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
      diagram.panBy(dx * dt, dy * dt);
      follow();
    }
    raf = view.requestAnimationFrame(panAtEdge);
  };
  canvas.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 && event.button !== 1) return;
      const p = input.point(event);
      pointers.set(event.pointerId, p);
      if (mode !== 'inspect') input.capture(event.pointerId);
      canvas.focus({ preventScroll: true });
      if (pointers.size === 2 && mode !== 'inspect') {
        cancel();
        const [a, b] = [...pointers.values()];
        pinch = {
          distance: Math.hypot(b[0] - a[0], b[1] - a[1]),
          center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
        };
        return;
      }
      const world = api.world(p);
      if (!world || drag) return;
      const touch = event.pointerType === 'touch';
      const hit = diagram.hitTest(p, { radiusPx: touch ? 22 : api.options().pickRadiusPx })[0];
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const kind =
        mode === 'inspect'
          ? 'press'
          : space || event.button === 1
            ? 'pan'
            : mode === 'edit' && (hit?.kind === 'port' || (event.altKey && hit?.kind === 'vertex'))
              ? 'connect'
              : mode === 'edit' && (hit?.kind === 'vertex' || hit?.kind === 'group')
                ? 'move'
                : !touch &&
                    (event.shiftKey ||
                      (mode === 'edit' && (options.backgroundDrag ?? 'select') === 'select'))
                  ? 'marquee'
                  : 'pan';
      drag = {
        id: event.pointerId,
        start: p,
        last: p,
        world,
        kind,
        moved: false,
        threshold: touch ? touchThreshold : threshold,
        additive,
        hit,
        selection: api.selection(),
        revision: api.revision(),
        target: null,
        blocked: false,
      };
      if (touch)
        longPress = setTimeout(() => {
          context(p, event, 'pointer');
          cancel();
        }, 550);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointermove',
    (event) => {
      const p = input.point(event);
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, p);
      diagram.setPointer(p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()],
          center: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (distance > 0 && pinch.distance > 0) diagram.zoomBy(distance / pinch.distance, center);
        diagram.panBy(center[0] - pinch.center[0], center[1] - pinch.center[1]);
        pinch = { distance, center };
        return;
      }
      const current = drag;
      if (!current || current.id !== event.pointerId) return;
      if (
        !current.moved &&
        Math.hypot(p[0] - current.start[0], p[1] - current.start[1]) > current.threshold
      ) {
        current.moved = true;
        if (longPress) clearTimeout(longPress);
        longPress = undefined;
        const camera = diagram.getCamera();
        if (camera && current.kind !== 'press') diagram.setCamera(camera);
        if (current.kind === 'move' && current.hit) {
          if (!current.selection.some((item) => itemKey(item) === itemKey(current.hit!)))
            current.selection = current.additive
              ? merge(current.selection, [current.hit])
              : [current.hit];
          setSelection(current.selection);
        }
        if (
          current.kind === 'connect' &&
          current.hit &&
          current.hit.kind !== 'group' &&
          api.scene()
        )
          current.session = new ConnectSession(
            api.scene()!,
            current.hit,
            api.options().routeClearance,
          );
        canvas.style.cursor =
          current.kind === 'pan' || current.kind === 'move' ? 'grabbing' : 'crosshair';
      }
      if (!current.moved) return;
      if (current.kind === 'pan') diagram.panBy(p[0] - current.last[0], p[1] - current.last[1]);
      current.last = p;
      follow();
      if (!raf) raf = view.requestAnimationFrame(panAtEdge);
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerup',
    (event) => {
      const p = input.point(event);
      pointers.delete(event.pointerId);
      if (pinch) {
        input.release(event.pointerId);
        if (pointers.size < 2) pinch = undefined;
        cancel();
        return;
      }
      const current = drag;
      if (!current || current.id !== event.pointerId) {
        input.release(event.pointerId);
        return;
      }
      current.last = p;
      follow();
      const world = api.world(p);
      cancel();
      if (!current.moved) {
        const hit = diagram.hitTest(p, {
          radiusPx: event.pointerType === 'touch' ? 22 : api.options().pickRadiusPx,
        })[0];
        if (hit) setSelection(toggle(hit, current.additive));
        else if (!current.additive) setSelection([]);
      } else if (
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
        setSelection(current.additive ? merge(current.selection, items) : items);
      }
    },
    { signal },
  );
  canvas.addEventListener(
    'pointercancel',
    (event) => {
      pointers.delete(event.pointerId);
      pinch = undefined;
      cancel();
    },
    { signal },
  );
  canvas.addEventListener(
    'lostpointercapture',
    (event) => {
      if (drag?.id === event.pointerId) cancel();
    },
    { signal },
  );
  canvas.addEventListener(
    'pointerleave',
    () => {
      if (!drag) diagram.setPointer(null);
    },
    { signal },
  );
  canvas.addEventListener(
    'dblclick',
    (event) => {
      const hit = diagram.hitTest(input.point(event))[0];
      if (hit) api.emit('open', hit);
      else if (mode !== 'inspect') diagram.fit({ animate: true });
    },
    { signal },
  );
  canvas.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
      context(input.point(event), event, 'pointer');
    },
    { signal },
  );
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (mode === 'inspect' || (options.wheel === 'modifier' && !event.ctrlKey && !event.metaKey))
        return;
      event.preventDefault();
      diagram.zoomBy(
        Math.exp(
          -Math.max(-500, Math.min(500, wheelDelta(event, { height: canvas.clientHeight }))) *
            0.002,
        ),
        input.point(event),
      );
    },
    { signal, passive: false },
  );

  if (options.keyboard !== false) {
    canvas.addEventListener(
      'keydown',
      (event) => {
        if (event.target !== canvas) return;
        const items = api.selection(),
          key = event.key;
        if (key === ' ') {
          space = true;
          event.preventDefault();
          return;
        }
        if (key === 'Escape') {
          cancel();
          setSelection([]);
        } else if (key === 'Home') diagram.fit({ animate: true });
        else if (key === '+' || key === '=') diagram.zoomBy(1.2);
        else if (key === '-') diagram.zoomBy(1 / 1.2);
        else if (key === 'Enter' && items[0]) api.emit('open', items[0]);
        else if ((key === 'Delete' || key === 'Backspace') && mode === 'edit')
          api.emit('delete', [
            ...new Set(
              items.filter((i) => i.kind === 'vertex' || i.kind === 'edge').map((i) => i.id),
            ),
          ]);
        else if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey))
          context(items[0] ? (diagram.locate(items[0]) ?? [0, 0]) : [0, 0], event, 'keyboard');
        else if (key === 'Tab') {
          const vertices = api.scene()?.vertices.filter((n) => n.visible) ?? [],
            at = vertices.findIndex((n) => items[0] && itemKey(n.hit) === itemKey(items[0])),
            next =
              vertices[
                at < 0 ? (event.shiftKey ? vertices.length - 1 : 0) : at + (event.shiftKey ? -1 : 1)
              ];
          if (next) {
            setSelection([next.hit]);
            diagram.reveal(next.hit);
          } else return;
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
          const step = api.options().gridPitch * (event.shiftKey ? 4 : 1),
            dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
            dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
          if (mode === 'edit' && items.some((i) => i.kind === 'vertex' || i.kind === 'group')) {
            const proposal = api.move(items, [dx, dy]);
            if (proposal) api.emit('move', proposal);
          } else if (mode !== 'inspect') diagram.panBy(-dx * 4, -dy * 4);
        } else return;
        event.preventDefault();
      },
      { signal },
    );
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
  const media = canvas.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => api.reduced(media?.matches ?? false);
  motion();
  media?.addEventListener('change', motion, { signal });
  const off = diagram.on('invalidate', () => {
    if (drag && api.revision() !== drag.revision) cancel();
  });
  return () => {
    if (closed) return;
    closed = true;
    off();
    cancel();
    diagram.setPointer(null);
    input.destroy();
  };
}
