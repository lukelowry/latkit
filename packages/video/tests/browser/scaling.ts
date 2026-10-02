import { createComposition, kit, type Gpu } from '@latkit/gpu';
import { exportVideo, type VideoWrite } from '../../src/index.js';
import { view } from './views.js';
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};

export async function ownership(gpu: Gpu) {
  let release!: () => void,
    entered!: () => void,
    destroyed = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const child = view(gpu, {
    async prepare() {
      entered();
      await gate;
    },
    encode(frame) {
      frame.encoder
        .beginRenderPass({
          colorAttachments: [
            { view: frame.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
          ],
        })
        .end();
    },
    release() {
      destroyed = true;
    },
  });
  const composition = createComposition(gpu, { views: [{ view: child, region: [0, 0, 1, 1] }] });
  const target = kit.createRenderTarget({ gpu, width: 32, height: 32 });
  try {
    const rendering = gpu.render({
      timeMs: 0,
      views: [{ renderer: kit.rendererOf(composition), target }],
    });
    await ready;
    try {
      let busy = false;
      try {
        await gpu.render({ timeMs: 0, views: [{ renderer: kit.rendererOf(child), target }] });
      } catch (error) {
        busy = String(error).includes('in progress');
      }
      assert(busy, 'Composed child was allowed concurrent preparation');
    } finally {
      release();
      await rendering;
    }
    composition.destroy();
    assert(!destroyed, 'Composition destroyed its borrowed child');
    await gpu.render({ timeMs: 0, views: [{ renderer: kit.rendererOf(child), target }] });
  } finally {
    release();
    composition.destroy();
    target.destroy();
    child.destroy();
  }
}

/** Deliberately difficult to compress: changing spatial detail, generated entirely on the GPU. */
export async function throughput(gpu: Gpu): Promise<unknown[]> {
  const module = gpu.device.createShaderModule({
    code: `
@group(0) @binding(0) var<uniform> phase: vec4f;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2. - 1., 0., 1.);
}
@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let xy = floor(p.xy / 4.);
  let v = fract(sin(dot(xy, vec2f(12.9898, 78.233)) + phase.x * 0.04) * 43758.5453);
  return vec4f(v, fract(v * 3.7), fract(v * 7.1), 1.);
}`,
  });
  const pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  let pipeline: GPURenderPipeline, binding: GPUBindGroup;
  const scene = view(gpu, {
    async prepare(frame) {
      let cached = pipelines.get(frame.format);
      if (!cached) {
        cached = await gpu.renderPipeline({
          layout: 'auto',
          vertex: { module, entryPoint: 'vertex' },
          fragment: { module, entryPoint: 'fragment', targets: [{ format: frame.format }] },
        });
        pipelines.set(frame.format, cached);
      }
      pipeline = cached;
      binding = gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: frame.uniforms(new Float32Array([frame.timeMs, 0, 0, 0])) },
        ],
      });
    },
    encode(frame) {
      const pass = frame.encoder.beginRenderPass({
        colorAttachments: [
          { view: frame.target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, binding);
      pass.draw(3);
      pass.end();
    },
    release() {
      pipelines.clear();
    },
  });
  const report = [];
  try {
    for (const duration of [1, 10]) {
      let writes = 0,
        peakWrite = 0,
        active = 0,
        peakActive = 0;
      const output = new WritableStream<VideoWrite>({
        async write(chunk) {
          writes++;
          active++;
          peakActive = Math.max(peakActive, active);
          peakWrite = Math.max(peakWrite, chunk.bytes.length);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        },
      });
      const start = performance.now();
      const result = await exportVideo(scene, {
        output,
        width: 1920,
        height: 1080,
        duration,
        frameRate: 30,
        bitrate: 12_000_000,
      });
      assert(
        writes > 2 && peakActive === 1 && peakWrite <= 256 * 1024,
        'Detailed workload did not exercise bounded output',
      );
      report.push({
        benchmark: '1080p changing detail with slow sink',
        duration,
        frames: result.frames,
        elapsedMs: performance.now() - start,
        byteLength: result.byteLength,
        writes,
        peakWrite,
        gpu: gpu.stats(),
      });
    }
  } finally {
    scene.destroy();
  }
  return report;
}
