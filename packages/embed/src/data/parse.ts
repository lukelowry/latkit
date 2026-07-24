import type { Topology } from '@latkit/network';

import type { NetworkData, NetworkField, NetworkLabels } from './types.js';
import { validateNetworkData } from './validate.js';

const PREFIX = '@latkit/embed';
const U32_MAX = 0xffff_ffff;

/**
 * Parse and validate JSON-compatible network data.
 *
 * Numeric slots accept number arrays or little-endian base64 objects. The
 * returned arrays are newly owned typed arrays suitable for the renderer.
 */
export function parseNetwork(input: unknown): NetworkData {
  const root = record(input, 'root');
  const topology = parseTopology(required(root, 'topology', 'root'));
  const labels = parseLabels(optional(root, 'labels'));
  const fields = parseFields(optional(root, 'fields'));
  const data: NetworkData = { topology, labels, fields };
  try {
    validateNetworkData(data);
    return data;
  } catch (cause) {
    throw new Error(`${PREFIX}: invalid network data: ${message(cause)}`, { cause });
  }
}

/** Parse serialized topology and supply straight-edge offsets when omitted. */
function parseTopology(input: unknown): Topology {
  const source = record(input, 'topology');
  const vertexCount = integer(required(source, 'vertexCount', 'topology'), 'topology.vertexCount');
  if (vertexCount < 0) fail('topology.vertexCount', 'must be non-negative');

  const vertexCoordsSlot = optional(source, 'vertexCoords');
  const vertexCoords =
    vertexCoordsSlot === undefined ? undefined : f32(vertexCoordsSlot, 'topology.vertexCoords');
  const edges = u32(required(source, 'edges', 'topology'), 'topology.edges');
  if (edges.length % 2 !== 0) fail('topology.edges', 'length must be even');
  const edgeCount = edges.length / 2;

  const polylinePointsSlot = optional(source, 'polylinePoints');
  const polylinePoints =
    polylinePointsSlot === undefined
      ? undefined
      : f32(polylinePointsSlot, 'topology.polylinePoints');
  const polylineStartSlot = optional(source, 'polylineStart');
  const polylineStart =
    polylineStartSlot === undefined
      ? new Uint32Array(edgeCount + 1)
      : u32(polylineStartSlot, 'topology.polylineStart');

  return {
    vertexCount,
    vertexCoords,
    edges,
    polylineStart,
    polylinePoints,
  };
}

/** Parse optional vertex and edge interaction labels. */
function parseLabels(input: unknown): NetworkLabels | undefined {
  if (input === undefined) return undefined;
  const source = record(input, 'labels');
  const vertex = stringArray(optional(source, 'vertex'), 'labels.vertex');
  const edge = stringArray(optional(source, 'edge'), 'labels.edge');
  return { vertex, edge };
}

/** Parse the optional static field catalog. */
function parseFields(input: unknown): readonly NetworkField[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) fail('fields', 'must be an array');

  return input.map((item, index) => {
    const path = `fields[${index}]`;
    const source = record(item, path);
    const id = string(required(source, 'id', path), `${path}.id`);
    const label = string(required(source, 'label', path), `${path}.label`);
    const unitSlot = optional(source, 'unit');
    const unit = unitSlot === undefined ? undefined : string(unitSlot, `${path}.unit`);
    const scope = string(required(source, 'scope', path), `${path}.scope`);
    if (scope !== 'vertex' && scope !== 'edge') {
      fail(`${path}.scope`, 'must be "vertex" or "edge"');
    }
    const values = f32(required(source, 'values', path), `${path}.values`);
    return { id, label, unit, scope, values };
  });
}

/** Decode an f32 numeric slot without relying on host endianness. */
function f32(input: unknown, path: string): Float32Array {
  if (Array.isArray(input)) {
    const values = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const value = finiteNumber(input[i], `${path}[${i}]`);
      const rounded = Math.fround(value);
      if (!Number.isFinite(rounded)) fail(`${path}[${i}]`, 'is outside the f32 range');
      values[i] = rounded;
    }
    return values;
  }

  const bytes = base64(input, path);
  const values = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < values.length; i++) {
    const value = view.getFloat32(i * 4, true);
    if (!Number.isFinite(value)) fail(path, `contains a non-finite f32 at index ${i}`);
    values[i] = value;
  }
  return values;
}

/** Decode a u32 numeric slot after validating JSON integers before coercion. */
function u32(input: unknown, path: string): Uint32Array {
  if (Array.isArray(input)) {
    const values = new Uint32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const value = integer(input[i], `${path}[${i}]`);
      if (value < 0 || value > U32_MAX) fail(`${path}[${i}]`, 'is outside the u32 range');
      values[i] = value;
    }
    return values;
  }

  const bytes = base64(input, path);
  const values = new Uint32Array(bytes.byteLength / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < values.length; i++) values[i] = view.getUint32(i * 4, true);
  return values;
}

/** Decode and validate one base64 object into owned bytes. */
function base64(input: unknown, path: string): Uint8Array<ArrayBuffer> {
  const source = record(input, path);
  const encoded = string(required(source, 'base64', path), `${path}.base64`);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (cause) {
    throw new Error(`${PREFIX}: ${path}.base64 is invalid`, { cause });
  }
  if (binary.length % 4 !== 0) fail(path, 'base64 byte length must be divisible by 4');

  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Parse an optional array of strings. */
function stringArray(input: unknown, path: string): readonly string[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) fail(path, 'must be an array');
  return input.map((value, index) => string(value, `${path}[${index}]`));
}

/** Require a finite number. */
function finiteNumber(input: unknown, path: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) fail(path, 'must be a finite number');
  return input;
}

/** Require an integer. */
function integer(input: unknown, path: string): number {
  const value = finiteNumber(input, path);
  if (!Number.isInteger(value)) fail(path, 'must be an integer');
  return value;
}

/** Require a string. */
function string(input: unknown, path: string): string {
  if (typeof input !== 'string') fail(path, 'must be a string');
  return input;
}

/** Require a non-null record. */
function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(path, 'must be an object');
  }
  return input as Record<string, unknown>;
}

/** Read an own property, returning undefined when absent. */
function optional(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

/** Read a required own property. */
function required(source: Record<string, unknown>, key: string, path: string): unknown {
  const value = optional(source, key);
  if (value === undefined) fail(`${path}.${key}`, 'is required');
  return value;
}

/** Return a stable message for a caught validation error. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Throw one consistently prefixed parse error. */
function fail(path: string, problem: string): never {
  throw new Error(`${PREFIX}: ${path} ${problem}`);
}
