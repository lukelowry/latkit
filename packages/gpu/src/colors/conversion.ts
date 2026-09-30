import {
  converter,
  toGamut,
  useMode,
  modeA98,
  modeHsl,
  modeHsv,
  modeHwb,
  modeLab,
  modeLab65,
  modeLch,
  modeLch65,
  modeLrgb,
  modeOklab,
  modeOklch,
  modeP3,
  modeProphoto,
  modeRec2020,
  modeRgb,
  modeXyz50,
  modeXyz65,
} from 'culori/fn';
import type { Color } from 'culori';
import type { RGBA } from './color.js';

let initialized = false;
let rgb: ReturnType<typeof converter<'rgb'>>;
let gamut: ReturnType<typeof toGamut>;
/** Keep parsing and authoring initialization out of renderer-only bundles and frame preparation. */
export function initializeColors(): void {
  if (initialized) return;
  for (const mode of [
    modeA98,
    modeHsl,
    modeHsv,
    modeHwb,
    modeLab,
    modeLab65,
    modeLch,
    modeLch65,
    modeLrgb,
    modeOklab,
    modeOklch,
    modeP3,
    modeProphoto,
    modeRec2020,
    modeRgb,
    modeXyz50,
    modeXyz65,
  ])
    useMode(mode);
  rgb = converter('rgb');
  gamut = toGamut('rgb', 'oklch');
  initialized = true;
}
/** CSS absolute colors enter the bounded sRGB presentation contract here. */
export function toRgba(value: Color | string): RGBA | null {
  initializeColors();
  let color = rgb(value);
  if (!color) return null;
  const channelsIn = [color.r ?? 0, color.g ?? 0, color.b ?? 0, color.alpha ?? 1];
  if (!channelsIn.every(Number.isFinite)) return null;
  // Avoid a perceptual round trip for colors already inside the presentation gamut.
  if (channelsIn.slice(0, 3).some((v) => v < 0 || v > 1)) color = rgb(gamut(color));
  if (!color) return null;
  const channels = [color.r ?? 0, color.g ?? 0, color.b ?? 0, color.alpha ?? 1];
  if (!channels.every(Number.isFinite)) return null;
  return Object.freeze(channels.map((v) => Math.max(0, Math.min(1, v)))) as RGBA;
}
