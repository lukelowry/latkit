import {
  kit,
  type Gpu,
  type Marker,
  type MarkerImage,
  type ProjectedCamera,
  type RGBA,
} from '@latkit/gpu';
import { failure, rowCount } from '@latkit/model';
import { networkKey, type NetworkData, type NetworkItem } from '../data.js';
import {
  curvedAt,
  edgeOptions,
  ownerSegments,
  routeOf,
  vertexOptions,
  type Geometry,
  type VertexBank,
  type EdgeBank,
  type SegmentBatch,
} from '../geometry/topology.js';
import { lineColor, type Style } from '../options.js';
import type { LabelBatch } from './labels.js';
import type { FieldRead } from './fields.js';
import { DISC, linePipeline, markerPipeline, type Pipelines } from './pipelines.js';

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
/** Focus levels, as draw.wgsl reads them; the higher wins. */
const END = 1,
  HOVERED = 2,
  SELECTED = 3;
/** Past this many runs of focused instances, a focus draw takes every row, keeping the focused. */
const RANGES = 64;
/** Changed focus words this close upload in one write: on the GPU, a write costs about as much. */
const WRITE_BYTES = 4096;
/** Instances as `[first, count]` runs; `all` past `RANGES` of them. */
type Focused = readonly (readonly [number, number])[] | 'all';
/** The runs of ascending instances. */
function focusRuns(instances: readonly number[]): Focused | undefined {
  if (!instances.length) return undefined;
  const out: [number, number][] = [];
  for (const i of instances) {
    const last = out.at(-1);
    if (last && i <= last[0] + last[1]) last[1] = Math.max(last[1], i + 1 - last[0]);
    else out.push([i, 1]);
  }
  return out.length > RANGES ? 'all' : out;
}
const sameHover = (a: NetworkItem | null, b: NetworkItem | null) =>
  a === b || (!!a && !!b && networkKey(a) === networkKey(b));
/** Words of the uniforms' members, as `Uniforms` lays them out: the scene block first. */
const U = {
  light: kit.Projector.floats,
  hoverColor: 32,
  selectedColor: 36,
  glow: 40,
  halo: 44,
  flowColor: 48,
  easeShift: 52,
  ease: 54,
  dt: 55,
  dashPeriodPx: 56,
  edgeSpacingPx: 57,
  flowSpacingPx: 58,
  markers: 59,
  hoverScale: 60,
  labelHaloPx: 61,
  grown: 62,
  growth: 64,
  words: 68,
} as const;
/** An edge's private bends and junctions draw no markers. */
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
/** How a bank's rows draw: their type's marker, or a disc; an edge's private points as discs. */
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
  readonly camera: ProjectedCamera;
  /** The frame's camera on its viewport, which writes the projection block. */
  readonly projector: kit.Projector;
  /** The sun of the geography beneath, which dims the network at night; none without one. */
  readonly light: kit.Light | null;
  /** What label halos match: the ground beneath, or the background. */
  readonly halo: RGBA;
  /** Whether a geography draws beneath, in this pass, which hides the globe's far side itself. */
  readonly grounded: boolean;
  readonly options: Style;
  readonly data: NetworkData;
  readonly geometry: Geometry;
  readonly reads: Reads;
  /** Replaced whenever it changes. */
  readonly selection: readonly NetworkItem[];
  readonly hover: NetworkItem | null;
  readonly height: number;
  readonly pipelines: Pipelines;
  /** This frame's shade uniforms. */
  readonly shade: GPUBufferBinding;
  readonly labels: readonly LabelBatch[];
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
  /** A curved batch's indirect draw, which its tessellation counts. */
  readonly record?: number;
  /** A vertex bank's marker; discs draw with the shared vertex pipeline. */
  readonly pipeline?: GPURenderPipeline;
  /** Its markers' shadows, drawn beneath every marker when the style casts them. */
  readonly shadows?: GPURenderPipeline;
  readonly focus?: Focus;
}
/**
 * A command's focused instances, which draw again over the rest with their pipeline: runs of its
 * instances, or a curved batch's span of focused segments, tessellated alone into its own draw.
 */
