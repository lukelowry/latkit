import { createColormap, colormaps, spotlight } from '@latkit/gpu';
import type { Options, DiagramData, Shape, RouteStrategy } from '@latkit/diagram';
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
}
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
const statusMap = createColormap({
  kind: 'categorical',
  colors: [
    [0.36, 0.43, 0.5, 1],
    [0.94, 0.64, 0.32, 1],
  ],
});
const elbow: RouteStrategy = {
  route: ({ endpoints }) =>
    endpoints
      .slice(1)
      .map((to) => [
        endpoints[0].position,
        [to.position[0], endpoints[0].position[1]],
        to.position,
      ]),
};
export const theme: Options = {
  backgroundColor: [0.047, 0.063, 0.082, 1],
  componentBaseColor: [0.1, 0.13, 0.17, 1],
  connectionBaseColor: [0.46, 0.57, 0.65, 1],
  outlineColor: [0.34, 0.43, 0.5, 1],
  textColor: [0.91, 0.94, 0.96, 1],
  gridColor: [0.35, 0.43, 0.52, 0.26],
  groupColor: [0.24, 0.36, 0.4, 0.1],
  hoverColor: [0.96, 0.66, 0.44, 1],
  selectedColor: [0.94, 0.47, 0.35, 1],
  fontSizePx: 14,
  nodePadding: 16,
  portSpacing: 30,
  routeClearance: 20,
  fitPaddingPx: 44,
  msaa: 4,
};
export function data(source: GraphSource, settings: Settings, automatic = false): DiagramData {
  return {
    source,
    components: Object.fromEntries(
      types.map((type) => [
        type,
        {
          ...(!automatic ? { position: 'position' } : {}),
          shape: settings.shape === 'mixed' ? shapes[type] : settings.shape,
          labels: { field: 'name', size: 14, maxWidth: 180, overflow: 'wrap' },
          visible: 'visible',
          shade: 'signal',
          color:
            settings.palette === 'neutral'
              ? null
              : {
                  field: 'signal',
                  domain: [0, 1],
                  colormap: settings.palette === 'signal' ? signalMap : thermalMap,
                },
          status: settings.status ? { field: 'status', domain: [0, 1], colormap: statusMap } : null,
          ports:
            type === 'Control' ? { feedback: { side: 'bottom', label: 'feedback' } } : undefined,
        },
      ]),
    ),
    connections: {
      Signal: {
        route: settings.route === 'elbow' ? elbow : settings.route,
        appearance: settings.appearance,
        labels: { field: 'name', size: 12, maxWidth: 140, overflow: 'ellipsis' },
        arrows: settings.arrows ? ['target'] : [],
        flow: settings.flow ? { field: 'signal', domain: [0, 1], range: [20, 48] } : null,
        width: { field: 'signal', domain: [0, 1], range: [1.5, 2.5] },
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
