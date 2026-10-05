import { createColormap, colormaps, spotlight } from '@latkit/gpu';
import type { DiagramConfig, Shape, RouteStrategy } from '@latkit/diagram';
import type { Shade } from '@latkit/gpu';
import { types, shapes } from './graph.js';
import type { GraphSource } from './source.js';
export interface Settings {
  shape: 'mixed' | Shape;
  route: 'orthogonal' | 'straight' | 'elbow';
  appearance: 'wire' | 'tag';
  palette: 'neutral' | 'signal' | 'thermal';
  flow: boolean;
  arrows: boolean;
  status: boolean;
  labels: boolean;
  light: boolean;
  density: 'compact' | 'comfortable' | 'spacious';
  titlePosition: 'header' | 'center';
  overflow: 'wrap' | 'ellipsis';
}
/** The config's style options. */
export type Style = Omit<DiagramConfig, 'source' | 'vertices' | 'edges' | 'groups'>;
/** What the diagram draws. */
export type Drawn = Required<Pick<DiagramConfig, 'source' | 'vertices' | 'edges' | 'groups'>>;
const signalMap = createColormap({
  colors: [
    [0.12, 0.23, 0.27, 1],
    [0.18, 0.34, 0.35, 1],
    [0.28, 0.39, 0.32, 1],
  ],
  label: 'Signal',
});
const thermalMap = createColormap({
  label: 'Inferno surfaces',
  colors: colormaps.inferno.colors.map(([r, g, b]) => [r * 0.45, g * 0.45, b * 0.45, 1]),
});
const lightSignalMap = createColormap({
  colors: signalMap.colors.map(([r, g, b]) => [0.8 + r * 0.2, 0.8 + g * 0.2, 0.8 + b * 0.2, 1]),
});
const lightThermalMap = createColormap({
  colors: colormaps.inferno.colors.map(([r, g, b]) => [
    0.8 + r * 0.2,
    0.8 + g * 0.2,
    0.8 + b * 0.2,
    1,
  ]),
});
const statusMap = createColormap({
  kind: 'categorical',
  colors: [
    [0, 0, 0, 0],
    [0.94, 0.64, 0.32, 1],
  ],
});
const elbow: RouteStrategy = {
  route: ({ ends }) =>
    ends
      .slice(1)
      .map((to) => [ends[0].position, [to.position[0], ends[0].position[1]], to.position]),
};
export function theme(light: boolean): Style {
  return light
    ? {
        ...base,
        background: [0.96, 0.97, 0.98, 1],
        vertexColor: [1, 1, 1, 1],
        edgeColor: [0.34, 0.43, 0.55, 1],
        outlineColor: [0.61, 0.68, 0.76, 1],
        textColor: [0.13, 0.2, 0.29, 1],
        gridColor: [0.35, 0.44, 0.56, 0.24],
        groupColor: [0.4, 0.56, 0.78, 0.07],
        hoverColor: [0.22, 0.49, 0.79, 1],
        selectedColor: [0.14, 0.38, 0.7, 1],
      }
    : base;
}
const base: Style = {
  background: [0.063, 0.082, 0.106, 1],
  vertexColor: [0.1, 0.13, 0.17, 1],
  edgeColor: [0.46, 0.57, 0.65, 1],
  outlineColor: [0.34, 0.43, 0.5, 1],
  textColor: [0.91, 0.94, 0.96, 1],
  gridColor: [0.35, 0.43, 0.52, 0.26],
  groupColor: [0.24, 0.36, 0.4, 0.1],
  hoverColor: [0.48, 0.7, 0.94, 1],
  selectedColor: [0.51, 0.72, 1, 1],
  fontSizePx: 13,
  gridPitch: 8,
  vertexPadding: 12,
  portSpacing: 24,
  routeClearance: 16,
  fitPaddingPx: 44,
};
export function data(source: GraphSource, settings: Settings, automatic = false): Drawn {
  return {
    source: source.data,
    vertices: Object.fromEntries(
      types.map((type) => [
        type,
        {
          ...(!automatic ? { x: 'position', y: { field: 'position', component: 1 } } : {}),
          shape: settings.shape === 'mixed' ? shapes[type] : settings.shape,
          labels: {
            field: 'name',
            fontSize: settings.density === 'compact' ? 12 : 13,
            maxWidth: 180,
            overflow: settings.overflow,
          },
          labelPosition: settings.titlePosition,
          visible: 'visible',
          shade: 'signal',
          color:
            settings.palette === 'neutral'
              ? null
              : {
                  field: 'signal',
                  domain: [0, 1],
                  colormap:
                    settings.palette === 'signal'
                      ? settings.light
                        ? lightSignalMap
                        : signalMap
                      : settings.light
                        ? lightThermalMap
                        : thermalMap,
                },
          status: settings.status ? { field: 'status', domain: [0, 1], colormap: statusMap } : null,
          ports:
            type === 'Control' ? { feedback: { side: 'bottom', label: 'feedback' } } : undefined,
        },
      ]),
    ),
    edges: {
      Signal: {
        route: settings.route === 'elbow' ? elbow : settings.route,
        appearance: settings.appearance,
        labels: { field: 'name', fontSize: 12, maxWidth: 140, overflow: 'ellipsis' },
        arrows: settings.arrows,
        flowPx: settings.flow ? { field: 'signal', domain: [0, 1], range: [20, 48] } : null,
        widthPx: { field: 'signal', domain: [0, 1], range: [1.5, 2.5] },
      },
    },
    groups: source.graph.groups,
  };
}
export function effect(name: string): Shade | null {
  if (name === 'spotlight')
    return spotlight({ radiusPx: 180, strength: 0.3, color: [1, 0.52, 0.36] });
  if (name === 'signal')
    return {
      wgsl: 'fn shade(f: ShadeFragment) -> vec4f { let c=mix(f.color.rgb,vec3f(0.18,0.58,0.52),f.value*0.5); return vec4f(c,f.color.a); }',
    };
  return null;
}
