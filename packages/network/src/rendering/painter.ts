import { kit, type Gpu, type Shade } from '@latkit/gpu';
import { failure, rowCount } from '@latkit/model';
import type { Camera } from '../camera.js';
import { DEG, turn } from '../camera.js';
import {
  sameItem,
  type NetworkData,
  type NetworkItem,
  type VertexData,
  type EdgeData,
  type PathData,
} from '../data.js';
import {
  vertexOptions,
  edgeOptions,
  type Geometry,
  type VertexBank,
  type EdgeBank,
  type SegmentBatch,
} from '../geometry/topology.js';
import type { Style } from '../options.js';
import type { LabelBatch } from './labels.js';
import type { FieldRead } from './fields.js';
import { pipelines, type Pipelines } from './pipelines.js';

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
  readonly shade: Shade | null;
  readonly host: Float32Array;
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
  private phases = new WeakMap<SegmentBatch, kit.BufferData>();
  private curves?: {
    capacity: number;
    instances: kit.BufferResource;
    indirect: kit.BufferResource;
  };
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
    const pipeline = await pipelines(
      gpu,
      frame.format,
      options.msaa,
      state.shade?.wgsl ?? kit.defaultShade,
    );
    const { color, depth } = this.attachments.prepare(frame, {
      msaa: options.msaa,
      depth: 'depth32float',
    });
    const bytes = new ArrayBuffer(16 * 16),
      f = new Float32Array(bytes),
      u = new Uint32Array(bytes);
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
    f.set(options.vertexBaseColor, 20);
    f.set(options.edgeBaseColor ?? [0, 0, 0, -1], 24);
    f.set(
      [
        options.vertexRadiusPx,
        options.edgeWidthPx / 2,
        options.dashPeriodPx,
        options.markers ? 1 : 0,
      ],
      28,
    );
    f.set([...options.hoverColor.slice(0, 3), options.hoverAlpha], 32);
    f.set(
      options.selectedColor
        ? [...options.selectedColor.slice(0, 3), options.selectedAlpha]
        : [0, 0, 0, 0],
      36,
    );
    f.set(
      [
        options.hoverWidthPx,
        options.selectedWidthPx,
        options.hoverWidthPx,
        options.selectedWidthPx,
      ],
      40,
    );
    f.set(
      [
        ...(state.pointer ?? [-1e6, -1e6]),
        options.nightFloor,
        Math.max(0.0001, options.terminatorWidth),
      ],
      44,
    );
    f.set(
      [...sun(options.sunTime ?? Date.now()), options.daylight && geometry.geographic ? 1 : 0],
      48,
    );
    f.set(
      [...options.surfaceColor.slice(0, 3), options.daylight ? options.surfaceNightFloor : 1],
      52,
    );
    f.set(options.gridColor, 56);
    u.set([options.focusEnabled ? 1 : 0, options.graticule ? 1 : 0, 0, 0], 60);
    this.updateFocus(state);
    const focusedBinding = frame.buffer(this.focus);
    const uniform = frame.uniforms(f),
      host = frame.shade({ parameters: state.host, pointerPx: state.pointer }),
      empty = frame.buffer(this.dummy);
    const vertexBuffers = new Map<VertexBank, GPUBufferBinding>(),
      edgeBuffers = new Map<EdgeBank, GPUBufferBinding>();
    for (const bank of geometry.vertices)
      vertexBuffers.set(bank, frame.buffer(this.output(bank, bank.count * 80)));
    for (const bank of geometry.edges)
      edgeBuffers.set(bank, frame.buffer(this.output(bank, bank.count * 32)));
    const compute: Compute[] = [];
    const makeCompute = (
      bank: VertexBank | EdgeBank,
      read: FieldRead,
      config: VertexData | EdgeData | PathData,
      edge: boolean,
    ) => {
      for (const { page, offset } of read.pages) {
        const data = new ArrayBuffer(12 * 16),
          pf = new Float32Array(data),
          pu = new Uint32Array(data);
        const slot = (name: string) => {
          const field = page.columns[name];
          return field && 'slot' in field ? field.slot : 0xffffffff;
        };
        const origin = (name: string, lane = 0) => {
          const field = page.columns[name];
          return field?.kind === 'value' ? (field.origin?.[lane] ?? 0) : 0;
        };
        pu.set(
          [
            slot(read.vector ? 'position' : 'x'),
            slot(read.vector ? 'position' : 'y'),
            slot('size'),
            slot('height'),
          ],
          0,
        );
        pu.set([slot('color'), slot('visible'), slot('shade'), slot('dash')], 4);
        pu.set([rowCount(page.rows), offset, read.vector ? 2 : 1, 'synthetic' in bank ? 1 : 0], 8);
        const ox = origin(read.vector ? 'position' : 'x'),
          oy = origin(read.vector ? 'position' : 'y', read.vector ? 1 : 0);
        const longitude = turn(camera.center[0], ox) * DEG,
          latitude = oy * DEG;
        pf.set(
          [ox - camera.center[0], oy - camera.center[1], Math.sin(longitude), Math.cos(longitude)],
          12,
        );
        pf.set([Math.sin(latitude), Math.cos(latitude), 0, 0], 16);
        for (const [name, at] of [
          ['color', 20],
          ['size', 28],
          ['height', 36],
        ] as const) {
          const field = page.columns[name];
          pf.set(
            kit.scaleParameters(read.scales[name] ?? kit.resolveScale({}, null), {
              origin: field?.kind === 'value' ? field.origin?.[0] : undefined,
            }),
            at,
          );
        }
        pf.set([origin('visible'), origin('shade'), origin('dash'), 0], 44);
        const colors = frame.colormap(config.color?.colormap);
        const output = edge
          ? edgeBuffers.get(bank as EdgeBank)!
          : vertexBuffers.get(bank as VertexBank)!;
        let styleUniform = uniform;
        if ('baseColor' in config || 'points' in config) {
          const values = f.slice();
          values.set((config as PathData).baseColor ?? [0.52, 0.6, 0.68, 0.6], 24);
          styleUniform = frame.uniforms(values);
        }
        const group = gpu.device.createBindGroup({
          layout: pipeline.compute,
          entries: [
            { binding: 0, resource: styleUniform },
            { binding: 1, resource: frame.uniforms(pf) },
            { binding: 2, resource: output },
          ],
        });
        compute.push({ colors, fields: page.bindGroup, group, count: rowCount(page.rows), edge });
      }
    };
    for (const bank of geometry.vertices)
      makeCompute(bank, reads.vertices.get(bank)!, vertexOptions(data, bank), false);
    for (const bank of geometry.edges)
      makeCompute(bank, reads.edges.get(bank)!, edgeOptions(data, bank), true);
    const curveCount = Math.max(
      0,
      ...geometry.edges
        .filter((bank) => edgeOptions(data, bank).curve === 'geodesic')
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
      style = uniform,
      phase?: GPUBufferBinding,
    ) =>
      gpu.device.createBindGroup({
        layout: pipeline.draw,
        entries: [
          { binding: 0, resource: style },
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
      let style = uniform;
      if (bank.kind === 'path') {
        const config = data.paths![bank.type],
          values = f.slice();
        values[29] = (config.widthPx ?? 1) / 2;
        values.set(config.baseColor ?? [0.52, 0.6, 0.68, 0.6], 24);
        style = frame.uniforms(values);
      }
      for (const batch of bank.batches) {
        const config = edgeOptions(data, bank);
        const curved = config.curve === 'geodesic',
          count = batch.records.length / 4;
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
                  resource: frame.uniforms(
                    Uint32Array.of(count, 'dash' in config && config.dash ? 1 : 0, 0, 0),
                  ),
                },
              ],
            })
          : undefined;
        let phase: GPUBufferBinding | undefined;
        const values = state.phases.get(batch);
        if (values) {
          let buffer = this.phases.get(batch);
          if (!buffer) {
            buffer = new kit.BufferData({ size: values.byteLength, label: 'network dash phases' });
            this.phases.set(batch, buffer);
          }
          buffer.write({ data: values });
          phase = frame.buffer(buffer);
        }
        edges.push({
          group: group(
            a,
            b,
            segments,
            edgeBuffers.get(bank)!,
            geometry.vertexCount + bank.base,
            style,
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
      last.options.focusEnabled === options.focusEnabled &&
      last.options.focusEnds === options.focusEnds
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
      if (
        item.kind === 'edge' &&
        (options.focusEnds === 'hover-selected' ||
          (level === 2 && options.focusEnds === 'selected'))
      )
        for (const vertex of adjacency.neighborhood(item, data))
          if (vertex.kind === 'vertex') mark(vertex, level);
    };
    if (options.focusEnabled) {
      for (const item of state.selection) focus(item, 2);
      if (state.hover) focus(state.hover, 1);
    }
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
            clearValue: paint.options.background,
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
    for (const buffer of this.buffers.values()) buffer.destroy();
    this.buffers.clear();
    this.attachments.destroy();
    this.dummy.destroy();
    this.curves?.instances.destroy();
    this.curves?.indirect.destroy();
  }
}
