import { bakeColormap, type RenderTarget, type SceneRenderer } from '@latkit/gpu';
import { validateSeries } from '@latkit/model';
import { resolveOptions } from './options.js';
import { SHADE_HOST_WORDS } from './shade.js';
import { Plot } from './plot.js';
import type { Scene } from './snapshot.js';

/** Render the same plot as a live monitor, then advance its playhead without rereading history. */
export function createMonitorRenderer(target: RenderTarget, scene: Scene): SceneRenderer {
  validateSeries(scene.series);
  if (
    !Number.isInteger(scene.signal) ||
    scene.signal < 0 ||
    scene.signal >= scene.series.signals.length
  )
    throw new RangeError('Monitor scene signal is out of range');
  if (scene.series.state.frameCount === 0)
    throw new RangeError('Cannot render an empty monitor series');
  const options = resolveOptions(scene.options ?? {});
  const scale =
    scene.viewport && scene.viewport[0] > 0 && scene.viewport[1] > 0
      ? Math.min(target.width / scene.viewport[0], target.height / scene.viewport[1])
      : 1;
  const plot = new Plot(
    target,
    options,
    scene.colormap ?? bakeColormap(options.colormap),
    scale,
    { error: () => {}, range: () => {}, rendered: () => {}, present: () => {} },
    scene.glyphs,
  );
  try {
    plot.load(
      scene.series,
      scene.signal,
      { frames: 0, range: null, domain: null },
      scene.selected ?? null,
      false,
    );
  } catch (error) {
    plot.destroy();
    throw error;
  }
  const host = new Float32Array(SHADE_HOST_WORDS);
  if (scene.shade) {
    if (scene.shade.uniforms.length !== SHADE_HOST_WORDS) {
      plot.destroy();
      throw new RangeError('Monitor shade uniforms must contain 64 floats');
    }
    host.set(scene.shade.uniforms);
  }
  // Observe failures immediately; prepare reports them to the caller without an unhandled rejection.
  let failure: Error | null = null;
  let ready = false;
  const closed = new AbortController();
  const shadeReady = plot
    .setShade(scene.shade?.wgsl ?? null)
    .catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    })
    .then(() => {
      ready = true;
    });
  return {
    async prepare(time, signal) {
      if (!Number.isFinite(time)) throw new RangeError('Monitor source time must be finite');
      signal.throwIfAborted();
      closed.signal.throwIfAborted();
      if (!ready) {
        const waitSignal = AbortSignal.any([signal, closed.signal]);
        await new Promise<void>((resolve, reject) => {
          const abort = () =>
            reject(
              waitSignal.reason instanceof Error
                ? waitSignal.reason
                : new DOMException('Monitor preparation aborted', 'AbortError'),
            );
          waitSignal.addEventListener('abort', abort, { once: true });
          void shadeReady.then(() => {
            waitSignal.removeEventListener('abort', abort);
            resolve();
          });
          if (waitSignal.aborted) abort();
        });
      }
      signal.throwIfAborted();
      closed.signal.throwIfAborted();
      if (failure) throw failure;
      await plot.prepare(signal);
      signal.throwIfAborted();
      plot.seek(scene.cursor === false ? null : time);
    },
    draw: (timeMs) => plot.draw(timeMs, host),
    destroy: () => {
      closed.abort(new DOMException('Monitor closed', 'AbortError'));
      plot.destroy();
    },
  };
}
