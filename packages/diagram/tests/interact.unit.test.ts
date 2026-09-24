import { describe, expect, it } from 'vitest';

import { Interactor } from '../src/interact.js';
import { NONE } from '../src/prepare.js';
import {
  block,
  group,
  harness,
  HEIGHT,
  LEFT,
  net,
  port,
  TOP,
  WIDTH,
  type PressOptions,
} from './fixtures/interact-harness.js';
import { build, plant, twoArea } from './fixtures/netlists.js';

type Point = readonly [number, number];

/** GENROU, TGOV1, IEEET1 top-lefts: GENROU (400, 100), TGOV1 (96, 48), IEEET1 (96, 200). */
const TWO_AREA = [400, 100, 96, 48, 96, 200];

/**
 * Wiring cases. Ports: SRC 0 y (out), 1 z (out, unwired); DST 2 a (in, left), 3 b (in, right);
 * TAP 4 u, 5 v (unwired), 6 w (in, alone on net 2). Nets: 0 [0, 2] driven, 1 [3, 4] undriven,
 * 2 [6].
 */
function bench() {
  return build({
    blocks: [
      {
        key: 'src',
        title: 'SRC',
        ports: [
          { name: 'y', flow: 'out' },
          { name: 'z', flow: 'out' },
        ],
      },
      {
        key: 'dst',
        title: 'DST',
        ports: [
          { name: 'a', flow: 'in' },
          { name: 'b', flow: 'in', side: 1 },
        ],
      },
      {
        key: 'tap',
        title: 'TAP',
        ports: [
          { name: 'u', flow: 'in' },
          { name: 'v', flow: 'in' },
          { name: 'w', flow: 'in' },
        ],
      },
    ],
    nets: [
      {
        label: 'y',
        ports: [
          [0, 'y'],
          [1, 'a'],
        ],
      },
      {
        label: 'loop',
        ports: [
          [1, 'b'],
          [2, 'u'],
        ],
      },
      { label: 'solo', ports: [[2, 'w']] },
    ],
  });
}
const BENCH = [96, 96, 400, 64, 400, 240];

/** An interactor over a harness, with gesture helpers in canvas-local points. */
function setup(netlist = twoArea() as ReturnType<typeof twoArea> | null, placed = TWO_AREA) {
  const h = harness(netlist, placed);
  const interactor = new Interactor(h.ctx);
  let last: Point = [0, 0];
  const press = (at: Point, o: PressOptions = {}): void =>
    interactor.gesture({
      kind: 'press',
      sx: at[0],
      sy: at[1],
      button: o.button ?? 0,
      pointerType: o.pointerType ?? 'mouse',
      shift: o.shift ?? false,
      mod: o.mod ?? false,
      targetPx: o.targetPx ?? 8,
    });
  const moveTo = (to: Point): void => {
    interactor.gesture({
      kind: 'dragMove',
      sx: to[0],
      sy: to[1],
      dx: to[0] - last[0],
      dy: to[1] - last[1],
      time: 0,
    });
    last = to;
  };
  const drag = (from: Point, to: Point, o: PressOptions = {}): void => {
    press(from, o);
    interactor.gesture({ kind: 'dragStart', sx: from[0], sy: from[1], time: 0 });
    last = from;
    moveTo(to);
  };
  const release = (at: Point = last, cancelled = false): void =>
    interactor.gesture({
      kind: 'dragEnd',
      sx: at[0],
      sy: at[1],
      clientX: LEFT + at[0],
      clientY: TOP + at[1],
      cancelled,
    });
  const tap = (at: Point, o: { shift?: boolean; mod?: boolean } = {}): void => {
    press(at, o);
    interactor.gesture({
      kind: 'tap',
      sx: at[0],
      sy: at[1],
      targetPx: 8,
      shift: o.shift ?? false,
      mod: o.mod ?? false,
    });
  };
  const doubleTap = (at: Point): void =>
    interactor.gesture({ kind: 'doubleTap', sx: at[0], sy: at[1], targetPx: 8 });
  const offset = (at: Point, dx: number, dy: number): Point => [at[0] + dx, at[1] + dy];
  return { ...h, interactor, press, drag, moveTo, release, tap, doubleTap, offset };
}

