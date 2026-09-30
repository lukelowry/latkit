import type { Column, NumericArray, RowsBlock, SampleColumn, SamplesBlock } from '@latkit/model';
import { rowCount, sliceRows, type FieldValues } from './binding.js';
import type { GpuPage, UploadOptions } from './columns.js';
import {
  FieldPages,
  type Bitmap,
  type Column as EncodedColumn,
  type CopyJob,
} from './field-pages.js';
import { Allocator, type Allocation } from './allocation.js';
import { BufferData } from './buffers.js';
import { align, GpuError, integer } from './error.js';
import type { Entry, Memory } from './memory.js';

export interface UploadScope {
  use(entry: Entry): void;
  check(check: () => void): void;
  copy(job: CopyJob): void;
}
interface NumericView {
  values: NumericArray | Uint8Array;
  boolean?: true;
  offset: number;
  components: number;
  rowStride: number;
  frameStride: number;
  validity?: { values: Uint8Array; offset: number; rowStride: number; frameStride: number };
  presence?: Uint8Array;
}
interface Resident {
  entry: Entry;
  pages: readonly GpuPage[];
  copies: CopyJob[];
}
interface MutableResident {
  entry: Entry;
  allocation: Allocation;
  version: number;
  size: number;
}

export class Uploader {
  private columns = new WeakMap<object, Map<string, Resident>>();
  private mutable = new WeakMap<BufferData, MutableResident[]>();
  readonly pageBytes: number;
  readonly fieldPages: FieldPages;
  private numericCache = new WeakMap<
    ArrayBufferLike,
    Map<string, { entry: Entry; column: EncodedColumn }>
  >();
  private identities = new WeakMap<object, number>();
  private serial = 0;

  constructor(
    private readonly allocator: Allocator,
    private readonly memory: Memory,
    pageBytes: number,
  ) {
    this.fieldPages = new FieldPages(allocator.device, allocator);
    this.pageBytes =
      Math.floor(
        Math.min(
          integer(pageBytes, 'page bytes', 4),
          allocator.device.limits.maxStorageBufferBindingSize,
          allocator.device.limits.maxBufferSize,
          memory.budget.stagingBytes,
        ) / 4,
      ) * 4;
    if (this.pageBytes < 4)
      throw new GpuError('resource-limit', 'Device cannot hold a numeric page');
  }

  validate(column: Column, rows: number): void {
    if (rows) this.view(column, rows, 1, false);
  }

  upload(
    block: RowsBlock | SamplesBlock,
    options: UploadOptions,
    scope: UploadScope,
  ): readonly GpuPage[] {
    return this.prepare(block, options, scope, block);
  }

  values(
    values: FieldValues,
    options: Pick<UploadOptions, 'float64' | 'maxPageBytes'>,
    scope: UploadScope,
  ): readonly GpuPage[] {
    return this.prepare(
      { index: values.index, rows: values.rows, columns: { value: values.values } },
      { ...options, select: ['value'] },
      scope,
      values,
    );
  }

  fields(
    block: {
      readonly index: FieldValues['index'];
      readonly rows: FieldValues['rows'];
      readonly columns: Readonly<Record<string, Column>>;
      readonly presence?: Readonly<Record<string, Uint8Array>>;
    },
    options: UploadOptions,
    scope: UploadScope,
  ): readonly GpuPage[] {
    return this.prepare(block, options, scope, block);
  }

