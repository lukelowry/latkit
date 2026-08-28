import type { PreparedTopology, Topology } from '../topology/index.js';
import { writeSpherePosition } from '../topology/sphere.js';
import { prepareTopology } from '../topology/pack.js';
import type { DecodedSegments, EncodedSegments, EncodedSegmentsInfo } from './types.js';
import {
  HEADER_WORDS,
  MAGIC,
  SEGMENT_RECORD_WORDS,
  SEGMENT_SPHERE_ENDPOINT_WORDS,
  W,
} from './wire.js';

/**
 * Encode topology edges and polylines into the canonical segment buffer.
 *
 * @remarks
 * Each edge is split into spans from its source vertex through intermediate
 * polyline points to its target vertex. Segments remain edge-major so
 * `edgeStarts[edge]..edgeStarts[edge + 1]` is the instance range for one edge.
 */
export function encodeSegments(source: Topology | PreparedTopology): EncodedSegments {
  const input = 'fingerprint' in source ? source : prepareTopology(source);
  const { vertexCoords, polylinePoints, edgeCount, segmentCount } = input;

  const edgeStartsWords = edgeCount + 1;
  const recordWords = segmentCount * SEGMENT_RECORD_WORDS;
  const sphereEndpointWords = segmentCount * SEGMENT_SPHERE_ENDPOINT_WORDS;
  const recordsOffset = HEADER_WORDS + edgeStartsWords;
  const sphereEndpointsOffset = recordsOffset + recordWords;
  const totalWords = sphereEndpointsOffset + sphereEndpointWords;

  const storage = new Uint8Array(new ArrayBuffer(totalWords * 4)) as EncodedSegments;
  const words = new Uint32Array(storage.buffer);
  const floats = new Float32Array(storage.buffer);

  words[W.magic] = MAGIC;
  words[W.headerWords] = HEADER_WORDS;
  words[W.storageBytes] = storage.byteLength;
  words[W.flags] = 0;
  words[W.vertexCount] = input.vertexCount;
  words[W.edgeCount] = edgeCount;
  words[W.segmentCount] = segmentCount;
  words[W.fingerprint] = input.fingerprint;
  words[W.edgeStarts] = HEADER_WORDS;
  words[W.records] = recordsOffset;
  words[W.sphereEndpoints] = sphereEndpointsOffset;

  let segment = 0;
  const edgeStartsOffset = words[W.edgeStarts]!;
  for (let edge = 0; edge < edgeCount; edge++) {
    words[edgeStartsOffset + edge] = segment;

    const from = input.edges[edge * 2]!;
    const to = input.edges[edge * 2 + 1]!;

    const lo = input.polylineStart[edge]!;
    const hi = input.polylineStart[edge + 1]!;
    const pointCount = hi - lo;
    const edgeSegmentCount = pointCount + 1;

    for (let local = 0; local < edgeSegmentCount; local += 1, segment += 1) {
      const a = local === 0 ? coord(vertexCoords, from) : coord(polylinePoints, lo + local - 1);
      const b = local === pointCount ? coord(vertexCoords, to) : coord(polylinePoints, lo + local);

      const base = recordsOffset + segment * SEGMENT_RECORD_WORDS;
      words[base] = edge;
      words[base + 1] = from;
      words[base + 2] = to;
      words[base + 3] = packUnorm2x16(local / edgeSegmentCount, (local + 1) / edgeSegmentCount);
      floats[base + 4] = a[0];
      floats[base + 5] = a[1];
      floats[base + 6] = b[0];
      floats[base + 7] = b[1];

      const sphereBase = sphereEndpointsOffset + segment * SEGMENT_SPHERE_ENDPOINT_WORDS;
      writeSpherePosition(floats, sphereBase, a[0], a[1]);
      writeSpherePosition(floats, sphereBase + 3, b[0], b[1]);
    }
  }
  words[edgeStartsOffset + edgeCount] = segment;
  if (segment !== segmentCount) throw new Error('segment count mismatch');

  return storage;
}

/**
 * Validate encoded segment storage and return counts plus fingerprint.
 *
 * @throws Error when the header, section offsets, or record references are invalid.
 */
export function readEncodedSegmentsInfo(bytes: Uint8Array): EncodedSegmentsInfo {
  return validateEncodedSegments(bytes).info;
}

/**
 * Validate encoded segment storage once and return reusable typed views.
 *
 * @throws Error when the header, section offsets, or record references are invalid.
 */
export function decodeSegments(encoded: EncodedSegments): DecodedSegments {
  const { u32, info } = validateEncodedSegments(encoded);
  return {
    encoded,
    info,
    u32,
    f32: new Float32Array(encoded.buffer, encoded.byteOffset, encoded.byteLength / 4),
    edgeStarts: copyEdgeStarts(u32, info.edgeCount),
    recordsOffset: u32[W.records]!,
  };
}

/**
 * Return a copied edge-to-segment range table from encoded segment storage.
 *
 * @throws Error when the encoded storage fails segment validation.
 */
export function readEdgeSegmentStarts(bytes: Uint8Array): Uint32Array<ArrayBuffer> {
  const { u32, info } = validateEncodedSegments(bytes);
  return copyEdgeStarts(u32, info.edgeCount);
}

/** Validated segment words and their decoded header metadata. */
interface ValidatedSegments {
  readonly u32: Uint32Array<ArrayBuffer>;
  readonly info: EncodedSegmentsInfo;
}