describe('Interactor wires', () => {
  it('draws a new wire: glow, target highlight, preview, and a connect proposal', () => {
    const t = setup(bench(), BENCH);
    const compatible = [port(3), port(4), port(5), port(6), net(1), net(2)];
    const [vx, vy] = t.portAt(5);
    t.drag(t.portAt(1), [vx + 3, vy + 2]);

    expect(t.interactor.active).toBe(true);
    expect(t.interactor.dragging).toBe(true);
    expect(t.calls.compatible).toEqual([[1, NONE]]);
    expect(t.focus.glow).toEqual([
      [compatible, null],
      [compatible, port(5)],
    ]);
    // The free end snaps; the target search reads the raw point within max(16, 8) px.
    expect(t.calls.preview.at(-1)).toEqual([1, vx, vy, port(5)]);
    expect(t.calls.target.at(-1)).toEqual([1, NONE, vx + 3, vy + 2, 16]);
    expect(t.overlay.previews.at(-1)).toBeInstanceOf(Float32Array);
    expect(t.calls.detach).toEqual([]);

    t.release([vx, vy]);
    expect(t.emitted('connect')).toEqual([
      {
        from: 1,
        to: { kind: 'port', index: 5 },
        replaces: null,
        point: [vx, vy],
        clientX: LEFT + vx,
        clientY: TOP + vy,
      },
    ]);
    expect(t.focus.glow.at(-1)).toEqual([null, null]);
    expect(t.overlay.previews.at(-1)).toBeNull();
    expect(t.interactor.active).toBe(false);
    expect(t.interactor.dragging).toBe(false);
  });

  it('picks up a wired input: from its driver, replacing it, shown detached', () => {
    const t = setup(bench(), BENCH);
    t.drag(t.portAt(2), t.offset(t.portAt(5), 2, 0));
    expect(t.calls.compatible).toEqual([[0, 2]]);
    expect(t.calls.detach).toEqual([2]);

    t.release(t.portAt(5));
    expect(t.emitted('connect')).toEqual([
      expect.objectContaining({ from: 0, to: { kind: 'port', index: 5 }, replaces: 2 }),
    ]);
    expect(t.calls.detach).toEqual([2, null]);
  });

  it('picks up an undriven wire from another port on it', () => {
    const t = setup(bench(), BENCH);
    t.drag(t.portAt(4), [700, 500]);
    expect(t.calls.compatible).toEqual([[3, 4]]);
    expect(t.calls.detach).toEqual([4]);
  });

  it('draws a new wire from an input alone on its net or unwired', () => {
    const t = setup(bench(), BENCH);
    t.drag(t.portAt(6), [700, 500]);
    t.release();
    t.drag(t.portAt(5), [700, 500]);
    t.release();
    expect(t.calls.compatible).toEqual([
      [6, NONE],
      [5, NONE],
    ]);
    expect(t.calls.detach).toEqual([]);
    expect(t.emitted('connect').map((c) => (c as { from: number }).from)).toEqual([6, 5]);
  });

  it('proposes a wire to nothing over empty canvas, at the snapped release point', () => {
    const t = setup(bench(), BENCH);
    t.drag(t.portAt(1), [703, 517]);
    t.release();
    expect(t.emitted('connect')).toEqual([
      {
        from: 1,
        to: null,
        replaces: null,
        point: [704, 520],
        clientX: LEFT + 703,
        clientY: TOP + 517,
      },
    ]);
  });

  it('keeps the release point unsnapped without snap', () => {
    const t = setup(bench(), BENCH);
    t.state.snap = false;
    t.drag(t.portAt(1), [703, 517]);
    t.release();
    expect(t.emitted('connect')).toEqual([expect.objectContaining({ point: [703, 517] })]);
  });

  it('treats a group frame as empty canvas', () => {
    const t = setup(bench(), BENCH);
    t.drag(t.portAt(1), [700, 500]);
    t.state.pick = () => [group(0)];
    t.release();
    expect(t.emitted('connect')).toEqual([expect.objectContaining({ to: null })]);
  });

  it('proposes a wire onto a net target', () => {
    const t = setup(bench(), BENCH);
    t.state.target = () => net(1);
    t.drag(t.portAt(1), [700, 500]);
    t.release();
    expect(t.emitted('connect')).toEqual([
      expect.objectContaining({ to: { kind: 'net', index: 1 } }),
    ]);
  });

  it('drops a wire released on the replaced port, an incompatible part, or outside the canvas', () => {
    const t = setup(bench(), BENCH);
    t.drag(t.portAt(2), [700, 500]);
    t.release(t.portAt(2));
    t.drag(t.portAt(1), [700, 500]);
    t.release(t.centerOf(1));
    t.drag(t.portAt(1), [700, 500]);
    t.release([-5, 300]);
    expect(t.emitted('connect')).toEqual([]);
    expect(t.calls.detach).toEqual([2, null]);
    expect(t.focus.glow.at(-1)).toEqual([null, null]);
    expect(t.overlay.previews.at(-1)).toBeNull();
  });

  it('drops a wire on Escape and on a cancelled drag, restoring the picked-up wire', () => {
    const t = setup(bench(), BENCH);
    t.drag(t.portAt(2), t.portAt(5));
    expect(t.interactor.key({ kind: 'escape' })).toBe(true);
    expect(t.calls.detach).toEqual([2, null]);
    expect(t.focus.glow.at(-1)).toEqual([null, null]);
    expect(t.interactor.active).toBe(false);
    t.release(t.portAt(5), true);
    t.release(t.portAt(5));

    t.drag(t.portAt(1), t.portAt(5));
    t.release(t.portAt(5), true);
    expect(t.emitted('connect')).toEqual([]);
    expect(t.overlay.previews.at(-1)).toBeNull();
  });

  it('clears hover as a drag starts', () => {
    const t = setup(bench(), BENCH);
    t.focus.hover = port(1);
    t.drag(t.portAt(1), [700, 500]);
    expect(t.focus.hover).toBeNull();
    expect(t.emitted('hover')).toEqual([null]);
    t.release();
    t.drag(t.portAt(1), [700, 500]);
    expect(t.emitted('hover')).toEqual([null]);
  });
});

