import { kit, type Gpu, type RGBA } from '@latkit/gpu';
import { failure, rowCount } from '@latkit/model';
import type { Camera } from '../camera.js';
import { DEG } from '../camera.js';
import { sameItem, type NetworkData, type NetworkItem } from '../data.js';
import {
  edgeOptions,
  type Geometry,
  type VertexBank,
  type EdgeBank,
  type SegmentBatch,
} from '../geometry/topology.js';
import { lineWidthPx, PATH_LINE, type Style } from '../options.js';
import type { LabelBatch } from './labels.js';
import type { FieldRead } from './fields.js';
import type { Pipelines } from './pipelines.js';

/** Bytes of a page's uniform slot: a vertex page's rows, origin, color, and seven channels. */
const SLOT = 256;
const SLOT_WORDS = SLOT / 4;
/** Bytes a line page binds: its rows, color, and five channels. */
const LINE_BYTES = 192;
/** A path's private points draw no markers. */
const HIDDEN: kit.ChannelRead = { component: 0, fallback: 0 };
/** The upload origin a raw axis reads relative to; a scaled or constant axis is absolute. */
function rebase(channel: kit.ChannelRead, page: kit.GpuPage): number {
  const field = channel.column === undefined ? undefined : page.columns[channel.column];
  return !channel.scale && field?.kind === 'value' ? (field.origin?.[channel.component] ?? 0) : 0;
}
/** A type's color for rows without one: its constant, its scale's missing color, or `fallback`. */
function typeColor(read: FieldRead, fallback: RGBA | null): RGBA {
  const color = read.bound.channels.color;
  if (Array.isArray(color?.constant)) return color.constant as RGBA;
  return color?.missing ?? fallback ?? [0, 0, 0, -1];
}

