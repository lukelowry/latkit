import { rowCount, type FieldInput } from '@latkit/model';
import { kit, type ColorScale, type Gpu, type RGBA, type Scale } from '@latkit/gpu';
import type { DiagramData, EdgeData, VertexData } from './data.js';
import type { Scene } from './scene.js';

/**
 * Each slot's style as four words: its color and status, packed; its width and flow as two halves;
 * and its shade value. A zero color draws the view's base color for the item's kind, and a
 * negative width its default; unbound items keep the base words, bound ones are written each
 * frame on the GPU from the fields they read.
 */
const NONE = 0xffffffff;
export const styleShader = /* wgsl */ `
struct Page {
  /** Color, width, flow, and shade field slots. */
  fields: vec4u,
  /** Rows, first slot, slot stride, and the color word: 0 the color, 1 the status. */
  place: vec4u,
  origin: vec4f,
  base: vec4f,
  color: LatkitScale,
  width: LatkitScale,
  flow: LatkitScale,
}
@group(1) @binding(0) var<uniform> page: Page;
@group(1) @binding(1) var<storage, read_write> styles: array<vec4u>;
@compute @workgroup_size(64) fn style_main(@builtin(global_invocation_id) id: vec3u) {
  let row = id.x;
  if (row >= page.place.x) { return; }
  let at = page.place.y + row * page.place.z;
  if (page.fields.x != 0xffffffffu) {
    let color = pack4x8unorm(fieldColor(page.fields.x, row, 0u, page.color, page.base));
    if (page.place.w == 0u) { styles[at].x = color; } else { styles[at].y = color; }
  }
  if (page.fields.y != 0xffffffffu || page.fields.z != 0xffffffffu) {
    styles[at].z = pack2x16float(vec2f(
      fieldScaled(page.fields.y, row, 0u, page.width, -1.0),
      fieldScaled(page.fields.z, row, 0u, page.flow, 0.0)));
  }
  if (page.fields.w != 0xffffffffu) {
    styles[at].w = bitcast<u32>(fieldNumber(page.fields.w, row, 0u, page.origin.x, 0.0));
  }
}
`;
/** One pass over a type's rows: which fields it reads, where it writes, and through what. */
interface Pass {
  readonly color?: ColorScale | null;
  readonly width?: Scale | null;
  readonly flow?: Scale | null;
  readonly shade?: FieldInput | null;
  /** Writes the status word rather than the color. */
  readonly status?: boolean;
  readonly base: RGBA;
  readonly first: number;
  readonly stride: number;
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
const CLEAR: RGBA = [0, 0, 0, 0];
/** Every pass a type's bindings need, over the slots its rows hold. */
function passes(
  options: VertexData | EdgeData,
  first: number,
  ports?: { readonly first: number; readonly names: readonly string[] },
): Pass[] {
  const base = options.baseColor ?? CLEAR,
    out: Pass[] = [];
  const own: Pass = {
    color: options.color,
    width: 'widthPx' in options ? options.widthPx : null,
    flow: 'flow' in options ? options.flow : null,
    shade: options.shade,
    base,
    first,
    stride: 1,
  };
  if (own.color || own.width || own.flow || own.shade) out.push(own);
  if ('status' in options && options.status)
    out.push({ color: options.status, status: true, base: CLEAR, first, stride: 1 });
  if (ports && 'ports' in options)
    ports.names.forEach((name, k) => {
      const port = options.ports?.[name],
        at = { first: ports.first + k, stride: ports.names.length };
      if (port?.color) out.push({ color: port.color, base: CLEAR, ...at });
      if (port?.status) out.push({ color: port.status, status: true, base: CLEAR, ...at });
    });
  return out;
}
/** The fields one type's passes read, each by a name the passes find again. */
function inputs(options: VertexData | EdgeData, names: readonly string[]) {
  const out: Record<string, FieldInput> = {};
  for (const [i, pass] of passes(options, 0, { first: 0, names }).entries()) {
    if (pass.color) out['c' + i] = pass.color.field;
    if (pass.width) out['w' + i] = pass.width.field;
    if (pass.flow) out['f' + i] = pass.flow.field;
    if (pass.shade) out['s' + i] = pass.shade;
  }
  return out;
}

/**
 * The base words: a type's own base color, or zero for the view's. A new scene or new bindings
 * write them again, so no word a pass no longer writes keeps an old value.
 */
function baseWords(scene: Scene): kit.BufferData {
  const words = new Uint32Array(Math.max(4, scene.slots.count * 4)),
    packed = (color: RGBA | undefined) =>
      color
        ? (Math.round(color[0] * 255) |
            (Math.round(color[1] * 255) << 8) |
            (Math.round(color[2] * 255) << 16) |
            (Math.round(color[3] * 255) << 24)) >>>
          0
        : 0,
    // Width -1 and flow 0 as two halves: 0xbc00 is -1.
    halves = 0x0000bc00;
  for (let slot = 0; slot < scene.slots.count; slot++) words[slot * 4 + 2] = halves;
  scene.vertices.forEach((vertex, i) => (words[i * 4] = packed(vertex.options.baseColor)));
  scene.edges.forEach(
    (edge, i) => (words[(scene.slots.edges + i) * 4] = packed(edge.options.baseColor)),
  );
  const buffer = new kit.BufferData({ size: words.byteLength, label: 'diagram styles' });
  buffer.write({ data: words });
  return buffer;
}
/** Bytes of each pass's parameters: what it reads, where it writes, and its scales. */
const PARAMETERS = 16 * 10;

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
        options: data.vertices[type] as VertexData | EdgeData,
        first: at.first,
        ports: { first: at.ports, names: at.names },
      })),
      ...[...scene.types.edges].map(([type, at]) => ({
        type,
        options: data.edges![type] as VertexData | EdgeData,
        first: scene.slots.edges + at.first,
        ports: undefined,
      })),
    ];
    for (const { type, options, first, ports } of types) {
      const list = passes(options, first, ports);
      if (!list.length) continue;
      const fields = inputs(options, ports?.names ?? []),
        scales = new Map<object, kit.ResolvedScale>();
      for (const pass of list)
        for (const [mapping, range] of [
          [pass.color, [0, 1]],
          [pass.width, [1, 4]],
          [pass.flow, [0, 40]],
        ] as const)
          if (mapping && !scales.has(mapping))
            scales.set(
              mapping,
              await kit.fieldScale(frame.reader, {
                ...mapping,
                source: data.source,
                from: type,
                rows: options.rows,
                range: ('range' in mapping ? mapping.range : undefined) ?? range,
              }),
            );
      for await (const tile of frame.reader.fields({
        source: data.source,
        from: type,
        rows: options.rows,
        fields,
      }))
        for (const page of frame.upload(tile, {
          select: Object.keys(fields),
          float64: 'relative',
        })) {
          const slot = (name: string) => {
            const field = page.columns[name];
            return field?.kind === 'value' ? field.slot : NONE;
          };
          list.forEach((pass, i) => {
            const values = new ArrayBuffer(PARAMETERS),
              f = new Float32Array(values),
              u = new Uint32Array(values),
              shade = page.columns['s' + i],
              scale = (
                mapping: Scale | ColorScale | null | undefined,
                name: string,
                at: number,
              ) => {
                const field = page.columns[name];
                if (mapping)
                  f.set(
                    kit.scaleParameters(scales.get(mapping)!, {
                      origin: field?.kind === 'value' ? field.origin?.[0] : undefined,
                    }),
                    at,
                  );
              };
            u.set([slot('c' + i), slot('w' + i), slot('f' + i), slot('s' + i)], 0);
            u.set(
              [
                rowCount(page.rows),
                pass.first + page.rowOffset * pass.stride,
                pass.stride,
                pass.status ? 1 : 0,
              ],
              4,
            );
            f[8] = shade?.kind === 'value' ? (shade.origin?.[0] ?? 0) : 0;
            f.set(pass.base, 12);
            scale(pass.color, 'c' + i, 16);
            scale(pass.width, 'w' + i, 24);
            scale(pass.flow, 'f' + i, 32);
            const parameters = (this.parameters[out.length] ??= new kit.BufferData({
              size: PARAMETERS,
              usage: GPUBufferUsage.UNIFORM,
              label: 'diagram style pass',
            }));
            parameters.write({ data: u });
            out.push({
              fields: page.bindGroup,
              colors: frame.colormap(pass.color?.colormap),
              group: this.gpu.device.createBindGroup({
                layout,
                entries: [
                  { binding: 0, resource: frame.buffer(parameters) },
                  { binding: 1, resource: styles },
                ],
              }),
              count: rowCount(page.rows),
            });
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
