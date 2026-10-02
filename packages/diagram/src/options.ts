import type { RGBA } from '@latkit/gpu';
/** How a diagram draws, beyond the shared view style; every option has a default. */
export interface DiagramStyle {
  readonly gridPitch?: number;
  readonly grid?: boolean;
  readonly snap?: boolean;
  readonly labels?: boolean;
  readonly junctions?: boolean;
  readonly vertexPadding?: number;
  /** Corner radius in diagram units. Per-vertex bindings may override it. */
  readonly cornerRadius?: number;
  /** Stroke, focus, and port sizes stay constant in CSS pixels while zooming. */
  readonly outlineWidthPx?: number;
  readonly portSizePx?: number;
  readonly portMarker?: 'directional' | 'circle' | 'diamond';
  readonly portLabels?: boolean;
  readonly portFontSizePx?: number;
  readonly edgeWidthPx?: number;
  readonly gridMinSpacingPx?: number;
  readonly detail?: 'auto' | 'full';
  readonly portSpacing?: number;
  readonly routeClearance?: number;
  /** Bounds CPU route interpolation; larger scenes settle immediately. Default: 512 vertices. */
  readonly animationMaxVertices?: number;
  readonly vertexBaseColor?: RGBA;
  readonly edgeBaseColor?: RGBA;
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
