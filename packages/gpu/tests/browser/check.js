/* global GPUBufferUsage, GPUMapMode, GPUShaderStage */
import {
  createGpu,
  createRenderTarget,
  fieldShader,
  TextureData,
  rowCount,
} from '../../dist/index.js';

import { checkColors } from './colors.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function check() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('No real WebGPU adapter is available');
  const device = await adapter.requestDevice();
  const failures = [];
  device.addEventListener('uncapturederror', (event) => failures.push(event.error.message));
  device.pushErrorScope('validation');
  const gpu = await createGpu({ device, pageBytes: 64 * 1024 });
  const output = createRenderTarget({ gpu, width: 16, height: 16 });
  const checks = [];
  try {
    const module = device.createShaderModule({
      code:
        fieldShader({ group: 0 }) +
        `
      struct Info { rows: u32, frames: u32, destination: u32, slot: u32 }
      @group(1) @binding(0) var<storage, read_write> output: array<f32>;
      @group(1) @binding(1) var<uniform> info: Info;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
        if (id.x >= info.rows * info.frames) { return; }
        let row = id.x % info.rows; let frame = id.x / info.rows;
        var value = -999.0;
        if (fieldValid(info.slot, row, frame)) { value = fieldFloat(info.slot, row, frame, 0u); }
        output[info.destination + id.x] = value;
      }`,
    });
    const resultLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      ],
    });
    const pipeline = await gpu.computePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.fieldLayout, resultLayout] }),
      compute: { module, entryPoint: 'main' },
    });

    async function readColumns(block, policy, owner = gpu, renderTarget = output) {
      const count =
        rowCount(block.rows) * (block.kind === 'samples' ? block.coordinates.length : 1);
      const result = owner.buffer({
        size: count * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });
      const readback = owner.buffer({
        size: count * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });
      let groups = [],
        expected = [];
      const renderer = {
        async prepare(frame) {
          const destination = frame.buffer(result);
          frame.buffer(readback);
          const pages = frame.upload(block, {
            select: Object.keys(block.columns),
            float64: policy,
          });
          groups = [];
          expected = [];
          for (const page of pages) {
            const column = page.columns.value;
            const rows = rowCount(page.rows),
              frames = page.samples?.count ?? 1;
            const info = frame.uniforms(Uint32Array.of(rows, frames, expected.length, column.slot));
            const group = device.createBindGroup({
              layout: resultLayout,
              entries: [
                { binding: 0, resource: destination },
                { binding: 1, resource: info },
              ],
            });
            groups.push({ group, fields: page.bindGroup, count: rows * frames });
            const native = block.columns.value;
            const frameStart = page.samples ? page.samples.firstFrame - block.firstFrame : 0;
            for (let f = 0; f < frames; f++)
              for (let r = 0; r < rows; r++) {
                const address =
                  native.offset +
                  (frameStart + f) * (native.frameStride ?? 0) +
                  (page.rowOffset + r) * (native.rowStride ?? 1);
                const present =
                  !native.validity || native.validity[address >>> 3] & (1 << (address & 7));
                expected.push(
                  present ? Math.fround(native.values[address] - (column.origin?.[0] ?? 0)) : -999,
                );
              }
          }
        },
        encode(frame) {
          const pass = frame.encoder.beginComputePass();
          pass.setPipeline(pipeline);
          for (const { group, fields, count } of groups) {
            pass.setBindGroup(0, fields);
            pass.setBindGroup(1, group);
            pass.dispatchWorkgroups(Math.ceil(count / 64));
          }
          pass.end();
          frame.encoder.copyBufferToBuffer(result.buffer, 0, readback.buffer, 0, count * 4);
        },
        destroy() {},
      };
      await owner.render({ timeMs: 0, views: [{ renderer, target: renderTarget }] });
      await readback.buffer.mapAsync(GPUMapMode.READ);
      const actual = new Float32Array(readback.buffer.getMappedRange());
      for (let i = 0; i < count; i++)
        assert(
          Object.is(actual[i], expected[i]),
          'Column mismatch at ' + i + ': ' + actual[i] + ' != ' + expected[i],
        );
      readback.buffer.unmap();
      await owner.idle();
      result.destroy();
      readback.destroy();
      return renderer;
    }

    const index = { document: 'd', type: 'node', version: 'i0' };
    await readColumns({
      kind: 'samples',
      version: 'v0',
      schemaVersion: 's0',
      index,
      rows: { kind: 'indices', values: Uint32Array.of(900000, 4) },
      rowOffset: 0,
      firstFrame: 70,
      coordinates: Float64Array.of(1e12, 1e12 + 0.25),
      columns: {
        value: {
          kind: 'numeric',
          values: Float32Array.of(999, 10, 20, 88, 88, 30, 40),
          offset: 1,
          length: 6,
          rowStride: 1,
          frameStride: 4,
          validity: Uint8Array.of(0b00100110),
        },
      },
    });
    checks.push('strided sparse nullable samples');
    await readColumns(
      {
        kind: 'rows',
        version: 'v0',
        schemaVersion: 's0',
        index,
        rows: { kind: 'range', offset: 0, count: 3 },
        position: 0,
        columns: {
          value: {
            kind: 'numeric',
            values: Float64Array.of(1e12, 1e12 + 0.25, 1e12 + 0.5),
            offset: 0,
            length: 3,
          },
        },
      },
      'relative',
    );
    checks.push('Float64 rebasing before narrowing');

    const vertex = device.createShaderModule({
      code: `
      @vertex fn vs(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
        let points = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3)); return vec4f(points[id], 0, 1);
      }
      @group(0) @binding(0) var<uniform> color: vec4f;
      @fragment fn fs() -> @location(0) vec4f { return color; }`,
    });
    const descriptor = {
      layout: 'auto',
      vertex: { module: vertex, entryPoint: 'vs' },
      fragment: { module: vertex, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    };
    const colors = [
      [1, 0, 0, 1],
      [0, 0, 1, 1],
    ];
    const targets = colors.map(() => createRenderTarget({ gpu, width: 16, height: 16 }));
    const pixels = gpu.buffer({
      size: 8192,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const renderers = colors.map((color) => {
      let pipeline, group;
      return {
        async prepare(frame) {
          pipeline = await gpu.renderPipeline(descriptor);
          frame.buffer(pixels);
          group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: frame.uniforms(Float32Array.from(color)) }],
          });
        },
        encode(frame) {
          const pass = frame.encoder.beginRenderPass({
            colorAttachments: [
              { view: frame.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
            ],
          });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, group);
          pass.draw(3);
          pass.end();
        },
        destroy() {},
      };
    });
    await gpu.render({
      timeMs: 0,
      views: renderers.map((renderer, i) => ({ renderer, target: targets[i] })),
      encode(encoder) {
        for (let i = 0; i < 2; i++)
          encoder.copyTextureToBuffer(
            { texture: targets[i].texture() },
            { buffer: pixels.buffer, offset: i * 4096, bytesPerRow: 256 },
            [16, 16],
          );
      },
    });
    await pixels.buffer.mapAsync(GPUMapMode.READ);
    const rgba = new Uint8Array(pixels.buffer.getMappedRange());
    assert(
      rgba[0] === 255 && rgba[2] === 0 && rgba[4096] === 0 && rgba[4098] === 255,
      "Views overwrote each other's uniforms",
    );
    pixels.buffer.unmap();
    await gpu.idle();
    pixels.destroy();
    targets.forEach((target) => target.destroy());
    checks.push('two render passes and readback in one submission');

    const atlas = new TextureData({ width: 3, height: 2, format: 'r8unorm' });
    atlas.write({ x: 0, y: 0, width: 3, height: 2, data: Uint8Array.of(1, 2, 3, 4, 5, 6) });
    const atlasReadback = gpu.buffer({
      size: 512,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    let atlasTexture;
    const atlasRenderer = {
      async prepare(frame) {
        atlasTexture = frame.texture(atlas);
        frame.buffer(atlasReadback);
      },
      encode(frame) {
        frame.encoder.copyTextureToBuffer(
          { texture: atlasTexture },
          { buffer: atlasReadback.buffer, bytesPerRow: 256 },
          [3, 2],
        );
      },
      destroy() {},
    };
    for (let iteration = 0; iteration < 2; iteration++) {
      if (iteration) atlas.write({ x: 1, y: 1, width: 1, height: 1, data: Uint8Array.of(9) });
      await gpu.render({ timeMs: 0, views: [{ renderer: atlasRenderer, target: output }] });
      await atlasReadback.buffer.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(atlasReadback.buffer.getMappedRange());
      const expected = [1, 2, 3, 4, iteration ? 9 : 5, 6];
      for (let i = 0; i < expected.length; i++)
        assert(
          bytes[Math.floor(i / 3) * 256 + (i % 3)] === expected[i],
          'Texture upload or dirty row mismatch',
        );
      atlasReadback.buffer.unmap();
      await gpu.idle();
    }
    atlasReadback.destroy();
    checks.push('unaligned pixel rows and incremental texture upload');

    checks.push(await checkColors(gpu, output));
    gpu.trim();
    const rows = 1_000_000;
    const large = {
      kind: 'rows',
      version: 'large',
      schemaVersion: 's0',
      index,
      rows: { kind: 'range', offset: 0, count: rows },
      position: 0,
      columns: {
        value: {
          kind: 'numeric',
          values: Float32Array.from({ length: rows }, (_, i) => i),
          offset: 0,
          length: rows,
        },
      },
    };
    const before = gpu.stats();
    const start = performance.now();
    await readColumns(large);
    const elapsedMs = performance.now() - start;
    const after = gpu.stats();
    assert(
      after.stagedBytes === before.stagedBytes,
      'Float32 numeric payload was unnecessarily materialized',
    );
    checks.push('one million rows, paged compute and full numerical readback');
    const fragmented = await createGpu({ device, pageBytes: 8 * 1024 ** 2 });
    const fragmentedTarget = createRenderTarget({ gpu: fragmented, width: 16, height: 16 });
    const consolidation = {
      ...large,
      rows: { kind: 'range', offset: 0, count: 65536 },
      columns: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          i ? 'extra' + i : 'value',
          {
            kind: 'numeric',
            offset: 0,
            length: 65536,
            values: Float32Array.from({ length: 65536 }, (_, row) => row + i),
          },
        ]),
      ),
    };
    await readColumns(consolidation, undefined, fragmented, fragmentedTarget);
    const copied = fragmented.stats().gpuCopiedBytes;
    assert(copied > 0, 'Fragmented fields did not exercise GPU consolidation');
    await readColumns(consolidation, undefined, fragmented, fragmentedTarget);
    assert(fragmented.stats().gpuCopiedBytes === copied, 'Resident consolidation was repeated');
    fragmentedTarget.destroy();
    fragmented.destroy();
    checks.push('ten fragmented fields, native GPU consolidation and resident reuse');
    const validation = await device.popErrorScope();
    assert(
      !validation && !failures.length,
      'WebGPU validation: ' + [validation?.message, ...failures].join('; '),
    );
    return {
      checks,
      adapter: adapter.info?.description || adapter.info?.architecture || 'available',
      large: {
        rows,
        elapsedMs,
        uploadedBytes: after.uploadedBytes - before.uploadedBytes,
        stagedBytes: after.stagedBytes - before.stagedBytes,
        peakGpuBytes: after.peakGpuBytes,
      },
    };
  } finally {
    output.destroy();
    gpu.destroy();
    device.destroy();
  }
}