  private prepare(
    block: Pick<RowsBlock, 'index' | 'rows' | 'columns'> &
      Partial<Pick<RowsBlock, 'version'>> & {
        readonly kind?: string;
        readonly presence?: Readonly<Record<string, Uint8Array>>;
      },
    options: UploadOptions,
    scope: UploadScope,
    identity: object,
  ): readonly GpuPage[] {
    if (!options.select.length || new Set(options.select).size !== options.select.length)
      throw new GpuError('invalid-input', 'Upload fields must be nonempty and unique');
    const sampled = block.kind === 'samples' ? (block as SamplesBlock) : undefined;
    if (sampled) {
      integer(sampled.firstFrame, 'first frame');
      integer(sampled.rowOffset, 'sample row offset');
      if (!(sampled.coordinates instanceof Float64Array))
        throw new GpuError('invalid-input', 'Coordinates must be Float64Array');
    }
    const count = rowCount(block.rows),
      frames = sampled?.coordinates.length ?? 1;
    if (!count || !frames) return [];
    const limit = Math.min(
      this.pageBytes,
      integer(options.maxPageBytes ?? this.pageBytes, 'page bytes', 4),
    );
    const key = JSON.stringify([options.select, options.float64, limit]);
    let cache = this.columns.get(identity);
    const cached = cache?.get(key);
    if (cached?.entry.live) {
      scope.use(cached.entry);
      for (const copy of cached.copies) scope.copy(copy);
      this.memory.uploadHits++;
      return cached.pages;
    }
    const views: [string, NumericView][] = options.select.map((name) => {
      const column = block.columns[name];
      if (!column) throw new GpuError('invalid-input', 'Missing upload field: ' + name);
      const view = this.view(column, count, frames, sampled !== undefined);
      view.presence = block.presence?.[name];
      if (view.presence && view.presence.length * 8 < count)
        throw new GpuError('invalid-input', 'Presence bitmap does not cover rows');
      if (view.values instanceof Float64Array && !options.float64)
        throw new GpuError(
          'precision',
          'Float64 field ' + name + ' requires an explicit encoding policy',
        );
      return [name, view];
    });
    let widest = 1,
      cellBytes = block.rows.kind === 'indices' ? 4 : 0;
    for (const [, view] of views) {
      widest = Math.max(widest, view.components);
      cellBytes += (view.boolean ? 1 / 8 : view.components * 8) + (view.validity ? 1 / 8 : 0);
    }
    if (cellBytes > limit) throw new GpuError('resource-limit', 'A vector exceeds the page bound');
    const tileRows = Math.min(
      count,
      Math.floor(limit / cellBytes),
      views.some(([, view]) => view.boolean) ? limit * 8 - 31 : Infinity,
    );
    const tileFrames = Math.min(frames, Math.floor(limit / (tileRows * cellBytes)));
    const pageCount = Math.ceil(count / tileRows) * Math.ceil(frames / tileFrames);
    const dependencies = new Set<Entry>();
    const copies: CopyJob[] = [];
    const allocations: Allocation[] = [];
    cache ??= new Map();
    this.columns.set(identity, cache);
    const ownCache = cache;
    const entry = this.memory.add(
      block.rows.kind === 'indices' ? [block.rows.values.buffer] : [],
      256 + pageCount * (192 + views.length * 160 + widest * 8),
      () => {
        ownCache.delete(key);
        for (const allocation of allocations) allocation.release();
        for (const dependency of dependencies) dependency.unpin();
      },
      'gpu',
    );
    const pages: GpuPage[] = [];
    const allocate = (
      size: number,
      label: string,
      exclude?: ReadonlySet<GPUBuffer>,
    ): Allocation => {
      const allocation = this.allocator.allocate(size, GPUBufferUsage.STORAGE, label, exclude);
      allocations.push(allocation);
      return allocation;
    };
    const column = (
      view: NumericView,
      row: number,
      nr: number,
      frame: number,
      nf: number,
      policy: UploadOptions['float64'],
    ): EncodedColumn => {
      const resident = this.resident(view, row, nr, frame, nf, limit, policy);
      if (!dependencies.has(resident.entry)) {
        resident.entry.pin();
        dependencies.add(resident.entry);
      }
      return resident.column;
    };
    try {
      const rowTiles = new Map<number, { rows: GpuPage['rows']; rowMap?: GPUBufferBinding }>();
      for (let frame = 0; frame < frames; frame += tileFrames) {
        const nf = Math.min(tileFrames, frames - frame);
        let samples: { firstFrame: number; count: number; coordinates: EncodedColumn } | undefined;
        if (sampled) {
          const axis = sampled.coordinates;
          for (let i = frame; i < frame + nf; i++) {
            if (!Number.isFinite(axis[i]) || (i > 0 && axis[i] < axis[i - 1]))
              throw new GpuError(
                'invalid-input',
                'Sample coordinates must be finite and nondecreasing',
              );
          }
          samples = {
            firstFrame: sampled.firstFrame + frame,
            count: nf,
            coordinates: column(
              { values: axis, offset: 0, components: 1, rowStride: 0, frameStride: 1 },
              0,
              1,
              frame,
              nf,
              'relative',
            ),
          };
        }
        for (let row = 0; row < count; row += tileRows) {
          const nr = Math.min(tileRows, count - row);
          let rowTile = rowTiles.get(row);
          if (!rowTile) {
            const rows = sliceRows(block.rows, row, nr);
            let rowMap: GPUBufferBinding | undefined;
            if (rows.kind === 'indices') {
              rowMap = allocate(rows.values.byteLength, 'physical rows').binding;
              this.allocator.write(rowMap, rows.values);
            }
            rowTile = { rows, rowMap };
            rowTiles.set(row, rowTile);
          }
          const { rows, rowMap } = rowTile;
          const columns: Record<string, EncodedColumn> = Object.create(null) as Record<
            string,
            EncodedColumn
          >;
          for (const [name, view] of views)
            columns[name] = column(view, row, nr, frame, nf, options.float64);
          pages.push(
            this.fieldPages.build(
              {
                version: block.version,
                index: block.index,
                rows,
                rowOffset: row,
                rowMap,
                columns,
                samples,
              },
              allocate,
              copies,
            ),
          );
        }
      }
      ownCache.set(key, { entry, pages, copies });
      for (const copy of copies) scope.copy(copy);
      scope.use(entry);
      entry.unpin();
      return pages;
    } catch (error) {
      this.memory.remove(entry);
      for (const dependency of dependencies) if (!dependency.pins) this.memory.remove(dependency);
      throw error;
    }
  }

