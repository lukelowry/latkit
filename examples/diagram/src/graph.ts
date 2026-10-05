import { itemId, numberAt, rowAt, rowCount, type Schema, type TypeDefinition } from '@latkit/model';
import type { Point, Positions } from '@latkit/gpu';
import type { Group, Shape, ConnectProposal } from '@latkit/diagram';

export const types = ['Input', 'Process', 'Control', 'Output'] as const;
export type BlockType = (typeof types)[number];
/** Each block type's ports and the way signals flow through them. */
export const ports: Record<BlockType, Readonly<Record<string, 'in' | 'out'>>> = {
  Input: { out: 'out' },
  Process: { in: 'in', out: 'out' },
  Control: { in: 'in', feedback: 'in', out: 'out' },
  Output: { in: 'in' },
};
const fields: TypeDefinition['fields'] = {
  name: { type: 'text' },
  position: { type: { kind: 'vector', items: 'float64', size: 2 } },
  signal: { type: 'float32' },
  status: { type: 'float32' },
  visible: { type: 'float32' },
};
/** A port is a reference to the signal wire it is plugged into. */
export const schema: Schema = {
  types: {
    ...Object.fromEntries(
      types.map((type) => [
        type,
        {
          fields: {
            ...fields,
            ...Object.fromEntries(
              Object.entries(ports[type]).map(([port, direction]) => [
                port,
                { type: { kind: 'reference', to: 'Signal' }, nullable: true, direction },
              ]),
            ),
          },
        },
      ]),
    ),
    Signal: { fields: { name: { type: 'text' }, signal: { type: 'float32' } } },
  },
};
export interface Block {
  id: string;
  type: BlockType;
  name: string;
  position: Point;
  signal: number;
  status: number;
  visible: number;
  /** The wire each port is plugged into; null where unplugged. */
  ports: Readonly<Record<string, string | null>>;
}
export interface Wire {
  id: string;
  name: string;
  signal: number;
}
export interface Graph {
  blocks: Block[];
  wires: Wire[];
  groups: Record<string, Group>;
}
/** A block's port. */
export interface Plug {
  readonly id: string;
  readonly port: string;
}
export const shapes: Record<BlockType, Shape> = {
  Input: 'ellipse',
  Process: 'rounded',
  Control: 'diamond',
  Output: 'rectangle',
};
export const presets = [
  { id: 'loop', name: 'Control loop', description: 'Typed ports, feedback & fan-out' },
  { id: 'groups', name: 'Grouped plants', description: 'Nested groups & boundary proxies' },
  { id: 'shapes', name: 'Shape atlas', description: 'Four shapes, labels & wire tags' },
  { id: 'scale', name: 'Scale study', description: '1,024 blocks, one shared pipeline' },
] as const;
export type Preset = (typeof presets)[number]['id'];
function unplugged(type: BlockType): Record<string, null> {
  return Object.fromEntries(Object.keys(ports[type]).map((port) => [port, null]));
}
export function preset(which: Preset, compact = false): Graph {
  const blocks: Block[] = [],
    wires: Wire[] = [],
    groups: Record<string, Group> = {},
    byId = new Map<string, Block>();
  const block = (id: string, type: BlockType, name: string, x: number, y: number) => {
    const value: Block = {
      id,
      type,
      name,
      position: [x, y],
      signal: (blocks.length % 7) / 6,
      status: 0,
      visible: 1,
      ports: unplugged(type),
    };
    blocks.push(value);
    byId.set(id, value);
    return id;
  };
  const plug = (id: string, port: string, wire: string) => {
    const value = byId.get(id)!;
    value.ports = { ...value.ports, [port]: wire };
  };
  /** A wire from one block's output to each target's input, or the port a target names. */
  const wire = (name: string, from: string, ...targets: (string | Plug)[]) => {
    const id = 'wire-' + wires.length;
    wires.push({ id, name, signal: 0.5 });
    plug(from, 'out', id);
    for (const target of targets)
      if (typeof target === 'string') plug(target, 'in', id);
      else plug(target.id, target.port, id);
  };
  if (which === 'loop') {
    block('reference', 'Input', 'Reference', 0, 0);
    block('controller', 'Control', 'Controller', 240, 0);
    block('actuator', 'Process', 'Actuator', 500, 0);
    block('plant', 'Process', 'Plant', 500, 240);
    block('sensor', 'Process', 'Sensor', 240, 240);
    block('response', 'Output', 'Response', 740, 240);
    wire('Set point', 'reference', 'controller');
    wire('Command', 'controller', 'actuator');
    wire('Drive', 'actuator', 'plant');
    wire('Measured', 'plant', 'response', 'sensor');
    wire('Feedback', 'sensor', { id: 'controller', port: 'feedback' });
    byId.get('plant')!.status = 1;
  } else if (which === 'groups') {
    block('dispatch', 'Input', 'Dispatch', 0, 190);
    for (let i = 0; i < 3; i++) {
      block('control-' + i, 'Process', 'Controller ' + (i + 1), 320, i * 210);
      block('plant-' + i, 'Process', 'Plant ' + (i + 1), 620, i * 210);
      wire('Drive ' + (i + 1), 'control-' + i, 'plant-' + i);
      groups['unit-' + i] = {
        label: 'Unit ' + (i + 1),
        parent: 'station',
        vertices: {
          Process: { kind: 'ids', ids: ['control-' + i, 'plant-' + i] },
        },
      };
    }
    block('meter', 'Output', 'Metering', 950, 190);
    wire('Dispatch', 'dispatch', 'control-0', 'control-1', 'control-2');
    // The meter reads one wire, so the plants share it.
    wire('Power', 'plant-0', 'meter');
    for (let i = 1; i < 3; i++) plug('plant-' + i, 'out', 'wire-' + (wires.length - 1));
    groups.station = { label: 'Generating station', vertices: {} };
  } else if (which === 'shapes') {
    block('ellipse', 'Input', 'Input', 0, 0);
    block('rounded', 'Process', 'Process', 300, 0);
    block('diamond', 'Control', 'Decision', 300, 250);
    block('rectangle', 'Output', 'Result', 640, 250);
    wire('Source', 'ellipse', 'rounded');
    wire('Evaluate', 'rounded', 'diamond');
    wire('Accept', 'diamond', 'rectangle');
  } else {
    for (let row = 0; row < 32; row++)
      for (let col = 0; col < 32; col++) {
        const id = row * 32 + col;
        block('block-' + id, 'Process', 'Block ' + (id + 1), col * 240, row * 150);
        if (col) wire('', 'block-' + (id - 1), 'block-' + id);
      }
  }
  if (compact && which === 'loop') {
    const positions: Record<string, Point> = {
      reference: [0, 0],
      controller: [0, 175],
      actuator: [210, 175],
      plant: [210, 365],
      sensor: [0, 365],
      response: [210, 555],
    };
    for (const value of blocks) value.position = positions[value.id];
  }
  if (compact && which === 'shapes') {
    const positions: Point[] = [
      [0, 0],
      [240, 0],
      [0, 250],
      [290, 340],
    ];
    blocks.forEach((value, i) => {
      value.position = positions[i];
    });
  }
  return { blocks, wires, groups };
}
/** Every port plugged into a wire. */
export function plugged(graph: Graph, wire: string): Plug[] {
  return graph.blocks.flatMap((block) =>
    Object.entries(block.ports)
      .filter(([, value]) => value === wire)
      .map(([port]) => ({ id: block.id, port })),
  );
}
function plug(graph: Graph, at: Plug, wire: string | null): Graph {
  return {
    ...graph,
    blocks: graph.blocks.map((block) =>
      block.id === at.id ? { ...block, ports: { ...block.ports, [at.port]: wire } } : block,
    ),
  };
}
/** Keep the wires something drives and something reads, and unplug ports from the rest. */
function prune(graph: Graph): Graph {
  const driven = new Set<string>(),
    read = new Set<string>();
  for (const block of graph.blocks)
    for (const [port, wire] of Object.entries(block.ports))
      if (wire) (ports[block.type][port] === 'out' ? driven : read).add(wire);
  const wires = graph.wires.filter((wire) => driven.has(wire.id) && read.has(wire.id));
  if (wires.length === graph.wires.length) return graph;
  const kept = new Set(wires.map((wire) => wire.id));
  return {
    ...graph,
    wires,
    blocks: graph.blocks.map((block) =>
      Object.values(block.ports).every((wire) => !wire || kept.has(wire))
        ? block
        : {
            ...block,
            ports: Object.fromEntries(
              Object.entries(block.ports).map(([port, wire]) => [
                port,
                wire && kept.has(wire) ? wire : null,
              ]),
            ),
          },
    ),
  };
}
/** The graph with each block where positions put it, as a move proposes or a layout arranges. */
export function placeGraph(graph: Graph, positions: Readonly<Record<string, Positions>>): Graph {
  const placed = new Map<string, Point>();
  for (const [type, { x, y }] of Object.entries(positions)) {
    if (x.values.kind !== 'numeric' || y.values.kind !== 'numeric') continue;
    const blocks = graph.blocks.filter((block) => block.type === type);
    for (let i = 0; i < rowCount(x.rows); i++)
      placed.set(blocks[rowAt(x.rows, i)].id, [numberAt(x.values, i)!, numberAt(y.values, i)!]);
  }
  return {
    ...graph,
    blocks: graph.blocks.map((block) => ({
      ...block,
      position: placed.get(block.id) ?? block.position,
    })),
  };
}
export function deleteItems(graph: Graph, ids: readonly string[]): Graph {
  const removed = new Set(ids),
    blocks = graph.blocks.filter((block) => !removed.has(block.id));
  const available = new Set(blocks.map((block) => block.id));
  return prune({
    blocks,
    wires: graph.wires.filter((wire) => !removed.has(wire.id)),
    groups: Object.fromEntries(
      Object.entries(graph.groups).map(([id, group]) => [
        id,
        {
          ...group,
          vertices: Object.fromEntries(
            Object.entries(group.vertices).map(([type, rows]) => [
              type,
              rows.kind === 'ids'
                ? { ...rows, ids: rows.ids.filter((id) => available.has(id)) }
                : rows,
            ]),
          ),
        },
      ]),
    ),
  });
}
export function addBlock(
  graph: Graph,
  type: BlockType,
  position: Point,
): { graph: Graph; block: Block } {
  const block: Block = {
    id: 'block-' + crypto.randomUUID(),
    type,
    name: 'New ' + type.toLowerCase(),
    position,
    signal: 0.5,
    status: 0,
    visible: 1,
    ports: unplugged(type),
  };
  return { graph: { ...graph, blocks: [...graph.blocks, block] }, block };
}
/** A block's first port in a direction, for wiring dropped on its body. */
function portOf(block: Block, direction: 'in' | 'out'): string {
  const port = Object.keys(ports[block.type]).find((name) => ports[block.type][name] === direction);
  if (!port) throw new Error(`${block.name} has no ${direction === 'in' ? 'input' : 'output'}.`);
  return port;
}
/** Plug the proposal's ports into one wire: the driving output's, or a new one. */
export function connectGraph(graph: Graph, proposal: ConnectProposal, createOnDrop = false): Graph {
  // The proposal names rows; this graph names blocks and wires by id.
  const fromPort = proposal.from.kind === 'port' ? proposal.from.port : undefined;
  const source = graph.blocks.find((block) => block.id === itemId(proposal.from));
  if (!source) throw new Error('The starting block was removed.');
  // A moved input leaves its wire first.
  const replaces = proposal.replaces;
  let next = replaces
    ? plug(graph, { id: itemId(replaces.end), port: replaces.end.port }, null)
    : graph;
  const input = !!fromPort && ports[source.type][fromPort] === 'in';
  let target: {
    readonly kind: 'vertex' | 'edge';
    readonly id: string;
    readonly port?: string;
  } | null = proposal.to && {
    kind: proposal.to.kind === 'edge' ? 'edge' : 'vertex',
    id: itemId(proposal.to),
    ...(proposal.to.kind === 'port' ? { port: proposal.to.port } : {}),
  };
  if (!target) {
    if (replaces) return prune(next);
    if (!createOnDrop) return graph;
    const added = addBlock(next, 'Process', proposal.position);
    next = added.graph;
    target = { kind: 'vertex', id: added.block.id, port: input ? 'out' : 'in' };
  }
  if (target.kind === 'edge') {
    if (!fromPort) throw new Error('Only a port joins a wire.');
    return prune(plug(next, { id: source.id, port: fromPort }, target.id));
  }
  const destination = next.blocks.find((block) => block.id === target.id);
  if (!destination) throw new Error('The destination was removed.');
  const from: Plug = { id: source.id, port: fromPort ?? portOf(source, 'out') },
    to: Plug = {
      id: destination.id,
      port:
        target.port ?? portOf(destination, ports[source.type][from.port] === 'in' ? 'out' : 'in'),
    };
  if (ports[source.type][from.port] === ports[destination.type][to.port])
    throw new Error('Wire an output to an input.');
  const [driver, reader] = ports[source.type][from.port] === 'out' ? [from, to] : [to, from];
  let wire = next.blocks.find((block) => block.id === driver.id)!.ports[driver.port];
  if (!wire) {
    wire = 'wire-' + crypto.randomUUID();
    next = plug(
      { ...next, wires: [...next.wires, { id: wire, name: 'New signal', signal: 0.5 }] },
      driver,
      wire,
    );
  }
  return prune(plug(next, reader, wire));
}
export class History {
  private undoStack: Graph[] = [];
  private redoStack: Graph[] = [];
  constructor(public current: Graph) {}
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  commit(next: Graph): void {
    this.undoStack.push(this.current);
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    this.current = next;
  }
  undo(): Graph {
    const value = this.undoStack.pop();
    if (value) {
      this.redoStack.push(this.current);
      this.current = value;
    }
    return this.current;
  }
  redo(): Graph {
    const value = this.redoStack.pop();
    if (value) {
      this.undoStack.push(this.current);
      this.current = value;
    }
    return this.current;
  }
}
