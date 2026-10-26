import type { ImageFormat } from 'latkit';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** Length of a recorded video, in seconds. */
const SECONDS = 6;
/** Video frame rate, in frames per second. */
const FPS = 30;
/** Each picture format's file extension, MIME type, and whether it keeps alpha. */
const FORMATS: Record<ImageFormat, { extension: string; type: string; alpha: boolean }> = {
  png: { extension: 'png', type: 'image/png', alpha: true },
  jpeg: { extension: 'jpg', type: 'image/jpeg', alpha: false },
  webp: { extension: 'webp', type: 'image/webp', alpha: true },
};

/**
 * Adds the Export section every page gets, for the page's first canvas. A picture captures the
 * canvas as it is now and is encoded in a worker as PNG, JPEG, or WebP, optionally with a
 * transparent background. A video records the canvas as MP4 while the page runs, showing its
 * progress. Pressing Record again stops it.
 */
export function exportSection(stage: Stage): void {
  const [canvas] = stage.canvases;
  if (!canvas) return;
  const section = stage.section('Export', false);
  let format: ImageFormat = 'png';
  /** JPEG quality, from 1 to 100. */
  let quality = 90;
  let transparent = false;
  /** Video bits per pixel per frame. When unset, the default of about 0.15 applies. */
  let bits: number | undefined;
  let recording: AbortController | undefined;
  /** Saved pixels per CSS pixel: the screen's device pixel ratio, capped at 2. */
  const scale = () => Math.min(2, devicePixelRatio);
  const picture = async () => {
    status.textContent = 'Taking a picture…';
    const { extension, type, alpha } = FORMATS[format];
    // `capture: 'now'` pictures this moment while the page keeps running, instead of waiting for
    // motion to settle.
    const shot = canvas.shot({ scale: scale(), transparent: transparent && alpha, capture: 'now' });
    const image = await shot.image();
    try {
      const file = await image.encode(format, { quality });
      const name = `views.${extension}`;
      save(name, new Blob([file.slice()], { type }));
      status.textContent = `Saved ${name}, ${image.width}×${image.height}, ${kilobytes(file.length)}`;
    } finally {
      image.destroy();
    }
  };
  const video = async () => {
    if (recording) return recording.abort(new Error('stopped'));
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const output = new WritableStream<Uint8Array>({
      write: (chunk) => void chunks.push(chunk.slice()),
    });
    recording = new AbortController();
    const shot = canvas.shot({ scale: scale() });
    const bitrate = bits && Math.round(shot.size[0] * shot.size[1] * FPS * bits);
    const started = performance.now();
    try {
      const recorder = shot.video({
        fps: FPS,
        output,
        signal: recording.signal,
        ...(bitrate ? { bitrate } : {}),
      });
      // Each frame waits until the page reaches that frame's time, so the video plays at the
      // page's real speed.
      await recorder.record(
        async (time) => {
          while (performance.now() - started < time * 1000) await nextFrame();
          return time < SECONDS;
        },
        ({ time }) =>
          (status.textContent = `Recording ${time.toFixed(1)} of ${SECONDS} s; V stops`),
      );
      const file = new Blob(chunks, { type: 'video/mp4' });
      save('views.mp4', file);
      status.textContent = `Saved views.mp4, ${SECONDS} s, ${kilobytes(file.size)}`;
    } catch (error) {
      status.textContent = recording.signal.aborted
        ? 'Stopped'
        : `Could not record: ${String(error)}`;
    } finally {
      recording = undefined;
    }
  };
  const failing = (run: () => Promise<void>) => () =>
    void run().catch(
      (error: unknown) => (status.textContent = `Could not export: ${String(error)}`),
    );
  section.actions([
    { label: 'Save picture', key: 'x', run: failing(picture) },
    { label: 'Record', key: 'v', run: failing(video) },
  ]);
  const status = section.note();
  status.setAttribute('role', 'status');
  const quality_ = section.range(
    'Quality',
    { min: 50, max: 100, step: 5, value: quality, format: String },
    (q) => (quality = q),
  );
  quality_.disabled = true;
  const clear = section.toggle('Transparent', undefined, transparent, (on) => (transparent = on));
  section.choice(
    'Format',
    [
      ['PNG', 'png'],
      ['JPEG', 'jpeg'],
      ['WebP', 'webp'],
    ] as const,
    format,
    (next) => {
      format = next;
      // PNG and WebP are lossless. JPEG trades detail for size and has no alpha.
      quality_.disabled = next !== 'jpeg';
      if (!FORMATS[next].alpha && transparent) clear(false);
    },
  );
  section.choice(
    'Video',
    [
      ['Standard', undefined],
      ['Sharp', 0.4],
      ['Small', 0.06],
    ] as const,
    bits,
    (next) => (bits = next),
  );
}

/** Saves `file` as a download named `name`. */
function save(name: string, file: Blob): void {
  const url = URL.createObjectURL(file);
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} kB`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
