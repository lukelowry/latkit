import bunnyUrl from './stanford-bunny.bin?url';

/**
 * The Stanford bunny, from the Stanford 3D Scanning Repository
 * (graphics.stanford.edu/data/3Dscanrep), as the public-domain `bunny` package ships it: a closed
 * low-resolution reconstruction. The file holds its vertex and triangle counts as two uint32s,
 * then float32 x, y, z per vertex with y up, then uint16 triangles wound outward.
 */
export interface Mesh {
  readonly count: number;
  /** x, y, z per vertex in meters, z up, resting on z = 0 and centered over the origin. */
  readonly positions: Float64Array;
  /** Outward triangles, three vertices each. */
  readonly triangles: Uint32Array;
  /** Each triangle side once: what the network draws, and the springs. */
  readonly edges: Uint32Array;
}

export async function loadBunny(height = 2.4): Promise<Mesh> {
  const response = await fetch(bunnyUrl);
  if (!response.ok) throw new Error(`Bunny mesh: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const [count, faces] = new Uint32Array(bytes, 0, 2) as unknown as [number, number];
  const scan = new Float32Array(bytes, 8, count * 3);
  const triangles = Uint32Array.from(new Uint16Array(bytes, 8 + count * 12, faces * 3));
  // The scan is y up; turn it z up, which keeps its triangles wound outward.
  const positions = new Float64Array(count * 3);
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const p = [scan[i * 3]!, -scan[i * 3 + 2]!, scan[i * 3 + 1]!];
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = p[a]!;
      lo[a] = Math.min(lo[a]!, p[a]!);
      hi[a] = Math.max(hi[a]!, p[a]!);
    }
  }
  const scale = height / (hi[2]! - lo[2]!),
    center = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, lo[2]!];
  for (let i = 0; i < positions.length; i++)
    positions[i] = (positions[i]! - center[i % 3]!) * scale;
  const seen = new Set<number>(),
    edges: number[] = [];
  for (let t = 0; t < triangles.length; t += 3)
    for (let s = 0; s < 3; s++) {
      const a = triangles[t + s]!,
        b = triangles[t + ((s + 1) % 3)]!;
      const key = Math.min(a, b) * count + Math.max(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(a, b);
    }
  return { count, positions, triangles, edges: Uint32Array.from(edges) };
}
