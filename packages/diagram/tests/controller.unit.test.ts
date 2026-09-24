// @vitest-environment jsdom

import type { Colormap, Netlist } from '@latkit/model';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Diagram, Options } from '../src/controller.js';
import { snapTo } from '../src/geometry.js';
import type { Part } from '../src/part.js';
import { DEFAULT_SHADE_WGSL, SHADE_HOST_WORDS, type Shade, type ShadeFrame } from '../src/shade.js';
import {
  FOCUS_COMPATIBLE,
  FOCUS_HOVER,
  FOCUS_SELECTED,
  FOCUS_TARGET,
  focusBases,
  OVERLAY_ALONG,
  OVERLAY_GHOST,
  OVERLAY_PREVIEW,
  OVERLAY_WORDS,
  WIRE_WORDS,
} from '../src/webgpu/buffers.js';
import {
  DISPLAY_ARROWS,
  DISPLAY_EDIT,
  DISPLAY_GRID,
  DISPLAY_JUNCTIONS,
  DISPLAY_LABELS,
  DISPLAY_REDUCED,
  UNIFORM_LAYOUT,
  W_FLAGS,
} from '../src/webgpu/uniforms.js';
import {
  createControllerHarness,
  createFakes,
  deferred,
  flushMicrotasks,
  HEIGHT,
  LEFT,
  TOP,
  WIDTH,
  type ControllerHarness,
} from './fixtures/controller-harness.js';
import { build, empty, twoArea } from './fixtures/netlists.js';

const G = 8;
const block = (index: number): Part => ({ kind: 'block', index });
const port = (index: number): Part => ({ kind: 'port', index });
const net = (index: number): Part => ({ kind: 'net', index });
const group = (index: number): Part => ({ kind: 'group', index });

/**
 * SRC drives GAIN drives SINK; SCOPE stands alone with an unwired input.
 *
 * Ports: 0 SRC.y (out), 1 GAIN.u (in), 2 GAIN.y (out), 3 SINK.u (in), 4 SCOPE.u (in).
 * Nets: 0 a [0, 1], 1 b [2, 3].
 */
function edit(): Netlist {
  return build({
    blocks: [
      { key: 'src', title: 'SRC', ports: [{ name: 'y', flow: 'out' }] },
      {
        key: 'gain',
        title: 'GAIN',
        ports: [
          { name: 'u', flow: 'in' },
          { name: 'y', flow: 'out' },
        ],
      },
      { key: 'sink', title: 'SINK', ports: [{ name: 'u', flow: 'in' }] },
      { key: 'scope', title: 'SCOPE', ports: [{ name: 'u', flow: 'in' }] },
    ],
    nets: [
      {
        label: 'a',
        ports: [
          [0, 'y'],
          [1, 'u'],
        ],
      },
      {
        label: 'b',
        ports: [
          [1, 'y'],
          [2, 'u'],
        ],
      },
    ],
  });
}

/**
 * `edit` after SRC was removed and EXTRA added reading GAIN: blocks GAIN 0, SINK 1, SCOPE 2,
 * EXTRA 3; one net [GAIN.y, SINK.u, EXTRA.u].
 */
function edited(): Netlist {
  return build({
    blocks: [
      {
        key: 'gain',
        title: 'GAIN',
        ports: [
          { name: 'u', flow: 'in' },
          { name: 'y', flow: 'out' },
        ],
      },
      { key: 'sink', title: 'SINK', ports: [{ name: 'u', flow: 'in' }] },
      { key: 'scope', title: 'SCOPE', ports: [{ name: 'u', flow: 'in' }] },
      { key: 'extra', title: 'EXTRA', ports: [{ name: 'u', flow: 'in' }] },
    ],
    nets: [
      {
        label: 'b',
        ports: [
          [0, 'y'],
          [1, 'u'],
          [3, 'u'],
        ],
      },
    ],
  });
}

/** Two blocks in one group, wired. */
function grouped(): Netlist {
  return build({
    blocks: [
      { key: 'a', title: 'A', group: 0, ports: [{ name: 'y', flow: 'out' }] },
      { key: 'b', title: 'B', group: 0, ports: [{ name: 'u', flow: 'in' }] },
    ],
    nets: [
      {
        ports: [
          [0, 'y'],
          [1, 'u'],
        ],
      },
    ],
    groups: ['plant'],
  });
}

let harnesses: ControllerHarness[] = [];

async function makeHarness(options: Options = {}, attach = true): Promise<ControllerHarness> {
  const h = await createControllerHarness(options, attach);
  harnesses.push(h);
  return h;
}

/** Attached, `netlist` loaded, one frame painted, nothing heard yet. */
async function loaded(
  options: Options = {},
  netlist: Netlist = edit(),
): Promise<ControllerHarness> {
  const h = await makeHarness(options);
  h.diagram.load(netlist);
  await h.settle();
  h.clearHeard();
  return h;
}

/** The focus flags of a part in the shared focus mirror. */
function flags(h: ControllerHarness, part: Part): number {
  const mirrors = h.renderer.mirrors;
  const counts = {
    blockCount: 4,
    portCount: 5,
    netCount: 2,
    groupCount: 0,
  };
  const bases = focusBases(counts);
  const base =
    part.kind === 'block'
      ? 0
      : part.kind === 'port'
        ? bases.port
        : part.kind === 'net'
          ? bases.net
          : bases.group;
  return mirrors.focus.u32[base + part.index]!;
}

/** The kinds of the overlay entries the last frame drew. */
function overlayKinds(h: ControllerHarness): number[] {
  const count = h.renderer.last?.overlay ?? 0;
  const u32 = h.renderer.mirrors.overlay.u32;
  return Array.from({ length: count }, (_, i) => u32[i * OVERLAY_WORDS]!);
}

/** The client point of a canvas-local one. */
const client = (point: readonly [number, number]): readonly [number, number] => [
  point[0] + LEFT,
  point[1] + TOP,
];

