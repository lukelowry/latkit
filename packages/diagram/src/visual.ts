/**
 * The fixed visual and interaction tuning every diagram shares. Pixel values are CSS pixels. The
 * gesture thresholds (drag, double tap, touch pick radius) and the key zoom step belong to the
 * input adapters that apply them.
 *
 * The shader-side values are repeated as WGSL `const`s in `webgpu/shaders/common.wgsl` (named in
 * `SCREAMING_SNAKE_CASE` after the key, `Px` as `_PX`); a unit test holds the two to the same
 * numbers, so the CPU and the passes agree on every size.
 */
export const VISUAL = Object.freeze({
  /** Wire half-width at rest: a 1.5 px line. */
  wireHalfWidthPx: 0.75,
  /** Wire half-width while hovered. */
  wireHoverHalfWidthPx: 1.25,
  /** Wire half-width while selected. */
  wireSelectedHalfWidthPx: 1.5,
  /** Junction dot radius. */
  junctionRadiusPx: 2.5,
  /** Arrowhead length from tip to base. */
  arrowLengthPx: 7,
  /** Arrowhead width at its base. */
  arrowWidthPx: 6,
  /** Arrows and junctions fade out below this screen size of one grid pitch. */
  wireDetailGridPx: 4,
  /** Flow dash period. */
  dashPeriodPx: 10,
  /** Fraction of a dash period that is drawn. */
  dashDuty: 0.6,
  /** Dash speed at `flowRate` 1 and a `netFlow` of 1, in CSS px per second. */
  dashSpeedPx: 40,
  /** Chevron period for flowing nets under reduced motion. */
  chevronPeriodPx: 16,
  /** Grid dot radius. */
  gridDotRadiusPx: 1,
  /** The finest grid level shown is at least this far apart on screen. */
  gridMinSpacingPx: 8,
  /** A grid level is fully drawn from this screen spacing up. */
  gridFullSpacingPx: 16,
  /** Outline width of blocks, groups, and ghosts. */
  outlinePx: 1,
  /** Status ring width. */
  statusRingPx: 2,
  /** Hover halo width. */
  hoverHaloPx: 3,
  /** Selection ring width. */
  selectedRingPx: 2,
  /** Fill alpha of a block moving with a drag. */
  draggingAlpha: 0.85,
  /** Text is invisible below this em size on screen. */
  labelMinPx: 4.5,
  /** Text is fully drawn from this em size on screen up. */
  labelFullPx: 7,
  /** Port markers fold into the block edge below this screen size. */
  portFoldPx: 3,
  /** A group frame starts turning into a tile below this screen width. */
  tileStartPx: 96,
  /** A group frame is a solid tile below this screen width. */
  tileFullPx: 40,
  /** Wire preview dash length. */
  previewDashPx: 6,
  /** Wire preview gap length. */
  previewGapPx: 4,
  /** Glyph edge softness: the SDF smoothing band in `fwidth` units. */
  glyphSoftness: 0.7,
  /** Radius a wire being drawn finds its target within, at least. */
  wireTargetPx: 16,
  /** Distance from an edge within which a drag pans the view toward it. */
  autoPanZonePx: 24,
  /** Auto-pan speed at the very edge, in CSS px per second. */
  autoPanSpeedPx: 600,
  /** Distance one arrow key pans. */
  keyPanPx: 48,
  /** Inset that keeps a keyboard context-menu anchor inside the canvas. */
  contextInsetPx: 8,
});

/** The `VISUAL` keys the shaders read, each a WGSL `const` in `common.wgsl`. */
export const SHADER_VISUALS = Object.freeze([
  'wireHalfWidthPx',
  'wireHoverHalfWidthPx',
  'wireSelectedHalfWidthPx',
  'junctionRadiusPx',
  'arrowLengthPx',
  'arrowWidthPx',
  'wireDetailGridPx',
  'dashPeriodPx',
  'dashDuty',
  'dashSpeedPx',
  'chevronPeriodPx',
  'gridDotRadiusPx',
  'gridMinSpacingPx',
  'gridFullSpacingPx',
  'outlinePx',
  'statusRingPx',
  'hoverHaloPx',
  'selectedRingPx',
  'draggingAlpha',
  'labelMinPx',
  'labelFullPx',
  'portFoldPx',
  'tileStartPx',
  'tileFullPx',
  'previewDashPx',
  'previewGapPx',
  'glyphSoftness',
] as const satisfies readonly (keyof typeof VISUAL)[]);

/** The WGSL constant name of a camelCase key: `wireHalfWidthPx` is `WIRE_HALF_WIDTH_PX`. */
export function wgslName(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
