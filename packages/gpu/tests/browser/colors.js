/* global GPUBufferUsage, GPUMapMode, GPUShaderStage, document, CSS */
import { colormaps, createColormap, reverseColormap, colormapCss, kit } from '../../dist/index.js';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
export async function checkColors(gpu, target) {
  const device = gpu.device;
  const tests = [
    ...Object.values(colormaps),
    reverseColormap(colormaps.viridis),
    reverseColormap(colormaps.phase),
    createColormap({
      colors: [
        [1, 0, 0, 0],
        [0, 0, 1, 1],
      ],
    }),
    createColormap({
      colors: [
        [1, 0.5, 0, 0.125],
        [0, 0.5, 1, 0.75],
      ],
    }),
  ];
  const values = Float32Array.from([
    -2,
    -0.5,
    0,
    ...Array.from({ length: 257 }, (_, i) => i / 256),
    1,
    1.5,
    2,
    3.4028234663852886e38,
    -3.4028234663852886e38,
    NaN,
    Infinity,
    -Infinity,
  ]);
  const bytes = values.length * 32;
  const result = gpu.buffer({
    size: bytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = gpu.buffer({
    size: bytes,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const input = gpu.buffer({
    size: values.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(input.buffer, 0, values);
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const module = device.createShaderModule({
    code:
      kit.colormapShader({ group: 0 }) +
      `
    @group(1) @binding(0) var<storage,read> values:array<f32>;
    @group(1) @binding(1) var<storage,read_write> results:array<vec4f>;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
      if(id.x>=arrayLength(&values)){return;}
      results[id.x*2u]=colormapColor(values[id.x]);
      results[id.x*2u+1u]=paletteColor(id.x);
    }`,
  });
  const pipeline = await gpu.computePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.colormapLayout, layout] }),
    compute: { module, entryPoint: 'main' },
  });
  let palette, data;
  let maxError = 0;
  for (const map of tests) {
    assert(
      CSS.supports('background-image', colormapCss(map)),
      'Invalid CSS gradient: ' + map.label,
    );
    const renderer = {
      async prepare(frame) {
        palette = frame.colormap(map);
        data = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: frame.buffer(input) },
            { binding: 1, resource: frame.buffer(result) },
          ],
        });
        frame.buffer(readback);
      },
      encode(frame) {
        const pass = frame.encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, palette);
        pass.setBindGroup(1, data);
        pass.dispatchWorkgroups(Math.ceil(values.length / 64));
        pass.end();
        frame.encoder.copyBufferToBuffer(result.buffer, 0, readback.buffer, 0, bytes);
      },
      destroy() {},
    };
    await gpu.render({ timeMs: 0, views: [{ renderer, target }] });
    await readback.buffer.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.buffer.getMappedRange());
    for (let i = 0; i < values.length; i++) {
      const expected = Number.isFinite(values[i])
        ? kit.sampleColormap(map, values[i])
        : [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        // Compare visible, premultiplied contributions; division near zero alpha amplifies irrelevant RGB error.
        const error = Math.abs(
          actual[i * 8 + c] * (c < 3 ? actual[i * 8 + 3] : 1) -
            expected[c] * (c < 3 ? expected[3] : 1),
        );
        maxError = Math.max(maxError, error);
        assert(
          error <= 1 / 255 + 1e-6,
          `Palette mismatch ${map.label} t=${values[i]} channel=${c}: ${error}`,
        );
      }
      const color = map.colors[i];
      const alpha = color ? Math.round(color[3] * 255) / 255 : 0;
      for (let c = 0; c < 4; c++) {
        const expectedIndex =
          c === 3 ? alpha : alpha ? Math.round(color[c] * alpha * 255) / (alpha * 255) : 0;
        assert(
          Math.abs(actual[i * 8 + 4 + c] - expectedIndex) < 1e-6,
          'Integer palette lookup blended categories',
        );
      }
    }
    readback.buffer.unmap();
  }
  await gpu.idle();
  input.destroy();
  result.destroy();
  readback.destroy();
  const context = document.createElement('div');
  context.style.color = 'rgb(20, 40, 60)';
  context.style.setProperty('--accent', '#ff8000');
  document.body.append(context);
  try {
    const close = (actual, expected) =>
      actual && actual.every((v, i) => Math.abs(v - expected[i]) < 1e-6);
    assert(
      close(kit.resolveColor('currentColor', context), [20 / 255, 40 / 255, 60 / 255, 1]),
      'currentColor resolution',
    );
    assert(
      close(kit.resolveColor('var(--accent)', context), [1, 128 / 255, 0, 1]),
      'Custom property resolution',
    );
    assert(
      close(kit.resolveColor('var(--missing, blue)', context), [0, 0, 1, 1]),
      'Custom property fallback',
    );
    assert(
      kit.resolveColor('var(--missing)', context) === null,
      'Unresolved variable must not inherit silently',
    );
    assert(kit.resolveColor('nonsense', context) === null, 'Invalid CSS must not inherit silently');
    assert(context.children.length === 0, 'CSS resolution leaked DOM probes');
  } finally {
    context.remove();
  }
  return `${tests.length} palettes: GPU/CPU agreement, categorical indices, alpha, cyclic seams, CSS and contextual colors (max error ${maxError.toFixed(6)})`;
}