afterEach(() => {
  for (const h of harnesses) h.destroy();
  harnesses = [];
  document.body.innerHTML = '';
  delete (document as { hidden?: boolean }).hidden;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createDiagram construction', () => {
  it('validates options before building any collaborator', () => {
    const fakes = createFakes();
    expect(() => fakes.create({ gridPitch: -1 })).toThrow(RangeError);
    expect(() => fakes.create({ interaction: 'draw' } as unknown as Options)).toThrow(TypeError);
    expect(fakes.deps.createRasterizer).not.toHaveBeenCalled();
  });

  it('loads, binds channels, and selects before any canvas exists, then replays on attach', async () => {
    const h = await makeHarness({ colormap: (t) => [t, 0, 1 - t] }, false);
    h.diagram.load(edit());
    h.diagram.setChannel('netColor', Float32Array.of(0.5, 1), [0, 2]);
    h.diagram.select([block(1)]);
    expect(h.diagram.hitTest(100, 100)).toEqual([]);
    expect(h.diagram.locate(block(1))).toBeNull();
    expect(h.diagram.getPose()).toBeNull();
    expect(h.diagram.toDiagram(100, 100)).toBeNull();

    await h.diagram.attach(h.canvas);
    expect(h.deps.Renderer).toHaveBeenCalledWith(h.presentations[0], h.renderer.mirrors, null);
    const lut = h.renderer.writeColormap.mock.calls[0]![0];
    expect(Array.from(lut.subarray(0, 4))).toEqual([0, 0, 255, 255]);
    expect(h.loop.frameNow).toHaveBeenCalledOnce();
    expect(h.frame()).toBe(false);
    expect(h.renderer.last).toMatchObject({ blocks: 4, ports: 5, groups: 0 });
    expect(h.renderer.last!.wires).toBeGreaterThan(0);
    expect(h.renderer.last!.glyphs).toBeGreaterThan(0);
    expect(flags(h, block(1)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
    expect(h.diagram.getChannelDomain('netColor')).toEqual([0, 2]);
    expect(h.diagram.getPose()).not.toBeNull();
  });
});

describe('attach, detach, and destroy', () => {
  it('leases a device, binds the canvas, attaches input, and paints', async () => {
    const h = await makeHarness();
    expect(h.diagram.attached).toBe(true);
    expect(h.emitted('attached')).toEqual([true]);
    expect(h.deps.createPresentation).toHaveBeenCalledWith(h.device, h.canvas);
    expect(h.deps.attachGestures).toHaveBeenCalledOnce();
    expect(h.deps.attachKeyboard).toHaveBeenCalledOnce();
    expect(h.surface.setNavigable).toHaveBeenLastCalledWith(true);
    expect(h.loop.resume).toHaveBeenCalled();
    expect(h.diagram.painted).toBe(false);

    // An empty diagram still paints: the canvas clears.
    h.frame();
    expect(h.diagram.painted).toBe(true);
    // Delivered after the frame, never from inside it.
    expect(h.emitted('painted')).toEqual([]);
    await flushMicrotasks();
    expect(h.emitted('painted')).toEqual([true]);
    expect(h.renderer.last).toEqual({
      groups: 0,
      wires: 0,
      blocks: 0,
      ports: 0,
      glyphs: 0,
      overlay: 0,
    });
    // No grid before the camera is placed.
    expect(h.renderer.mirrors.uniforms.u32[W_FLAGS]! & DISPLAY_GRID).toBe(0);
  });

  it('releases everything on detach, keeps every state, and replays it on the next attach', async () => {
    const h = await loaded();
    h.diagram.select([block(2)]);
    const renderer = h.renderer;
    const loop = h.loop;
    const input = h.input;
    const keys = h.keys;
    const device = h.device;

    h.diagram.detach();
    expect(h.diagram.attached).toBe(false);
    expect(h.diagram.painted).toBe(false);
    expect(h.emitted('painted')).toEqual([false]);
    expect(h.emitted('attached')).toEqual([false]);
    expect(h.pool.releases).toHaveBeenCalledWith(device);
    expect(renderer.destroy).toHaveBeenCalledOnce();
    expect(loop.destroy).toHaveBeenCalledOnce();
    expect(input.destroy).toHaveBeenCalledOnce();
    expect(keys.destroy).toHaveBeenCalledOnce();
    expect(h.surface.destroy).toHaveBeenCalledOnce();
    expect(h.presentations[0]!.destroy).toHaveBeenCalledOnce();
    expect(h.diagram.hitTest(400, 300)).toEqual([]);
    expect(h.diagram.locate(block(0))).toBeNull();

    await h.diagram.attach(h.canvas);
    expect(h.renderers).toHaveLength(2);
    expect(h.renderer.mirrors).toBe(renderer.mirrors);
    h.frame();
    expect(h.renderer.last).toMatchObject({ blocks: 4, ports: 5 });
    expect(flags(h, block(2)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
    expect(h.diagram.locate(block(0))).not.toBeNull();
  });

  it('forgets everything on destroy and refuses a later attach', async () => {
    const h = await loaded();
    const atlas = h.renderer.render.mock.calls[0]![1];
    expect(atlas.pixels.some((texel) => texel !== 0)).toBe(true);
    h.diagram.destroy();
    expect(h.diagram.attached).toBe(false);
    expect(h.renderer.destroy).toHaveBeenCalledOnce();
    // Listeners were cleared: destroy announces nothing.
    expect(h.heard).toEqual([]);
    await expect(h.diagram.attach(h.canvas)).rejects.toThrow(/destroyed/);
    expect(h.diagram.getPose()).toBeNull();

    // No netlist remains to answer from, and nothing it grew stays allocated.
    expect(h.diagram.neighborhood(block(0))).toEqual([]);
    expect(h.diagram.arrange()).toEqual(new Float32Array(0));
    expect(h.diagram.reveal(block(0))).toBe(false);
    const { mirrors } = h.renderer;
    for (const mirror of [
      mirrors.structure,
      mirrors.layout,
      mirrors.channels,
      mirrors.focus,
      mirrors.wires,
      mirrors.glyphs,
      mirrors.overlay,
    ]) {
      expect(mirror.words, mirror.label).toBe(0);
      expect(mirror.capacity, mirror.label).toBeLessThanOrEqual(4);
    }
    expect(atlas.height).toBe(256);
    expect(atlas.pixels.every((texel) => texel === 0)).toBe(true);
    h.diagram.destroy();
  });

  it('rejects an attach overtaken by a newer attach or a detach with AbortError', async () => {
    const h = await makeHarness({}, false);
    const release = h.pool.hold();
    const first = h.diagram.attach(h.canvas);
    const second = h.diagram.attach(h.canvas);
    await second;
    release();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.diagram.attached).toBe(true);
    expect(h.pool.releases).toHaveBeenCalledTimes(1);
    expect(h.renderers).toHaveLength(1);

    h.diagram.detach();
    const held = h.pool.hold();
    const third = h.diagram.attach(h.canvas);
    h.diagram.detach();
    held();
    await expect(third).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.diagram.attached).toBe(false);
    expect(h.pool.releases).toHaveBeenCalledTimes(3);
  });

  it('refuses a device without five vertex storage buffers and releases its lease', async () => {
    const h = await makeHarness({}, false);
    h.pool.limits = { maxStorageBuffersInVertexStage: 4 };
    await expect(h.diagram.attach(h.canvas)).rejects.toThrow(
      new TypeError('A Core WebGPU device is required'),
    );
    expect(h.pool.releases).toHaveBeenCalledOnce();
    expect(h.diagram.attached).toBe(false);
    expect(h.deps.Renderer).not.toHaveBeenCalled();

    h.pool.limits = { maxStorageBuffersInVertexStage: 8 };
    await h.diagram.attach(h.canvas);
    expect(h.diagram.attached).toBe(true);
  });

  it('recovers from a lost device in place, replaying every state', async () => {
    const h = await loaded();
    h.diagram.select([block(1)]);
    const first = h.renderer;
    const device = h.device;

    h.loseDevice({ reason: 'destroyed', message: 'gone' });
    await flushMicrotasks();
    expect(h.emitted('deviceLost')).toEqual([
      { reason: 'destroyed', message: 'gone', recovering: true },
    ]);
    expect(h.emitted('attached')).toEqual([false, true]);
    expect(h.pool.releases).toHaveBeenCalledWith(device);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(h.renderers).toHaveLength(2);
    expect(h.device).not.toBe(device);
    h.frame();
    expect(h.renderer.last).toMatchObject({ blocks: 4 });
    expect(flags(h, block(1)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
  });

  it('stays detached when no replacement device can be leased', async () => {
    const h = await loaded();
    h.pool.fail(new Error('no adapter'));
    h.loseDevice();
    await flushMicrotasks();
    expect(h.emitted('deviceLost')).toEqual([
      { reason: 'unknown', message: 'lost for test', recovering: true },
      { reason: 'unavailable', message: 'no adapter', recovering: false },
    ]);
    expect(h.diagram.attached).toBe(false);
  });

  it('lets a detach from a device-loss handler stand', async () => {
    const h = await loaded();
    h.diagram.on('deviceLost', () => h.diagram.detach());
    h.loseDevice();
    await flushMicrotasks();
    expect(h.emitted('deviceLost')).toEqual([
      { reason: 'unknown', message: 'lost for test', recovering: true },
    ]);
    expect(h.diagram.attached).toBe(false);
    expect(h.renderers).toHaveLength(1);
    expect(h.pool.devices).toHaveLength(1);
  });

  it('reports no recovery when the attached handler already detached', async () => {
    const h = await loaded();
    h.diagram.on('attached', (attached) => {
      if (!attached) h.diagram.detach();
    });
    h.loseDevice();
    await flushMicrotasks();
    expect(h.emitted('deviceLost')).toEqual([
      { reason: 'unknown', message: 'lost for test', recovering: false },
    ]);
    expect(h.diagram.attached).toBe(false);
    expect(h.pool.devices).toHaveLength(1);
  });

  it('lets an attach elsewhere from a device-loss handler win over the recovery', async () => {
    const h = await loaded();
    const other = document.createElement('canvas');
    let moved: Promise<void> | null = null;
    h.diagram.on('deviceLost', () => {
      moved = h.diagram.attach(other);
    });
    h.loseDevice();
    await flushMicrotasks();
    await expect(moved).resolves.toBeUndefined();
    expect(h.diagram.attached).toBe(true);
    expect(h.presentations.at(-1)!.canvas).toBe(other);
    expect(h.pool.devices).toHaveLength(2);
    expect(h.emitted('attached')).toEqual([false, true]);
  });

  it('ignores the loss of a device a newer attach already replaced', async () => {
    const h = await loaded();
    h.diagram.detach();
    await h.diagram.attach(h.canvas);
    h.clearHeard();
    h.loseDevice({}, 0);
    await flushMicrotasks();
    expect(h.heard).toEqual([]);
    expect(h.diagram.attached).toBe(true);
  });

  it('pauses rendering while the page is hidden', async () => {
    const h = await loaded();
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.loop.pause).toHaveBeenCalled();
    const frames = h.renderer.frames.length;
    expect(h.frame()).toBe(false);
    expect(h.renderer.frames).toHaveLength(frames);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(h.loop.paused).toBe(false);
    h.frame();
    expect(h.renderer.frames).toHaveLength(frames + 1);
  });

  it('pauses and resumes on request, clearing hover at once', async () => {
    const h = await loaded();
    h.diagram.setPointer(...client(h.at(block(2))));
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(2)]);

    h.diagram.pause();
    expect(h.emitted('hover')).toEqual([block(2), null]);
    expect(h.loop.pause).toHaveBeenCalled();
    expect(flags(h, block(2)) & FOCUS_HOVER).toBe(0);
    const frames = h.renderer.frames.length;
    expect(h.frame()).toBe(false);
    expect(h.renderer.frames).toHaveLength(frames);

    h.diagram.resume();
    expect(h.loop.paused).toBe(false);
  });
});

describe('paint', () => {
  it('rejects while detached, resolves after a submitted frame, and aborts on detach', async () => {
    const h = await makeHarness({}, false);
    await expect(h.diagram.paint()).rejects.toMatchObject({ name: 'InvalidStateError' });

    await h.diagram.attach(h.canvas);
    h.diagram.load(edit());
    const painted = h.diagram.paint();
    expect(h.loop.wake).toHaveBeenCalled();
    h.renderer.ready = false;
    h.frame();
    let settled = false;
    void painted.then(() => (settled = true));
    await flushMicrotasks();
    expect(settled).toBe(false);
    h.renderer.ready = true;
    h.frame();
    await expect(painted).resolves.toBeUndefined();

    const aborted = h.diagram.paint();
    h.diagram.detach();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects with a pipeline failure, replays it to late subscribers, and clears on a shade', async () => {
    const h = await loaded();
    const painted = h.diagram.paint();
    const cause = new Error('pipeline');
    h.renderer.onPipelineError!(cause);
    await expect(painted).rejects.toBe(cause);
    expect(h.emitted('pipelineError')).toEqual([{ cause }]);
    await expect(h.diagram.paint()).rejects.toBe(cause);

    const late = vi.fn();
    h.diagram.on('pipelineError', late);
    expect(late).toHaveBeenCalledWith({ cause });

    await h.diagram.setShade({ wgsl: 'fn shade(f: Fragment) -> vec4f { return f.color; }' });
    const next = h.diagram.paint();
    h.frame();
    await expect(next).resolves.toBeUndefined();
  });

  it('waits for a shade compile in flight', async () => {
    const h = await loaded();
    const gate = deferred<void>();
    h.renderer.nextShadeGate = gate;
    const shading = h.diagram.setShade({
      wgsl: 'fn shade(f: Fragment) -> vec4f { return f.color; }',
    });
    const painted = h.diagram.paint();
    let settled = false;
    void painted.then(() => (settled = true));
    h.frame();
    await flushMicrotasks();
    expect(settled).toBe(false);
    gate.resolve();
    await shading;
    h.frame();
    await expect(painted).resolves.toBeUndefined();
  });
});

describe('load', () => {
  it('fits the camera once a viewport exists, or keeps a placed pose with fit false', async () => {
    const h = await makeHarness({}, false);
    h.diagram.load(edit());
    expect(h.diagram.getPose()).toBeNull();
    await h.diagram.attach(h.canvas);
    h.frame();
    const pose = h.diagram.getPose()!;
    expect(pose.zoom).toBeGreaterThan(0);

    h.diagram.panBy(50, 0);
    const panned = h.diagram.getPose()!;
    h.diagram.load(edited(), { fit: false });
    h.frame();
    expect(h.diagram.getPose()).toEqual(panned);
    h.diagram.load(edit());
    h.frame();
    expect(h.diagram.getPose()!.centerX).not.toBe(panned.centerX);
  });

  it('throws naming an invalid field and leaves the prior view intact', async () => {
    const h = await loaded();
    h.diagram.select([block(2)]);
    const pose = h.diagram.getPose();
    const auto = h.diagram.arrange([]);
    const broken = { ...edit(), portStart: Uint32Array.of(0, 1, 3) };
    expect(() => h.diagram.load(broken)).toThrow(/portStart/);
    expect(h.diagram.getPose()).toEqual(pose);
    expect(h.diagram.arrange([])).toEqual(auto);
    h.frame();
    expect(h.renderer.last).toMatchObject({ blocks: 4, ports: 5 });
    expect(flags(h, block(2)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
  });

  it('treats the same netlist, or a content-equal one, as a no-op', async () => {
    const h = await loaded();
    const netlist = edit();
    h.diagram.load(netlist);
    h.diagram.setChannel('netColor', Float32Array.of(0, 1), [0, 4]);
    h.diagram.select([block(3)]);
    const frames = h.loop.frameNow.mock.calls.length;
    h.diagram.load(netlist);
    h.diagram.load(edit());
    expect(h.loop.frameNow).toHaveBeenCalledTimes(frames);
    expect(h.diagram.getChannelDomain('netColor')).toEqual([0, 4]);
    expect(flags(h, block(3)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
  });

  it('keeps survivors in place and selected, places new blocks beside, and clears channels', async () => {
    const h = await loaded({ motion: 'full' });
    const before = h.diagram.arrange([]);
    h.diagram.select([block(2), block(0)]);
    h.diagram.setChannel('netColor', Float32Array.of(0, 1), [0, 2]);
    h.diagram.setChannel('blockVisible', Float32Array.of(1, 1, 1, 0));

    h.diagram.load(edited());
    const after = h.diagram.arrange([]);
    // gain, sink, and scope were blocks 1, 2, 3; they are 0, 1, 2 now.
    expect(Array.from(after.subarray(0, 6))).toEqual(Array.from(before.subarray(2, 8)));
    // EXTRA reads GAIN: it lands right of it.
    expect(after[6]).toBeGreaterThan(after[0]!);
    expect(flags(h, block(1)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
    expect(flags(h, block(0)) & FOCUS_SELECTED).toBe(0);
    expect(h.diagram.getChannelDomain('netColor')).toBeNull();
    // Block 2 shows again: the visibility channel cleared.
    expect(h.diagram.hitTest(...client(h.at(block(2))))).toContainEqual(block(2));
    expect(h.emitted('select')).toEqual([]);

    // SRC fades out as a ghost, gone after the animation.
    const now = performance.now();
    expect(h.frame({ now })).toBe(true);
    expect(overlayKinds(h)).toEqual([OVERLAY_GHOST]);
    expect(h.frame({ now: now + 1000 })).toBe(false);
    expect(overlayKinds(h)).toEqual([]);
  });

  it('keeps the placement of every block whose key survives', async () => {
    const h = await loaded();
    const placement = new Float32Array(8).fill(Number.NaN);
    placement[4] = 480;
    placement[5] = 320;
    h.diagram.setChannel('blockPosition', placement);
    const sink = h.diagram.locate(block(2));

    // SINK is block 1 now and stays where it was placed.
    h.diagram.load(edited(), { fit: false });
    expect(h.diagram.locate(block(1))).toEqual(sink);
    // Only SINK carries a placement: binding exactly that one again moves nothing.
    const gain = h.diagram.locate(block(0));
    const extra = h.diagram.locate(block(3));
    const carried = new Float32Array(8).fill(Number.NaN);
    carried[2] = 480;
    carried[3] = 320;
    h.diagram.setChannel('blockPosition', carried);
    expect(h.diagram.locate(block(0))).toEqual(gain);
    expect(h.diagram.locate(block(1))).toEqual(sink);
    expect(h.diagram.locate(block(3))).toEqual(extra);
  });

  it('draws a load and the placements bound right after it in one frame', async () => {
    const h = await loaded({}, twoArea());
    // A real loop renders at once on `frameNow`: a load that forced a frame would draw the
    // automatic positions before the host's placements arrive, and every edit would flash.
    h.loop.frameNow.mockImplementation(() => void h.loop.frame());
    const render = h.renderer.render.getMockImplementation()!;
    const drawn: number[][] = [];
    h.renderer.render.mockImplementation((counts, atlas) => {
      drawn.push(Array.from(h.renderer.mirrors.layout.f32.subarray(0, 2 * counts.blocks)));
      return render(counts, atlas);
    });
    h.loop.wake.mockClear();

    h.diagram.load(edit(), { fit: false });
    const placement = Float32Array.of(0, 0, 160, 0, 320, 0, 480, 0);
    h.diagram.setChannel('blockPosition', placement);
    expect(drawn).toEqual([]);
    expect(h.loop.wake).toHaveBeenCalled();
    h.frame();
    expect(drawn).toEqual([Array.from(placement)]);
  });

  it('keeps the camera working on an empty netlist, for a first block dropped in', async () => {
    const h = await makeHarness();
    h.diagram.load(empty());
    expect(h.diagram.getPose()).toEqual({ centerX: 0, centerY: 0, zoom: 1 });
    await h.settle();
    expect(h.renderer.mirrors.uniforms.u32[W_FLAGS]! & DISPLAY_GRID).toBe(DISPLAY_GRID);
    expect(h.diagram.toDiagram(LEFT + WIDTH / 2, TOP + HEIGHT / 2)).toEqual([0, 0]);
    expect(h.diagram.hitTest(LEFT + 100, TOP + 100)).toEqual([]);
    h.diagram.panBy(80, 40);
    expect(h.diagram.getPose()).toEqual({ centerX: -80, centerY: -40, zoom: 1 });
    h.diagram.zoomBy(2);
    expect(h.diagram.getPose()).toEqual({ centerX: -80, centerY: -40, zoom: 2 });
    expect(h.diagram.setPose({ centerX: 8 })).toBe(true);
    // Nothing to fit: the view stays.
    h.diagram.fit(true);
    expect(h.diagram.getPose()).toEqual({ centerX: 8, centerY: -40, zoom: 2 });

    // A palette drop: the host adds a block where the pointer let go and loads the result.
    const drop = h.diagram.toDiagram(LEFT + 300, TOP + 200)!;
    expect(drop[0] % G === 0 && drop[1] % G === 0).toBe(true);
    const one = build({ blocks: [{ key: 'gain', title: 'GAIN', ports: [] }], nets: [] });
    h.diagram.load(one, { fit: false });
    h.diagram.setChannel('blockPosition', Float32Array.of(drop[0], drop[1]));
    h.frame();
    expect(h.diagram.getPose()).toEqual({ centerX: 8, centerY: -40, zoom: 2 });
    const [sx, sy] = [(drop[0] - 8) * 2 + WIDTH / 2, (drop[1] + 40) * 2 + HEIGHT / 2];
    expect(h.diagram.hitTest(LEFT + sx + 10, TOP + sy + 10)).toEqual([block(0)]);

    // Emptied again, the camera keeps its pose.
    h.diagram.load(empty());
    expect(h.diagram.getPose()).toEqual({ centerX: 8, centerY: -40, zoom: 2 });
    expect(h.diagram.toDiagram(LEFT + 300, TOP + 200)).toEqual(drop);
  });

  it('places the camera of an empty netlist loaded while detached', async () => {
    const h = await makeHarness({}, false);
    h.diagram.load(twoArea());
    expect(h.diagram.getPose()).toBeNull();
    h.diagram.load(empty());
    expect(h.diagram.getPose()).toEqual({ centerX: 0, centerY: 0, zoom: 1 });
    expect(h.diagram.toDiagram(LEFT, TOP)).toBeNull();
    await h.diagram.attach(h.canvas);
    expect(h.diagram.toDiagram(LEFT + WIDTH / 2, TOP + HEIGHT / 2)).toEqual([0, 0]);
  });

  it('leaves no ghosts under reduced motion, and arranges a netlist without keys whole', async () => {
    const h = await loaded({ motion: 'reduce' });
    h.diagram.load(edited());
    h.frame();
    expect(overlayKinds(h)).toEqual([]);

    const keyless = { ...twoArea(), blockKey: undefined };
    h.diagram.load(keyless);
    h.frame();
    expect(h.renderer.last).toMatchObject({ blocks: 3, ports: 7 });
  });

  it('clears hover and resolves it again at the pointer after the load', async () => {
    const h = await loaded();
    h.diagram.setPointer(...client(h.at(block(3))));
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(3)]);
    // SCOPE survives in place as block 2; the next frame finds it under the pointer again.
    h.diagram.load(edited(), { fit: false });
    expect(flags(h, block(3)) & FOCUS_HOVER).toBe(0);
    expect(h.emitted('hover')).toEqual([block(3)]);
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(3), block(2)]);

    // Loaded away from the pointer, hover clears for good.
    h.diagram.load(twoArea());
    h.diagram.setPointer(LEFT + 1, TOP + 1);
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(3), block(2), null]);
  });
});

describe('channels', () => {
  it('throws before a load unless clearing, and checks lengths', async () => {
    const h = await makeHarness();
    expect(() => h.diagram.setChannel('netColor', Float32Array.of(1))).toThrow(/loaded/);
    expect(() => h.diagram.setChannel('netColor', null)).not.toThrow();
    expect(() => h.diagram.setChannel('blockPosition', null)).not.toThrow();
    h.diagram.load(edit());
    expect(() => h.diagram.setChannel('netColor', Float32Array.of(1))).toThrow(/length 1 != 2/);
    expect(() => h.diagram.setChannel('blockPosition', new Float32Array(4))).toThrow(
      /length 4 != 8/,
    );
    expect(() => h.diagram.setChannel('portStatus', new Float32Array(5))).not.toThrow();
    expect(() => h.diagram.setChannel('blockVisible', new Float32Array(4))).not.toThrow();
  });

  it('places blocks at once and hands a NaN pair back to the automatic position', async () => {
    const h = await loaded();
    const home = h.at(block(3));
    const [ex, ey] = h.empty(40);
    const [x, y] = h.diagram.toDiagram(...client([ex, ey]))!;
    const placement = new Float32Array(8).fill(Number.NaN);
    placement[6] = x;
    placement[7] = y;
    h.diagram.setChannel('blockPosition', placement);
    // No frame needed: picking follows at once.
    const inside = client([ex + 12, ey + 12]);
    expect(h.diagram.hitTest(...inside)).toContainEqual(block(3));
    expect(h.at(block(3))).not.toEqual(home);

    // The automatic layout never follows a placement, and an arrangement never moves one.
    const auto = h.diagram.arrange();
    expect(Array.from(h.diagram.arrange([]))).toEqual(Array.from(auto));
    expect(h.diagram.hitTest(...inside)).toContainEqual(block(3));

    h.diagram.setChannel('blockPosition', new Float32Array(8).fill(Number.NaN));
    expect(h.at(block(3))).toEqual(home);
    placement[6] = Number.NaN;
    placement[7] = 0;
    h.diagram.setChannel('blockPosition', placement);
    expect(h.at(block(3))).toEqual(home);
    h.diagram.setChannel('blockPosition', null);
    expect(h.at(block(3))).toEqual(home);
  });

  it('hides blocks and nets from picking while locate still finds them', async () => {
    const h = await loaded();
    const center = client(h.at(block(2)));
    expect(h.diagram.hitTest(...center)).toContainEqual(block(2));
    h.diagram.setChannel('blockVisible', Float32Array.of(1, 1, 0, 1));
    expect(h.diagram.hitTest(...center)).not.toContainEqual(block(2));
    expect(h.diagram.locate(block(2))).toEqual(center);

    const anchor = client(h.at(net(0)));
    expect(h.diagram.hitTest(...anchor)).toContainEqual(net(0));
    h.diagram.setChannel('netVisible', Float32Array.of(0, 1));
    expect(h.diagram.hitTest(...anchor)).not.toContainEqual(net(0));
    h.diagram.setChannel('netVisible', null);
    expect(h.diagram.hitTest(...anchor)).toContainEqual(net(0));
  });

  it('locates a hidden net at its driver port, and a group only through shown members', async () => {
    const h = await loaded({}, grouped());
    const header = h.diagram.locate(group(0));
    expect(header).not.toBeNull();
    expect(h.diagram.locate(net(0))).not.toEqual(h.diagram.locate(port(0)));
    h.diagram.setChannel('netVisible', Float32Array.of(0));
    expect(h.diagram.locate(net(0))).toEqual(h.diagram.locate(port(0)));

    h.diagram.setChannel('blockVisible', Float32Array.of(0, 1));
    expect(h.diagram.locate(group(0))).not.toBeNull();
    h.diagram.setChannel('blockVisible', Float32Array.of(0, 0));
    expect(h.diagram.locate(group(0))).toBeNull();
    // Hidden blocks and ports still locate.
    expect(h.diagram.locate(block(0))).not.toBeNull();
    expect(h.diagram.locate(port(1))).not.toBeNull();
    h.diagram.setChannel('blockVisible', null);
    h.diagram.setChannel('netVisible', null);
    expect(h.diagram.locate(group(0))).toEqual(header);
  });

  it('normalizes colormap channels through their domain and ignores it for raw ones', async () => {
    const h = await loaded();
    h.diagram.setChannel('blockColor', Float32Array.of(0, 1, 2, 3));
    expect(h.diagram.getChannelDomain('blockColor')).toEqual([0, 1]);
    h.diagram.setChannelDomain('blockColor', [0, 3]);
    expect(h.diagram.getChannelDomain('blockColor')).toEqual([0, 3]);
    h.diagram.setChannelDomain('blockColor', null);
    expect(h.diagram.getChannelDomain('blockColor')).toEqual([0, 1]);
    h.diagram.setChannel('blockStatus', Float32Array.of(0, 1, 2, 0), [5, 6]);
    expect(h.diagram.getChannelDomain('blockStatus')).toBeNull();
    h.diagram.setChannelDomain('netFlow', [0, 1]);
    expect(h.diagram.getChannelDomain('netFlow')).toBeNull();
    expect(() => h.diagram.setChannel('netColor', Float32Array.of(0, 1), [1, 0])).toThrow();
    expect(h.diagram.getChannelDomain('netColor')).toBeNull();
  });

  it('keeps frames coming while dashes march, unless motion is reduced', async () => {
    const h = await loaded({ motion: 'full' });
    expect(h.frame()).toBe(false);
    h.diagram.setChannel('netFlow', Float32Array.of(0, -1));
    expect(h.frame()).toBe(true);
    h.diagram.setOptions({ flowRate: 0 });
    expect(h.frame()).toBe(false);
    h.diagram.setOptions({ flowRate: 1, motion: 'reduce' });
    expect(h.frame()).toBe(false);
    expect(h.renderer.mirrors.uniforms.u32[W_FLAGS]! & DISPLAY_REDUCED).toBe(DISPLAY_REDUCED);
    h.diagram.setOptions({ motion: 'full' });
    h.diagram.setChannel('netFlow', Float32Array.of(0, 0));
    expect(h.frame()).toBe(false);
  });
});

describe('arrange', () => {
  it('returns every automatic top-left as a new array, empty before a load, and never emits', async () => {
    const h = await makeHarness({ motion: 'full' });
    expect(h.diagram.arrange()).toEqual(new Float32Array(0));
    h.diagram.load(edit());
    await h.settle();
    h.clearHeard();
    const first = h.diagram.arrange();
    const second = h.diagram.arrange();
    expect(first).toHaveLength(8);
    expect(second).not.toBe(first);
    expect(Array.from(second)).toEqual(Array.from(first));
    for (const value of first) expect(value % G).toBe(0);
    expect(h.heard).toEqual([]);
  });

  it('eases blocks without a placement to a fresh layout, and never moves a placed one', async () => {
    const h = await loaded({ motion: 'full' });
    h.diagram.load(edited());
    const placed = h.at(block(1));
    const placement = new Float32Array(8).fill(Number.NaN);
    const auto = h.diagram.arrange([]);
    placement[2] = auto[2]!;
    placement[3] = auto[3]!;
    h.diagram.setChannel('blockPosition', placement);

    const fresh = h.diagram.arrange(undefined, { animate: true });
    // SRC left room at the unit's start; a full arrangement packs GAIN there.
    expect(Array.from(fresh)).not.toEqual(Array.from(auto));
    const now = performance.now();
    expect(h.frame({ now })).toBe(true);
    expect(h.frame({ now: now + 1000 })).toBe(false);
    expect(h.at(block(1))).toEqual(placed);
    const [gx, gy] = h.at(block(0));
    const pose = h.diagram.getPose()!;
    // GAIN's center now sits at its fresh top-left plus half its size.
    const top = h.diagram.toDiagram(gx + LEFT, gy + TOP)!;
    expect(Math.abs(top[0] - fresh[0]!)).toBeLessThan(200 / pose.zoom);
    expect(h.diagram.getChannelDomain('blockPosition')).toBeNull();
    expect(h.emitted('move')).toEqual([]);
  });

  it('re-arranges only the units the parts touch, in place, at once under reduced motion', async () => {
    const h = await loaded({ motion: 'reduce' });
    const before = h.diagram.arrange([]);
    const after = h.diagram.arrange([port(1), net(1)], { animate: true });
    expect(Array.from(after)).toEqual(Array.from(before));
    expect(h.frame()).toBe(false);
  });
});

describe('queries and the camera', () => {
  it('selects valid parts without emitting', async () => {
    const h = await loaded();
    h.diagram.select([block(1), port(99), { kind: 'wire', index: 0 } as unknown as Part, net(1)]);
    expect(flags(h, block(1)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
    expect(flags(h, net(1)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
    h.diagram.select([]);
    expect(flags(h, block(1)) & FOCUS_SELECTED).toBe(0);
    expect(h.emitted('select')).toEqual([]);
  });

  it('hit-tests ports before blocks before nets, inside the canvas only', async () => {
    const h = await loaded();
    const at = client(h.at(port(0)));
    const hits = h.diagram.hitTest(...at);
    expect(hits.slice(0, 2)).toEqual([port(0), block(0)]);
    expect(hits).toContainEqual(net(0));
    expect(h.diagram.hitTest(LEFT - 1, TOP + 10)).toEqual([]);
    expect(h.diagram.hitTest(LEFT + WIDTH, TOP + 10)).toEqual([]);
    expect(h.diagram.hitTest(...at, -1)).toEqual([]);
    expect(h.diagram.hitTest(Number.NaN, 0)).toEqual([]);
  });

  it('locates parts in client coordinates, null when invalid', async () => {
    const h = await loaded({}, grouped());
    const [bx, by] = h.diagram.locate(block(0))!;
    const [px, py] = h.diagram.locate(port(0))!;
    // A's output port sits on its right edge, level with its center.
    expect(px).toBeGreaterThan(bx);
    expect(py).toBeCloseTo(by, 6);
    expect(h.diagram.locate(net(0))).not.toBeNull();
    const [gx, gy] = h.diagram.locate(group(0))!;
    expect(gy).toBeLessThan(by);
    expect(gx).toBeGreaterThan(bx);
    expect(h.diagram.locate(block(2))).toBeNull();
    expect(h.diagram.locate(group(1))).toBeNull();
  });

  it('answers neighborhoods for every kind, without duplicates', async () => {
    const h = await makeHarness({}, false);
    expect(h.diagram.neighborhood(block(0))).toEqual([]);
    h.diagram.load(edit());
    expect(h.diagram.neighborhood(block(1))).toEqual([
      block(1),
      net(0),
      net(1),
      block(0),
      block(2),
    ]);
    expect(h.diagram.neighborhood(port(1))).toEqual([port(1), block(1), net(0), port(0)]);
    expect(h.diagram.neighborhood(port(4))).toEqual([port(4), block(3)]);
    expect(h.diagram.neighborhood(net(1))).toEqual([net(1), port(2), port(3), block(1), block(2)]);
    expect(h.diagram.neighborhood(block(9))).toEqual([]);
    h.diagram.load(grouped());
    expect(h.diagram.neighborhood(group(0))).toEqual([group(0), block(0), block(1)]);
  });

  it('reveals a part in place, centered, or with its neighbors', async () => {
    const h = await loaded();
    const pose = h.diagram.getPose()!;
    expect(h.diagram.reveal(block(2))).toBe(true);
    expect(h.diagram.getPose()).toEqual(pose);

    h.diagram.panBy(-5000, 0);
    expect(h.at(block(2))[0]).toBeLessThan(0);
    expect(h.diagram.reveal(block(2))).toBe(true);
    const [cx, cy] = h.at(block(2));
    expect(cx).toBeCloseTo(WIDTH / 2, 6);
    expect(cy).toBeCloseTo(HEIGHT / 2, 6);
    expect(h.diagram.getPose()!.zoom).toBe(pose.zoom);

    h.diagram.panBy(-5000, 0);
    expect(h.diagram.reveal(block(1), { neighbors: true })).toBe(true);
    for (const b of [0, 1, 2]) {
      const [bx, by] = h.at(block(b));
      expect(bx).toBeGreaterThan(0);
      expect(bx).toBeLessThan(WIDTH);
      expect(by).toBeGreaterThan(0);
      expect(by).toBeLessThan(HEIGHT);
    }
    expect(h.diagram.reveal(block(7))).toBe(false);
    h.diagram.setChannel('blockVisible', Float32Array.of(1, 1, 1, 0));
    expect(h.diagram.reveal(block(3))).toBe(false);
  });

  it('fits everything or some parts, and tells the host about fit transitions after frames', async () => {
    const h = await loaded({ motion: 'reduce' });
    const pose = h.diagram.getPose()!;
    h.diagram.panBy(120, 40);
    expect(h.emitted('fit')).toEqual([]);
    await h.settle();
    expect(h.emitted('fit')).toEqual([false]);

    h.diagram.fit(true);
    await h.settle();
    expect(h.diagram.getPose()).toEqual(pose);
    expect(h.emitted('fit')).toEqual([false, true]);

    h.diagram.fit([block(3)]);
    expect(h.diagram.getPose()!.zoom).toBeGreaterThan(pose.zoom);
    const [sx, sy] = h.at(block(3));
    expect(Math.abs(sx - WIDTH / 2)).toBeLessThan(2);
    expect(Math.abs(sy - HEIGHT / 2)).toBeLessThan(40);
    const framed = h.diagram.getPose();
    h.diagram.fit([block(42)]);
    expect(h.diagram.getPose()).toEqual(framed);
    // Framing some parts leaves the fit view.
    await h.settle();
    expect(h.emitted('fit')).toEqual([false, true, false]);
  });

  it('frames parts and neighborhoods without redefining the fit view', async () => {
    const h = await loaded({ motion: 'reduce' });
    const pose = h.diagram.getPose()!;
    h.diagram.fit([block(3)]);
    await h.settle();
    expect(h.emitted('fit')).toEqual([false]);
    const framed = h.diagram.getPose()!;
    expect(framed).not.toEqual(pose);

    // A resize keeps the framed pose: only the fit view follows the canvas.
    await h.settle({ width: WIDTH - 200 });
    await h.settle();
    expect(h.diagram.getPose()).toEqual(framed);
    expect(h.emitted('fit')).toEqual([false]);

    // The fit view is still everything.
    h.diagram.fit();
    await h.settle();
    expect(h.diagram.getPose()).toEqual(pose);
    expect(h.emitted('fit')).toEqual([false, true]);

    h.diagram.reveal(block(1), { neighbors: true });
    await h.settle();
    expect(h.emitted('fit')).toEqual([false, true, false]);
    // A grid change re-fits a camera at the fit view only.
    const neighbors = h.diagram.getPose()!;
    h.diagram.setOptions({ gridPitch: 10 });
    expect(h.diagram.getPose()).toEqual(neighbors);
  });

  it('stops a camera move in flight when revealing a part already in view', async () => {
    const h = await loaded({ motion: 'full', animationMs: 200 });
    const fitted = h.diagram.getPose()!;
    // An idle camera stays at its fit.
    expect(h.diagram.reveal(block(0))).toBe(true);
    await h.settle();
    expect(h.diagram.getPose()).toEqual(fitted);
    expect(h.emitted('fit')).toEqual([]);

    h.diagram.fit([block(3)], true);
    expect(h.diagram.reveal(block(0))).toBe(true);
    const now = performance.now();
    await h.settle({ now });
    expect(h.frame({ now: now + 100 })).toBe(false);
    expect(h.frame({ now: now + 1000 })).toBe(false);
    expect(h.diagram.getPose()).toEqual(fitted);
    const [x, y] = h.at(block(0));
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(WIDTH);
    expect(y).toBeGreaterThan(0);
    expect(y).toBeLessThan(HEIGHT);
    // The interrupted camera no longer follows its fit.
    expect(h.emitted('fit')).toEqual([]);
    await h.settle({ now: now + 1100, width: WIDTH - 200 });
    expect(h.diagram.getPose()).toEqual(fitted);
  });

  it('eases a fit when motion allows', async () => {
    const h = await loaded({ motion: 'full', animationMs: 200 });
    const pose = h.diagram.getPose()!;
    h.diagram.panBy(200, 0);
    h.diagram.fit(true);
    const now = performance.now();
    expect(h.frame({ now })).toBe(true);
    expect(h.diagram.getPose()!.centerX).not.toBe(pose.centerX);
    expect(h.frame({ now: now + 100 })).toBe(true);
    expect(h.frame({ now: now + 300 })).toBe(false);
    expect(h.diagram.getPose()!.centerX).toBeCloseTo(pose.centerX, 6);
  });

  it('converts client points to snapped diagram points', async () => {
    const h = await loaded();
    const [x, y] = h.diagram.toDiagram(LEFT + 333, TOP + 217)!;
    expect(x % G).toBe(0);
    expect(y % G).toBe(0);
    h.diagram.setOptions({ snap: false });
    const [ux, uy] = h.diagram.toDiagram(LEFT + 333, TOP + 217)!;
    expect(Math.abs(ux - x)).toBeLessThanOrEqual(G / 2);
    expect(Math.abs(uy - y)).toBeLessThanOrEqual(G / 2);
    expect(ux % G).not.toBe(0);
  });

  it('reads and sets the pose, clamping zoom, and pans and zooms by screen amounts', async () => {
    const h = await makeHarness();
    expect(h.diagram.getPose()).toBeNull();
    expect(h.diagram.setPose({ zoom: 2 })).toBe(false);
    h.diagram.load(edit());
    h.frame();
    const pose = h.diagram.getPose()!;
    expect(h.diagram.setPose({ zoom: 1000 })).toBe(true);
    expect(h.diagram.getPose()!.zoom).toBe(8);
    expect(h.diagram.setPose({ zoom: 1000 })).toBe(false);
    expect(() => h.diagram.setPose({ centerX: Number.NaN })).toThrow(RangeError);
    expect(h.diagram.setPose({ centerX: 10, centerY: 20, zoom: 1 })).toBe(true);
    expect(h.diagram.getPose()).toEqual({ centerX: 10, centerY: 20, zoom: 1 });

    h.diagram.panBy(30, -10);
    expect(h.diagram.getPose()).toEqual({ centerX: -20, centerY: 30, zoom: 1 });
    h.diagram.zoomBy(2);
    expect(h.diagram.getPose()).toEqual({ centerX: -20, centerY: 30, zoom: 2 });
    expect(pose.zoom).toBeGreaterThan(0);
  });
});

describe('hover', () => {
  it('resolves the pointer in the frame and delivers hover after it submits', async () => {
    const h = await loaded();
    h.diagram.setPointer(...client(h.at(block(2))));
    expect(h.emitted('hover')).toEqual([]);
    h.renderer.ready = false;
    await h.settle();
    expect(h.emitted('hover')).toEqual([]);
    h.renderer.ready = true;
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(2)]);
    expect(flags(h, block(2)) & FOCUS_HOVER).toBe(FOCUS_HOVER);

    h.diagram.setPointer(...client(h.empty()));
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(2), null]);

    h.diagram.setPointer(...client(h.at(port(4))));
    await h.settle();
    h.diagram.setPointer(null);
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(2), null, port(4), null]);
  });

  it('waits for a resize to settle and for the camera to hold still', async () => {
    const h = await loaded({ motion: 'full' });
    h.diagram.setPointer(...client(h.at(block(1))));
    await h.settle({ settled: false });
    expect(h.emitted('hover')).toEqual([]);
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(1)]);
  });

  it('follows what a programmatic camera move brings under the pointer, emitting nothing else', async () => {
    const h = await loaded();
    h.diagram.setPointer(...client(h.at(block(2))));
    await h.settle();
    h.clearHeard();
    h.diagram.panBy(2000, 0);
    await h.settle();
    expect(h.emitted('hover')).toEqual([null]);
    expect(h.heard.map((entry) => entry.event).sort()).toEqual(['fit', 'hover']);
  });

  it('picks the resting pointer again once a wheel or pinch settles', async () => {
    const h = await loaded();
    const [sx, sy] = h.at(block(2));
    h.diagram.setPointer(...client([sx, sy]));
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(2)]);

    h.input.emit({ kind: 'navigationStart' });
    h.input.emit({ kind: 'zoom', factor: 1.25, sx, sy });
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(2), null]);
    h.loop.wake.mockClear();
    h.input.emit({ kind: 'navigationEnd' });
    expect(h.loop.wake).toHaveBeenCalled();
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(2), null, block(2)]);
  });

  it('picks hover against the canvas rectangle, as taps and hitTest do', async () => {
    const h = await loaded();
    // The frame reports a content box smaller than the rectangle: padding or a border.
    const inset = { width: WIDTH - 300, height: HEIGHT - 200 };
    await h.settle(inset);
    const point = client(h.at(block(2)));
    expect(h.diagram.hitTest(...point)[0]).toEqual(block(2));
    h.diagram.setPointer(...point);
    await h.settle(inset);
    expect(h.emitted('hover')).toEqual([block(2)]);
  });

  it('writes the pointer for the shade and hands its tick the frame', async () => {
    const h = await loaded();
    const tick = vi.fn((host: Float32Array, _frame: ShadeFrame) => {
      host[0] = 7;
      return true;
    });
    await h.diagram.setShade({ wgsl: DEFAULT_SHADE_WGSL, tick });
    h.diagram.setPointer(LEFT + 100, TOP + 50);
    const now = performance.now();
    expect(h.frame({ now })).toBe(true);
    const [host, frame] = tick.mock.calls[0]!;
    expect(host).toHaveLength(SHADE_HOST_WORDS);
    expect(frame.timeMs).toBe(now);
    expect(frame.pointerPx).toEqual([100, 50]);
    expect(frame.viewport).toEqual({ w: WIDTH, h: HEIGHT });
  });
});

