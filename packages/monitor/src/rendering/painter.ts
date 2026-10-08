import { type Gpu, kit } from '@latkit/gpu';
import { failure, rowCount, type Domain, type FieldsBlock } from '@latkit/model';
import type { Binding, Look } from '../bindings.js';
import type { Style } from '../config.js';
import type { Axes, Plot } from '../axes.js';
import {
  baking,
  domainOf,
  type Image,
  type Layer,
  type LayerKind,
  type Transform,
} from './history.js';
import type { Lines, Pipelines } from './pipelines.js';

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
  readonly shade: GPUBindGroup;
  /** The colormap of a look baked into a color layer. */
  readonly colors?: GPUBindGroup;
  /** Instances: a line per row and frame step, two for stepped interpolation. */
  readonly instances: number;
  /** The first instance: past a page's first frame when it only shows where lines came from. */
  readonly first: number;
  /** Selected lines, which draw with their glow. */
  readonly focus: boolean;
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
 * Draws for one block of a trace into a layer: a line per row through every frame of each GPU
 * page, whose pages keep all frames of their rows. A single frame draws a dot only when `dots` is set.
 * With `context`, the block's first frame only shows where the lines drawn before came from.
 */
export function traceDraws(
  frame: kit.Preparation,
  block: FieldsBlock,
  trace: Binding,
  target: Image,
  layer: Layer,
  plot: Plot,
  style: Style,
  focus: boolean,
  shade: GPUBindGroup,
  dots: boolean,
  context = false,
): { readonly draws: Draw[]; readonly segments: number } {
  const pages = frame.upload(block, {
    select: Object.keys(block.columns),
    float64: 'relative',
    maxPageBytes: 256 * 1024,
  });
  const { bound, channels } = trace,
    interpolation = { linear: 0, 'step-before': 1, 'step-after': 2 }[
      trace.trace.interpolation ?? 'linear'
    ],
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
    // A value layer stores color values against its domain, unclamped; a color layer baking a look
    // maps them through it. Rows without one read NaN.
    baked = layer.kind === 'color' && baking(trace),
    color: kit.ResolvedChannel = {
      ...kit.resolveChannel(
        bound.channels.color,
        layer.kind === 'value'
          ? kit.resolveScale({ clamp: false }, layer.stored)
          : baked
            ? kit.resolveScale({ clamp: trace.look.clamp }, domainOf(trace.look, target))
            : null,
        NaN,
      ),
      fallback: NaN,
    },
    colors = baked ? frame.colormap(trace.look.colormap) : undefined;
  const draws: Draw[] = [];
  let segments = 0;
  for (const page of pages) {
    const frames = page.samples!.count,
      rows = rowCount(page.rows),
      skip = context && page.samples!.firstFrame === block.samples!.firstFrame ? 1 : 0,
      steps = rows * (Math.max(1, frames - 1) - skip);
    if ((frames < 2 && !dots) || steps <= 0) continue;
    if (page.columns[y.column!]?.kind !== 'value')
      throw failure('invalid-input', 'Trace field must be scalar');
    const uniforms = new Uint32Array(VIEW_BYTES / 4),
      floats = new Float32Array(uniforms.buffer);
    floats.set(
      [target.width, target.height, frame.viewport.pixelRatio, focus ? style.selectedWidthPx : 0],
      0,
    );
    floats.set(trace.look.base ?? style.traceColor, 4);
    floats.set(
      focus
        ? style.selectedColor === 'none'
          ? [0, 0, 0, -1]
          : style.selectedColor
        : [0, 0, 0, -2],
      8,
    );
    floats.set([plot.x, plot.y], 12);
    // A page that joins lines drawn before draws no dot at its first frame; one that starts a frame
    // earlier draws nothing from that frame, which only shows where they came from.
    uniforms[14] = interpolation | (dots ? 0 : 4) | (skip ? 8 : 0);
    kit.writeChannel(uniforms, 16, x, page.samples!.coordinates);
    kit.writeChannel(uniforms, 24, y, page);
    kit.writeChannel(uniforms, 32, color, page);
    kit.writeChannel(uniforms, 40, width, page);
    kit.writeChannel(uniforms, 48, channels.visible, page);
    kit.writeChannel(uniforms, 56, channels.shade, page);
    const factor = interpolation ? 2 : 1;
    segments += steps;
    draws.push({
      page,
      uniforms,
      shade,
      colors,
      instances: steps * factor,
      first: rows * skip * factor,
      focus,
    });
  }
  return { draws, segments };
}
/** Draw into a layer, clearing it first when fresh; selected lines draw with `focus`. */
export function paint(
  frame: kit.Encoding,
  pipelines: Pipelines,
  layer: Layer,
  draws: readonly Draw[],
  focus?: Lines,
): number {
  const pass = frame.encoder.beginRenderPass({
    colorAttachments: [
      {
        view: (layer.msaa ?? layer.texture).texture.createView(),
        ...(layer.msaa ? { resolveTarget: layer.texture.texture.createView() } : {}),
        loadOp: layer.fresh ? 'clear' : 'load',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  let pipeline: GPURenderPipeline | undefined;
  for (const draw of draws) {
    const lines = draw.focus ? focus! : pipelines,
      next = draw.colors ? lines.bake : lines.draw[layer.kind];
    if (next !== pipeline) pass.setPipeline((pipeline = next));
    pass.setBindGroup(0, draw.page.bindGroup);
    pass.setBindGroup(1, draw.view!);
    pass.setBindGroup(2, draw.shade);
    if (draw.colors) pass.setBindGroup(3, draw.colors);
    pass.draw(6, draw.instances, 0, draw.first);
  }
  pass.end();
  return draws.length;
}

/** A layer the screen shows, and how. */
export interface Composited {
  readonly image: Image;
  readonly layer: Layer;
  readonly look: Look;
  /** Drawn as selected, over the rest. */
  readonly focus: boolean;
  /** Its opacity: the rest fade while something is selected. */
  readonly alpha: number;
}
export interface Screen {
  /** The background, premultiplied, which the pass clears to. */
  readonly background: GPUColor;
  /** Each shown layer in draw order: its kind, image group, and the colormap of one a look maps. */
  readonly layers: readonly {
    readonly kind: LayerKind;
    readonly image: GPUBindGroup;
    readonly colors?: GPUBindGroup;
  }[];
  readonly shade: GPUBindGroup;
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
/**
 * Where a value from 0 to 1 across `stored` falls in the colormap of `domain`: x·value + y; z
 * colors, w clamps. `stored` may run either way.
 */
function remap(
  stored: readonly [number, number],
  domain: Domain | null,
  clamp: boolean,
): readonly number[] {
  if (!domain) return [0, 0, 0, 0];
  const span = domain[1] - domain[0],
    clamps = clamp ? 1 : 0;
  // A domain of one value colors everything at its middle, as a scale does.
  if (!(span > 0)) return [0, 0.5, 1, clamps];
  return [(stored[1] - stored[0]) / span, (stored[0] - domain[0]) / span, 1, clamps];
}
export async function prepareScreen(
  gpu: Gpu,
  frame: kit.Preparation,
  pipelines: Pipelines,
  layers: readonly Composited[],
  window: Domain,
  values: Domain,
  layout: Axes,
  style: Style,
  at: number | undefined,
  shade: GPUBindGroup,
): Promise<Screen> {
  const p = layout.plot,
    selected = style.selectedColor === 'none' ? [0, 0, 0, -1] : style.selectedColor;
  const shown = layers.map((entry) => {
    const uniforms = new Float32Array(24),
      // The values axis a look follows is the camera's, wherever the image was drawn.
      domain = entry.look.domain === 'values' ? values : domainOf(entry.look, entry.image);
    uniforms.set([
      frame.viewport.width,
      frame.viewport.height,
      frame.viewport.pixelRatio,
      entry.alpha,
    ]);
    uniforms.set([p.x, p.y, p.width, p.height], 4);
    uniforms.set(mapping(entry.image, window, values), 8);
    uniforms.set(entry.look.base ?? style.traceColor, 12);
    uniforms.set(entry.focus ? selected : [0, 0, 0, -2], 16);
    // A coverage layer's value is the camera's at its height in the plot, from top to bottom.
    uniforms.set(
      remap(
        entry.layer.kind === 'coverage' ? [values[1], values[0]] : entry.layer.stored,
        domain,
        entry.look.clamp,
      ),
      20,
    );
    return {
      kind: entry.layer.kind,
      image: gpu.device.createBindGroup({
        layout: pipelines.image,
        entries: [
          { binding: 0, resource: frame.uniforms(uniforms) },
          { binding: 1, resource: frame.texture(entry.layer.texture).createView() },
          { binding: 2, resource: pipelines.sampler },
        ],
      }),
      ...(entry.layer.kind !== 'color' && { colors: frame.colormap(entry.look.colormap) }),
    };
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
  const [r, g, b, a] = style.background;
  return {
    background: { r: r * a, g: g * a, b: b * a, a },
    layers: shown,
    shade,
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
      { view: frame.target, loadOp: 'clear', storeOp: 'store', clearValue: screen.background },
    ],
  });
  let calls = 0,
    kind: LayerKind | undefined;
  // Lines read nothing in group 0, which they bind all the same.
  pass.setBindGroup(0, pipelines.none);
  if (screen.grid) {
    pass.setPipeline(pipelines.lines);
    pass.setBindGroup(1, screen.axis);
    pass.draw(6, screen.grid);
    calls++;
  }
  pass.setBindGroup(2, screen.shade);
  for (const layer of screen.layers) {
    if (layer.kind !== kind) pass.setPipeline(pipelines.compose[(kind = layer.kind)]);
    pass.setBindGroup(0, layer.image);
    if (layer.colors) pass.setBindGroup(1, layer.colors);
    pass.draw(3);
    calls++;
  }
  pass.setBindGroup(0, pipelines.none);
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
