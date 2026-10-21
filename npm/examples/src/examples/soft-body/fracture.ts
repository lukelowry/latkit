import type { Mesh } from './mesh.js';

export type Vec3 = [number, number, number];

/** A cut vertex follows a weighted combination of the original surface vertices. */
export interface CutVertex {
  p: Vec3;
  weights: Map<number, number>;
}

export interface Piece {
  vertices: CutVertex[];
  faces: [number, number, number][];
}

const EPS = 1e-7;

/** Split the closed mesh into independently capped solids, once at page load. */
export function fracture(mesh: Mesh, count = 24): Piece[] {
  const first: Piece = {
    vertices: Array.from({ length: mesh.count }, (_, i) => ({
      p: Array.from(mesh.positions.slice(i * 3, i * 3 + 3)) as Vec3,
      weights: new Map([[i, 1]]),
    })),
    faces: Array.from(mesh.faces.a, (a, i) => [a, mesh.faces.b[i]!, mesh.faces.c[i]!]),
  };
  const pieces = [first];
  while (pieces.length < count) {
    // Cut the largest bounding volume, with stable ordering for repeatable pieces.
    const bounds = pieces.map((piece) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const { p } of piece.vertices)
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a]!, p[a]!);
          hi[a] = Math.max(hi[a]!, p[a]!);
        }
      return { lo, size: hi.map((v, a) => v - lo[a]!) };
    });
    let index = 0;
    for (let i = 1; i < pieces.length; i++)
      if (bounds[i]!.size.reduce((a, b) => a * b) > bounds[index]!.size.reduce((a, b) => a * b))
        index = i;
    const { lo, size } = bounds[index]!;
    const axis = size.indexOf(Math.max(...size));
    // An off-center cut avoids vertices exactly on the plane and overly regular cubes.
    const at = lo[axis]! + size[axis]! * (0.46 + (pieces.length % 3) * 0.04);
    const halves = split(pieces[index]!, axis, at);
    pieces.splice(index, 1, ...halves);
  }
  return pieces;
}

function split(piece: Piece, axis: number, at: number): [Piece, Piece] {
  const vertices = [...piece.vertices];
  const intersections = new Map<string, number>();
  const sides: [Piece, Piece] = [
    { vertices, faces: [] },
    { vertices, faces: [] },
  ];
  const segments: [number, number][] = [];

  const intersect = (a: number, b: number): number => {
    if (Math.abs(vertices[a]!.p[axis]! - at) < EPS) return a;
    if (Math.abs(vertices[b]!.p[axis]! - at) < EPS) return b;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const known = intersections.get(key);
    if (known !== undefined) return known;
    const va = vertices[a]!;
    const vb = vertices[b]!;
    const t = (at - va.p[axis]!) / (vb.p[axis]! - va.p[axis]!);
    const weights = new Map<number, number>();
    for (const [i, w] of va.weights) weights.set(i, w * (1 - t));
    for (const [i, w] of vb.weights) weights.set(i, (weights.get(i) ?? 0) + w * t);
    const p = va.p.map((v, k) => v + (vb.p[k]! - v) * t) as Vec3;
    p[axis] = at;
    const id = vertices.push({ p, weights }) - 1;
    intersections.set(key, id);
    return id;
  };

  for (const face of piece.faces) {
    const cut = new Set<number>();
    for (let side = 0; side < 2; side++) {
      const polygon: number[] = [];
      for (let e = 0; e < 3; e++) {
        const a = face[e]!;
        const b = face[(e + 1) % 3]!;
        const da = vertices[a]!.p[axis]! - at;
        const db = vertices[b]!.p[axis]! - at;
        const inside = side === 0 ? da <= 0 : da >= 0;
        const nextInside = side === 0 ? db <= 0 : db >= 0;
        if (inside) polygon.push(a);
        if (inside !== nextInside) {
          const id = intersect(a, b);
          polygon.push(id);
          cut.add(id);
        }
      }
      const unique = [...new Set(polygon)];
      for (let i = 1; i + 1 < unique.length; i++)
        sides[side]!.faces.push([unique[0]!, unique[i]!, unique[i + 1]!]);
    }
    if (cut.size === 2) segments.push([...cut] as [number, number]);
  }

  // Each cut boundary is a loop; triangulate concave loops instead of a center fan.
  const neighbors = new Map<number, number[]>();
  for (const [a, b] of segments) {
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }
  const remaining = new Set(neighbors.keys());
  while (remaining.size) {
    const start = remaining.values().next().value!;
    const loop = [start];
    remaining.delete(start);
    let previous = -1;
    let current = start;
    for (;;) {
      const next = neighbors
        .get(current)
        ?.find((id) => id !== previous && (remaining.has(id) || id === start));
      if (next === undefined) throw new Error('The bunny cut has an open boundary');
      if (next === start) break;
      loop.push(next);
      remaining.delete(next);
      previous = current;
      current = next;
    }
    for (const [a, b, c] of cap(loop, vertices, axis)) {
      sides[0].faces.push([a, b, c]);
      sides[1].faces.push([c, b, a]);
    }
  }
  return sides.map(compact) as [Piece, Piece];
}

/** Counterclockwise triangles viewed along the positive cut axis. */
function cap(loop: number[], vertices: CutVertex[], axis: number): [number, number, number][] {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const area = (a: number, b: number, c: number): number => {
    const [pa, pb, pc] = [vertices[a]!.p, vertices[b]!.p, vertices[c]!.p];
    return (pb[u]! - pa[u]!) * (pc[v]! - pa[v]!) - (pb[v]! - pa[v]!) * (pc[u]! - pa[u]!);
  };
  let signed = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = vertices[loop[i]!]!.p;
    const b = vertices[loop[(i + 1) % loop.length]!]!.p;
    signed += a[u]! * b[v]! - b[u]! * a[v]!;
  }
  if (signed < 0) loop.reverse();
  const triangles: [number, number, number][] = [];
  while (loop.length > 3) {
    let found = false;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[(i + loop.length - 1) % loop.length]!;
      const b = loop[i]!;
      const c = loop[(i + 1) % loop.length]!;
      if (area(a, b, c) <= 1e-12) continue;
      if (
        loop.some(
          (p) =>
            p !== a &&
            p !== b &&
            p !== c &&
            area(a, b, p) >= -1e-12 &&
            area(b, c, p) >= -1e-12 &&
            area(c, a, p) >= -1e-12,
        )
      )
        continue;
      triangles.push([a, b, c]);
      loop.splice(i, 1);
      found = true;
      break;
    }
    if (!found) throw new Error('The bunny cut could not be capped');
  }
  if (loop.length === 3) triangles.push(loop as [number, number, number]);
  return triangles;
}

function compact(piece: Piece): Piece {
  const ids = new Map<number, number>();
  const vertices: CutVertex[] = [];
  const faces = piece.faces.map(
    (face) =>
      face.map((id) => {
        if (!ids.has(id)) {
          ids.set(id, vertices.length);
          vertices.push(piece.vertices[id]!);
        }
        return ids.get(id)!;
      }) as [number, number, number],
  );
  return { vertices, faces };
}
