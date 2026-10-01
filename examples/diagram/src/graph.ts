import type { ComponentDefinition, Schema } from '@latkit/model';
import type { Group, Point, Shape, ConnectionGesture, MoveProposal } from '@latkit/diagram';

const fields: ComponentDefinition['fields'] = {
  name: { type: 'text' },
  position: { type: { kind: 'vector', items: 'float64', size: 2 } },
  signal: { type: 'float32' },
  status: { type: 'float32' },
  visible: { type: 'float32' },
};
const input = { direction: 'in' as const, type: 'signal' };
const output = { direction: 'out' as const, type: 'signal' };
export const types = ['Input', 'Process', 'Control', 'Output'] as const;
export type NodeType = (typeof types)[number];
export const schema: Schema = {
  queries: ['rows', 'endpoints'],
  limits: { maxBlockBytes: 1024 * 1024 },
  components: {
    Input: { fields, ports: { out: output } },
    Process: { fields, ports: { in: input, out: output } },
    Control: { fields, ports: { in: input, feedback: input, out: output } },
    Output: { fields, ports: { in: input } },
  },
  connections: {
    Signal: {
      fields: { name: { type: 'text' }, signal: { type: 'float32' } },
      roles: { source: { min: 1, direction: 'out' }, target: { min: 1, direction: 'in' } },
    },
  },
};
export interface Block {
  id: string;
  type: NodeType;
  name: string;
  position: Point;
  signal: number;
  status: number;
  visible: number;
}
export interface End {
  id: string;
  port: string | null;
  role: 'source' | 'target';
}
export interface Wire {
  id: string;
  name: string;
  signal: number;
  ends: End[];
}
export interface Graph {
  nodes: Block[];
  wires: Wire[];
  groups: Record<string, Group>;
}
export const shapes: Record<NodeType, Shape> = {
  Input: 'ellipse',
  Process: 'rounded',
  Control: 'diamond',
  Output: 'rectangle',
};
export const presets = [
  { id: 'loop', name: 'Control loop', description: 'Typed ports, feedback & fan-out' },
  { id: 'groups', name: 'Grouped plants', description: 'Nested groups & boundary proxies' },
  { id: 'shapes', name: 'Shape atlas', description: 'Four shapes, labels & connection tags' },
  { id: 'scale', name: 'Scale study', description: '1,024 blocks, one shared pipeline' },
] as const;
export type Preset = (typeof presets)[number]['id'];
export function preset(which: Preset, compact = false): Graph {
  const nodes: Block[] = [],
    wires: Wire[] = [],
    groups: Record<string, Group> = {};
  const node = (id: string, type: NodeType, name: string, x: number, y: number) => {
    nodes.push({
      id,
      type,
      name,
      position: [x, y],
      signal: (nodes.length % 7) / 6,
      status: 0,
      visible: 1,
    });
    return id;
  };
  const wire = (name: string, from: string, ...targets: string[]) => {
    wires.push({
      id: 'wire-' + wires.length,
      name,
      signal: 0.5,
      ends: [
        { id: from, port: 'out', role: 'source' },
        ...targets.map((id) => ({ id, port: 'in', role: 'target' as const })),
      ],
    });
  };
  if (which === 'loop') {
    node('reference', 'Input', 'Reference', 0, 0);
    node('controller', 'Control', 'Controller', 240, 0);
    node('actuator', 'Process', 'Actuator', 500, 0);
    node('plant', 'Process', 'Plant', 500, 240);
    node('sensor', 'Process', 'Sensor', 240, 240);
    node('response', 'Output', 'Response', 740, 240);
    wire('Set point', 'reference', 'controller');
    wire('Command', 'controller', 'actuator');
    wire('Drive', 'actuator', 'plant');
    wire('Measured', 'plant', 'response', 'sensor');
    wire('Feedback', 'sensor', 'controller');
    wires.at(-1)!.ends[1].port = 'feedback';
    nodes.find((n) => n.id === 'plant')!.status = 1;
  } else if (which === 'groups') {
    node('dispatch', 'Input', 'Dispatch', 0, 190);
    for (let i = 0; i < 3; i++) {
      node('control-' + i, 'Process', 'Controller ' + (i + 1), 320, i * 210);
      node('plant-' + i, 'Process', 'Plant ' + (i + 1), 620, i * 210);
      wire('Drive ' + (i + 1), 'control-' + i, 'plant-' + i);
      groups['unit-' + i] = {
        label: 'Unit ' + (i + 1),
        parent: 'station',
        components: {
          Process: { kind: 'ids', ids: ['control-' + i, 'plant-' + i] },
        },
      };
    }
    node('meter', 'Output', 'Metering', 950, 190);
    wire('Dispatch', 'dispatch', 'control-0', 'control-1', 'control-2');
    for (let i = 0; i < 3; i++) wire('Power ' + (i + 1), 'plant-' + i, 'meter');
    groups.station = { label: 'Generating station', components: {} };
  } else if (which === 'shapes') {
    node('ellipse', 'Input', 'Input', 0, 0);
    node('rounded', 'Process', 'Process', 300, 0);
    node('diamond', 'Control', 'Decision', 300, 250);
    node('rectangle', 'Output', 'Result', 640, 250);
    wire('Source', 'ellipse', 'rounded');
    wire('Evaluate', 'rounded', 'diamond');
    wire('Accept', 'diamond', 'rectangle');
  } else {
    for (let row = 0; row < 32; row++)
      for (let col = 0; col < 32; col++) {
        const id = row * 32 + col;
        node('block-' + id, 'Process', 'Block ' + (id + 1), col * 240, row * 150);
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
    for (const node of nodes) node.position = positions[node.id];
  }
  if (compact && which === 'shapes') {
    const positions: Point[] = [
      [0, 0],
      [240, 0],
      [0, 250],
      [290, 340],
    ];
    nodes.forEach((node, i) => {
      node.position = positions[i];
    });
  }
  return { nodes, wires, groups };
}
export function moveGraph(graph: Graph, proposal: MoveProposal): Graph {
  const positions = new Map(proposal.moves.map((m) => [m.component.id, m.position]));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    })),
  };
}
export function deleteItems(graph: Graph, ids: readonly string[]): Graph {
  const removed = new Set(ids),
    nodes = graph.nodes.filter((node) => !removed.has(node.id));
  const available = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    wires: graph.wires
      .filter((wire) => !removed.has(wire.id))
      .map((wire) => ({ ...wire, ends: wire.ends.filter((end) => available.has(end.id)) }))
      .filter(
        (wire) =>
          wire.ends.some((e) => e.role === 'source') && wire.ends.some((e) => e.role === 'target'),
      ),
    groups: Object.fromEntries(
      Object.entries(graph.groups).map(([id, group]) => [
        id,
        {
          ...group,
          components: Object.fromEntries(
            Object.entries(group.components).map(([type, rows]) => [
              type,
              rows.kind === 'ids'
                ? { ...rows, ids: rows.ids.filter((id) => available.has(id)) }
                : rows,
            ]),
          ),
        },
      ]),
    ),
  };
}
export function addBlock(
  graph: Graph,
  type: NodeType,
  position: Point,
): { graph: Graph; node: Block } {
  const node: Block = {
    id: 'block-' + crypto.randomUUID(),
    type,
    name: 'New ' + type.toLowerCase(),
    position,
    signal: 0.5,
    status: 0,
    visible: 1,
  };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
}
export function connectGraph(
  graph: Graph,
  gesture: ConnectionGesture,
  createOnDrop = false,
): Graph {
  let next = graph;
  const source = graph.nodes.find((node) => node.id === gesture.from.id);
  if (!source) throw new Error('The starting component was removed.');
  const inputPort = gesture.from.port
    ? schema.components[source.type].ports?.[gesture.from.port]?.direction === 'in'
    : false;
  let target = gesture.to;
  if (!target) {
    if (gesture.replaces) {
      const { connection, endpoint } = gesture.replaces;
      return {
        ...graph,
        wires: graph.wires
          .map((wire) =>
            wire.id === connection.id
              ? { ...wire, ends: wire.ends.filter((_, i) => i !== endpoint.ordinal) }
              : wire,
          )
          .filter(
            (wire) =>
              wire.ends.some((end) => end.role === 'source') &&
              wire.ends.some((end) => end.role === 'target'),
          ),
      };
    }
    if (!createOnDrop) return graph;
    const added = addBlock(next, 'Process', gesture.position);
    next = added.graph;
    target = {
      kind: 'component',
      type: added.node.type,
      id: added.node.id,
      port: inputPort ? 'out' : 'in',
    };
  }
  const a: End = {
    id: source.id,
    port: gesture.from.port ?? null,
    role: inputPort ? 'target' : 'source',
  };
  if (target.kind === 'connection') {
    return {
      ...next,
      wires: next.wires.map((wire) =>
        wire.id === target.id && !wire.ends.some((end) => end.id === a.id && end.port === a.port)
          ? { ...wire, ends: [...wire.ends, a] }
          : wire,
      ),
    };
  }
  const destination = next.nodes.find((node) => node.id === target.id);
  if (!destination) throw new Error('The destination was removed.');
  const b: End = {
    id: destination.id,
    port: target.port ?? null,
    role: inputPort ? 'source' : 'target',
  };
  if (gesture.replaces) {
    return {
      ...next,
      wires: next.wires.map((wire) =>
        wire.id === gesture.replaces!.connection.id
          ? {
              ...wire,
              ends: wire.ends.map((end, i) =>
                i === gesture.replaces!.endpoint.ordinal ? { ...b, role: end.role } : end,
              ),
            }
          : wire,
      ),
    };
  }
  return {
    ...next,
    wires: [
      ...next.wires,
      { id: 'wire-' + crypto.randomUUID(), name: 'New signal', signal: 0.5, ends: [a, b] },
    ],
  };
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
