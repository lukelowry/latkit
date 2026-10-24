import type { View } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

const MB = 1 << 20;

/**
 * A readout over a view: frames per second, the view's frame time on the CPU and the GPU, draws,
 * instances, and tiles, what it waits on, the GPU's memory, and the page's own measures; and how
 * much memory and upload the GPU may take, which the page gives back when it closes.
 */
export class Meter {
  readonly #line = h('p', { class: 'meter', 'aria-live': 'off' });
  readonly #times = new Map<string, number>();
  readonly #notes: (() => string)[] = [];
  #frames = 0;
  #since = performance.now();
  /** What the view waits on, as it last told. */
  #waiting: string[] = [];

  constructor(stage: Stage, view: View) {
    const section = stage.section('Performance', false);
    section.element.classList.add('performance');
    section.content.append(this.#line);
    const { gpu } = stage;
    const given = gpu.budget;
    stage.signal.addEventListener('abort', () => (gpu.budget = given));
    section.choice(
      'Memory',
      [
        ['Default', given.bytes],
        ['256 MB', 256 * MB],
        ['64 MB', 64 * MB],
        ['16 MB', 16 * MB],
      ] as const,
      given.bytes,
      (bytes) => (gpu.budget = { ...gpu.budget, bytes }),
    );
    section.choice(
      'Upload',
      [
        ['Default', given.uploadPerFrame],
        ['4 MB a frame', 4 * MB],
        ['1 MB a frame', MB],
        ['256 kB a frame', MB / 4],
      ] as const,
      given.uploadPerFrame,
      (uploadPerFrame) => (gpu.budget = { ...gpu.budget, uploadPerFrame }),
    );
    view.on('waiting', (waiting) => (this.#waiting = waiting));
    stage.frame(() => {
      this.#frames++;
      const now = performance.now();
      if (now - this.#since < 500) return;
      const stats = view.stats;
      const parts = [
        `${((this.#frames * 1000) / (now - this.#since)).toFixed(0)} fps`,
        `frame ${stats.cpuMs.toFixed(1)} ms${stats.gpuMs ? ` · GPU ${stats.gpuMs.toFixed(2)} ms` : ''}`,
        `${stats.draws} draws · ${stats.instances.toLocaleString()} instances`,
        `${(gpu.resident / MB).toFixed(0)} of ${(gpu.budget.bytes / MB).toFixed(0)} MB on the GPU` +
          (gpu.uploading ? ` · ${(gpu.uploading / MB).toFixed(1)} MB to upload` : ''),
      ];
      if (stats.tiles || stats.tilesLoading) {
        parts.push(
          `${stats.tiles} tiles${stats.tilesLoading ? ` (${stats.tilesLoading} loading)` : ''}`,
        );
      }
      if (this.#waiting.length) parts.push(`waiting on ${this.#waiting.join(', ')}`);
      const failures = view.failures;
      if (failures.length)
        parts.push(`${failures.length} marks draw nothing: ${failures[0]!.message}`);
      for (const [label, ms] of this.#times) parts.push(`${label} ${ms.toFixed(1)} ms`);
      this.#line.textContent = [...parts, ...this.#notes.map((note) => note())].join('\n');
      this.#frames = 0;
      this.#since = now;
    });
  }

  /** Runs `work`, keeping a moving average of its time under `label`. */
  measure<T>(label: string, work: () => T): T {
    const start = performance.now();
    const result = work();
    const ms = performance.now() - start;
    this.#times.set(label, (this.#times.get(label) ?? ms) * 0.9 + ms * 0.1);
    return result;
  }

  /** A readout computed at each refresh. */
  note(read: () => string): void {
    this.#notes.push(read);
  }
}