type Focus =
  | { readonly pipeline: GPURenderPipeline; readonly runs: Focused }
  | { readonly pipeline: GPURenderPipeline; readonly group: GPUBindGroup; readonly record: number };
/** The draws a command takes: the scene's, then its focused instances'. */
function drawsOf(item: Command): number {
  const focus = item.focus;
  if (!focus) return 1;
  return 1 + ('record' in focus || focus.runs === 'all' ? 1 : focus.runs.length);
}
/** A curved draw's tessellation: its bound segments, and how many. */
interface Tessellation {
  readonly group: GPUBindGroup;
  readonly count: number;
}
/**
 * Pieces every curved draw has room for past one per segment, beside a quarter more: enough for a
 * few curves split as finely as they go.
 */
const POOL_PIECES = 256;
/** Curve pieces a buffer grows by, so a focused span coming and going makes nothing again. */
const PIECE_STEP = 16384;
/** What a curved draw's segments read, as `Curves.flags` and `EdgeDraw.flags` hold it. */
const DASHED = 1,
  STRAIGHT = 2;
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
  /** The geography beneath, drawn first in the pass. */
  readonly ground?: kit.PreparedLayer;
  /** The scene block this frame's uniforms begin with, which the geography beneath binds. */
  readonly scene: GPUBufferBinding;
  /** The globe's depth alone, when nothing beneath draws the ground: the uniforms, bound. */
  readonly occlusion?: GPUBindGroup;
  readonly depth: GPUTextureView;
  readonly color?: GPUTextureView;
  readonly options: Style;
  readonly globe: boolean;
  readonly center: readonly [number, number];
  /** Every curved draw's tessellation, which the compute pass runs, then counts into `indirect`. */
  readonly curves?: {
    readonly tessellations: readonly Tessellation[];
    readonly finish: GPUBindGroup;
    readonly records: number;
    readonly indirect: GPUBuffer;
  };
  readonly drawCalls: number;
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
  /** The dense addresses of focused rows, ascending. */
  private focusedRows: readonly number[] = [];
  private focused?: {
    readonly geometry: Geometry;
    readonly selection: readonly NetworkItem[];
    readonly hover: NetworkItem | null;
    readonly options: Style;
  };
  /** Each routed batch's dash prefixes, uploaded once. */
  private readonly prefixes = new WeakMap<SegmentBatch, kit.BufferData>();
  /** Each bank's and batch's draw words, by role. */
  private readonly words = new WeakMap<object, Map<string, kit.BufferData>>();
  /**
   * Every curved draw's pieces, the pieces each took from its pool, and their indirect draws: grown
   * as the curves need, and held while they fit.
   */
  private curves?: {
    readonly pieces: kit.BufferResource;
    readonly taken: kit.BufferResource;
    readonly indirect: kit.BufferResource;
    readonly rooms: kit.BufferData;
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
  /**
   * A bank's or batch's words in a role, as a uniform: two vec4 held on the GPU, which upload only
   * the words that changed, so a frame that only moves the camera uploads none.
   */
  private wordsOf(key: object, role: string, words: readonly number[]): kit.BufferData {
    let byRole = this.words.get(key);
    if (!byRole) this.words.set(key, (byRole = new Map<string, kit.BufferData>()));
    let found = byRole.get(role);
    if (!found)
      byRole.set(
        role,
        (found = new kit.BufferData({
          size: 32,
          usage: GPUBufferUsage.UNIFORM,
          label: 'network draw',
        })),
      );
    found.update(Uint32Array.from({ length: 8 }, (_, i) => words[i] ?? 0));
    return found;
  }
  /** A routed batch's dash prefixes, uploaded once. */
  private prefixesOf(batch: SegmentBatch): kit.BufferData {
    let found = this.prefixes.get(batch);
    if (!found) {
      found = new kit.BufferData({
        size: batch.prefixes!.byteLength,
        label: 'network dash prefixes',
      });
      found.write({ data: batch.prefixes! });
      this.prefixes.set(batch, found);
    }
    return found;
  }
  /**
   * Room for a frame's curved draws: `pieces` in all, and each draw's segments and room as `rooms`
   * pairs them. Buffers are made a step larger than they need, and made again once the curves no
   * longer fit, or fit in a quarter of them.
   */
  private curveBuffers(pieces: number, rooms: readonly number[]): NonNullable<Painter['curves']> {
    const records = rooms.length / 2,
      held = this.curves,
      size = held?.pieces.buffer.size ?? 0;
    if (
      !held ||
      size < pieces * 16 ||
      size > pieces * 64 + PIECE_STEP * 16 ||
      held.taken.buffer.size < records * 4
    ) {
      const grown = (n: number, step: number) => Math.ceil(Math.max(1, n) / step) * step;
      this.destroyCurves();
      const made: kit.BufferResource[] = [];
      try {
        const buffer = (size: number, usage: number, label: string) => {
          const resource = this.gpu.buffer({ size, usage, label });
          made.push(resource);
          return resource;
        };
        this.curves = {
          pieces: buffer(
            grown(pieces, PIECE_STEP) * 16,
            GPUBufferUsage.STORAGE,
            'network curve pieces',
          ),
          // Zeroed as made, and emptied by each frame's count after.
          taken: buffer(grown(records, 64) * 4, GPUBufferUsage.STORAGE, 'network curve pools'),
          indirect: buffer(
            grown(records, 64) * 16,
            GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT,
            'network curve draws',
          ),
          rooms: new kit.BufferData({ size: 8, label: 'network curve rooms' }),
        };
      } catch (error) {
        for (const resource of made) resource.destroy();
        throw error;
      }
    }
    this.curves!.rooms.update(Uint32Array.from(rooms));
    return this.curves!;
  }
  private destroyCurves(): void {
    this.curves?.pieces.destroy();
    this.curves?.taken.destroy();
    this.curves?.indirect.destroy();
    this.curves = undefined;
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
    // What the geometry no longer draws lets go first, so its room serves the banks made now, even
    // when no frame has been submitted since it changed.
    this.prune(geometry);
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
    state.projector.write(f, 0, geometry.geographic, state.height);
    f.set(options.hoverColor, U.hoverColor);
    // `none` glows in each item's own color.
    f.set(
      options.selectedColor === 'none' ? [0, 0, 0, -1] : options.selectedColor,
      U.selectedColor,
    );
    f.set(
      [
        options.hoverWidthPx,
        options.selectedWidthPx,
        state.selection.length ? options.unselectedAlpha : 1,
        0,
      ],
      U.glow,
    );
    // Only geographic positions face the sun.
    kit.Projector.light(f, U.light, geometry.geographic ? state.light : null);
    f.set(state.halo, U.halo);
    f.set(options.flowColor, U.flowColor);
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
    /** One compute dispatch per page: a vertex bank's, or an edge bank's. */
    const write = (bank: VertexBank | EdgeBank, read: FieldRead, line = false) => {
      const color = line
          ? typeColor(read, lineColor(options))
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
          kit.writeChannel(words, at + 16, read.channel('widthPx', options.edgeWidthPx), page);
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
    for (const bank of geometry.edges) write(bank, reads.edges.get(bank)!, true);
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
    /** The focused rows among `count` dense addresses from `base`, as ascending offsets from it. */
    const focusedIn = (base: number, count: number): readonly number[] => {
      const rows = this.focusedRows;
      if (!rows.length) return rows;
      const out: number[] = [];
      let lo = 0,
        hi = rows.length;
      while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (rows[m] < base) lo = m + 1;
        else hi = m;
      }
      for (let i = lo; i < rows.length && rows[i] < base + count; i++) out.push(rows[i] - base);
      return out;
    };
    // Each edge batch's draw, and a curved one's region of the pieces: one per segment, then its pool.
    const rooms: number[] = [];
    let pieces = 0;
    const region = (count: number) => {
      const room = count + Math.ceil(count / 4) + POOL_PIECES,
        found = { record: rooms.length / 2, base: pieces, room };
      rooms.push(count, room);
      pieces += room;
      return found;
    };
    const plans = geometry.edges.flatMap((bank) => {
      if (edgeOptions(data, bank).route === 'geodesic' && !geometry.geographic)
        throw failure('invalid-input', 'Geodesics require geographic coordinates');
      const curved = curvedAt(data, bank, camera.projection, geometry.geographic),
        dashed = reads.edges.get(bank)!.has('dash'),
        straight = routeOf(data, bank, camera.projection) === 'straight',
        owners = focusedIn(geometry.vertexCount + bank.base, bank.count);
      return bank.batches.map((batch) => {
        // The segments of focused rows, ascending as their owners are, which draw again over the rest.
        const focused: number[] = [];
        for (const owner of owners) {
          const [first, end] = ownerSegments(batch.records, owner);
          for (let s = first; s < end; s++) focused.push(s);
        }
        const count = batch.records.length / 4,
          span = focused.length ? focused.at(-1)! - focused[0] + 1 : 0;
        return {
          bank,
          batch,
          count,
          focused,
          dashed,
          straight,
          // A curve's pieces come from its tessellation, so its focused span tessellates alone.
          curve: curved
            ? { scene: region(count), focus: span ? region(span) : undefined }
            : undefined,
        };
      });
    });
    const curves = rooms.length ? this.curveBuffers(pieces, rooms) : undefined,
      piecesBinding = curves ? frame.buffer(curves.pieces) : empty;
    const noImages = frame.texture(this.noImages).createView();
    /** A bank's or batch's words in a role, held on the GPU and uploaded only as they change. */
    const kept = (key: object, role: string, words: readonly number[]) =>
      frame.buffer(this.wordsOf(key, role, words));
    /** `draw` is what the shader's `VertexDraw` or `EdgeDraw` reads. */
    const group = (
      a: GPUBufferBinding,
      b: GPUBufferBinding,
      segments: GPUBufferBinding,
      styles: GPUBufferBinding,
      draw: GPUBufferBinding,
      prefixes?: GPUBufferBinding,
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
          { binding: 5, resource: draw },
          { binding: 6, resource: host },
          { binding: 7, resource: focusedBinding },
          { binding: 8, resource: piecesBinding },
          { binding: 9, resource: prefixes ?? empty },
          { binding: 11, resource: images },
          { binding: 12, resource: this.sampler },
        ],
      });
    const vertices: Command[] = [],
      edges: Command[] = [],
      tessellations: Tessellation[] = [];
    for (const bank of geometry.vertices) {
      if (bank.synthetic) continue;
      const marker = markerOf(data, bank),
        images = marker.images?.length ? frame.texture(this.atlas(marker)).createView() : noImages,
        runs = focusRuns(focusedIn(bank.base, bank.count));
      vertices.push({
        group: group(
          bound.get(bank)!.output,
          empty,
          empty,
          empty,
          kept(bank, 'draw', [bank.base, bank.count]),
          undefined,
          images,
        ),
        count: bank.count,
        pipeline: await markerPipeline(pipeline, marker),
        shadows: options.shadows ? await markerPipeline(pipeline, marker, 'shadows') : undefined,
        focus: runs && { pipeline: await markerPipeline(pipeline, marker, 'focus'), runs },
      });
    }
    const takenBinding = curves && frame.buffer(curves.taken);
    for (const { bank, batch, count, focused, dashed, straight, curve } of plans) {
      const a = bound.get(batch.a)!.output,
        b = bound.get(batch.b)!.output,
        segments = frame.buffer(batch.data),
        prefixes = dashed && batch.prefixes ? frame.buffer(this.prefixesOf(batch)) : undefined,
        draw = [
          geometry.vertexCount + bank.base,
          (prefixes ? DASHED : 0) | (straight ? STRAIGHT : 0),
          batch.a.base,
          batch.b.base,
        ];
      /** Tessellate `count` segments from `first` into a curved draw's region. */
      const tessellate = (
        role: string,
        count: number,
        first: number,
        { record, base, room }: { record: number; base: number; room: number },
      ) => {
        tessellations.push({
          count,
          group: gpu.device.createBindGroup({
            layout: pipeline.tessellation,
            entries: [
              { binding: 0, resource: uniform },
              { binding: 1, resource: a },
              { binding: 2, resource: b },
              { binding: 3, resource: segments },
              { binding: 4, resource: piecesBinding },
              { binding: 5, resource: takenBinding! },
              {
                binding: 6,
                resource: kept(batch, role + ' curves', [
                  count,
                  first,
                  (dashed ? DASHED : 0) | (straight ? STRAIGHT : 0),
                  base,
                  room,
                  record,
                ]),
              },
            ],
          }),
        });
        return group(
          a,
          b,
          segments,
          bound.get(bank)!.output,
          kept(batch, role, [...draw, base]),
          prefixes,
        );
      };
      let focus: Focus | undefined;
      const runs = focusRuns(focused);
      if (runs) {
        const lines = await linePipeline(pipeline, !!curve, 'focus');
        focus = curve?.focus
          ? {
              pipeline: lines,
              group: tessellate('focus', focused.at(-1)! - focused[0] + 1, focused[0], curve.focus),
              record: curve.focus.record,
            }
          : { pipeline: lines, runs };
      }
      edges.push({
        group: curve
          ? tessellate('scene', count, 0, curve.scene)
          : group(a, b, segments, bound.get(bank)!.output, kept(batch, 'scene', draw), prefixes),
        count,
        record: curve?.scene.record,
        focus,
      });
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
    // Without a ground drawn beneath, the globe still hides what lies behind it.
    const globe = camera.projection === 'globe',
      occlusion =
        globe && !state.grounded
          ? gpu.device.createBindGroup({
              layout: pipeline.occlusion,
              entries: [{ binding: 0, resource: uniform }],
            })
          : undefined;
    return {
      pipelines: pipeline,
      easing,
      curves: curves && {
        tessellations,
        records: rooms.length / 2,
        indirect: curves.indirect.buffer,
        finish: gpu.device.createBindGroup({
          layout: pipeline.finishing,
          entries: [
            { binding: 5, resource: takenBinding! },
            { binding: 7, resource: frame.buffer(curves.rooms) },
            { binding: 8, resource: frame.buffer(curves.indirect) },
          ],
        }),
      },
      compute,
      vertices,
      edges,
      labels,
      scene: { buffer: uniform.buffer, offset: uniform.offset ?? 0, size: kit.Projector.scene * 4 },
      occlusion,
      depth: depth!,
      color,
      options,
      globe,
      center: camera.center,
      drawCalls:
        (occlusion ? 1 : 0) +
        (options.markers
          ? vertices.reduce((n, item) => n + drawsOf(item), 0) +
            (options.shadows ? vertices.length : 0)
          : 0) +
        (options.poles ? vertices.length : 0) +
        (options.lines ? edges.reduce((n, item) => n + drawsOf(item), 0) : 0) +
        labels.reduce((n, v) => n + v.pages.length, 0),
    };
  }
  /**
   * Rewrite only the focus words that changed, and only when selection, hover, or geometry do; and
   * list the focused rows, which draw again over the rest.
   */
  private updateFocus(state: DrawFrame): void {
    const { geometry, options, data } = state,
      native = geometry.native ?? geometry,
      last = this.focused;
    if (
      last?.geometry === native &&
      last.selection === state.selection &&
      sameHover(last.hover, state.hover) &&
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
      if (item.kind === 'edge' && (level === SELECTED ? options.selectedEnds : options.hoverEnds))
        for (const vertex of adjacency.neighborhood(item, data))
          if (vertex.kind === 'vertex') mark(vertex, END);
    };
    for (const item of state.selection) focus(item, SELECTED);
    if (state.hover) focus(state.hover, HOVERED);
    // Sixteen rows per word, padded to whole 16-byte rows.
    const rows = native.vertexCount + native.edgeCount,
      size = Math.max(16, Math.ceil(rows / 64) * 16);
    if (this.focus.size !== size) this.focus.resize(size);
    const bytes = this.focus.bytes,
      words = new Uint32Array(bytes.buffer, bytes.byteOffset, size / 4),
      changed: number[] = [];
    const write = (word: number, value: number) => {
      if (word >= words.length || words[word] === value) return;
      words[word] = value;
      changed.push(word);
    };
    for (const word of this.focusWords.keys()) if (!next.has(word)) write(word, 0);
    for (const [word, value] of next) write(word, value);
    // Words far apart, as a selected edge and its ends are, upload apart rather than with every
    // word between them.
    changed.sort((x, y) => x - y);
    const edited: { offset: number; size: number }[] = [];
    for (const word of changed) {
      const last = edited.at(-1);
      if (last && word * 4 - (last.offset + last.size) < WRITE_BYTES)
        last.size = word * 4 + 4 - last.offset;
      else edited.push({ offset: word * 4, size: 4 });
    }
    if (edited.length) this.focus.touch(edited);
    this.focusWords = next;
    const dense: number[] = [];
    for (const word of [...next.keys()].sort((x, y) => x - y))
      for (let k = 0, bits = next.get(word)!; k < 16; k++)
        if ((bits >>> (k * 2)) & 3) dense.push(word * 16 + k);
    this.focusedRows = dense;
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
    // What the ground's draw reads, recorded before any pass of the network's.
    paint.ground?.encode(frame);
    const compute = frame.encoder.beginComputePass({ label: 'network fields, then curves' });
    for (const command of paint.compute) {
      compute.setPipeline(command.pipeline);
      compute.setBindGroup(0, command.fields);
      compute.setBindGroup(1, command.group);
      compute.setBindGroup(2, command.colors);
      compute.dispatchWorkgroups(Math.ceil(command.count / 64));
    }
    // Curves tessellate from the geometry just made, each into its region, then count their pieces.
    const curves = paint.curves;
    if (curves) {
      compute.setPipeline(paint.pipelines.tessellate);
      for (const { group, count } of curves.tessellations) {
        compute.setBindGroup(0, group);
        compute.dispatchWorkgroups(Math.ceil(count / 64));
      }
      compute.setPipeline(paint.pipelines.finish);
      compute.setBindGroup(0, curves.finish);
      compute.dispatchWorkgroups(Math.ceil(curves.records / 64));
    }
    compute.end();
    const pass = frame.encoder.beginRenderPass({
      label: 'network',
      colorAttachments: [
        {
          view: paint.color ?? frame.target,
          resolveTarget: paint.color ? frame.target : undefined,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: kit.clearColor(paint.options.background),
        },
      ],
      depthStencilAttachment: {
        view: paint.depth,
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    /** A curved draw's pieces, as its tessellation counted them. */
    const curve = (pipeline: GPURenderPipeline, group: GPUBindGroup, record: number) => {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.drawIndirect(curves!.indirect, record * 16);
    };
    /** A command's focused instances, over the rest. */
    const over = (item: Command) => {
      const focus = item.focus;
      if (!focus) return;
      if ('record' in focus) return curve(focus.pipeline, focus.group, focus.record);
      pass.setPipeline(focus.pipeline);
      pass.setBindGroup(0, item.group);
      if (focus.runs === 'all') pass.draw(6, item.count);
      else for (const [first, count] of focus.runs) pass.draw(6, count, 0, first);
    };
    // What lies beneath draws first; without it, a globe writes its depth alone.
    if (paint.ground) paint.ground.draw(pass);
    else if (paint.occlusion) {
      pass.setPipeline(paint.pipelines.occlude);
      pass.setBindGroup(0, paint.occlusion);
      pass.draw(3);
    }
    if (paint.options.lines)
      for (const item of paint.edges) {
        if (item.record !== undefined) {
          curve(paint.pipelines.curves, item.group, item.record);
          continue;
        }
        pass.setPipeline(paint.pipelines.edges);
        pass.setBindGroup(0, item.group);
        pass.draw(6, item.count);
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
    // Focused rows draw again over everything but labels: nothing covers them, and their glow lights
    // their neighbors.
    if (paint.options.lines) for (const item of paint.edges) over(item);
    if (paint.options.markers) for (const item of paint.vertices) over(item);
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
  /** Let go of the records of banks a geometry no longer draws. */
  private prune(geometry: Geometry): void {
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
    this.destroyCurves();
  }
}
