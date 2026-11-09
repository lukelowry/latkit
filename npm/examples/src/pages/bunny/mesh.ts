/**
 * The Stanford bunny, from the Stanford 3D Scanning Repository
 * (graphics.stanford.edu/data/3Dscanrep), as shipped by the public-domain `bunny` package: a
 * closed, low-resolution reconstruction.
 *
 * The file holds the vertex and triangle counts as two uint32s, then float32 x, y, z per vertex
 * with y up, then uint16 triangles wound outward.
 */
export interface Mesh {
  readonly count: number;
  /** x, y, z per vertex in meters, z up, resting on z = 0 and centered over the origin. */
  readonly positions: Float64Array;
  /** The three corners of each outward-wound triangle, one column per corner. */
  readonly faces: { readonly a: Uint32Array; readonly b: Uint32Array; readonly c: Uint32Array };
  /** Every triangle edge, listed once. They are the springs and the wireframe. */
  readonly springs: { readonly a: Uint32Array; readonly b: Uint32Array };
}

/** Undirected triangle edges, each listed once. The topology is shared by springs and drawing. */
export function wireframe(faces: Mesh['faces']): Mesh['springs'] {
  const seen = new Map<number, Set<number>>();
  const a: number[] = [];
  const b: number[] = [];
  const corners = [faces.a, faces.b, faces.c];
  for (let t = 0; t < faces.a.length; t++) {
    for (let k = 0; k < 3; k++) {
      const u = corners[k]![t]!;
      const v = corners[(k + 1) % 3]![t]!;
      if (u === v) continue;
      const lo = Math.min(u, v);
      const hi = Math.max(u, v);
      let ends = seen.get(lo);
      if (!ends) seen.set(lo, (ends = new Set()));
      if (ends.has(hi)) continue;
      ends.add(hi);
      a.push(lo);
      b.push(hi);
    }
  }
  return { a: Uint32Array.from(a), b: Uint32Array.from(b) };
}

export async function loadMesh(url: URL, height = 2.4): Promise<Mesh> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the bunny mesh: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const [count, faces] = new Uint32Array(bytes, 0, 2) as unknown as [number, number];
  const scan = new Float32Array(bytes, 8, count * 3);
  const triangles = new Uint16Array(bytes, 8 + count * 12, faces * 3);
  // The scan is y up. Rotate it to z up, which keeps its triangles wound outward.
  const positions = new Float64Array(count * 3);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const p = [scan[i * 3]!, -scan[i * 3 + 2]!, scan[i * 3 + 1]!];
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = p[k]!;
      lo[k] = Math.min(lo[k]!, p[k]!);
      hi[k] = Math.max(hi[k]!, p[k]!);
    }
  }
  const scale = height / (hi[2]! - lo[2]!);
  const center = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, lo[2]!];
  for (let i = 0; i < positions.length; i++)
    positions[i] = (positions[i]! - center[i % 3]!) * scale;
  const corner = (k: number) =>
    Uint32Array.from({ length: faces }, (_, t) => triangles[t * 3 + k]!);
  const topology = { a: corner(0), b: corner(1), c: corner(2) };
  return {
    count,
    positions,
    faces: topology,
    springs: wireframe(topology),
  };
}
