import { kit, type Gpu, type RGBA } from '@latkit/gpu';
import type { DiagramData, DiagramItem, Point } from './data.js';
import { itemKey } from './data.js';
import type { Scene, Rect, Vertex, Wire } from './scene.js';
import { intersects, itemSlots } from './scene.js';
import type { Style } from './config.js';
import type { DragDraw } from './drag.js';
import { labelBox } from './geometry.js';
import { Styles, type StyleFrame } from './styles.js';
import shader from './painter.wgsl';
import styleShader from './styles.wgsl';

/** What each instance draws; the shader branches on it. */
const KIND = {
  block: 0,
  group: 1,
  segment: 2,
  corner: 3,
  arrow: 4,
  port: 5,
  junction: 6,
  label: 7,
  box: 8,
  preview: 9,
} as const;
/** Words per instance: two vec4s of geometry, its kind, and its slot. */
const WORDS = 12;
/** Instances per page: a page's own origin keeps its float32 positions precise. */
const PAGE = 16384;
/** No item: overlay and preview instances, which no focus or style reaches. */
const NONE = 0xffffffff;
const SHAPES = ['rounded', 'rectangle', 'ellipse', 'diamond'] as const;
/** Up to a page of instances about one origin, and the box they cover for culling. */
interface InstancePage {
  bounds: Rect;
  origin: Point;
  data: kit.BufferData;
  count: number;
}
interface Geometry {
  instances: InstancePage[];
  text: readonly kit.TextBankPage[];
  focus: kit.BufferData;
  /** Each slot's flags, as last written. */
  states: Map<number, number>;
}
export interface Pipelines {
  shapes: GPURenderPipeline;
  text: GPURenderPipeline;
  grid: GPURenderPipeline;
  styles: GPUComputePipeline;
  layout: GPUBindGroupLayout;
  styleLayout: GPUBindGroupLayout;
}
export interface Overlay {
  readonly box?: readonly [number, number, number, number];
  readonly wire?: readonly Point[];
  readonly compatible?: readonly DiagramItem[];
  readonly target?: DiagramItem | null;
  readonly muted?: string;
  readonly invalid?: boolean;
}
/** What one frame draws. */
export interface DrawState {
  readonly scene: Scene;
  readonly data: DiagramData;
  readonly style: Style;
  readonly camera: kit.Camera2D;
  /** Replaced whenever it changes. */
  readonly selection: readonly DiagramItem[];
  readonly hover: DiagramItem | null;
  readonly pipelines: Pipelines;
  /** The shade's uniforms for this frame. */
  readonly shade: GPUBufferBinding;
  readonly overlay: Overlay | null;
  /** A drag drawn over the scene: what it moves, how far, and its rerouted wires. */
  readonly drag: DragDraw | null;
  /** Flow animates; false under reduced motion. */
  readonly motion: boolean;
}
export interface Paint {
  pipelines: Pipelines;
  restyle: StyleFrame;
  shapes: { group: GPUBindGroup; count: number }[];
  text: { group: GPUBindGroup; pages: readonly kit.TextPage[] }[];
  grid: GPUBindGroup;
  msaa?: GPUTextureView;
  background: RGBA;
  drawCalls: number;
}
/** The kinds as WGSL constants, ahead of the shader that branches on them. */
const kinds = Object.entries(KIND)
  .map(([name, value]) => `const ${name.toUpperCase()}: u32 = ${value}u;`)
  .join('\n');