/** Validate one encoded segment buffer and retain its aligned word view. */
function validateEncodedSegments(bytes: Uint8Array): ValidatedSegments {
  const u32 = encodedWords(bytes);
  validateSegmentsHeader(u32, bytes.byteLength);
  const info = {
    vertexCount: u32[W.vertexCount]!,
    edgeCount: u32[W.edgeCount]!,
    segmentCount: u32[W.segmentCount]!,
    fingerprint: u32[W.fingerprint]!,
  };
  validateSegmentsSections(u32, bytes.byteLength / 4, info);
  return { u32, info };
}

/** Copy the compact CPU edge-range table from validated segment words. */
function copyEdgeStarts(
  u32: Uint32Array<ArrayBuffer>,
  edgeCount: number,
): Uint32Array<ArrayBuffer> {
  const offset = u32[W.edgeStarts]!;
  const view = new Uint32Array(u32.buffer, u32.byteOffset + offset * 4, edgeCount + 1);
  const out = new Uint32Array(new ArrayBuffer((edgeCount + 1) * 4));
  out.set(view);
  return out;
}

/**
 * Validate fixed segment header words shared by all segment readers.
 *
 * @throws Error when magic, header size, byte length, or flags are invalid.
 */
function validateSegmentsHeader(words: Uint32Array, byteLength: number): void {
  if (words[W.magic] !== MAGIC) throw new Error('invalid segments header');
  if (words[W.headerWords] !== HEADER_WORDS) throw new Error('invalid segments header size');
  if (words[W.storageBytes] !== byteLength) throw new Error('segments byte length mismatch');
  if (words[W.flags] !== 0) throw new Error('invalid segments flags');
}

/**
 * Validate segment section offsets, edge ranges, and endpoint references.
 *
 * @throws Error when sections are non-contiguous or record contents are invalid.
 */
function validateSegmentsSections(
  words: Uint32Array,
  totalWords: number,
  counts: EncodedSegmentsInfo,
): void {
  if (!Number.isInteger(counts.vertexCount)) throw new Error('invalid segments vertex count');
  if (!Number.isInteger(counts.edgeCount)) throw new Error('invalid segments edge count');
  if (!Number.isInteger(counts.segmentCount)) throw new Error('invalid segments segment count');

  const edgeStarts = {
    offset: words[W.edgeStarts]!,
    length: counts.edgeCount + 1,
  };
  const records = {
    offset: words[W.records]!,
    length: counts.segmentCount * SEGMENT_RECORD_WORDS,
  };
  const sphereEndpoints = {
    offset: words[W.sphereEndpoints]!,
    length: counts.segmentCount * SEGMENT_SPHERE_ENDPOINT_WORDS,
  };

  if (edgeStarts.offset !== HEADER_WORDS)
    throw new Error('invalid segments section offset: edgeStarts');
  if (records.offset !== edgeStarts.offset + edgeStarts.length) {
    throw new Error('invalid segments section offset: records');
  }
  if (sphereEndpoints.offset !== records.offset + records.length) {
    throw new Error('invalid segments section offset: sphereEndpoints');
  }
  if (sphereEndpoints.offset + sphereEndpoints.length !== totalWords) {
    throw new Error('segments trailing bytes mismatch');
  }

  const starts = new Uint32Array(
    words.buffer,
    words.byteOffset + edgeStarts.offset * 4,
    edgeStarts.length,
  );
  let previous = starts[0]!;
  if (previous !== 0) throw new Error('segments edgeStarts must begin at zero');
  for (let i = 1; i < starts.length; i += 1) {
    const next = starts[i]!;
    if (next < previous) throw new Error('segments edgeStarts must be monotonic');
    previous = next;
  }
  if (previous !== counts.segmentCount) throw new Error('segments edgeStarts terminal mismatch');

  for (let edge = 0; edge < counts.edgeCount; edge += 1) {
    const start = starts[edge]!;
    const end = starts[edge + 1]!;
    for (let segment = start; segment < end; segment += 1) {
      const base = records.offset + segment * SEGMENT_RECORD_WORDS;
      if (words[base] !== edge) throw new Error('segments record edge mismatch');
      if (words[base + 1]! >= counts.vertexCount || words[base + 2]! >= counts.vertexCount) {
        throw new Error('segments endpoint out of range');
      }
    }
  }
}

/**
 * Return an aligned u32 view over encoded segment bytes.
 *
 * @throws Error when storage is too short, unaligned, or not ArrayBuffer-backed.
 */
function encodedWords(bytes: Uint8Array): Uint32Array<ArrayBuffer> {
  if (bytes.byteLength < HEADER_WORDS * 4) throw new Error('segments header is truncated');
  if (bytes.byteLength % 4 !== 0) throw new Error('segments byte length must be 4-byte aligned');
  if (!(bytes.buffer instanceof ArrayBuffer))
    throw new Error('segments storage must be ArrayBuffer-backed');
  if (bytes.byteOffset % 4 !== 0) throw new Error('segments storage must be 4-byte aligned');
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Read one coordinate pair by logical point index from an interleaved array. */
function coord(values: Float32Array, i: number): readonly [number, number] {
  return [values[i * 2]!, values[i * 2 + 1]!];
}

/** Pack two normalized values into low/high 16-bit unorm lanes. */
function packUnorm2x16(x: number, y: number): number {
  const lo = Math.round(clamp01(x) * 0xffff);
  const hi = Math.round(clamp01(y) * 0xffff);
  return (lo | (hi << 16)) >>> 0;
}

/** Clamp a value to the `[0, 1]` unorm domain. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
