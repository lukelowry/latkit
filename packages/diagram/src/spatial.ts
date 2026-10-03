import { failure } from '@latkit/model';
import type { Rect } from './scene.js';
export function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
export function union(rectangles: readonly Rect[]): Rect {
  if (!rectangles.length) return [0, 0, 0, 0];
  let x = Infinity,
    y = Infinity,
    r = -Infinity,
    b = -Infinity;
  for (const q of rectangles) {
    x = Math.min(x, q[0]);
    y = Math.min(y, q[1]);
    r = Math.max(r, q[2]);
    b = Math.max(b, q[3]);
  }
  return [x, y, r, b];
}
export function expand(r: Rect, n: number): Rect {
  return [r[0] - n, r[1] - n, r[2] + n, r[3] + n];
}
/** Bounded uniform index. Oversized entries/queries use a finite fallback. */
export class SpatialIndex {
  private cells = new Map<string, number[]>();
  private large: number[] = [];
  readonly boxes: Rect[] = [];
  bytes = 0;
  constructor(
    private readonly maxBytes = 32 * 1024 ** 2,
    private readonly pitch = 128,
  ) {}
  add(box: Rect): number {
    const id = this.boxes.length;
    this.boxes.push(box);
    this.bytes += 48;
    const x = Math.floor(box[0] / this.pitch),
      y = Math.floor(box[1] / this.pitch),
      r = Math.floor(box[2] / this.pitch),
      b = Math.floor(box[3] / this.pitch);
    if ((r - x + 1) * (b - y + 1) > 256) {
      this.large.push(id);
      this.bytes += 8;
    } else
      for (let j = y; j <= b; j++)
        for (let i = x; i <= r; i++) {
          const key = i + ',' + j;
          let cell = this.cells.get(key);
          if (!cell) {
            cell = [];
            this.cells.set(key, cell);
            this.bytes += 80;
          }
          cell.push(id);
          this.bytes += 8;
        }
    if (this.bytes > this.maxBytes) throw failure('resource-limit', 'Spatial index exceeds budget');
    return id;
  }
  /** Entries meeting the box; `check` bounds a scan of every entry. */
  query(box: Rect, check?: () => void): number[] {
    const x = Math.floor(box[0] / this.pitch),
      y = Math.floor(box[1] / this.pitch),
      r = Math.floor(box[2] / this.pitch),
      b = Math.floor(box[3] / this.pitch);
    if ((r - x + 1) * (b - y + 1) > 4096) {
      const found: number[] = [];
      for (let i = 0; i < this.boxes.length; i++) {
        check?.();
        if (intersects(this.boxes[i], box)) found.push(i);
      }
      return found;
    }
    const found = new Set(this.large);
    for (let j = y; j <= b; j++)
      for (let i = x; i <= r; i++) {
        check?.();
        for (const id of this.cells.get(i + ',' + j) ?? []) found.add(id);
      }
    return [...found].filter((id) => intersects(this.boxes[id], box));
  }
}