export interface Reads {
  readonly vertices: ReadonlyMap<VertexBank, FieldRead>;
  readonly edges: ReadonlyMap<EdgeBank, FieldRead>;
}
export interface DrawFrame {
  readonly camera: Camera;
  readonly options: Style;
  readonly data: NetworkData;
  readonly geometry: Geometry;
  readonly reads: Reads;
  /** Replaced whenever it changes. */
  readonly selection: readonly NetworkItem[];
  readonly hover: NetworkItem | null;
  readonly pointer: readonly [number, number] | null;
  readonly height: number;
  readonly pipelines: Pipelines;
  /** This frame's shade uniforms. */
  readonly shade: GPUBufferBinding;
  readonly labels: readonly LabelBatch[];
  readonly phases: ReadonlyMap<SegmentBatch, Float32Array>;
}
interface Command {
  readonly group: GPUBindGroup;
  readonly count: number;
  readonly tessellation?: GPUBindGroup;
}
interface Compute {
  readonly colors: GPUBindGroup;
  readonly fields: GPUBindGroup;
  readonly group: GPUBindGroup;
  readonly count: number;
  readonly edge: boolean;
}
export interface Paint {
  readonly pipelines: Pipelines;
  readonly compute: readonly Compute[];
  readonly vertices: readonly Command[];
  readonly edges: readonly Command[];
  readonly labels: readonly { group: GPUBindGroup; pages: readonly kit.TextPage[] }[];
  readonly background: GPUBindGroup;
  readonly depth: GPUTextureView;
  readonly color?: GPUTextureView;
  readonly options: Style;
  readonly globe: boolean;
  readonly indirect?: GPUBuffer;
  readonly drawCalls: number;
}
function sun(time: number): readonly [number, number, number] {
  const date = new Date(time),
    day = (time - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000;
  const decl = -23.44 * Math.cos((2 * Math.PI * (day + 10)) / 365.25) * DEG,
    lon = (0.5 - (time % 86400000) / 86400000) * Math.PI * 2;
  return [Math.cos(decl) * Math.cos(lon), Math.sin(decl), -Math.cos(decl) * Math.sin(lon)];
}
export class Painter {
  private buffers = new Map<object, kit.BufferResource>();
  private readonly attachments: kit.Attachments;
  private readonly dummy: kit.BufferResource;
  /** Two bits per drawn row: what the selection and hover halo. */
  private readonly focus = new kit.BufferData({ size: 16, label: 'network focus' });
  private focusWords = new Map<number, number>();
  private focused?: {
    readonly geometry: Geometry;
    readonly selection: readonly NetworkItem[];
    readonly hover: NetworkItem | null;
    readonly options: Style;
  };
  /** Each batch's dash prefixes, uploaded when they change. */
  private phases = new WeakMap<
    SegmentBatch,
    { readonly buffer: kit.BufferData; readonly values: Float32Array }
  >();
  private curves?: {
    capacity: number;
    instances: kit.BufferResource;
    indirect: kit.BufferResource;
  };
  /**
   * Every page's uniform slot, written here each frame and held in chunks of one binding's size,
   * so a frame uploads only the words that changed.
   */
  private slots = new Uint32Array(0);
  private readonly chunks: kit.BufferData[] = [];
  constructor(private readonly gpu: Gpu) {
    this.attachments = new kit.Attachments(gpu);
    this.dummy = gpu.buffer({
      size: 80,
      usage: GPUBufferUsage.STORAGE,
      label: 'network empty binding',
    });
  }
  private output(key: object, bytes: number): kit.BufferResource {
    let result = this.buffers.get(key);
    if (!result) {
      result = this.gpu.buffer({
        size: Math.max(80, bytes),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        label: 'network prepared geometry',
      });
      this.buffers.set(key, result);
    }
    return result;
  }
  async prepare(frame: kit.Preparation, state: DrawFrame): Promise<Paint> {
    const { gpu } = this,
      { camera, options, reads, geometry, data } = state;
    const pipeline = state.pipelines;
    const { color, depth } = this.attachments.prepare(frame, {
      msaa: options.msaa,
      depth: 'depth32float',
    });
    const f = new Float32Array(60),
      u = new Uint32Array(f.buffer);
    const scale = camera.scale / (camera.projection === 'globe' ? DEG : 1),
      distance = Math.max(1e-9, (frame.viewport.height * 1.5) / scale);
    f.set(
      [
        frame.viewport.width,
        frame.viewport.height,
        frame.viewport.pixelRatio,
        ['flat', 'tilt', 'globe'].indexOf(camera.projection),
      ],
      0,
    );
    f.set([scale, distance, 0, 0], 4);
    f.set(
      [
        Math.cos(camera.bearing * DEG),
        Math.sin(camera.bearing * DEG),
        Math.cos(camera.pitch * DEG),
        Math.sin(camera.pitch * DEG),
      ],
      8,
    );
    f.set(
      [
        Math.sin(camera.center[1] * DEG),
        Math.cos(camera.center[1] * DEG),
        state.height,
        geometry.geographic ? 1 : 0,
      ],
      12,
    );
    f.set(
      [
        camera.center[0],
        camera.center[1],
        Math.sin(camera.center[0] * DEG),
        Math.cos(camera.center[0] * DEG),
      ],
      16,
    );
    f.set([options.dashPeriodPx, options.markers ? 1 : 0, 0, 0], 20);
    f.set(options.hoverColor, 24);
    f.set(options.selectedColor ?? [0, 0, 0, 0], 28);
    f.set(
      [
        options.hoverWidthPx,
        options.selectedWidthPx,
        options.hoverWidthPx,
        options.selectedWidthPx,
      ],
      32,
    );
    f.set(
      [
        ...(state.pointer ?? [-1e6, -1e6]),
        options.nightFloor,
        Math.max(0.0001, options.terminatorWidth),
      ],
      36,
    );
    f.set(
      [...sun(options.sunTime ?? Date.now()), options.daylight && geometry.geographic ? 1 : 0],
      40,
    );
    f.set(
      [...options.surfaceColor.slice(0, 3), options.daylight ? options.surfaceNightFloor : 1],
      44,
    );
    f.set(options.gridColor, 48);
    u.set([0, options.graticule ? 1 : 0, 0, 0], 52);
    f.set(options.background, 56);
    this.updateFocus(state);
    const focusedBinding = frame.buffer(this.focus);
    const uniform = frame.uniforms(f),
      host = state.shade,
      empty = frame.buffer(this.dummy);
    const vertexBuffers = new Map<VertexBank, GPUBufferBinding>(),
      edgeBuffers = new Map<EdgeBank, GPUBufferBinding>();
    for (const bank of geometry.vertices)
      vertexBuffers.set(bank, frame.buffer(this.output(bank, bank.count * 80)));
    for (const bank of geometry.edges)
      edgeBuffers.set(bank, frame.buffer(this.output(bank, bank.count * 32)));
    // Write each page's slot, then bind them from the chunks that hold them.
    const pages: {
      readonly page: kit.GpuPage;
      readonly colors: GPUBindGroup;
      readonly output: GPUBufferBinding;
      readonly edge: boolean;
    }[] = [];
    let slots = 0;
    for (const bank of geometry.vertices) slots += reads.vertices.get(bank)!.pages.length;
    for (const bank of geometry.edges) slots += reads.edges.get(bank)!.pages.length;
    if (this.slots.length < slots * SLOT_WORDS) this.slots = new Uint32Array(slots * SLOT_WORDS);
    const words = this.slots.subarray(0, slots * SLOT_WORDS).fill(0),
      floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    /** One compute dispatch per page: a vertex bank's, or the bank of a `line` type's options. */
    const write = (bank: VertexBank | EdgeBank, read: FieldRead, line?: object) => {
      const color = line
          ? typeColor(read, 'points' in line ? PATH_LINE.color : options.edgeBaseColor)
          : typeColor(read, options.vertexBaseColor),
        colors = frame.colormap(read.bound.channels.color?.colormap),
        output = line ? edgeBuffers.get(bank as EdgeBank)! : vertexBuffers.get(bank as VertexBank)!,
        hidden = 'synthetic' in bank && !!bank.synthetic;
      for (const { page, offset } of read.pages) {
        const at = pages.length * SLOT_WORDS;
        pages.push({ page, colors, output, edge: !!line });
        words[at] = rowCount(page.rows);
        words[at + 1] = offset;
        floats.set(color, at + 4);
        if (line) {
          kit.writeChannel(words, at + 8, read.channel('color'), page);
          kit.writeChannel(
            words,
            at + 16,
            read.channel('widthPx', lineWidthPx(line, options)),
            page,
          );
          kit.writeChannel(words, at + 24, read.channel('visible'), page);
          kit.writeChannel(words, at + 32, read.channel('shade'), page);
          kit.writeChannel(words, at + 40, read.channel('dash'), page);
          continue;
        }
        // Positions read relative to their upload origin, rebased here to the camera center.
        const x = read.channel('x'),
          y = read.channel('y');
        floats[at + 2] = rebase(x, page) - camera.center[0];
        floats[at + 3] = rebase(y, page) - camera.center[1];
        kit.writeChannel(words, at + 8, x, page, 0);
        kit.writeChannel(words, at + 16, y, page, 0);
        kit.writeChannel(words, at + 24, read.channel('z'), page);
        kit.writeChannel(
          words,
          at + 32,
          hidden ? HIDDEN : read.channel('sizePx', options.vertexRadiusPx),
          page,
        );
        kit.writeChannel(words, at + 40, read.channel('color'), page);
        kit.writeChannel(words, at + 48, hidden ? HIDDEN : read.channel('visible'), page);
        kit.writeChannel(words, at + 56, read.channel('shade'), page);
      }
    };
    for (const bank of geometry.vertices) write(bank, reads.vertices.get(bank)!);
    for (const bank of geometry.edges) write(bank, reads.edges.get(bank)!, edgeOptions(data, bank));
    const perChunk = Math.floor(gpu.device.limits.maxUniformBufferBindingSize / SLOT),
      held = Math.ceil(slots / perChunk);
    this.chunks.length = Math.min(this.chunks.length, held);
    const bindings: GPUBufferBinding[] = [];
    for (let k = 0; k < held; k++) {
      const chunk = (this.chunks[k] ??= new kit.BufferData({
        size: SLOT,
        usage: GPUBufferUsage.UNIFORM,
        label: 'network pages',
      }));
      chunk.update(
        words.subarray(k * perChunk * SLOT_WORDS, (k + 1) * perChunk * SLOT_WORDS),
        SLOT,
      );
      bindings.push(frame.buffer(chunk));
    }
    const compute: Compute[] = pages.map(({ page, colors, output, edge }, i) => {
      const chunk = bindings[Math.floor(i / perChunk)];
      return {
        colors,
        fields: page.bindGroup,
        group: gpu.device.createBindGroup({
          layout: pipeline.compute,
          entries: [
            { binding: 0, resource: uniform },
            {
              binding: 1,
              resource: {
                buffer: chunk.buffer,
                offset: (chunk.offset ?? 0) + (i % perChunk) * SLOT,
                size: edge ? LINE_BYTES : SLOT,
              },
            },
            { binding: 2, resource: output },
          ],
        }),
        count: rowCount(page.rows),
        edge,
      };
    });
    const curveCount = Math.max(
      0,
      ...geometry.edges
        .filter((bank) => edgeOptions(data, bank).route === 'geodesic')
        .flatMap((bank) => bank.batches.map((batch) => batch.records.length / 4)),
    );
    if (curveCount) {
      if (!geometry.geographic)
        throw failure('invalid-input', 'Geodesics require geographic coordinates');
      const capacity = curveCount * 181;
      if (!this.curves || capacity > this.curves.capacity) {
        const instances = gpu.buffer({
          size: capacity * 16,
          usage: GPUBufferUsage.STORAGE,
          label: 'network reusable curve scratch',
        });
        let indirect: kit.BufferResource;
        try {
          indirect = gpu.buffer({
            size: 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
            label: 'network curve count',
          });
        } catch (error) {
          instances.destroy();
          throw error;
        }
        this.curves?.instances.destroy();
        this.curves?.indirect.destroy();
        this.curves = { capacity, instances, indirect };
      }
    }
    const curveInstances = curveCount ? frame.buffer(this.curves!.instances) : empty;
    const curveIndirect = curveCount ? frame.buffer(this.curves!.indirect) : undefined;
    /** `base` is the dense address of the bank's first row, for focus. */
    const group = (
      a: GPUBufferBinding,
      b: GPUBufferBinding,
      segments: GPUBufferBinding,
      styles: GPUBufferBinding,
      base: number,
      phase?: GPUBufferBinding,
    ) =>
      gpu.device.createBindGroup({
        layout: pipeline.draw,
        entries: [
          { binding: 0, resource: uniform },
          { binding: 1, resource: a },
          { binding: 2, resource: b },
          { binding: 3, resource: segments },
          { binding: 4, resource: styles },
          {
            binding: 5,
            resource: frame.uniforms(Uint32Array.of(base, 0, phase ? 1 : 0, 0)),
          },
          { binding: 6, resource: host },
          { binding: 7, resource: focusedBinding },
          { binding: 8, resource: curveInstances },
          { binding: 9, resource: phase ?? empty },
        ],
      });
    const vertices: Command[] = [],
      edges: Command[] = [];
    for (const bank of geometry.vertices)
      if (!bank.synthetic)
        vertices.push({
          group: group(vertexBuffers.get(bank)!, empty, empty, empty, bank.base),
          count: bank.count,
        });
    for (const bank of geometry.edges) {
      const curved = edgeOptions(data, bank).route === 'geodesic',
        dashed = reads.edges.get(bank)!.has('dash');
      for (const batch of bank.batches) {
        const count = batch.records.length / 4;
        const a = vertexBuffers.get(batch.a)!,
          b = vertexBuffers.get(batch.b)!,
          segments = frame.buffer(batch.data);
        const tessellation = curved
          ? gpu.device.createBindGroup({
              layout: pipeline.tessellation,
              entries: [
                { binding: 0, resource: uniform },
                { binding: 1, resource: a },
                { binding: 2, resource: b },
                { binding: 3, resource: segments },
                { binding: 4, resource: curveInstances },
                { binding: 5, resource: curveIndirect! },
                {
                  binding: 6,
                  resource: frame.uniforms(Uint32Array.of(count, dashed ? 1 : 0, 0, 0)),
                },
              ],
            })
          : undefined;
        let phase: GPUBufferBinding | undefined;
        const values = state.phases.get(batch);
        if (values) {
          let phases = this.phases.get(batch);
          if (phases?.values !== values) {
            const buffer =
              phases?.buffer ??
              new kit.BufferData({ size: values.byteLength, label: 'network dash phases' });
            buffer.write({ data: values });
            this.phases.set(batch, (phases = { buffer, values }));
          }
          phase = frame.buffer(phases.buffer);
        }
        edges.push({
          group: group(
            a,
            b,
            segments,
            edgeBuffers.get(bank)!,
            geometry.vertexCount + bank.base,
            phase,
          ),
          count,
          tessellation,
        });
      }
    }
    const labels: { group: GPUBindGroup; pages: readonly kit.TextPage[] }[] = [];
    for (const { runs, anchors } of state.labels)
      if (runs.length) {
        const pages = await frame.text({ runs });
        labels.push({
          group: gpu.device.createBindGroup({
            layout: pipeline.label,
            entries: [
              { binding: 0, resource: uniform },
              { binding: 1, resource: frame.buffer(anchors) },
            ],
          }),
          pages,
        });
      }
    const background = gpu.device.createBindGroup({
      layout: pipeline.background,
      entries: [{ binding: 0, resource: uniform }],
    });
    return {
      pipelines: pipeline,
      indirect: curveIndirect?.buffer,
      compute,
      vertices,
      edges,
      labels,
      background,
      depth: depth!,
      color,
      options,
      globe: camera.projection === 'globe',
      drawCalls:
        1 +
        (camera.projection === 'globe' && options.earthAxis ? 1 : 0) +
        (options.markers ? vertices.length : 0) +
        (options.poles ? vertices.length : 0) +
        (options.lines ? edges.length : 0) +
        labels.reduce((n, v) => n + v.pages.length, 0),
    };
  }
  /** Rewrite only the focus words that changed, and only when selection, hover, or geometry do. */
  private updateFocus(state: DrawFrame): void {
    const { geometry, options, data } = state,
      native = geometry.native ?? geometry,
      last = this.focused;
    if (
      last?.geometry === native &&
      last.selection === state.selection &&
      sameItem(last.hover, state.hover) &&
      last.options.selectedEnds === options.selectedEnds &&
      last.options.hoverEnds === options.hoverEnds
    )
      return;
    const next = new Map<number, number>(),
      adjacency = native.adjacency;
    const mark = (item: NetworkItem, level: number) => {
      const dense = adjacency.address(item);
      if (dense === undefined) return;
      const word = dense >>> 4,
        shift = (dense & 15) * 2,
        bits = next.get(word) ?? 0;
      if (((bits >>> shift) & 3) < level)
        next.set(word, ((bits & ~(3 << shift)) | (level << shift)) >>> 0);
    };
    const focus = (item: NetworkItem, level: number) => {
      mark(item, level);
      if (item.kind === 'edge' && (level === 2 ? options.selectedEnds : options.hoverEnds))
        for (const vertex of adjacency.neighborhood(item, data))
          if (vertex.kind === 'vertex') mark(vertex, level);
    };
    for (const item of state.selection) focus(item, 2);
    if (state.hover) focus(state.hover, 1);
    // Sixteen rows per word, padded to whole 16-byte rows.
    const rows = native.vertexCount + native.edgeCount + native.pathCount,
      size = Math.max(16, Math.ceil(rows / 64) * 16);
    if (this.focus.size !== size) this.focus.resize(size);
    const bytes = this.focus.bytes,
      words = new Uint32Array(bytes.buffer, bytes.byteOffset, size / 4);
    let lo = Infinity,
      hi = -1;
    const write = (word: number, value: number) => {
      if (word >= words.length || words[word] === value) return;
      words[word] = value;
      lo = Math.min(lo, word);
      hi = Math.max(hi, word);
    };
    for (const word of this.focusWords.keys()) if (!next.has(word)) write(word, 0);
    for (const [word, value] of next) write(word, value);
    if (hi >= lo) this.focus.touch({ offset: lo * 4, size: (hi - lo + 1) * 4 });
    this.focusWords = next;
    this.focused = {
      geometry: native,
      selection: state.selection,
      hover: state.hover,
      options,
    };
  }
  encode(frame: kit.Encoding, paint: Paint): void {
    const compute = frame.encoder.beginComputePass({ label: 'network native fields to geometry' });
    for (const command of paint.compute) {
      compute.setPipeline(command.edge ? paint.pipelines.edge : paint.pipelines.vertex);
      compute.setBindGroup(0, command.fields);
      compute.setBindGroup(1, command.group);
      compute.setBindGroup(2, command.colors);
      compute.dispatchWorkgroups(Math.ceil(command.count / 64));
    }
    compute.end();
    const begin = (load: boolean) =>
      frame.encoder.beginRenderPass({
        label: 'network',
        colorAttachments: [
          {
            view: paint.color ?? frame.target,
            resolveTarget: paint.color ? frame.target : undefined,
            loadOp: load ? 'load' : 'clear',
            storeOp: 'store',
            clearValue: kit.clearColor(paint.options.background),
          },
        ],
        depthStencilAttachment: {
          view: paint.depth,
          depthClearValue: 1,
          depthLoadOp: load ? 'load' : 'clear',
          depthStoreOp: 'store',
        },
      });
    let pass = begin(false);
    pass.setPipeline(paint.pipelines.surface);
    pass.setBindGroup(0, paint.background);
    pass.draw(3);
    if (paint.globe && paint.options.earthAxis) {
      pass.setPipeline(paint.pipelines.axis);
      pass.setBindGroup(0, paint.background);
      pass.draw(6);
    }
    if (paint.options.lines) {
      pass.setPipeline(paint.pipelines.edges);
      for (const item of paint.edges) {
        if (item.tessellation) {
          pass.end();
          frame.encoder.clearBuffer(paint.indirect!);
          const prepare = frame.encoder.beginComputePass({
            label: 'network adaptive curve tessellation',
          });
          prepare.setPipeline(paint.pipelines.tessellate);
          prepare.setBindGroup(0, item.tessellation);
          prepare.dispatchWorkgroups(Math.ceil(item.count / 64));
          prepare.end();
          pass = begin(true);
          pass.setPipeline(paint.pipelines.curves);
          pass.setBindGroup(0, item.group);
          pass.drawIndirect(paint.indirect!, 0);
          continue;
        }
        pass.setPipeline(paint.pipelines.edges);
        pass.setBindGroup(0, item.group);
        pass.draw(6, item.count);
      }
    }
    if (paint.options.poles) {
      pass.setPipeline(paint.pipelines.poles);
      for (const item of paint.vertices) {
        pass.setBindGroup(0, item.group);
        pass.draw(6, item.count);
      }
    }
    if (paint.options.markers) {
      pass.setPipeline(paint.pipelines.vertices);
      for (const item of paint.vertices) {
        pass.setBindGroup(0, item.group);
        pass.draw(6, item.count);
      }
    }
    pass.setPipeline(paint.pipelines.text);
    for (const item of paint.labels) {
      pass.setBindGroup(0, item.group);
      for (const page of item.pages) {
        pass.setBindGroup(1, page.bindGroup);
        pass.draw(6, page.count);
      }
    }
    pass.end();
  }
  prune(geometry: Geometry): void {
    const live = new Set<object>([...geometry.vertices, ...geometry.edges]);
    for (const [key, buffer] of this.buffers)
      if (!live.has(key)) {
        buffer.destroy();
        this.buffers.delete(key);
      }
  }
  destroy(): void {
    this.chunks.length = 0;
    for (const buffer of this.buffers.values()) buffer.destroy();
    this.buffers.clear();
    this.attachments.destroy();
    this.dummy.destroy();
    this.curves?.instances.destroy();
    this.curves?.indirect.destroy();
  }
}
