import type { kit, RGBA } from '@latkit/gpu';
export interface Tick {
  readonly value: number;
  readonly label?: string;
}
export interface AxisOptions {
  readonly label?: string;
  readonly ticks?: readonly Tick[];
  readonly minSpacingPx?: number;
  readonly format?: 'auto' | 'fixed' | 'scientific' | 'engineering';
  readonly precision?: number;
  readonly grid?: boolean;
}
/** How a monitor draws; every option has a default. */
export interface StyleOptions extends kit.HoverOptions {
  /** `full` draws every observation; `auto` summarizes long histories. */
  readonly detail?: 'auto' | 'full';
  /** A label, axis options, or false to hide the axis. */
  readonly coordinateAxis?: string | AxisOptions | false;
  readonly valueAxis?: string | AxisOptions | false;
  /** How fitted values follow appends: `grow` keeps drawn history, `fit` redraws it. */
  readonly autoDomain?: 'grow' | 'fit';
  /** Fraction of the fitted value range added on each side. */
  readonly domainPadding?: number;
  readonly font?: kit.TextFont;
  readonly fontSizePx?: number;
  readonly textColor?: RGBA;
  readonly axisColor?: RGBA;
  readonly gridColor?: RGBA;
  readonly backgroundColor?: RGBA;
  readonly cursorColor?: RGBA;
  /** Selected traces' color; null keeps their own. */
  readonly focusColor?: RGBA | null;
  /** Opacity of unselected traces while something is selected. */
  readonly unselectedAlpha?: number;
  readonly paddingPx?: kit.Insets;
  readonly pickRadiusPx?: number;
  readonly msaa?: 1 | 4;
}
export interface Limits {
  readonly rows?: number;
  readonly segmentsPerFrame?: number;
  /** Raw refinement and summary preparation per submission; retain the last presented image. */
  readonly prepareMs?: number;
  readonly historyBytes?: number;
  readonly pickingBytes?: number;
}
