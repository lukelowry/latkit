import { rowCount } from '@latkit/model';
import { kit, type Gpu, type RGBA } from '@latkit/gpu';
import type { DiagramData, EdgeOptions, VertexOptions } from './data.js';
import type { Scene } from './scene.js';

// Each slot's style is four words: its color and status, packed; its width and flow as two halves;
// and its shade. A zero color draws the view's base color for the item's kind, and a negative width
// its default. A scene writes every constant into the base words once; styles.wgsl writes the
// channels bound to fields on the GPU.

/** Line widths in CSS pixels that a `widthPx` field spans, and speeds a `flowPx` field spans. */
const WIDTH_RANGE = [1, 4] as const,
  FLOW_RANGE = [0, 40] as const;
/** Each options object's style channels, by the port names they bind. */
const styles = new WeakMap<object, Map<string, kit.BoundChannels<string>>>();
/** A type's style channels: its own, and each port's color and status as `color:name`. */
function typeStyle(
  options: VertexOptions | EdgeOptions,
  edge: boolean,
  ports: readonly string[] = [],
): kit.BoundChannels<string> {
  let byPorts = styles.get(options);
  if (!byPorts) styles.set(options, (byPorts = new Map<string, kit.BoundChannels<string>>()));
  const key = ports.join(','),
    found = byPorts.get(key);
  if (found) return found;
  const values: Record<string, unknown> = { color: options.color, shade: options.shade },
    kinds: Record<string, kit.ChannelKind> = { color: 'color', shade: 'raw' };
  if (edge) {
    const { widthPx, flowPx } = options as EdgeOptions;
    Object.assign(values, { widthPx, flowPx });
    Object.assign(kinds, { widthPx: WIDTH_RANGE, flowPx: FLOW_RANGE });
  } else {
    const vertex = options as VertexOptions;
    values.status = vertex.status;
    kinds.status = 'color';
    for (const name of ports) {
      values['color:' + name] = vertex.ports?.[name]?.color;
      values['status:' + name] = vertex.ports?.[name]?.status;
      kinds['color:' + name] = kinds['status:' + name] = 'color';
    }
  }
  const bound = kit.bindChannels(values, kinds);
  byPorts.set(key, bound);
  return bound;
}
/** Check a type's style channels, so a config with an invalid one is rejected when set. */
export function checkStyle(options: VertexOptions | EdgeOptions, edge: boolean): void {
  typeStyle(options, edge, edge ? [] : Object.keys((options as VertexOptions).ports ?? {}).sort());
}
/** Whether a type's wires flow: a flow field, or a nonzero speed. */
export function flowing(options: EdgeOptions): boolean {
  const flow = typeStyle(options, true).channels.flowPx;
  return flow.field !== undefined || (typeof flow.constant === 'number' && flow.constant !== 0);
}
/** The widest a type's wires draw, in CSS pixels. */
export function widestPx(options: EdgeOptions, fallback: number): number {
  const width = kit.resolveChannel(typeStyle(options, true).channels.widthPx, null, fallback);
  return width.scale ? Math.max(...width.scale.range) : width.fallback;
}

const float = new Float32Array(1),
  bits = new Uint32Array(float.buffer);
/** A number's float16 bits, as WGSL's pack2x16float writes them. */
function half(value: number): number {
  float[0] = value;
  const x = bits[0],
    sign = (x >>> 16) & 0x8000,
    exponent = ((x >>> 23) & 0xff) - 112,
    mantissa = x & 0x7fffff;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0)
    return exponent < -10
      ? sign
      : sign | ((((mantissa | 0x800000) >> (1 - exponent)) + 0x1000) >> 13);
  return (sign | (exponent << 10)) + ((mantissa + 0x1000) >> 13);
}
/** A constant color packed as unorm bytes; zero, the view's base color, without one. */
function packed(channel: kit.BoundChannel | undefined): number {
  const color = channel?.constant;
  if (!Array.isArray(color)) return 0;
  return (
    (Math.round(color[0] * 255) |
      (Math.round(color[1] * 255) << 8) |
      (Math.round(color[2] * 255) << 16) |
      (Math.round(color[3] * 255) << 24)) >>>
    0
  );
}
function constant(channel: kit.BoundChannel | undefined, fallback: number): number {
  return typeof channel?.constant === 'number' ? channel.constant : fallback;
}
/** The base words: every slot's constants, and the view's defaults where it has none. */
function baseWords(scene: Scene): kit.BufferData {
  const words = new Uint32Array(Math.max(4, scene.slots.count * 4)),
    floats = new Float32Array(words.buffer);
  const write = (slot: number, channels: Readonly<Record<string, kit.BoundChannel>>) => {
    words[slot * 4] = packed(channels.color);
    words[slot * 4 + 1] = packed(channels.status);
    // Width -1 and flow 0, as two halves, unless the type sets them.
    words[slot * 4 + 2] =
      half(constant(channels.widthPx, -1)) | (half(constant(channels.flowPx, 0)) << 16);
    floats[slot * 4 + 3] = constant(channels.shade, 0);
  };
  for (let slot = 0; slot < scene.slots.count; slot++) words[slot * 4 + 2] = 0x0000bc00;
  // Each type's rows run from its first to the next type's.
  const vertices = [...scene.types.vertices],
    edges = [...scene.types.edges];
  vertices.forEach(([type, at], t) => {
    const { channels } = typeStyle(scene.data.vertices[type], false, at.names),
      end = vertices[t + 1]?.[1].first ?? scene.vertices.length;
    for (let i = at.first; i < end; i++) {
      write(i, channels);
      const slot = scene.vertices[i].portSlot;
      at.names.forEach((name, k) =>
        write(slot + k, { color: channels['color:' + name], status: channels['status:' + name] }),
      );
    }
  });
  edges.forEach(([type, at], t) => {
    const { channels } = typeStyle(scene.data.edges![type], true),
      end = edges[t + 1]?.[1].first ?? scene.edges.length;
    for (let i = at.first; i < end; i++) write(scene.slots.edges + i, channels);
  });
  const buffer = new kit.BufferData({ size: words.byteLength, label: 'diagram styles' });
  buffer.write({ data: words });
  return buffer;
}

