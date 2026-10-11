import { kit, type Gpu, type RGBA } from '@latkit/gpu';
import type { Style } from '../options.js';
import type { LabelBatch } from '../scene/labels.js';
import type { RecordStyles, Styled } from '../scene/records.js';
import type { Prepared } from '../scene/sources.js';
import type { ShapesBuffers } from '../scene/upload.js';
import { S, STYLE_FLOATS, type Pipelines } from './pipelines.js';

/** One record's shapes as a frame draws them: a level, the ranges of it in view, and their look. */
export interface ShapeDraw {
  readonly kind: 'area' | 'line';
  /** The record's type, which keys its draw's uniforms. */
  readonly type: string;
  readonly prepared: Prepared;
  readonly level: number;
  /** First and count pairs: triangle indices for areas, strip entries for lines. */
  readonly ranges: readonly number[];
  readonly styled: Styled;
  /** Each shape row's values row, where values come from another Data. */
  readonly map?: GPUBufferBinding;
  /** A bit per shape row, where any is selected. */
  readonly selection?: GPUBufferBinding;
  /** The hovered shape row, or NONE. */
  readonly hovered: number;
}
export interface Scene {
  readonly projector: kit.Projector;
  readonly style: Style;
  readonly light: kit.Light | null;
  /** Whether any row is selected, which fades the rest. */
  readonly selected: boolean;
  /** Areas, then lines, each in their records' order. */
  readonly shapes: readonly ShapeDraw[];
  readonly labels: readonly LabelBatch[];
  readonly pipelines: Pipelines;
  readonly shade: GPUBufferBinding;
  /** A host's scene block, bound in place of the view's own; a view on its own writes its own. */
  readonly hosted?: GPUBufferBinding;
  /** How long comets have moved for, in seconds; 0 holds them still. */
  readonly seconds: number;
}
export interface Paint {
  readonly pipelines: Pipelines;
  readonly frame: GPUBindGroup;
  readonly axis?: GPURenderPipeline;
  readonly records?: GPUComputePipeline;
  readonly text?: GPURenderPipeline;
  readonly shapes: readonly {
    readonly kind: 'area' | 'line';
    readonly group: GPUBindGroup;
    readonly index?: GPUBuffer;
    readonly ranges: readonly number[];
  }[];
  readonly labels: readonly {
    readonly group: GPUBindGroup;
    readonly pages: readonly kit.TextPage[];
  }[];
  readonly styled: readonly Styled[];
  readonly color?: GPUTextureView;
  readonly depth?: GPUTextureView;
  readonly drawCalls: number;
  /** Vertices and triangles the frame's shapes draw. */
  readonly drawn: { readonly vertices: number; readonly triangles: number };
}
const NONE = 0xffffffff;
const DRAW_WORDS = 16;

/**
 * What a frame binds and draws. A frame where only the camera moved uploads nothing of its own
 * when hosted: the scene block is the host's, and the style and every draw's uniforms upload only
 * the words that change.
 */
