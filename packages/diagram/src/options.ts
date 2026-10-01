import type { HoverOptions, Insets, RGBA, TextFont } from '@latkit/gpu';
export interface Options extends HoverOptions {
  readonly gridPitch?: number;
  readonly grid?: boolean;
  readonly snap?: boolean;
  readonly labels?: boolean;
  readonly junctions?: boolean;
  readonly font?: TextFont;
  /** Default text size in diagram units (CSS pixels at scale 1). */
  readonly fontSizePx?: number;
  readonly nodePadding?: number;
  /** Corner radius in diagram units. Per-component bindings may override it. */
  readonly cornerRadius?: number;
  /** Stroke, focus, and port sizes stay constant in CSS pixels while zooming. */
  readonly outlineWidthPx?: number;
  readonly selectionWidthPx?: number;
  readonly hoverWidthPx?: number;
  readonly portSizePx?: number;
  readonly portMarker?: 'directional' | 'circle' | 'diamond';
  readonly portLabels?: boolean;
  readonly portFontSizePx?: number;
  readonly connectionWidthPx?: number;
  readonly gridMinSpacingPx?: number;
  readonly detail?: 'auto' | 'full';
  readonly portSpacing?: number;
  readonly routeClearance?: number;
  readonly motion?: 'auto' | 'reduce' | 'full';
  readonly animationMs?: number;
  /** Bounds CPU route interpolation; larger scenes settle immediately. Default: 512 components. */
  readonly animationMaxComponents?: number;
  readonly pickRadiusPx?: number;
  readonly fitPaddingPx?: Insets;
  readonly revealPaddingPx?: number;
  readonly backgroundColor?: RGBA;
  readonly componentBaseColor?: RGBA;
  readonly connectionBaseColor?: RGBA;
  readonly outlineColor?: RGBA;
  readonly textColor?: RGBA;
  readonly gridColor?: RGBA;
  readonly groupColor?: RGBA;
  readonly hoverColor?: RGBA;
  readonly selectedColor?: RGBA;
  readonly msaa?: 1 | 4;
}
export interface Limits {
  readonly components?: number;
  readonly connections?: number;
  readonly endpoints?: number;
  readonly geometryBytes?: number;
  readonly pickingBytes?: number;
  readonly routePoints?: number;
  readonly prepareMs?: number;
}
