import { createComposition, type Gpu } from '@latkit/gpu';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
import { makeFakeNetwork } from '../../network/src/fake-network.js';
import { Telemetry } from '../../monitor/src/source.js';
export type ExampleView = 'network' | 'monitor' | 'combined';
/** App-owned construction runs identically in a worker or the window. */
export function scene(gpu: Gpu, kind: ExampleView) {
  const live = new Telemetry(['response'], 48, 1 / 60);
  for (let frame = 0; frame <= 360; frame++)
    live.append(
      Float64Array.from(
        { length: 48 },
        (_, row) => Math.sin(frame * 0.035 + row * 0.16) * (0.4 + row / 100),
      ),
    );
  const samples = live.data;
  const geometry = makeFakeNetwork();
  const monitor = createMonitor(gpu, {
    source: samples,
    traces: {
      response: {
        from: 'sensor',
        y: 'response',
        color: { field: 'response', domain: [-1, 1], colormap: 'turbo' },
      },
    },
    camera: { window: [0, 6], values: [-1, 1] },
    coordinateAxis: 'Time (s)',
    valueAxis: 'Response',
  });
  const network = createNetwork(gpu, {
    source: geometry.data,
    vertices: {
      Bus: {
        x: 'position',
        y: { field: 'position', component: 1 },
        color: { field: 'load', domain: [0, 1], colormap: 'turbo' },
      },
    },
    edges: {
      Line: {
        ends: ['from', 'to'],
        bends: 'bends',
        route: 'geodesic',
      },
    },
    poles: false,
    daylight: false,
    shade: {
      wgsl: `fn shade(f: ShadeFragment) -> vec4f {
      let wave = 0.65 + 0.35 * sin(shadeContext.pointer.w * 0.003 + f.px.x * 0.015);
      return vec4f(f.color.rgb * wave, f.color.a);
    }`,
      tick: () => true,
    },
  });
  const composition =
    kind === 'combined'
      ? createComposition(gpu, {
          views: [
            { view: network, region: [0, 0, 1, 0.55] },
            { view: monitor, region: [0, 0.55, 1, 0.45] },
          ],
        })
      : undefined;
  return {
    view: composition ?? (kind === 'monitor' ? monitor : network),
    close() {
      composition?.destroy();
      network.destroy();
      monitor.destroy();
    },
  };
}
