import type { RGBA, Insets } from '@latkit/gpu';
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
  /** A trace's `color` and `widthPx` where it leaves them unset. */
  readonly traceColor?: RGBA;
  readonly traceWidthPx?: number;
  /** A label, axis options, or false to hide the axis. */
  readonly xAxis?: string | AxisOptions | false;
  readonly yAxis?: string | AxisOptions | false;
  readonly axisColor?: RGBA;
  readonly gridColor?: RGBA;
  /** The playhead at `at`. */
  readonly cursorColor?: RGBA;
  /** Opacity of unselected traces while something is selected. */
  readonly unselectedAlpha?: number;
  readonly paddingPx?: Insets;
}
export interface Limits {
  /** Rows the traces draw together. */
  readonly rows?: number;
  /** Line segments drawn per frame; what is drawn is never drawn again. */
  readonly segmentsPerFrame?: number;
  /**
   * GPU memory for history: 4 bytes a pixel for traces of fixed colors, 8 for each look of traces
   * colored by a field; five times either under MSAA.
   */
  readonly historyBytes?: number;
}
