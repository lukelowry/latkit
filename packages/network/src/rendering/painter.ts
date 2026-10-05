import { kit, type Gpu, type Marker, type MarkerImage, type RGBA } from '@latkit/gpu';
import { failure, rowCount } from '@latkit/model';
import type { Camera } from '../camera.js';
import { DEG } from '../camera.js';
import { sameItem, type NetworkData, type NetworkItem } from '../data.js';
import {
  edgeOptions,
  vertexOptions,
  type Geometry,
  type VertexBank,
  type EdgeBank,
  type SegmentBatch,
} from '../geometry/topology.js';
import { lineColor, lineWidthPx, type Style } from '../options.js';
import type { LabelBatch } from './labels.js';
import type { FieldRead } from './fields.js';
import { DISC, markerPipeline, type Pipelines } from './pipelines.js';

/** Bytes of a page's uniform slot: its header and seven channels, or a marker's eight inputs. */
const SLOT = 256;
const SLOT_WORDS = SLOT / 4;
/** Bytes a drawn row holds: a vertex's five vec4, its marker's two inputs, an edge's three. */
const VERTEX_BYTES = 80;
const INPUT_BYTES = 32;
const LINE_BYTES = 48;
/** How long hover takes to grow a vertex, and to let it go. */
const GROW_MS = 160;
/** No vertex, as a dense address. */
const NONE = 0xffffffff;
/** Words of the uniforms' named members after their fourteen vec4, as `Uniforms` lays them out. */
const U = {
  easeShift: 56,
  ease: 58,
  dt: 59,
  dashPeriodPx: 60,
  edgeSpacingPx: 61,
  flowSpacingPx: 62,
  markers: 63,
  hoverScale: 64,
  labelHaloPx: 65,
  grown: 66,
  growth: 68,
  words: 72,
} as const;
/** A path's private points draw no markers. */
const HIDDEN: kit.ResolvedChannel = { component: 0, fallback: 0 };
/** The upload origin a raw axis reads relative to; a scaled or constant axis is absolute. */
function rebase(channel: kit.ResolvedChannel, page: kit.GpuPage): number {
  const field = channel.column === undefined ? undefined : page.columns[channel.column];
  return !channel.scale && field?.kind === 'value' ? (field.origin?.[channel.component] ?? 0) : 0;
}
/** A type's color for rows without one: its constant, its scale's missing color, or `fallback`. */
function typeColor(read: FieldRead, fallback: RGBA | null): RGBA {
  const { constant, missing } = read.bound.channels.color ?? {};
  if (Array.isArray(constant)) return constant as RGBA;
  if (Array.isArray(missing)) return missing as RGBA;
  return fallback ?? [0, 0, 0, -1];
}
/** The inputs a marker steps rather than eases, a bit each in the order it names them. */
function stepsOf(marker: Marker): number {
  const names = Object.keys(marker.inputs ?? {});
  return (marker.steps ?? []).reduce((bits, name) => bits | (1 << names.indexOf(name)), 0);
}
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** How a bank's rows draw: their type's marker, or a disc; a path's private points as discs. */
function markerOf(data: NetworkData, bank: VertexBank): Marker {
  return bank.synthetic ? DISC : (vertexOptions(data, bank).marker ?? DISC);
}
const inputCount = (data: NetworkData, bank: VertexBank) =>
  Object.keys(markerOf(data, bank).inputs ?? {}).length;

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
  /** Each bank's records, and what a transition eases them from, as `Painter.records` made them. */
  readonly records: Records;
  /** Whether flow moves and hover grows over time; false under reduced motion. */
  readonly motion: boolean;
  /**
   * A transition in progress: how much of what was drawn as it began still shows, from 1 to 0, and
   * whether it begins with this frame.
   */
  readonly transition: { readonly rest: number; readonly start: boolean } | null;
}
interface Command {
  readonly group: GPUBindGroup;
  readonly count: number;
  readonly tessellation?: GPUBindGroup;
  /** A vertex bank's marker; discs draw with the shared vertex pipeline. */
  readonly pipeline?: GPURenderPipeline;
  /** Its markers' shadows, drawn beneath every marker when the style casts them. */
  readonly shadows?: GPURenderPipeline;
}
interface Compute {
  readonly pipeline: GPUComputePipeline;
  readonly colors: GPUBindGroup;
  readonly fields: GPUBindGroup;
  readonly group: GPUBindGroup;
  readonly count: number;
}
/**
 * What this frame's compute pass eases from, made ready before it: banks' records copied as a
 * transition begins, snapshots cleared for banks new to the drawing, and every bank it eases.
 */
