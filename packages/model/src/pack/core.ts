/**
 * The core pack: everything a model knows before any class loads. Topology and anchor arrays are
 * sections; the rest is the directory.
 */

import type { ClassSpec, Loader, Model, Signal, Topology } from '../model.js';
import { decode, encode, type Section, typed } from './container.js';

const KIND = 'latkit-model-core';

type Data = Omit<Model, keyof Loader>;

interface Meta {
  readonly vendor: string;
  readonly id: string;
  readonly name: string;
  readonly meta: Model['meta'];
  readonly topology: {
    readonly vertexCount: number;
    readonly coordinateSpace?: Topology['coordinateSpace'];
    readonly vertexCoords?: string;
    readonly polylinePoints?: string;
  };
  readonly owners: Model['owners'];
  readonly classes: readonly {
    readonly id: string;
    readonly label: string;
    readonly count: number;
    readonly anchor?: { readonly kind: 'vertex' | 'edge'; readonly index: string };
    readonly signals: readonly Signal[];
  }[];
}

/** Pack a model's data. Returned bytes are the caller's. */
export function encodeCore(model: Data): Uint8Array {
  const { topology } = model;
  const sections: { id: string; data: Section }[] = [
    { id: 'edges', data: topology.edges },
    { id: 'polylineStart', data: topology.polylineStart },
  ];
  if (topology.vertexCoords) sections.push({ id: 'vertexCoords', data: topology.vertexCoords });
  if (topology.polylinePoints) {
    sections.push({ id: 'polylinePoints', data: topology.polylinePoints });
  }
  const classes = model.classes.map((spec, index): Meta['classes'][number] => {
    const entry = { id: spec.id, label: spec.label, count: spec.count, signals: spec.signals };
    if (!spec.anchor) return entry;
    const id = `anchor.${index}`;
    sections.push({ id, data: spec.anchor.index });
    return { ...entry, anchor: { kind: spec.anchor.kind, index: id } };
  });
  const meta: Meta = {
    vendor: model.vendor,
    id: model.id,
    name: model.name,
    meta: model.meta,
    topology: {
      vertexCount: topology.vertexCount,
      ...(topology.coordinateSpace !== undefined && { coordinateSpace: topology.coordinateSpace }),
      ...(topology.vertexCoords && { vertexCoords: 'vertexCoords' }),
      ...(topology.polylinePoints && { polylinePoints: 'polylinePoints' }),
    },
    owners: model.owners,
    classes,
  };
  return encode(KIND, meta, sections);
}

/** Unpack a model's data; arrays view the received buffer. `createModel` validates the result. */
export function decodeCore(bytes: Uint8Array): Data {
  const pack = decode<Meta>(bytes, KIND);
  const meta = pack.meta;
  const topology: Topology = {
    vertexCount: meta.topology.vertexCount,
    ...(meta.topology.coordinateSpace !== undefined && {
      coordinateSpace: meta.topology.coordinateSpace,
    }),
    edges: typed(pack, 'edges', Uint32Array),
    polylineStart: typed(pack, 'polylineStart', Uint32Array),
    ...(meta.topology.vertexCoords !== undefined && {
      vertexCoords: typed(pack, meta.topology.vertexCoords, Float32Array),
    }),
    ...(meta.topology.polylinePoints !== undefined && {
      polylinePoints: typed(pack, meta.topology.polylinePoints, Float32Array),
    }),
  };
  const classes = meta.classes.map((entry): ClassSpec => ({
    id: entry.id,
    label: entry.label,
    count: entry.count,
    signals: entry.signals,
    ...(entry.anchor && {
      anchor: { kind: entry.anchor.kind, index: typed(pack, entry.anchor.index, Uint32Array) },
    }),
  }));
  return {
    vendor: meta.vendor,
    id: meta.id,
    name: meta.name,
    meta: meta.meta,
    topology,
    owners: meta.owners,
    classes,
  };
}
