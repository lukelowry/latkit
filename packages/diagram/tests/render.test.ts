import { renderer as snapshotRenderer } from '../../gpu/tests/fixtures/public-render.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createData } from '@latkit/model';
import { createGpu, createComposition, kit } from '@latkit/gpu';
import { createDiagram, type Diagram } from '../src/diagram.js';
import type { Controls } from '../src/input.js';
import type { DragDraw } from '../src/drag.js';
import { Source, data, vertex as vertexOf } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';
function device() {
  const fake = fakeDevice();
  fake.device.createPipelineLayout = vi.fn(() => ({}) as GPUPipelineLayout);
  fake.device.createRenderPipelineAsync = vi.fn(() =>
    Promise.resolve({ getBindGroupLayout: () => ({}) } as unknown as GPURenderPipeline),
  );
  const original = fake.device.createCommandEncoder.bind(fake.device);
  fake.device.createCommandEncoder = vi.fn(() => {
    const encoder = original();
    encoder.beginRenderPass = vi.fn(
      () =>
        ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          draw: vi.fn(),
          end: vi.fn(),
          setViewport: vi.fn(),
        }) as unknown as GPURenderPassEncoder,
    );
    encoder.beginComputePass = vi.fn(
      () =>
        ({
          setPipeline: vi.fn(),
          setBindGroup: vi.fn(),
          dispatchWorkgroups: vi.fn(),
          end: vi.fn(),
        }) as unknown as GPUComputePassEncoder,
    );
    return encoder;
  });
  return fake;
}
/** Whether a write since the last clear holds this value for every task: a style page's field. */
function wrote(fake: ReturnType<typeof device>, count: number, value: number): boolean {
  return fake.queue.writeBuffer.mock.calls.some(([, , data]) => {
    const bytes = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
    const floats = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~3)),
    );
    return floats.filter((v) => v === value).length >= count;
  });
}
/** What input drives, without a canvas. */
const interaction = (diagram: Diagram) => (diagram as unknown as { controls: Controls }).controls;
/** The drag the latest frame drew over its scene. */
const dragOf = (diagram: Diagram) =>
  (diagram as unknown as { shown?: { drag?: DragDraw } }).shown?.drag;
const animating = (diagram: Diagram) => kit.rendererOf(diagram).animating;
const presentedOf = (diagram: Diagram) =>
  (
    diagram as unknown as {
      shown: {
        scene: import('../src/scene.js').Scene;
        picking: import('../src/picking.js').Picking;
        widthPx: number;
        camera: kit.Camera2D;
        viewport: import('@latkit/gpu').Viewport;
      };
    }
  ).shown;
