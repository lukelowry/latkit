import { Shot, type ImageFormat, type View } from '../latkit.js';
import { h } from './dom.js';
import type { Stage } from './stage.js';

/** Seconds of video a recording takes. */
const SECONDS = 6;
/** Frames a second of video. */
const FPS = 30;
/** Each picture format: its file's extension and type, and whether it keeps alpha. */
const FORMATS: Record<ImageFormat, { extension: string; type: string; alpha: boolean }> = {
  png: { extension: 'png', type: 'image/png', alpha: true },
  jpeg: { extension: 'jpg', type: 'image/jpeg', alpha: false },
  webp: { extension: 'webp', type: 'image/webp', alpha: true },
};

/**
 * The Export section every page gets: a picture of its views laid out as the page shows them,
 * written as PNG, JPEG, or WebP in a worker, clear where the theme's background is when asked; and a
 * video of them as MP4, recorded as the page runs, with its progress, stopped by pressing again.
 */
export function exportSection(stage: Stage): void {
  if (!stage.shown.length) return;
  const section = stage.section('Export', false);
  let format: ImageFormat = 'png';
  /** JPEG's quality, 1 to 100. */
  let quality = 90;
  let transparent = false;
  /** Bits a pixel a frame of video: about 0.15 unless set. */
  let bits: number | undefined;
  let recording: AbortController | undefined;
  /** The views, and a shot of them laid out as the page shows them, `align` pixels a block. */
  const shot = (align: [number, number]): [Shot, View[]] => {
    const shown = stage.shown
      .map(({ view, element, panel: [x, y, w, h] }) => {
        const canvas = element.getBoundingClientRect();
        const [left, top] = [canvas.left + x * canvas.width, canvas.top + y * canvas.height];
        const [width, height] = [w * canvas.width, h * canvas.height];
        return {
          view,
          box: { left, top, width, height, right: left + width, bottom: top + height },
        };
      })
      .filter(({ box }) => box.width > 0 && box.height > 0);
    const left = Math.min(...shown.map((s) => s.box.left));
    const top = Math.min(...shown.map((s) => s.box.top));
    const width = Math.max(...shown.map((s) => s.box.right)) - left;
    const height = Math.max(...shown.map((s) => s.box.bottom)) - top;
    const scale = Math.min(2, devicePixelRatio);
    const size: [number, number] = [
      Math.max(align[0], Math.floor((width * scale) / align[0]) * align[0]),
      Math.max(align[1], Math.floor((height * scale) / align[1]) * align[1]),
    ];
    const panels = shown.map(
      ({ box }) =>
        [
          (box.left - left) / width,
          (box.top - top) / height,
          box.width / width,
          box.height / height,
        ] as const,
    );
    return [new Shot(size).scale(size[0] / width).panels(panels), shown.map((s) => s.view)];
  };
  const picture = async () => {
    status.textContent = 'Taking a picture…';
    const { extension, type, alpha } = FORMATS[format];
    const [plain, views] = shot([1, 1]);
    const taken = transparent && alpha ? plain.transparent() : plain;
    // A picture waits for its views to be still; the page holds its own motion meanwhile.
    const image = await stage.hold(() => taken.image(views));
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
    const [taken, views] = shot([4, 2]);
    const bitrate = bits && Math.round(taken.size[0] * taken.size[1] * FPS * bits);
    const started = performance.now();
    try {
      const recorder = taken.video(stage.gpu, FPS, output, {
        signal: recording.signal,
        ...(bitrate ? { bitrate } : {}),
      });
      // Each frame waits for the page to reach its time, so the video runs as the page does.
      await recorder.record(
        views,
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
      // PNG and WebP are lossless; JPEG trades detail for size, and has no alpha.
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
