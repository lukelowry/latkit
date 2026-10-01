import { bakeColormap, createChannels, type RenderTarget, type SceneRenderer } from '@latkit/gpu';
import { CameraRig } from './camera.js';
import { channelRecord, SLOTTED, type Channel, type Scope, type SlotChannel } from './channels.js';
import { Focus } from './focus.js';
import { resolveOptions, validateOptions } from './options.js';
import { idOf } from './part.js';
import { Scene as LayoutScene } from './scene.js';
import type { Scene } from './snapshot.js';
import { GlyphAtlas } from '@latkit/gpu';
import { Labels } from './text/labels.js';
import { createMirrors } from './webgpu/buffers.js';
import { Renderer } from './webgpu/renderer.js';
import {
  createUniforms,
  DISPLAY_ARROWS,
  DISPLAY_GRID,
  DISPLAY_JUNCTIONS,
  DISPLAY_LABELS,
  DISPLAY_REDUCED,
} from './webgpu/uniforms.js';

/** Render a diagram scene to an owned GPU target, without a DOM or animation loop. */
export async function createDiagramRenderer(
  target: RenderTarget,
  snapshot: Scene,
): Promise<SceneRenderer> {
  validateOptions(snapshot.options ?? {});
  const opts = resolveOptions(snapshot.options ?? {});
  const mirrors = createMirrors();
  const uniforms = createUniforms(mirrors.uniforms);
  const channels = createChannels<SlotChannel, Scope>({
    name: 'diagram',
    structure: 'netlist',
    channels: SLOTTED,
    store: () => mirrors.channels,
    record: channelRecord(uniforms),
    shown() {},
    error() {},
  });
  const scene = new LayoutScene(mirrors, channels);
  const renderer = new Renderer(target, mirrors, snapshot.shade?.wgsl ?? null);
  try {
    scene.setRouting(opts.routing);
    scene.load(snapshot.netlist, opts.gridPitch, false, 0);
    for (const [name, binding] of Object.entries(snapshot.channels ?? {})) {
      const channel = name as Channel;
      if (channel === 'blockPosition') {
        if ('series' in binding.values)
          throw new TypeError('Diagram positions cannot follow a series');
        scene.place(binding.values);
        scene.placementChanged();
      } else {
        channels.set(channel, binding.values, binding.domain);
      }
    }
    scene.visibilityChanged();
    const prepared = scene.prepared!;
    const focus = new Focus(mirrors.focus);
    focus.reset(prepared);
    focus.select((snapshot.selected ?? []).map(idOf));
    const atlas = snapshot.glyphs
      ? GlyphAtlas.from(snapshot.glyphs)
      : new GlyphAtlas(opts.fontFamily);
    const labels = new Labels(mirrors.glyphs, atlas);
    labels.reset(prepared);
    const camera = new CameraRig();
    const scale =
      snapshot.viewport && snapshot.viewport[0] > 0 && snapshot.viewport[1] > 0
        ? Math.min(target.width / snapshot.viewport[0], target.height / snapshot.viewport[1])
        : 1;
    const viewport = { w: target.width / scale, h: target.height / scale };
    camera.setPadding(opts.fitPaddingPx);
    camera.setBounds(scene.bounds(), snapshot.camera?.fit ?? true);
    if (snapshot.camera && !snapshot.camera.fit)
      camera.setPose({ ...snapshot.camera, zoom: snapshot.camera.scale }, false, 0);
    uniforms.setColors(opts);
    uniforms.setCounts(prepared);
    uniforms.setPointer(null);
    uniforms.flags =
      (opts.grid ? DISPLAY_GRID : 0) |
      (opts.arrows ? DISPLAY_ARROWS : 0) |
      (opts.junctions ? DISPLAY_JUNCTIONS : 0) |
      (opts.labels ? DISPLAY_LABELS : 0) |
      (opts.motion === 'reduce' ? DISPLAY_REDUCED : 0);
    uniforms.gridPitch = prepared.metrics.grid;
    uniforms.flowRate = opts.flowRate;
    if (snapshot.shade) uniforms.host.set(snapshot.shade.uniforms);
    renderer.writeColormap(snapshot.colormap ?? bakeColormap(opts.colormap));
    await renderer.setShade(snapshot.shade?.wgsl ?? null);
    return {
      prepare: (time, signal) => channels.prepare(time, signal),
      draw(timeMs) {
        camera.tick(timeMs, viewport);
        scene.tick(timeMs);
        const pose = camera.pose;
        uniforms.setFrame(viewport.w, viewport.h, scale, timeMs);
        uniforms.setCamera(pose.centerX, pose.centerY, pose.zoom);
        const glyphs = labels.update(
          camera.view(viewport),
          pose.zoom,
          mirrors.layout,
          opts.labels,
          false,
        );
        uniforms.setAtlas(atlas);
        if (
          !renderer.render(
            {
              groups: prepared.groupCount,
              wires: scene.routes.capacity,
              blocks: prepared.blockCount,
              ports: prepared.portCount,
              glyphs,
              overlay: 0,
            },
            atlas,
          )
        ) {
          throw new Error('Diagram pipeline is not ready');
        }
      },
      destroy() {
        scene.clear();
        renderer.destroy();
      },
    };
  } catch (error) {
    scene.clear();
    renderer.destroy();
    throw error;
  }
}
