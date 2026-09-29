import { normalizeDomain } from '@latkit/model';
import { bakeColormap, type RenderTarget, type SceneRenderer } from '@latkit/gpu';
import { resolveOptions } from './options.js';
import { Lane } from './lane.js';
import { LanePainter } from './painter.js';
import { position } from './position.js';
import type { Scene } from './snapshot.js';

/** Render a monitor's history once and advance its playhead without rereading that history. */
export function createMonitorRenderer(target: RenderTarget, scene: Scene): SceneRenderer {
  if (scene.series.state.frameCount === 0)
    throw new RangeError('Cannot render an empty monitor series');
  const options = resolveOptions(scene.options ?? {});
  const scale =
    scene.viewport && scene.viewport[0] > 0 && scene.viewport[1] > 0
      ? Math.min(target.width / scene.viewport[0], target.height / scene.viewport[1])
      : 1;
  const painter = new LanePainter(target, target.width, target.height);
  painter.writeColormap(scene.colormap ?? bakeColormap(options.colormap));
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void ready.catch(() => undefined);
  let dead = false,
    queued = false,
    started = false,
    prepared = false;
  const lane = new Lane(
    scene.series,
    scene.signal,
    painter,
    {
      timeRange: options.timeRange,
      valueRange: options.valueRange,
      colorRange: options.colorRange,
      lineWidth: options.lineWidthPx * scale,
      focusColor: options.focusColor,
      unselectedAlpha: options.unselectedAlpha,
    },
    { frames: 0, range: null, domain: null },
    {
      error: reject,
      range: () => {},
      rendered: resolve,
      present() {
        if (queued || dead) return;
        queued = true;
        queueMicrotask(() => {
          queued = false;
          if (!dead) lane.frame(true);
        });
      },
    },
  );
  lane.select(scene.selected ?? null);
  let time = 0;
  const range = normalizeDomain(options.timeRange ?? scene.series.state.timeRange);
  return {
    async prepare(next, signal) {
      signal.throwIfAborted();
      if (!started) {
        started = true;
        lane.resume();
      }
      if (!prepared) {
        await new Promise<void>((resolve, reject) => {
          const aborted = (): void =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException('Monitor preparation aborted', 'AbortError'),
            );
          signal.addEventListener('abort', aborted, { once: true });
          void ready
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', aborted));
        });
        signal.throwIfAborted();
        prepared = true;
      }
      time = next;
    },
    draw() {
      painter.present(
        scene.selected == null ? 1 : options.unselectedAlpha,
        null,
        null,
        scene.cursor === false ? null : position(time, range),
      );
    },
    destroy() {
      dead = true;
      lane.destroy();
      painter.destroy();
      reject(new DOMException('Monitor renderer closed', 'AbortError'));
    },
  };
}
