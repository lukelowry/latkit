import { GpuError, kit, type RGBA } from '@latkit/gpu';
import type { Data } from '@latkit/model';
import type { Limits, StyleOptions } from './options.js';
import type { DiagramData, VertexData, EdgeData } from './data.js';
export type Style = Required<StyleOptions>;
export const defaults: Style = {
  gridPitch: 8,
  grid: true,
  snap: true,
  labels: true,
  junctions: true,
  font: { family: 'system-ui, sans-serif' },
  fontSizePx: 12,
  vertexPadding: 10,
  cornerRadius: 8,
  outlineWidthPx: 1,
  selectionWidthPx: 2,
  hoverWidthPx: 3,
  portSizePx: 8,
  portMarker: 'directional',
  portLabels: true,
  portFontSizePx: 11,
  edgeWidthPx: 1.5,
  gridMinSpacingPx: 12,
  detail: 'auto',
  portSpacing: 22,
  routeClearance: 16,
  motion: 'auto',
  animationMs: 250,
  animationMaxVertices: 512,
  pickRadiusPx: 8,
  fitPaddingPx: 32,
  revealPaddingPx: 48,
  hover: 'auto',
  hoverBudgetMs: 4,
  msaa: 1,
  backgroundColor: [0.055, 0.065, 0.09, 1],
  vertexBaseColor: [0.16, 0.19, 0.25, 1],
  edgeBaseColor: [0.6, 0.65, 0.73, 1],
  outlineColor: [0.4, 0.47, 0.58, 1],
  textColor: [0.92, 0.94, 0.98, 1],
  gridColor: [0.5, 0.55, 0.65, 0.2],
  groupColor: [0.45, 0.55, 0.7, 0.1],
  hoverColor: [1, 0.7, 0.25, 1],
  selectedColor: [0.35, 0.7, 1, 1],
};
export const limitDefaults: Required<Limits> = {
  vertices: 100000,
  edges: 200000,
  ends: 1000000,
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
/** The style a config describes: its own options over the defaults. */
export function options(config: StyleOptions = {}): Style {
  const result = patch(
    defaults,
    Object.fromEntries(
      Object.keys(defaults).map((key) => [key, config[key as keyof StyleOptions]]),
    ) as StyleOptions,
  );
  for (const key of [
    'gridPitch',
    'fontSizePx',
    'vertexPadding',
    'cornerRadius',
    'outlineWidthPx',
    'selectionWidthPx',
    'hoverWidthPx',
    'portSizePx',
    'portFontSizePx',
    'edgeWidthPx',
    'gridMinSpacingPx',
    'portSpacing',
    'routeClearance',
    'animationMs',
    'pickRadiusPx',
    'revealPaddingPx',
    'hoverBudgetMs',
  ] as const)
    positive(
      result[key],
      key,
      ['animationMs', 'cornerRadius', 'outlineWidthPx', 'hoverWidthPx'].includes(key),
    );
  for (const key of ['grid', 'snap', 'labels', 'junctions', 'portLabels'] as const)
    if (typeof result[key] !== 'boolean') fail('Invalid ' + key);
  if (!Number.isSafeInteger(result.animationMaxVertices) || result.animationMaxVertices < 0)
    fail('Invalid animationMaxVertices');
  if (!['auto', 'full'].includes(result.detail)) fail('Invalid detail');
  if (!['directional', 'circle', 'diamond'].includes(result.portMarker)) fail('Invalid portMarker');
  if (![1, 4].includes(result.msaa)) fail('Invalid msaa');
  if (!['auto', 'reduce', 'full'].includes(result.motion)) fail('Invalid motion');
  if (!['auto', 'on', 'off'].includes(result.hover)) fail('Invalid hover');
  const padding =
    typeof result.fitPaddingPx === 'number' ? [result.fitPaddingPx] : result.fitPaddingPx;
  if (padding.length !== 1 && padding.length !== 4) fail('Invalid fitPaddingPx');
  padding.forEach((v) => positive(v, 'fitPaddingPx', true));
  if (!result.font.family) fail('A font family is required');
  for (const key of Object.keys(result) as (keyof Style)[])
    if (key.endsWith('Color')) kit.validateRgba(result[key] as RGBA);
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
function binding(value: VertexData | EdgeData) {
  if (value.labels) {
    if (value.labels.size !== undefined) positive(value.labels.size, 'label size');
    if (value.labels.maxWidth !== undefined) positive(value.labels.maxWidth, 'label width');
    if (
      value.labels.maxCount !== undefined &&
      (!Number.isSafeInteger(value.labels.maxCount) || value.labels.maxCount < 0)
    )
      fail('Invalid label count');
    if (value.labels.color) kit.validateRgba(value.labels.color);
    if (value.labels.overflow && !['wrap', 'ellipsis'].includes(value.labels.overflow))
      fail('Invalid label overflow');
  }
}
export function data(value: DiagramData): DiagramData {
  if (!value.source?.schema || !value.source.tables) fail('A Data source is required');
  if (!value.vertices) fail('Vertex bindings are required');
  for (const vertex of Object.values(value.vertices)) {
    binding(vertex);
    if (vertex.cornerRadius !== undefined) positive(vertex.cornerRadius, 'cornerRadius', true);
    if (vertex.labelPosition && !['header', 'center'].includes(vertex.labelPosition))
      fail('Invalid labelPosition');
    if (vertex.shape && !['rectangle', 'rounded', 'ellipse', 'diamond'].includes(vertex.shape))
      fail('Invalid shape');
    for (const port of Object.values(vertex.ports ?? {})) {
      if (port.marker && !['directional', 'circle', 'diamond'].includes(port.marker))
        fail('Invalid port marker');
      if (port.side && !['left', 'right', 'top', 'bottom'].includes(port.side))
        fail('Invalid port side');
      if (port.order !== undefined && !Number.isFinite(port.order)) fail('Invalid port order');
    }
  }
  for (const [type, edge] of Object.entries(value.edges ?? {})) {
    binding(edge);
    if (
      edge.ends &&
      (edge.ends.length !== 2 ||
        !edge.ends.every((end) => typeof end === 'string') ||
        edge.ends[0] === edge.ends[1])
    )
      fail('Edge ends must be two distinct fields: ' + type);
    if (edge.arrows !== undefined && typeof edge.arrows !== 'boolean') fail('Invalid arrows');
    if (
      edge.route &&
      typeof edge.route === 'string' &&
      !['straight', 'orthogonal'].includes(edge.route)
    )
      fail('Invalid route');
    if (edge.route && typeof edge.route === 'object' && typeof edge.route.route !== 'function')
      fail('Invalid routing strategy');
    if (edge.appearance && !['wire', 'tag'].includes(edge.appearance))
      fail('Invalid edge appearance');
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
    vertices: { ...value.vertices },
    edges: { ...value.edges },
    groups: { ...value.groups },
  };
}
export function sources(data: DiagramData): Set<Data> {
  const result = new Set([data.source]);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return;
    if ('source' in value && 'field' in value) {
      result.add((value as kit.FieldBinding).source);
      return;
    }
    if ('values' in value) return;
    for (const child of Object.values(value)) visit(child);
  };
  visit(data.vertices);
  visit(data.edges);
  return result;
}