  private id(value: object | undefined): number {
    if (!value) return 0;
    let id = this.identities.get(value);
    if (id === undefined) {
      id = ++this.serial;
      this.identities.set(value, id);
    }
    return id;
  }

  private resident(
    view: NumericView,
    row: number,
    rows: number,
    frame: number,
    frames: number,
    limit: number,
    policy: UploadOptions['float64'],
  ): { entry: Entry; column: EncodedColumn } {
    const mask = view.validity;
    const key = JSON.stringify([
      view.values.constructor.name,
      view.values.byteOffset,
      view.values.length,
      view.boolean,
      view.offset,
      view.components,
      view.rowStride,
      view.frameStride,
      row,
      rows,
      frame,
      frames,
      limit,
      policy,
      this.id(mask?.values.buffer),
      mask?.values.byteOffset,
      mask?.offset,
      mask?.rowStride,
      mask?.frameStride,
      this.id(view.presence?.buffer),
      view.presence?.byteOffset,
    ]);
    let cache = this.numericCache.get(view.values.buffer);
    if (!cache) {
      cache = new Map();
      this.numericCache.set(view.values.buffer, cache);
    }
    const cached = cache.get(key);
    if (cached?.entry.live) {
      cached.entry.touched = ++this.memory.clock;
      this.memory.uploadHits++;
      return cached;
    }
    const allocations: Allocation[] = [];
    const own = cache;
    const entry = this.memory.add(
      [],
      192 + view.components * 8,
      () => {
        own.delete(key);
        for (const allocation of allocations) allocation.release();
      },
      'gpu',
    );
    try {
      const allocate = (size: number, label: string): Allocation => {
        const allocation = this.allocator.allocate(size, GPUBufferUsage.STORAGE, label);
        allocations.push(allocation);
        return allocation;
      };
      const column = this.numeric(view, row, rows, frame, frames, limit, policy, allocate);
      if (view.presence) column.presence = this.bitmap(view.presence, row, rows, allocate);
      const result = { entry, column };
      own.set(key, result);
      entry.unpin();
      return result;
    } catch (error) {
      this.memory.remove(entry);
      throw error;
    }
  }