describe('setShade', () => {
  const shade = (wgsl: string): Shade => ({ wgsl });
  const A = 'fn shade(f: Fragment) -> vec4f { return f.color * 0.5; }';
  const B = 'fn shade(f: Fragment) -> vec4f { return nope; }';

  it('resolves at once while detached and compiles on attach', async () => {
    const h = await makeHarness({}, false);
    await expect(h.diagram.setShade(shade(A))).resolves.toBeUndefined();
    await h.diagram.attach(h.canvas);
    expect(h.renderer.shade).toBe(A);
  });

  it('keeps the previous shade when a new one does not compile', async () => {
    const h = await loaded();
    await h.diagram.setShade(shade(A));
    expect(h.renderer.setShade).toHaveBeenLastCalledWith(A);
    h.renderer.nextShadeError = new Error('does not compile');
    await expect(h.diagram.setShade(shade(B))).rejects.toThrow('does not compile');
    h.diagram.detach();
    await h.diagram.attach(h.canvas);
    expect(h.renderer.shade).toBe(A);
  });

  it('ends a frame whose shade tick detaches, before it submits', async () => {
    const h = await loaded();
    await h.diagram.setShade({
      wgsl: A,
      tick: () => {
        h.diagram.detach();
        return true;
      },
    });
    const renderer = h.renderer;
    const frames = renderer.frames.length;
    expect(h.frame()).toBe(false);
    expect(renderer.frames).toHaveLength(frames);
    expect(h.diagram.attached).toBe(false);
  });
});

