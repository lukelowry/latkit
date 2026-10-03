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
  /** A label, axis options, or false to hide the axis. */
  readonly coordinateAxis?: string | AxisOptions | false;
  readonly valueAxis?: string | AxisOptions | false;
  /** Fraction of the fitted value range added on each side. */
  readonly domainPadding?: number;
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
  /** GPU memory for history images. */
  readonly historyBytes?: number;
  readonly pickingBytes?: number;
}