  private view(column: Column, rows: number, frames: number, sampled: boolean): NumericView {
    if (column.kind === 'boolean') {
      if (sampled) throw new GpuError('invalid-input', 'Sampled fields must be numeric');
      const offset = integer(column.offset, 'boolean offset');
      if (
        !(column.values instanceof Uint8Array) ||
        rows > column.length ||
        offset + rows > column.values.length * 8 ||
        (column.validity && offset + rows > column.validity.length * 8)
      )
        throw new GpuError('invalid-input', 'Boolean bitmap does not cover its rows');
      return {
        values: column.values,
        boolean: true,
        offset,
        components: 1,
        rowStride: 1,
        frameStride: 0,
        validity: column.validity
          ? { values: column.validity, offset, rowStride: 1, frameStride: 0 }
          : undefined,
      };
    }
    if (column.kind !== 'numeric' && column.kind !== 'vector')
      throw new GpuError('unsupported', 'Numeric uploads accept numeric and vector columns');
    const vector = column.kind === 'vector';
    if (sampled && vector)
      throw new GpuError('invalid-input', 'Sampled fields must be scalar numeric columns');
    if (vector && column.values.validity)
      throw new GpuError('invalid-input', 'Vector lanes are non-nullable');
    const scalar = vector ? column.values : column;
    const values = scalar.values;
    if (!(
      values instanceof Float32Array ||
      values instanceof Float64Array ||
      values instanceof Int32Array ||
      values instanceof Uint32Array
    ))
      throw new GpuError('invalid-input', 'Unsupported numeric backing');
    const components = vector ? integer(column.size, 'vector size', 1) : 1;
    const parentOffset = integer(column.offset, 'column offset');
    integer(column.length, 'column length');
    const rowStride = sampled
      ? integer((column as SampleColumn).rowStride, 'row stride', 1)
      : components;
    const frameStride = sampled
      ? integer((column as SampleColumn).frameStride, 'frame stride', 1)
      : 0;
    if (sampled) {
      let a = rowStride,
        b = frameStride;
      while (b) {
        const remainder = a % b;
        a = b;
        b = remainder;
      }
      if (frames > rowStride / a && rows > frameStride / a)
        throw new GpuError('invalid-input', 'Sample strides alias distinct cells');
    }
    const offset = vector
      ? integer(scalar.offset, 'child offset') + parentOffset * components
      : parentOffset;
    const span = (rows - 1) * rowStride + (frames - 1) * frameStride + components;
    if (
      !Number.isSafeInteger(span) ||
      offset + span > values.length ||
      (vector
        ? rows > column.length || parentOffset * components + span > scalar.length
        : span > column.length)
    )
      throw new GpuError('invalid-input', 'Column does not cover its logical axes');
    let validity: NumericView['validity'];
    if (column.validity) {
      const rs = vector ? 1 : rowStride,
        fs = vector ? 0 : frameStride;
      const last = parentOffset + (rows - 1) * rs + (frames - 1) * fs;
      if (!(column.validity instanceof Uint8Array) || last >= column.validity.length * 8)
        throw new GpuError('invalid-input', 'Validity bitmap does not cover the column');
      validity = { values: column.validity, offset: parentOffset, rowStride: rs, frameStride: fs };
    }
    return { values, offset, components, rowStride, frameStride, validity };
  }

