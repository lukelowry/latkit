import type { Index, RowAxis } from '@latkit/model';
import type { GpuField, GpuValueField, GpuPage } from './types.js';
import type { Allocation, Allocator } from '../memory/allocation.js';
import { GpuError } from '../error.js';
import { rowCount } from '@latkit/model';

/** Private addresses consumed by the one shared page encoder. */
export interface Bitmap {
  readonly binding: GPUBufferBinding;
  readonly offset: number;
  readonly rowStride: number;
  readonly frameStride: number;
}
export interface Column extends Bitmap {
  readonly type: GpuValueField['type'];
  readonly items?: Column;
  readonly listBase?: number;
  readonly components: number;
  readonly origin?: Float64Array;
  readonly validity?: Bitmap;
  presence?: Bitmap;
}
/** Field kinds as the shader reads them; fieldShader declares one constant per kind. */
export const FIELD_KIND = { float32: 0, int32: 1, uint32: 2, boolean: 3, list: 4 } as const;
const HEADER_WORDS = 7;

export interface CopyJob {
  pending: boolean;
  readonly copies: readonly { source: GPUBufferBinding; target: GPUBufferBinding }[];
}

export class FieldPages {
  readonly layout: GPUBindGroupLayout;
  constructor(
    private readonly device: GPUDevice,
    private readonly allocator: Allocator,
  ) {
    const limits = device.limits as GPUSupportedLimits & {
      maxStorageBuffersInVertexStage?: number;
      maxStorageBuffersInFragmentStage?: number;
    };
    for (const limit of [
      limits.maxStorageBuffersPerShaderStage,
      limits.maxStorageBuffersInVertexStage,
      limits.maxStorageBuffersInFragmentStage,
    ])
      if (limit !== undefined && limit < 3)
        throw new GpuError(
          'unsupported',
          'Field rendering requires three storage bindings per shader stage',
        );
    this.layout = device.createBindGroupLayout({
      label: 'latkit fields',
      entries: [0, 1, 2].map((binding) => ({
        binding,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE,
        buffer: { type: 'read-only-storage' },
      })),
    });
  }

  build(
    input: {
      readonly index: Index;
      readonly rows: RowAxis;
      readonly rowOffset: number;
      readonly rowMap?: GPUBufferBinding;
      readonly columns: Readonly<Record<string, Column>>;
      readonly envelope?: { firstBucket: number; count: number };
      readonly samples?: { firstFrame: number; count: number; coordinates: Column };
    },
    allocate: (size: number, label: string, exclude?: ReadonlySet<GPUBuffer>) => Allocation,
    copies: CopyJob[],
  ): GpuPage {
    const columns = Object.values(input.columns);
    const fields = input.samples ? [...columns, input.samples.coordinates] : [...columns];
    for (const column of columns) if (column.items) fields.push(column.items);
    const regions: GPUBufferBinding[] = [];
    const add = (binding: GPUBufferBinding | undefined): void => {
      if (
        binding &&
        !regions.some(
          (item) =>
            item.buffer === binding.buffer &&
            item.offset === binding.offset &&
            item.size === binding.size,
        )
      )
        regions.push(binding);
    };
    add(input.rowMap);
    for (const field of fields) {
      add(field.binding);
      add(field.validity?.binding);
      add(field.presence?.binding);
    }
    const buffers = [...new Set(regions.map((region) => region.buffer))];
    if (!buffers.length) buffers.push(allocate(4, 'empty field page').binding.buffer);
    const relocated = new Map<GPUBufferBinding, GPUBufferBinding>();
    if (buffers.length > 2) {
      const total = regions.reduce((sum, region) => sum + region.size!, 0);
      if (total > this.device.limits.maxStorageBufferBindingSize)
        throw new GpuError('resource-limit', 'Prepared field page exceeds the binding limit');
      const packed = allocate(total, 'field page consolidation', new Set(buffers)).binding;
      let offset = packed.offset!;
      const work = regions.map((source) => {
        const target = { buffer: packed.buffer, offset, size: source.size };
        offset += source.size!;
        relocated.set(source, target);
        return { source, target };
      });
      copies.push({ pending: true, copies: work });
      buffers.splice(0, buffers.length, packed.buffer);
    }
    const location = (binding: GPUBufferBinding): { bank: number; word: number } => {
      const region = regions.find(
        (item) =>
          item.buffer === binding.buffer &&
          item.offset === binding.offset &&
          item.size === binding.size,
      )!;
      const target = relocated.get(region) ?? binding;
      return { bank: buffers.indexOf(target.buffer), word: (target.offset ?? 0) / 4 };
    };
    // Seven header words, sixteen words per field. Descriptors never consume numeric staging.
    const words = new Uint32Array(HEADER_WORDS + Math.max(1, fields.length) * 16);
    words.set([
      rowCount(input.rows),
      input.samples?.count ?? input.envelope?.count ?? 1,
      fields.length,
      input.rows.kind === 'indices' ? 1 : 0,
      input.rows.kind === 'range' ? input.rows.offset : 0,
    ]);
    if (input.rowMap) {
      const at = location(input.rowMap);
      words[5] = at.bank;
      words[6] = at.word;
    }
    const descriptor = (field: Column, slot: number): GpuField => {
      const at = location(field.binding),
        offset = HEADER_WORDS + slot * 16;
      words.set(
        [
          at.bank,
          at.word * (field.type === 'boolean' ? 32 : 1) + field.offset,
          field.rowStride,
          field.frameStride,
          field.items ? FIELD_KIND.list : FIELD_KIND[field.type],
          field.components,
        ],
        offset,
      );
      for (const [mask, start] of [
        [field.validity, offset + 6],
        [field.presence, offset + 10],
      ] as const) {
        if (!mask) words[start] = 0xffffffff;
        else {
          const bit = location(mask.binding);
          words.set(
            [bit.bank, bit.word * 32 + mask.offset, mask.rowStride, mask.frameStride],
            start,
          );
        }
      }
      if (field.items) {
        const child = fields.indexOf(field.items);
        words[offset + 14] = child;
        words[offset + 15] = field.listBase ?? 0;
        return { kind: 'list', slot, items: descriptor(field.items, child) as GpuValueField };
      }
      return {
        kind: 'value',
        slot,
        type: field.type,
        components: field.components,
        origin: field.origin,
      };
    };
    const described: Record<string, GpuField> = Object.create(null) as Record<string, GpuField>;
    Object.entries(input.columns).forEach(([name, field], slot) => {
      described[name] = descriptor(field, slot);
    });
    const samples = input.samples && {
      ...input.samples,
      coordinates: descriptor(input.samples.coordinates, columns.length) as GpuValueField,
    };
    const metadata = allocate(words.byteLength, 'field descriptors').binding;
    this.allocator.write(metadata, words);
    const bindGroup = this.device.createBindGroup({
      label: 'latkit field page',
      layout: this.layout,
      entries: [
        { binding: 0, resource: metadata },
        ...[0, 1].map((bank) => ({
          binding: bank + 1,
          resource: {
            buffer: buffers[bank] ?? buffers[0],
            offset: 0,
            size: (buffers[bank] ?? buffers[0]).size,
          },
        })),
      ],
    });
    return {
      index: input.index,
      rows: input.rows,
      rowOffset: input.rowOffset,
      columns: described,
      samples,
      envelope: input.envelope,
      bindGroup,
    };
  }
}
