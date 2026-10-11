import { rowCount, type Data } from '@latkit/model';
import { kit, type Gpu, type RGBA } from '@latkit/gpu';
import { rowsOf } from '../read.js';
import type { ChannelName } from '../options.js';

/** Bytes of a page's uniform slot: its header and five channels. */
const SLOT_WORDS = 64;
/** Bytes a values row's record holds: its color, then its width, shade, shown, and dashed. */
const RECORD_BYTES = 32;
/** A record unused for this many presented frames lets go of its buffer. */
const IDLE_FRAMES = 240;

/** How every row of a record draws when no channel reads a field, and rows without a record. */
export interface Constant {
  readonly color: RGBA;
  readonly width: number;
  readonly shade: number;
  readonly visible: boolean;
  readonly dash: boolean;
}
interface Dispatch {
  readonly fields: GPUBindGroup;
  readonly group: GPUBindGroup;
  readonly colors: GPUBindGroup;
  readonly count: number;
}
/** A record's look this frame: its constant, and its rows' records where channels read fields. */
export interface Styled {
  readonly constant: Constant;
  readonly records?: GPUBufferBinding;
  /** What this frame computes before drawing: nothing once the records hold the latest values. */
  readonly dispatches: readonly Dispatch[];
  /** Mark the records computed, once the frame that computes them is submitted. */
  commit(): void;
}
interface Read {
  readonly pages: readonly kit.GpuPage[];
  readonly channels: Readonly<Record<ChannelName, kit.ResolvedChannel>>;
}
interface Entry {
  buffer?: kit.BufferResource;
  computed?: Read;
  used: number;
}

const FALLBACK: Readonly<Record<ChannelName, number>> = {
  color: -1,
  widthPx: 1,
  visible: 1,
  shade: 0,
  dash: 0,
};

/**
 * Each record's per-row look, computed on the GPU from the fields its channels read, once per
 * change of its values, options, or the coordinate a sampled field reads at: never per frame.
 */
export class RecordStyles {
  private readonly bindings = new WeakMap<object, kit.BoundChannels<ChannelName>>();
  private readonly entries = new WeakMap<Data, WeakMap<object, Map<string, Entry>>>();
  /** Entries holding buffers, to let go of idle ones. */
  private readonly held = new Set<Entry>();
  private frames = 0;
  constructor(private readonly gpu: Gpu) {}

