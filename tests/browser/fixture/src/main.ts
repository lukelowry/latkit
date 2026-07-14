import { requestDevice } from '@latkit/gpu';
import { createMonitor, type Monitor, type Series } from '@latkit/monitor';
import { createNetwork, type Network, type Topology } from '@latkit/network';
import './style.css';

interface AdapterReport {
  readonly api: boolean;
  readonly coreAdapter: boolean;
  readonly info?: Readonly<Record<string, string>>;
  readonly fallback?: boolean;
  readonly features?: readonly string[];
  readonly limits?: Readonly<Record<string, number>>;
}

interface BrowserReport {
  readonly userAgent: string;
  readonly platform: string;
  readonly adapter: AdapterReport;
}

interface BorrowerLosses {
  readonly network: number;
  readonly monitor0: number;
  readonly monitor1: number;
}

interface FixtureState {
  readonly generation: number;
  readonly liveMonitors: number;
  readonly ownerLosses: number;
  readonly borrowerLosses: BorrowerLosses;
  readonly uncapturedErrors: number;
  readonly lastUncapturedError: string | null;
  readonly lastOwnerLoss: Readonly<{ reason: string; message: string }> | null;
}

interface FixtureApi {
  readonly ready: Promise<void>;
  destroyFirstMonitor(): Promise<void>;
  remountAfterLoss(): Promise<void>;
  report(): BrowserReport | null;
  state(): FixtureState;
}

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
let browserReport: BrowserReport | null = null;
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

function reportDevice(device: GPUDevice): BrowserReport {
  const infoNames = ['vendor', 'architecture', 'device', 'description'] as const;
  const info = Object.fromEntries(
    infoNames.flatMap((name) => {
      const value = device.adapterInfo[name];
      return value.length > 0 ? [[name, value] as const] : [];
    }),
  );
  const limitNames = [
    'maxBufferSize',
    'maxStorageBufferBindingSize',
    'maxStorageBuffersPerShaderStage',
    'maxStorageBuffersInVertexStage',
  ] as const;
  const limits = Object.fromEntries(
    limitNames.flatMap((name) => {
      const value = device.limits[name];
      return typeof value === 'number' ? [[name, value] as const] : [];
    }),
  );

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    adapter: {
      api: true,
      coreAdapter: true,
      info,
      fallback: device.adapterInfo.isFallbackAdapter,
      features: [...device.features].sort(),
      limits,
    },
  };
}

async function mount(): Promise<void> {
  generation++;
  const nextDevice = await requestDevice();
  device = nextDevice;
  browserReport = reportDevice(nextDevice);
  reportElement.textContent = JSON.stringify(browserReport, null, 2);
  nextDevice.addEventListener('uncapturederror', (event) => {
    uncapturedErrors++;
    lastUncapturedError = event.error.message;
  });
  void nextDevice.lost.then((info) => {
    ownerLosses++;
    lastOwnerLoss = { reason: String(info.reason), message: info.message };
  });

  const nextNetwork = await createNetwork(nextDevice, networkCanvas, {
    msaa: 1,
    borders: false,
    graticule: false,
    earthAxis: false,
    daylight: false,
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
  nextNetwork.setChannel('vertexColor', new Float32Array([1, 0, 0.25, 0.5, 0.75]), [0, 1]);
  nextNetwork.fit(false);
  nextNetwork.fadeIn(0);

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

async function start(): Promise<void> {
  browserReport = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    adapter: { api: Boolean(navigator.gpu), coreAdapter: false },
  };
  reportElement.textContent = JSON.stringify(browserReport, null, 2);
  await mount();
  status.dataset.state = 'ready';
  status.value = 'ready';
}

const ready = start().catch((error: unknown) => {
  status.dataset.state = 'error';
  status.value = error instanceof Error ? error.message : String(error);
  throw error;
});

window.latkitFixture = {
  ready,
  destroyFirstMonitor,
  remountAfterLoss,
  report: () => browserReport,
  state: currentState,
};
