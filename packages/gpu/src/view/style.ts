import { failure } from '@latkit/model';
import { validateRgba, type RGBA } from '../colors/color.js';
import type { TextRasterizer } from '../text/text.js';
import { insetSides, type Insets } from './camera.js';
import type { ItemView } from './item-view.js';
export type ResolvedViewStyle = Required<ItemView.Style>;

/** The shared style's defaults, which each view's own defaults may override. */
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
  hoverWidthPx: 6,
  selectedWidthPx: 8,
  unselectedAlpha: 1,
  font: Object.freeze({ family: 'system-ui, sans-serif' }),
  fontSizePx: 12,
  textColor: [0.92, 0.94, 0.98, 1] as RGBA,
});

/** How lines dash and carry comets, in every view that draws lines. */
export interface LineStyle {
  /** How far a dash and the gap after it run, in CSS pixels. */
  readonly dashPeriodPx?: number;
  /** The comets a line's `flowPx` moves along it, `flowSpacingPx` apart; 0 draws none. */
  readonly flowColor?: RGBA;
  readonly flowSpacingPx?: number;
}
export const lineStyle: Required<LineStyle> = Object.freeze({
  dashPeriodPx: 12,
  flowColor: [0.95, 0.97, 1, 0.9] as RGBA,
  flowSpacingPx: 32,
});
/** Style every view with a projected camera understands, over a plane or the earth. */
export interface ProjectedStyle {
  /** The pitch a fit tilts a pitched projection to, in degrees from looking straight down. */
  readonly fitPitch?: number;
  /** The bearing a fit turns to, in degrees clockwise from north. */
  readonly fitBearing?: number;
  /** How fast an orbiting camera turns: 1 turns 12 degrees a second, and negative the other way. */
  readonly orbitRate?: number;
  /** How far the ground's halo reaches around label text, in CSS pixels. */
  readonly labelHaloPx?: number;
}
export const projectedStyle: Required<ProjectedStyle> = Object.freeze({
  fitPitch: 45,
  fitBearing: 0,
  orbitRate: 1,
  labelHaloPx: 2,
});
/** A grid beneath what a view draws, spaced for the zoom. */
export interface GridStyle {
  readonly grid?: boolean;
  readonly gridColor?: RGBA;
  /** How close the grid's lines may draw, in CSS pixels; it picks the nicest step at least this. */
  readonly gridMinSpacingPx?: number;
}
export const gridStyle: Required<GridStyle> = Object.freeze({
  grid: false,
  gridColor: [0.3, 0.38, 0.46, 0.4] as RGBA,
  gridMinSpacingPx: 64,
});
/** The steepest a camera tilts, in degrees. */
export const MAX_PITCH = 80;

/**
 * What a style option takes where its default does not say: any finite number (`signed`), one
 * above zero (`positive`), or one from 0 to 1 (`unit`); the only values it takes, beside a color
 * for a color; or a check, which may throw its own failure.
 */
export type StyleRule =
  'signed' | 'positive' | 'unit' | readonly unknown[] | ((value: unknown) => boolean);
export type StyleRules<T> = { readonly [K in keyof T]?: StyleRule };

const VIEW_RULES: StyleRules<ResolvedViewStyle> = {
  msaa: [1, 4],
  hover: ['auto', 'on', 'off'],
  motion: ['auto', 'reduce', 'full'],
  selectedColor: ['none'],
  font: (value) => typeof (value as TextRasterizer.Font | null)?.family === 'string',
  fitPaddingPx: insetsRule,
  revealPaddingPx: insetsRule,
  hoverBudgetMs: 'positive',
  fontSizePx: 'positive',
  unselectedAlpha: 'unit',
};
/** Rules for the shared pieces of a view's own style. */
const SHARED_RULES: StyleRules<Required<ProjectedStyle & GridStyle>> = {
  fitPitch: (value) => typeof value === 'number' && value >= 0 && value <= MAX_PITCH,
  fitBearing: 'signed',
  orbitRate: 'signed',
  gridMinSpacingPx: 'positive',
};

/**
 * A style over its defaults; throws on an invalid option. A color takes RGBA, a boolean option a
 * boolean, and a number one finite and not negative, unless a rule says otherwise. A view resolves
 * its own options on the shared style it resolved, `base`.
 */
export function resolveStyle<T extends object, Base extends object = object>(
  config: { readonly [K in keyof T]?: unknown },
  defaults: T,
  rules: StyleRules<T> = {},
  base?: Base,
): Readonly<T & Base> {
  const style: Record<string, unknown> = { ...base, ...(defaults as Record<string, unknown>) };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const value = config[key];
    if (value === undefined) continue;
    const rule = rules[key] ?? SHARED_RULES[key as keyof (ProjectedStyle & GridStyle)];
    if (!accepts(key, value, defaults[key], rule)) fail('Invalid ' + key);
    style[key] = value;
  }
  return Object.freeze(style) as Readonly<T & Base>;
}
/** The shared style a config describes over a view's defaults; throws on an invalid option. */
export function resolveViewStyle(
  config: ItemView.Style,
  defaults: Partial<ResolvedViewStyle> = {},
): ResolvedViewStyle {
  return resolveStyle(config, { ...viewStyle, ...defaults }, VIEW_RULES);
}
function accepts(key: string, value: unknown, fallback: unknown, rule?: StyleRule): boolean {
  const color = key.endsWith('Color') || key === 'background';
  if (typeof rule === 'function') return rule(value);
  if (Array.isArray(rule)) return rule.includes(value) || (color && isRgba(value, key));
  if (color) return isRgba(value, key);
  if (typeof fallback === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (rule === 'signed') return true;
  if (rule === 'positive') return value > 0;
  return value >= 0 && (rule !== 'unit' || value <= 1);
}
function isRgba(value: unknown, name: string): boolean {
  validateRgba(value, name);
  return true;
}
function insetsRule(value: unknown): boolean {
  insetSides(value as Insets);
  return true;
}
function fail(message: string): never {
  throw failure('invalid-input', message);
}
