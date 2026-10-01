import { GpuError, validateRgba } from '@latkit/gpu';
import type { Options, Limits } from './options.js';
import type { DiagramData, ComponentOptions, ConnectionOptions } from './data.js';
export const defaults: Required<Options> = {
  gridPitch: 8,
  grid: true,
  snap: true,
  labels: true,
  junctions: true,
  font: { family: 'system-ui, sans-serif' },
  fontSizePx: 12,
  nodePadding: 12,
  portSpacing: 24,
  routeClearance: 16,
  motion: 'auto',
  animationMs: 250,
  pickRadiusPx: 8,
  fitPaddingPx: 32,
  revealPaddingPx: 48,
  hover: 'auto',
  hoverBudgetMs: 4,
  msaa: 1,
  backgroundColor: [0.055, 0.065, 0.09, 1],
  componentBaseColor: [0.16, 0.19, 0.25, 1],
  connectionBaseColor: [0.6, 0.65, 0.73, 1],
  outlineColor: [0.4, 0.47, 0.58, 1],
  textColor: [0.92, 0.94, 0.98, 1],
  gridColor: [0.5, 0.55, 0.65, 0.2],
  groupColor: [0.45, 0.55, 0.7, 0.1],
  hoverColor: [1, 0.7, 0.25, 1],
  selectedColor: [0.35, 0.7, 1, 1],
};
export const limitDefaults: Required<Limits> = {
  components: 100000,
  connections: 200000,
  endpoints: 1000000,
  geometryBytes: 128 * 1024 ** 2,
  pickingBytes: 32 * 1024 ** 2,
  routePoints: 2000000,
  prepareMs: 30000,
};
export function fail(message: string): never {
  throw new GpuError('invalid-input', message);
}
export function positive(value: number, name: string, zero = false): number {
  if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0)) fail('Invalid ' + name);
  return value;
}
export function patch<T extends object>(base: T, values: Partial<T>): T {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)),
  };
}
export function options(value: Options = {}, base = defaults): Required<Options> {
  const result = patch(base, value);
  for (const key of [
    'gridPitch',
    'fontSizePx',
    'nodePadding',
    'portSpacing',
    'routeClearance',
    'animationMs',
    'pickRadiusPx',
    'revealPaddingPx',
    'hoverBudgetMs',
  ] as const)
    positive(result[key], key, key === 'animationMs');
  for (const key of ['grid', 'snap', 'labels', 'junctions'] as const)
    if (typeof result[key] !== 'boolean') fail('Invalid ' + key);
  if (![1, 4].includes(result.msaa)) fail('Invalid msaa');
  if (!['auto', 'reduce', 'full'].includes(result.motion)) fail('Invalid motion');
  if (!['auto', 'on', 'off'].includes(result.hover)) fail('Invalid hover');
  const padding =
    typeof result.fitPaddingPx === 'number' ? [result.fitPaddingPx] : result.fitPaddingPx;
  if (padding.length !== 1 && padding.length !== 4) fail('Invalid fitPaddingPx');
  padding.forEach((v) => positive(v, 'fitPaddingPx', true));
  if (!result.font.family) fail('A font family is required');
  for (const key of Object.keys(result) as (keyof Options)[])
    if (key.endsWith('Color')) validateRgba(result[key] as import('@latkit/gpu').RGBA);
  return result;
}
export function limits(value: Limits = {}): Required<Limits> {
  const result = patch(limitDefaults, value);
  for (const [name, v] of Object.entries(result)) {
    positive(v, name);
    if (name !== 'prepareMs' && !Number.isSafeInteger(v)) fail('Invalid integer limit: ' + name);
  }
  return result;
}
function binding(value: ComponentOptions | ConnectionOptions) {
  if (value.labels) {
    if (value.labels.size !== undefined) positive(value.labels.size, 'label size');
    if (value.labels.maxWidth !== undefined) positive(value.labels.maxWidth, 'label width');
    if (
      value.labels.maxCount !== undefined &&
      (!Number.isSafeInteger(value.labels.maxCount) || value.labels.maxCount < 0)
    )
      fail('Invalid label count');
    if (value.labels.color) validateRgba(value.labels.color);
    if (value.labels.overflow && !['wrap', 'ellipsis'].includes(value.labels.overflow))
      fail('Invalid label overflow');
  }
}
export function data(value: DiagramData): DiagramData {
  if (!value.source || typeof value.source.query !== 'function')
    fail('A Queryable source is required');
  if (!value.components) fail('Component bindings are required');
  for (const component of Object.values(value.components)) {
    binding(component);
    if (
      component.shape &&
      !['rectangle', 'rounded', 'ellipse', 'diamond'].includes(component.shape)
    )
      fail('Invalid shape');
    for (const port of Object.values(component.ports ?? {})) {
      if (port.side && !['left', 'right', 'top', 'bottom'].includes(port.side))
        fail('Invalid port side');
      if (port.order !== undefined && !Number.isFinite(port.order)) fail('Invalid port order');
    }
  }
  for (const connection of Object.values(value.connections ?? {})) {
    binding(connection);
    if (
      connection.route &&
      typeof connection.route === 'string' &&
      !['straight', 'orthogonal'].includes(connection.route)
    )
      fail('Invalid route');
    if (
      connection.route &&
      typeof connection.route === 'object' &&
      typeof connection.route.route !== 'function'
    )
      fail('Invalid routing strategy');
    if (connection.appearance && !['wire', 'tag'].includes(connection.appearance))
      fail('Invalid connection appearance');
  }
  for (const [id, group] of Object.entries(value.groups ?? {})) {
    const seen = new Set([id]);
    let parent = group.parent;
    while (parent) {
      if (seen.has(parent)) fail('Cyclic group parents');
      seen.add(parent);
      const entry = value.groups?.[parent];
      if (!entry) fail('Unknown parent group: ' + parent);
      parent = entry.parent;
    }
  }
  return {
    ...value,
    components: { ...value.components },
    connections: { ...value.connections },
    groups: { ...value.groups },
  };
}
export function sources(data: DiagramData): Set<import('@latkit/model').Queryable> {
  const result = new Set([data.source]);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
    if ('source' in value && 'field' in value) {
      result.add((value as import('@latkit/gpu').FieldBinding).source);
      return;
    }
    if ('values' in value) return;
    for (const child of Object.values(value)) visit(child);
  };
  visit(data.components);
  visit(data.connections);
  return result;
}