  /** A record's channels, bound once per options object. */
  bind(
    options: object,
    kinds: Readonly<Record<string, kit.ChannelKind>>,
  ): kit.BoundChannels<ChannelName> {
    let found = this.bindings.get(options);
    if (!found)
      this.bindings.set(
        options,
        (found = kit.bindChannels(
          options,
          kinds as Readonly<Record<ChannelName, kit.ChannelKind>>,
        )),
      );
    return found;
  }
  /** What a record's options draw without fields: their constants over the style's defaults. */
  constant(bound: kit.BoundChannels<ChannelName>, color: RGBA, width: number): Constant {
    const channels = bound.channels,
      number = (name: ChannelName, fallback: number) => {
        const value = channels[name]?.constant;
        return typeof value === 'number' ? value : fallback;
      },
      own = channels.color?.constant ?? channels.color?.missing;
    return {
      color: Array.isArray(own) ? (own as RGBA) : color,
      width: number('widthPx', width),
      shade: number('shade', 0),
      visible: number('visible', 1) > 0,
      dash: number('dash', 0) > 0,
    };
  }
  /** A record drawn by its constants alone, as it waits on the rows its values join. */
  waiting(
    options: object,
    kinds: Readonly<Record<string, kit.ChannelKind>>,
    color: RGBA,
    width: number,
  ): Styled {
    return {
      constant: this.constant(this.bind(options, kinds), color, width),
      dispatches: [],
      commit() {},
    };
  }
  async prepare(
    frame: kit.Preparation,
    request: {
      readonly values: Data;
      readonly type: string;
      readonly options: object;
      readonly kinds: Readonly<Record<string, kit.ChannelKind>>;
      readonly color: RGBA;
      readonly width: number;
      readonly layout: GPUBindGroupLayout;
    },
  ): Promise<Styled> {
    const { values, type, options } = request,
      bound = this.bind(options, request.kinds),
      constant = this.constant(bound, request.color, request.width),
      done = { constant, dispatches: [], commit() {} };
    if (!Object.keys(bound.fields).length) return done;
    const entry = this.entry(values, options, type);
    entry.used = this.frames;
    // The style's defaults fill rows without values, so they key the records too.
    const deps = [values, type, options, request.width, ...request.color];
    const read = await frame.memo<Read>(entry, deps, async (f) => {
      const select = Object.keys(bound.fields),
        pages: kit.GpuPage[] = [];
      for await (const tile of f.reader.fields({
        source: values,
        from: type,
        fields: bound.fields,
      }))
        for (const page of f.upload(tile, { select, float64: 'relative' })) pages.push(page);
      const channels = {} as Record<ChannelName, kit.ResolvedChannel>;
      for (const name of Object.keys(FALLBACK) as ChannelName[]) {
        const channel = bound.channels[name] ?? { component: 0 },
          scale =
            channel.scale && channel.field !== undefined
              ? await kit.fieldScale(f.reader, {
                  ...channel.scale,
                  source: values,
                  from: type,
                  field: channel.field,
                })
              : undefined;
        channels[name] = kit.resolveChannel(
          channel,
          scale,
          name === 'widthPx' ? request.width : FALLBACK[name],
        );
      }
      return { pages, channels };
    });
    const rows = rowsOf(values, type),
      size = Math.max(RECORD_BYTES, rows * RECORD_BYTES);
    if (entry.buffer?.buffer.size !== size) {
      entry.buffer?.destroy();
      entry.buffer = this.gpu.buffer({
        size,
        usage: GPUBufferUsage.STORAGE,
        label: 'geography records',
      });
      entry.computed = undefined;
      this.held.add(entry);
    }
    const records = frame.buffer(entry.buffer);
    if (entry.computed === read) return { ...done, records };
    const colors = frame.colormap(bound.channels.color?.colormap),
      dispatches: Dispatch[] = [];
    for (const page of read.pages) {
      const words = new Uint32Array(SLOT_WORDS),
        floats = new Float32Array(words.buffer),
        count = rowCount(page.rows);
      words[0] = count;
      words[1] = page.rowOffset;
      floats.set(constant.color, 4);
      kit.writeChannel(words, 8, read.channels.color, page);
      kit.writeChannel(words, 16, read.channels.widthPx, page);
      kit.writeChannel(words, 24, read.channels.visible, page);
      kit.writeChannel(words, 32, read.channels.shade, page);
      kit.writeChannel(words, 40, read.channels.dash, page);
      dispatches.push({
        fields: page.bindGroup,
        colors,
        count,
        group: this.gpu.device.createBindGroup({
          layout: request.layout,
          entries: [
            { binding: 0, resource: frame.uniforms(words) },
            { binding: 1, resource: records },
          ],
        }),
      });
    }
    return {
      constant,
      records,
      dispatches,
      commit: () => {
        entry.computed = read;
      },
    };
  }
  /** Encode a frame's dispatches, in one compute pass. */
  encode(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    styled: readonly Styled[],
  ): void {
    if (!styled.some((s) => s.dispatches.length)) return;
    const pass = encoder.beginComputePass({ label: 'geography records' });
    pass.setPipeline(pipeline);
    for (const { dispatches } of styled)
      for (const d of dispatches) {
        pass.setBindGroup(0, d.fields);
        pass.setBindGroup(1, d.group);
        pass.setBindGroup(2, d.colors);
        pass.dispatchWorkgroups(Math.ceil(d.count / 64));
      }
    pass.end();
  }
  /** A presented frame was submitted: let go of records idle long enough. */
  presented(): void {
    this.frames++;
    for (const entry of this.held)
      if (this.frames - entry.used > IDLE_FRAMES) {
        entry.buffer?.destroy();
        entry.buffer = undefined;
        entry.computed = undefined;
        this.held.delete(entry);
      }
  }
  destroy(): void {
    for (const entry of this.held) entry.buffer?.destroy();
    this.held.clear();
  }
  private entry(values: Data, options: object, type: string): Entry {
    let byOptions = this.entries.get(values);
    if (!byOptions) this.entries.set(values, (byOptions = new WeakMap()));
    let byType = byOptions.get(options);
    if (!byType) byOptions.set(options, (byType = new Map<string, Entry>()));
    let entry = byType.get(type);
    if (!entry) byType.set(type, (entry = { used: this.frames }));
    return entry;
  }
}
