/* global GPUBufferUsage, GPUMapMode, GPUShaderStage */
import {
  fieldShader,
  scaleShader,
  scaleParameters,
  resolveScale,
  shadeShader,
  outputShader,
} from '../../dist/index.js';
export async function checkFoundation(gpu, target) {
  const device = gpu.device,
    rows = 3,
    buckets = 5,
    slots = rows * buckets * 4;
  const numeric = Float64Array.from({ length: slots }, (_, i) => 1e12 + i / 4),
    coordinates = Float64Array.from({ length: slots }, (_, i) => 1e10 + Math.floor(i / 4) * 0.125),
    frames = Float64Array.from({ length: slots }, (_, i) => 2 ** 40 + i),
    validity = new Uint8Array(Math.ceil(slots / 8)).fill(255),
    continuous = new Uint8Array(Math.ceil((rows * buckets) / 8));
  for (let cell = 0; cell < rows * buckets; cell++) {
    if (cell % 2 === 0) continuous[cell >>> 3] |= 1 << (cell & 7);
  }
  const block = {
    kind: 'envelope',
    version: 'v',
    schemaVersion: 's',
    index: { document: 'd', type: 'node', version: 'i' },
    rows: { kind: 'range', offset: 10, count: rows },
    rowOffset: 0,
    firstBucket: 0,
    bucketCount: buckets,
    columns: {
      value: {
        values: { kind: 'numeric', offset: 0, length: slots, values: numeric, validity },
        coordinates,
        frames,
        continuous,
      },
    },
  };
  const output = gpu.buffer({
    size: rows * buckets * 16 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readback = gpu.buffer({
    size: output.buffer.size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const module = device.createShaderModule({
    code:
      fieldShader({ group: 0 }) +
      scaleShader() +
      `
    struct Info {shape:vec4u,slots:vec4u}
    @group(1) @binding(0) var<storage,read_write> result:array<f32>;
    @group(1) @binding(1) var<uniform> info:Info;
    @group(1) @binding(2) var<uniform> scale:LatkitScale;
    @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u) {
      if(id.x>=info.shape.x*info.shape.y){return;}
      let row=id.x%info.shape.x;let bucket=id.x/info.shape.x;
      let to=((row+info.shape.z)*5u+bucket+info.shape.w)*16u;
      for(var lane=0u;lane<4u;lane++) {
        result[to+lane]=fieldFloat(info.slots.x,row,bucket,lane);
        result[to+4u+lane]=fieldFloat(info.slots.y,row,bucket,lane);
        result[to+8u+lane]=fieldFloat(info.slots.z,row,bucket,lane);
      }
      result[to+12u]=select(0.0,1.0,fieldBool(info.slots.w,row,bucket));
      result[to+13u]=scaleMapped(fieldFloat(info.slots.x,row,bucket,0u),fieldValid(info.slots.x,row,bucket),scale,-99.0);
      result[to+14u]=scaleMapped(100.0,true,LatkitScale(vec4f(0,0,2,6),vec4f(2,1,0,0)),-99.0);
      result[to+15u]=scaleMapped(100.0,true,LatkitScale(vec4f(0),vec4f(0)),-99.0);
    }`,
  });
  const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(errors.map((m) => m.message).join(';'));
  const pipeline = await gpu.computePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.fieldLayout, layout] }),
    compute: { module, entryPoint: 'main' },
  });
  let draws = [],
    expected = new Float32Array(rows * buckets * 16);
  const renderer = {
    async prepare(frame) {
      const destination = frame.buffer(output);
      frame.buffer(readback);
      draws = [];
      for (const page of frame.upload(block, { select: ['value'], maxPageBytes: 1024 })) {
        const field = page.columns.value,
          nr = page.rows.count,
          nf = page.envelope.count;
        const group = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: destination },
            {
              binding: 1,
              resource: frame.uniforms(
                Uint32Array.of(
                  nr,
                  nf,
                  page.rowOffset,
                  page.envelope.firstBucket,
                  field.values.slot,
                  field.coordinates.slot,
                  field.frames.slot,
                  field.continuous.slot,
                ),
              ),
            },
            {
              binding: 2,
              resource: frame.uniforms(
                scaleParameters(resolveScale({}, [1e12, 1e12 + 100]), {
                  origin: field.values.origin?.[0],
                }),
              ),
            },
          ],
        });
        draws.push({ group, fields: page.bindGroup, count: nr * nf });
        for (let r = 0; r < nr; r++)
          for (let b = 0; b < nf; b++) {
            const cell = (page.rowOffset + r) * buckets + page.envelope.firstBucket + b,
              at = cell * 16;
            for (let lane = 0; lane < 4; lane++) {
              expected[at + lane] = numeric[cell * 4 + lane] - field.values.origin[lane];
              expected[at + 4 + lane] =
                coordinates[cell * 4 + lane] - field.coordinates.origin[lane];
              expected[at + 8 + lane] = frames[cell * 4 + lane] - field.frames.origin[lane];
            }
            expected[at + 12] = cell % 2 === 0 ? 1 : 0;
            expected[at + 13] = (numeric[cell * 4] - 1e12) / 100;
            expected[at + 14] = 5;
            expected[at + 15] = -99;
          }
      }
    },
    encode(frame) {
      const pass = frame.encoder.beginComputePass();
      pass.setPipeline(pipeline);
      for (const draw of draws) {
        pass.setBindGroup(0, draw.fields);
        pass.setBindGroup(1, draw.group);
        pass.dispatchWorkgroups(Math.ceil(draw.count / 64));
      }
      pass.end();
      frame.encoder.copyBufferToBuffer(output.buffer, 0, readback.buffer, 0, output.buffer.size);
    },
    destroy() {},
  };
  try {
    await gpu.render({ timeMs: 0, views: [{ renderer, target }] });
    await readback.buffer.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.buffer.getMappedRange());
    for (let i = 0; i < actual.length; i++)
      if (Math.abs(actual[i] - expected[i]) > 1e-6)
        throw new Error(`Envelope/scale GPU mismatch at ${i}: ${actual[i]} != ${expected[i]}`);
    readback.buffer.unmap();
    await gpu.idle();
    const effect = device.createShaderModule({
      code:
        shadeShader() +
        outputShader() +
        `fn shade(f:ShadeFragment)->vec4f{return f.color;} @compute @workgroup_size(1) fn main(){ let color=outputColor(shade(ShadeFragment(vec4f(1),shadeContext.pointer.xy,0)),1); }`,
    });
    if ((await effect.getCompilationInfo()).messages.some((m) => m.type === 'error'))
      throw new Error('Shared effect ABI did not compile');
    return [
      'native envelope GPU paging / values / coordinates / exact-relative frame identities / continuity',
      'CPU-WGSL scale agreement / constant / empty domains',
      'shared shade context and premultiplied output shader',
    ];
  } finally {
    output.destroy();
    readback.destroy();
  }
}
