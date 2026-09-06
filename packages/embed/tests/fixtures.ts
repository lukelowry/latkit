import type { Series, Topology } from '@latkit/model';
import type { Monitor, Events as MonitorEvents } from '@latkit/monitor';
import type { Network, Events as NetworkEvents, Projection } from '@latkit/network';
import { vi } from 'vitest';

import { createElementClasses, type ElementDeps } from '../src/define.js';
import type { NetworkData } from '../src/network.js';

export function topology(): Topology {
  return {
    vertexCount: 3,
    vertexCoords: new Float32Array([-1, -1, 0, 1, 1, -1]),
    edges: new Uint32Array([0, 1, 1, 2, 2, 0]),
    polylineStart: new Uint32Array([0, 0, 0, 0]),
  };
}

export function networkData(): NetworkData {
  return {
    topology: topology(),
    fields: [
      { id: 'load', scope: 'vertex', values: new Float32Array([10, 30, 20]) },
      { id: 'capacity', scope: 'vertex', values: new Float32Array([40, 60, 80]) },
      { id: 'flow', scope: 'edge', values: new Float32Array([4, 8, 6]) },
    ],
  };
}

export function serializedNetwork(): Record<string, unknown> {
  return {
    topology: {
      vertexCount: 3,
      vertexCoords: [-1, -1, 0, 1, 1, -1],
      edges: [0, 1, 1, 2, 2, 0],
    },
    fields: [{ id: 'load', scope: 'vertex', values: [10, 30, 20] }],
  };
}

export function series(): Series {
  return {
    time: Float64Array.from([0, 1, 2]),
    values: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    signalCount: 2,
    elementCount: 2,
  };
}

export function serializedSeries(): Record<string, unknown> {
  return {
    time: [0, 1, 2],
    values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    signalCount: 2,
    elementCount: 2,
  };
}

type Spy = ReturnType<typeof vi.fn>;

/** Every option patch a `setOptions` spy received, merged in call order. */
export function patchesOf(spy: Spy): Record<string, unknown> {
  const calls = spy.mock.calls as Array<[Record<string, unknown>]>;
  return Object.assign({}, ...calls.map((call) => call[0])) as Record<string, unknown>;
}

interface Listeners<E> {
  emit<Key extends keyof E>(event: Key, payload: E[Key]): void;
}

function listeners<E extends object>() {
  const stored = new Map<keyof E, Set<(payload: unknown) => void>>();
  const on = vi.fn((event: keyof E, handler: (payload: never) => void) => {
    let handlers = stored.get(event);
    if (!handlers) stored.set(event, (handlers = new Set()));
    const entry = handler as unknown as (payload: unknown) => void;
    handlers.add(entry);
    return () => handlers!.delete(entry);
  });
  const emit: Listeners<E>['emit'] = (event, payload) => {
    for (const handler of [...(stored.get(event) ?? [])]) handler(payload);
  };
  return { on, emit };
}

export interface FakeNetwork extends Listeners<NetworkEvents> {
  readonly value: Network;
  readonly attach: Spy;
  readonly detach: Spy;
  readonly load: Spy;
  readonly setOptions: Spy;
  readonly setChannel: Spy;
  readonly setChannelDomain: Spy;
  readonly setProjection: Spy;
  readonly setBorders: Spy;
  readonly pause: Spy;
  readonly resume: Spy;
  geographic: boolean;
  /** Make the next `attach` reject with `error`. */
  failAttach(error: unknown): void;
}

