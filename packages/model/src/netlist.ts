/**
 * The one check a netlist runs before a renderer loads it: what `Document.Netlist` promises.
 */

import type { Document } from './document.js';

const NONE = 0xffffffff;

/** Port flows: `0` in, `1` out, `2` both. */
const FLOW_OUT = 1;
const FLOW_LIMIT = 2;
/** Port sides: `0` left through `3` bottom. */
const SIDE_LIMIT = 3;
/** Net styles: `0` wires, `1` tags. */
const STYLE_LIMIT = 1;

function isTypedArray(value: unknown, name: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${name}]`;
}

/** A safe non-negative integer count, or throw `invalid <what>`. */
function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${what}`);
  }
  return value;
}

/** An optional typed array of the right kind and length whose values stay within `limit`. */
function optionalColumn(
  value: unknown,
  name: string,
  kind: 'Uint8Array' | 'Uint32Array',
  length: number,
  limit: number,
  what: string,
): void {
  if (value === undefined) return;
  if (!isTypedArray(value, kind)) throw new Error(`${name} must be ${kind}`);
  const column = value as Uint8Array | Uint32Array;
  if (column.length !== length) throw new Error(`invalid ${name} length`);
  for (let i = 0; i < length; i++) {
    if (column[i]! > limit) throw new Error(`invalid ${what}`);
  }
}

/** An offset table: a Uint32Array beginning at zero and never decreasing. */
function offsets(value: unknown, name: string, length: number | null): Uint32Array {
  if (!isTypedArray(value, 'Uint32Array')) throw new Error(`${name} must be Uint32Array`);
  const table = value as Uint32Array;
  if (length === null ? table.length < 1 : table.length !== length) {
    throw new Error(`invalid ${name} length`);
  }
  if (table[0] !== 0) throw new Error(`${name} must begin at zero`);
  for (let i = 1; i < table.length; i++) {
    if (table[i]! < table[i - 1]!) throw new Error(`${name} must be monotonic`);
  }
  return table;
}

/** An optional array of strings, one per item. */
function optionalStrings(value: unknown, name: string, length: number): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  if (value.length !== length) throw new Error(`invalid ${name} length`);
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string') throw new Error(`${name} must be an array of strings`);
  }
}

/**
 * Check what a netlist promises: counts, typed-array kinds, offset tables, ranges, one driver and
 * one kind per net, one net per port, unique keys, and label lengths. The one validator every
 * consumer shares, so a netlist a format builds is one a renderer loads.
 *
 * @throws Error naming the first field that is invalid.
 */
export function validateNetlist(netlist: Document.Netlist): void {
  const blockCount = count(netlist.blockCount, 'block count');
  const portStart = offsets(netlist.portStart, 'portStart', blockCount + 1);
  const portCount = portStart[blockCount]!;

  const flow = netlist.portFlow;
  if (!isTypedArray(flow, 'Uint8Array')) throw new Error('portFlow must be Uint8Array');
  if (flow.length !== portCount) throw new Error('invalid portFlow length');
  for (let port = 0; port < portCount; port++) {
    if (flow[port]! > FLOW_LIMIT) throw new Error('invalid port flow');
  }
  optionalColumn(netlist.portKind, 'portKind', 'Uint8Array', portCount, 0xff, 'port kind');
  optionalColumn(netlist.portSide, 'portSide', 'Uint8Array', portCount, SIDE_LIMIT, 'port side');

  const netPorts = netlist.netPorts;
  if (!isTypedArray(netPorts, 'Uint32Array')) throw new Error('netPorts must be Uint32Array');
  const netStart = offsets(netlist.netStart, 'netStart', null);
  const netCount = netStart.length - 1;
  if (netStart[netCount] !== netPorts.length) throw new Error('netStart terminal mismatch');

  const kind = netlist.portKind;
  const joined = new Uint8Array(portCount);
  for (let net = 0; net < netCount; net++) {
    const end = netStart[net + 1]!;
    let drivers = 0;
    let first = NONE;
    for (let i = netStart[net]!; i < end; i++) {
      const port = netPorts[i]!;
      if (port >= portCount) throw new Error('net port out of range');
      if (joined[port]) throw new Error('port on more than one net');
      joined[port] = 1;
      if (flow[port] === FLOW_OUT && ++drivers > 1) throw new Error('net has more than one driver');
      if (first === NONE) first = port;
      else if (kind && kind[port] !== kind[first]) throw new Error('net mixes port kinds');
    }
  }
  optionalColumn(netlist.netStyle, 'netStyle', 'Uint8Array', netCount, STYLE_LIMIT, 'net style');

  const groupCount = count(netlist.groupCount ?? 0, 'group count');
  const blockGroup = netlist.blockGroup;
  if (blockGroup !== undefined) {
    if (!isTypedArray(blockGroup, 'Uint32Array')) throw new Error('blockGroup must be Uint32Array');
    if (blockGroup.length !== blockCount) throw new Error('invalid blockGroup length');
    for (let block = 0; block < blockCount; block++) {
      const group = blockGroup[block]!;
      if (group !== NONE && group >= groupCount) throw new Error('block group out of range');
    }
  }

  optionalStrings(netlist.blockKey, 'blockKey', blockCount);
  if (netlist.blockKey && new Set(netlist.blockKey).size !== blockCount) {
    throw new Error('duplicate block key');
  }
  optionalStrings(netlist.blockTitle, 'blockTitle', blockCount);
  optionalStrings(netlist.blockLabel, 'blockLabel', blockCount);
  optionalStrings(netlist.portLabel, 'portLabel', portCount);
  optionalStrings(netlist.netLabel, 'netLabel', netCount);
  optionalStrings(netlist.groupLabel, 'groupLabel', groupCount);
}
