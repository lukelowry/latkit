import { createComposition, colormaps, type Gpu } from '@latkit/gpu';
import { createMonitor } from '@latkit/monitor';
import { createNetwork } from '@latkit/network';
import { makeFakeNetwork } from '../../network/src/fake-network.js';
import { Telemetry } from '../../monitor/src/source.js';
export type ExampleView = 'network' | 'monitor' | 'combined';
/** App-owned construction runs identically in a worker or the window. */
export async function scene(gpu: Gpu, kind: ExampleView) {
  const live = new Telemetry(['response'], 48, 1 / 60);
  for (let frame = 0; frame <= 360; frame++)
    live.append(
      Float64Array.from(
        { length: 48 },
        (_, row) => Math.sin(frame * 0.035 + row * 0.16) * (0.4 + row / 100),
      ),
    );
  const samples = await live.retain();
  await live.close();
  const geometry = makeFakeNetwork();
  const monitor = createMonitor({
    gpu,
    data: {
      source: samples,
      window: { kind: 'range', between: [0, 6] },
      traces: {
        response: {
          from: 'sensor',
          field: 'response',
          color: { field: 'response', domain: [-1, 1], colormap: colormaps.turbo },
        },
      },
    },
    options: {
      valueDomain: [-1, 1],
      coordinateAxis: { label: 'Time (s)' },
      valueAxis: { label: 'Response' },
    },
  });
  const network = createNetwork({
    gpu,
    data: {
      source: geometry,
      coordinates: 'geographic',
      vertices: {
        node: {
          position: 'position',
          color: { field: 'load', domain: [0, 1], colormap: colormaps.turbo },
        },
      },
      edges: {
        line: {
          connectivity: { kind: 'endpoints', layout: 'pair' },
          bends: 'bends',
          curve: 'geodesic',
        },
      },
    },
    options: { poles: false, daylight: false },
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
      ? createComposition({
          gpu,
          views: [
            { renderer: network, region: { x: 0, y: 0, width: 1, height: 0.55 } },
            { renderer: monitor, region: { x: 0, y: 0.55, width: 1, height: 0.45 } },
          ],
        })
      : undefined;
  return {
    renderer: composition ?? (kind === 'monitor' ? monitor : network),
    async close() {
      composition?.destroy();
      network.destroy();
      monitor.destroy();
      await samples.close();
      await geometry.close();
    },
  };
}