export class Painter {
  private readonly attachments: kit.Attachments;
  private readonly empty: kit.BufferResource;
  private readonly style = new kit.BufferData({
    size: STYLE_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM,
    label: 'geography style',
  });
  private readonly styleWords = new Float32Array(STYLE_FLOATS);
  /** Each record's draw uniforms, by the shapes it draws and its kind and type. */
  private readonly draws = new WeakMap<ShapesBuffers, Map<string, kit.BufferData>>();
  /** Bind groups by the buffers they bind, kept while frames bind them. */
  private groups = new Map<string, GPUBindGroup>();
  private readonly ids = new WeakMap<object, number>();
  private serial = 0;
  constructor(
    private readonly gpu: Gpu,
    private readonly records: RecordStyles,
  ) {
    this.attachments = new kit.Attachments(gpu);
    this.empty = gpu.buffer({ size: 32, usage: GPUBufferUsage.STORAGE, label: 'geography empty' });
  }
  /** A number naming an object, for keys. */
  private id(object: object): number {
    let id = this.ids.get(object);
    if (id === undefined) this.ids.set(object, (id = ++this.serial));
    return id;
  }
  /** A binding's buffer and range, as a key. */
  private key(binding: GPUBufferBinding): string {
    return `${this.id(binding.buffer)}:${binding.offset ?? 0}:${binding.size ?? ''}`;
  }
  /** Bind what a frame draws. A frame on its own makes its attachments; a hosted one draws in its host's. */
  async prepare(frame: kit.Preparation, scene: Scene): Promise<Paint> {
    const { gpu } = this,
      { projector, style, pipelines } = scene,
      camera = projector.camera,
      standalone = !scene.hosted;
    const { color, depth } = standalone
      ? this.attachments.prepare(frame, { msaa: pipelines.msaa, depth: 'depth32float' })
      : { color: undefined, depth: undefined };
    let sceneBinding = scene.hosted;
    if (!sceneBinding) {
      const block = new Float32Array(kit.Projector.scene);
      projector.write(block, 0, true, 0);
      kit.Projector.light(block, kit.Projector.floats, scene.light);
      sceneBinding = frame.uniforms(block);
    }
    const s = this.styleWords;
    s.set(style.surfaceColor, S.surface);
    s.set(style.grid ? style.gridColor : [0, 0, 0, 0], S.gridColor);
    s.set(style.atmosphere ? style.atmosphereColor : [0, 0, 0, 0], S.atmosphere);
    s.set(style.hoverColor, S.hover);
    s.set(style.selectedColor === 'none' ? [0, 0, 0, -1] : style.selectedColor, S.selected);
    s.set(
      [
        style.hoverWidthPx,
        style.selectedWidthPx,
        scene.selected ? style.unselectedAlpha : 1,
        style.dashPeriodPx,
      ],
      S.glow,
    );
    s.set([...style.surfaceColor.slice(0, 3), style.labelHaloPx], S.halo);
    s.set(style.earthAxisColor, S.axis);
    s.set(style.flowColor, S.flow);
    s.set([style.flowSpacingPx, scene.seconds, 0, 0], S.motion);
    s.set(kit.gridLines(camera, style.gridMinSpacingPx, true), S.grid);
    this.style.update(s);
    const styleBinding = frame.buffer(this.style),
      empty = frame.buffer(this.empty),
      used = new Map<string, GPUBindGroup>();
    /** A bind group, made once while the buffers it binds stay. */
    const group = (layout: GPUBindGroupLayout, entries: readonly GPUBufferBinding[]) => {
      const key = `${this.id(layout)}|${entries.map((e) => this.key(e)).join('|')}`;
      let found = used.get(key) ?? this.groups.get(key);
      if (!found)
        found = gpu.device.createBindGroup({
          layout,
          entries: entries.map((resource, binding) => ({ binding, resource })),
        });
      used.set(key, found);
      return found;
    };
    let vertices = 0,
      triangles = 0;
    const shapes = scene.shapes.map((draw) => {
      const { prepared, styled, kind } = draw,
        level = prepared.buffers.level(draw.level),
        c = styled.constant,
        words = new Uint32Array(DRAW_WORDS),
        floats = new Float32Array(words.buffer);
      floats.set(c.color, 0);
      floats.set([c.width, c.shade, (c.visible ? 1 : 0) + (c.dash ? 2 : 0), c.flow], 4);
      words.set(
        [styled.records ? 1 : 0, draw.map ? 1 : 0, draw.hovered, draw.selection ? 1 : 0],
        8,
      );
      words[12] = prepared.shapes.levels[draw.level].strips.length;
      let byRecord = this.draws.get(prepared.buffers);
      if (!byRecord)
        this.draws.set(prepared.buffers, (byRecord = new Map<string, kit.BufferData>()));
      const name = `${kind}\u0000${draw.type}`;
      let uniform = byRecord.get(name);
      if (!uniform)
        byRecord.set(
          name,
          (uniform = new kit.BufferData({
            size: DRAW_WORDS * 4,
            usage: GPUBufferUsage.UNIFORM,
            label: 'geography draw',
          })),
        );
      uniform.update(words);
      for (let i = 1; i < draw.ranges.length; i += 2)
        if (kind === 'area') {
          triangles += draw.ranges[i] / 3;
          vertices += draw.ranges[i];
        } else vertices += draw.ranges[i] * 2;
      return {
        kind,
        index: kind === 'area' ? frame.buffer(level.triangles).buffer : undefined,
        ranges: draw.ranges,
        group: group(pipelines.shapes, [
          frame.buffer(prepared.buffers.vertices),
          frame.buffer(prepared.buffers.origins),
          styled.records ?? empty,
          draw.map ?? empty,
          draw.selection ?? empty,
          kind === 'line' ? frame.buffer(level.strips) : empty,
          kind === 'line' ? frame.buffer(level.along) : empty,
          frame.buffer(uniform),
        ]),
      };
    });
    const labels: { group: GPUBindGroup; pages: readonly kit.TextPage[] }[] = [];
    for (const { runs, anchors } of scene.labels)
      if (runs.length)
        labels.push({
          pages: await frame.text({ runs }),
          group: group(pipelines.label, [sceneBinding, frame.buffer(anchors), styleBinding]),
        });
    this.groups = used;
    const showsAxis = camera.projection === 'globe' && style.earthAxis,
      computes = scene.shapes.some((s) => s.styled.dispatches.length);
    const [axis, records, text] = await Promise.all([
      showsAxis ? pipelines.axis() : undefined,
      computes ? pipelines.records() : undefined,
      labels.length ? pipelines.text() : undefined,
    ]);
    return {
      pipelines,
      frame: gpu.device.createBindGroup({
        layout: pipelines.frame,
        entries: [
          { binding: 0, resource: sceneBinding },
          { binding: 1, resource: scene.shade },
          { binding: 2, resource: styleBinding },
        ],
      }),
      axis,
      records,
      text,
      shapes,
      labels,
      styled: scene.shapes.map((s) => s.styled),
      color,
      depth,
      drawn: { vertices, triangles },
      drawCalls:
        1 +
        (axis ? 1 : 0) +
        shapes.reduce((n, s) => n + s.ranges.length / 2, 0) +
        labels.reduce((n, l) => n + l.pages.length, 0),
    };
  }
  /** Compute the records the frame's draws read, before any pass. */
  compute(encoder: GPUCommandEncoder, paint: Paint): void {
    if (paint.records) this.records.encode(encoder, paint.records, paint.styled);
  }
  /** Draw into a pass: the ground, areas, lines, then labels. */
  draw(pass: GPURenderPassEncoder, paint: Paint): void {
    const p = paint.pipelines;
    pass.setPipeline(p.ground);
    pass.setBindGroup(0, paint.frame);
    pass.draw(3);
    if (paint.axis) {
      pass.setPipeline(paint.axis);
      pass.draw(6);
    }
    let bound: GPURenderPipeline | undefined;
    for (const shape of paint.shapes) {
      const pipeline = shape.kind === 'area' ? p.areas : p.lines;
      if (pipeline !== bound) pass.setPipeline((bound = pipeline));
      pass.setBindGroup(1, shape.group);
      if (shape.index) {
        pass.setIndexBuffer(shape.index, 'uint32');
        for (let i = 0; i < shape.ranges.length; i += 2)
          pass.drawIndexed(shape.ranges[i + 1], 1, shape.ranges[i]);
      } else
        for (let i = 0; i < shape.ranges.length; i += 2)
          pass.draw(shape.ranges[i + 1] * 2, 1, shape.ranges[i] * 2);
    }
    if (paint.text) {
      pass.setPipeline(paint.text);
      for (const label of paint.labels) {
        pass.setBindGroup(0, label.group);
        for (const page of label.pages) {
          pass.setBindGroup(1, page.bindGroup);
          pass.draw(6, page.count);
        }
      }
    }
  }
  /** A frame on its own: its records, then one pass over its own attachments. */
  encode(frame: kit.Encoding, paint: Paint, background: RGBA): void {
    this.compute(frame.encoder, paint);
    const pass = frame.encoder.beginRenderPass({
      label: 'geography',
      colorAttachments: [
        {
          view: paint.color ?? frame.target,
          resolveTarget: paint.color ? frame.target : undefined,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: kit.clearColor(background),
        },
      ],
      depthStencilAttachment: {
        view: paint.depth!,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    this.draw(pass, paint);
    pass.end();
  }
  destroy(): void {
    this.attachments.destroy();
    this.empty.destroy();
    this.groups.clear();
  }
}
export { NONE };