/** Instances written straight into typed storage, a page at a time. */
class Instances {
  readonly pages: InstancePage[] = [];
  private readonly f = new Float32Array(WORDS * PAGE);
  private readonly u = new Uint32Array(this.f.buffer);
  private used = 0;
  private origin: Point = [0, 0];
  private bounds = [Infinity, Infinity, -Infinity, -Infinity];
  constructor(
    private readonly label: string,
    private readonly previous?: readonly InstancePage[],
  ) {}
  /**
   * An instance: `a` and `b` in diagram units, its first point (and a segment's second) made
   * relative to the page's origin, and the box it covers for culling.
   */
  push(kind: number, slot: number, a: readonly number[], b: readonly number[], box: Rect): void {
    if (this.used === PAGE) this.flush();
    if (!this.used) this.origin = this.previous?.[this.pages.length]?.origin ?? [a[0], a[1]];
    const at = this.used++ * WORDS,
      [ox, oy] = this.origin,
      two = kind === KIND.segment || kind === KIND.preview;
    this.f[at] = a[0] - ox;
    this.f[at + 1] = a[1] - oy;
    this.f[at + 2] = two ? a[2] - ox : a[2];
    this.f[at + 3] = two ? a[3] - oy : a[3];
    this.f[at + 4] = b[0] ?? 0;
    this.f[at + 5] = b[1] ?? 0;
    this.f[at + 6] = b[2] ?? 0;
    this.f[at + 7] = b[3] ?? 0;
    this.u[at + 8] = kind;
    this.u[at + 9] = slot;
    const r = this.bounds;
    r[0] = Math.min(r[0], box[0]);
    r[1] = Math.min(r[1], box[1]);
    r[2] = Math.max(r[2], box[2]);
    r[3] = Math.max(r[3], box[3]);
  }
  /** The pages written; a page that holds what it held before uploads nothing. */
  flush(): InstancePage[] {
    if (this.used) {
      const data =
        this.previous?.[this.pages.length]?.data ??
        new kit.BufferData({ size: 4, label: this.label });
      data.update(this.u.subarray(0, this.used * WORDS));
      this.pages.push({
        origin: this.origin,
        bounds: this.bounds as unknown as Rect,
        data,
        count: this.used,
      });
      this.used = 0;
      this.bounds = [Infinity, Infinity, -Infinity, -Infinity];
    }
    return this.pages;
  }
}
/** A wire's instances: segments that end where their bends' arcs begin, arrows, and junctions. */
function wire(instances: Instances, slot: number, drawn: Wire, radius: number): void {
  drawn.paths.forEach((path, p) => {
    let along = drawn.offsets[p] ?? 0,
      from = path[0];
    const segment = (a: Point, b: Point) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length > 1e-9)
        instances.push(
          KIND.segment,
          slot,
          [a[0], a[1], b[0], b[1]],
          [along],
          [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        );
      along += length;
    };
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[i - 1],
        b = path[i],
        c = path[i + 1],
        ab = Math.hypot(b[0] - a[0], b[1] - a[1]),
        bc = Math.hypot(c[0] - b[0], c[1] - b[1]),
        r = Math.min(radius, ab / 2, bc / 2);
      if (!(r > 1e-6)) continue;
      const into: Point = [(b[0] - a[0]) / ab, (b[1] - a[1]) / ab],
        onward: Point = [(c[0] - b[0]) / bc, (c[1] - b[1]) / bc],
        enter: Point = [b[0] - into[0] * r, b[1] - into[1] * r],
        leave: Point = [b[0] + onward[0] * r, b[1] + onward[1] * r];
      segment(from, enter);
      const center: Point = [enter[0] + leave[0] - b[0], enter[1] + leave[1] - b[1]];
      instances.push(
        KIND.corner,
        slot,
        [center[0], center[1], r, along],
        [-onward[0], -onward[1], into[0], into[1]],
        [center[0] - r, center[1] - r, center[0] + r, center[1] + r],
      );
      along += (r * Math.PI) / 2;
      from = leave;
    }
    segment(from, path[path.length - 1]);
  });
  for (const { point: p, direction: d } of drawn.arrows)
    instances.push(KIND.arrow, slot, [p[0], p[1], d[0], d[1]], [], [p[0], p[1], p[0], p[1]]);
  for (const p of drawn.junctions)
    instances.push(KIND.junction, slot, [p[0], p[1], 0, 0], [], [p[0], p[1], p[0], p[1]]);
}
/** Where a vertex's title sits: centered by its capitals in its band, or on the vertex. */
function titleAt(vertex: Vertex, style: Style): Point {
  const x = vertex.x + vertex.width / 2;
  if (vertex.options.labelPosition !== 'header')
    return kit.textOrigin(vertex.label, [x, vertex.y + vertex.height / 2], 'center', 'middle');
  const top = vertex.ports.some((p) => p.side === 'top') ? style.portFontSize * 1.5 : 0,
    inset =
      vertex.shape === 'diamond'
        ? vertex.height / 4
        : vertex.shape === 'ellipse'
          ? (vertex.height * (1 - Math.SQRT1_2)) / 2
          : 0;
  return kit.textOrigin(
    vertex.label,
    [x, vertex.y + inset + top + (vertex.header - top) / 2],
    'center',
    'middle',
  );
}
/** Where a port's name sits: inside its vertex, a marker's half and a gap from the port. */
function portNameAt(vertex: Vertex, port: Vertex['ports'][number], style: Style): Point {
  const label = port.label,
    [x, y] = port.position,
    gap = style.portSize / 2 + 4,
    slant =
      vertex.shape === 'diamond'
        ? ((label.width + gap * 2) * vertex.height) / (2 * vertex.width)
        : 0;
  return port.side === 'left'
    ? kit.textOrigin(label, [x + gap, y], 'start', 'middle')
    : port.side === 'right'
      ? kit.textOrigin(label, [x - gap, y], 'end', 'middle')
      : port.side === 'top'
        ? kit.textOrigin(label, [x, y + gap + slant], 'center', 'top')
        : kit.textOrigin(label, [x, y - gap - slant], 'center', 'bottom');
}
/** Build the pipelines for one target format, MSAA, and shade; the view caches each variant. */
export async function pipelines(
  gpu: Gpu,
  format: GPUTextureFormat,
  msaa: 1 | 4,
  shade: string,
): Promise<Pipelines> {
  const d = gpu.device,
    V = GPUShaderStage.VERTEX,
    F = GPUShaderStage.FRAGMENT;
  const layout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, buffer: { type: 'uniform' } },
      { binding: 2, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: V | F, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: V, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: V | F, buffer: { type: 'read-only-storage' } },
    ],
  });
  const styleLayout = d.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const [module, compute] = await Promise.all([
    gpu.shaderModule(
      kit.shadeShader({ group: 0, binding: 1 }) +
        kit.textShader({ group: 1 }) +
        kit.outputShader() +
        kinds +
        '\n' +
        shader +
        shade,
      'diagram',
    ),
    gpu.shaderModule(kit.fieldShader({ group: 0, colormap: 2 }) + styleShader, 'diagram styles'),
  ]);
  const pipe = (vertex: string, fragment: string, text = false) =>
    gpu.renderPipeline({
      layout: d.createPipelineLayout({
        bindGroupLayouts: text ? [layout, gpu.textLayout] : [layout],
      }),
      vertex: { module, entryPoint: vertex },
      fragment: {
        module,
        entryPoint: fragment,
        targets: [{ format, blend: kit.premultipliedBlend }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: { count: msaa },
    });
  const [shapes, text, grid, styles] = await Promise.all([
    pipe('shape_vertex', 'shape_fragment'),
    pipe('text_vertex', 'text_fragment', true),
    pipe('grid_vertex', 'grid_fragment'),
    gpu.computePipeline({
      layout: d.createPipelineLayout({
        bindGroupLayouts: [gpu.fieldLayout, styleLayout, gpu.colormapLayout],
      }),
      compute: { module: compute, entryPoint: 'style_main' },
    }),
  ]);
  return { shapes, text, grid, styles, layout, styleLayout };
}
export class Painter {
  private focused?: {
    readonly geometry: Geometry;
    readonly selection: readonly DiagramItem[];
    readonly hover: DiagramItem | null;
    readonly overlay: Overlay | null;
    readonly drag: DragDraw['marks'] | null;
  };
  private readonly attachments: kit.Attachments;
  private readonly styles: Styles;
  private readonly empty = new kit.BufferData({ size: 16, label: 'diagram empty' });
  private gesture?: readonly InstancePage[];
  private dragged?: readonly InstancePage[];
  /** Every label, by the slot it names: a scene that keeps its text only moves anchors. */
  private readonly text = new kit.TextBank({ label: 'diagram text', local: true });
  /** The labels of rerouted wires a drag draws. */
  private readonly dragText = new kit.TextBank({ label: 'diagram drag text', local: true });
  constructor(private readonly gpu: Gpu) {
    this.attachments = new kit.Attachments(gpu);
    this.styles = new Styles(gpu);
  }
  private build(scene: Scene, style: Style, previous?: Geometry): Geometry {
    const instances = new Instances('diagram instances', previous?.instances),
      text = this.text;
    text.hide();
    scene.groups.forEach((group, i) => {
      const b = group.bounds;
      if (b[0] === b[2]) return;
      instances.push(
        KIND.group,
        scene.slots.groups + i,
        [b[0], b[1], b[2] - b[0], b[3] - b[1]],
        [style.cornerRadius, group.header, +group.collapsed],
        b,
      );
      const slot = scene.slots.groups + i;
      text.add(
        slot,
        group.label,
        kit.textOrigin(
          group.label,
          [b[0] + style.vertexPadding, b[1] + group.header / 2],
          'start',
          'middle',
        ),
        { slot },
      );
    });
    scene.edges.forEach((edge, i) => {
      if (edge.visible && edge.paths.length)
        wire(instances, scene.slots.edges + i, edge, style.cornerRadius);
    });
    scene.edges.forEach((edge, i) => {
      if (!edge.visible || !edge.paths.length || !style.labels) return;
      const slot = scene.slots.edges + i;
      edge.labels.forEach((at, k) => {
        const b = labelBox(edge, at);
        instances.push(
          KIND.label,
          slot,
          [b[0], b[1], b[2] - b[0], b[3] - b[1]],
          [+(edge.options.appearance === 'tag')],
          b,
        );
        text.add(slot + ':' + k, edge.label, at, { slot });
      });
    });
    scene.vertices.forEach((vertex, i) => {
      if (!vertex.visible) return;
      const box: Rect = [vertex.x, vertex.y, vertex.x + vertex.width, vertex.y + vertex.height];
      instances.push(
        KIND.block,
        i,
        [vertex.x, vertex.y, vertex.width, vertex.height],
        [vertex.radius, vertex.header, SHAPES.indexOf(vertex.shape)],
        box,
      );
      text.add(i, vertex.label, titleAt(vertex, style), { slot: i });
      vertex.ports.forEach((port, k) => {
        const p = port.position,
          slot = vertex.portSlot + k,
          sign = port.direction === 'in' ? -1 : 1;
        instances.push(
          KIND.port,
          slot,
          [p[0], p[1], port.normal[0] * sign, port.normal[1] * sign],
          [
            port.marker === 'diamond'
              ? 2
              : port.marker === 'directional' && port.direction !== undefined
                ? 1
                : 0,
            +port.connected,
          ],
          [p[0], p[1], p[0], p[1]],
        );
        // A port's name sits on its block: it follows the block's drag and reads on its fill.
        text.add(slot, port.label, portNameAt(vertex, port, style), { slot: i });
      });
    });
    const reuse = previous?.focus.size === Math.max(4, scene.slots.count * 4);
    return {
      instances: instances.flush(),
      text: text.flush(),
      focus: reuse
        ? previous.focus
        : new kit.BufferData({ size: Math.max(4, scene.slots.count * 4), label: 'diagram focus' }),
      states: reuse ? previous.states : new Map<number, number>(),
    };
  }
  async prepare(frame: kit.Preparation, state: DrawState): Promise<Paint> {
    const { scene, style, camera, pipelines, shade: effect, overlay } = state;
    // A scene's instances and labels, built once; a new scene writes only what changed.
    const geometry = await frame.memo('geometry', [scene], (_, previous: Geometry | undefined) =>
      this.build(scene, style, previous),
    );
    this.focus(scene, geometry, state);
    const restyle = await this.styles.prepare(frame, scene, state.data, pipelines.styleLayout),
      { styles } = restyle,
      focus = frame.buffer(geometry.focus),
      empty = frame.buffer(this.empty),
      accent = style.selectedColor ?? style.hoverColor;
    const group = (
      origin: Point,
      data: GPUBufferBinding,
      anchors = empty,
      textSize = 0,
      flags = focus,
    ) =>
      this.gpu.device.createBindGroup({
        layout: pipelines.layout,
        entries: [
          {
            binding: 0,
            resource: frame.uniforms(
              Float32Array.of(
                origin[0] - camera.center[0],
                origin[1] - camera.center[1],
                camera.scale[0],
                camera.scale[1] * (camera.yDirection === 'down' ? 1 : -1),
                frame.viewport.width,
                frame.viewport.height,
                frame.viewport.pixelRatio,
                frame.timeMs,
                style.gridPitch,
                +style.grid,
                +state.motion,
                textSize,
                ...accent,
                ...style.hoverColor,
                ...style.gridColor,
                style.outlineWidthPx,
                style.selectedWidthPx,
                style.hoverWidthPx,
                +(style.selectedColor === null),
                ...style.background,
                +(style.detail === 'auto'),
                style.gridMinSpacingPx,
                style.portSize,
                style.edgeWidthPx,
                ...(state.drag?.delta ?? [0, 0]),
                +style.junctions,
                scene.slots.ports,
                ...style.vertexBaseColor,
                ...style.edgeBaseColor,
                ...style.outlineColor,
                ...style.groupColor,
              ),
            ),
          },
          { binding: 1, resource: effect },
          { binding: 2, resource: data },
          { binding: 3, resource: flags },
          { binding: 4, resource: anchors },
          { binding: 5, resource: styles },
        ],
      });
    // Culling keeps the rims, shadows, and markers of what lies just off the canvas.
    const reach = 16 + style.portSize * camera.scale[0],
      dx = (frame.viewport.width / 2 + reach) / camera.scale[0],
      dy = (frame.viewport.height / 2 + reach) / camera.scale[1],
      visible: Rect = [
        camera.center[0] - dx,
        camera.center[1] - dy,
        camera.center[0] + dx,
        camera.center[1] + dy,
      ];
    const shapes: Paint['shapes'] = [],
      text: Paint['text'] = [];
    const draw = (pages: readonly InstancePage[], flags = focus) => {
      for (const page of pages)
        if (intersects(page.bounds, visible))
          shapes.push({
            group: group(page.origin, frame.buffer(page.data), empty, 0, flags),
            count: page.count,
          });
    };
    // Text too small to read is left out.
    const write = async (pages: readonly kit.TextBankPage[], flags = focus) => {
      for (const page of pages)
        if (intersects(page.bounds, visible) && page.maxSize * camera.scale[0] >= 3)
          text.push({
            group: group(
              page.origin,
              frame.buffer(this.empty),
              frame.buffer(page.anchors),
              page.maxSize,
              flags,
            ),
            pages: await frame.text({ runs: page.runs }),
          });
    };
    draw(geometry.instances);
    await write(geometry.text);
    if (state.drag?.wires.length) {
      // Rerouted wires draw as they will be, past the focus that hides their old routes.
      const moving = new Instances('diagram drag', this.dragged),
        named = this.dragText;
      named.hide();
      for (const dragged of state.drag.wires) {
        wire(moving, dragged.slot, dragged, style.cornerRadius);
        dragged.labels.forEach((at, k) => {
          const b = labelBox(dragged.edge, at);
          moving.push(KIND.label, dragged.slot, [b[0], b[1], b[2] - b[0], b[3] - b[1]], [], b);
          named.add(dragged.slot + ':' + k, dragged.edge.label, at, { slot: dragged.slot });
        });
      }
      this.dragged = moving.flush();
      draw(this.dragged, empty);
      await write(named.flush(), empty);
    }
    if (overlay?.box || overlay?.wire) {
      const gesture = new Instances('diagram gesture', this.gesture);
      if (overlay.box) {
        const b = overlay.box;
        gesture.push(KIND.box, NONE, [b[0], b[1], b[2] - b[0], b[3] - b[1]], [], b);
      }
      let along = 0;
      for (let i = 1; i < (overlay.wire?.length ?? 0); i++) {
        const a = overlay.wire![i - 1],
          b = overlay.wire![i];
        gesture.push(
          KIND.preview,
          NONE,
          [a[0], a[1], b[0], b[1]],
          [along, +!!overlay.invalid],
          [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
        );
        along += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      this.gesture = gesture.flush();
      draw(this.gesture, empty);
    }
    const msaa = this.attachments.prepare(frame, { msaa: style.msaa }).color;
    const level = Math.max(
      0,
      Math.ceil(
        Math.log(Math.max(1, style.gridMinSpacingPx / (style.gridPitch * camera.scale[0]))) /
          Math.log(4),
      ),
    );
    const period = style.gridPitch * 4 ** (level + 1);
    return {
      pipelines,
      restyle,
      shapes,
      text,
      grid: group(
        [
          Math.floor(camera.center[0] / period) * period,
          Math.floor(camera.center[1] / period) * period,
        ],
        empty,
      ),
      msaa,
      background: style.background,
      drawCalls: 1 + shapes.length + text.reduce((n, page) => n + page.pages.length, 0),
    };
  }
  encode(frame: kit.Encoding, paint: Paint): void {
    this.styles.encode(frame.encoder, paint.pipelines.styles, paint.restyle);
    const pass = frame.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: paint.msaa ?? frame.target,
          resolveTarget: paint.msaa ? frame.target : undefined,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: kit.clearColor(paint.background),
        },
      ],
    });
    pass.setPipeline(paint.pipelines.grid);
    pass.setBindGroup(0, paint.grid);
    pass.draw(3);
    pass.setPipeline(paint.pipelines.shapes);
    for (const shape of paint.shapes) {
      pass.setBindGroup(0, shape.group);
      pass.draw(6, shape.count);
    }
    pass.setPipeline(paint.pipelines.text);
    for (const label of paint.text) {
      pass.setBindGroup(0, label.group);
      for (const page of label.pages) {
        pass.setBindGroup(1, page.bindGroup);
        pass.draw(6, page.count);
      }
    }
    pass.end();
  }
  /** Write each slot's selection, hover, and gesture flags where they changed. */
  private focus(scene: Scene, geometry: Geometry, state: DrawState): void {
    const { selection, hover, overlay } = state,
      drag = state.drag?.marks ?? null,
      last = this.focused;
    if (
      last?.geometry === geometry &&
      last.selection === selection &&
      last.hover === hover &&
      last.overlay === overlay &&
      last.drag === drag
    )
      return;
    this.focused = { geometry, selection, hover, overlay, drag };
    const slots = itemSlots(scene),
      states = new Map<number, number>();
    const flag = (slot: number | undefined, bit: number) => {
      if (slot !== undefined) states.set(slot, (states.get(slot) ?? 0) | bit);
    };
    for (const item of selection) flag(slots.get(itemKey(item)), 1);
    if (hover && !overlay?.wire) flag(slots.get(itemKey(hover)), 2);
    for (const item of overlay?.compatible ?? []) flag(slots.get(itemKey(item)), 4);
    if (overlay?.target) flag(slots.get(itemKey(overlay.target)), 8);
    if (overlay?.muted) flag(slots.get(overlay.muted), 32);
    for (const slot of drag?.moving ?? []) flag(slot, 64);
    for (const slot of drag?.rerouted ?? []) flag(slot, 128);
    const words = new Uint32Array(
      geometry.focus.bytes.buffer,
      geometry.focus.bytes.byteOffset,
      geometry.focus.size / 4,
    );
    const write = (slot: number, value: number) => {
      if (slot < words.length && words[slot] !== value) {
        words[slot] = value;
        geometry.focus.touch({ offset: slot * 4, size: 4 });
      }
    };
    for (const slot of geometry.states.keys()) if (!states.has(slot)) write(slot, 0);
    for (const [slot, value] of states) write(slot, value);
    geometry.states = states;
  }
  destroy(): void {
    this.attachments.destroy();
    this.styles.destroy();
    this.focused = undefined;
    this.dragged = undefined;
    this.gesture = undefined;
    this.text.clear();
    this.dragText.clear();
  }
}
