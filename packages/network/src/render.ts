import { createChannels, type RenderTarget, type SceneRenderer } from '@latkit/gpu';
import { prepareTopology, encodeTopology } from './topology/index.js';
import { finiteBounds } from './topology/pack.js';
import { encodeSegments } from './segments/index.js';
import { prepareScene } from './scene.js';
import { Renderer } from './webgpu/renderer.js';
import {
  createUniforms,
  DISPLAY_DAYLIGHT,
  DISPLAY_EDGE_BASE_COLOR,
  DISPLAY_GEOGRAPHIC,
  DISPLAY_GRATICULE,
  DISPLAY_VERTICES,
} from './webgpu/uniforms.js';
import { CameraRig } from './camera/rig.js';
import { CHANNELS, channelRecord, initialDomain, type Channel } from './channels.js';
import { PROJECTION_DEFS, isGeographicTopology } from './projections.js';
import { resolveOptions } from './options.js';
import { VISUAL } from './visual.js';
import { createDaylight } from './daylight.js';
import { FocusState } from './focus-state.js';
import { TILT_PX_PER_MS, GLOBE_DEG_PER_MS } from './orbit.js';
import type { Scene } from './snapshot.js';

/** Render a captured network to a borrowed GPU target without input, DOM, or a display clock. */
export async function createNetworkRenderer(
  target: RenderTarget,
  scene: Scene,
): Promise<SceneRenderer> {
  const options = resolveOptions(scene.options ?? {});
  const uniforms = createUniforms();
  const rig = new CameraRig(uniforms.camera);
  rig.animationMs = 0;
  const prepared = prepareTopology(scene.topology);
  const geometry = prepareScene(encodeTopology(prepared), encodeSegments(prepared));
  const renderer = new Renderer(target, options.msaa, scene.shade?.wgsl);
  const channels = createChannels<Channel, 'vertex' | 'edge'>({
    name: 'network',
    structure: 'topology',
    channels: CHANNELS,
    store: () => renderer,
    record: channelRecord(uniforms, {
      dashPeriodPx: () => options.dashPeriodPx,
      heightRange: () => options.heightRange,
      sizeRange: () => options.sizeRange,
    }),
    shown: () => {},
    error: () => {},
    initialDomain,
  });
  try {
    const { info } = geometry;
    const counts = { vertex: info.vertexCount, edge: info.edgeCount };
    renderer.bindTopology(geometry, channels.measure(counts));
    channels.load(counts);
    channels.set('vertexPosition', geometry.coords);
    for (const name of Object.keys(scene.channels ?? {}) as Channel[]) {
      const binding = scene.channels![name]!;
      channels.set(name, binding.values, binding.domain);
    }
    const scale =
      scene.viewport && scene.viewport[0] > 0 && scene.viewport[1] > 0
        ? Math.min(target.width / scene.viewport[0], target.height / scene.viewport[1])
        : 1;
    const vp = { w: target.width / scale, h: target.height / scale };
    const geographic = isGeographicTopology(scene.topology, info.bounds);
    const projection = scene.camera?.projection ?? 'flat';
    if (!PROJECTION_DEFS[projection].canUse(info.bounds, info.characteristicLength, geographic))
      throw new RangeError(`The scene cannot use the ${projection} projection`);
    rig.setFitOptions({
      paddingPx: options.fitPaddingPx,
      pitch: options.fitPitch,
      bearing: options.fitBearing,
    });
    const positions = scene.channels?.vertexPosition?.values;
    const bounds =
      positions && !('series' in positions) && PROJECTION_DEFS[projection].livePositions
        ? finiteBounds(channels.values('vertexPosition')!)
        : info.bounds;
    rig.setBounds(bounds, true);
    rig.switchTo(projection, vp);
    if (scene.camera && !scene.camera.fit) rig.place(scene.camera, scene.camera.scale, vp, false);
    rig.tick(0, vp);
    let initial = rig.capture(vp);
    let fitFirstFrame =
      !!positions &&
      'series' in positions &&
      scene.camera?.fit !== false &&
      PROJECTION_DEFS[projection].livePositions;
    renderer.useProjection(projection);
    let failure: Error | undefined;
    renderer.onPipelineError = (_family, error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    };
    await renderer.warmProjection(projection);
    if (failure) throw failure;
    if (scene.colormap) renderer.writeColormap(scene.colormap);
    renderer.setBorders(scene.borders ?? null);
    renderer.setPasses({
      vertices: options.vertices,
      edges: options.edges,
      poles: options.poles,
      borders: options.borders && geographic,
      earthAxis: options.earthAxis,
    });
    uniforms.vBaseColor.set(options.vertexBaseColor);
    if (options.edgeBaseColor) uniforms.eBaseColor.set(options.edgeBaseColor);
    uniforms.graticuleColor.set(options.graticuleColor);
    uniforms.surfaceColor.set(options.surfaceColor);
    uniforms.borderColor.set(options.borderColor);
    uniforms.display.flags =
      (options.daylight && geographic ? DISPLAY_DAYLIGHT : 0) |
      (options.graticule ? DISPLAY_GRATICULE : 0) |
      (geographic ? DISPLAY_GEOGRAPHIC : 0) |
      (options.edgeBaseColor ? DISPLAY_EDGE_BASE_COLOR : 0) |
      (options.vertices ? DISPLAY_VERTICES : 0);
    uniforms.light.nightFloor = options.nightFloor;
    uniforms.light.surfaceNightFloor = options.surfaceNightFloor;
    uniforms.light.terminatorWidth = options.terminatorWidth;
    createDaylight(uniforms.light).refresh(options.sunTime ?? Date.now(), true);
    const radius = info.characteristicLength * VISUAL.vertexRadiusFraction * options.vertexScale;
    uniforms.geometry.vRadius = radius;
    uniforms.geometry.eHalfWidth =
      info.characteristicLength * VISUAL.edgeHalfWidthFraction * options.edgeScale;
    uniforms.geometry.heightAmplitude =
      PROJECTION_DEFS[projection].heightAmplitude(info.bounds, vp, radius) * options.heightScale;
    uniforms.frame.viewportX = target.width;
    uniforms.frame.viewportY = target.height;
    uniforms.frame.backingScale = scale;
    if (scene.shade) uniforms.host.set(scene.shade.uniforms);
    const focus = new FocusState(
      uniforms,
      (edge) => [scene.topology.edges[edge * 2]!, scene.topology.edges[edge * 2 + 1]!],
      {
        enabled: options.focusEnabled,
        hoverColor: options.hoverColor,
        selectedColor: options.selectedColor,
        hoverAlpha: options.hoverAlpha,
        selectedAlpha: options.selectedAlpha,
        vertexHoverPx: options.vertexHoverPx,
        vertexSelectedPx: options.vertexSelectedPx,
        edgeHoverPx: options.edgeHoverPx,
        edgeSelectedPx: options.edgeSelectedPx,
        endpointMode: options.focusEndpointMode,
      },
    );
    if (scene.selected) focus.select(scene.selected.kind, scene.selected.index);
    return {
      async prepare(time, signal) {
        await channels.prepare(time, signal);
        if (fitFirstFrame) {
          fitFirstFrame = false;
          rig.setBounds(finiteBounds(channels.values('vertexPosition')!), true);
          rig.tick(0, vp);
          initial = rig.capture(vp);
        }
      },
      draw(timeMs) {
        if (scene.orbit && initial) {
          const elapsed = timeMs * options.orbitRate;
          rig.place(initial.pose, initial.px, vp, false);
          if (projection === 'globe')
            rig.camera.setPose(
              { centerX: initial.pose.centerX + elapsed * GLOBE_DEG_PER_MS },
              false,
            );
          else rig.camera.rotateBy(elapsed * TILT_PX_PER_MS, 0, vp);
        }
        rig.tick(timeMs, vp);
        if (!renderer.render(uniforms))
          throw new Error('The network did not render its prepared frame');
      },
      destroy() {
        channels.load(null);
        renderer.destroy();
      },
    };
  } catch (error) {
    channels.load(null);
    renderer.destroy();
    throw error;
  }
}
