/**
 * The core pack: everything a model knows before any class loads. Topology and anchor arrays are
 * sections; the rest, each class's declared columns and signals included, is the directory.
 */

import type { Model } from '../model.js';
import { decode, encode, type Section, typed } from './container.js';

const KIND = 'latkit-model-core';

interface Meta {
  readonly format: string;
  readonly id: string;
  readonly name: string;
  readonly meta: NonNullable<Model.Description['meta']>;
  readonly topology: {
    readonly vertexCount: number;
    readonly coordinateSpace?: Model.Topology['coordinateSpace'];
    readonly vertexCoords?: string;
    readonly polylinePoints?: string;
  };
  readonly owners: NonNullable<Model.Description['owners']>;
  readonly classes: readonly {
    readonly id: string;
    readonly label: string;
    readonly count: number;
    readonly anchor?: { readonly kind: 'vertex' | 'edge'; readonly index: string };
    readonly columns: Model.Class['columns'];
    readonly signals: readonly Model.Signal[];
  }[];
}

/** A declared column as the directory stores it: its own fields and nothing else. */
function declared(column: Model.Column): Model.Column {
  return {
    kind: column.kind,
    id: column.id,
    label: column.label,
    ...(column.kind === 'number' && column.unit !== undefined && { unit: column.unit }),
    ...(column.group !== undefined && { group: column.group }),
  } as Model.Column;
}

/** Pack a model's description. Returned bytes are the caller's. */
export function encodeCore(model: Model.Description): Uint8Array {
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
    const entry = {
      id: spec.id,
      label: spec.label,
      count: spec.count,
      columns: spec.columns.map(declared),
      signals: spec.signals,
    };
    if (!spec.anchor) return entry;
    const id = `anchor.${index}`;
    sections.push({ id, data: spec.anchor.index });
    return { ...entry, anchor: { kind: spec.anchor.kind, index: id } };
  });
  const meta: Meta = {
    format: model.format,
    id: model.id,
    name: model.name,
    meta: model.meta ?? {},
    topology: {
      vertexCount: topology.vertexCount,
      ...(topology.coordinateSpace !== undefined && { coordinateSpace: topology.coordinateSpace }),
      ...(topology.vertexCoords && { vertexCoords: 'vertexCoords' }),
      ...(topology.polylinePoints && { polylinePoints: 'polylinePoints' }),
    },
    owners: model.owners ?? {},
    classes,
  };
  return encode(KIND, meta, sections);
}

/** Unpack a model's description; arrays view the received buffer, and the model checks it. */
export function decodeCore(bytes: Uint8Array): Model.Description {
  const pack = decode<Meta>(bytes, KIND);
  const meta = pack.meta;
  const topology: Model.Topology = {
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
  const classes = meta.classes.map((entry): Model.Class => ({
    id: entry.id,
    label: entry.label,
    count: entry.count,
    columns: entry.columns,
    signals: entry.signals,
    ...(entry.anchor && {
      anchor: { kind: entry.anchor.kind, index: typed(pack, entry.anchor.index, Uint32Array) },
    }),
  }));
  return {
    format: meta.format,
    id: meta.id,
    name: meta.name,
    meta: meta.meta,
    topology,
    owners: meta.owners,
    classes,
  };
}
