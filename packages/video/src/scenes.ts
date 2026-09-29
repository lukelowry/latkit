import type { Series } from '@latkit/model';
import type { ChannelBinding } from '@latkit/gpu';
import type { Scene } from './types.js';

type WireBinding = Omit<ChannelBinding, 'values'> & {
  readonly values:
    Float32Array | Float64Array | { readonly series: number; readonly signal: number };
};
type Wire<S extends Scene> = S extends { kind: 'monitor' }
  ? Omit<S, 'series'> & { readonly series: number }
  : Omit<S, 'channels'> & { readonly channels?: Readonly<Record<string, WireBinding>> };
export type WireScene = Wire<Scene>;

/** Deduplicate series by identity; leave large sample stores on their owner. */
export function pack(views: readonly Scene[]): { views: WireScene[]; series: Series[] } {
  const series: Series[] = [];
  const ids = new Map<Series, number>();
  const identify = (source: Series): number => {
    let id = ids.get(source);
    if (id === undefined) {
      id = series.length;
      ids.set(source, id);
      series.push(source);
    }
    return id;
  };
  const packed = views.map((view): WireScene => {
    if (view.kind === 'monitor') return { ...view, series: identify(view.series) };
    if (view.kind !== 'network' && view.kind !== 'diagram')
      throw new TypeError('Unknown video view');
    return {
      ...view,
      channels: Object.fromEntries(
        Object.entries(view.channels ?? {}).map(([name, binding]) => [
          name,
          {
            ...binding,
            values:
              'series' in binding.values
                ? { series: identify(binding.values.series), signal: binding.values.signal }
                : binding.values,
          },
        ]),
      ),
    };
  });
  return { views: packed, series };
}
export function unpack(views: readonly WireScene[], series: readonly Series[]): Scene[] {
  const source = (id: number): Series => {
    const value = series[id];
    if (!value) throw new RangeError('Missing video series');
    return value;
  };
  return views.map((view): Scene => {
    if (view.kind === 'monitor') return { ...view, series: source(view.series) };
    return {
      ...view,
      channels: Object.fromEntries(
        Object.entries(view.channels ?? {}).map(([name, binding]) => [
          name,
          {
            ...binding,
            values:
              'series' in binding.values
                ? { series: source(binding.values.series), signal: binding.values.signal }
                : binding.values,
          },
        ]),
      ),
    };
  });
}