describe('Interactor block moves', () => {
  it('selects an unselected block, live-snaps the offset, and proposes the move', () => {
    const t = setup();
    t.drag([456, 124], [461, 127]);
    expect(t.emitted('select')).toEqual([[{ kind: 'block', index: 0 }]]);
    expect(t.focus.dragging).toEqual([[0]]);
    expect(t.scene.drags).toEqual([
      [[0], 0, 0],
      [[0], 8, 0],
    ]);

    t.moveTo([476, 131]);
    expect(t.scene.drags.at(-1)).toEqual([[0], 24, 8]);
    t.release();
    expect(t.scene.commits).toBe(1);
    expect(t.focus.dragging.at(-1)).toBeNull();
    const [move] = t.emitted('move') as { blocks: Uint32Array; positions: Float32Array }[];
    expect(Array.from(move!.blocks)).toEqual([0]);
    expect(Array.from(move!.positions)).toEqual([424, 108]);
  });

  it('announces the selection once the move is under way, so a handler may cancel it', () => {
    const t = setup();
    const emit = t.ctx.emit;
    t.ctx.emit = (event, payload) => {
      emit(event, payload);
      if (event === 'select') t.interactor.cancel();
    };
    t.drag([456, 124], [476, 124]);
    expect(t.scene.drags).toEqual([
      [[0], 0, 0],
      [null, 0, 0],
    ]);
    expect(t.interactor.active).toBe(false);
    t.release();
    expect(t.emitted('move')).toEqual([]);
  });

  it('drags every selected block when the pressed one is selected, without a select', () => {
    const t = setup();
    t.focus.select([block(0), port(3), block(1)]);
    t.drag(t.centerOf(1), t.offset(t.centerOf(1), 16, 16));
    expect(t.emitted('select')).toEqual([]);
    expect(t.scene.drags.at(-1)).toEqual([[0, 1], 16, 16]);
  });

  it('follows the pointer unsnapped without snap', () => {
    const t = setup();
    t.state.snap = false;
    t.drag([456, 124], [461, 127]);
    expect(t.scene.drags.at(-1)).toEqual([[0], 5, 3]);
  });

  it('commits nothing when the offset comes back to zero', () => {
    const t = setup();
    t.drag([456, 124], [470, 124]);
    t.moveTo([458, 125]);
    t.release();
    expect(t.scene.commits).toBe(0);
    expect(t.scene.drags.at(-1)).toEqual([null, 0, 0]);
    expect(t.emitted('move')).toEqual([]);
  });

  it('restores the blocks on Escape and on a cancelled drag', () => {
    const t = setup();
    t.drag([456, 124], [476, 131]);
    expect(t.interactor.key({ kind: 'escape' })).toBe(true);
    expect(t.scene.drags.at(-1)).toEqual([null, 0, 0]);
    expect(Array.from(t.scene.positions)).toEqual(TWO_AREA);
    expect(t.focus.dragging.at(-1)).toBeNull();
    t.release([476, 131], true);

    t.drag([456, 124], [476, 131]);
    t.release([476, 131], true);
    expect(t.scene.commits).toBe(0);
    expect(t.emitted('move')).toEqual([]);
  });

  it('moves every member of a group pressed on its frame outside any block', () => {
    const t = setup(plant('steam'), TWO_AREA);
    const [x0, y0] = t.groupRect(0)!;
    t.drag([x0 + 4, y0 + 4], [x0 + 20, y0 + 4]);
    expect(t.emitted('select')).toEqual([]);
    expect(t.focus.dragging).toEqual([[0, 1, 2]]);
    expect(t.scene.drags.at(-1)).toEqual([[0, 1, 2], 16, 0]);
    t.release();
    expect(t.scene.commits).toBe(1);
  });
});

describe('Interactor marquee', () => {
  it('selects the blocks a marquee over empty canvas touches', () => {
    const t = setup();
    t.focus.select([block(0)]);
    t.drag([50, 20], [300, 400]);
    expect(t.overlay.marquees.at(-1)).toEqual([50, 20, 300, 400]);
    // The rectangle is normalized whichever way it is drawn.
    t.moveTo([30, 10]);
    expect(t.overlay.marquees.at(-1)).toEqual([30, 10, 50, 20]);
    t.moveTo([300, 400]);
    t.release();
    expect(t.overlay.marquees.at(-1)).toBeNull();
    expect(t.emitted('select')).toEqual([
      [
        { kind: 'block', index: 1 },
        { kind: 'block', index: 2 },
      ],
    ]);
  });

  it('adds to the selection with Shift and starts on a net', () => {
    const t = setup();
    t.focus.select([block(0)]);
    t.state.pick = () => [net(2)];
    t.drag([50, 20], [300, 400], { shift: true });
    t.release();
    expect([...t.focus.selection]).toEqual([block(0), block(1), block(2)]);
    expect(t.emitted('select')).toHaveLength(1);
  });

  it('emits nothing when the selection does not change, and nothing when cancelled', () => {
    const t = setup();
    t.drag([700, 500], [720, 520]);
    t.release();
    t.drag([50, 20], [300, 400]);
    t.release(undefined, true);
    expect(t.overlay.marquees.at(-1)).toBeNull();
    expect(t.emitted('select')).toEqual([]);
  });
});

