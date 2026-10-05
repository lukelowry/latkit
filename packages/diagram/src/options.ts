import type { RGBA } from '@latkit/gpu';
/**
 * How a diagram draws, beyond the shared view style; every option has a default. Sizes without a
 * `Px` suffix are diagram units and zoom with the blocks; `Px` sizes stay constant on screen.
 */
export interface DiagramStyle {
  readonly gridPitch?: number;
  readonly grid?: boolean;
  readonly snap?: boolean;
  readonly labels?: boolean;
  readonly junctions?: boolean;
  readonly vertexPadding?: number;
  /** Per-vertex bindings may override it. */
  /** The radius of every corner: blocks, groups, and wire bends; a vertex type's own overrides it. */
  readonly cornerRadius?: number;
  readonly outlineWidthPx?: number;
  /** Port markers, arrowheads, and junctions. */
  readonly portSize?: number;
  readonly portMarker?: 'directional' | 'circle' | 'diamond';
  readonly portLabels?: boolean;
  readonly portFontSize?: number;
  readonly edgeWidthPx?: number;
  readonly gridMinSpacingPx?: number;
  readonly detail?: 'auto' | 'full';
  readonly portSpacing?: number;
  /** Space wires keep from blocks, and the length of the stub out of each port. */
  readonly routeClearance?: number;
  /** Bounds CPU route interpolation; larger scenes settle immediately. Default: 512 vertices. */
  readonly animationMaxVertices?: number;
  readonly vertexColor?: RGBA;
  readonly edgeColor?: RGBA;
  readonly outlineColor?: RGBA;
  readonly gridColor?: RGBA;
  readonly groupColor?: RGBA;
}
export interface Limits {
  readonly vertices?: number;
  readonly edges?: number;
  readonly ends?: number;
  readonly geometryBytes?: number;
  readonly pickingBytes?: number;
  readonly routePoints?: number;
  /** Time for reading, layout, and routing one scene. */
  readonly layoutMs?: number;
}
