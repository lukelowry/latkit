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
/** How a monitor draws, beyond the shared view style; every option has a default. */
export interface MonitorStyle {
  /** `full` draws every observation; `auto` summarizes long histories. */
  readonly detail?: 'auto' | 'full';
  /** A label, axis options, or false to hide the axis. */
  readonly coordinateAxis?: string | AxisOptions | false;
  readonly valueAxis?: string | AxisOptions | false;
  /** How fitted values follow appends: `grow` keeps drawn history, `fit` redraws it. */
  readonly autoDomain?: 'grow' | 'fit';
  /** Fraction of the fitted value range added on each side. */
  readonly domainPadding?: number;
  readonly axisColor?: RGBA;
  readonly gridColor?: RGBA;
  /** The playhead at `at`. */
  readonly cursorColor?: RGBA;
  /** Opacity of unselected traces while something is selected. */
  readonly unselectedAlpha?: number;
  readonly paddingPx?: kit.Insets;
}
export interface Limits {
  readonly rows?: number;
  /** Observations drawn per frame. */
  readonly observationsPerFrame?: number;
  /** History preparation per frame; the last presented image stays meanwhile. */
  readonly frameMs?: number;
  readonly historyBytes?: number;
  readonly pickingBytes?: number;
}