describe('Interactor pan', () => {
  it('pans with the middle button, even over a block', () => {
    const t = setup();
    t.drag([456, 124], [466, 130], { button: 1 });
    expect(t.camera.pans).toEqual([[10, 6]]);
    expect(t.scene.drags).toEqual([]);
    t.release();
    expect(t.interactor.active).toBe(false);
  });

  it('pans a primary drag while Space is held in edit', () => {
    const t = setup();
    expect(t.interactor.key({ kind: 'space', down: true })).toBe(true);
    t.drag([456, 124], [466, 124]);
    t.release();
    expect(t.camera.pans).toEqual([[10, 0]]);
    expect(t.interactor.key({ kind: 'space', down: false })).toBe(true);
    t.drag([456, 124], [466, 124]);
    expect(t.scene.drags.length).toBeGreaterThan(0);
  });

  it('pans a touch on empty canvas or a net, and moves a touched block', () => {
    const t = setup();
    t.drag([700, 500], [690, 500], { pointerType: 'touch' });
    t.release();
    t.state.pick = () => [net(1)];
    t.drag([700, 500], [690, 500], { pointerType: 'touch', shift: true });
    t.release();
    expect(t.camera.pans).toEqual([
      [-10, 0],
      [-10, 0],
    ]);
    expect(t.overlay.marquees).toEqual([]);
    t.state.pick = null;
    t.drag([456, 124], [472, 124], { pointerType: 'touch' });
    expect(t.scene.drags.at(-1)).toEqual([[0], 16, 0]);
  });

  it('does nothing with a drag whose press a cancel abandoned', () => {
    const t = setup();
    // A load or a grid change lands between the press on a block and the drag threshold.
    t.press([456, 124]);
    t.interactor.cancel();
    t.interactor.gesture({ kind: 'dragStart', sx: 456, sy: 124, time: 0 });
    t.interactor.gesture({ kind: 'dragMove', sx: 496, sy: 124, dx: 40, dy: 0, time: 0 });
    expect(t.interactor.active).toBe(false);
    t.release([496, 124]);
    // Nor with one that never had a press.
    t.interactor.gesture({ kind: 'dragStart', sx: 10, sy: 10, time: 0 });
    t.interactor.gesture({ kind: 'dragMove', sx: 20, sy: 10, dx: 10, dy: 0, time: 0 });
    t.release([20, 10]);
    expect(t.camera.pans).toEqual([]);
    expect(t.scene.drags).toEqual([]);
    expect(t.overlay.marquees).toEqual([]);
    expect(t.events).toEqual([]);

    // The next press drags as it always does.
    t.drag([456, 124], [472, 124]);
    expect(t.scene.drags.at(-1)).toEqual([[0], 16, 0]);
  });

  it('in navigate, pans every drag and marquees only a Shift mouse drag, adding', () => {
    const t = setup();
    t.state.mode = 'navigate';
    t.drag([456, 124], [466, 124]);
    t.release();
    t.drag(t.portAt(4), t.offset(t.portAt(4), 10, 0));
    t.release();
    expect(t.camera.pans).toEqual([
      [10, 0],
      [10, 0],
    ]);
    expect(t.scene.drags).toEqual([]);
    expect(t.calls.compatible).toEqual([]);
    expect(t.interactor.key({ kind: 'space', down: true })).toBe(false);

    t.focus.select([block(0)]);
    t.drag([50, 20], [300, 400], { shift: true });
    t.release();
    expect([...t.focus.selection]).toEqual([block(0), block(1), block(2)]);
    t.drag([700, 500], [690, 500], { shift: true, pointerType: 'touch' });
    expect(t.camera.pans.at(-1)).toEqual([-10, 0]);
  });

  it('in inspect, drags do nothing', () => {
    const t = setup();
    t.state.mode = 'inspect';
    t.drag([456, 124], [476, 124]);
    t.moveTo([500, 124]);
    t.release();
    t.drag([700, 500], [600, 400], { button: 1 });
    expect(t.interactor.active).toBe(false);
    expect(t.camera.pans).toEqual([]);
    expect(t.scene.drags).toEqual([]);
    expect(t.overlay.marquees).toEqual([]);
  });

  it('moves the camera for wheel and pinch gestures except in inspect', () => {
    const t = setup();
    t.interactor.gesture({ kind: 'zoom', factor: 2, sx: 100, sy: 100 });
    t.interactor.gesture({ kind: 'pan', dx: 5, dy: -5 });
    t.state.mode = 'inspect';
    t.interactor.gesture({ kind: 'zoom', factor: 2, sx: 100, sy: 100 });
    t.interactor.gesture({ kind: 'pan', dx: 5, dy: -5 });
    expect(t.camera.zooms).toEqual([[2, 100, 100]]);
    expect(t.camera.pans).toEqual([[5, -5]]);
  });

  it('keeps a moving block under the pointer through a wheel zoom', () => {
    const t = setup();
    t.drag([456, 124], [472, 124]);
    // Zooming 2x about the canvas center puts diagram (436, 212) under the pointer at (472, 124).
    t.interactor.gesture({ kind: 'zoom', factor: 2, sx: WIDTH / 2, sy: HEIGHT / 2 });
    expect(t.scene.drags.at(-1)).toEqual([[0], -16, 88]);
  });

  it('marks navigation active and clears hover as it starts', () => {
    const t = setup();
    t.focus.hover = block(1);
    t.interactor.gesture({ kind: 'navigationStart' });
    expect(t.interactor.active).toBe(true);
    // A wheel or pinch is no pointer drag.
    expect(t.interactor.dragging).toBe(false);
    expect(t.emitted('hover')).toEqual([null]);
    t.interactor.gesture({ kind: 'navigationEnd' });
    expect(t.interactor.active).toBe(false);
    t.interactor.gesture({ kind: 'hover', clientX: 0, clientY: 0, targetPx: 8 });
    t.interactor.gesture({ kind: 'hoverEnd' });
    expect(t.events).toHaveLength(1);
  });
});

