import { type Gpu, type RGBA, kit } from '@latkit/gpu';
import { failure, rowCount, type Domain, type FieldsBlock } from '@latkit/model';
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
  readonly uniforms: Uint32Array;
  view?: GPUBindGroup;
  readonly colors: GPUBindGroup;
  readonly shade: GPUBindGroup;
  /** Instances: a line per row and frame step, two for stepped interpolation. */
  readonly instances: number;
}
/** A draw's view, in one 256-byte slot: its sizes, colors, plot, and interpolation, then six 32-byte channels. */
const VIEW_BYTES = 4 * 16 + 6 * 32;
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
      packed = new Uint32Array((chunk.length * stride) / 4);
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
  const { bound, channels } = trace,
    tint = bound.channels.color;
  const colors = frame.colormap(tint.colormap),
    interpolation = { linear: 0, 'step-before': 1, 'step-after': 2 }[
      trace.trace.interpolation ?? 'linear'
    ],
    base = Array.isArray(tint.constant)
      ? (tint.constant as RGBA)
      : Array.isArray(tint.missing)
        ? (tint.missing as RGBA)
        : style.traceColor,
    width = kit.resolveChannel(bound.channels.widthPx, channels.widthPx.scale, style.traceWidthPx);
  // The coordinate and values map onto the image as its window and values place them.
  const x: kit.ResolvedChannel = {
      component: 0,
      scale: kit.resolveScale({ clamp: false }, target.window),
      fallback: NaN,
    },
    y: kit.ResolvedChannel = {
      ...channels.y,
      scale: kit.resolveScale({ clamp: false }, target.values),
    },
    color = trace.colorFollows
      ? kit.resolveChannel(tint, kit.resolveScale({}, target.values), -1)
      : channels.color;
  const draws: Draw[] = [];
  let segments = 0;
  for (const page of pages) {
    const frames = page.samples!.count,
      rows = rowCount(page.rows);
    if (frames < 2 && !dots) continue;
    if (page.columns[y.column!]?.kind !== 'value')
      throw failure('invalid-input', 'Trace field must be scalar');
    const uniforms = new Uint32Array(VIEW_BYTES / 4),
      floats = new Float32Array(uniforms.buffer);
    floats.set(
      [target.width, target.height, frame.viewport.pixelRatio, focus ? style.selectedWidthPx : 0],
      0,
    );
    floats.set(base, 4);
    floats.set(
      focus
        ? style.selectedColor === 'none'
          ? [0, 0, 0, -1]
          : style.selectedColor
        : [0, 0, 0, -2],
      8,
    );
    floats.set([plot.x, plot.y], 12);
    uniforms[14] = interpolation;
    kit.writeChannel(uniforms, 16, x, page.samples!.coordinates);
    kit.writeChannel(uniforms, 24, y, page);
    kit.writeChannel(uniforms, 32, color, page);
    kit.writeChannel(uniforms, 40, width, page);
    kit.writeChannel(uniforms, 48, channels.visible, page);
    kit.writeChannel(uniforms, 56, channels.shade, page);
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
  /** Each text page's glyphs, with the axis group that holds its anchors. */
  readonly text: readonly {
    readonly axis: GPUBindGroup;
    readonly pages: readonly kit.TextPage[];
  }[];
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
  const screen = frame.uniforms(Float32Array.of(frame.viewport.width, frame.viewport.height, 0, 0));
  // Lines read no anchors, so their groups bind their own data there.
  const axis = (data: GPUBufferBinding, anchors = data) =>
    gpu.device.createBindGroup({
      layout: pipelines.axis,
      entries: [
        { binding: 0, resource: screen },
        { binding: 1, resource: data },
        { binding: 2, resource: anchors },
      ],
    });
  // Lines and the first page of text share one group, as one page holds every axis label.
  const lines = frame.buffer(layout.lines),
    labelled = layout.text.filter((page) => page.runs.length),
    first = axis(lines, labelled.length ? frame.buffer(labelled[0].anchors) : lines),
    text: Screen['text'][number][] = [];
  for (const [i, page] of labelled.entries())
    text.push({
      axis: i ? axis(lines, frame.buffer(page.anchors)) : first,
      pages: await frame.text({ runs: page.runs }),
    });
  return {
    image,
    axis: first,
    cursor:
      cursor !== null && cursor >= p.x && cursor <= p.x + p.width
        ? axis(
            frame.buffer(
              buffer(
                Float32Array.of(cursor, p.y, cursor, p.y + p.height, ...style.cursorColor),
                'monitor playhead',
              ),
            ),
          )
        : undefined,
    text,
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
  pass.setPipeline(pipelines.text);
  for (const { axis, pages } of screen.text) {
    pass.setBindGroup(1, axis);
    for (const page of pages) {
      pass.setBindGroup(0, page.bindGroup);
      pass.draw(6, page.count);
      calls++;
    }
  }
  pass.end();
  return calls;
}
/** Hold an image's textures until this frame's GPU work completes. */
export function enroll(frame: kit.Preparation, value: Image): void {
  frame.texture(value.texture);
  if (value.msaa) frame.texture(value.msaa);
}
