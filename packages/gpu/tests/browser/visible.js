import { rowCount } from '@latkit/model';
/* global GPUShaderStage, GPUTextureUsage, GPUBufferUsage, GPUMapMode, document, requestAnimationFrame */
import { createGpu, kit } from '../../dist/index.js';

export async function show() {
  const gpu = await createGpu({ pageBytes: 65536 }),
    device = gpu.device;
  const errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  device.pushErrorScope('validation');
  const controls = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
    ],
  });
  const format = navigator.gpu.getPreferredCanvasFormat();
  const shared = `
    struct View { size: vec2f, origin: vec2f, kind: f32, phase: f32, scale: f32, pad: f32 }
    @group(1) @binding(0) var<uniform> view: View;
    struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f }
  `;
  const module = device.createShaderModule({
    code:
      kit.fieldShader({ group: 0 }) +
      shared +
      `
    @vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) row: u32) -> Vertex {
      let corners = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1));
      let uv = corners[vertex];
      let p = fieldVec2f(0u,row,0u) + view.origin;
      let radius = fieldFloat(1u,row,0u,0u);
      let shape = fieldUint(4u,row,0u,0u);
      let pulse = 1.0 + 0.06 * sin(view.phase + fieldFloat(7u,row,0u,0u));
      var extent = vec2f(radius);
      if (shape == 1u) { extent = vec2f(radius * 2.8, radius); }
      if (shape == 2u) { extent = vec2f(2.0, radius * pulse); }
      var position = p + uv * extent * pulse;
      position = (position - view.size * 0.5) * view.scale + view.size * 0.5;
      var color = fieldVec4f(2u,row,0u);
      let opacity = fieldFloat(3u,row,0u,0u);
      let width = fieldFloat(5u,row,0u,0u);
      let selected = fieldBool(8u,row,0u);
      let order = fieldUint(9u,row,0u,0u);
      color = vec4f(mix(color.rgb, vec3f(1.0), select(0.0, 0.18, selected)), color.a * opacity);
      if (!fieldValid(0u,row,0u) || !fieldBool(6u,row,0u) || width < 0.0 || order == 0xffffffffu) { position = vec2f(-10000); }
      return Vertex(vec4f(position / view.size * vec2f(2,-2) + vec2f(-1,1), 0, 1), uv, color);
    }
    @fragment fn fs(input: Vertex) -> @location(0) vec4f {
      if (view.kind == 0.0 && dot(input.uv,input.uv) > 1.0) { discard; }
      return vec4f(input.color.rgb * input.color.a, input.color.a);
    }
  `,
  });
  const text = device.createShaderModule({
    code:
      kit.textShader({ group: 0 }) +
      shared +
      `
    @vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Vertex {
      let item = textVertex(vertex,instance);
      var position = item.position;
      if (item.anchor != 0u) { position.x += sin(view.phase) * 6.0; }
      return Vertex(vec4f(position / view.size * vec2f(2,-2) + vec2f(-1,1),0,1), item.uv, item.color);
    }
    @fragment fn fs(input: Vertex) -> @location(0) vec4f { return textColor(input.uv,input.color); }
  `,
  });
  const blend = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };
  const pipeline = await gpu.renderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.fieldLayout, controls] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
  });
  const textPipeline = await gpu.renderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.textLayout, controls] }),
    vertex: { module: text, entryPoint: 'vs' },
    fragment: { module: text, entryPoint: 'fs', targets: [{ format, blend }] },
  });
  const dimensions = [400, 300],
    views = [];
  let capture,
    uniformBytes = 0;
  let scale = 1,
    phase = 0,
    moving = false,
    closed = false;
  const labels = ['Native fields', 'Shared text atlas', 'Recording observations'];
  const descriptions = [
    '2,400 points · 10 fields',
    'Shaped runs · reusable anchors',
    '1,200 observations · native rows',
  ];
  for (let kind = 0; kind < 3; kind++) {
    const canvas = document.querySelectorAll('canvas')[kind];
    canvas.width = dimensions[0];
    canvas.height = dimensions[1];
    const target = kit.createPresentation({
      gpu,
      canvas,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const count = [2400, 6, 1200][kind],
      index = { document: 'fixture', type: 'mark', version: 'rows' },
      rows = { kind: 'range', offset: 0, count };
    const positions = new Float64Array(count * 2);
    const radius = new Float32Array(count),
      color = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      let x, y;
      if (kind === 0) {
        const theta = i * 2.39996,
          r = Math.sqrt(i / count) * 120;
        x = 200 + Math.cos(theta) * r * 1.35;
        y = 178 + Math.sin(theta) * r * 0.68;
        radius[i] = 1.2 + (i % 7) * 0.14;
      } else if (kind === 1) {
        x = 90 + (i % 2) * 220;
        y = 122 + Math.floor(i / 2) * 62;
        radius[i] = 18;
      } else {
        x = 25 + (i / count) * 350;
        y = 180 + Math.sin(i / 90) * 36 + Math.sin(i / 27) * 14;
        radius[i] = 1.5;
      }
      positions.set([1e12 + x, 1e12 + y], i * 2);
      color.set(
        [0.2 + (0.4 * (i % 19)) / 19, 0.65 + 0.25 * Math.sin(i / 100) ** 2, 0.92, 1],
        i * 4,
      );
    }
    const numeric = (values) => ({ kind: 'numeric', offset: 0, length: values.length, values });
    const vector = (values, size) => ({
      kind: 'vector',
      offset: 0,
      length: count,
      size,
      values: numeric(values),
    });
    const local = (values) => ({ index, rows, values });
    const fields = {
      position: local(vector(positions, 2)),
      radius: local(numeric(radius)),
      color: local(vector(color, 4)),
      opacity: local(numeric(new Float32Array(count).fill(0.9))),
      shape: local(numeric(new Uint32Array(count).fill(kind))),
      width: local(numeric(new Float32Array(count).fill(1))),
      active: local({
        kind: 'boolean',
        offset: 0,
        length: count,
        values: new Uint8Array(Math.ceil(count / 8)).fill(255),
      }),
      gain: local(numeric(Float32Array.from({ length: count }, (_, i) => i / 20))),
      selected: local({
        kind: 'boolean',
        offset: 0,
        length: count,
        values: new Uint8Array(Math.ceil(count / 8)).fill(17),
      }),
      order: local(numeric(Uint32Array.from({ length: count }, (_, i) => i))),
    };
    const runs = [
      {
        text: labels[kind],
        position: [24, 32],
        size: 20,
        color: [0.91, 0.95, 1, 1],
        font: { family: 'sans-serif', weight: 600 },
      },
      { text: descriptions[kind], position: [24, 56], size: 12, color: [0.55, 0.66, 0.76, 1] },
      {
        text: 'office · Δx 0.25 · العربية',
        position: [24, 284],
        size: 14,
        color: [0.72, 0.86, 0.94, 1],
        anchor: 1,
      },
    ];
    if (kind === 1)
      for (let i = 0; i < 6; i++)
        runs.push({
          text: ['Input', 'Output', 'Layout', 'Text', 'Fields', 'Frame'][i],
          position: [positions[i * 2] - 1e12 - 27, positions[i * 2 + 1] - 1e12 + 5],
          size: 14,
          color: [0.03, 0.08, 0.12, 1],
        });
    let draws = [],
      textPages = [],
      textGroup;
    const rowSource = {
      version: 'v1',
      schema: { limits: { maxBlockBytes: 1048576 }, types: { [index.type]: { fields: {} } } },
      tables: {},
    };
    const renderer = {
      async prepare(frame) {
        if (capture) frame.buffer(capture);
        draws = [];
        for await (const native of frame.fields({
          source: rowSource,
          from: index.type,
          rows: { ...rows, index },
          fields,
        }))
          for (const page of frame.upload(native, {
            select: Object.keys(native.columns),
            float64: 'relative',
          })) {
            uniformBytes += 32;
            const origin = page.columns.position.origin;
            const binding = frame.uniforms(
              Float32Array.of(
                ...dimensions,
                origin[0] - 1e12,
                origin[1] - 1e12,
                kind,
                phase,
                scale,
                0,
              ),
            );
            draws.push({
              page,
              group: device.createBindGroup({
                layout: controls,
                entries: [{ binding: 0, resource: binding }],
              }),
            });
          }
        textPages = await frame.text({ runs });
        uniformBytes += 32;
        textGroup = device.createBindGroup({
          layout: controls,
          entries: [
            {
              binding: 0,
              resource: frame.uniforms(Float32Array.of(...dimensions, 0, 0, kind, phase, 1, 0)),
            },
          ],
        });
      },
      encode(frame) {
        const pass = frame.encoder.beginRenderPass({
          colorAttachments: [
            {
              view: frame.target,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0.027, 0.047, 0.075, 1],
            },
          ],
        });
        pass.setPipeline(pipeline);
        for (const { page, group } of draws) {
          pass.setBindGroup(0, page.bindGroup);
          pass.setBindGroup(1, group);
          pass.draw(6, rowCount(page.rows));
        }
        pass.setPipeline(textPipeline);
        pass.setBindGroup(1, textGroup);
        for (const page of textPages) {
          pass.setBindGroup(0, page.bindGroup);
          pass.draw(6, page.count);
        }
        pass.end();
      },
      destroy() {},
    };
    views.push({ renderer, target });
  }
  const stats = () => {
    const s = gpu.stats();
    document.querySelector('#stats').textContent =
      `${views.length} views · ${s.submissions} submissions · ${(s.gpuBytes / 1048576).toFixed(1)} MiB GPU · ${s.uploadHits} upload cache hits · ${(s.gpuCopiedBytes / 1024).toFixed(0)} KiB GPU consolidation`;
  };
  const render = async () => {
    uniformBytes = 0;
    await gpu.render({ timeMs: performance.now(), views });
    await gpu.idle();
    stats();
  };
  await render();
  const before = gpu.stats();
  await render();
  const residentUploadedBytes = gpu.stats().uploadedBytes - before.uploadedBytes;
  if (residentUploadedBytes !== uniformBytes || gpu.stats().stagedBytes !== before.stagedBytes)
    throw new Error('Unchanged fixture reuploaded data or text');
  // Read back real text pixels from the first canvas before handing control to the user.
  const pixels = gpu.buffer({
    size: 256 * 200,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  capture = pixels;
  await gpu.render({
    timeMs: 0,
    views,
    encode(encoder) {
      encoder.copyTextureToBuffer(
        { texture: views[0].target.texture(), origin: [24, 12] },
        { buffer: pixels.buffer, bytesPerRow: 256 },
        [64, 30],
      );
    },
  });
  await pixels.buffer.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(pixels.buffer.getMappedRange());
  let bright = 0;
  for (let y = 0; y < 30; y++)
    for (let x = 0; x < 64; x++) if (data[y * 256 + x * 4] > 100) bright++;
  pixels.buffer.unmap();
  await gpu.idle();
  pixels.destroy();
  capture = undefined;
  if (bright < 30) throw new Error('Text shader produced no visible text');
  const validation = await device.popErrorScope();
  if (validation || errors.length) throw new Error([validation?.message, ...errors].join('\n'));
  stats();
  let busy = false;
  const tick = async () => {
    if (closed) return;
    if (!busy) {
      busy = true;
      try {
        if (moving) phase += 0.035;
        await render();
      } catch (error) {
        document.querySelector('#status').textContent = error.stack;
        moving = false;
      } finally {
        busy = false;
      }
    }
    if (moving) requestAnimationFrame(tick);
  };
  document.querySelector('#animate').onclick = (event) => {
    moving = !moving;
    event.target.textContent = moving ? 'Pause animation' : 'Animate anchors';
    if (moving) void tick();
  };
  document.querySelector('#zoom').oninput = (event) => {
    scale = Number(event.target.value);
    if (!moving) void tick();
  };
  globalThis.fixture = {
    gpu,
    errors,
    render,
    close() {
      closed = true;
      for (const view of views) view.target.destroy();
      gpu.destroy();
    },
  };
  return {
    fieldsPerPage: 10,
    views: 3,
    textPixels: bright,
    residentUniformBytes: residentUploadedBytes,
    text: 'shared shaped-run SDF atlas, actual pixel readback',
  };
}
