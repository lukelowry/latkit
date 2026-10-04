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
  /** Item keys drawn offset by the drag: its vertices, their ports, and its groups. */
  readonly moving: ReadonlySet<string>;
  /** Item keys of the rerouted edges, hidden while their new wires draw. */
  readonly rerouted: ReadonlySet<string>;
}
/** A drag drawn over a still scene: what moves, how far, and the wires it reroutes. */
export interface DragDraw {
  readonly marks: DragMarks;
  readonly delta: Point;
  readonly wires: readonly (Wire & { readonly edge: Edge })[];
}

/** Find what dragging the items with these keys moves. */
export function dragMarks(scene: Scene, keys: ReadonlySet<string>): DragMarks {
  const parents = new Map(scene.groups.map((group) => [group.id, group.parent])),
    groups = new Set<string>();
  for (const group of scene.groups)
    for (let id: string | undefined = group.id; id; id = parents.get(id))
      if (keys.has(itemKey({ kind: 'group', id }))) {
        groups.add(group.id);
        break;
      }
  const vertices: number[] = [],
    moving = new Set<string>();
  scene.vertices.forEach((vertex, i) => {
    const key = itemKey(vertex.hit);
    if (!keys.has(key)) return;
    vertices.push(i);
    moving.add(key);
    for (const port of vertex.ports)
      moving.add(itemKey({ ...vertex.hit, kind: 'port', port: port.name }));
  });
  for (const id of groups) moving.add(itemKey({ kind: 'group', id }));
  const moved = new Set(vertices),
    edges: number[] = [],
    rerouted = new Set<string>();
  scene.edges.forEach((edge, i) => {
    if (!edge.ends.some((end) => moved.has(end.vertex))) return;
    edges.push(i);
    rerouted.add(itemKey(edge.hit));
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
