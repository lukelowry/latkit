import { exportVideo, type Scene } from '@latkit/video';
import { colormap } from '@latkit/colormaps';
import { Series } from '@latkit/model';
import { createNetwork } from '@latkit/network';
import { createDiagram } from '@latkit/diagram';
import { createMonitor } from '@latkit/monitor';
import { makeFakeNetwork } from '../../network/src/fake-network.js';
import { TOPOLOGIES } from '../../network/src/topologies.js';
import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from 'mediabunny';

const status = document.querySelector<HTMLPreElement>('#status')!;
const source = document.querySelector<HTMLDivElement>('#source')!;
const results = document.querySelector<HTMLElement>('#results')!;
const button = document.querySelector<HTMLButtonElement>('#export')!;
const artifacts: {
  name: string;
  blob: Blob;
  url: string;
  width: number;
  height: number;
  duration: number;
  seconds: number;
}[] = [];
function canvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  source.append(c);
  return c;
}
function samples(elements: number, seconds = 6): Series {
  const time = Float64Array.from({ length: seconds * 60 + 1 }, (_, i) => i / 60);
  const values = Float32Array.from({ length: time.length * elements }, (_, i) => {
    const t = Math.floor(i / elements) / 60,
      element = i % elements;
    return 0.5 + 0.45 * Math.sin(t * 2.4 - element * 0.18) * Math.exp(-Math.max(0, t - 2) * 0.15);
  });
  const series = Series.create({ signals: ['response'], elementCount: elements });
  series.append({ time, values });
  series.seal();
  return series;
}
async function record(
  name: string,
  views: readonly Scene[],
  options: { width?: number; height?: number; format?: 'mp4' | 'webm'; stream?: boolean } = {},
): Promise<void> {
  status.textContent = `Exporting ${name}?`;
  const begin = performance.now();
  const config = {
    views,
    timeRange: [0, 6] as const,
    width: options.width ?? 1280,
    height: options.height ?? 720,
    frameRate: 30,
    quality: 'high' as const,
    format: options.format ?? 'mp4',
    onProgress: (p: { completedFrames: number; totalFrames: number }) => {
      status.textContent = `${name}: ${p.completedFrames}/${p.totalFrames} frames`;
    },
  };
  let blob: Blob;
  if (options.stream) {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(`${name}.mp4`, { create: true });
    await exportVideo({ ...config, output: await handle.createWritable() });
    blob = await handle.getFile();
  } else blob = await exportVideo(config);
  const seconds = (performance.now() - begin) / 1000;
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${name}: no video track`);
    const duration = await input.computeDuration();
    if (Math.abs(duration - 6) > 0.04) throw new Error(`${name}: invalid duration ${duration}`);
    if (track.displayWidth !== config.width || track.displayHeight !== config.height)
      throw new Error(`${name}: wrong video dimensions`);
    const sink = new VideoSampleSink(track);
    // Pixel readback is verification only; the exporter never reads video pixels into JavaScript.
    const decoded = new OffscreenCanvas(160, 90);
    const context = decoded.getContext('2d', { willReadFrequently: true })!;
    let first: Uint8ClampedArray | undefined;
    let changed = false;
    for (const time of [0, 2, 5.5]) {
      const sample = await sink.getSample(time);
      if (!sample) throw new Error(`${name}: undecodable frame at ${time}`);
      try {
        sample.draw(context, 0, 0, decoded.width, decoded.height);
        const pixels = context.getImageData(0, 0, decoded.width, decoded.height).data;
        let minimum = 255,
          maximum = 0,
          difference = 0;
        for (let i = 0; i < pixels.length; i++) {
          if (i % 4 === 3) continue;
          minimum = Math.min(minimum, pixels[i]!);
          maximum = Math.max(maximum, pixels[i]!);
          if (first) difference += Math.abs(pixels[i]! - first[i]!);
        }
        if (maximum - minimum < 20) throw new Error(`${name}: blank decoded frame at ${time}`);
        if (first) changed ||= difference / pixels.length > 0.02;
        else first = pixels;
      } finally {
        sample.close();
      }
    }
    if (!changed) throw new Error(`${name}: animation did not change decoded pixels`);
    const url = URL.createObjectURL(blob);
    artifacts.push({
      name,
      blob,
      url,
      width: track.displayWidth,
      height: track.displayHeight,
      duration,
      seconds,
    });
    const article = document.createElement('article');
    const heading = document.createElement('h2');
    heading.textContent = name;
    const video = document.createElement('video');
    video.controls = true;
    video.loop = true;
    video.src = url;
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.${config.format}`;
    link.textContent = `Download | ${track.displayWidth}x${track.displayHeight} | ${duration.toFixed(2)}s | ${(blob.size / 1e6).toFixed(2)} MB | exported in ${seconds.toFixed(2)}s`;
    article.append(heading, video, link);
    results.append(article);
  } finally {
    input.dispose();
  }
}
async function run(): Promise<void> {
  button.disabled = true;
  const f = makeFakeNetwork();
  const series = samples(f.vertexCount);
  const network = createNetwork({
    colormap: colormap('turbo'),
    daylight: false,
    vertexScale: 1.8,
    edgeScale: 1.4,
    borders: false,
  });
  const monitor = createMonitor({
    colormap: colormap('turbo'),
    timeRange: [0, 6],
    valueRange: [0, 1],
    lineWidthPx: 1.5,
  });
  const diagram = createDiagram({ colormap: colormap('turbo'), motion: 'full', flowRate: 2 });
  try {
    network.load(f.topology);
    network.setChannel('vertexColor', { series, signal: 0 }, [0, 1]);
    network.setChannel('vertexHeight', { series, signal: 0 }, [0, 1]);
    network.setChannel('vertexSize', f.degree);
    await network.attach(canvas());
    await network.paint();
    monitor.load({ series, signal: 0 });
    await monitor.attach(canvas());
    await record('network-signals', [network.snapshot()]);
    const world = TOPOLOGIES[1]!.build();
    network.load(world.topology);
    network.setChannel('vertexColor', { series: samples(world.vertexCount), signal: 0 }, [0, 1]);
    network.setOptions({ graticule: true, orbitRate: 2 });
    network.setCamera({ projection: 'globe', fit: true });
    network.orbit(true);
    await network.paint();
    await record('globe-orbit', [network.snapshot()]);
    network.orbit(false);
    network.load(f.topology);
    network.setChannel('vertexColor', { series, signal: 0 }, [0, 1]);
    network.setChannel('vertexHeight', { series, signal: 0 }, [0, 1]);
    network.setChannel('vertexSize', f.degree);
    network.setOptions({ graticule: false });
    network.setCamera({ projection: 'tilt', fit: true });
    await network.paint();
    await record('network-and-monitor', [network.snapshot(), monitor.snapshot()], {
      height: 1080,
      width: 1920,
      stream: true,
    });
    diagram.load({
      blockCount: 4,
      portStart: new Uint32Array([0, 1, 3, 5, 6]),
      portFlow: new Uint8Array([1, 0, 1, 0, 1, 0]),
      netStart: new Uint32Array([0, 2, 4, 6]),
      netPorts: new Uint32Array([0, 1, 2, 3, 4, 5]),
      blockTitle: ['Input', 'Controller', 'Plant', 'Output'],
      blockLabel: ['reference', 'PID', 'response', 'measurement'],
      portLabel: ['setpoint', 'error', 'command', 'drive', 'signal', 'sample'],
      netLabel: ['error', 'control', 'response'],
    });
    diagram.setChannel('netFlow', new Float32Array([1, 1, 1]));
    diagram.setChannel('blockColor', { series: samples(4), signal: 0 }, [0, 1]);
    await diagram.attach(canvas());
    await diagram.paint();
    await record('diagram-flow', [diagram.snapshot()]);
    await record('monitor-history', [monitor.snapshot()], { format: 'webm' });
    status.textContent = `Verified ${artifacts.length} videos: metadata and decoded samples at 0, 2, and 5.5 seconds.`;
  } catch (error) {
    status.textContent = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    network.destroy();
    monitor.destroy();
    diagram.destroy();
    button.disabled = false;
  }
}
button.addEventListener('click', () => {
  void run().catch(console.error);
});
Object.assign(window, { videoProof: { run, artifacts } });
