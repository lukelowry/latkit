import { failure } from '@latkit/model';
import { validateRgba, type RGBA } from '../colors/color.js';
import type { TextFont } from '../text/text.js';
import { insetSides, type Insets } from './camera.js';

/** Style every item view understands, with one set of defaults. */
export interface ViewStyle {
  readonly background?: RGBA;
  readonly msaa?: 1 | 4;
  /** `auto` searches within `hoverBudgetMs` once the camera settles; `on` always searches. */
  readonly hover?: 'auto' | 'on' | 'off';
  readonly hoverBudgetMs?: number;
  readonly pickRadiusPx?: number;
  readonly fitPaddingPx?: Insets;
  /** Reveal centers an item closer than this to the canvas edge. */
  readonly revealPaddingPx?: Insets;
  readonly animationMs?: number;
  /** `auto` follows the reduced-motion preference. */
  readonly motion?: 'auto' | 'reduce' | 'full';
  readonly hoverColor?: RGBA;
  /** `none` keeps each selected item's own color. */
  readonly selectedColor?: RGBA | 'none';
  readonly hoverWidthPx?: number;
  readonly selectedWidthPx?: number;
  readonly font?: TextFont;
  readonly fontSizePx?: number;
  readonly textColor?: RGBA;
}
export type ResolvedViewStyle = Required<ViewStyle>;

export const viewStyle: ResolvedViewStyle = Object.freeze({
  background: [0.025, 0.038, 0.06, 1] as RGBA,
  msaa: 4,
  hover: 'auto',
  hoverBudgetMs: 2,
  pickRadiusPx: 8,
  fitPaddingPx: 32,
  revealPaddingPx: 48,
  animationMs: 300,
  motion: 'auto',
  hoverColor: [1, 0.72, 0.28, 1] as RGBA,
  selectedColor: [1, 0.4, 0.24, 1] as RGBA,
  hoverWidthPx: 3,
  selectedWidthPx: 3,
  font: Object.freeze({ family: 'system-ui, sans-serif' }),
  fontSizePx: 12,
  textColor: [0.92, 0.94, 0.98, 1] as RGBA,
});

const keys = Object.keys(viewStyle) as (keyof ViewStyle)[];
/** The shared style a config describes over a view's defaults; throws on an invalid option. */
export function resolveViewStyle(
  config: ViewStyle,
  defaults: Partial<ResolvedViewStyle> = {},
): ResolvedViewStyle {
  const style: Record<string, unknown> = { ...viewStyle, ...defaults };
  for (const key of keys) {
    const value = config[key];
    if (value === undefined) continue;
    if (key === 'selectedColor' && value === 'none') {
      // Selection keeps item colors.
    } else if (key.endsWith('Color') || key === 'background') validateRgba(value as RGBA);
    else if (key === 'msaa') {
      if (value !== 1 && value !== 4) fail('MSAA must be 1 or 4');
    } else if (key === 'hover') {
      if (!['auto', 'on', 'off'].includes(value as string)) fail('Invalid hover policy');
    } else if (key === 'motion') {
      if (!['auto', 'reduce', 'full'].includes(value as string)) fail('Invalid motion');
    } else if (key === 'font') {
      if (typeof (value as TextFont).family !== 'string') fail('Invalid font');
    } else if (key === 'fitPaddingPx' || key === 'revealPaddingPx') insetSides(value as Insets);
    else if (key === 'hoverBudgetMs' || key === 'fontSizePx') {
      if (!Number.isFinite(value) || (value as number) <= 0) fail('Invalid ' + key);
    } else if (!Number.isFinite(value) || (value as number) < 0) fail('Invalid ' + key);
    style[key] = value;
  }
  return Object.freeze(style) as ResolvedViewStyle;
}
function fail(message: string): never {
  throw failure('invalid-input', message);
}