describe('Interactor taps', () => {
  it('selects the first picked part and clears on empty canvas', () => {
    const t = setup();
    t.tap([456, 124]);
    t.tap([456, 124]);
    t.tap([700, 500]);
    t.tap([700, 500]);
    expect(t.emitted('select')).toEqual([[{ kind: 'block', index: 0 }], []]);
  });

  it('cycles through the stack of picked parts on repeated taps', () => {
    const t = setup();
    t.tap(t.portAt(2));
    t.tap(t.portAt(2));
    t.tap(t.portAt(2));
    expect(t.emitted('select')).toEqual([
      [{ kind: 'port', index: 2 }],
      [{ kind: 'block', index: 0 }],
      [{ kind: 'port', index: 2 }],
    ]);
  });

  it('toggles the first picked part with Shift or Ctrl/Meta, and keeps it over empty canvas', () => {
    const t = setup();
    t.tap([456, 124]);
    t.tap(t.centerOf(1), { shift: true });
    t.tap(t.centerOf(2), { mod: true });
    t.tap(t.centerOf(1), { mod: true });
    t.tap([700, 500], { shift: true });
    expect(t.emitted('select')).toEqual([
      [{ kind: 'block', index: 0 }],
      [
        { kind: 'block', index: 0 },
        { kind: 'block', index: 1 },
      ],
      [
        { kind: 'block', index: 0 },
        { kind: 'block', index: 1 },
        { kind: 'block', index: 2 },
      ],
      [
        { kind: 'block', index: 0 },
        { kind: 'block', index: 2 },
      ],
    ]);
  });

  // The adapter reports the click that completes a double tap as the double tap alone.
  const doubleClick = (t: ReturnType<typeof setup>, at: Point, o: PressOptions = {}): void => {
    t.tap(at, o);
    t.press(at, o);
    t.doubleTap(at);
  };

  it('opens the top part on a double tap, announcing no part beneath it', () => {
    const t = setup();
    doubleClick(t, t.portAt(2));
    expect(t.events.map((e) => e.event)).toEqual(['select', 'open']);
    expect([...t.focus.selection]).toEqual([port(2)]);
    expect(t.emitted('open')).toEqual([{ kind: 'port', index: 2 }]);

    // A block inside a group frame: the frame beneath is never selected along the way.
    const g = setup(plant('steam'), TWO_AREA);
    doubleClick(g, g.centerOf(0));
    expect(g.emitted('select')).toEqual([[{ kind: 'block', index: 0 }]]);
    expect(g.emitted('open')).toEqual([{ kind: 'block', index: 0 }]);
  });

  it('opens without a select when the top part is the selection already', () => {
    const t = setup();
    t.focus.select([port(2)]);
    t.press(t.portAt(2));
    t.doubleTap(t.portAt(2));
    expect(t.events).toEqual([{ event: 'open', payload: { kind: 'port', index: 2 } }]);
  });

  it('brings the top part back when the first tap stepped down the stack from it', () => {
    const t = setup();
    t.focus.select([port(2)]);
    doubleClick(t, t.portAt(2));
    expect(t.emitted('select')).toEqual([
      [{ kind: 'block', index: 0 }],
      [{ kind: 'port', index: 2 }],
    ]);
    expect(t.emitted('open')).toEqual([{ kind: 'port', index: 2 }]);
  });

  it('leaves the selection alone on a double tap either click of which carried a modifier', () => {
    const t = setup();
    t.focus.select([block(0)]);
    // Shift on the first click adds the block; the double tap opens it and keeps both.
    t.tap(t.centerOf(1), { shift: true });
    t.press(t.centerOf(1));
    t.doubleTap(t.centerOf(1));
    expect([...t.focus.selection]).toEqual([block(0), block(1)]);
    expect(t.emitted('select')).toHaveLength(1);
    expect(t.emitted('open')).toEqual([{ kind: 'block', index: 1 }]);

    // Ctrl/Meta on the second click alone: the stack step of the first tap stands.
    const u = setup();
    u.focus.select([port(2)]);
    u.tap(u.portAt(2));
    u.press(u.portAt(2), { mod: true });
    u.doubleTap(u.portAt(2));
    expect([...u.focus.selection]).toEqual([block(0)]);
    expect(u.emitted('select')).toEqual([[{ kind: 'block', index: 0 }]]);
    expect(u.emitted('open')).toEqual([{ kind: 'port', index: 2 }]);
  });

  it('fits on a double tap over empty canvas, except in inspect', () => {
    const t = setup();
    t.doubleTap([700, 500]);
    t.state.mode = 'inspect';
    t.doubleTap([700, 500]);
    t.doubleTap([456, 124]);
    expect(t.camera.fits).toBe(1);
    expect(t.emitted('open')).toEqual([{ kind: 'block', index: 0 }]);
  });

  it('answers taps in every mode but none', () => {
    const t = setup();
    for (const mode of ['navigate', 'inspect'] as const) {
      t.state.mode = mode;
      t.tap([456, 124]);
      t.tap([700, 500]);
    }
    t.state.mode = 'none';
    t.tap([456, 124]);
    t.doubleTap([456, 124]);
    t.drag([456, 124], [500, 124]);
    expect(t.emitted('select')).toHaveLength(4);
    expect(t.events).toHaveLength(4);
  });
});

