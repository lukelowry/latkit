import type { Point } from './data.js';
import { itemKey } from './data.js';
import type { Moved } from './route.js';
import type { Edge, Scene, Vertex, Wire } from './scene.js';

/** What a drag moves in one scene, found once when it starts. */
export interface DragMarks {
  readonly vertices: readonly number[];
  /** Groups that move with their vertices: the dragged ones and the groups inside them. */
  readonly groups: ReadonlySet<string>;
  /** Edges with an end on a moving vertex, which the drag reroutes. */
  readonly edges: readonly number[];
  /** Slots drawn offset by the drag: its vertices, their ports, and its groups. */
  readonly moving: ReadonlySet<number>;
  /** Slots of the rerouted edges, hidden while their new wires draw. */
  readonly rerouted: ReadonlySet<number>;
}
/** A rerouted wire, its edge's slot, and where its label goes. */
export type DragWire = Wire & {
  readonly edge: Edge;
  readonly slot: number;
  readonly labels: readonly Point[];
};
/** A drag drawn over a still scene: what moves, how far, and the wires it reroutes. */
export interface DragDraw {
  readonly marks: DragMarks;
  readonly delta: Point;
  readonly wires: readonly DragWire[];
}

/** Find what dragging the items with these keys moves. */
export function dragMarks(scene: Scene, keys: ReadonlySet<string>): DragMarks {
  const parents = new Map(scene.groups.map((group) => [group.id, group.parent])),
    groups = new Set<string>(),
    moving = new Set<number>();
  scene.groups.forEach((group, i) => {
    for (let id: string | undefined = group.id; id; id = parents.get(id))
      if (keys.has(itemKey({ kind: 'group', id }))) {
        groups.add(group.id);
        moving.add(scene.slots.groups + i);
        break;
      }
  });
  const vertices: number[] = [];
  scene.vertices.forEach((vertex, i) => {
    if (!keys.has(itemKey(vertex.hit))) return;
    vertices.push(i);
    moving.add(i);
    for (let k = 0; k < vertex.ports.length; k++) moving.add(vertex.portSlot + k);
  });
  const moved = new Set(vertices),
    edges: number[] = [],
    rerouted = new Set<number>();
  scene.edges.forEach((edge, i) => {
    if (!edge.ends.some((end) => moved.has(end.vertex))) return;
    edges.push(i);
    rerouted.add(scene.slots.edges + i);
  });
  return { vertices, groups, edges, moving, rerouted };
}

/** The moving vertices where the drag has taken them. */
export function moved(scene: Scene, marks: DragMarks, delta: Point): Moved {
  return {
    vertices: new Map(marks.vertices.map((i) => [i, translated(scene.vertices[i], delta)])),
    groups: marks.groups,
    delta,
  };
}
function translated(vertex: Vertex, delta: Point): Vertex {
  return {
    ...vertex,
    x: vertex.x + delta[0],
    y: vertex.y + delta[1],
    ports: vertex.ports.map((port) => ({
      ...port,
      position: [port.position[0] + delta[0], port.position[1] + delta[1]],
    })),
  };
}
