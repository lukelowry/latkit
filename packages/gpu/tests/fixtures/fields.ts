import type { GpuField, GpuValueField, GpuPage } from '../../src/index.js';
import { bytes } from './device.js';

function bindings(page: GpuPage): GPUBufferBinding[] {
  const group = page.bindGroup as unknown as { descriptor: GPUBindGroupDescriptor };
  return [...group.descriptor.entries].map((entry) => entry.resource as GPUBufferBinding);
}
function words(page: GpuPage): Uint32Array {
  const data = bytes(bindings(page)[0]);
  return new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
}
/** Decode the public shader ABI independently of the uploader implementation. */
export function field(page: GpuPage, selected: string | GpuField = 'value') {
  const item = typeof selected === 'string' ? page.columns[selected] : selected;
  const table = words(page),
    f = table.subarray(8 + item.slot * 16, 24 + item.slot * 16),
    banks = bindings(page).slice(1);
  const mask = (start: number) => {
    if (f[start] === 0xffffffff) return undefined;
    const bit = f[start + 1],
      offset = bit % 32;
    const count = offset + (table[0] - 1) * f[start + 2] + (table[1] - 1) * f[start + 3] + 1;
    return {
      offset,
      binding: {
        buffer: banks[f[start]].buffer,
        offset: Math.floor(bit / 32) * 4,
        size: Math.ceil(count / 32) * 4,
      },
    };
  };
  const span =
    ((item === page.samples?.coordinates ? 1 : table[0]) - 1) * f[2] + (table[1] - 1) * f[3] + f[5];
  return {
    binding: {
      buffer: banks[f[0]].buffer,
      offset: (item as GpuValueField).type === 'boolean' ? Math.floor(f[1] / 32) * 4 : f[1] * 4,
      size:
        (item as GpuValueField).type === 'boolean'
          ? Math.ceil(((f[1] % 32) + span) / 32) * 4
          : span * 4,
    },
    offset: (item as GpuValueField).type === 'boolean' ? f[1] % 32 : 0,
    rowStride: f[2],
    frameStride: f[3],
    validity: mask(6),
    presence: mask(10),
  };
}
export function rowMap(page: GpuPage): GPUBufferBinding | undefined {
  const table = words(page);
  return table[3]
    ? { buffer: bindings(page)[1 + table[5]].buffer, offset: table[6] * 4, size: table[0] * 4 }
    : undefined;
}
export function values(page: GpuPage, name = 'value'): number[] {
  const descriptor = field(page, name),
    data = bytes(descriptor.binding),
    type = (page.columns[name] as GpuValueField).type;
  const view =
    type === 'uint32'
      ? new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4)
      : type === 'int32'
        ? new Int32Array(data.buffer, data.byteOffset, data.byteLength / 4)
        : new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const count = page.rows.kind === 'range' ? page.rows.count : page.rows.values.length;
  return Array.from({ length: count }, (_, row) => view[row * descriptor.rowStride]);
}
