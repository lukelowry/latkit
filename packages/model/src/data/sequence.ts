/** Persistent concatenation tree. Leaf size follows the supplied batch, not a data limit. */
type Node<T> = {
  readonly length: number;
  readonly height: number;
  readonly last: T;
} & ({ readonly values: readonly T[] } | { readonly left: Node<T>; readonly right: Node<T> });

function branch<T>(left: Node<T>, right: Node<T>): Node<T> {
  return {
    left,
    right,
    length: left.length + right.length,
    height: 1 + Math.max(left.height, right.height),
    last: right.last,
  };
}
function balance<T>(left: Node<T>, right: Node<T>): Node<T> {
  if (left.height > right.height + 1 && 'left' in left) {
    if (left.left.height >= left.right.height) return branch(left.left, branch(left.right, right));
    const middle = left.right;
    if ('left' in middle)
      return branch(branch(left.left, middle.left), branch(middle.right, right));
  }
  if (right.height > left.height + 1 && 'left' in right) {
    if (right.right.height >= right.left.height)
      return branch(branch(left, right.left), right.right);
    const middle = right.left;
    if ('left' in middle)
      return branch(branch(left, middle.left), branch(middle.right, right.right));
  }
  return branch(left, right);
}
function join<T>(left: Node<T> | undefined, right: Node<T> | undefined): Node<T> | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.height > right.height + 1 && 'left' in left)
    return balance(left.left, join(left.right, right)!);
  if (right.height > left.height + 1 && 'left' in right)
    return balance(join(left, right.left)!, right.right);
  return branch(left, right);
}
function* range<T>(node: Node<T> | undefined, first: number, end: number): Generator<T> {
  if (!node || first >= node.length || end <= 0 || first >= end) return;
  if ('values' in node) {
    for (let i = Math.max(0, first); i < Math.min(end, node.length); i++) yield node.values[i];
  } else {
    yield* range(node.left, first, end);
    yield* range(node.right, first - node.left.length, end - node.left.length);
  }
}
function equalRange<T>(a: Node<T>, ai: number, b: Node<T>, bi: number, count: number): boolean {
  if (!count) return true;
  while ('left' in a) {
    if (ai >= a.left.length) {
      ai -= a.left.length;
      a = a.right;
    } else if (ai + count <= a.left.length) a = a.left;
    else break;
  }
  while ('left' in b) {
    if (bi >= b.left.length) {
      bi -= b.left.length;
      b = b.right;
    } else if (bi + count <= b.left.length) b = b.left;
    else break;
  }
  if (a === b && ai === bi) return true;
  if ('values' in a && 'values' in b) {
    for (let i = 0; i < count; i++) if (a.values[ai + i] !== b.values[bi + i]) return false;
    return true;
  }
  const split = Math.min(
    'left' in a ? a.left.length - ai : count,
    'left' in b ? b.left.length - bi : count,
  );
  return equalRange(a, ai, b, bi, split) && equalRange(a, ai + split, b, bi + split, count - split);
}
export class Sequence<T> implements Iterable<T> {
  private constructor(private readonly root?: Node<T>) {}
  static empty<T>(): Sequence<T> {
    return new Sequence<T>();
  }
  get length(): number {
    return this.root?.length ?? 0;
  }
  append(values: readonly T[]): Sequence<T> {
    if (!values.length) return this;
    return new Sequence(
      join(this.root, { values, length: values.length, height: 1, last: values.at(-1)! }),
    );
  }
  at(index: number): T | undefined {
    index = Math.trunc(index) || 0;
    if (index < 0) index += this.length;
    let node = this.root;
    if (!node || index < 0 || index >= node.length) return undefined;
    while (!('values' in node)) {
      if (index < node.left.length) node = node.left;
      else {
        index -= node.left.length;
        node = node.right;
      }
    }
    return node.values[index];
  }
  /** First matching item for a monotone predicate, or length. Visits one tree path. */
  lowerBound(matches: (value: T) => boolean): number {
    let node = this.root,
      offset = 0;
    if (!node || !matches(node.last)) return this.length;
    while (!('values' in node)) {
      if (matches(node.left.last)) node = node.left;
      else {
        offset += node.left.length;
        node = node.right;
      }
    }
    let lo = 0,
      hi = node.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (matches(node.values[mid])) hi = mid;
      else lo = mid + 1;
    }
    return offset + lo;
  }
  startsWith(other: Sequence<T>): boolean {
    return (
      other.length <= this.length &&
      (!other.root || equalRange(this.root!, 0, other.root, 0, other.length))
    );
  }
  range(first = 0, end = this.length): Iterable<T> {
    return range(this.root, first, end);
  }
  [Symbol.iterator](): Iterator<T> {
    return this.range()[Symbol.iterator]();
  }
}
