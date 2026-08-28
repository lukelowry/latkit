import { decodeSegments, type DecodedSegments, type EncodedSegments } from './segments/index.js';
import { readEncodedTopologyInfo, type EncodedTopology } from './topology/index.js';
import type { EncodedTopologyInfo } from './topology/types.js';
import { W } from './topology/wire.js';

/** Validated encoded scene shared by renderer and picker. */
export interface PreparedScene {
  /** Encoded topology storage retained for GPU upload. */
  readonly topology: EncodedTopology;
  /** Validated topology metadata. */
  readonly info: EncodedTopologyInfo;
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

  return {
    topology,
    info,
    coords,
    segments,
  };
}