  private numeric(
    view: NumericView,
    row: number,
    rows: number,
    frame: number,
    frames: number,
    limit: number,
    policy: UploadOptions['float64'],
    allocate: (size: number, label: string) => Allocation,
  ): EncodedColumn {
    if (view.boolean) {
      const data = this.bitmap(view.values as Uint8Array, view.offset + row, rows, allocate);
      const validity = view.validity
        ? this.bitmap(view.validity.values, view.validity.offset + row, rows, allocate)
        : undefined;
      return { ...data, type: 'boolean', components: 1, validity };
    }
    const base = view.offset + row * view.rowStride + frame * view.frameStride;
    const span = (rows - 1) * view.rowStride + (frames - 1) * view.frameStride + view.components;
    const packedSize = rows * frames * view.components * 4;
    const is64 = view.values instanceof Float64Array;
    const direct = !is64 && span * 4 <= limit && span * 4 <= packedSize * 2;
    const type =
      view.values instanceof Int32Array
        ? 'int32'
        : view.values instanceof Uint32Array
          ? 'uint32'
          : 'float32';
    const binding = allocate(direct ? span * 4 : packedSize, 'numeric column').binding;
    let origin: Float64Array | undefined;
    const valid = (r: number, f: number): boolean => {
      if (view.presence && !(view.presence[(row + r) >>> 3] & (1 << ((row + r) & 7)))) return false;
      if (!view.validity) return true;
      const mask = view.validity;
      const bit = mask.offset + (row + r) * mask.rowStride + (frame + f) * mask.frameStride;
      return (mask.values[bit >>> 3] & (1 << (bit & 7))) !== 0;
    };
    if (direct) this.allocator.write(binding, view.values.subarray(base, base + span));
    else
      this.memory.stage(packedSize, () => {
        const values =
          type === 'int32'
            ? new Int32Array(rows * frames * view.components)
            : type === 'uint32'
              ? new Uint32Array(rows * frames * view.components)
              : new Float32Array(rows * frames * view.components);
        if (is64 && policy === 'relative') {
          origin = new Float64Array(view.components);
          for (let lane = 0; lane < view.components; lane++) {
            find: for (let f = 0; f < frames; f++)
              for (let r = 0; r < rows; r++) {
                const value = view.values[base + f * view.frameStride + r * view.rowStride + lane];
                if (valid(r, f) && Number.isFinite(value)) {
                  origin[lane] = value;
                  break find;
                }
              }
          }
        }
        let at = 0;
        for (let f = 0; f < frames; f++)
          for (let r = 0; r < rows; r++)
            for (let lane = 0; lane < view.components; lane++) {
              if (!valid(r, f)) {
                values[at++] = 0;
                continue;
              }
              const value = view.values[base + f * view.frameStride + r * view.rowStride + lane];
              const encoded = value - (origin?.[lane] ?? 0);
              if (is64 && Number.isFinite(value) && !Number.isFinite(Math.fround(encoded)))
                throw new GpuError(
                  'precision',
                  'Finite Float64 value exceeds the selected Float32 encoding',
                );
              values[at++] = encoded;
            }
        this.allocator.write(binding, values);
      });
    let validity: Bitmap | undefined;
    if (view.validity) {
      const size = align(Math.ceil((rows * frames) / 8), 4);
      const mask = allocate(size, 'column validity').binding;
      this.memory.stage(size, () => {
        const bits = new Uint8Array(size);
        for (let f = 0; f < frames; f++)
          for (let r = 0; r < rows; r++)
            if (valid(r, f)) {
              const bit = f * rows + r;
              bits[bit >>> 3] |= 1 << (bit & 7);
            }
        this.allocator.write(mask, bits);
      });
      validity = { binding: mask, offset: 0, rowStride: 1, frameStride: rows };
    }
    return {
      binding,
      type,
      offset: 0,
      components: view.components,
      rowStride: direct ? view.rowStride : view.components,
      frameStride: direct ? view.frameStride : rows * view.components,
      origin,
      validity,
    };
  }

