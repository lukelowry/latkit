import { createModel, type ClassData, type Loader, type Model } from '../src/index.js';

/** Three vertices in a line with two edges, buses owning vertices, branches owning edges, two
 *  generators anchored to vertices 0 and 2, and one area with no place on the canvas. */
export function sampleData(): Omit<Model, keyof Loader> {
  return {
    vendor: 'test',
    id: 'sample',
    name: 'Sample',
    meta: { freqBase: 60, note: 'fixture', live: true, empty: null },
    topology: {
      vertexCount: 3,
      vertexCoords: Float32Array.of(-96, 30, -95, 31, -94, 30),
      coordinateSpace: 'geographic',
      edges: Uint32Array.of(0, 1, 1, 2),
      polylineStart: Uint32Array.of(0, 0, 1),
      polylinePoints: Float32Array.of(-94.5, 30.5),
    },
    owners: { vertex: 'bus', edge: 'branch' },
    classes: [
      {
        id: 'bus',
        label: 'Bus',
        count: 3,
        signals: [
          { id: 'Vm', label: 'Voltage', unit: 'pu', recorded: true },
          { id: 'Va', label: 'Angle', unit: 'deg', recorded: false },
        ],
      },
      { id: 'branch', label: 'Branch', count: 2, signals: [] },
      {
        id: 'gen',
        label: 'Generator',
        count: 2,
        anchor: { kind: 'vertex', index: Uint32Array.of(0, 2) },
        signals: [{ id: 'P', label: 'Power', unit: 'MW', recorded: true }],
      },
      { id: 'area', label: 'Area', count: 1, signals: [] },
    ],
  };
}

export function sampleClass(id: string): ClassData {
  switch (id) {
    case 'bus':
      return {
        labels: ['North', 'Middle', 'South'],
        columns: [
          {
            kind: 'number',
            id: 'Vm',
            label: 'Voltage',
            unit: 'pu',
            values: Float64Array.of(1.02, NaN, 0.98),
          },
          { kind: 'text', id: 'zone', label: 'Zone', group: 'Location', values: ['A', null, 'B'] },
          { kind: 'flag', id: 'slack', label: 'Slack', values: Uint8Array.of(1, 0, 0) },
        ],
      };
    case 'branch':
      return {
        labels: ['North-Middle', 'Middle-South'],
        columns: [{ kind: 'flag', id: 'xfmr', label: 'Transformer', values: Uint8Array.of(0, 1) }],
      };
    case 'gen':
      return { labels: ['G1', 'G2'], columns: [] };
    case 'area':
      return { labels: ['Texas'], columns: [] };
    default:
      throw new Error(`no fixture class '${id}'`);
  }
}

export function sampleLoader(calls: string[] = []): Loader {
  return {
    load: async (id) => {
      calls.push(id);
      return sampleClass(id);
    },
    bytes: async () => new TextEncoder().encode('{"case":"sample"}'),
  };
}

export function sampleModel(calls?: string[]): Model {
  return createModel(sampleData(), sampleLoader(calls));
}