describe('Interactor context menu', () => {
  const event = (clientX: number, clientY: number) => ({ clientX, clientY }) as MouseEvent;

  it('answers a pointer request with the parts under it', () => {
    const t = setup();
    t.focus.select([block(1)]);
    const e = event(LEFT + 456, TOP + 124);
    t.interactor.gesture({ kind: 'contextmenu', event: e, keyboard: false });
    expect(t.calls.pick.at(-1)).toEqual([456, 124, 8]);
    expect(t.emitted('contextmenu')).toEqual([
      {
        event: e,
        keyboard: false,
        clientX: LEFT + 456,
        clientY: TOP + 124,
        parts: [{ kind: 'block', index: 0 }],
      },
    ]);
    expect([...t.focus.selection]).toEqual([block(1)]);
  });

  it('anchors a keyboard request at the first selected part, kept inside the canvas', () => {
    const t = setup();
    const e = event(0, 0);
    const [cx, cy] = t.centerOf(0);
    t.focus.select([block(0), port(3)]);
    t.interactor.gesture({ kind: 'contextmenu', event: e, keyboard: true });
    t.state.locate = () => [-50, 700];
    t.interactor.gesture({ kind: 'contextmenu', event: e, keyboard: true });
    t.focus.select([]);
    t.interactor.gesture({ kind: 'contextmenu', event: e, keyboard: true });
    expect(t.emitted('contextmenu')).toEqual([
      {
        event: e,
        keyboard: true,
        clientX: LEFT + cx,
        clientY: TOP + cy,
        parts: [
          { kind: 'block', index: 0 },
          { kind: 'port', index: 3 },
        ],
      },
      expect.objectContaining({ clientX: LEFT + 8, clientY: TOP + HEIGHT - 8 }),
      expect.objectContaining({ clientX: LEFT + WIDTH / 2, clientY: TOP + HEIGHT / 2, parts: [] }),
    ]);
  });
});

