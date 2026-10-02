import { GpuError, kit, type RGBA } from '@latkit/gpu';

/** How a network draws; every option has a default. */
export interface StyleOptions extends kit.HoverOptions {
  readonly msaa?: 1 | 4;
  readonly showVertices?: boolean;
  readonly showEdges?: boolean;
  /** Stems from the ground to raised vertices. */
  readonly showPoles?: boolean;
  readonly showGraticule?: boolean;
  /** The globe's axis. */
  readonly showEarthAxis?: boolean;
  readonly vertexRadiusPx?: number;
  readonly edgeWidthPx?: number;
  readonly heightScale?: number;
  readonly dashPeriodPx?: number;
  readonly vertexBaseColor?: RGBA;
  /** Null colors each edge by its ends. */
  readonly edgeBaseColor?: RGBA | null;
  readonly backgroundColor?: RGBA;
  readonly surfaceColor?: RGBA;
  readonly graticuleColor?: RGBA;
  /** Light the globe by the sun at `sunTime`, or now. */
  readonly daylight?: boolean;
  readonly sunTime?: number | null;
  readonly nightFloor?: number;
  readonly surfaceNightFloor?: number;
  readonly terminatorWidth?: number;
  /** Halo hovered and selected items. */
  readonly focusEnabled?: boolean;
  readonly hoverColor?: RGBA;
  readonly selectedColor?: RGBA;
  readonly hoverAlpha?: number;
  readonly selectedAlpha?: number;
  readonly vertexHoverPx?: number;
  readonly vertexSelectedPx?: number;
  readonly edgeHoverPx?: number;
  readonly edgeSelectedPx?: number;
  /** Also halo the vertices an edge joins. */
  readonly focusEnds?: 'off' | 'selected' | 'hover-selected';
  readonly fitPaddingPx?: kit.Insets;
  readonly fitPitch?: number;
  readonly fitBearing?: number;
  readonly revealPaddingPx?: number;
  readonly animationMs?: number;
  readonly orbitRate?: number;
  readonly motion?: 'auto' | 'reduce' | 'full';
  readonly pickRadiusPx?: number;
}
export type Style = Required<StyleOptions>;
export const DEFAULTS: Style = Object.freeze({
  msaa: 4,
  showVertices: true,
  showEdges: true,
  showPoles: false,
  showGraticule: false,
  showEarthAxis: true,
  vertexRadiusPx: 4,
  edgeWidthPx: 1.4,
  heightScale: 1,
  dashPeriodPx: 12,
  vertexBaseColor: [0.28, 0.75, 0.85, 1] as RGBA,
  edgeBaseColor: null,
  backgroundColor: [0.025, 0.038, 0.06, 1] as RGBA,
  surfaceColor: [0.07, 0.1, 0.15, 1] as RGBA,
  graticuleColor: [0.3, 0.38, 0.46, 0.4] as RGBA,
  daylight: false,
  sunTime: null,
  nightFloor: 0.55,
  surfaceNightFloor: 0.15,
  terminatorWidth: 0.12,
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
const UNIT = new Set([
  'nightFloor',
  'surfaceNightFloor',
  'terminatorWidth',
  'hoverAlpha',
  'selectedAlpha',
]);
/** The style a config describes: its own options over the defaults. */
export function resolveStyle(config: StyleOptions): Style {
  const style: Record<string, unknown> = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Style)[]) {
    const value = config[key];
    if (value === undefined) continue;
    if (key.endsWith('Color')) {
      if (!(key === 'edgeBaseColor' && value === null)) kit.validateRgba(value as RGBA);
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
    } else if (typeof DEFAULTS[key] === 'boolean') {
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
    if (UNIT.has(key) && (value as number) > 1)
      throw new GpuError('invalid-input', 'Option must be in [0,1]: ' + key);
    style[key] = value;
  }
  return Object.freeze(style) as Style;
}