  private bitmap(
    values: Uint8Array,
    offset: number,
    count: number,
    allocate: (size: number, label: string) => Allocation,
  ): Bitmap {
    const from = Math.floor(offset / 32) * 4;
    const end = align(Math.ceil((offset + count) / 8), 4);
    const binding = allocate(end - from, 'packed boolean').binding;
    if (end <= values.length) this.allocator.write(binding, values.subarray(from, end));
    else
      this.memory.stage(end - from, () => {
        const bytes = new Uint8Array(end - from);
        bytes.set(values.subarray(from, Math.min(end, values.length)));
        this.allocator.write(binding, bytes);
      });
    return { binding, offset: offset - from * 8, rowStride: 1, frameStride: 0 };
  }

  buffer(data: BufferData, scope: UploadScope): GPUBufferBinding {
    const version = data.version;
    const residents = this.mutable.get(data) ?? [];
    this.mutable.set(data, residents);
    let resident = residents.find(
      (item) => item.entry.live && item.version === version && item.size === data.size,
    );
    if (resident) this.memory.uploadHits++;
    else {
      resident = residents.find(
        (item) =>
          item.entry.live &&
          !item.entry.pins &&
          item.allocation.binding.size >= align(Math.max(4, data.size), 4),
      );
      if (resident) {
        resident.entry.pin();
        try {
          for (const range of data.changesSince(resident.version))
            this.writeBytes(resident.allocation.binding, data.bytes, range.offset, range.size);
          resident.version = version;
          resident.size = data.size;
        } catch (error) {
          this.memory.remove(resident.entry);
          throw error;
        }
      } else {
        const entry = this.memory.add(
          [],
          128,
          () => {
            const index = residents.findIndex((item) => item.entry === entry);
            if (index >= 0) {
              residents[index].allocation.release();
              residents.splice(index, 1);
            }
          },
          'gpu',
        );
        try {
          const allocation = this.allocator.allocate(data.size, data.usage, data.label);
          resident = { entry, allocation, version, size: data.size };
          residents.push(resident);
          this.writeBytes(allocation.binding, data.bytes, 0, data.size);
        } catch (error) {
          this.memory.remove(entry);
          throw error;
        }
      }
      scope.use(resident.entry);
      resident.entry.unpin();
      scope.check(() => {
        if (data.version !== version)
          throw new GpuError('conflict', 'Renderer buffer changed during preparation');
      });
      return { ...resident.allocation.binding, size: align(Math.max(4, data.size), 4) };
    }
    scope.use(resident.entry);
    scope.check(() => {
      if (data.version !== version)
        throw new GpuError('conflict', 'Renderer buffer changed during preparation');
    });
    return { ...resident.allocation.binding, size: align(Math.max(4, data.size), 4) };
  }

  uniforms(data: ArrayBufferView, scope: UploadScope): GPUBufferBinding {
    const allocations: Allocation[] = [];
    const entry = this.memory.add(
      [],
      64,
      () => {
        for (const allocation of allocations) allocation.release();
      },
      'gpu',
    );
    try {
      const allocation = this.allocator.allocate(
        data.byteLength,
        GPUBufferUsage.UNIFORM,
        'frame uniforms',
      );
      allocations.push(allocation);
      this.writeBytes(
        allocation.binding,
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        0,
        data.byteLength,
      );
      scope.use(entry);
      entry.unpin();
      entry.close();
      return allocation.binding;
    } catch (error) {
      this.memory.remove(entry);
      throw error;
    }
  }

  private writeBytes(
    binding: GPUBufferBinding,
    bytes: Uint8Array,
    offset: number,
    size: number,
  ): void {
    if (!size) return;
    const start = Math.floor(offset / 4) * 4,
      end = align(offset + size, 4);
    if (end <= bytes.length) this.allocator.write(binding, bytes.subarray(start, end), start);
    else
      this.memory.stage(end - start, () => {
        const padded = new Uint8Array(end - start);
        padded.set(bytes.subarray(start, Math.min(end, bytes.length)));
        this.allocator.write(binding, padded, start);
      });
  }
}