describe('options', () => {
  it('validates a whole patch before applying any of it', async () => {
    const h = await loaded();
    expect(() => h.diagram.setOptions({ grid: false, gridPitch: -1 })).toThrow(RangeError);
    expect(() =>
      h.diagram.setOptions({
        grid: false,
        colormap: () => {
          throw new Error('bad colormap');
        },
      }),
    ).toThrow('bad colormap');
    h.frame();
    expect(h.renderer.mirrors.uniforms.u32[W_FLAGS]! & DISPLAY_GRID).toBe(DISPLAY_GRID);
    // Construction-only options are ignored live.
    expect(() => h.diagram.setOptions({ devices: h.pool })).not.toThrow();
  });

  it('writes display flags, colors, and the colormap', async () => {
    const h = await loaded({ motion: 'full' });
    expect(h.renderer.mirrors.uniforms.u32[W_FLAGS]).toBe(
      DISPLAY_GRID | DISPLAY_ARROWS | DISPLAY_JUNCTIONS | DISPLAY_LABELS,
    );
    const red: Colormap = (t) => [t, 0, 0];
    h.diagram.setOptions({
      grid: false,
      arrows: false,
      junctions: false,
      labels: false,
      motion: 'reduce',
      interaction: 'edit',
      colormap: red,
    });
    h.frame();
    expect(h.renderer.mirrors.uniforms.u32[W_FLAGS]).toBe(DISPLAY_REDUCED | DISPLAY_EDIT);
    expect(h.renderer.last!.glyphs).toBe(0);
    const lut = h.renderer.writeColormap.mock.lastCall![0];
    expect(Array.from(lut.subarray(lut.length - 4))).toEqual([255, 0, 0, 255]);
  });

  it('re-sizes at a new grid pitch, keeping the selection and the channels', async () => {
    const h = await loaded();
    h.diagram.select([block(2)]);
    h.diagram.setChannel('blockStatus', Float32Array.of(0, 1, 0, 2));
    const before = h.diagram.arrange([]);
    h.diagram.setOptions({ gridPitch: 10 });
    const after = h.diagram.arrange([]);
    expect(Array.from(after)).not.toEqual(Array.from(before));
    for (const value of after) expect(value % 10).toBe(0);
    expect(flags(h, block(2)) & FOCUS_SELECTED).toBe(FOCUS_SELECTED);
    h.frame();
    expect(h.renderer.last).toMatchObject({ blocks: 4, ports: 5 });
    const [x] = h.diagram.toDiagram(LEFT + 333, TOP + 217)!;
    expect(x % 10).toBe(0);
  });

  it('samples glyphs by the atlas size of the frame that grew it', async () => {
    // 130 distinct narrow glyphs overflow the first 256-pixel atlas (111 cells).
    const title = Array.from({ length: 130 }, (_, i) => String.fromCodePoint(0x100 + i)).join('');
    const h = await makeHarness();
    const atlasHeight = UNIFORM_LAYOUT.find((field) => field.name === 'atlas_size')!.word + 1;
    const render = h.renderer.render.getMockImplementation()!;
    const seen: { atlas: number; uniform: number }[] = [];
    h.renderer.render.mockImplementation((counts, atlas) => {
      seen.push({ atlas: atlas.height, uniform: h.renderer.mirrors.uniforms.f32[atlasHeight]! });
      return render(counts, atlas);
    });
    h.diagram.load(build({ blocks: [{ key: 'wide', title, ports: [] }], nets: [] }));
    expect(h.frame()).toBe(false);
    expect(h.renderer.last!.glyphs).toBe(130);
    expect(seen).toEqual([{ atlas: 512, uniform: 512 }]);
  });

  it('re-routes on a new routing mode and redraws text in a new font', async () => {
    // The speed loop bends at right angles; straight wires do not.
    const h = await loaded({}, twoArea());
    const wires = (): number[] => {
      const { f32 } = h.renderer.mirrors.wires;
      return Array.from(f32.subarray(0, h.renderer.last!.wires * WIRE_WORDS));
    };
    const orthogonal = wires();
    h.diagram.setOptions({ routing: 'straight' });
    h.frame();
    expect(wires()).not.toEqual(orthogonal);

    h.diagram.setOptions({ fontFamily: 'Fira Code' });
    h.frame();
    expect(h.rasterizer.draws.at(-1)!.font).toContain('Fira Code');
  });

  it('re-fits a camera at its fit on new fit padding', async () => {
    const h = await loaded();
    const pose = h.diagram.getPose()!;
    h.diagram.setOptions({ fitPaddingPx: 150 });
    expect(h.diagram.getPose()!.zoom).toBeLessThan(pose.zoom);
    h.diagram.setOptions({ fitPaddingPx: null });
    expect(h.diagram.getPose()!.zoom).toBeCloseTo(pose.zoom, 9);
  });

  it('attaches the adapters the interaction and keyboard options ask for', async () => {
    const h = await loaded();
    expect(h.input.policy.navigable()).toBe(true);
    expect(h.input.policy.pickRadiusPx()).toBe(8);
    const wheel = (init: WheelEventInit): WheelEvent => new WheelEvent('wheel', init);
    expect(h.input.policy.wheel(wheel({ deltaY: 100 }))).toBe('zoom');
    expect(h.input.policy.wheel(wheel({ deltaY: 3.5 }))).toBe('pan');
    h.diagram.setOptions({ wheel: 'modifier', pickRadiusPx: 12 });
    expect(h.input.policy.wheel(wheel({ deltaY: 100 }))).toBe('none');
    expect(h.input.policy.wheel(wheel({ deltaY: 100, ctrlKey: true }))).toBe('zoom');
    expect(h.input.policy.pickRadiusPx()).toBe(12);

    const input = h.input;
    const keys = h.keys;
    h.diagram.setOptions({ interaction: 'none' });
    expect(input.destroy).toHaveBeenCalledOnce();
    expect(keys.destroy).toHaveBeenCalledOnce();
    expect(h.surface.setNavigable).toHaveBeenLastCalledWith(false);

    h.diagram.setOptions({ interaction: 'inspect' });
    expect(h.gestures).toHaveLength(2);
    expect(h.keyboards).toHaveLength(2);
    expect(h.input.policy.navigable()).toBe(false);
    expect(h.surface.setNavigable).toHaveBeenLastCalledWith(false);

    h.diagram.setOptions({ keyboard: false });
    expect(h.keys.destroy).toHaveBeenCalledOnce();
    expect(h.gestures).toHaveLength(2);
  });
});