/** One pass over a type's rows: the channels it writes, and where. */
interface Pass {
  /** The color channel it writes, if any; into the status word when `status`. */
  readonly color?: string;
  readonly status: boolean;
  /** Whether it writes the widths and flows, and the shades. */
  readonly lines: boolean;
  readonly shade: boolean;
  readonly first: number;
  readonly stride: number;
}
/** Every pass a type's fields need, over the slots its rows hold. */
function passes(
  bound: kit.BoundChannels<string>,
  first: number,
  ports?: { readonly first: number; readonly names: readonly string[] },
): Pass[] {
  const field = (name: string) => bound.channels[name]?.field !== undefined,
    out: Pass[] = [];
  const own: Pass = {
    ...(field('color') ? { color: 'color' } : {}),
    status: false,
    lines: field('widthPx') || field('flowPx'),
    shade: field('shade'),
    first,
    stride: 1,
  };
  if (own.color || own.lines || own.shade) out.push(own);
  const only = (color: string, status: boolean, first: number, stride: number): Pass => ({
    color,
    status,
    lines: false,
    shade: false,
    first,
    stride,
  });
  if (field('status')) out.push(only('status', true, first, 1));
  ports?.names.forEach((name, k) => {
    const at = ports.first + k,
      stride = ports.names.length;
    if (field('color:' + name)) out.push(only('color:' + name, false, at, stride));
    if (field('status:' + name)) out.push(only('status:' + name, true, at, stride));
  });
  return out;
}
interface Dispatch {
  readonly fields: GPUBindGroup;
  readonly colors: GPUBindGroup;
  readonly group: GPUBindGroup;
  readonly count: number;
}
/** The words a frame's shapes read, and how its encoder fills them. */
export interface StyleFrame {
  readonly styles: GPUBufferBinding;
  /** Base words to copy in first, when they changed since the buffer last held them. */
  readonly seed: { readonly from: GPUBufferBinding; readonly words: kit.BufferData } | null;
  readonly dispatches: readonly Dispatch[];
}
/** Words of each pass's parameters: where it writes, the missing color, and four channels. */
const PARAMETERS = 8 + 4 * 8;
const UNSET: kit.ResolvedChannel = { component: 0, fallback: 0 };
/** A pass's color for rows without one: zero draws the view's. */
const CLEAR: RGBA = [0, 0, 0, 0];

/**
 * The style words of one scene under one set of bindings, and the passes that write them. The
 * passes write a buffer of the view's own, since uploads share buffers with the field pages they
 * read; it is seeded from the uploaded base words whenever those change. Words and passes are
 * kept until the scene, the bindings, or a sampled field's coordinate change, and a frame whose
 * passes already ran runs none.
 */