export function fakeNetwork(): FakeNetwork {
  const { on, emit } = listeners<NetworkEvents>();
  let attached = false;
  let failure: { readonly error: unknown } | null = null;
  const attach = vi.fn(async () => {
    await Promise.resolve();
    if (failure) {
      const { error } = failure;
      failure = null;
      throw error;
    }
    attached = true;
    emit('attached', true);
  });
  const detach = vi.fn(() => {
    if (!attached) return;
    attached = false;
    emit('attached', false);
  });
  const spies = {
    attach,
    detach,
    load: vi.fn(),
    setOptions: vi.fn(),
    setChannel: vi.fn(),
    setChannelDomain: vi.fn(),
    setProjection: vi.fn((mode: Projection) => mode !== 'globe'),
    setBorders: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  const fake: FakeNetwork = {
    ...spies,
    emit,
    geographic: true,
    failAttach(error) {
      failure = { error };
    },
    value: {
      projection: 'flat',
      projections: { flat: true, tilt: true, globe: false },
      get geographic() {
        return fake.geographic;
      },
      orbiting: false,
      get attached() {
        return attached;
      },
      on,
      ...spies,
      destroy: vi.fn(),
    } as unknown as Network,
  };
  return fake;
}

export interface FakeMonitor extends Listeners<MonitorEvents> {
  readonly value: Monitor;
  readonly attach: Spy;
  readonly detach: Spy;
  readonly load: Spy;
  readonly setOptions: Spy;
  readonly setSignal: Spy;
  readonly pause: Spy;
  readonly resume: Spy;
}

export function fakeMonitor(): FakeMonitor {
  const { on, emit } = listeners<MonitorEvents>();
  let attached = false;
  const attach = vi.fn(async () => {
    await Promise.resolve();
    attached = true;
    emit('attached', true);
  });
  const detach = vi.fn(() => {
    if (!attached) return;
    attached = false;
    emit('attached', false);
  });
  const spies = {
    attach,
    detach,
    load: vi.fn(),
    setOptions: vi.fn(),
    setSignal: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return {
    ...spies,
    emit,
    value: {
      get attached() {
        return attached;
      },
      on,
      ...spies,
      select: vi.fn(),
      extend: vi.fn(),
      clear: vi.fn(),
      destroy: vi.fn(),
    } as unknown as Monitor,
  };
}

let tagId = 0;

/** Both element classes over fakes, defined under fresh tags for one test. */
export interface Harness {
  readonly deps: ElementDeps;
  readonly networks: FakeNetwork[];
  readonly monitors: FakeMonitor[];
  readonly network: () => HTMLElement;
  readonly monitor: () => HTMLElement;
  /** Report viewport proximity for a host, as the IntersectionObserver would. */
  near(host: HTMLElement, near: boolean): void;
  readonly observing: Set<HTMLElement>;
}

export function harness(overrides: Partial<ElementDeps> = {}): Harness {
  const networks: FakeNetwork[] = [];
  const monitors: FakeMonitor[] = [];
  const updaters = new Map<HTMLElement, (near: boolean) => void>();
  const observing = new Set<HTMLElement>();
  const deps: ElementDeps = {
    createNetwork: vi.fn(() => {
      const fake = fakeNetwork();
      networks.push(fake);
      return fake.value;
    }),
    createMonitor: vi.fn(() => {
      const fake = fakeMonitor();
      monitors.push(fake);
      return fake.value;
    }),
    loadBorders: vi.fn(() =>
      Promise.resolve({ vertices: new Uint8Array(24), indices: new Uint32Array([0]) }),
    ),
    fetch: vi.fn(() => Promise.reject(new Error('fetch not stubbed'))),
    observeNear: vi.fn((host: HTMLElement, update: (near: boolean) => void) => {
      updaters.set(host, update);
      observing.add(host);
      return () => {
        updaters.delete(host);
        observing.delete(host);
      };
    }),
    warn: vi.fn(),
    ...overrides,
  };
  const classes = createElementClasses(HTMLElement, deps);
  const id = ++tagId;
  const networkTag = `test-network-${id}`;
  const monitorTag = `test-monitor-${id}`;
  customElements.define(networkTag, classes.network);
  customElements.define(monitorTag, classes.monitor);
  return {
    deps,
    networks,
    monitors,
    observing,
    network: () => document.createElement(networkTag),
    monitor: () => document.createElement(monitorTag),
    near(host, near) {
      updaters.get(host)?.(near);
    },
  };
}

/** A JSON response. */
export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Append `<script type="application/json">` holding `body` to `host`. */
export function inline(host: HTMLElement, body: unknown): void {
  const script = document.createElement('script');
  script.type = 'application/json';
  script.textContent = JSON.stringify(body);
  host.append(script);
}

export function canvasOf(host: HTMLElement): HTMLCanvasElement {
  return host.shadowRoot!.querySelector('canvas')!;
}