interface Easing {
  readonly copies: readonly { readonly from: GPUBuffer; readonly to: GPUBuffer }[];
  readonly clears: readonly GPUBuffer[];
  readonly eased: ReadonlySet<object>;
}
/** A frame's drawn records: each bank's, and what a transition eases them from. */
export interface Records {
  readonly outputs: ReadonlyMap<object, kit.BufferResource>;
  /** Undefined at rest, and when the GPU budget cannot hold what a transition eases from. */
  readonly easing?: Easing;
}
export interface Paint {
  readonly pipelines: Pipelines;
  /** What a transition in progress eases from; undefined at rest, or when the budget cannot hold it. */
  readonly easing?: Easing;
  readonly compute: readonly Compute[];
  readonly vertices: readonly Command[];
  readonly edges: readonly Command[];
  readonly labels: readonly { group: GPUBindGroup; pages: readonly kit.TextPage[] }[];
  readonly background: GPUBindGroup;
  readonly depth: GPUTextureView;
  readonly color?: GPUTextureView;
  readonly options: Style;
  readonly globe: boolean;
  readonly center: readonly [number, number];
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
/** A vertex hover grows or lets go: its dense address, when it started, and from how far. */
interface Growth {
  readonly dense: number;
  readonly since: number;
  readonly from: number;
}
export class Painter {
  /** Each bank's drawn records, and a marked bank's inputs after them. */
  private buffers = new Map<object, kit.BufferResource>();
  /** What each bank drew as the transition in progress began; released as it ends. */
  private readonly previous = new Map<object, kit.BufferResource>();
  /** The banks whose snapshots hold what the transition in progress eases from. */
  private eased: ReadonlySet<object> = new Set();
  /** Each marker's images, laid into an atlas once. */
  private readonly atlases = new WeakMap<readonly MarkerImage[], kit.TextureData>();
  private readonly noImages = new kit.TextureData({ width: 1, height: 1, format: 'rgba8unorm' });
  private readonly sampler: GPUSampler;
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
  /** The camera center the latest encoded frame drew around, and where `previous` was drawn. */
  private drawnCenter?: readonly [number, number];
  private easedCenter: readonly [number, number] = [0, 0];
  /** When the latest presented frame drew, which flow moves on from. */
  private presentedAt?: number;
  private grow: Growth = { dense: NONE, since: 0, from: 0 };
  private shrink: Growth = { dense: NONE, since: 0, from: 0 };
  /** Whether hover is still growing or letting go of a vertex, as of the latest presented frame. */
  growing = false;
  constructor(private readonly gpu: Gpu) {
    this.attachments = new kit.Attachments(gpu);
    this.dummy = gpu.buffer({
      size: 80,
      usage: GPUBufferUsage.STORAGE,
      label: 'network empty binding',
    });
    this.sampler = gpu.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      label: 'network marker images',
    });
  }
  /** A marker's images as one texture: its atlas, or a clear pixel without images. */
  private atlas(marker: Marker): kit.TextureData {
    const images = marker.images;
    if (!images?.length) return this.noImages;
    let found = this.atlases.get(images);
    if (!found) {
      const { data, width, height } = kit.markerAtlas(images);
      found = new kit.TextureData({ width, height, format: 'rgba8unorm' });
      found.write({ x: 0, y: 0, width, height, data });
      this.atlases.set(images, found);
    }
    return found;
  }
  /** A bank's drawn records, made again when their size changes. */
  private output(key: object, bytes: number): kit.BufferResource {
    const size = Math.max(80, bytes);
    let result = this.buffers.get(key);
    if (result?.buffer.size !== size) {
      result?.destroy();
      this.previous.get(key)?.destroy();
      this.previous.delete(key);
      result = this.gpu.buffer({
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        label: 'network drawn records',
      });
      this.buffers.set(key, result);
    }
    return result;
  }
  /**
   * What each bank's compute pass eases from while a transition runs: what it drew as the transition
   * began, copied then, or nothing for a bank new to the drawing, whose rows ease in. Undefined when
   * the GPU budget cannot hold the snapshots, and the change steps instead, as a diagram's does.
   */
  private easing(
    start: boolean,
    outputs: ReadonlyMap<object, kit.BufferResource>,
    made: ReadonlySet<object>,
  ): Easing | undefined {
    const copies: { from: GPUBuffer; to: GPUBuffer }[] = [],
      clears: GPUBuffer[] = [],
      eased = new Set<object>();
    try {
      for (const [bank, output] of outputs) {
        let into = this.previous.get(bank);
        if (!into) {
          into = this.gpu.buffer({
            size: output.buffer.size,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'network transition start',
          });
          this.previous.set(bank, into);
        }
        if (start && !made.has(bank)) copies.push({ from: output.buffer, to: into.buffer });
        else if (start || made.has(bank) || !this.eased.has(bank)) clears.push(into.buffer);
        eased.add(bank);
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'resource-limit') throw error;
      this.release();
      return undefined;
    }
    return { copies, clears, eased };
  }
  /** Let go of what a finished transition eased from. */
  private release(): void {
    for (const buffer of this.previous.values()) buffer.destroy();
    this.previous.clear();
    this.eased = new Set();
  }
  /**
   * The vertices hover grows and lets go, and how far each has: grown over `GROW_MS` as motion
   * allows, at once otherwise. Presented frames move it on; an export draws it as it stands.
   */
  private growth(state: DrawFrame, timeMs: number, presented: boolean): readonly number[] {
    const { options, hover, motion } = state,
      native = state.geometry.native ?? state.geometry;
    const at = (g: Growth, toward: number) =>
      g.dense === NONE
        ? 0
        : g.from +
          (toward - g.from) * easeOut(motion ? Math.min(1, (timeMs - g.since) / GROW_MS) : 1);
    if (presented && options.hoverScale !== 1) {
      const dense = hover?.kind === 'vertex' ? (native.adjacency.address(hover) ?? NONE) : NONE;
      if (dense !== this.grow.dense) {
        // A vertex hover returns to grows again from where letting go left it.
        const back = dense === this.shrink.dense ? at(this.shrink, 0) : 0;
        this.shrink = { dense: this.grow.dense, since: timeMs, from: at(this.grow, 1) };
        this.grow = { dense, since: timeMs, from: back };
      }
      this.growing =
        motion &&
        ((this.grow.dense !== NONE && timeMs - this.grow.since < GROW_MS) ||
          (this.shrink.dense !== NONE && timeMs - this.shrink.since < GROW_MS));
    } else if (presented) this.growing = false;
    return [this.grow.dense, this.shrink.dense, at(this.grow, 1), at(this.shrink, 0)];
  }
  /**
   * Each bank's drawn records for a frame, made again when their size changes, and what a
   * transition eases them from; the transition steps when the GPU budget cannot hold that. A
   * presented frame at rest lets go of what the last transition eased from.
   */
  records(
    geometry: Geometry,
    data: NetworkData,
    transition: { readonly start: boolean } | null,
    presented: boolean,
  ): Records {
    const outputs = new Map<object, kit.BufferResource>(),
      made = new Set<object>();
    const prepare = (bank: VertexBank | EdgeBank, bytes: number) => {
      const before = this.buffers.get(bank),
        output = this.output(bank, bytes);
      if (output !== before) made.add(bank);
      outputs.set(bank, output);
    };
    for (const bank of geometry.vertices)
      prepare(bank, bank.count * (VERTEX_BYTES + (inputCount(data, bank) ? INPUT_BYTES : 0)));
    for (const bank of geometry.edges) prepare(bank, bank.count * LINE_BYTES);
    if (!transition && presented && this.previous.size) this.release();
    return {
      outputs,
      easing: transition ? this.easing(transition.start, outputs, made) : undefined,
    };
  }
  async prepare(frame: kit.Preparation, state: DrawFrame): Promise<Paint> {
    const { gpu } = this,
      { camera, options, reads, geometry, data, transition } = state,
      { presented, timeMs } = frame;
    const pipeline = state.pipelines;
    const { color, depth } = this.attachments.prepare(frame, {
      msaa: options.msaa,
      depth: 'depth32float',
    });
    const f = new Float32Array(U.words),
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
    f.set(options.hoverColor, 20);
    f.set(options.selectedColor === 'none' ? [0, 0, 0, 0] : options.selectedColor, 24);
    f.set(
      [
        options.hoverWidthPx,
        options.selectedWidthPx,
        options.hoverWidthPx,
        options.selectedWidthPx,
      ],
      28,
    );
    f.set(
      [
        ...(state.pointer ?? [-1e6, -1e6]),
        options.nightFloor,
        Math.max(0.0001, options.terminatorWidth),
      ],
      32,
    );
    f.set(
      [
        ...sun(options.sunTime === 'now' ? Date.now() : options.sunTime),
        options.daylight && geometry.geographic ? 1 : 0,
      ],
      36,
    );
    f.set(
      [...options.surfaceColor.slice(0, 3), options.daylight ? options.surfaceNightFloor : 1],
      40,
    );
    f.set(options.gridColor, 44);
    u.set([0, options.grid ? 1 : 0, 0, 0], 48);
    f.set(options.flowColor, 52);
    const { outputs, easing } = state.records;
    if (transition?.start) this.easedCenter = this.drawnCenter ?? camera.center;
    if (transition && easing) {
      // Around the center the snapshot was drawn around; on a globe, the short way round.
      let dx = this.easedCenter[0] - camera.center[0];
      if (camera.projection === 'globe') dx -= 360 * Math.round(dx / 360);
      f.set([dx, this.easedCenter[1] - camera.center[1]], U.easeShift);
      f[U.ease] = transition.rest;
    }
    // Flow moves by the time since the latest presented frame, at most a tenth of a second.
    f[U.dt] =
      presented && state.motion && this.presentedAt !== undefined
        ? Math.min(0.1, Math.max(0, (timeMs - this.presentedAt) / 1000))
        : 0;
    if (presented) this.presentedAt = timeMs;
    f[U.dashPeriodPx] = options.dashPeriodPx;
    f[U.edgeSpacingPx] = options.edgeSpacingPx;
    f[U.flowSpacingPx] = options.flowSpacingPx;
    u[U.markers] = options.markers ? 1 : 0;
    f[U.hoverScale] = options.hoverScale;
    f[U.labelHaloPx] = options.labelHaloPx;
    const [grown, left, growth, shrink] = this.growth(state, timeMs, presented);
    u.set([grown, left], U.grown);
    f.set([growth, shrink], U.growth);
    this.updateFocus(state);
    const focusedBinding = frame.buffer(this.focus);
    const uniform = frame.uniforms(f),
      host = state.shade,
      empty = frame.buffer(this.dummy);
    const bound = new Map<
      object,
      { readonly output: GPUBufferBinding; previous: GPUBufferBinding }
    >();
    for (const [bank, output] of outputs)
      bound.set(bank, {
        output: frame.buffer(output),
        previous: easing ? frame.buffer(this.previous.get(bank)!) : empty,
      });
    // Write each page's slot, then bind them from the chunks that hold them.
    const pages: {
      readonly page: kit.GpuPage;
      readonly colors: GPUBindGroup;
      readonly bank: VertexBank | EdgeBank;
      readonly edge: boolean;
      /** A marked page's inputs slot. */
      readonly inputs?: number;
    }[] = [];
    let slots = 0;
    for (const bank of geometry.vertices)
      slots += reads.vertices.get(bank)!.pages.length * (inputCount(data, bank) ? 2 : 1);
    for (const bank of geometry.edges) slots += reads.edges.get(bank)!.pages.length;
    if (this.slots.length < slots * SLOT_WORDS) this.slots = new Uint32Array(slots * SLOT_WORDS);
    const words = this.slots.subarray(0, slots * SLOT_WORDS).fill(0),
      floats = new Float32Array(words.buffer, words.byteOffset, words.length);
    let used = 0;
    /** One compute dispatch per page: a vertex bank's, or the bank of a `line` type's options. */
    const write = (bank: VertexBank | EdgeBank, read: FieldRead, line?: object) => {
      const color = line
          ? typeColor(read, lineColor(line, options))
          : typeColor(read, options.vertexColor),
        colors = frame.colormap(read.bound.channels.color?.colormap),
        hidden = 'synthetic' in bank && !!bank.synthetic,
        marked = !line && inputCount(data, bank as VertexBank) > 0;
      for (const { page, offset } of read.pages) {
        const at = used++ * SLOT_WORDS;
        words[at] = rowCount(page.rows);
        words[at + 1] = offset;
        floats.set(color, at + 4);
        if (line) {
          pages.push({ page, colors, bank, edge: true });
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
          kit.writeChannel(words, at + 48, read.channel('flowPx'), page);
          kit.writeChannel(words, at + 56, read.channel('lane'), page);
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
          hidden ? HIDDEN : read.channel('radiusPx', options.vertexRadiusPx),
          page,
        );
        kit.writeChannel(words, at + 40, read.channel('color'), page);
        kit.writeChannel(words, at + 48, hidden ? HIDDEN : read.channel('visible'), page);
        kit.writeChannel(words, at + 56, read.channel('shade'), page);
        if (!marked) {
          pages.push({ page, colors, bank, edge: false });
          continue;
        }
        // Its inputs' slot: eight channels, read with the page's vertices.
        const inputs = used++ * SLOT_WORDS;
        for (let k = 0; k < kit.MARKER_INPUTS; k++)
          kit.writeChannel(words, inputs + k * 8, read.channel(('input' + k) as 'input0'), page);
        pages.push({ page, colors, bank, edge: false, inputs: inputs / SLOT_WORDS });
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
    const slotBinding = (i: number): GPUBufferBinding => {
      const chunk = bindings[Math.floor(i / perChunk)];
      return {
        buffer: chunk.buffer,
        offset: (chunk.offset ?? 0) + (i % perChunk) * SLOT,
        size: SLOT,
      };
    };
    /** Each marked bank's rows and stepped inputs, bound once for all its pages. */
    const markedBanks = new Map<VertexBank, GPUBufferBinding>();
    let slot = 0;
    const compute: Compute[] = pages.map(({ page, colors, bank, edge, inputs }) => {
      const own = slot;
      slot += inputs === undefined ? 1 : 2;
      const { output, previous } = bound.get(bank)!,
        entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: uniform },
          { binding: 1, resource: slotBinding(own) },
          { binding: 2, resource: output },
          { binding: 3, resource: previous },
        ];
      if (inputs !== undefined) {
        const vertexBank = bank as VertexBank;
        let marked = markedBanks.get(vertexBank);
        if (!marked)
          markedBanks.set(
            vertexBank,
            (marked = frame.uniforms(
              Uint32Array.of(vertexBank.count, stepsOf(markerOf(data, vertexBank)), 0, 0),
            )),
          );
        entries.push(
          { binding: 4, resource: slotBinding(inputs) },
          { binding: 5, resource: marked },
        );
      }
      return {
        pipeline: edge ? pipeline.edge : inputs === undefined ? pipeline.vertex : pipeline.marked,
        colors,
        fields: page.bindGroup,
        group: gpu.device.createBindGroup({
          layout: inputs === undefined ? pipeline.compute : pipeline.markedCompute,
          entries,
        }),
        count: rowCount(page.rows),
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
    const noImages = frame.texture(this.noImages).createView();
    /** `draw` is what the shader's `VertexDraw` or `EdgeDraw` reads. */
    const group = (
      a: GPUBufferBinding,
      b: GPUBufferBinding,
      segments: GPUBufferBinding,
      styles: GPUBufferBinding,
      draw: readonly [number, number, number, number],
      phase?: GPUBufferBinding,
      images: GPUTextureView = noImages,
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
            resource: frame.uniforms(Uint32Array.from(draw)),
          },
          { binding: 6, resource: host },
          { binding: 7, resource: focusedBinding },
          { binding: 8, resource: curveInstances },
          { binding: 9, resource: phase ?? empty },
          { binding: 11, resource: images },
          { binding: 12, resource: this.sampler },
        ],
      });
    const vertices: Command[] = [],
      edges: Command[] = [];
    for (const bank of geometry.vertices) {
      if (bank.synthetic) continue;
      const marker = markerOf(data, bank),
        images = marker.images?.length ? frame.texture(this.atlas(marker)).createView() : noImages;
      vertices.push({
        group: group(
          bound.get(bank)!.output,
          empty,
          empty,
          empty,
          [bank.base, bank.count, 0, 0],
          undefined,
          images,
        ),
        count: bank.count,
        pipeline: await markerPipeline(pipeline, marker),
        shadows: options.shadows ? await markerPipeline(pipeline, marker, true) : undefined,
      });
    }
    for (const bank of geometry.edges) {
      const curved = edgeOptions(data, bank).route === 'geodesic',
        dashed = reads.edges.get(bank)!.has('dash');
      for (const batch of bank.batches) {
        const count = batch.records.length / 4;
        const a = bound.get(batch.a)!.output,
          b = bound.get(batch.b)!.output,
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
            bound.get(bank)!.output,
            [geometry.vertexCount + bank.base, phase ? 1 : 0, batch.a.base, batch.b.base],
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
      easing,
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
      center: camera.center,
      drawCalls:
        1 +
        (camera.projection === 'globe' && options.earthAxis ? 1 : 0) +
        (options.markers ? vertices.length * (options.shadows ? 2 : 1) : 0) +
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
    // What each bank drew, kept as a transition begins; the compute pass then eases from it.
    const easing = paint.easing;
    if (easing) {
      for (const { from, to } of easing.copies)
        frame.encoder.copyBufferToBuffer(from, 0, to, 0, from.size);
      for (const buffer of easing.clears) frame.encoder.clearBuffer(buffer);
      this.eased = easing.eased;
    }
    this.drawnCenter = paint.center;
    const compute = frame.encoder.beginComputePass({ label: 'network native fields to geometry' });
    for (const command of paint.compute) {
      compute.setPipeline(command.pipeline);
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
      // Every marker's shadow first, so none darkens another marker.
      for (const item of paint.vertices)
        if (item.shadows) {
          pass.setPipeline(item.shadows);
          pass.setBindGroup(0, item.group);
          pass.draw(6, item.count);
        }
      for (const item of paint.vertices) {
        pass.setPipeline(item.pipeline ?? paint.pipelines.vertices);
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
    for (const map of [this.buffers, this.previous])
      for (const [key, buffer] of map)
        if (!live.has(key)) {
          buffer.destroy();
          map.delete(key);
        }
  }
  destroy(): void {
    this.chunks.length = 0;
    for (const map of [this.buffers, this.previous]) {
      for (const buffer of map.values()) buffer.destroy();
      map.clear();
    }
    this.attachments.destroy();
    this.dummy.destroy();
    this.curves?.instances.destroy();
    this.curves?.indirect.destroy();
  }
}