export class Styles {
  private target?: { readonly buffer: kit.BufferResource; holds?: kit.BufferData };
  /** Each pass's parameters, rewritten only when the passes are built again. */
  private readonly parameters: kit.BufferData[] = [];
  /** The passes the words last ran, so an unchanged frame runs none. */
  private encoded?: readonly Dispatch[];
  constructor(private readonly gpu: Gpu) {}
  /** This frame's words, and its passes: each bound type's pages of fields at the frame's coordinate. */
  async prepare(
    frame: kit.Preparation,
    scene: Scene,
    data: DiagramData,
    layout: GPUBindGroupLayout,
  ): Promise<StyleFrame> {
    const words = await frame.memo('style words', [scene, data.vertices, data.edges], () =>
      baseWords(scene),
    );
    if (this.target?.buffer.buffer.size !== words.size) {
      this.target?.buffer.destroy();
      this.target = {
        buffer: this.gpu.buffer({
          size: words.size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          label: 'diagram styles',
        }),
      };
    }
    const target = this.target,
      styles = frame.buffer(target.buffer),
      seed = target.holds === words ? null : { from: frame.buffer(words), words },
      dispatches = await frame.memo(
        'style passes',
        [scene, data.source, data.vertices, data.edges, target.buffer, layout],
        (f) => this.dispatches(f, scene, data, styles, layout),
      );
    return { styles, seed, dispatches };
  }
  private async dispatches(
    frame: kit.Preparation,
    scene: Scene,
    data: DiagramData,
    styles: GPUBufferBinding,
    layout: GPUBindGroupLayout,
  ): Promise<readonly Dispatch[]> {
    const out: Dispatch[] = [];
    const types = [
      ...[...scene.types.vertices].map(([type, at]) => ({
        type,
        options: data.vertices[type] as VertexOptions | EdgeOptions,
        bound: typeStyle(data.vertices[type], false, at.names),
        first: at.first,
        ports: { first: at.ports, names: at.names },
      })),
      ...[...scene.types.edges].map(([type, at]) => ({
        type,
        options: data.edges![type] as VertexOptions | EdgeOptions,
        bound: typeStyle(data.edges![type], true),
        first: scene.slots.edges + at.first,
        ports: undefined,
      })),
    ];
    for (const { type, options, bound, first, ports } of types) {
      const list = passes(bound, first, ports);
      if (!list.length) continue;
      const reads = await kit.resolveChannels(
        frame.reader,
        { source: data.source, from: type, rows: options.rows },
        bound,
        { widthPx: -1 },
      );
      for await (const tile of frame.reader.fields({
        source: data.source,
        from: type,
        rows: options.rows,
        fields: bound.fields,
      }))
        for (const page of frame.upload(tile, {
          select: Object.keys(bound.fields),
          float64: 'relative',
        }))
          for (const pass of list) {
            const words = new Uint32Array(PARAMETERS),
              floats = new Float32Array(words.buffer);
            words.set(
              [
                rowCount(page.rows),
                pass.first + page.rowOffset * pass.stride,
                pass.stride,
                pass.status ? 1 : 0,
              ],
              0,
            );
            const color = pass.color === undefined ? undefined : bound.channels[pass.color];
            floats.set(Array.isArray(color?.missing) ? color.missing : CLEAR, 4);
            kit.writeChannel(words, 8, pass.color ? reads[pass.color] : UNSET, page);
            kit.writeChannel(words, 16, pass.lines ? reads.widthPx : UNSET, page);
            kit.writeChannel(words, 24, pass.lines ? reads.flowPx : UNSET, page);
            kit.writeChannel(words, 32, pass.shade ? reads.shade : UNSET, page);
            const parameters = (this.parameters[out.length] ??= new kit.BufferData({
              size: PARAMETERS * 4,
              usage: GPUBufferUsage.UNIFORM,
              label: 'diagram style pass',
            }));
            parameters.write({ data: words });
            out.push({
              fields: page.bindGroup,
              colors: frame.colormap(color?.colormap),
              group: this.gpu.device.createBindGroup({
                layout,
                entries: [
                  { binding: 0, resource: frame.buffer(parameters) },
                  { binding: 1, resource: styles },
                ],
              }),
              count: rowCount(page.rows),
            });
          }
    }
    return out;
  }
  /** Seed the words if they changed, then run the passes, before any shape reads them. */
  encode(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, frame: StyleFrame): void {
    if (frame.seed) {
      const { from, words } = frame.seed;
      encoder.copyBufferToBuffer(
        from.buffer,
        from.offset ?? 0,
        frame.styles.buffer,
        frame.styles.offset ?? 0,
        words.size,
      );
      if (this.target) this.target.holds = words;
    }
    if (!frame.dispatches.length || (!frame.seed && frame.dispatches === this.encoded)) return;
    this.encoded = frame.dispatches;
    const pass = encoder.beginComputePass({ label: 'diagram styles' });
    pass.setPipeline(pipeline);
    for (const dispatch of frame.dispatches) {
      pass.setBindGroup(0, dispatch.fields);
      pass.setBindGroup(1, dispatch.group);
      pass.setBindGroup(2, dispatch.colors);
      pass.dispatchWorkgroups(Math.ceil(dispatch.count / 64));
    }
    pass.end();
  }
  destroy(): void {
    this.target?.buffer.destroy();
    this.target = undefined;
    this.encoded = undefined;
  }
}
