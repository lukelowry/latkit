import type { Topology } from '@latkit/network';

/** Numeric JSON array encoded directly or as little-endian base64 bytes. */
export type NumericJSON = readonly number[] | { readonly base64: string };

/** Optional labels for network vertices and edges. */
export interface NetworkLabels {
  readonly vertex?: readonly string[];
  readonly edge?: readonly string[];
}

/** One decoded static scalar field over network vertices or edges. */
export interface NetworkField {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly scope: 'vertex' | 'edge';
  readonly values: Float32Array;
}

/** Decoded, renderer-ready network input. */
export interface NetworkData {
  readonly topology: Topology;
  readonly labels?: NetworkLabels;
  readonly fields?: readonly NetworkField[];
}

/** Serialized topology accepted by {@link parseNetwork}. */
export interface NetworkTopologyJSON {
  readonly vertexCount: number;
  readonly vertexCoords?: NumericJSON;
  readonly coordinateSpace?: 'cartesian' | 'geographic';
  readonly edges: NumericJSON;
  readonly polylineStart?: NumericJSON;
  readonly polylinePoints?: NumericJSON;
}

/** Serialized static field accepted by {@link parseNetwork}. */
export interface NetworkFieldJSON {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly scope: 'vertex' | 'edge';
  readonly values: NumericJSON;
}

/** JSON-compatible network input accepted by {@link parseNetwork}. */
export interface NetworkJSON {
  readonly topology: NetworkTopologyJSON;
  readonly labels?: NetworkLabels;
  readonly fields?: readonly NetworkFieldJSON[];
}