describe('Interactor keys', () => {
  it('nudges selected blocks in edit by a grid, four with Shift, proposing each move', () => {
    const t = setup();
    t.focus.select([block(0), net(1)]);
    expect(t.interactor.key({ kind: 'arrow', dx: 1, dy: 0, large: false })).toBe(true);
    expect(t.interactor.key({ kind: 'arrow', dx: 0, dy: -1, large: true })).toBe(true);
    expect(t.scene.nudges).toEqual([
      [[0], 8, 0],
      [[0], 0, -32],
    ]);
    const moves = t.emitted('move') as { positions: Float32Array }[];
    expect(moves.map((m) => Array.from(m.positions))).toEqual([
      [408, 100],
      [408, 68],
    ]);
    expect(t.camera.pans).toEqual([]);
  });

  it('pans 48 px against the arrow otherwise', () => {
    const t = setup();
    expect(t.interactor.key({ kind: 'arrow', dx: 1, dy: 0, large: false })).toBe(true);
    t.state.mode = 'navigate';
    t.focus.select([block(0)]);
    expect(t.interactor.key({ kind: 'arrow', dx: 0, dy: -1, large: true })).toBe(true);
    expect(t.camera.pans).toEqual([
      [-48, 0],
      [0, 48],
    ]);
    expect(t.scene.nudges).toEqual([]);
  });

  it('steps the selection along the blocks in inspect', () => {
    const t = setup();
    t.state.mode = 'inspect';
    // Nothing selected: the block nearest the viewport center.
    expect(t.interactor.key({ kind: 'arrow', dx: 1, dy: 0, large: false })).toBe(true);
    expect([...t.focus.selection]).toEqual([block(0)]);
    t.interactor.key({ kind: 'arrow', dx: -1, dy: 0, large: false });
    expect([...t.focus.selection]).toEqual([block(1)]);
    t.interactor.key({ kind: 'arrow', dx: 0, dy: 1, large: false });
    expect([...t.focus.selection]).toEqual([block(2)]);
    // Nothing lies below IEEET1 on its nets.
    expect(t.interactor.key({ kind: 'arrow', dx: 0, dy: 1, large: false })).toBe(true);
    expect([...t.focus.selection]).toEqual([block(2)]);
    expect(t.emitted('select')).toHaveLength(3);
    expect(t.camera.pans).toEqual([]);
  });

  it('skips hidden blocks when stepping', () => {
    const t = setup();
    t.state.mode = 'inspect';
    t.scene.hidden.add(1);
    t.focus.select([block(0)]);
    t.interactor.key({ kind: 'arrow', dx: -1, dy: 0, large: false });
    expect([...t.focus.selection]).toEqual([block(2)]);
  });

  it('zooms about the center and fits, except in inspect', () => {
    const t = setup();
    expect(t.interactor.key({ kind: 'zoom', factor: 1.2 })).toBe(true);
    expect(t.interactor.key({ kind: 'fit' })).toBe(true);
    t.state.mode = 'navigate';
    expect(t.interactor.key({ kind: 'fit' })).toBe(true);
    t.state.mode = 'inspect';
    expect(t.interactor.key({ kind: 'zoom', factor: 1.2 })).toBe(false);
    expect(t.interactor.key({ kind: 'fit' })).toBe(false);
    expect(t.camera.zooms).toEqual([[1.2, WIDTH / 2, HEIGHT / 2]]);
    expect(t.camera.fits).toBe(2);
  });

  it('walks the blocks in reading order with Tab, returning false at the ends', () => {
    const t = setup();
    const walk = (back: boolean) => t.interactor.key({ kind: 'tab', back });
    // Reading order: TGOV1 (y 48), GENROU (y 100), IEEET1 (y 200).
    expect([walk(false), walk(false), walk(false), walk(false)]).toEqual([true, true, true, false]);
    expect([...t.focus.selection]).toEqual([block(2)]);
    expect([walk(true), walk(true), walk(true)]).toEqual([true, true, false]);
    expect([...t.focus.selection]).toEqual([block(1)]);
    expect(t.emitted('select')).toEqual([
      [{ kind: 'block', index: 1 }],
      [{ kind: 'block', index: 0 }],
      [{ kind: 'block', index: 2 }],
      [{ kind: 'block', index: 0 }],
      [{ kind: 'block', index: 1 }],
    ]);
    t.focus.select([]);
    expect(walk(true)).toBe(true);
    expect([...t.focus.selection]).toEqual([block(2)]);
  });

  it('breaks reading-order ties by x, then index, and skips hidden blocks', () => {
    const t = setup(twoArea(), [400, 100, 96, 48, 96, 100]);
    const walk = () => t.interactor.key({ kind: 'tab', back: false });
    t.scene.hidden.add(1);
    expect([walk(), walk(), walk()]).toEqual([true, true, false]);
    expect(t.emitted('select')).toEqual([
      [{ kind: 'block', index: 2 }],
      [{ kind: 'block', index: 0 }],
    ]);
  });

  it('opens the first selected part with Enter', () => {
    const t = setup();
    expect(t.interactor.key({ kind: 'open' })).toBe(false);
    t.focus.select([port(2), block(0)]);
    expect(t.interactor.key({ kind: 'open' })).toBe(true);
    expect(t.emitted('open')).toEqual([{ kind: 'port', index: 2 }]);
  });

  it('clears the selection with Escape, unused when there is none', () => {
    const t = setup();
    expect(t.interactor.key({ kind: 'escape' })).toBe(false);
    t.focus.select([block(0)]);
    expect(t.interactor.key({ kind: 'escape' })).toBe(true);
    expect(t.emitted('select')).toEqual([[]]);
  });

  it('proposes deleting the selection in edit only', () => {
    const t = setup();
    expect(t.interactor.key({ kind: 'delete' })).toBe(false);
    t.focus.select([block(0), net(1)]);
    t.state.mode = 'navigate';
    expect(t.interactor.key({ kind: 'delete' })).toBe(false);
    t.state.mode = 'edit';
    expect(t.interactor.key({ kind: 'delete' })).toBe(true);
    expect(t.emitted('delete')).toEqual([
      [
        { kind: 'block', index: 0 },
        { kind: 'net', index: 1 },
      ],
    ]);
  });

  it('holds other keys while a drag is in flight', () => {
    const t = setup();
    t.focus.select([block(0)]);
    t.drag([700, 500], [720, 520]);
    expect(t.interactor.key({ kind: 'tab', back: false })).toBe(true);
    expect(t.interactor.key({ kind: 'delete' })).toBe(true);
    expect(t.interactor.key({ kind: 'arrow', dx: 1, dy: 0, large: false })).toBe(true);
    expect(t.events).toEqual([]);
    expect(t.scene.nudges).toEqual([]);
  });

  it('uses no key before a load or in none', () => {
    const t = setup(null, []);
    expect(t.interactor.key({ kind: 'arrow', dx: 1, dy: 0, large: false })).toBe(false);
    expect(t.interactor.key({ kind: 'tab', back: false })).toBe(false);
    expect(t.interactor.key({ kind: 'zoom', factor: 1.2 })).toBe(false);
    const u = setup();
    u.state.mode = 'none';
    u.focus.select([block(0)]);
    for (const k of [
      { kind: 'arrow', dx: 1, dy: 0, large: false },
      { kind: 'zoom', factor: 1.2 },
      { kind: 'fit' },
      { kind: 'tab', back: false },
      { kind: 'open' },
      { kind: 'escape' },
      { kind: 'delete' },
      { kind: 'space', down: true },
    ] as const) {
      expect(u.interactor.key(k)).toBe(false);
    }
    expect(u.events).toEqual([]);
  });
});

