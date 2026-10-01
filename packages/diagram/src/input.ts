import { createCanvasInput, inputModifiers, wheelDelta } from '@latkit/gpu';
import type { Diagram, ConnectionGesture } from './diagram.js';
import { interaction } from './diagram.js';
import type { DiagramItem, DiagramHit, Point } from './data.js';
import { itemKey } from './data.js';
export interface InputOptions {
  readonly diagram: Diagram;
  readonly canvas: HTMLCanvasElement;
  readonly interaction?: 'edit' | 'navigate' | 'inspect' | 'none';
  readonly wheel?: 'zoom' | 'modifier';
  readonly keyboard?: boolean;
}
interface Drag {
  id: number;
  start: Point;
  last: Point;
  world: Point;
  kind: 'press' | 'pan' | 'move' | 'marquee' | 'connect';
  moved: boolean;
  hit?: DiagramHit;
  selection: readonly DiagramItem[];
  revision: number;
  wire?: Pick<ConnectionGesture, 'from' | 'replaces'>;
}
/** Owns DOM listeners and capture only. Model changes remain application proposals. */
export function attachDiagramInput(options: InputOptions): () => void {
  const { diagram, canvas } = options,
    mode = options.interaction ?? 'navigate';
  if (mode === 'none') return () => {};
  const api = interaction(diagram),
    input = createCanvasInput({
      canvas,
      keyboard: options.keyboard,
      touchAction: mode === 'inspect' ? 'pan-x pan-y' : 'none',
    });
  const { signal } = input;
  let drag: Drag | undefined,
    space = false,
    closed = false,
    longPress: ReturnType<typeof setTimeout> | undefined;
  const pointers = new Map<number, Point>();
  let pinch: { distance: number; center: Point } | undefined;
  const setSelection = (items: readonly DiagramItem[]) => {
    diagram.select(items);
    api.emit('select', items);
  };
  const cancel = () => {
    if (longPress) clearTimeout(longPress);
    longPress = undefined;
    const id = drag?.id;
    drag = undefined;
    api.preview([], null);
    api.overlay(null);
    if (id !== undefined) input.release(id);
  };
  const toggle = (hit: DiagramItem, add: boolean) => {
    if (!add) return [hit];
    const existing = api.selection(),
      key = itemKey(hit);
    return existing.some((i) => itemKey(i) === key)
      ? existing.filter((i) => itemKey(i) !== key)
      : [...existing, hit];
  };
  const context = (
    point: Point,
    event: MouseEvent | KeyboardEvent,
    trigger: 'pointer' | 'keyboard',
  ) => {
    api.emit('contextmenu', {
      point,
      items: diagram.hitTest(point),
      trigger,
      modifiers: inputModifiers(event),
    });
  };
  const connection = (
    hit: DiagramHit,
  ): Pick<ConnectionGesture, 'from' | 'replaces'> | undefined => {
    if (hit.kind !== 'port' && hit.kind !== 'component') return;
    const from = { type: hit.type, id: hit.id, ...(hit.kind === 'port' ? { port: hit.port } : {}) };
    if (hit.kind === 'port') {
      const scene = api.scene(),
        node = scene?.nodes.findIndex((n) => n.hit.id === hit.id && n.hit.type === hit.type);
      const port =
        node !== undefined && node >= 0
          ? scene!.nodes[node].ports.find((p) => p.name === hit.port)
          : undefined;
      if (port?.definition.direction === 'in') {
        for (const edge of scene?.edges ?? []) {
          const end = edge.endpoints.find((e) => e.node === node && e.port === hit.port);
          const other = edge.endpoints.find((e) => e !== end);
          if (end && other) {
            const n = scene!.nodes[other.node];
            return {
              from: { type: n.hit.type, id: n.hit.id, ...(other.port ? { port: other.port } : {}) },
              replaces: {
                connection: { type: edge.hit.type, id: edge.hit.id },
                endpoint: { ordinal: end.ordinal, index: edge.hit.index, role: end.role },
              },
            };
          }
        }
      }
    }
    return { from };
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
      if (!world) return;
      const hit = diagram.hitTest(p, {
        radiusPx: event.pointerType === 'touch' ? 22 : api.options().pickRadiusPx,
      })[0];
      const kind =
        mode === 'inspect'
          ? 'press'
          : space || event.button === 1
            ? 'pan'
            : mode === 'edit' &&
                (hit?.kind === 'port' || (event.altKey && hit?.kind === 'component'))
              ? 'connect'
              : mode === 'edit' && (hit?.kind === 'component' || hit?.kind === 'group')
                ? 'move'
                : event.shiftKey
                  ? 'marquee'
                  : 'press';
      if (kind === 'move' || kind === 'connect' || kind === 'marquee') {
        const camera = diagram.getCamera();
        if (camera) diagram.setCamera(camera);
      }
      let selection = api.selection();
      if (kind === 'move' && hit && !selection.some((i) => itemKey(i) === itemKey(hit))) {
        selection = toggle(hit, event.shiftKey);
        setSelection(selection);
      }
      drag = {
        id: event.pointerId,
        start: p,
        last: p,
        world,
        kind,
        moved: false,
        hit,
        selection,
        revision: api.revision(),
        wire: kind === 'connect' && hit ? connection(hit) : undefined,
      };
      if (event.pointerType === 'touch')
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
          center: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
          d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (d > 0 && pinch.distance > 0) diagram.zoomBy(d / pinch.distance, center);
        diagram.panBy(center[0] - pinch.center[0], center[1] - pinch.center[1]);
        pinch = { distance: d, center };
        return;
      }
      if (!drag || drag.id !== event.pointerId) return;
      if (Math.hypot(p[0] - drag.start[0], p[1] - drag.start[1]) > 3) {
        drag.moved = true;
        if (longPress) clearTimeout(longPress);
        longPress = undefined;
      }
      if (!drag.moved && drag.kind !== 'connect') return;
      if (drag.kind === 'press' && mode !== 'inspect') drag.kind = 'pan';
      if (drag.kind === 'pan') diagram.panBy(p[0] - drag.last[0], p[1] - drag.last[1]);
      const world = api.world(p);
      if (world) {
        const g = api.options().gridPitch,
          snap = (n: number) => (api.options().snap ? Math.round(n / g) * g : n);
        if (drag.kind === 'move')
          api.preview(drag.selection, [
            snap(world[0] - drag.world[0]),
            snap(world[1] - drag.world[1]),
          ]);
        if (drag.kind === 'marquee')
          api.overlay({
            box: [
              Math.min(drag.world[0], world[0]),
              Math.min(drag.world[1], world[1]),
              Math.max(drag.world[0], world[0]),
              Math.max(drag.world[1], world[1]),
            ],
          });
        if (drag.kind === 'connect')
          api.overlay({ wire: [drag.world, [world[0], drag.world[1]], world] });
      }
      drag.last = p;
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
      const world = api.world(p),
        g = api.options().gridPitch,
        snap = (n: number) => (api.options().snap ? Math.round(n / g) * g : n);
      cancel();
      if (current.kind === 'connect' && current.wire && world) {
        const hits = diagram.hitTest(p),
          hit = hits.find(
            (h) => h.kind === 'port' || h.kind === 'component' || h.kind === 'connection',
          );
        if (
          hit &&
          hit.kind !== 'group' &&
          hit.type === current.wire.from.type &&
          hit.id === current.wire.from.id &&
          (hit.kind === 'port' ? hit.port : undefined) === current.wire.from.port
        )
          return;
        const to =
          hit && hit.kind !== 'group'
            ? {
                kind: hit.kind === 'connection' ? ('connection' as const) : ('component' as const),
                type: hit.type,
                id: hit.id,
                ...(hit.kind === 'port' ? { port: hit.port } : {}),
              }
            : null;
        if (to?.port && current.wire.from.port) {
          const scene = api.scene(),
            a = scene?.nodes
              .find(
                (n) => n.hit.type === current.wire!.from.type && n.hit.id === current.wire!.from.id,
              )
              ?.ports.find((p) => p.name === current.wire!.from.port),
            b = scene?.nodes
              .find((n) => n.hit.type === to.type && n.hit.id === to.id)
              ?.ports.find((p) => p.name === to.port);
          if (
            a &&
            b &&
            ((a.definition.type && b.definition.type && a.definition.type !== b.definition.type) ||
              (a.definition.direction === b.definition.direction &&
                a.definition.direction !== 'both'))
          )
            return;
        }
        api.emit('connect', {
          ...current.wire,
          to,
          position: [snap(world[0]), snap(world[1])],
          point: p,
        });
      } else if (current.kind === 'move' && current.moved && world) {
        const delta: Point = [snap(world[0] - current.world[0]), snap(world[1] - current.world[1])];
        if (delta[0] || delta[1]) {
          const proposal = api.move(current.selection, delta);
          if (proposal) api.emit('move', proposal);
        }
      } else if (current.kind === 'marquee' && world)
        setSelection(api.marquee(current.world, world));
      else if (!current.moved) {
        const hit = diagram.hitTest(p)[0];
        setSelection(hit ? toggle(hit, event.shiftKey) : []);
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
              items
                .filter((i) => i.kind === 'component' || i.kind === 'connection')
                .map((i) => i.id),
            ),
          ]);
        else if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey))
          context(items[0] ? (diagram.locate(items[0]) ?? [0, 0]) : [0, 0], event, 'keyboard');
        else if (key === 'Tab') {
          const nodes = api.scene()?.nodes.filter((n) => n.visible) ?? [],
            at = nodes.findIndex((n) => items[0] && itemKey(n.hit) === itemKey(items[0])),
            next =
              nodes[
                at < 0
                  ? event.shiftKey
                    ? nodes.length - 1
                    : 0
                  : (at + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length
              ];
          if (next) {
            setSelection([next.hit]);
            diagram.reveal(next.hit);
          }
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
          const step = api.options().gridPitch * (event.shiftKey ? 10 : 1),
            dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0,
            dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
          if (mode === 'edit' && items.some((i) => i.kind === 'component' || i.kind === 'group')) {
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
