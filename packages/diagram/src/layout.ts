import type { RequestOptions } from '@latkit/model';
import type { FieldValues, TextInput, TextMetrics } from '@latkit/gpu';
import type { DiagramData } from './data.js';
import type { Limits, Options } from './options.js';
export interface ArrangeOptions extends RequestOptions {
  readonly data: DiagramData;
  readonly options?: Pick<Options, 'gridPitch' | 'font' | 'fontSizePx'>;
  readonly limits?: Pick<Limits, 'components' | 'endpoints' | 'geometryBytes' | 'routePoints'>;
  /** Inject shaped metrics, e.g. gpu.measureText. No GPU or DOM is acquired by arrange. */
  readonly measureText: (input: TextInput, options?: RequestOptions) => Promise<TextMetrics>;
}
/** Bounded native topology reads; returns two-lane position fields keyed by component type.
 * Positions use the same physical Index as the source. Input data and documents are never edited. */
export declare function arrange(
  options: ArrangeOptions,
): Promise<Readonly<Record<string, FieldValues>>>;
