import { type Gpu, kit } from '@latkit/gpu';
import { rowCount, type Domain, type FieldsBlock } from '@latkit/model';
import type { Binding } from '../bindings.js';
import type { Style } from '../config.js';
import type { Axes, Plot } from '../axes.js';
import type { Pipelines } from './pipelines.js';

/** What decides an image's pixels. */
export interface Transform {
  readonly width: number;
  readonly height: number;
  readonly window: Domain;
  readonly values: Domain;
  /** Changes with the traces, their style, and the shade. */
  readonly generation: number;
}
/** How far a trace is drawn into an image. */
export interface Progress {
  /** The last absolute frame drawn for every row; the next lines start from it. */
  readonly through?: number;
  /** A chunk drawn for its first `rows` rows, which finishes before anything later. */
  readonly chunk?: { readonly start: number; readonly frames: number; readonly rows: number };
}
/** History pixels for one transform, and how far each trace is drawn into them. */
export interface Image extends Transform {
  readonly texture: kit.TextureResource;
  readonly msaa?: kit.TextureResource;
  readonly progress: Map<string, Progress>;
  /** Cleared by its first pass. */
  fresh: boolean;
}
export function sameTransform(a: Transform | undefined, b: Transform): boolean {
  return (
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.generation === b.generation &&
    a.window[0] === b.window[0] &&
    a.window[1] === b.window[1] &&
    a.values[0] === b.values[0] &&
    a.values[1] === b.values[1]
  );
}
export function image(gpu: Gpu, transform: Transform, msaa: 1 | 4): Image {
  const size = [transform.width, transform.height];
  const texture = gpu.texture({
    size,
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.COPY_DST,
  });
  try {
    return {
      ...transform,
      texture,
      msaa:
        msaa === 4
          ? gpu.texture({
              size,
              format: 'rgba8unorm',
              sampleCount: 4,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
          : undefined,
      progress: new Map(),
      fresh: true,
    };
  } catch (error) {
    texture.destroy();
    throw error;
  }
}
export function destroyImage(value?: Image): void {
  value?.texture.destroy();
  value?.msaa?.destroy();
}
export function imageBytes(value: Pick<Image, 'width' | 'height' | 'msaa'>): number {
  return value.width * value.height * 4 * (value.msaa ? 5 : 1);
}
export function buffer(values: ArrayBufferView, label: string): kit.BufferData {
  const data = new kit.BufferData({ size: Math.max(16, values.byteLength), label });
  if (values.byteLength) data.write({ data: values });
  return data;
}

export interface Draw {
  readonly page: kit.GpuPage;
  /** This draw's view uniforms, bound by `bindDraws`. */
  readonly uniforms: Float32Array;
  view?: GPUBindGroup;
  readonly colors: GPUBindGroup;
  readonly shade: GPUBindGroup;
  /** Instances: a line per row and frame step, two for stepped interpolation. */
  readonly instances: number;
}
const VIEW_BYTES = 224;
/** Bind every draw's uniforms from shared buffers: one per buffer's worth of draws, not one each. */
export function bindDraws(
  gpu: Gpu,
  frame: kit.Preparation,
  pipelines: Pipelines,
  draws: readonly Draw[],
): void {
  const limits = gpu.device.limits,
    stride =
      Math.ceil(VIEW_BYTES / limits.minUniformBufferOffsetAlignment) *
      limits.minUniformBufferOffsetAlignment,
    per = Math.max(1, Math.floor(limits.maxUniformBufferBindingSize / stride));
  for (let first = 0; first < draws.length; first += per) {
    const chunk = draws.slice(first, first + per),
      packed = new Float32Array((chunk.length * stride) / 4);
    chunk.forEach((draw, i) => packed.set(draw.uniforms, (i * stride) / 4));
    const binding = frame.uniforms(packed);
    chunk.forEach((draw, i) => {
      draw.view = gpu.device.createBindGroup({
        layout: pipelines.view,
        entries: [
          {
            binding: 0,
            resource: {
              buffer: binding.buffer,
              offset: (binding.offset ?? 0) + i * stride,
              size: VIEW_BYTES,
            },
          },
        ],
      });
    });
  }
}
/**
 * Draws for one block of a trace: a line per row through every frame of each GPU page, whose
 * pages keep all frames of their rows. A single frame draws a dot only when `dots` is set.
 */
export function traceDraws(
  gpu: Gpu,
  frame: kit.Preparation,
  pipelines: Pipelines,
  block: FieldsBlock,
  trace: Binding,
  target: Image,
  plot: Plot,
  style: Style,
  focus: boolean,
  shade: GPUBindGroup,
  dots: boolean,
): { readonly draws: Draw[]; readonly segments: number } {
  const pages = frame.upload(block, {
    select: Object.keys(block.columns),
    float64: 'relative',
    maxPageBytes: 256 * 1024,
  });
  const colors = frame.colormap(trace.trace.color?.colormap),
    colorDomain = trace.colorDomain ?? target.values,
    interpolation = { linear: 0, 'step-before': 1, 'step-after': 2 }[
      trace.trace.interpolation ?? 'linear'
    ],
    width = trace.trace.widthPx ?? 1.25;
  const draws: Draw[] = [];
  let segments = 0;
  for (const page of pages) {
    const frames = page.samples!.count,
      rows = rowCount(page.rows);
    if (frames < 2 && !dots) continue;
    const value = page.columns.value,
      coordinate = page.samples!.coordinates,
      color = page.columns.color,
      shaded = page.columns.shade,
      visible = page.columns.visible;
    if (value.kind !== 'value') throw new Error('Trace field must be scalar');
    const uniforms = new Float32Array(56),
      ints = new Uint32Array(uniforms.buffer);
    uniforms.set([target.width, target.height, plot.width, plot.height], 0);
    uniforms.set(trace.trace.baseColor ?? [0.23, 0.72, 0.88, 0.7], 4);
    uniforms.set(focus && style.selectedColor ? style.selectedColor : [0, 0, 0, -1], 8);
    uniforms.set(
      [
        focus ? Math.max(width, style.selectedWidthPx) : width,
        focus ? 1 : 0,
        frame.viewport.pixelRatio,
        trace.trace.color ? 1 : 0,
      ],
      12,
    );
    ints.set(
      [
        value.slot,
        coordinate.slot,
        color?.kind === 'value' ? color.slot : 0xffffffff,
        shaded?.kind === 'value' ? shaded.slot : 0xffffffff,
      ],
      16,
    );
    ints.set(
      [
        visible?.kind === 'value' ? visible.slot : 0xffffffff,
        visible?.kind === 'value' && visible.type === 'boolean' ? 1 : 0,
        interpolation,
        0,
      ],
      20,
    );
    ints.set([rows, frames, 0, 0], 24);
    uniforms.set([shaded?.kind === 'value' ? (shaded.origin?.[0] ?? 0) : 0, 0, plot.x, plot.y], 28);
    const scale = (at: number, domain: Domain, origin: number | undefined, clamp = false) =>
      uniforms.set(
        kit.scaleParameters(kit.resolveScale({ clamp }, domain), { origin: origin ?? 0 }),
        at,
      );
    scale(32, target.window, coordinate.origin?.[0]);
    scale(40, target.values, value.origin?.[0]);
    scale(48, colorDomain, color?.kind === 'value' ? color.origin?.[0] : 0, true);
    const steps = rows * Math.max(1, frames - 1);
    segments += steps;
    draws.push({
      page,
      uniforms,
      colors,
      shade,
      instances: steps * (interpolation ? 2 : 1),
    });
  }
  return { draws, segments };
}
/** Draw onto an image, clearing it first when fresh. */
export function paint(
  frame: kit.Encoding,
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
  pass.setPipeline(pipelines.trace);
  for (const draw of draws) {
    pass.setBindGroup(0, draw.page.bindGroup);
    pass.setBindGroup(1, draw.view!);
    pass.setBindGroup(2, draw.colors);
    pass.setBindGroup(3, draw.shade);
    pass.draw(6, draw.instances);
  }
  pass.end();
  return draws.length;
}

export interface Screen {
  readonly image: GPUBindGroup;
  readonly axis: GPUBindGroup;
  readonly cursor?: GPUBindGroup;
  readonly text: readonly kit.TextPage[];
  readonly lines: number;
  readonly grid: number;
}
/** Where an image's pixels fall in the camera's plot: offset and scale of its uv per plot uv. */
function mapping(image: Transform, window: Domain, values: Domain): readonly number[] {
  const iw = image.window[1] - image.window[0],
    iv = image.values[1] - image.values[0];
  return [
    (window[0] - image.window[0]) / iw,
    (image.values[1] - values[1]) / iv,
    (window[1] - window[0]) / iw,
    (values[1] - values[0]) / iv,
  ];
}
export async function prepareScreen(
  gpu: Gpu,
  frame: kit.Preparation,
  pipelines: Pipelines,
  history: Image,
  focus: Image | undefined,
  window: Domain,
  values: Domain,
  layout: Axes,
  style: Style,
  at: number | undefined,
): Promise<Screen> {
  const p = layout.plot,
    uniforms = new Float32Array(24);
  uniforms.set([frame.viewport.width, frame.viewport.height, 0, 0]);
  uniforms.set([p.x, p.y, p.width, p.height], 4);
  uniforms.set(mapping(history, window, values), 8);
  uniforms.set(focus ? mapping(focus, window, values) : [0, 0, 1, 1], 12);
  uniforms.set(style.background, 16);
  uniforms.set([focus ? style.unselectedAlpha : 1, focus ? 1 : 0, 1, 0], 20);
  const image = gpu.device.createBindGroup({
    layout: pipelines.image,
    entries: [
      { binding: 0, resource: frame.uniforms(uniforms) },
      { binding: 1, resource: frame.texture(history.texture).createView() },
      { binding: 2, resource: frame.texture((focus ?? history).texture).createView() },
      { binding: 3, resource: pipelines.sampler },
    ],
  });
  const cursor =
    at === undefined
      ? null
      : kit.scaleValue(at, kit.resolveScale({ range: [p.x, p.x + p.width], clamp: false }, window));
  const axis = (data: kit.BufferData) =>
    gpu.device.createBindGroup({
      layout: pipelines.axis,
      entries: [
        {
          binding: 0,
          resource: frame.uniforms(
            Float32Array.of(frame.viewport.width, frame.viewport.height, 0, 0),
          ),
        },
        { binding: 1, resource: frame.buffer(data) },
      ],
    });
  return {
    image,
    axis: axis(layout.lines),
    cursor:
      cursor !== null && cursor >= p.x && cursor <= p.x + p.width
        ? axis(
            buffer(
              Float32Array.of(cursor, p.y, cursor, p.y + p.height, ...style.cursorColor),
              'monitor playhead',
            ),
          )
        : undefined,
    text: await frame.text({ runs: layout.runs }),
    lines: layout.lineCount,
    grid: layout.gridCount,
  };
}
export function composite(frame: kit.Encoding, pipelines: Pipelines, screen: Screen): number {
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
/** Hold an image's textures until this frame's GPU work completes. */
export function enroll(frame: kit.Preparation, value: Image): void {
  frame.texture(value.texture);
  if (value.msaa) frame.texture(value.msaa);
}
