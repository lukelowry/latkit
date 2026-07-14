import { requestDevice } from '@latkit/gpu';
import { createMonitor, type Monitor, type Series } from '@latkit/monitor';
import { createNetwork, type Borders, type Network, type Topology } from '@latkit/network';
import {
  emptyAdapterEvidence,
  evidenceFromDevice,
  probeCompatibility,
} from './compatibility-probe.js';
import type { BrowserReport, FixtureApi, FixtureState } from './protocol.js';
import './style.css';

declare global {
  interface Window {
    latkitFixture: FixtureApi;
  }
}

const status = document.querySelector<HTMLOutputElement>('#status')!;
const reportElement = document.querySelector<HTMLElement>('#report')!;
const networkCanvas = document.querySelector<HTMLCanvasElement>('#network')!;
const monitorCanvases = [
  document.querySelector<HTMLCanvasElement>('#monitor-0')!,
  document.querySelector<HTMLCanvasElement>('#monitor-1')!,
] as const;

let device: GPUDevice | null = null;
let network: Network | null = null;
let monitors: Array<Monitor | null> = [];
let browserReport: BrowserReport = {
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  webgpu: {
    apiAvailable: Boolean(navigator.gpu),
    core: emptyAdapterEvidence('core'),
    compatibility: emptyAdapterEvidence('compatibility'),
  },
};
let generation = 0;
let ownerLosses = 0;
const borrowerLosses = { network: 0, monitor0: 0, monitor1: 0 };
let uncapturedErrors = 0;
let lastUncapturedError: string | null = null;
let lastOwnerLoss: { reason: string; message: string } | null = null;

const topology: Topology = {
  vertexCount: 5,
  vertexCoords: new Float32Array([0, 0, -1, 0, 1, 0, 0, -1, 0, 1]),
  edges: new Uint32Array([0, 1, 0, 2, 0, 3, 0, 4]),
  polylineStart: new Uint32Array(5),
};

const borders = makeBorders();
const requestedMsaa = new URLSearchParams(location.search).get('msaa') === '4' ? 4 : 1;

function makeSeries(offset: number): Series {
  const frames = 96;
  const elements = 3;
  const time = Float64Array.from({ length: frames }, (_, frame) => frame / (frames - 1));
  const values = new Float32Array(frames * elements);
  for (let frame = 0; frame < frames; frame++) {
    values[frame * elements] = 0.2 + offset;
    values[frame * elements + 1] = 0.5 + Math.sin(frame * 0.2) * 0.08;
    values[frame * elements + 2] = 0.8 - offset;
  }
  return { time, values, signalCount: 1, elementCount: elements };
}

async function mount(): Promise<void> {
  generation++;
  const nextDevice = await requestDevice();
  device = nextDevice;
  browserReport = {
    ...browserReport,
    webgpu: {
      ...browserReport.webgpu,
      core: evidenceFromDevice('core', nextDevice),
    },
  };
  renderReport();
  nextDevice.addEventListener('uncapturederror', (event) => {
    uncapturedErrors++;
    lastUncapturedError = event.error.message;
  });
  void nextDevice.lost.then((info) => {
    ownerLosses++;
    lastOwnerLoss = { reason: String(info.reason), message: info.message };
  });

  const nextNetwork = await createNetwork(nextDevice, networkCanvas, {
    msaa: requestedMsaa,
    borders: true,
    graticule: true,
    earthAxis: true,
    daylight: true,
    poles: true,
    baseColor: [0.1, 0.9, 1, 1],
  });
  network = nextNetwork;
  networkCanvas.dataset.state = 'mounted';
  nextNetwork.on('deviceLost', () => {
    borrowerLosses.network++;
  });
  nextNetwork.on('select', (kind, index) => {
    networkCanvas.dataset.select = kind === null ? 'none' : `${kind}:${index}`;
  });
  nextNetwork.load(topology);
  nextNetwork.setBorders(borders);
  nextNetwork.setChannel('vertexColor', new Float32Array([1, 0, 0.25, 0.5, 0.75]), [0, 1]);
  nextNetwork.setChannel(
    'vertexHeight',
    new Float32Array([0.1, 0.3, 0.5, 0.7, 0.9]),
    [0, 1],
    [0, 1],
  );
  nextNetwork.fit(false);
  nextNetwork.fadeIn(0);
  networkCanvas.dataset.projection = 'flat';
  networkCanvas.dataset.msaa = String(requestedMsaa);

  monitors = await Promise.all(
    monitorCanvases.map(async (canvas, index) => {
      const monitor = await createMonitor(nextDevice, canvas, {
        lineWidthPx: 2,
        valueRange: [0, 1],
        colormap: (value) => [value, 1 - value * 0.4, 1 - value],
      });
      monitor.on('deviceLost', () => {
        if (index === 0) borrowerLosses.monitor0++;
        else borrowerLosses.monitor1++;
      });
      monitor.on('pick', (reading) => {
        canvas.dataset.pick = `element:${reading.element}`;
      });
      monitor.load(makeSeries(index * 0.04));
      canvas.dataset.state = 'mounted';
      return monitor;
    }),
  );

  await settleDevice(nextDevice);
}

