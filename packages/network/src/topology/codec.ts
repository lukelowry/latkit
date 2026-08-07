import {
  computeBounds,
  estimateCharacteristicLength,
  prepareTopology,
  type PreparedTopology,
} from './pack.js';
import type { Bounds, EncodedTopology, EncodedTopologyInfo, Topology } from './types.js';
import { spherePositionsForCoords } from './sphere.js';
import { HEADER_WORDS, MAGIC, W } from './wire.js';

/** Encode a topology into the canonical GPU-facing topology buffer. */
export function encodeTopology(source: Topology | PreparedTopology): EncodedTopology {
  const input = 'fingerprint' in source ? source : prepareTopology(source);
  const { vertexCoords, polylinePoints, edgeCount } = input;
  const vertexSphere = spherePositionsForCoords(vertexCoords);
  const bounds = computeBounds(vertexCoords);

  return writeTopologyStorage({
    vertexCount: input.vertexCount,
    vertexCoords,
    vertexSphere,
    edges: input.edges,
    polylineStart: input.polylineStart,
    polylinePoints,
    bounds,
    characteristicLength: estimateCharacteristicLength(input.vertexCount, bounds),
    edgeCount,
    fingerprint: input.fingerprint,
  });
}

/**
 * Validate encoded topology storage and return header metadata.
 *
 * @throws Error when the header, section offsets, or storage alignment are invalid.
 */
export function readEncodedTopologyInfo(bytes: Uint8Array): EncodedTopologyInfo {
  const words = encodedWords(bytes);
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

  if (words[W.magic] !== MAGIC) throw new Error('invalid topology header');
  if (words[W.headerWords] !== HEADER_WORDS) throw new Error('invalid topology header size');
  if (words[W.storageBytes] !== bytes.byteLength) throw new Error('topology byte length mismatch');
  if (words[W.flags] !== 0) throw new Error('invalid topology flags');

  const info = {
    vertexCount: words[W.vCount]!,
    edgeCount: words[W.eCount]!,
    fingerprint: words[W.fingerprint]!,
    bounds: {
      xMin: floats[W.xMin]!,
      xMax: floats[W.xMax]!,
      yMin: floats[W.yMin]!,
      yMax: floats[W.yMax]!,
    },
    characteristicLength: floats[W.characteristicLength]!,
  };

  validateSections(words, bytes.byteLength / 4, info);
  return info;
}

/** Allocate and populate topology header words plus numeric sections. */
function writeTopologyStorage(input: {
  readonly vertexCount: number;
  readonly vertexCoords: Float32Array;
  readonly vertexSphere: Float32Array;
  readonly edges: Uint32Array;
  readonly polylineStart: Uint32Array;
  readonly polylinePoints: Float32Array;
  readonly bounds: Bounds;
  readonly characteristicLength: number;
  readonly edgeCount: number;
  readonly fingerprint: number;
}): EncodedTopology {
  const vertexCount = input.vertexCount;
  const edgeCount = input.edgeCount;

  const lengths = [input.vertexCoords.length, input.vertexSphere.length] as const;

  let cursor = HEADER_WORDS;
  const offsets = lengths.map((length) => {
    const offset = cursor;
    cursor += length;
    return offset;
  });

  const storage = new Uint8Array(new ArrayBuffer(cursor * 4)) as EncodedTopology;
  const words = new Uint32Array(storage.buffer);
  const floats = new Float32Array(storage.buffer);

  words[W.magic] = MAGIC;
  words[W.headerWords] = HEADER_WORDS;
  words[W.storageBytes] = storage.byteLength;
  words[W.flags] = 0;
  words[W.vCount] = vertexCount;
  words[W.eCount] = edgeCount;
  words[W.vCoords] = offsets[0]!;
  words[W.fingerprint] = input.fingerprint;
  words[W.vSphere] = offsets[1]!;
  floats[W.xMin] = input.bounds.xMin;
  floats[W.xMax] = input.bounds.xMax;
  floats[W.yMin] = input.bounds.yMin;
  floats[W.yMax] = input.bounds.yMax;
  floats[W.characteristicLength] = input.characteristicLength;

  new Float32Array(storage.buffer, offsets[0]! * 4, input.vertexCoords.length).set(
    input.vertexCoords,
  );
  new Float32Array(storage.buffer, offsets[1]! * 4, input.vertexSphere.length).set(
    input.vertexSphere,
  );

  return storage;
}

/**
 * Validate that topology sections are contiguous and stay within storage.
 *
 * @throws Error when section offsets or trailing bytes do not match the layout.
 */
function validateSections(
  words: Uint32Array,
  totalWords: number,
  counts: {
    readonly vertexCount: number;
    readonly edgeCount: number;
  },
): void {
  const sections = {
    vertexCoords: { offset: words[W.vCoords]!, length: counts.vertexCount * 2 },
    vertexSphere: { offset: words[W.vSphere]!, length: counts.vertexCount * 3 },
  };

  let cursor = HEADER_WORDS;
  const numeric = [
    ['vertexCoords', sections.vertexCoords],
    ['vertexSphere', sections.vertexSphere],
  ] as const;
  for (const [name, section] of numeric) {
    if (section.offset !== cursor) throw new Error(`invalid topology section offset: ${name}`);
    cursor += section.length;
    if (cursor > totalWords) throw new Error(`topology section out of bounds: ${name}`);
  }
  if (cursor !== totalWords) throw new Error('topology trailing bytes mismatch');
}

/**
 * Return an aligned u32 view over encoded topology bytes.
 *
 * @throws Error when storage is too short, unaligned, or not ArrayBuffer-backed.
 */
function encodedWords(bytes: Uint8Array): Uint32Array {
  if (bytes.byteLength < HEADER_WORDS * 4) throw new Error('topology header is truncated');
  if (bytes.byteLength % 4 !== 0) throw new Error('topology byte length must be 4-byte aligned');
  if (!(bytes.buffer instanceof ArrayBuffer))
    throw new Error('topology storage must be ArrayBuffer-backed');
  if (bytes.byteOffset % 4 !== 0) throw new Error('topology storage must be 4-byte aligned');
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
