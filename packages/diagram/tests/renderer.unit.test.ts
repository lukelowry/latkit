/// <reference types="@webgpu/types" />

import { bakeColormap, COLORMAP_LUT_SIZE } from '@latkit/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_OPTIONS } from '../src/options.js';
import { prepare } from '../src/prepare.js';
import { DEFAULT_SHADE_WGSL } from '../src/shade.js';
import {
  createMirrors,
  DIRTY_MERGE_GAP,
  DIRTY_RANGE_LIMIT,
  GLYPH_WORDS,
  OVERLAY_WORDS,
  UNIFORM_WORDS,
  WIRE_WORDS,
  writeStructure,
  type DrawCounts,
  type Mirrors,
} from '../src/webgpu/buffers.js';
import { PASSES, passSource, Renderer, type AtlasPixels } from '../src/webgpu/renderer.js';
import { createUniforms, DISPLAY_GRID } from '../src/webgpu/uniforms.js';
import {
  flushGpuPromises,
  installWebGpuConstants,
  makeFakeGpu,
  type FakeGpuHarness,
  type FakeRenderPass,
} from './fixtures/fake-webgpu.js';
import { twoArea } from './fixtures/netlists.js';

beforeEach(() => {
  installWebGpuConstants();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NO_COUNTS: DrawCounts = { groups: 0, wires: 0, blocks: 0, ports: 0, glyphs: 0, overlay: 0 };
/** Counts that draw every pass over `loadedMirrors()`. */
const ALL_COUNTS: DrawCounts = { groups: 1, wires: 5, blocks: 3, ports: 7, glyphs: 3, overlay: 1 };

/** A stand-in atlas: `height` rows of 16 px, with a clean spy. */
function fakeAtlas(height = 4): AtlasPixels & { clean: ReturnType<typeof vi.fn> } {
  const atlas = {
    width: 16,
    height,
    pixels: new Uint8Array(16 * height),
    version: 0,
    dirtyFrom: 0,
    dirtyTo: height,
    clean: vi.fn(() => {
      atlas.dirtyFrom = 0;
      atlas.dirtyTo = 0;
    }),
  };
  return atlas;
}

/** Mirrors with the TwoArea unit's structure, a layout, and a handful of instance entries. */
function loadedMirrors(): Mirrors {
  const mirrors = createMirrors();
  const prepared = prepare(twoArea(), 8);
  writeStructure(mirrors.structure, prepared);
  mirrors.layout.resize(12);
  mirrors.layout.touchAll();
  mirrors.channels.resize(20);
  mirrors.channels.touchAll();
  mirrors.focus.resize(13);
  mirrors.focus.touchAll();
  mirrors.wires.resize(5 * WIRE_WORDS);
  mirrors.wires.touchAll();
  mirrors.glyphs.resize(3 * GLYPH_WORDS);
  mirrors.glyphs.touchAll();
  mirrors.overlay.resize(OVERLAY_WORDS);
  mirrors.overlay.touchAll();
  return mirrors;
}

/** A renderer whose pipelines have landed. */
async function ready(
  mirrors: Mirrors = loadedMirrors(),
  shade: string | null = null,
): Promise<{ h: FakeGpuHarness; renderer: Renderer; mirrors: Mirrors }> {
  const h = makeFakeGpu();
  const renderer = new Renderer(h.presentation, mirrors, shade);
  await flushGpuPromises();
  return { h, renderer, mirrors };
}

/** The last frame's render pass. */
function lastPass(h: FakeGpuHarness): FakeRenderPass {
  return h.device.encoders.at(-1)!.passes[0]!;
}

/** The pipelines the last frame drew, by label. */
function drawnPipelines(h: FakeGpuHarness): Map<string, GPURenderPipelineDescriptor> {
  const drawn = new Map<string, GPURenderPipelineDescriptor>();
  for (const call of lastPass(h).calls) {
    if (call.method !== 'setPipeline') continue;
    const { descriptor } = call.args[0] as { descriptor: GPURenderPipelineDescriptor };
    drawn.set(descriptor.label!, descriptor);
  }
  return drawn;
}

/** The shader source each pipeline the last frame drew was built from, by label. */
function drawnCode(h: FakeGpuHarness): Map<string, string> {
  const code = new Map<string, string>();
  for (const [label, descriptor] of drawnPipelines(h)) {
    const module = descriptor.vertex.module as unknown as { descriptor: GPUShaderModuleDescriptor };
    code.set(label, module.descriptor.code);
  }
  return code;
}

/** `[pipeline label, vertex count, instance count]` per draw of a pass, in order. */
function draws(pass: FakeRenderPass): [string, number, number][] {
  const out: [string, number, number][] = [];
  let label = '';
  for (const call of pass.calls) {
    if (call.method === 'setPipeline') label = (call.args[0] as { label: string }).label;
    if (call.method === 'draw') out.push([label, call.args[0] as number, call.args[1] as number]);
  }
  return out;
}

/** The `writeBuffer` calls against the buffer labeled `label`: `[offset, byteOffset, size]`. */
function writesTo(h: FakeGpuHarness, label: string): [number, number, number][] {
  const buffers = new Set<unknown>(h.device.buffersLabeled(label));
  return h.device.queue.writeBuffer.mock.calls
    .filter((call) => buffers.has(call[0]))
    .map((call) => [call[1] as number, call[3] as number, call[4] as number]);
}

describe('Renderer construction', () => {
  it('shares one group 0 layout and adds group 1 only for the instanced passes', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, createMirrors(), null);

    const [shared, instance] = h.device.bindGroupLayouts;
    const entries = [...shared!.entries];
    expect(entries.map((entry) => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(entries.every((entry) => entry.visibility === 3)).toBe(true);
    expect(
      entries.map((entry) => entry.buffer?.type ?? entry.texture?.sampleType ?? 'sampler'),
    ).toEqual([
      'uniform',
      'read-only-storage',
      'read-only-storage',
      'read-only-storage',
      'read-only-storage',
      'float',
      'float',
      'sampler',
    ]);
    expect([...instance!.entries]).toEqual([
      { binding: 0, visibility: 1, buffer: { type: 'read-only-storage' } },
    ]);
    const [base, instanced] = h.device.pipelineLayouts;
    expect([...base!.bindGroupLayouts]).toHaveLength(1);
    expect([...instanced!.bindGroupLayouts]).toHaveLength(2);

    const layoutOf = (name: string) =>
      h.device.renderPipelines.find((pipeline) => pipeline.label === `diagram-${name}`)!.layout;
    for (const pass of PASSES) {
      const expected = pass.instances
        ? 'diagram-instanced-pipeline-layout'
        : 'diagram-base-pipeline-layout';
      expect(
        (layoutOf(pass.name) as unknown as { descriptor: GPUPipelineLayoutDescriptor }).descriptor
          .label,
      ).toBe(expected);
    }
    renderer.destroy();
  });

  it('seeds the colormap with the default ramp and samples linearly with clamping', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, createMirrors(), null);

    const colormap = h.device.texturesLabeled('diagram colormap')[0]!;
    expect(colormap.descriptor.size).toEqual([COLORMAP_LUT_SIZE, 1]);
    expect(colormap.descriptor.format).toBe('rgba8unorm');
    expect(h.device.queue.writeTexture).toHaveBeenCalledOnce();
    expect(h.device.queue.writeTexture.mock.calls[0]![1]).toEqual(
      bakeColormap(DEFAULT_OPTIONS.colormap),
    );
    expect(h.device.samplers).toEqual([
      {
        label: 'diagram sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
    ]);
    renderer.destroy();
  });

  it('builds one pipeline per pass with vs/fs entry points and premultiplied over blending', async () => {
    const { h, renderer } = await ready();

    expect(h.device.renderPipelines.map((pipeline) => pipeline.label).sort()).toEqual(
      PASSES.map((pass) => `diagram-${pass.name}`).sort(),
    );
    for (const pipeline of h.device.renderPipelines) {
      expect(pipeline.vertex.entryPoint).toBe('vs');
      expect(pipeline.vertex.buffers ?? []).toEqual([]);
      expect(pipeline.fragment!.entryPoint).toBe('fs');
      expect(pipeline.primitive?.topology).toBe('triangle-list');
      expect(pipeline.depthStencil).toBeUndefined();
      expect(pipeline.multisample).toBeUndefined();
      const [target] = [...pipeline.fragment!.targets];
      expect(target!.format).toBe('bgra8unorm');
      expect(target!.blend).toEqual({
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      });
    }
    renderer.destroy();
  });

  it('splices the shade prelude and the host shade into the shaded passes only', async () => {
    const custom = 'fn shade(f: Fragment) -> vec4f { return f.color * 0.5; }';
    const { h, renderer } = await ready(loadedMirrors(), custom);

    const code = (name: string) =>
      h.device.shaderModules.find((module) => module.label === `diagram-${name}`)!.code;
    for (const pass of PASSES) {
      expect(code(pass.name)).toBe(passSource(pass.name, custom));
      expect(code(pass.name).startsWith('// The prelude of every diagram pass')).toBe(true);
      expect(code(pass.name).includes('struct Fragment')).toBe(pass.shaded);
      expect(code(pass.name).includes('return f.color * 0.5;')).toBe(pass.shaded);
    }
    expect(PASSES.filter((pass) => pass.shaded).map((pass) => pass.name)).toEqual([
      'group',
      'wire',
      'block',
      'port',
    ]);
    renderer.destroy();
  });
});

describe('Renderer frames', () => {
  it('renders nothing and uploads nothing until the pipelines land', async () => {
    const h = makeFakeGpu();
    const mirrors = loadedMirrors();
    const renderer = new Renderer(h.presentation, mirrors, null);
    const onReady = vi.fn();
    renderer.onPipelinesReady = onReady;
    const atlas = fakeAtlas();

    expect(renderer.render(NO_COUNTS, atlas)).toBe(false);
    expect(h.device.buffers).toHaveLength(0);
    expect(h.device.queue.submit).not.toHaveBeenCalled();
    expect(mirrors.structure.dirtyTo).toBeGreaterThan(0);
    expect(atlas.clean).not.toHaveBeenCalled();

    await flushGpuPromises();
    expect(onReady).toHaveBeenCalledOnce();
    expect(renderer.render(NO_COUNTS, atlas)).toBe(true);
    expect(h.device.queue.submit).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it('allocates a buffer per mirror from its backing store and uploads everything first', async () => {
    const { h, renderer, mirrors } = await ready();
    renderer.render(NO_COUNTS, fakeAtlas());

    const uniforms = h.device.buffersLabeled('diagram uniforms');
    expect(uniforms).toHaveLength(1);
    expect(uniforms[0]!.size).toBe(UNIFORM_WORDS * 4);
    expect(uniforms[0]!.descriptor.usage).toBe(GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    for (const name of [
      'structure',
      'layout',
      'channels',
      'focus',
      'wires',
      'glyphs',
      'overlay',
    ] as const) {
      const mirror = mirrors[name];
      const [buffer] = h.device.buffersLabeled(mirror.label);
      expect(buffer!.size).toBe(Math.ceil((Math.max(mirror.capacity, 4) * 4) / 16) * 16);
      expect(buffer!.size % 16).toBe(0);
      expect(buffer!.descriptor.usage).toBe(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      expect(writesTo(h, mirror.label)).toEqual([[0, 0, mirror.words * 4]]);
      expect(mirror.dirtyFrom >= mirror.dirtyTo).toBe(true);
    }
    // A mirror with nothing in use still binds a buffer and uploads nothing.
    const empty = createMirrors();
    const second = await ready(empty);
    second.renderer.render(NO_COUNTS, fakeAtlas());
    expect(second.h.device.buffersLabeled('diagram wires')[0]!.size).toBe(16);
    expect(writesTo(second.h, 'diagram wires')).toEqual([]);
    renderer.destroy();
    second.renderer.destroy();
  });

  it('uploads the uniform block whole every frame and other mirrors only where dirty', async () => {
    const { h, renderer, mirrors } = await ready();
    renderer.render(NO_COUNTS, fakeAtlas());
    h.device.queue.writeBuffer.mockClear();

    mirrors.layout.touch(2, 5);
    mirrors.wires.touch(WIRE_WORDS, 2 * WIRE_WORDS);
    renderer.render(NO_COUNTS, fakeAtlas());

    expect(writesTo(h, 'diagram uniforms')).toEqual([[0, 0, UNIFORM_WORDS * 4]]);
    expect(writesTo(h, 'diagram layout')).toEqual([[8, 8, 12]]);
    expect(writesTo(h, 'diagram wires')).toEqual([
      [WIRE_WORDS * 4, WIRE_WORDS * 4, WIRE_WORDS * 4],
    ]);
    expect(writesTo(h, 'diagram structure')).toEqual([]);
    expect(h.device.buffersLabeled('diagram layout')).toHaveLength(1);
    // The upload hands over the mirror's own backing store.
    const call = h.device.queue.writeBuffer.mock.calls.find(
      (entry) => entry[0] === h.device.buffersLabeled('diagram layout')[0],
    )!;
    expect(call[2]).toBe(mirrors.layout.u32.buffer);
    expect([mirrors.layout.dirtyFrom, mirrors.layout.dirtyTo]).toEqual([0, 0]);
    renderer.destroy();
  });

  it('uploads scattered writes as one small write each, not the span between them', async () => {
    const mirrors = loadedMirrors();
    mirrors.focus.resize(300_000);
    mirrors.focus.touchAll();
    const { h, renderer } = await ready(mirrors);
    renderer.render(NO_COUNTS, fakeAtlas());
    h.device.queue.writeBuffer.mockClear();

    // Hover moving from block 18 to a net far down the focus mirror: two words, far apart.
    mirrors.focus.touch(18, 19);
    mirrors.focus.touch(270_000, 270_001);
    // Channel slots written in one frame: close together, one upload.
    mirrors.channels.touch(0, 3);
    mirrors.channels.touch(10, 13);
    renderer.render(NO_COUNTS, fakeAtlas());

    expect(writesTo(h, 'diagram focus')).toEqual([
      [18 * 4, 18 * 4, 4],
      [270_000 * 4, 270_000 * 4, 4],
    ]);
    expect(writesTo(h, 'diagram channels')).toEqual([[0, 0, 13 * 4]]);
    expect(mirrors.focus.dirtyCount).toBe(0);

    // Past the range limit the mirror falls back to one span over all of it.
    h.device.queue.writeBuffer.mockClear();
    for (let i = 0; i <= DIRTY_RANGE_LIMIT; i++) {
      mirrors.focus.touch(i * 2 * DIRTY_MERGE_GAP, i * 2 * DIRTY_MERGE_GAP + 1);
    }
    renderer.render(NO_COUNTS, fakeAtlas());
    const last = DIRTY_RANGE_LIMIT * 2 * DIRTY_MERGE_GAP + 1;
    expect(writesTo(h, 'diagram focus')).toEqual([[0, 0, last * 4]]);
    renderer.destroy();
  });

  it('reallocates, uploads whole, and rebinds a mirror whose version changed', async () => {
    const { h, renderer, mirrors } = await ready();
    renderer.render(NO_COUNTS, fakeAtlas());
    const sharedGroups = h.device.bindGroups.filter(
      (group) => group.label === 'diagram-shared-group',
    );
    expect(sharedGroups).toHaveLength(1);
    const old = h.device.buffersLabeled('diagram structure')[0]!;
    h.device.queue.writeBuffer.mockClear();

    mirrors.structure.resize(mirrors.structure.capacity + 100);
    renderer.render(NO_COUNTS, fakeAtlas());

    const [, replacement] = h.device.buffersLabeled('diagram structure');
    expect(old.destroyed).toBe(true);
    expect(replacement!.size).toBe(Math.ceil((mirrors.structure.capacity * 4) / 16) * 16);
    expect(writesTo(h, 'diagram structure')).toEqual([[0, 0, mirrors.structure.words * 4]]);
    const groups = h.device.bindGroups.filter((group) => group.label === 'diagram-shared-group');
    expect(groups).toHaveLength(2);
    expect([...groups[1]!.entries][1]!.resource).toEqual({ buffer: replacement });

    // Growing an instance mirror rebinds only its own group 1.
    mirrors.glyphs.resize(mirrors.glyphs.capacity * 4);
    renderer.render(NO_COUNTS, fakeAtlas());
    expect(
      h.device.bindGroups.filter((group) => group.label === 'diagram-shared-group'),
    ).toHaveLength(2);
    expect(
      h.device.bindGroups.filter((group) => group.label === 'diagram-glyphs-group'),
    ).toHaveLength(2);
    expect(
      h.device.bindGroups.filter((group) => group.label === 'diagram-wires-group'),
    ).toHaveLength(1);
    renderer.destroy();
  });

  it('keeps a buffer large enough for growth within capacity after a shrink', async () => {
    const mirrors = loadedMirrors();
    mirrors.wires.resize(100 * WIRE_WORDS);
    mirrors.wires.resize(WIRE_WORDS);
    const { h, renderer } = await ready(mirrors);
    renderer.render(NO_COUNTS, fakeAtlas());
    const version = mirrors.wires.version;

    mirrors.wires.resize(100 * WIRE_WORDS);
    mirrors.wires.touchAll();
    renderer.render(NO_COUNTS, fakeAtlas());

    expect(mirrors.wires.version).toBe(version);
    const [buffer, ...rest] = h.device.buffersLabeled('diagram wires');
    expect(rest).toHaveLength(0);
    expect(buffer!.size).toBeGreaterThanOrEqual(100 * WIRE_WORDS * 4);
    renderer.destroy();
  });

  it('encodes the seven passes in draw order with their instance counts', async () => {
    const { h, renderer, mirrors } = await ready();
    const uniforms = createUniforms(mirrors.uniforms);
    uniforms.flags = DISPLAY_GRID;

    expect(
      renderer.render(
        { groups: 2, wires: 5, blocks: 3, ports: 7, glyphs: 3, overlay: 1 },
        fakeAtlas(),
      ),
    ).toBe(true);

    const pass = lastPass(h);
    expect(draws(pass)).toEqual([
      ['diagram-grid', 3, 1],
      ['diagram-group', 6, 2],
      ['diagram-wire', 6, 5],
      ['diagram-block', 6, 3],
      ['diagram-port', 6, 7],
      ['diagram-glyph', 6, 3],
      ['diagram-overlay', 6, 1],
    ]);
    const bindings = pass.calls
      .filter((call) => call.method === 'setBindGroup')
      .map((call) => [
        call.args[0],
        (call.args[1] as { descriptor: GPUBindGroupDescriptor }).descriptor.label,
      ]);
    expect(bindings).toEqual([
      [0, 'diagram-shared-group'],
      [1, 'diagram-wires-group'],
      [1, 'diagram-glyphs-group'],
      [1, 'diagram-overlay-group'],
    ]);
    expect(pass.calls.at(-1)!.method).toBe('end');

    const [descriptor] = h.device.encoders.at(-1)!.descriptors;
    const [attachment] = [...descriptor!.colorAttachments];
    expect(attachment).toMatchObject({
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
    });
    expect(descriptor!.depthStencilAttachment).toBeUndefined();
    expect(h.device.queue.submit).toHaveBeenCalledOnce();
    renderer.destroy();
  });

  it('skips the grid without its flag, empty passes, and instances beyond a mirror', async () => {
    const { h, renderer, mirrors } = await ready();
    createUniforms(mirrors.uniforms).flags = 0;

    renderer.render(
      { groups: 0, wires: 99, blocks: 3, ports: 0, glyphs: 0, overlay: -1 },
      fakeAtlas(),
    );

    expect(draws(lastPass(h))).toEqual([
      ['diagram-wire', 6, mirrors.wires.words / WIRE_WORDS],
      ['diagram-block', 6, 3],
    ]);
    renderer.destroy();
  });

  it('uploads the atlas by version and by dirty rows, then cleans it', async () => {
    const { h, renderer } = await ready();
    const atlas = fakeAtlas(4);
    renderer.render(NO_COUNTS, atlas);

    const [texture] = h.device.texturesLabeled('diagram atlas');
    expect(texture!.descriptor).toMatchObject({ size: [16, 4], format: 'r8unorm' });
    const atlasWrites = () =>
      h.device.queue.writeTexture.mock.calls.filter(
        (call) =>
          (call[0] as GPUTexelCopyTextureInfo).texture === (texture as unknown as GPUTexture),
      );
    expect(atlasWrites()).toHaveLength(1);
    expect(atlasWrites()[0]!.slice(2)).toEqual([
      { offset: 0, bytesPerRow: 16, rowsPerImage: 4 },
      [16, 4],
    ]);
    expect(atlas.clean).toHaveBeenCalledOnce();

    renderer.render(NO_COUNTS, atlas);
    expect(atlasWrites()).toHaveLength(1);

    atlas.dirtyFrom = 1;
    atlas.dirtyTo = 3;
    renderer.render(NO_COUNTS, atlas);
    expect(atlasWrites()).toHaveLength(2);
    expect(atlasWrites()[1]!.slice(0, 1)).toEqual([{ texture, origin: [0, 1] }]);
    expect(atlasWrites()[1]!.slice(2)).toEqual([
      { offset: 16, bytesPerRow: 16, rowsPerImage: 2 },
      [16, 2],
    ]);
    const groups = () =>
      h.device.bindGroups.filter((group) => group.label === 'diagram-shared-group').length;
    expect(groups()).toBe(1);

    // A grown atlas is a new texture, uploaded whole and rebound.
    atlas.height = 8;
    atlas.pixels = new Uint8Array(16 * 8);
    atlas.version = 1;
    renderer.render(NO_COUNTS, atlas);
    const replaced = h.device.texturesLabeled('diagram atlas');
    expect(replaced).toHaveLength(2);
    expect(replaced[0]!.destroyed).toBe(true);
    expect(replaced[1]!.descriptor.size).toEqual([16, 8]);
    expect(groups()).toBe(2);
    renderer.destroy();
  });

  it('binds a one-row atlas before any glyph is rasterized', async () => {
    const { h, renderer } = await ready();
    renderer.render(NO_COUNTS, fakeAtlas(0));
    expect(h.device.texturesLabeled('diagram atlas')[0]!.descriptor.size).toEqual([16, 1]);
    expect(h.device.queue.writeTexture).toHaveBeenCalledOnce(); // the colormap only
    renderer.destroy();
  });

  it('throws naming a mirror that outgrows the device', async () => {
    const h = makeFakeGpu({ limits: { maxStorageBufferBindingSize: 64 } });
    const renderer = new Renderer(h.presentation, loadedMirrors(), null);
    await flushGpuPromises();
    expect(() => renderer.render(NO_COUNTS, fakeAtlas())).toThrow(
      /diagram structure needs \d+ bytes, over the device's storage binding limit 64/,
    );
    renderer.destroy();
  });
});

describe('Renderer colormap', () => {
  it('writes a lookup texture and refuses one too short', () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, createMirrors(), null);
    const lut = new Uint8Array(COLORMAP_LUT_SIZE * 4).fill(7);
    renderer.writeColormap(lut);
    expect(h.device.queue.writeTexture).toHaveBeenLastCalledWith(
      { texture: h.device.texturesLabeled('diagram colormap')[0] },
      lut,
      { bytesPerRow: COLORMAP_LUT_SIZE * 4 },
      [COLORMAP_LUT_SIZE, 1],
    );
    expect(() => renderer.writeColormap(new Uint8Array(4))).toThrow(RangeError);
    renderer.destroy();
  });
});

describe('Renderer shade', () => {
  const custom = 'fn shade(f: Fragment) -> vec4f { return f.color * 2.0; }';
  const latestCode = (h: FakeGpuHarness, name: string) =>
    h.device.shaderModules.filter((module) => module.label === `diagram-${name}`).at(-1)!.code;

  it('rebuilds only the shaded pipelines and resolves once they draw', async () => {
    const { h, renderer, mirrors } = await ready();
    const onReady = vi.fn();
    renderer.onPipelinesReady = onReady;
    const before = h.device.renderPipelines.length;

    await renderer.setShade(custom);

    expect(onReady).toHaveBeenCalledOnce();
    expect(h.device.renderPipelines.slice(before).map((pipeline) => pipeline.label)).toEqual([
      'diagram-group',
      'diagram-wire',
      'diagram-block',
      'diagram-port',
    ]);
    expect(latestCode(h, 'block')).toContain('return f.color * 2.0;');
    createUniforms(mirrors.uniforms).flags = DISPLAY_GRID;
    renderer.render(ALL_COUNTS, fakeAtlas());
    const drawn = drawnCode(h);
    expect(drawn.size).toBe(PASSES.length);
    for (const pass of PASSES) {
      expect(drawn.get(`diagram-${pass.name}`)).toBe(passSource(pass.name, custom));
    }

    // The same shade builds nothing; null restores the identity.
    await renderer.setShade(custom);
    expect(h.device.renderPipelines.length - before).toBe(4);
    await renderer.setShade(null);
    expect(h.device.renderPipelines.length - before).toBe(8);
    expect(latestCode(h, 'port')).toContain(DEFAULT_SHADE_WGSL);
    renderer.destroy();
  });

  it('rejects a shade that fails to compile and keeps drawing the previous one', async () => {
    const { h, renderer } = await ready();
    const onError = vi.fn();
    renderer.onPipelineError = onError;
    h.device.createRenderPipelineAsync.mockRejectedValueOnce(new Error('bad wgsl'));

    const failure = renderer.setShade('fn shade(f: Fragment) -> vec4f { return nope; }');
    await expect(failure).rejects.toThrow('diagram shader build failed:\nbad wgsl');
    await expect(failure).rejects.toMatchObject({ cause: new Error('bad wgsl') });

    expect(onError).not.toHaveBeenCalled();
    expect(renderer.render(ALL_COUNTS, fakeAtlas())).toBe(true);
    expect(drawnCode(h).get('diagram-block')).toBe(passSource('block'));
    // The previous shade is still the one a repeat request finds drawing.
    const built = h.device.renderPipelines.length;
    await renderer.setShade(null);
    expect(h.device.renderPipelines.length).toBe(built);
    renderer.destroy();
  });

  it('names compilation errors with their module and line', async () => {
    const { h, renderer } = await ready();
    h.device.createShaderModule.mockImplementationOnce(
      (descriptor: GPUShaderModuleDescriptor) =>
        ({
          label: descriptor.label,
          getCompilationInfo: async () => ({
            messages: [{ type: 'error', lineNum: 812, linePos: 30, message: 'unresolved nope' }],
          }),
        }) as unknown as GPUShaderModule,
    );
    h.device.createRenderPipelineAsync.mockRejectedValueOnce(new Error('pipeline'));
    await expect(
      renderer.setShade('fn shade(f: Fragment) -> vec4f { return nope; }'),
    ).rejects.toThrow('diagram shader build failed:\ndiagram-group:812:30 unresolved nope');
    renderer.destroy();
  });

  it('reports a failed first build, draws nothing, and recovers on a shade that builds', async () => {
    const h = makeFakeGpu();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.device.createRenderPipelineAsync.mockRejectedValueOnce(new Error('bad host shade'));
    const renderer = new Renderer(
      h.presentation,
      loadedMirrors(),
      'fn shade(f: Fragment) -> vec4f { }',
    );
    const onError = vi.fn();
    const onReady = vi.fn();
    renderer.onPipelineError = onError;
    renderer.onPipelinesReady = onReady;
    await flushGpuPromises();

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      'diagram shader build failed:\nbad host shade',
    );
    expect(error).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(renderer.render(NO_COUNTS, fakeAtlas())).toBe(false);

    await renderer.setShade(custom);
    expect(onReady).toHaveBeenCalledOnce();
    expect(renderer.render(NO_COUNTS, fakeAtlas())).toBe(true);
    renderer.destroy();
  });

  it('retries the unshaded pipelines when they failed', async () => {
    const h = makeFakeGpu();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The shaded four dispatch first; the fifth call is the grid.
    let calls = 0;
    const build = h.device.createRenderPipelineAsync.getMockImplementation()!;
    h.device.createRenderPipelineAsync.mockImplementation((descriptor) =>
      ++calls === 5 ? Promise.reject(new Error('grid')) : build(descriptor),
    );
    const renderer = new Renderer(h.presentation, loadedMirrors(), null);
    await flushGpuPromises();
    expect(renderer.render(NO_COUNTS, fakeAtlas())).toBe(false);

    await renderer.setShade(custom);
    expect(
      h.device.renderPipelines.filter((pipeline) => pipeline.label === 'diagram-grid'),
    ).toHaveLength(1);
    expect(renderer.render(NO_COUNTS, fakeAtlas())).toBe(true);
    renderer.destroy();
  });

  it('lets the latest shade win and returns to a drawing shade without a build', async () => {
    const { h, renderer } = await ready();
    const onReady = vi.fn();
    renderer.onPipelinesReady = onReady;
    const before = h.device.renderPipelines.length;

    const first = renderer.setShade('fn shade(f: Fragment) -> vec4f { return vec4f(0.0); }');
    const second = renderer.setShade(custom);
    await Promise.all([first, second]);
    expect(onReady).toHaveBeenCalledOnce();
    renderer.render(ALL_COUNTS, fakeAtlas());
    expect(drawnCode(h).get('diagram-block')).toBe(passSource('block', custom));
    const block = drawnPipelines(h).get('diagram-block');

    // A request for the shade already drawing abandons the build toward another.
    const pending = renderer.setShade('fn shade(f: Fragment) -> vec4f { return f.color.bgra; }');
    await renderer.setShade(custom);
    await pending;
    expect(onReady).toHaveBeenCalledOnce();
    expect(h.device.renderPipelines.length - before).toBe(12);
    renderer.render(ALL_COUNTS, fakeAtlas());
    expect(drawnPipelines(h).get('diagram-block')).toBe(block);
    renderer.destroy();
  });

  it('joins a build already under way for the same shade', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, loadedMirrors(), custom);
    const joined = renderer.setShade(custom);
    await joined;
    expect(h.device.renderPipelines).toHaveLength(PASSES.length);
    expect(renderer.render(NO_COUNTS, fakeAtlas())).toBe(true);
    renderer.destroy();
  });
});

describe('Renderer destroy', () => {
  it('releases every buffer and texture, once, and stops drawing', async () => {
    const { h, renderer } = await ready();
    renderer.render(NO_COUNTS, fakeAtlas());
    expect(h.device.buffers.length).toBeGreaterThan(0);

    renderer.destroy();
    renderer.destroy();

    expect(h.device.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(h.device.textures.every((texture) => texture.destroyed)).toBe(true);
    expect(renderer.render(NO_COUNTS, fakeAtlas())).toBe(false);
    await expect(
      renderer.setShade('fn shade(f: Fragment) -> vec4f { return f.color; }'),
    ).resolves.toBeUndefined();
  });

  it('stands down builds that land after it', async () => {
    const h = makeFakeGpu();
    const renderer = new Renderer(h.presentation, loadedMirrors(), null);
    const onReady = vi.fn();
    renderer.onPipelinesReady = onReady;
    renderer.destroy();
    await flushGpuPromises();
    expect(onReady).not.toHaveBeenCalled();
    expect(renderer.render(NO_COUNTS, fakeAtlas())).toBe(false);
  });
});
