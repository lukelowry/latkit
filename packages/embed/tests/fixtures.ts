import type { Events, Item, Network, Projection, Topology } from '@latkit/network';
import { vi } from 'vitest';

import type { NetworkData } from '../src/data/types.js';

export function topology(): Topology {
  return {
    vertexCount: 3,
    vertexCoords: new Float32Array([-1, -1, 0, 1, 1, -1]),
    edges: new Uint32Array([0, 1, 1, 2, 2, 0]),
    polylineStart: new Uint32Array([0, 0, 0, 0]),
  };
}

export function networkData(): NetworkData {
  return { topology: topology() };
}

export function networkDataWithFields(): NetworkData {
  return {
    topology: topology(),
    fields: [
      {
        id: 'load',
        label: 'Load',
        unit: 'MW',
        scope: 'vertex',
        values: new Float32Array([10, 30, 20]),
      },
      {
        id: 'capacity',
        label: 'Capacity',
        unit: 'MW',
        scope: 'vertex',
        values: new Float32Array([40, 60, 80]),
      },
      {
        id: 'flow',
        label: 'Flow',
        unit: 'MW',
        scope: 'edge',
        values: new Float32Array([4, 8, 6]),
      },
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
  };
}

type Spy = ReturnType<typeof vi.fn>;

export interface FakeNetwork {
  readonly value: Network;
  readonly on: Spy;
  readonly load: Spy;
  readonly setBorders: Spy;
  readonly pause: Spy;
  readonly resume: Spy;
  readonly destroy: Spy;
  readonly setChannel: Spy;
  readonly setChannelDomain: Spy;
  readonly getChannelDomain: Spy;
  readonly setOptions: Spy;
  readonly setProjection: Spy;
  readonly fit: Spy;
  readonly reveal: Spy;
  readonly neighborhood: Spy;
  readonly select: Spy;
  readonly panBy: Spy;
  readonly rotateBy: Spy;
  readonly getPose: Spy;
  readonly setPose: Spy;
  readonly zoomBy: Spy;
  readonly orbit: Spy;
  emit<Key extends keyof Events>(event: Key, payload: Events[Key]): void;
}

export function fakeNetwork(
  projections: Network['projections'] = { flat: true, tilt: true, globe: true },
): FakeNetwork {
  const listeners = new Map<keyof Events, Set<(payload: unknown) => unknown>>();
  const on = vi.fn((event: keyof Events, handler: (payload: never) => unknown) => {
    let handlers = listeners.get(event);
    if (!handlers) listeners.set(event, (handlers = new Set()));
    const stored = handler as unknown as (payload: unknown) => unknown;
    handlers.add(stored);
    return () => handlers!.delete(stored);
  });
  let orbiting = false;
  const load = vi.fn();
  const setBorders = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  const destroy = vi.fn();
  const setChannel = vi.fn();
  const setChannelDomain = vi.fn();
  const getChannelDomain = vi.fn(() => null);
  const setOptions = vi.fn();
  const setProjection = vi.fn((mode: Projection) => projections[mode]);
  const fit = vi.fn();
  const reveal = vi.fn(() => true);
  const neighborhood = vi.fn((item: Item) => [item]);
  const select = vi.fn();
  const panBy = vi.fn();
  const rotateBy = vi.fn();
  const getPose = vi.fn(() => ({ centerX: 1, centerY: 2, pitch: 3, bearing: 4 }));
  const setPose = vi.fn(() => true);
  const zoomBy = vi.fn();
  const orbit = vi.fn((active: boolean) => (orbiting = active));
  const spies = {
    on,
    load,
    setBorders,
    pause,
    resume,
    destroy,
    setChannel,
    setChannelDomain,
    getChannelDomain,
    setOptions,
    setProjection,
    fit,
    reveal,
    neighborhood,
    select,
    panBy,
    rotateBy,
    getPose,
    setPose,
    zoomBy,
    orbit,
  };
  return {
    value: {
      projection: 'flat',
      projections,
      geographic: true,
      get orbiting() {
        return orbiting;
      },
      ...spies,
    } as unknown as Network,
    ...spies,
    emit(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
