import type { HoverOptions as importHoverOptions } from '@latkit/gpu';
import { GpuError, validateRgba, type Insets, type RGBA } from '@latkit/gpu';

export interface Options extends importHoverOptions {
  readonly msaa?: 1 | 4;
  readonly vertices?: boolean;
  readonly edges?: boolean;
  readonly poles?: boolean;
  readonly vertexRadiusPx?: number;
  readonly edgeWidthPx?: number;
  readonly heightScale?: number;
  readonly dashPeriodPx?: number;
  readonly vertexBaseColor?: RGBA;
  readonly edgeBaseColor?: RGBA | null;
  readonly backgroundColor?: RGBA;
  readonly surfaceColor?: RGBA;
  readonly graticuleColor?: RGBA;
  readonly graticule?: boolean;
  readonly daylight?: boolean;
  readonly sunTime?: number | null;
  readonly nightFloor?: number;
  readonly surfaceNightFloor?: number;
  readonly terminatorWidth?: number;
  readonly earthAxis?: boolean;
  readonly focusEnabled?: boolean;
  readonly hoverColor?: RGBA;
  readonly selectedColor?: RGBA;
  readonly hoverAlpha?: number;
  readonly selectedAlpha?: number;
  readonly vertexHoverPx?: number;
  readonly vertexSelectedPx?: number;
  readonly edgeHoverPx?: number;
  readonly edgeSelectedPx?: number;
  readonly focusEnds?: 'off' | 'selected' | 'hover-selected';
  readonly fitPaddingPx?: Insets;
  readonly fitPitch?: number;
  readonly fitBearing?: number;
  readonly revealPaddingPx?: number;
  readonly animationMs?: number;
  readonly orbitRate?: number;
  readonly motion?: 'auto' | 'reduce' | 'full';
  readonly pickRadiusPx?: number;
}
export const DEFAULTS: Required<Options> = Object.freeze({
  msaa: 4,
  vertices: true,
  edges: true,
  poles: false,
  vertexRadiusPx: 4,
  edgeWidthPx: 1.4,
  heightScale: 1,
  dashPeriodPx: 12,
  vertexBaseColor: [0.28, 0.75, 0.85, 1] as RGBA,
  edgeBaseColor: null,
  backgroundColor: [0.025, 0.038, 0.06, 1] as RGBA,
  surfaceColor: [0.07, 0.1, 0.15, 1] as RGBA,
  graticuleColor: [0.3, 0.38, 0.46, 0.4] as RGBA,
  graticule: false,
  daylight: false,
  sunTime: null,
  nightFloor: 0.55,
  surfaceNightFloor: 0.15,
  terminatorWidth: 0.12,
  earthAxis: true,
  focusEnabled: true,
  hoverColor: [1, 0.72, 0.28, 1] as RGBA,
  selectedColor: [1, 0.4, 0.24, 1] as RGBA,
  hoverAlpha: 0.65,
  selectedAlpha: 0.9,
  vertexHoverPx: 3,
  vertexSelectedPx: 4,
  edgeHoverPx: 2,
  edgeSelectedPx: 3,
  focusEnds: 'hover-selected',
  fitPaddingPx: 48,
  fitPitch: 45,
  fitBearing: 0,
  revealPaddingPx: 48,
  animationMs: 350,
  orbitRate: 1,
  motion: 'auto',
  pickRadiusPx: 10,
  hover: 'auto',
  hoverBudgetMs: 2,
});
export function resolveOptions(patch: Options, previous = DEFAULTS): Required<Options> {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw new GpuError('invalid-input', 'Unknown network option: ' + key);
    if (key.endsWith('Color')) {
      if (key === 'edgeBaseColor' && value === null) continue;
      validateRgba(value as RGBA);
    } else if (key === 'fitPaddingPx') {
      const values = typeof value === 'number' ? [value] : (value as readonly number[]);
      if (
        !Array.isArray(values) ||
        (values.length !== 1 && values.length !== 4) ||
        values.some((v) => !Number.isFinite(v) || v < 0)
      )
        throw new GpuError('invalid-input', 'Invalid fit padding');
    } else if (key === 'sunTime') {
      if (value !== null && !Number.isFinite(value))
        throw new GpuError('invalid-input', 'Invalid sun time');
    } else if (key === 'msaa') {
      if (value !== 1 && value !== 4) throw new GpuError('invalid-input', 'MSAA must be 1 or 4');
    } else if (typeof DEFAULTS[key as keyof Options] === 'boolean') {
      if (typeof value !== 'boolean')
        throw new GpuError('invalid-input', 'Expected boolean: ' + key);
    } else if (key === 'hover') {
      if (!['auto', 'on', 'off'].includes(value as string))
        throw new GpuError('invalid-input', 'Invalid hover policy');
    } else if (key === 'hoverBudgetMs') {
      if (!Number.isFinite(value) || (value as number) <= 0)
        throw new GpuError('invalid-input', 'Hover budget must be positive');
    } else if (key === 'motion') {
      if (!['auto', 'reduce', 'full'].includes(value as string))
        throw new GpuError('invalid-input', 'Invalid motion');
    } else if (key === 'focusEnds') {
      if (!['off', 'selected', 'hover-selected'].includes(value as string))
        throw new GpuError('invalid-input', 'Invalid end focus');
    } else if (!Number.isFinite(value) || (value as number) < 0)
      throw new GpuError('invalid-input', 'Invalid option: ' + key);
    if (
      [
        'nightFloor',
        'surfaceNightFloor',
        'terminatorWidth',
        'hoverAlpha',
        'selectedAlpha',
      ].includes(key) &&
      (value as number) > 1
    )
      throw new GpuError('invalid-input', 'Option must be in [0,1]: ' + key);
  }
  return Object.freeze({ ...previous, ...patch });
}
