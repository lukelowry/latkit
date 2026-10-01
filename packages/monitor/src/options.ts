import type { Domain } from '@latkit/model';
import type { HoverOptions, Insets, RGBA, TextFont } from '@latkit/gpu';
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
export interface Options extends HoverOptions {
  readonly detail?: 'auto' | 'full';
  readonly follow?: { readonly span: number } | null;
  readonly coordinateAxis?: AxisOptions | null;
  readonly valueAxis?: AxisOptions | null;
  readonly valueDomain?: Domain | 'auto';
  /** Automatic domain policy; grow avoids repainting committed history on ordinary appends. */
  readonly autoDomain?: 'grow' | 'fit';
  readonly domainPadding?: number;
  readonly font?: TextFont;
  readonly fontSizePx?: number;
  readonly textColor?: RGBA;
  readonly axisColor?: RGBA;
  readonly gridColor?: RGBA;
  readonly backgroundColor?: RGBA;
  readonly cursorColor?: RGBA;
  readonly focusColor?: RGBA | null;
  readonly unselectedAlpha?: number;
  readonly paddingPx?: Insets;
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