function destroyBorrowers(): void {
  network?.destroy();
  network = null;
  networkCanvas.dataset.state = 'destroyed';
  for (let index = 0; index < monitors.length; index++) {
    monitors[index]?.destroy();
    monitorCanvases[index]!.dataset.state = 'destroyed';
  }
  monitors = [];
}

async function destroyFirstMonitor(): Promise<void> {
  const first = monitors[0];
  if (!first) throw new Error('first monitor is not mounted');
  first.destroy();
  monitors[0] = null;
  monitorCanvases[0].dataset.state = 'destroyed';

  network?.zoomBy(1.03);
  const survivor = monitors[1];
  survivor?.setFocus(1);
  survivor?.resume();
  if (device) await settleDevice(device);
}

async function remountAfterLoss(): Promise<void> {
  const previous = device;
  if (!previous) throw new Error('device is not mounted');
  previous.destroy();
  await previous.lost;
  await Promise.resolve();
  destroyBorrowers();
  device = null;
  await mount();
}

async function setProjection(mode: 'flat' | 'tilt' | 'globe'): Promise<boolean> {
  const supported = network?.setProjection(mode) ?? false;
  if (!supported) return false;

  networkCanvas.dataset.projection = mode;
  network?.fit(false);
  network?.fadeIn(0);
  if (device) await settleDevice(device);
  return true;
}

function currentState(): FixtureState {
  return {
    generation,
    liveMonitors: monitors.filter((monitor) => monitor !== null).length,
    ownerLosses,
    borrowerLosses: { ...borrowerLosses },
    uncapturedErrors,
    lastUncapturedError,
    lastOwnerLoss,
  };
}

function animationFrames(count: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (): void => {
      if (count-- <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    step();
  });
}

async function settleDevice(target: GPUDevice): Promise<void> {
  await animationFrames(2);
  await target.queue.onSubmittedWorkDone();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function discoverCapabilities(): Promise<void> {
  browserReport = {
    ...browserReport,
    webgpu: {
      ...browserReport.webgpu,
      compatibility: await probeCompatibility(navigator.gpu),
    },
  };
  renderReport();
  status.dataset.capabilities = 'ready';
}

async function start(): Promise<void> {
  try {
    await mount();
  } catch (error) {
    browserReport = {
      ...browserReport,
      webgpu: {
        ...browserReport.webgpu,
        core: {
          ...browserReport.webgpu.core,
          error: errorMessage(error),
        },
      },
    };
    renderReport();
    throw error;
  }
  status.dataset.state = 'ready';
  status.value = 'ready';
}

const capabilitiesReady = discoverCapabilities().catch((error: unknown) => {
  status.dataset.capabilities = 'error';
  renderReport();
  throw error;
});

const ready = capabilitiesReady.then(start).catch((error: unknown) => {
  status.dataset.state = 'error';
  status.value = errorMessage(error);
  throw error;
});

window.latkitFixture = {
  capabilitiesReady,
  ready,
  destroyFirstMonitor,
  remountAfterLoss,
  setProjection,
  report: () => browserReport,
  state: currentState,
};

function renderReport(): void {
  reportElement.textContent = JSON.stringify(browserReport, null, 2);
}

function makeBorders(): Borders {
  const points = [
    [-1, -0.4],
    [1, 0.4],
  ] as const;
  const buffer = new ArrayBuffer(points.length * 24);
  const view = new DataView(buffer);
  for (let index = 0; index < points.length; index++) {
    const [longitude, latitude] = points[index]!;
    const longitudeRad = (longitude * Math.PI) / 180;
    const latitudeRad = (latitude * Math.PI) / 180;
    const cosLatitude = Math.cos(latitudeRad);
    const offset = index * 24;
    view.setFloat32(offset, longitude, true);
    view.setFloat32(offset + 4, latitude, true);
    view.setFloat32(offset + 8, cosLatitude * Math.cos(longitudeRad), true);
    view.setFloat32(offset + 12, Math.sin(latitudeRad), true);
    view.setFloat32(offset + 16, cosLatitude * Math.sin(longitudeRad), true);
    view.setUint32(offset + 20, 0, true);
  }
  return { vertices: new Uint8Array(buffer), indices: new Uint32Array([0, 1]) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
