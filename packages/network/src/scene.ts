import { decodeSegments, type DecodedSegments, type EncodedSegments } from './segments/index.js';
import { SEGMENT_RECORD_WORDS } from './segments/wire.js';
import { estimateCharacteristicLength } from './topology/pack.js';
import { readEncodedTopologyInfo, type EncodedTopology } from './topology/index.js';
import type { EncodedTopologyInfo } from './topology/types.js';
import { W } from './topology/wire.js';

/** Validated encoded scene shared by renderer and picker. */
export interface PreparedScene {
  /** Encoded topology storage retained for GPU upload. */
  readonly topology: EncodedTopology;
  /** Validated topology metadata. */
  readonly info: EncodedTopologyInfo;
  /** Raw-coordinate bounds covering vertices and every rendered edge segment. */
  readonly pathBounds: EncodedTopologyInfo['bounds'];
  /** Typical planar spacing derived from the complete rendered path extent. */
  readonly pathCharacteristicLength: number;
  /** Zero-copy interleaved vertex-coordinate view. */
  readonly coords: Float32Array<ArrayBuffer>;
  /** Validated encoded segments and reusable views. */
  readonly segments: DecodedSegments;
}

/**
 * Validate and pair encoded topology and segment storage once.
 *
 * The encoded buffers are internal owned snapshots and must remain immutable
 * while the prepared scene is active.
 */
export function prepareScene(
  topology: EncodedTopology,
  encodedSegments: EncodedSegments,
): PreparedScene {
  const info = readEncodedTopologyInfo(topology);
  const segments = decodeSegments(encodedSegments);

  if (segments.info.vertexCount !== info.vertexCount) {
    throw new Error('network segment vertex count does not match topology');
  }
  if (segments.info.edgeCount !== info.edgeCount) {
    throw new Error('network segment edge count does not match topology');
  }
  if (segments.info.fingerprint !== info.fingerprint) {
    throw new Error('network segment fingerprint does not match topology');
  }

  const words = new Uint32Array(
    topology.buffer,
    topology.byteOffset,
    topology.byteLength / Uint32Array.BYTES_PER_ELEMENT,
  );
  const coords = new Float32Array(
    topology.buffer,
    topology.byteOffset + words[W.vCoords]! * Uint32Array.BYTES_PER_ELEMENT,
    info.vertexCount * 2,
  );

  const pathBounds = computePathBounds(info.bounds, segments);
  return {
    topology,
    info,
    pathBounds,
    pathCharacteristicLength: estimateCharacteristicLength(info.vertexCount, pathBounds),
    coords,
    segments,
  };
}

/** Expand canonical vertex bounds over every encoded segment endpoint. */
function computePathBounds(
  vertexBounds: EncodedTopologyInfo['bounds'],
  segments: DecodedSegments,
): EncodedTopologyInfo['bounds'] {
  let { xMin, xMax, yMin, yMax } = vertexBounds;
  const { f32, recordsOffset } = segments;
  for (let segment = 0; segment < segments.info.segmentCount; segment++) {
    const base = recordsOffset + segment * SEGMENT_RECORD_WORDS;
    for (let offset = 4; offset <= 6; offset += 2) {
      const x = f32[base + offset]!;
      const y = f32[base + offset + 1]!;
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
  }
  return { xMin, xMax, yMin, yMax };
}