describe('Interactor auto-pan', () => {
  it('pans toward an edge while moving blocks, scaled by depth, and the blocks follow', () => {
    const t = setup();
    t.drag([456, 124], [790, 124]);
    expect(t.scene.drags.at(-1)).toEqual([[0], 336, 0]);
    // 14 px into the 24 px zone: 7/12 of 600 px/s.
    expect(t.interactor.tick(1000)).toBe(true);
    expect(t.camera.pans).toEqual([]);
    expect(t.interactor.tick(1016)).toBe(true);
    expect(t.camera.pans[0]![0]).toBeCloseTo(-5.6, 6);
    expect(t.interactor.tick(1100)).toBe(true);
    expect(t.camera.pans[1]![0]).toBeCloseTo(-29.4, 6);
    expect(t.scene.drags.at(-1)).toEqual([[0], 368, 0]);
    // A stall integrates at most 100 ms.
    t.interactor.tick(5000);
    expect(t.camera.pans[2]![0]).toBeCloseTo(-35, 6);

    t.moveTo([400, 124]);
    expect(t.interactor.tick(5016)).toBe(false);
    t.release();
    expect(t.interactor.tick(5032)).toBe(false);
  });

  it('pans a marquee and a wire past the top-left corner', () => {
    const t = setup();
    t.drag([300, 300], [-10, 12]);
    t.interactor.tick(0);
    t.interactor.tick(50);
    expect(t.camera.pans[0]![0]).toBeCloseTo(30, 6);
    expect(t.camera.pans[0]![1]).toBeCloseTo(15, 6);
    expect(t.overlay.marquees.at(-1)![0]).toBeCloseTo(-40, 6);
    t.release();

    const w = setup(bench(), BENCH);
    w.drag(w.portAt(1), [WIDTH - 1, HEIGHT / 2]);
    const previews = w.calls.preview.length;
    w.interactor.tick(0);
    w.interactor.tick(50);
    expect(w.calls.preview.length).toBe(previews + 1);
  });

  it('never runs under reduced motion or for a pan', () => {
    const t = setup();
    t.state.reduced = true;
    t.drag([456, 124], [790, 124]);
    expect(t.interactor.tick(0)).toBe(false);
    expect(t.interactor.tick(50)).toBe(false);
    t.release();
    t.state.reduced = false;
    t.drag([456, 124], [790, 124], { button: 1 });
    expect(t.interactor.tick(0)).toBe(false);
    expect(t.interactor.tick(50)).toBe(false);
    expect(t.camera.pans).toEqual([[334, 0]]);
  });
});

describe('Interactor held Space', () => {
  it('keeps a held Space through a cancel, since a load or a grid change leaves the key down', () => {
    const t = setup();
    t.interactor.key({ kind: 'space', down: true });
    t.interactor.cancel();
    t.drag([456, 124], [466, 124]);
    t.release();
    expect(t.camera.pans).toEqual([[10, 0]]);
    expect(t.scene.drags).toEqual([]);

    expect(t.interactor.key({ kind: 'space', down: false })).toBe(true);
    t.drag([456, 124], [472, 124]);
    expect(t.scene.drags.at(-1)).toEqual([[0], 16, 0]);
  });

  it('lets go of Space on its release in every mode, as the keyboard adapter reports it', () => {
    const t = setup();
    // The mode moves on while the key is held; the adapter reports the release, or its teardown.
    for (const mode of ['none', 'navigate', 'inspect'] as const) {
      t.state.mode = 'edit';
      expect(t.interactor.key({ kind: 'space', down: true })).toBe(true);
      t.state.mode = mode;
      expect(t.interactor.key({ kind: 'space', down: false })).toBe(false);
      t.state.mode = 'edit';
      t.drag([456, 124], [472, 124]);
      t.release();
    }
    expect(t.camera.pans).toEqual([]);
    expect(t.scene.commits).toBe(3);
  });
});

describe('Interactor cancel', () => {
  it('abandons a drag and forgets navigation', () => {
    const t = setup();
    t.interactor.gesture({ kind: 'navigationStart' });
    t.interactor.cancel();
    expect(t.interactor.active).toBe(false);
    t.drag([456, 124], [472, 124]);
    expect(t.scene.drags.at(-1)).toEqual([[0], 16, 0]);
    t.interactor.cancel();
    expect(t.scene.drags.at(-1)).toEqual([null, 0, 0]);
    expect(t.interactor.active).toBe(false);
    t.release();
    expect(t.emitted('move')).toEqual([]);
  });
});
