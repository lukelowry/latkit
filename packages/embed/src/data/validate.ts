import { validateTopology, type Topology } from '@latkit/network';

import type { NetworkData } from './types.js';

/** Validate already-decoded network data supplied through the element property. */
export function validateNetworkData(input: unknown): asserts input is NetworkData {
  const data = record(input, 'data');
  const topology = record(data.topology, 'topology') as unknown as Topology;
  validateTopology(topology);

  const vertexCount = topology.vertexCount;
  const edgeCount = topology.edges.length / 2;
  const labels = optionalRecord(data.labels, 'labels');
  validateLabels(labels?.vertex, vertexCount, 'vertex');
  validateLabels(labels?.edge, edgeCount, 'edge');

  const fields = data.fields;
  if (fields === undefined) return;
  if (!Array.isArray(fields)) throw new Error('fields must be an array');

  const ids = new Set<string>();
  for (let index = 0; index < fields.length; index++) {
    const field = record(fields[index], `field ${index}`);
    const id = string(field.id, 'field id');
    if (id.trim().length === 0) throw new Error('field id must not be empty');
    if (ids.has(id)) throw new Error(`duplicate field id ${id}`);
    ids.add(id);

    string(field.label, `field ${id} label`);
    if (field.unit !== undefined) string(field.unit, `field ${id} unit`);
    const scope = field.scope;
    if (scope !== 'vertex' && scope !== 'edge') {
      throw new Error(`invalid field scope ${String(scope)}`);
    }
    if (!isFloat32Array(field.values)) {
      throw new Error(`field ${id} values must be Float32Array`);
    }
    const expected = scope === 'vertex' ? vertexCount : edgeCount;
    if (field.values.length !== expected) {
      throw new Error(`field ${id} values length ${field.values.length} != ${expected}`);
    }
    for (const value of field.values) {
      if (!Number.isFinite(value)) throw new Error(`field ${id} values must be finite`);
    }
  }
}

/** Validate an optional label array against its topology scope. */
function validateLabels(input: unknown, expected: number, scope: string): void {
  if (input === undefined) return;
  if (!Array.isArray(input)) throw new Error(`${scope} labels must be an array`);
  if (input.length !== expected) {
    throw new Error(`${scope} labels length ${input.length} != ${expected}`);
  }
  for (const label of input) {
    if (typeof label !== 'string') throw new Error(`${scope} labels must contain strings`);
  }
}

/** Return an optional record or reject a malformed present value. */
function optionalRecord(input: unknown, name: string): Record<string, unknown> | undefined {
  return input === undefined ? undefined : record(input, name);
}

/** Require a non-null record. */
function record(input: unknown, name: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${name} must be an object`);
  }
  return input as Record<string, unknown>;
}

/** Require a string and return its narrowed value. */
function string(input: unknown, name: string): string {
  if (typeof input !== 'string') throw new Error(`${name} must be a string`);
  return input;
}

/** Recognize decoded f32 arrays across realms. */
function isFloat32Array(value: unknown): value is Float32Array {
  return Object.prototype.toString.call(value) === '[object Float32Array]';
}