async function fixture() {
  const fake = device(),
    source = new Source();
  const gpu = await createGpu({
    device: fake.device,
    text: {
      rasterizer: {
        rasterize: (input) =>
          Promise.resolve({
            advance: input.text.length * 0.6,
            ascent: 0.8,
            descent: 0.2,
            width: 8,
            height: 8,
            left: 0,
            top: -0.8,
            coverage: new Uint8Array(64).fill(255),
          }),
      },
    },
  });
  const target = kit.createTextureTarget(gpu, { width: 800, height: 600 }),
    diagram = createDiagram(gpu, data(source));
  const draw = () =>
    gpu.render({ views: [{ renderer: kit.rendererOf(diagram), target }], timeMs: 0 });
  return { fake, source, gpu, target, diagram, draw };
}
/** Each task's load, sampled at coordinates 0 and 1. */
function load(source: Source) {
  const n = source.count;
  return createData(
    {
      axis: { name: 'time' },
      types: { Task: { fields: { load: { type: 'float32', sampled: true } } } },
    },
    [
      {
        kind: 'samples',
        index: source.index('Task'),
        rows: { kind: 'range', offset: 0, count: n },
        firstFrame: 0,
        coordinates: Float64Array.of(0, 1),
        columns: {
          load: {
            kind: 'numeric',
            offset: 0,
            length: n * 2,
            values: Float32Array.from({ length: n * 2 }, (_, i) => (i < n ? 0.25 : 0.75)),
            rowStride: 1,
            frameStride: n,
          },
        },
      },
    ],
  );
}
afterEach(() => vi.restoreAllMocks());
it('restyles widths without reads, geometry uploads, or stale hit-test radii', async () => {
  const f = await fixture();
  try {
    f.diagram.set({ labels: false, edgeWidthPx: 1 });
    await f.draw();
    await f.gpu.idle();
    const before = presentedOf(f.diagram),
      counts = f.gpu.stats();
    const edge = before.scene.edges[0];
    const segments = edge.paths
      .flatMap((path) => path.slice(1).map((b, i) => ({ a: path[i], b })))
      .sort(
        (u, v) =>
          Math.hypot(v.b[0] - v.a[0], v.b[1] - v.a[1]) -
          Math.hypot(u.b[0] - u.a[0], u.b[1] - u.a[1]),
      );
    const { a, b } = segments[0];
    const point = kit.cameraPoint(
      before.camera,
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      before.viewport,
    );
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const beside: readonly [number, number] = [
      point[0] - ((b[1] - a[1]) / length) * 5,
      point[1] + ((b[0] - a[0]) / length) * 5,
    ];
    const hits = () => {
      const p = presentedOf(f.diagram);
      return p.picking
        .hit(beside, p.camera, p.viewport, 0, true, undefined, p.widthPx)
        .some((item) => item.kind === 'edge' && item.row === edge.hit.row);
    };
    expect(hits()).toBe(false);
    f.diagram.set({ edgeWidthPx: 16, vertexBaseColor: [0.2, 0.4, 0.6, 1] });
    expect(hits()).toBe(false); // Pending configuration cannot change presented picking.
    await f.draw();
    await f.gpu.idle();
    const after = presentedOf(f.diagram);
    expect(after.scene).toBe(before.scene);
    expect(after.picking).toBe(before.picking);
    expect(hits()).toBe(true);
    expect(f.gpu.stats().queries).toBe(counts.queries);
    expect(f.gpu.stats().queryHits).toBe(counts.queryHits);
    expect(f.gpu.stats().uploadedBytes - counts.uploadedBytes).toBeLessThan(4096);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('reroutes clearance changes without rereading fields or changing accepted positions', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const before = presentedOf(f.diagram),
      counts = f.gpu.stats();
    f.diagram.set({ routeClearance: 32 });
    await f.draw();
    const after = presentedOf(f.diagram);
    expect(after.scene).not.toBe(before.scene);
    expect(after.scene.vertices.map(({ x, y }) => [x, y])).toEqual(
      before.scene.vertices.map(({ x, y }) => [x, y]),
    );
    expect(f.gpu.stats().queries).toBe(counts.queries);
    expect(f.gpu.stats().queryHits).toBe(counts.queryHits);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('keeps structural geometry when identical data is republished and reacquires evicted uploads', async () => {
  const f = await fixture();
  try {
    await f.draw();
    await f.gpu.idle();
    const before = presentedOf(f.diagram);
    f.source.update();
    f.diagram.set({ source: f.source.data });
    await f.draw();
    await f.gpu.idle();
    expect(presentedOf(f.diagram).scene).toBe(before.scene);
    expect(presentedOf(f.diagram).picking).toBe(before.picking);
    f.gpu.trim();
    const uploads = f.gpu.stats().uploads;
    await f.draw();
    expect(f.gpu.stats().uploads).toBeGreaterThan(uploads);
    expect(presentedOf(f.diagram).scene).toBe(before.scene);
    expect(f.diagram.locate(vertexOf(f.source, 'n0'))).not.toBeNull();
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('renders through the unified owner and publishes picking after submission', async () => {
  const f = await fixture();
  try {
    expect(f.diagram.locate(vertexOf(f.source, 'n0'))).toBeNull();
    await f.draw();
    const point = f.diagram.locate(vertexOf(f.source, 'n0'))!;
    expect((await f.diagram.pick(point))[0]).toMatchObject({ kind: 'vertex', id: 'n0', row: 0 });
    expect(f.diagram.stats().frames).toBe(1);
    expect(f.fake.queue.submit).toHaveBeenCalledTimes(1);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('reuses geometry and uploads on camera and focus changes', async () => {
  const f = await fixture();
  try {
    await f.draw();
    await f.gpu.idle();
    const reads = f.source.queries;
    const before = f.gpu.stats().uploadedBytes;
    interaction(f.diagram).pan(10, 20);
    await f.draw();
    await f.gpu.idle();
    expect(f.source.queries).toBe(reads);
    // Uniforms change, but the geometry and text are resident.
    expect(f.gpu.stats().uploadedBytes - before).toBeLessThan(4096);
    f.diagram.select([vertexOf(f.source, 'n0')]);
    await f.draw();
    expect(f.source.queries).toBe(reads);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('preserves presented picking when a sibling fails to encode', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const before = f.diagram.locate(vertexOf(f.source, 'n0'));
    interaction(f.diagram).pan(100, 0);
    const bad = {
      ...snapshotRenderer(
        () => Promise.resolve(),
        () => {
          throw new Error('sibling failed');
        },
      ),
    };
    const target = kit.createTextureTarget(f.gpu, { width: 10, height: 10 });
    await expect(
      f.gpu.render({
        views: [
          { renderer: kit.rendererOf(f.diagram), target: f.target },
          { renderer: bad, target },
        ],
        timeMs: 0,
      }),
    ).rejects.toThrow('sibling failed');
    expect(f.diagram.locate(vertexOf(f.source, 'n0'))).toEqual(before);
    target.destroy();
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('keeps drag previews separate from accepted positions', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const ref = vertexOf(f.source, 'n0'),
      api = interaction(f.diagram),
      accepted = api.scene()!;
    const before = accepted.vertices[0].x,
      at = f.diagram.locate(ref)!,
      scale = f.diagram.camera.scale;
    api.preview([ref], [24, 0]);
    await f.draw();
    // The preview draws over the accepted scene and leaves it as it is; locate follows the drag.
    expect(api.scene()).toBe(accepted);
    expect(f.diagram.locate(ref)![0]).toBeCloseTo(at[0] + 24 * scale);
    api.preview([ref], [40, 0]);
    await f.draw();
    expect(f.diagram.locate(ref)![0]).toBeCloseTo(at[0] + 40 * scale);
    api.preview([], null);
    await f.draw();
    expect(f.diagram.locate(ref)).toEqual(at);
    expect(api.scene()!.vertices[0].x).toBe(before);
    const move = api.move([ref], [24, 8])!;
    expect(move.moves[0].position).toEqual([before + 24, api.scene()!.vertices[0].y + 8]);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('supports composition and independent renderer views', async () => {
  const f = await fixture();
  const second = createDiagram(f.gpu, data(f.source)),
    composed = createComposition(f.gpu, {
      views: [
        { view: f.diagram, region: [0, 0, 0.5, 1] },
        { view: second, region: [0.5, 0, 0.5, 1] },
      ],
    });
  try {
    await f.gpu.render({
      views: [{ renderer: kit.rendererOf(composed), target: f.target }],
      timeMs: 0,
    });
    expect(second.stats().frames).toBe(1);
  } finally {
    composed.destroy();
    second.destroy();
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('leaves application data usable after releasing GPU resources', async () => {
  const f = await fixture();
  await f.draw();
  const value = f.source.data;
  f.diagram.destroy();
  f.diagram.destroy();
  f.target.destroy();
  f.gpu.destroy();
  expect(f.source.data).toBe(value);
  expect(Object.keys(value.tables).length).toBeGreaterThan(0);
});

it('accepts sparse movement without moving uncovered vertices', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const api = interaction(f.diagram),
      before = api.scene()!.vertices.map((n) => [n.x, n.y]);
    const proposal = api.move([vertexOf(f.source, 'n0')], [0, 24])!;
    f.diagram.set({ vertices: { Task: { position: proposal.positions.Task } } });
    await f.draw();
    expect(
      api
        .scene()!
        .vertices.slice(1)
        .map((n) => [n.x, n.y]),
    ).toEqual(before.slice(1));
    expect(api.scene()!.vertices[0].y).toBe(before[0][1] + 24);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('patches movement buffers and keeps shaped text resident', async () => {
  const f = await fixture();
  try {
    await f.draw();
    await f.gpu.idle();
    const before = f.gpu.stats(),
      reads = f.source.queries,
      api = interaction(f.diagram);
    api.preview([vertexOf(f.source, 'n0')], [0, 8]);
    await f.draw();
    await f.gpu.idle();
    expect(f.source.queries).toBe(reads);
    expect(f.gpu.stats().uploadedBytes - before.uploadedBytes).toBeLessThan(4096);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});

it('moves nested collapsed groups without losing routes or accumulating geometry', async () => {
  const f = await fixture();
  try {
    f.diagram.set({
      ...data(f.source),
      groups: {
        outer: { label: 'Outer', vertices: {}, collapsed: true },
        inner: {
          label: 'Inner',
          parent: 'outer',
          vertices: { Task: { kind: 'ids', ids: ['n0', 'n1'] } },
        },
      },
    });
    await f.draw();
    const api = interaction(f.diagram),
      base = api.scene()!;
    const bounds = [...base.groups.find((g) => g.id === 'outer')!.bounds];
    const refs = [{ kind: 'group' as const, id: 'outer' }, vertexOf(f.source, 'n0')];
    expect(api.move(refs, [0, 24])!.moves).toHaveLength(2);
    api.preview(refs, [0, 24]);
    await f.draw();
    // The groups move with their vertices, and the wires leaving them reroute where they go; the
    // accepted scene stays as it is, so no geometry accumulates.
    const drag = dragOf(f.diagram)!;
    expect(api.scene()).toBe(base);
    expect([...drag.marks.groups].sort()).toEqual(['inner', 'outer']);
    expect(base.vertices.map((vertex) => vertex.visible)).toEqual([false, false, true, true]);
    const wire = drag.wires.find((w) => w.edge === base.edges[1])!;
    expect(wire.paths.length).toBeGreaterThan(0);
    // The wire now leaves the group's box where the drag has taken it.
    expect(
      wire.paths.some((path) =>
        path.some((p) => p[1] >= bounds[1] + 24 - 1e-9 && p[1] <= bounds[3] + 24 + 1e-9),
      ),
    ).toBe(true);
    api.preview(refs, [0, 48]);
    await f.draw();
    expect(dragOf(f.diagram)!.delta).toEqual([0, 48]);
    expect(api.scene()).toBe(base);
    api.preview([], null);
    await f.draw();
    expect(dragOf(f.diagram)).toBeUndefined();
    expect(api.scene()!.groups.find((g) => g.id === 'outer')!.bounds).toEqual(bounds);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('preserves surviving selection and removes deleted identities only after submission', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const refs = [0, 3].map((n) => vertexOf(f.source, 'n' + n));
    f.diagram.select(refs);
    const changes = vi.fn();
    f.diagram.on('select', changes);
    f.diagram.set(data(new Source(2)));
    expect(interaction(f.diagram).selection()).toEqual(refs);
    await f.draw();
    await Promise.resolve();
    expect(interaction(f.diagram).selection()).toEqual(refs.slice(0, 1));
    expect(changes).toHaveBeenCalledWith(refs.slice(0, 1));
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});

it('invalidates routes when shapes, port anchors, or routing clearance change', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const api = interaction(f.diagram);
    const original = api.scene()!.edges[0].paths;
    f.diagram.set({ vertices: { Task: { shape: 'diamond' } } });
    await f.draw();
    const changed = api.scene()!;
    expect(changed.edges[0].paths).not.toBe(original);
    const output = changed.vertices[0].ports.find((port) => port.name === 'output')!;
    const end = output.position.map((v, i) => v + (output.normal[i] * changed.portSize!) / 2);
    expect(
      changed.edges[0].paths.flat().some((point) => point[0] === end[0] && point[1] === end[1]),
    ).toBe(true);
    f.diagram.set({
      vertices: {
        Task: { shape: 'rounded', ports: { input: { side: 'right' }, output: { side: 'left' } } },
      },
    });
    await f.draw();
    const rewired = api.scene()!;
    for (const edge of rewired.edges)
      for (const end of edge.ends) {
        const port = rewired.vertices[end.vertex].ports.find((p) => p.name === end.port)!;
        expect(
          edge.paths
            .flat()
            .some(
              (point) =>
                point[0] === port.position[0] + (port.normal[0] * rewired.portSize!) / 2 &&
                point[1] === port.position[1] + (port.normal[1] * rewired.portSize!) / 2,
            ),
        ).toBe(true);
      }
    const before = rewired.edges[0].paths;
    f.diagram.set({ routeClearance: 32 });
    await f.draw();
    expect(api.scene()!.edges[0].paths).not.toBe(before);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});

it('updates uniform-only presentation without querying or rebuilding geometry', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const reads = f.source.queries,
      scene = interaction(f.diagram).scene();
    f.diagram.set({
      grid: false,
      gridMinSpacingPx: 18,
      selectedColor: [0.3, 0.6, 1, 1],
      outlineWidthPx: 2,
      detail: 'full',
    });
    await f.draw();
    expect(f.source.queries).toBe(reads);
    expect(interaction(f.diagram).scene()).toBe(scene);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('animates accepted positions with coherent picking and one native read per revision', async () => {
  const f = await fixture();
  const render = (timeMs: number) =>
    f.gpu.render({ views: [{ renderer: kit.rendererOf(f.diagram), target: f.target }], timeMs });
  try {
    f.diagram.set({ animationMs: 200, motion: 'full' });
    f.diagram.set(data(f.source, true));
    await render(0);
    f.diagram.set({ camera: { fit: false } });
    const ref = vertexOf(f.source, 'n0');
    const before = interaction(f.diagram).scene()!.vertices[0].y;
    f.source.xy[1] += 80;
    f.source.update();
    f.diagram.set({ source: f.source.data });
    f.diagram.set(data(f.source, true), { animate: true });
    await render(20);
    const reads = f.source.queries;
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(before);
    await render(120);
    const vertex = interaction(f.diagram).scene()!.vertices[0];
    expect(vertex.y).toBeGreaterThan(before);
    expect(vertex.y).toBeLessThan(before + 80);
    expect(
      (await f.diagram.pick(f.diagram.locate(ref)!)).some(
        (hit) => hit.kind === 'vertex' && hit.row === 0,
      ),
    ).toBe(true);
    await render(220);
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(before + 80);
    expect(f.source.queries).toBe(reads);
    expect(animating(f.diagram)).toBe(false);
    f.diagram.set({ motion: 'reduce' });
    f.source.xy[1] += 80;
    f.source.update();
    f.diagram.set({ source: f.source.data });
    f.diagram.set(data(f.source, true), { animate: true });
    await render(240);
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(before + 160);
    expect(animating(f.diagram)).toBe(false);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});

it('exports a transition at its target positions without starting or ending it', async () => {
  const f = await fixture();
  const render = (timeMs: number, presented = true) =>
    f.gpu.render({
      views: [{ renderer: kit.rendererOf(f.diagram), target: f.target, presented }],
      timeMs,
    });
  try {
    f.diagram.set({ animationMs: 200, motion: 'full' });
    f.diagram.set(data(f.source, true));
    await render(0);
    f.diagram.set({ camera: { fit: false } });
    const shown = () => interaction(f.diagram).scene()!.vertices[0].y,
      before = shown();
    f.source.xy[1] += 80;
    f.source.update();
    f.diagram.set({ source: f.source.data });
    f.diagram.set(data(f.source, true), { animate: true });
    await render(20, false);
    expect(shown()).toBe(before);
    expect(animating(f.diagram)).toBe(false);
    // The first presented frame starts the transition the export left waiting.
    await render(20);
    expect(shown()).toBe(before);
    expect(animating(f.diagram)).toBe(true);
    await render(120, false);
    expect(shown()).toBe(before);
    await render(120);
    expect(shown()).toBeGreaterThan(before);
    expect(shown()).toBeLessThan(before + 80);
    await render(220);
    expect(shown()).toBe(before + 80);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});

it('restores accepted positions when a drag interrupts and cancels a layout transition', async () => {
  const f = await fixture();
  const render = (timeMs: number) =>
    f.gpu.render({ views: [{ renderer: kit.rendererOf(f.diagram), target: f.target }], timeMs });
  try {
    const api = interaction(f.diagram),
      ref = vertexOf(f.source, 'n0');
    f.diagram.set({ motion: 'full', animationMs: 200 });
    f.diagram.set(data(f.source, true));
    await render(0);
    f.source.xy[1] = 80;
    f.source.update();
    f.diagram.set({ source: f.source.data });
    f.diagram.set(data(f.source, true), { animate: true });
    await render(20);
    await render(100);
    api.preview([ref], [0, 8]);
    await render(120);
    api.preview([], null);
    await render(140);
    expect(api.scene()!.vertices[0].y).toBe(80);
    expect(animating(f.diagram)).toBe(false);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('settles immediately when animation is disabled or above its configured size limit', async () => {
  const f = await fixture();
  try {
    f.diagram.set(data(f.source, true));
    await f.draw();
    f.diagram.set({ animationMaxVertices: 2, motion: 'full', animationMs: 0 });
    f.diagram.fit(undefined, { animate: true });
    await f.draw();
    expect(Number.isFinite(f.diagram.camera.scale)).toBe(true);
    f.diagram.set({ animationMs: 200 });
    f.source.xy[1] = 80;
    f.source.update();
    f.diagram.set({ source: f.source.data });
    f.diagram.set(data(f.source, true), { animate: true });
    await f.draw();
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(80);
    expect(animating(f.diagram)).toBe(false);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('merges layout shorthands and camera patches, and reports the presented camera', async () => {
  const f = await fixture();
  try {
    const cameras = vi.fn();
    f.diagram.on('camera', cameras);
    f.diagram.set({ layout: 'layered' });
    f.diagram.set({ layout: { direction: 'down' } });
    expect(f.diagram.config.layout).toEqual({ algorithm: 'layered', direction: 'down' });
    await f.draw();
    await Promise.resolve();
    expect(cameras).toHaveBeenLastCalledWith(expect.objectContaining({ fit: true }));
    f.diagram.set({ camera: { scale: 2 } });
    expect(f.diagram.camera.fit).toBe(false);
    await f.draw();
    await Promise.resolve();
    expect(cameras).toHaveBeenLastCalledWith(expect.objectContaining({ scale: 2, fit: false }));
    f.diagram.set({ camera: null });
    await f.draw();
    expect(f.diagram.camera.fit).toBe(true);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('fits items once and follows all the data otherwise', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const all = f.diagram.camera;
    expect(all.fit).toBe(true);
    f.diagram.fit([vertexOf(f.source, 'n0')]);
    await f.draw();
    expect(f.diagram.camera.fit).toBe(false);
    expect(f.diagram.camera.scale).toBeGreaterThan(all.scale);
    f.diagram.fit([]);
    expect(f.diagram.camera.fit).toBe(true);
    await f.draw();
    expect(f.diagram.camera).toEqual(all);
    f.diagram.set({ camera: { center: [10, 10] } });
    expect(f.diagram.camera.fit).toBe(false);
    f.diagram.set({ camera: null });
    expect(f.diagram.camera.fit).toBe(true);
    expect(() => f.diagram.set({ camera: { scale: 0 } })).toThrow('camera scale');
    expect(() => f.diagram.set({ camera: { zoom: 2 } as never })).toThrow('Unknown camera');
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('expands field shorthands in entries and their ports', async () => {
  const f = await fixture();
  try {
    f.diagram.set({
      vertices: { Task: { color: 'weight', ports: { input: { color: 'weight', side: 'top' } } } },
      edges: { Dependency: { widthPx: 'weight' } },
    });
    const task = f.diagram.config.vertices.Task;
    expect(task.color).toEqual({ field: 'weight' });
    expect(task.ports?.input.color).toEqual({ field: 'weight' });
    expect(task.ports?.input.side).toBe('top');
    expect(f.diagram.config.edges?.Dependency.widthPx).toEqual({ field: 'weight' });
    await f.draw();
    // Wires pick within the widest a bound width draws.
    expect(presentedOf(f.diagram).widthPx).toBe(4);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('shares the view style, stats, and limits', async () => {
  const f = await fixture();
  try {
    f.diagram.set({ selectedWidthPx: 4, background: [0, 0, 0, 1], selectedColor: null });
    await f.draw();
    expect(f.diagram.stats()).toMatchObject({ frames: 1, hover: 'idle', hoverMs: 0 });
    expect(f.diagram.stats().pickingBytes).toBeGreaterThan(0);
    expect(() => f.diagram.set({ selectionWidthPx: 2 } as never)).toThrow('Unknown diagram option');
    expect(() => f.diagram.set({ backgroundColor: [0, 0, 0, 1] } as never)).toThrow(
      'Unknown diagram option',
    );
    expect(() => f.diagram.set({ limits: { prepareMs: 1 } } as never)).toThrow(
      'Unknown diagram limit',
    );
    expect(() => f.diagram.set({ input: { dragThresholdPx: -1 } })).toThrow('dragThresholdPx');
    expect(() => f.diagram.set({ input: { dragHandle: 1 } as never })).toThrow(
      'Unknown input option',
    );
    expect(() => f.diagram.set({ input: { mode: 'drag' } as never })).toThrow(
      'Unsupported input mode',
    );
    f.diagram.set({ input: 'edit' });
    expect(f.diagram.config.input).toEqual({ mode: 'edit' });
    f.diagram.set({ limits: { layoutMs: 1000 } });
    expect(f.diagram.config.limits).toEqual({ layoutMs: 1000 });
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('restyles at a new coordinate on the GPU, rereading the scene only for sampled structure', async () => {
  const f = await fixture();
  const render = (at: number) => {
    f.fake.queue.writeBuffer.mockClear();
    return f.gpu.render({
      views: [{ renderer: kit.rendererOf(f.diagram), target: f.target, at }],
      timeMs: 0,
    });
  };
  try {
    await render(0);
    const still = interaction(f.diagram).scene();
    await render(1);
    expect(interaction(f.diagram).scene()).toBe(still);
    f.diagram.set({
      vertices: { Task: { shade: { source: load(f.source), from: 'Task', field: 'load' } } },
    });
    await render(0);
    const before = interaction(f.diagram).scene()!;
    expect(wrote(f.fake, f.source.count, 0.25)).toBe(true);
    await render(1);
    expect(interaction(f.diagram).scene()).toBe(before);
    expect(wrote(f.fake, f.source.count, 0.75)).toBe(true);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});

it('freezes sampled structure throughout a drag while its styles play on', async () => {
  const f = await fixture();
  const render = (at: number) => {
    f.fake.queue.writeBuffer.mockClear();
    return f.gpu.render({
      views: [{ renderer: kit.rendererOf(f.diagram), target: f.target, at }],
      timeMs: 0,
    });
  };
  try {
    const field = { source: load(f.source), from: 'Task', field: 'load' };
    f.diagram.set({ vertices: { Task: { visible: field, shade: field } } });
    await render(0);
    const before = presentedOf(f.diagram);
    interaction(f.diagram).preview([before.scene.vertices[0].hit], [8, 0]);
    await render(1);
    expect(presentedOf(f.diagram).scene).toBe(before.scene);
    expect(wrote(f.fake, f.source.count, 0.75)).toBe(true);
    interaction(f.diagram).preview([], null);
    await render(1);
    expect(presentedOf(f.diagram).scene).not.toBe(before.scene);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
