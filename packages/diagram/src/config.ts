import { failure } from '@latkit/model';
import { kit, viewStyle, type RGBA, type ViewInput } from '@latkit/gpu';
import type { DiagramStyle, Limits } from './options.js';
import type { DiagramData, VertexOptions, EdgeOptions } from './data.js';
import type { DiagramInput } from './input.js';
import { structure } from './read.js';
import { checkStyle } from './styles.js';
export type Style = Required<DiagramStyle> & kit.ResolvedViewStyle;
/** Every new option must declare the work it invalidates. */
export const STYLE_EFFECTS = {
  gridPitch: 'scene',
  grid: 'frame',
  snap: 'frame',
  labels: 'scene',
  junctions: 'frame',
  vertexPadding: 'scene',
  cornerRadius: 'scene',
  outlineWidthPx: 'frame',
  portSize: 'route',
  portMarker: 'scene',
  portLabels: 'scene',
  portFontSize: 'scene',
  edgeWidthPx: 'frame',
  gridMinSpacingPx: 'frame',
  detail: 'frame',
  portSpacing: 'scene',
  routeClearance: 'route',
  vertexColor: 'frame',
  edgeColor: 'frame',
  outlineColor: 'frame',
  gridColor: 'frame',
  groupColor: 'frame',
  background: 'frame',
  msaa: 'frame',
  hover: 'frame',
  hoverBudgetMs: 'frame',
  pickRadiusPx: 'frame',
  fitPaddingPx: 'frame',
  revealPaddingPx: 'frame',
  animationMs: 'frame',
  motion: 'frame',
  hoverColor: 'frame',
  selectedColor: 'frame',
  hoverWidthPx: 'frame',
  selectedWidthPx: 'frame',
  font: 'scene',
  fontSizePx: 'scene',
  textColor: 'scene',
} as const satisfies Record<keyof Style, 'frame' | 'route' | 'scene'>;
export const DEFAULTS: Required<DiagramStyle> = Object.freeze({
  gridPitch: 8,
  grid: true,
  snap: true,
  labels: true,
  junctions: true,
  vertexPadding: 10,
  cornerRadius: 6,
  outlineWidthPx: 1,
  portSize: 8,
  portMarker: 'directional',
  portLabels: true,
  portFontSize: 11,
  edgeWidthPx: 1.5,
  gridMinSpacingPx: 12,
  detail: 'auto',
  portSpacing: 22,
  routeClearance: 16,
  vertexColor: [0.16, 0.19, 0.25, 1] as RGBA,
  edgeColor: [0.6, 0.65, 0.73, 1] as RGBA,
  outlineColor: [0.4, 0.47, 0.58, 1] as RGBA,
  gridColor: [0.5, 0.55, 0.65, 0.2] as RGBA,
  groupColor: [0.45, 0.55, 0.7, 0.1] as RGBA,
});
/** Every geometry is antialiased in its shader, so multisampling adds nothing but bandwidth. */
export const VIEW_DEFAULTS: Partial<kit.ResolvedViewStyle> = Object.freeze({ msaa: 1 });
export const LIMITS: Required<Limits> = Object.freeze({
  vertices: 100000,
  edges: 200000,
  ends: 1000000,
  geometryBytes: 128 * 1024 ** 2,
  pickingBytes: 32 * 1024 ** 2,
  routePoints: 2000000,
  layoutMs: 30000,
});
export function fail(message: string): never {
  throw failure('invalid-input', message);
}
export function positive(value: number, name: string, zero = false): number {
  if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0)) fail('Invalid ' + name);
  return value;
}
const ZERO = new Set(['cornerRadius', 'outlineWidthPx']);
const CHOICES: Partial<Record<keyof DiagramStyle, readonly string[]>> = {
  detail: ['auto', 'full'],
  portMarker: ['directional', 'circle', 'diamond'],
};
/** The style a config describes: its own options over the defaults, on the shared view style. */
export function resolveStyle(
  config: DiagramStyle = {},
  view: kit.ResolvedViewStyle = viewStyle,
): Style {
  const style: Record<string, unknown> = { ...view, ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof DiagramStyle)[]) {
    const value = config[key];
    if (value === undefined) continue;
    const choices = CHOICES[key];
    if (key.endsWith('Color')) kit.validateRgba(value as RGBA);
    else if (choices) {
      if (!choices.includes(value as string)) fail('Invalid ' + key);
    } else if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') fail('Invalid ' + key);
    } else positive(value as number, key, ZERO.has(key));
    style[key] = value;
  }
  return Object.freeze(style) as Style;
}
/** Limits over their defaults; `layoutMs` may be fractional. */
export function resolveLimits(value?: Limits): Required<Limits> {
  return kit.resolveLimits(value, LIMITS, 'diagram');
}
/** Throw on the diagram's own input options the gestures cannot use; return the shared rest. */
export function checkInput(input: DiagramInput): ViewInput {
  const {
    backgroundDrag,
    dragThresholdPx,
    touchDragThresholdPx,
    connectRadiusPx,
    autoPan,
    autoPanMarginPx,
    autoPanSpeedPx,
    canConnect,
    ...shared
  } = input;
  if (backgroundDrag !== undefined && !['pan', 'select'].includes(backgroundDrag))
    fail('Invalid backgroundDrag');
  for (const [key, value] of Object.entries({
    dragThresholdPx,
    touchDragThresholdPx,
    autoPanSpeedPx,
  }))
    if (value !== undefined) positive(value, key, true);
  for (const [key, value] of Object.entries({ connectRadiusPx, autoPanMarginPx }))
    if (value !== undefined) positive(value, key);
  if (autoPan !== undefined && typeof autoPan !== 'boolean') fail('Invalid autoPan');
  if (canConnect !== undefined && typeof canConnect !== 'function') fail('Invalid canConnect');
  return shared;
}
/** A type's labels and channels: what it reads, and how it draws. */
function binding(value: VertexOptions | EdgeOptions, edge: boolean) {
  const labels = kit.resolveLabels(value.labels);
  if (labels) {
    if (labels.fontSize !== undefined) positive(labels.fontSize, 'label font size');
    if (labels.maxWidth !== undefined) positive(labels.maxWidth, 'label width');
    if (
      labels.maxCount !== undefined &&
      (!Number.isSafeInteger(labels.maxCount) || labels.maxCount < 0)
    )
      fail('Invalid label count');
    if (labels.color) kit.validateRgba(labels.color);
    if (labels.overflow && !['wrap', 'ellipsis'].includes(labels.overflow))
      fail('Invalid label overflow');
  }
  structure(value, edge);
  checkStyle(value, edge);
}
export function data(value: DiagramData): DiagramData {
  if (!value.source?.schema || !value.source.tables) fail('A Data source is required');
  if (!value.vertices) fail('Vertex bindings are required');
  for (const vertex of Object.values(value.vertices)) {
    binding(vertex, false);
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
    binding(edge, true);
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
  return value;
}
