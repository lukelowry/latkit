import {
  resolveScale,
  scaleValue,
  scaleParameters,
  type Encoding,
  type Gpu,
  type GpuPage,
  type GpuValueField,
  type Preparation,
  type TextureResource,
  type TextPage,
} from '@latkit/gpu';
import { rowCount, type Domain } from '@latkit/model';
import { isEnvelope, type Chunk } from '../history.js';
import { buffer, geometry, type Geometry, type Seams } from '../segments.js';
import type { Settings } from '../config.js';
import type { Axes, Plot } from '../axes.js';
import type { Pipelines } from './pipelines.js';
export interface Image {
  texture: TextureResource;
  msaa?: TextureResource;
  width: number;
  height: number;
  x: Domain;
  y: Domain;
  ready: boolean;
  fresh: boolean;
}
export function image(
  gpu: Gpu,
  width: number,
  height: number,
  x: Domain,
  y: Domain,
  msaa: 1 | 4,
): Image {
  const texture = gpu.texture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
  try {
    return {
      texture,
      msaa:
        msaa === 4
          ? gpu.texture({
              size: [width, height],
              format: 'rgba8unorm',
              sampleCount: 4,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
          : undefined,
      width,
      height,
      x,
      y,
      ready: false,
      fresh: true,
    };
  } catch (e) {
    texture.destroy();
    throw e;
  }
}
export function destroyImage(value?: Image) {
  value?.texture.destroy();
  value?.msaa?.destroy();
}
export function imageBytes(image: Image): number {
  return image.width * image.height * 4 * (image.msaa ? 5 : 1);
}
export interface Draw {
  page: GpuPage;
  view: GPUBindGroup;
  colors: GPUBindGroup;
  shade: GPUBindGroup;
  geometry: Geometry;
  factor: number;
}
export function prepareChunk(
  gpu: Gpu,
  frame: Preparation,
  pipelines: Pipelines,
  chunk: Chunk,
  target: Image,
  plot: Plot,
  settings: Settings,
  seams: Seams,
  focus: boolean,
  parameters: Float32Array,
  pointer: readonly [number, number] | null,
  memo: Map<string, Geometry>,
  timeMs: number,
): Draw[] {
  const native = chunk.data,
    env = isEnvelope(native),
    binding = chunk.binding;
  const select = env ? [binding.field] : Object.keys(native.columns);
  const pages = frame.upload(native, { select, float64: 'relative', maxPageBytes: 256 * 1024 });
  const colors = frame.colormap(binding.trace.color?.colormap),
    effect = gpu.device.createBindGroup({
      layout: pipelines.shade,
      entries: [{ binding: 0, resource: frame.shade({ parameters, pointerPx: pointer, timeMs }) }],
    });
  const colorDomain = binding.colorDomain ?? target.y;
  const styles = chunk.styles
    ? Float32Array.from(chunk.styles, (v, i) =>
        i % 4 === 0
          ? (scaleValue(v, resolveScale({}, colorDomain)) ?? -1)
          : Number.isFinite(v)
            ? v
            : 0,
      )
    : new Float32Array(4);
  const styleBuffer = frame.buffer(buffer(styles, 'monitor row styles'));
  const draws: Draw[] = [];
  for (const page of pages) {
    const desc = page.columns[env ? binding.field : 'value'];
    if (desc.kind === 'list') throw new Error('Trace field must be scalar');
    const value = desc.kind === 'envelope' ? desc.values : desc,
      coordinate = desc.kind === 'envelope' ? desc.coordinates : page.samples!.coordinates;
    const color = env ? (binding.colorValue ? value : undefined) : page.columns.color;
    const shade = env ? (binding.shadeValue ? value : undefined) : page.columns.shade;
    const visibility = env ? undefined : page.columns.visible;
    const uniforms = new Float32Array(132),
      ints = new Uint32Array(uniforms.buffer),
      base = binding.trace.baseColor ?? [0.23, 0.72, 0.88, 0.7];
    uniforms.set([target.width, target.height, plot.width, plot.height], 0);
    uniforms.set(base, 4);
    uniforms.set(settings.focusColor ?? [0, 0, 0, -1], 8);
    uniforms.set(
      [binding.trace.widthPx ?? 1.25, focus ? 1 : 0, 0, binding.trace.color ? 1 : 0],
      12,
    );
    ints.set(
      [
        value.slot,
        coordinate.slot,
        color?.kind === 'value' ? color.slot : 0xffffffff,
        shade?.kind === 'value' ? shade.slot : 0xffffffff,
      ],
      16,
    );
    ints.set(
      [
        env ? 1 : 0,
        visibility?.kind === 'value' ? visibility.slot : 0xffffffff,
        0,
        binding.trace.interpolation === 'step-before'
          ? 1
          : binding.trace.interpolation === 'step-after'
            ? 2
            : 0,
      ],
      20,
    );
    ints.set(
      [
        rowCount(page.rows),
        page.samples?.count ?? page.envelope!.count,
        page.rowOffset - native.rowOffset,
        (visibility?.kind === 'value' && visibility.type === 'boolean' ? 1 : 0) |
          (binding.colorValue ? 2 : 0) |
          (binding.shadeValue ? 4 : 0),
      ],
      24,
    );
    uniforms.set(
      [
        shade?.kind === 'value' ? (shade.origin?.[0] ?? 0) : 0,
        frame.viewport.pixelRatio,
        plot.x,
        plot.y,
      ],
      28,
    );
    const setScale = (at: number, domain: Domain, column: GpuValueField, clamp: boolean) => {
      for (let lane = 0; lane < 4; lane++)
        uniforms.set(
          scaleParameters(resolveScale({ clamp }, domain), {
            origin: column.origin?.[Math.min(lane, column.components - 1)] ?? 0,
          }),
          at + lane * 8,
        );
    };
    for (let lane = 0; lane < 4; lane++)
      uniforms[32 + lane] =
        shade?.kind === 'value' ? (shade.origin?.[Math.min(lane, shade.components - 1)] ?? 0) : 0;
    setScale(36, target.x, coordinate, false);
    setScale(68, target.y, value, false);
    for (let lane = 0; lane < 4; lane++)
      uniforms.set(
        scaleParameters(resolveScale({}, colorDomain), {
          origin:
            color?.kind === 'value'
              ? (color.origin?.[Math.min(lane, color.components - 1)] ?? 0)
              : 0,
        }),
        100 + lane * 8,
      );
    const key = [
      page.rowOffset,
      page.samples?.firstFrame,
      page.samples?.count,
      page.envelope?.firstBucket,
      page.envelope?.count,
    ].join(':');
    let shape = memo.get(key);
    if (!shape) {
      shape = geometry(chunk, page, seams, target.x, target.y, colorDomain);
      memo.set(key, shape);
    }
    const group = gpu.device.createBindGroup({
      layout: pipelines.view,
      entries: [
        { binding: 0, resource: frame.uniforms(uniforms) },
        { binding: 1, resource: frame.buffer(shape.addresses) },
        { binding: 2, resource: frame.buffer(shape.joins) },
        { binding: 3, resource: styleBuffer },
      ],
    });
    draws.push({
      page,
      view: group,
      colors,
      shade: effect,
      geometry: shape,
      factor: ints[23] ? 2 : 1,
    });
  }
  return draws;
}
export function paint(
  frame: Encoding,
  pipelines: Pipelines,
  target: Image,
  draws: readonly Draw[],
): number {
  const pass = frame.encoder.beginRenderPass({
    colorAttachments: [
      {
        view: (target.msaa ?? target.texture).texture.createView(),
        ...(target.msaa ? { resolveTarget: target.texture.texture.createView() } : {}),
        loadOp: target.fresh ? 'clear' : 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  let calls = 0;
  for (const draw of draws) {
    pass.setBindGroup(0, draw.page.bindGroup);
    pass.setBindGroup(1, draw.view);
    pass.setBindGroup(2, draw.colors);
    pass.setBindGroup(3, draw.shade);
    if (draw.geometry.count) {
      pass.setPipeline(draw.geometry.raw ? pipelines.raw : pipelines.envelope);
      pass.draw(6, draw.geometry.count * draw.factor);
      calls++;
    }
    if (draw.geometry.joinCount) {
      pass.setPipeline(pipelines.seams);
      pass.draw(6, draw.geometry.joinCount * draw.factor);
      calls++;
    }
  }
  pass.end();
  return calls;
}
export interface Screen {
  image: GPUBindGroup;
  axis: GPUBindGroup;
  cursor?: GPUBindGroup;
  text: readonly TextPage[];
  lines: number;
  grid: number;
}
export async function prepareScreen(
  gpu: Gpu,
  frame: Preparation,
  pipelines: Pipelines,
  history: Image,
  focus: Image,
  showHistory: boolean,
  showFocus: boolean,
  x: Domain,
  y: Domain,
  layout: Axes,
  settings: Settings,
  at: number | undefined,
): Promise<Screen> {
  const p = layout.plot,
    uniforms = new Float32Array(20);
  uniforms.set([frame.viewport.width, frame.viewport.height, 0, 0]);
  uniforms.set([p.x, p.y, p.width, p.height], 4);
  const dx = history.x[1] - history.x[0],
    dy = history.y[1] - history.y[0];
  uniforms.set(
    [
      (x[0] - history.x[0]) / dx,
      (history.y[1] - y[1]) / dy,
      (x[1] - x[0]) / dx,
      (y[1] - y[0]) / dy,
    ],
    8,
  );
  uniforms.set(settings.backgroundColor, 12);
  uniforms.set(
    [showFocus ? settings.unselectedAlpha : 1, showFocus ? 1 : 0, showHistory ? 1 : 0, 0],
    16,
  );
  const imageGroup = gpu.device.createBindGroup({
    layout: pipelines.image,
    entries: [
      { binding: 0, resource: frame.uniforms(uniforms) },
      { binding: 1, resource: frame.texture(history.texture).createView() },
      { binding: 2, resource: frame.texture(focus.texture).createView() },
      { binding: 3, resource: pipelines.sampler },
    ],
  });
  const cursor =
    at === undefined
      ? null
      : scaleValue(at, resolveScale({ range: [p.x, p.x + p.width], clamp: false }, x));
  const extra = cursor !== null && cursor >= p.x && cursor <= p.x + p.width ? 8 : 0;
  const makeAxis = (values: import('@latkit/gpu').BufferData) =>
    gpu.device.createBindGroup({
      layout: pipelines.axis,
      entries: [
        {
          binding: 0,
          resource: frame.uniforms(
            Float32Array.of(frame.viewport.width, frame.viewport.height, 0, 0),
          ),
        },
        { binding: 1, resource: frame.buffer(values) },
      ],
    });
  return {
    image: imageGroup,
    axis: makeAxis(layout.lines),
    cursor: extra
      ? makeAxis(
          buffer(
            Float32Array.of(cursor!, p.y, cursor!, p.y + p.height, ...settings.cursorColor),
            'monitor playhead',
          ),
        )
      : undefined,
    text: await frame.text({ runs: layout.runs }),
    lines: layout.lineCount,
    grid: layout.gridCount,
  };
}
export function composite(frame: Encoding, pipelines: Pipelines, screen: Screen): number {
  const pass = frame.encoder.beginRenderPass({
    colorAttachments: [
      {
        view: frame.target,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  pass.setPipeline(pipelines.background);
  pass.setBindGroup(0, screen.image);
  pass.draw(3);
  let calls = 1;
  if (screen.grid) {
    pass.setPipeline(pipelines.lines);
    pass.setBindGroup(1, screen.axis);
    pass.draw(6, screen.grid);
    calls++;
  }
  pass.setPipeline(pipelines.composite);
  pass.setBindGroup(0, screen.image);
  pass.draw(3);
  calls++;
  if (screen.lines) {
    pass.setPipeline(pipelines.lines);
    pass.setBindGroup(1, screen.axis);
    pass.draw(6, screen.lines, 0, screen.grid);
    calls++;
  }
  if (screen.cursor) {
    pass.setPipeline(pipelines.lines);
    pass.setBindGroup(1, screen.cursor);
    pass.draw(6, 1);
    calls++;
  }
  for (const text of screen.text) {
    pass.setPipeline(pipelines.text);
    pass.setBindGroup(0, text.bindGroup);
    pass.setBindGroup(1, screen.axis);
    pass.draw(6, text.count);
    calls++;
  }
  pass.end();
  return calls;
}
export function enroll(frame: Preparation, value: Image) {
  frame.texture(value.texture);
  if (value.msaa) frame.texture(value.msaa);
}
