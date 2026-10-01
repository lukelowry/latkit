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
  readonly portSpacing?: number;
  readonly routeClearance?: number;
  readonly motion?: 'auto' | 'reduce' | 'full';
  readonly animationMs?: number;
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