describe('gestures', () => {
  it('drags a block and proposes its snapped resting place', async () => {
    const h = await loaded({ interaction: 'edit' });
    const auto = h.diagram.arrange([]);
    const zoom = h.diagram.getPose()!.zoom;
    const from = h.at(block(2));
    h.drag(from, [from[0] + 61, from[1] + 43]);
    expect(h.emitted('select')).toEqual([[block(2)]]);
    const [move] = h.emitted('move');
    expect(Array.from(move!.blocks)).toEqual([2]);
    const dx = snapTo(61 / zoom, G);
    const dy = snapTo(43 / zoom, G);
    expect(dx).not.toBe(0);
    expect(Array.from(move!.positions)).toEqual([auto[4]! + dx, auto[5]! + dy]);
    // Already shown there.
    const [x, y] = h.at(block(2));
    expect(x - from[0]).toBeCloseTo(dx * zoom, 3);
    expect(y - from[1]).toBeCloseTo(dy * zoom, 3);
  });

  it('reports the raw release point and offset when snap is off', async () => {
    const h = await loaded({ interaction: 'edit', snap: false });
    const auto = h.diagram.arrange([]);
    const zoom = h.diagram.getPose()!.zoom;
    const from = h.at(block(2));
    h.drag(from, [from[0] + 61, from[1] + 43]);
    const [move] = h.emitted('move');
    expect(move!.positions[0]).toBeCloseTo(auto[4]! + 61 / zoom, 3);
    expect(move!.positions[1]).toBeCloseTo(auto[5]! + 43 / zoom, 3);

    const spot = h.empty();
    h.drag(h.at(port(0)), spot);
    const [wire] = h.emitted('connect');
    const [x, y] = h.diagram.toDiagram(...client(spot))!;
    expect(wire!.point).toEqual([x, y]);
    expect(x % G !== 0 || y % G !== 0).toBe(true);
  });

  it('hears a held Space released as its adapter goes away on detach', async () => {
    const h = await loaded({ interaction: 'edit' });
    expect(h.keys.emit({ kind: 'space', down: true })).toBe(true);
    h.diagram.detach();
    await h.diagram.attach(h.canvas);
    h.frame();
    const pose = h.diagram.getPose();
    const from = h.at(block(2));
    h.drag(from, [from[0] + 61, from[1] + 43]);
    // A move, not a pan: the Space released with the old adapter.
    expect(h.emitted('move')).toHaveLength(1);
    expect(h.diagram.getPose()).toEqual(pose);
  });

  it('draws a wire from an out port to a compatible in port', async () => {
    const h = await loaded({ interaction: 'edit', motion: 'full' });
    const from = h.at(port(0));
    const to = h.at(port(4));
    h.drag(from, to, { hold: true });
    expect(flags(h, port(4)) & (FOCUS_COMPATIBLE | FOCUS_TARGET)).toBe(
      FOCUS_COMPATIBLE | FOCUS_TARGET,
    );
    // The glow pulses and the preview draws.
    expect(h.frame()).toBe(true);
    expect(overlayKinds(h).length).toBeGreaterThan(1);
    expect(new Set(overlayKinds(h))).toEqual(new Set([OVERLAY_PREVIEW]));
    // Each leg starts where the route has run so far, so the dashes carry on around bends.
    const { f32 } = h.renderer.mirrors.overlay;
    let along = 0;
    for (let i = 0; i < overlayKinds(h).length; i++) {
      const at = i * OVERLAY_WORDS;
      expect(f32[at + OVERLAY_ALONG]).toBeCloseTo(along, 3);
      along += Math.hypot(f32[at + 3]! - f32[at + 1]!, f32[at + 4]! - f32[at + 2]!);
    }
    expect(along).toBeGreaterThan(0);

    h.input.emit({
      kind: 'dragEnd',
      sx: to[0],
      sy: to[1],
      clientX: to[0] + LEFT,
      clientY: to[1] + TOP,
      cancelled: false,
    });
    expect(h.emitted('connect')).toEqual([
      {
        from: 0,
        to: { kind: 'port', index: 4 },
        replaces: null,
        point: h.diagram.toDiagram(...client(to)),
        clientX: to[0] + LEFT,
        clientY: to[1] + TOP,
      },
    ]);
    expect(flags(h, port(4)) & (FOCUS_COMPATIBLE | FOCUS_TARGET)).toBe(0);
    expect(h.frame()).toBe(false);
    expect(overlayKinds(h)).toEqual([]);
  });

  it("picks up a wired input's wire and drops it on another input", async () => {
    const h = await loaded({ interaction: 'edit' });
    h.drag(h.at(port(1)), h.at(port(4)));
    expect(h.emitted('connect')).toMatchObject([
      { from: 0, to: { kind: 'port', index: 4 }, replaces: 1 },
    ]);
  });

  it('proposes a wire to nothing when released over empty canvas', async () => {
    const h = await loaded({ interaction: 'edit' });
    const spot = h.empty();
    h.drag(h.at(port(0)), spot);
    expect(h.emitted('connect')).toEqual([
      {
        from: 0,
        to: null,
        replaces: null,
        point: h.diagram.toDiagram(...client(spot)),
        clientX: spot[0] + LEFT,
        clientY: spot[1] + TOP,
      },
    ]);
  });

  it('proposes deleting the selection with Delete', async () => {
    const h = await loaded({ interaction: 'edit' });
    h.tap(...h.at(block(3)));
    expect(h.emitted('select')).toEqual([[block(3)]]);
    expect(h.keys.emit({ kind: 'delete' })).toBe(true);
    expect(h.emitted('delete')).toEqual([[block(3)]]);
  });

  it('cancels a drag with Escape, returning the blocks', async () => {
    const h = await loaded({ interaction: 'edit' });
    const from = h.at(block(2));
    h.drag(from, [from[0] + 80, from[1] + 50], { hold: true });
    expect(h.at(block(2))).not.toEqual(from);
    expect(h.keys.emit({ kind: 'escape' })).toBe(true);
    expect(h.input.cancel).toHaveBeenCalledOnce();
    expect(h.at(block(2))).toEqual(from);
    expect(h.emitted('move')).toEqual([]);
    // With nothing to cancel, Escape clears the selection.
    expect(h.keys.emit({ kind: 'escape' })).toBe(true);
    expect(h.emitted('select')).toEqual([[block(2)], []]);
    expect(h.input.cancel).toHaveBeenCalledOnce();
  });

  it('leaves a pending press alone when Escape clears the selection during a wheel', async () => {
    const h = await loaded({ interaction: 'edit' });
    const at = h.at(block(2));
    h.tap(...at);
    expect(h.emitted('select')).toEqual([[block(2)]]);
    // A mouse press is down when a wheel burst starts; Escape then only clears the selection.
    h.input.emit({
      kind: 'press',
      sx: at[0],
      sy: at[1],
      button: 0,
      pointerType: 'mouse',
      shift: false,
      mod: false,
      targetPx: 8,
    });
    h.input.emit({ kind: 'navigationStart' });
    expect(h.keys.emit({ kind: 'escape' })).toBe(true);
    expect(h.emitted('select')).toEqual([[block(2)], []]);
    expect(h.input.cancel).not.toHaveBeenCalled();
    h.input.emit({ kind: 'navigationEnd' });
    // The press is still pending: its drag moves the block it pressed.
    const to: readonly [number, number] = [at[0] + 40, at[1] + 24];
    h.input.emit({ kind: 'dragStart', sx: at[0], sy: at[1], time: 0 });
    h.input.emit({ kind: 'dragMove', sx: to[0], sy: to[1], dx: 40, dy: 24, time: 16 });
    h.input.emit({
      kind: 'dragEnd',
      sx: to[0],
      sy: to[1],
      clientX: to[0] + LEFT,
      clientY: to[1] + TOP,
      cancelled: false,
    });
    expect(h.emitted('move')).toHaveLength(1);
  });

  it('suppresses hover during a drag and resolves it again after', async () => {
    const h = await loaded({ interaction: 'edit' });
    const from = h.at(block(1));
    h.diagram.setPointer(...client(from));
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(1)]);
    const to: readonly [number, number] = [from[0] + 40, from[1] + 30];
    h.drag(from, to, { hold: true });
    expect(h.emitted('hover')).toEqual([block(1), null]);
    h.diagram.setPointer(...client(to));
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(1), null]);
    h.input.emit({
      kind: 'dragEnd',
      sx: to[0],
      sy: to[1],
      clientX: to[0] + LEFT,
      clientY: to[1] + TOP,
      cancelled: false,
    });
    await h.settle();
    expect(h.emitted('hover')).toEqual([block(1), null, block(1)]);
  });

  it('pans on a navigate drag, opens on a double tap, and fits on Home', async () => {
    const h = await loaded({ motion: 'full' });
    const pose = h.diagram.getPose()!;
    const from = h.at(block(1));
    h.drag(from, [from[0] + 50, from[1] + 20]);
    expect(h.diagram.getPose()!.centerX).toBeCloseTo(pose.centerX - 50 / pose.zoom, 6);
    expect(h.emitted('move')).toEqual([]);
    await h.settle();
    expect(h.emitted('fit')).toEqual([false]);

    const [sx, sy] = h.at(block(1));
    h.tap(sx, sy);
    h.input.emit({ kind: 'doubleTap', sx, sy, targetPx: 8 });
    expect(h.emitted('open')).toEqual([block(1)]);

    expect(h.keys.emit({ kind: 'fit' })).toBe(true);
    const now = performance.now();
    await h.settle({ now });
    await h.settle({ now: now + 1000 });
    expect(h.emitted('fit')).toEqual([false, true]);
    expect(h.diagram.getPose()!.centerX).toBeCloseTo(pose.centerX, 6);
  });

  it('answers a context request with the parts under the pointer', async () => {
    const h = await loaded({ interaction: 'inspect' });
    const [clientX, clientY] = client(h.at(block(2)));
    const event = new MouseEvent('contextmenu', { clientX, clientY });
    h.input.emit({ kind: 'contextmenu', event, keyboard: false });
    expect(h.emitted('contextmenu')).toEqual([
      { event, keyboard: false, clientX, clientY, parts: [block(2)] },
    ]);
  });

  it('walks blocks with Tab, leaving the canvas at the end', async () => {
    const h = await loaded({ interaction: 'inspect' });
    const walked: boolean[] = [];
    for (let i = 0; i < 5; i++) walked.push(h.keys.emit({ kind: 'tab', back: false }));
    expect(walked).toEqual([true, true, true, true, false]);
    expect(h.emitted('select')).toHaveLength(4);
  });
});

