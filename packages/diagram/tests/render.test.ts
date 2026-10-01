import { afterEach, expect, it, vi } from 'vitest';
import { createGpu, createRenderTarget, createComposition } from '@latkit/gpu';
import { createDiagram, interaction } from '../src/diagram.js';
import { Source, data } from './fixture.js';
import { fakeDevice } from '../../gpu/tests/fixtures/device.js';
function device() {
  const fake = fakeDevice();
  fake.device.createShaderModule = vi.fn(
    () =>
      ({
        getCompilationInfo: () => Promise.resolve({ messages: [] }),
      }) as unknown as GPUShaderModule,
  );
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
    return encoder;
  });
  return fake;
}
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
  const target = createRenderTarget({ gpu, width: 800, height: 600 }),
    diagram = createDiagram({ gpu, data: data(source) });
  const draw = () => gpu.render({ views: [{ renderer: diagram, target }], timeMs: 0 });
  return { fake, source, gpu, target, diagram, draw };
}
afterEach(() => vi.restoreAllMocks());
it('renders through the unified owner and publishes picking after submission', async () => {
  const f = await fixture();
  try {
    expect(f.diagram.locate({ kind: 'vertex', type: 'Task', id: 'n0' })).toBeNull();
    await f.draw();
    const point = f.diagram.locate({ kind: 'vertex', type: 'Task', id: 'n0' })!;
    expect(f.diagram.hitTest(point)[0]).toMatchObject({ kind: 'vertex', id: 'n0', row: 0 });
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
    f.diagram.panBy(10, 20);
    await f.draw();
    await f.gpu.idle();
    expect(f.source.queries).toBe(reads);
    // Uniforms change, but the geometry and text are resident.
    expect(f.gpu.stats().uploadedBytes - before).toBeLessThan(4096);
    f.diagram.select([{ kind: 'vertex', type: 'Task', id: 'n0' }]);
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
    const before = f.diagram.locate({ kind: 'vertex', type: 'Task', id: 'n0' });
    f.diagram.panBy(100, 0);
    const bad = {
      prepare: () => Promise.resolve(),
      encode() {
        throw new Error('sibling failed');
      },
      destroy() {},
    };
    const target = createRenderTarget({ gpu: f.gpu, width: 10, height: 10 });
    await expect(
      f.gpu.render({
        views: [
          { renderer: f.diagram, target: f.target },
          { renderer: bad, target },
        ],
        timeMs: 0,
      }),
    ).rejects.toThrow('sibling failed');
    expect(f.diagram.locate({ kind: 'vertex', type: 'Task', id: 'n0' })).toEqual(before);
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
    const ref = { kind: 'vertex' as const, type: 'Task', id: 'n0' },
      api = interaction(f.diagram);
    const before = api.scene()!.vertices[0].x;
    api.preview([ref], [24, 0]);
    await f.draw();
    expect(api.scene()!.vertices[0].x).toBe(before + 24);
    api.preview([ref], [40, 0]);
    await f.draw();
    expect(api.scene()!.vertices[0].x).toBe(before + 40);
    api.preview([], null);
    await f.draw();
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
  const second = createDiagram({ gpu: f.gpu, data: data(f.source) }),
    composed = createComposition({
      gpu: f.gpu,
      views: [
        { renderer: f.diagram, region: { x: 0, y: 0, width: 0.5, height: 1 } },
        { renderer: second, region: { x: 0.5, y: 0, width: 0.5, height: 1 } },
      ],
    });
  try {
    await f.gpu.render({ views: [{ renderer: composed, target: f.target }], timeMs: 0 });
    expect(second.stats().frames).toBe(1);
  } finally {
    composed.destroy();
    second.destroy();
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('releases subscriptions and never closes borrowed sources', async () => {
  const f = await fixture();
  await f.draw();
  const close = vi.spyOn(f.source, 'close');
  f.diagram.destroy();
  f.diagram.destroy();
  f.target.destroy();
  f.gpu.destroy();
  expect(close).not.toHaveBeenCalled();
  expect(f.source.listeners.size).toBe(0);
});

it('accepts sparse movement without moving uncovered vertices', async () => {
  const f = await fixture();
  try {
    await f.draw();
    const api = interaction(f.diagram),
      before = api.scene()!.vertices.map((n) => [n.x, n.y]);
    const proposal = api.move([{ kind: 'vertex', type: 'Task', id: 'n0' }], [0, 24])!;
    f.diagram.setVertex('Task', { position: proposal.positions.Task });
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
    api.preview([{ kind: 'vertex', type: 'Task', id: 'n0' }], [0, 8]);
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
    f.diagram.setData({
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
    const refs = [
      { kind: 'group' as const, id: 'outer' },
      { kind: 'vertex' as const, type: 'Task', id: 'n0' },
    ];
    expect(api.move(refs, [0, 24])!.moves).toHaveLength(2);
    api.preview(refs, [0, 24]);
    await f.draw();
    const moved = api.scene()!,
      box = moved.groups.find((g) => g.id === 'outer')!.bounds;
    expect(box[0]).toBe(bounds[0]);
    expect(box[1]).toBe(bounds[1] + 24);
    expect(moved.vertices.map((vertex) => vertex.visible)).toEqual([false, false, true, true]);
    expect(moved.edges[1].paths.length).toBeGreaterThan(0);
    expect(moved.bytes - moved.routeBytes).toBe(base.bytes - base.routeBytes);
    api.preview(refs, [0, 48]);
    await f.draw();
    expect(api.scene()!.vertices[0].y).toBe(base.vertices[0].y + 48);
    api.preview([], null);
    await f.draw();
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
    const refs = [0, 3].map((n) => ({ kind: 'vertex' as const, type: 'Task', id: 'n' + n }));
    f.diagram.select(refs);
    const changes = vi.fn();
    f.diagram.on('select', changes);
    f.diagram.setData(data(new Source(2)));
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
    f.diagram.setVertex('Task', { shape: 'diamond' });
    await f.draw();
    const changed = api.scene()!;
    expect(changed.edges[0].paths).not.toBe(original);
    const end = changed.vertices[0].ports.find((port) => port.name === 'output')!.position;
    expect(
      changed.edges[0].paths.flat().some((point) => point[0] === end[0] && point[1] === end[1]),
    ).toBe(true);
    f.diagram.setVertex('Task', {
      shape: 'rounded',
      ports: { input: { side: 'right' }, output: { side: 'left' } },
    });
    await f.draw();
    const rewired = api.scene()!;
    for (const edge of rewired.edges)
      for (const end of edge.ends) {
        const port = rewired.vertices[end.vertex].ports.find((p) => p.name === end.port)!;
        expect(
          edge.paths
            .flat()
            .some((point) => point[0] === port.position[0] && point[1] === port.position[1]),
        ).toBe(true);
      }
    const before = rewired.edges[0].paths;
    f.diagram.setOptions({ routeClearance: 32 });
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
    f.diagram.setOptions({
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
    f.gpu.render({ views: [{ renderer: f.diagram, target: f.target }], timeMs });
  try {
    f.diagram.setOptions({ animationMs: 200, motion: 'full' });
    f.diagram.setData(data(f.source, true));
    await render(0);
    f.diagram.setCamera(f.diagram.getCamera()!);
    const ref = { kind: 'vertex' as const, type: 'Task', id: 'n0' };
    const before = interaction(f.diagram).scene()!.vertices[0].y;
    f.source.xy[1] += 80;
    f.source.update();
    f.diagram.setData(data(f.source, true), { animate: true });
    await render(20);
    const reads = f.source.queries;
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(before);
    await render(120);
    const vertex = interaction(f.diagram).scene()!.vertices[0];
    expect(vertex.y).toBeGreaterThan(before);
    expect(vertex.y).toBeLessThan(before + 80);
    expect(f.diagram.hitTest(f.diagram.locate(ref)!).some((hit) => hit.id === 'n0')).toBe(true);
    await render(220);
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(before + 80);
    expect(f.source.queries).toBe(reads);
    expect(f.diagram.animating).toBe(false);
    f.diagram.setOptions({ motion: 'reduce' });
    f.source.xy[1] += 80;
    f.source.update();
    f.diagram.setData(data(f.source, true), { animate: true });
    await render(240);
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(before + 160);
    expect(f.diagram.animating).toBe(false);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});

it('restores accepted positions when a drag interrupts and cancels a layout transition', async () => {
  const f = await fixture();
  const render = (timeMs: number) =>
    f.gpu.render({ views: [{ renderer: f.diagram, target: f.target }], timeMs });
  try {
    const api = interaction(f.diagram),
      ref = { kind: 'vertex' as const, type: 'Task', id: 'n0' };
    f.diagram.setOptions({ motion: 'full', animationMs: 200 });
    f.diagram.setData(data(f.source, true));
    await render(0);
    f.source.xy[1] = 80;
    f.source.update();
    f.diagram.setData(data(f.source, true), { animate: true });
    await render(20);
    await render(100);
    api.preview([ref], [0, 8]);
    await render(120);
    api.preview([], null);
    await render(140);
    expect(api.scene()!.vertices[0].y).toBe(80);
    expect(f.diagram.animating).toBe(false);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
it('settles immediately when animation is disabled or above its configured size limit', async () => {
  const f = await fixture();
  try {
    f.diagram.setData(data(f.source, true));
    await f.draw();
    f.diagram.setOptions({ animationMaxVertices: 2, motion: 'full', animationMs: 0 });
    f.diagram.fit({ animate: true });
    await f.draw();
    expect(f.diagram.getCamera()!.scale.every(Number.isFinite)).toBe(true);
    f.diagram.setOptions({ animationMs: 200 });
    f.source.xy[1] = 80;
    f.source.update();
    f.diagram.setData(data(f.source, true), { animate: true });
    await f.draw();
    expect(interaction(f.diagram).scene()!.vertices[0].y).toBe(80);
    expect(f.diagram.animating).toBe(false);
  } finally {
    f.diagram.destroy();
    f.target.destroy();
    f.gpu.destroy();
  }
});
