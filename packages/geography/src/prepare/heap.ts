/**
 * A min-heap of integer handles by numeric key, with `before` ordering handles whose keys are equal.
 * It tracks where each handle sits, so a handle's key can change in place. Each node has four
 * children, which halves the depth and keeps siblings in one cache line on heaps of millions.
 */
export class Heap {
  private handles: Int32Array;
  private keys: Float64Array;
  private positions: Int32Array;
  private count = 0;

  constructor(
    capacity: number,
    private readonly before: (a: number, b: number) => boolean,
  ) {
    const size = Math.max(capacity, 1);
    this.handles = new Int32Array(size);
    this.keys = new Float64Array(size);
    this.positions = new Int32Array(size).fill(-1);
  }

  /** The handles in the heap. */
  get size(): number {
    return this.count;
  }

  push(handle: number, key: number): void {
    if (handle >= this.positions.length) this.growPositions(handle + 1);
    if (this.count === this.handles.length) this.growItems();
    const at = this.count++;
    this.handles[at] = handle;
    this.keys[at] = key;
    this.positions[handle] = at;
    this.up(at);
  }

  /** Removes and returns the handle with the least key. */
  pop(): number {
    const { handles, keys, positions } = this,
      top = handles[0],
      last = --this.count;
    positions[top] = -1;
    if (last > 0) {
      handles[0] = handles[last];
      keys[0] = keys[last];
      positions[handles[0]] = 0;
      this.down(0);
    }
    return top;
  }

  /** Changes the key of a handle in the heap, moving it to its new place. */
  update(handle: number, key: number): void {
    const at = this.positions[handle];
    if (at < 0) return;
    const old = this.keys[at];
    this.keys[at] = key;
    if (key < old) this.up(at);
    else this.down(at);
  }

  clear(): void {
    for (let i = 0; i < this.count; i++) this.positions[this.handles[i]] = -1;
    this.count = 0;
  }

  /** Whether the item with key `a` and handle `ha` comes before the one with key `b` and handle `hb`. */
  private precedes(a: number, ha: number, b: number, hb: number): boolean {
    return a < b || (a === b && this.before(ha, hb));
  }

  /** Moves the item at `at` toward the root, shifting parents down into the hole it leaves. */
  private up(at: number): void {
    const { handles, keys, positions } = this,
      handle = handles[at],
      key = keys[at];
    while (at > 0) {
      const parent = (at - 1) >> 2;
      if (!this.precedes(key, handle, keys[parent], handles[parent])) break;
      handles[at] = handles[parent];
      keys[at] = keys[parent];
      positions[handles[at]] = at;
      at = parent;
    }
    handles[at] = handle;
    keys[at] = key;
    positions[handle] = at;
  }

  /** Moves the item at `at` toward the leaves, shifting the least child up into the hole it leaves. */
  private down(at: number): void {
    const { handles, keys, positions, count } = this,
      handle = handles[at],
      key = keys[at];
    for (;;) {
      const first = 4 * at + 1;
      if (first >= count) break;
      let child = first;
      for (let c = first + 1; c < first + 4 && c < count; c++)
        if (this.precedes(keys[c], handles[c], keys[child], handles[child])) child = c;
      if (!this.precedes(keys[child], handles[child], key, handle)) break;
      handles[at] = handles[child];
      keys[at] = keys[child];
      positions[handles[at]] = at;
      at = child;
    }
    handles[at] = handle;
    keys[at] = key;
    positions[handle] = at;
  }

  private growItems(): void {
    const size = 2 * this.handles.length,
      handles = new Int32Array(size),
      keys = new Float64Array(size);
    handles.set(this.handles);
    keys.set(this.keys);
    this.handles = handles;
    this.keys = keys;
  }

  private growPositions(length: number): void {
    const positions = new Int32Array(Math.max(length, 2 * this.positions.length)).fill(-1);
    positions.set(this.positions);
    this.positions = positions;
  }
}