describe('the TwoArea example from DIAGRAM.md', () => {
  it('runs verbatim against the harness', async () => {
    const fakes = createFakes();
    const created: Diagram[] = [];
    // The example's imports, bound to the harness: `@latkit/colormaps` is not a dependency of
    // this package (and has no 'vik'), so a diverging stand-in plays its part.
    const createDiagram = (options: Options): Diagram => {
      const diagram = fakes.create(options);
      created.push(diagram);
      return diagram;
    };
    const colormap =
      (_name: 'vik'): Colormap =>
      (t) => [t, 1 - Math.abs(2 * t - 1), 1 - t];
    const canvas = fakes.canvas;
    const t = 0;
    const deviationAt = (_t: number): Float32Array => Float32Array.of(0.25, -0.5, 1);
    const playing = Float32Array.of(1, 1, 1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    // TGOV1 drives pmech, IEEET1 drives efd, GENROU's speed feeds both back.
    const unit: Netlist = {
      blockCount: 3,
      blockKey: ['Genrou/1_1_genrou', 'Tgov1/1_1_tgov1', 'Ieeet1/1_1_ieeet1'],
      blockTitle: ['GENROU', 'TGOV1', 'IEEET1'],
      portStart: Uint32Array.of(0, 3, 5, 7),
      portFlow: Uint8Array.of(0, 0, 1, /* tgov1 */ 0, 1, /* ieeet1 */ 0, 1),
      portLabel: ['pmech', 'efd', 'speed', 'speed', 'pmech', 'speed', 'efd'],
      netStart: Uint32Array.of(0, 2, 4, 7),
      netPorts: Uint32Array.of(4, 0, /* efd */ 6, 1, /* speed */ 2, 3, 5),
      netLabel: ['1_1_pmech', '1_1_efd', '1_1_speed'],
    };

    const diagram = createDiagram({ interaction: 'edit', gridPitch: 8, colormap: colormap('vik') });
    diagram.load(unit); // laid out: controllers feed GENROU, the speed loop returns underneath
    diagram.on('connect', ({ from, to }) => console.log(`wire from port ${from} to`, to));
    await diagram.attach(canvas);

    // During playback: each signal's deviation from its initial value, normalized per signal.
    diagram.setChannel('netColor', deviationAt(t), [-1, 1]);
    diagram.setChannel('netFlow', playing);

    try {
      const loop = fakes.loops[0]!;
      const renderer = fakes.renderers[0]!;
      // Dashes march: frames keep coming.
      expect(loop.frame()).toBe(true);
      expect(renderer.last).toMatchObject({ blocks: 3, ports: 7, groups: 0 });
      expect(diagram.getChannelDomain('netColor')).toEqual([-1, 1]);

      const x = (b: number): number => diagram.locate(block(b))![0];
      expect(x(1)).toBeLessThan(x(0));
      expect(x(2)).toBeLessThan(x(0));

      // Pick up GENROU's efd wire and let go over empty canvas: a reconnect to nothing.
      const at = (part: Part): readonly [number, number] => {
        const [cx, cy] = diagram.locate(part)!;
        return [cx - LEFT, cy - TOP];
      };
      let spot: readonly [number, number] | null = null;
      for (let sy = 60; sy < HEIGHT - 60 && !spot; sy += 10) {
        for (let sx = 60; sx < WIDTH - 60 && !spot; sx += 10) {
          if (diagram.hitTest(sx + LEFT, sy + TOP, 24).length === 0) spot = [sx, sy];
        }
      }
      const [sx, sy] = at(port(1));
      const [ex, ey] = spot!;
      const input = fakes.gestures[0]!;
      input.emit({
        kind: 'press',
        sx,
        sy,
        button: 0,
        pointerType: 'mouse',
        shift: false,
        mod: false,
        targetPx: 8,
      });
      input.emit({ kind: 'dragStart', sx, sy, time: 0 });
      input.emit({ kind: 'dragMove', sx: ex, sy: ey, dx: ex - sx, dy: ey - sy, time: 16 });
      input.emit({
        kind: 'dragEnd',
        sx: ex,
        sy: ey,
        clientX: ex + LEFT,
        clientY: ey + TOP,
        cancelled: false,
      });
      expect(log).toHaveBeenCalledWith('wire from port 6 to', null);
    } finally {
      for (const each of created) each.destroy();
    }
  });
});
