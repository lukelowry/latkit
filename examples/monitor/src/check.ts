import { read } from '@latkit/model';
import { createGpu, kit } from '@latkit/gpu';
import { createMonitor } from '@latkit/monitor';
import { Telemetry } from './source.js';
const result = document.querySelector<HTMLPreElement>('#result')!;
const run = document.querySelector<HTMLButtonElement>('#run')!;
run.onclick = () => void check();
async function check(): Promise<void> {
  run.disabled = true;
  result.textContent = 'Checking short and long histories?';
  const report: unknown[] = [];
  let gpu: Awaited<ReturnType<typeof createGpu>> | undefined;
  let target: ReturnType<typeof kit.createTextureTarget> | undefined;
  const errors: string[] = [];
  try {
    gpu = await createGpu();
    target = kit.createTextureTarget(gpu, { width: 1000, height: 600 });
    gpu.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const owner = gpu,
      output = target;
    for (const frames of [90, 900]) {
      const source = new Telemetry(['value'], 192, 0.1);
      const values = (frame: number) =>
        Float64Array.from({ length: 192 }, (_, row) => Math.sin(frame * 0.02 + row * 0.1));
      for (let f = 0; f < frames; f++) source.append(values(f));
      const monitor = createMonitor(gpu, {
        source: source.data,
        traces: {
          value: {
            from: 'sensor',
            field: 'value',
            color: { field: 'value', domain: [-1, 1], colormap: 'viridis' },
          },
        },
        camera: { window: [0, 100], values: [-1.1, 1.1] },
      });
      const renderer = kit.rendererOf(monitor);
      try {
        const render = async () => {
          const begin = performance.now();
          await owner.render({
            completion: 'complete',
            views: [{ renderer, target: output }],
            timeMs: 0,
          });
          await owner.idle();
          return performance.now() - begin;
        };
        const initialMs = await render();
        const appendMs: number[] = [];
        for (let f = 0; f < 8; f++) {
          source.append(values(frames + f));
          monitor.set({ source: source.data });
          appendMs.push(await render());
        }
        monitor.select([{ source: source.data, index: source.index, row: 42, trace: 'value' }]);
        const focusMs = await render();
        const focusedAppendMs: number[] = [];
        for (let f = 8; f < 16; f++) {
          source.append(values(frames + f));
          monitor.set({ source: source.data });
          focusedAppendMs.push(await render());
        }
        let blocks = 0;
        for await (const block of read(source.data, {
          kind: 'samples',
          from: 'sensor',
          select: ['value'],
          window: { kind: 'frames', offset: 0, count: frames + 16 },
        }))
          if (block.kind === 'samples') blocks++;
        const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
        report.push({
          frames,
          rows: 192,
          blocks,
          initialMs,
          appendMeanMs: mean(appendMs),
          focusMs,
          focusedAppendMeanMs: mean(focusedAppendMs),
          stats: monitor.stats(),
        });
        result.textContent = JSON.stringify({ report, errors }, null, 2);
      } finally {
        monitor.destroy();
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    document.body.dataset.result = 'passed';
  } catch (error) {
    document.body.dataset.result = 'failed';
    result.textContent += '\n' + String(error);
    console.error(error);
  } finally {
    target?.destroy();
    gpu?.destroy();
    run.disabled = false;
  }
}
