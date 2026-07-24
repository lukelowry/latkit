import type { Events, Network, ProjectionMode, Topology } from '@latkit/network';
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

export interface FakeNetwork {
  readonly value: Network;
  readonly on: ReturnType<typeof vi.fn>;
  readonly load: ReturnType<typeof vi.fn>;
  readonly setBorders: ReturnType<typeof vi.fn>;
  readonly fadeIn: ReturnType<typeof vi.fn>;
  readonly pause: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly setColormap: ReturnType<typeof vi.fn>;
  readonly setBaseColor: ReturnType<typeof vi.fn>;
  readonly setChannel: ReturnType<typeof vi.fn>;
  readonly clearChannel: ReturnType<typeof vi.fn>;
  readonly setChannelRange: ReturnType<typeof vi.fn>;
  readonly setOptions: ReturnType<typeof vi.fn>;
  readonly setProjection: ReturnType<typeof vi.fn>;
  readonly fit: ReturnType<typeof vi.fn>;
  readonly select: ReturnType<typeof vi.fn>;
  readonly clearSelection: ReturnType<typeof vi.fn>;
  readonly panBy: ReturnType<typeof vi.fn>;
  readonly zoomBy: ReturnType<typeof vi.fn>;
  emit<Key extends keyof Events>(event: Key, ...args: Parameters<Events[Key]>): void;
}

export function fakeNetwork(
  projections: Network['projections'] = { flat: true, tilt: true, globe: true },
): FakeNetwork {
  const listeners = new Map<keyof Events, Set<(...args: unknown[]) => unknown>>();
  const on = vi.fn((event: keyof Events, handler: (...args: never[]) => unknown) => {
    let handlers = listeners.get(event);
    if (!handlers) listeners.set(event, (handlers = new Set()));
    const stored = handler as unknown as (...args: unknown[]) => unknown;
    handlers.add(stored);
    return () => handlers!.delete(stored);
  });
  const load = vi.fn();
  const setBorders = vi.fn();
  const fadeIn = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  const destroy = vi.fn();
  const setColormap = vi.fn();
  const setBaseColor = vi.fn();
  const setChannel = vi.fn();
  const clearChannel = vi.fn();
  const setChannelRange = vi.fn();
  const setOptions = vi.fn();
  const setProjection = vi.fn((mode: ProjectionMode) => projections[mode]);
  const fit = vi.fn();
  const select = vi.fn();
  const clearSelection = vi.fn();
  const panBy = vi.fn();
  const zoomBy = vi.fn();
  return {
    value: {
      projections,
      on,
      load,
      setBorders,
      fadeIn,
      pause,
      resume,
      destroy,
      setColormap,
      setBaseColor,
      setChannel,
      clearChannel,
      setChannelRange,
      setOptions,
      setProjection,
      fit,
      select,
      clearSelection,
      panBy,
      zoomBy,
    } as unknown as Network,
    on,
    load,
    setBorders,
    fadeIn,
    pause,
    resume,
    destroy,
    setColormap,
    setBaseColor,
    setChannel,
    clearChannel,
    setChannelRange,
    setOptions,
    setProjection,
    fit,
    select,
    clearSelection,
    panBy,
    zoomBy,
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
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
