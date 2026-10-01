import type { ExportResult, WorkerReply } from './messages.js';
import { verify } from './checks.js';
import type { ExampleView } from './scene.js';
const status = document.querySelector<HTMLPreElement>('#status')!;
const button = document.querySelector<HTMLButtonElement>('#export')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const results = document.querySelector<HTMLElement>('#results')!;
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const urls: string[] = [],
  files: string[] = [];
let busy = false;
function exportOne(
  view: ExampleView,
  format: 'mp4' | 'webm',
  duration: number,
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    worker.onerror = (event) => reject(new Error(event.message));
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      if (message.kind === 'progress')
        status.textContent = `${view}: ${message.progress.completedFrames}/${message.progress.totalFrames} frames`;
      if (message.kind === 'error') reject(new Error(message.message));
      if (message.kind === 'done') resolve(message);
    };
    const filename = `latkit-video-${crypto.randomUUID()}.${format}`;
    files.push(filename);
    worker.postMessage({ kind: 'export', view, format, duration, filename });
  });
}
async function run() {
  if (busy) throw new Error('Already exporting');
  busy = true;
  button.disabled = true;
  cancel.disabled = false;
  const report = [];
  try {
    for (const [view, format] of [
      ['network', 'mp4'],
      ['monitor', 'webm'],
      ['combined', 'mp4'],
    ] as const) {
      const duration = 2;
      const message = await exportOne(view, format, duration);
      const directory = await navigator.storage.getDirectory();
      const blob = await (await directory.getFileHandle(message.filename)).getFile();
      const decoded = await verify(blob, 1280, 720, duration);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const article = document.createElement('article'),
        title = document.createElement('h2'),
        video = document.createElement('video'),
        link = document.createElement('a');
      title.textContent = `${view} / ${format}`;
      video.controls = true;
      video.loop = true;
      video.src = url;
      link.href = url;
      link.download = `${view}.${format}`;
      link.textContent = `Download - ${(blob.size / 1e6).toFixed(2)} MB - ${(Number(message.elapsedMs) / 1000).toFixed(2)}s export`;
      article.append(title, video, link);
      results.append(article);
      report.push({ ...message, decoded });
    }
    status.textContent = JSON.stringify(report, null, 2);
    return report;
  } catch (error) {
    status.textContent = String(error);
    throw error;
  } finally {
    busy = false;
    button.disabled = false;
    cancel.disabled = true;
  }
}
button.onclick = () => void run().catch(console.error);
cancel.onclick = () => worker.postMessage({ kind: 'cancel' });
window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  worker.terminate();
  for (const url of urls) URL.revokeObjectURL(url);
  void navigator.storage
    .getDirectory()
    .then((root) => Promise.all(files.map((file) => root.removeEntry(file).catch(() => {}))));
});
Object.assign(window, { videoProof: { run } });
