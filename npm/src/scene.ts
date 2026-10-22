/**
 * The expression builders that write scenes' options. A scene is plain data the view reads, its
 * types written from the forms latkit reads (`inputs.ts`); nothing here needs WebAssembly.
 */

import type {
  Binary,
  Colormap,
  ExprNode,
  FieldNode,
  Marker,
  Size,
  State,
  Unary,
} from './inputs.js';

/** A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. Where an option takes an expression, a
 * string starting with `#` is a hex color and any other string names a field. */
export type Color = string;

/** What an expression is written as: an {@link Expr}, or its JSON form. */
export type ExprInput = Expr | ExprNode;

const nodeOf = (input: ExprInput): ExprNode => (input instanceof Expr ? input.node : input);

/** A value for every row of a mark: a constant, a field, view state, or arithmetic of them. */
export class Expr {
  /** An expression from its JSON form; use the builders for common operations. */
  constructor(readonly node: ExprNode) {}

  toJSON(): ExprNode {
    return this.node;
  }

  /** Reads this expression's fields from `table` of dataset `data`, joined by row id. */
  of(data: string, table: string): Expr {
    return new Expr(mapFields(this.node, (f) => ({ ...f, of: [data, table] })));
  }

  /** Reads sampled fields at their last frame without interpolating. */
  step(): Expr {
    return new Expr(mapFields(this.node, (f) => ({ ...f, step: true })));
  }

  add(other: ExprInput): Expr {
    return binary('add', this, other);
  }
  sub(other: ExprInput): Expr {
    return binary('sub', this, other);
  }
  mul(other: ExprInput): Expr {
    return binary('mul', this, other);
  }
  div(other: ExprInput): Expr {
    return binary('div', this, other);
  }
  rem(other: ExprInput): Expr {
    return binary('rem', this, other);
  }
  pow(other: ExprInput): Expr {
    return binary('pow', this, other);
  }
  min(other: ExprInput): Expr {
    return binary('min', this, other);
  }
  max(other: ExprInput): Expr {
    return binary('max', this, other);
  }
  clamp(low: ExprInput, high: ExprInput): Expr {
    return this.max(low).min(high);
  }
  lt(other: ExprInput): Expr {
    return binary('lt', this, other);
  }
  le(other: ExprInput): Expr {
    return binary('le', this, other);
  }
  gt(other: ExprInput): Expr {
    return binary('gt', this, other);
  }
  ge(other: ExprInput): Expr {
    return binary('ge', this, other);
  }
  eq(other: ExprInput): Expr {
    return binary('eq', this, other);
  }
  ne(other: ExprInput): Expr {
    return binary('ne', this, other);
  }
  and(other: ExprInput): Expr {
    return binary('and', this, other);
  }
  or(other: ExprInput): Expr {
    return binary('or', this, other);
  }
  not(): Expr {
    return unary('not', this);
  }
  neg(): Expr {
    return unary('neg', this);
  }
  abs(): Expr {
    return unary('abs', this);
  }
  sqrt(): Expr {
    return unary('sqrt', this);
  }
  sin(): Expr {
    return unary('sin', this);
  }
  cos(): Expr {
    return unary('cos', this);
  }
  floor(): Expr {
    return unary('floor', this);
  }
  ln(): Expr {
    return unary('ln', this);
  }
  exp(): Expr {
    return unary('exp', this);
  }

  /** Whether a text field equals `text`. */
  is(text: string): Expr {
    return new Expr({ is: [this.node, text] });
  }

  /** Whether a text field holds `text`, ignoring case. Queries read it; marks do not. */
  contains(text: string): Expr {
    return new Expr({ contains: [this.node, text] });
  }

  /** The value through `map`: a catalog name, or your own colors. */
  colormap(map: Colormap): Mapped {
    return new Mapped({ colormap: map, value: this.node });
  }

  /** The value mapped linearly onto `[low, high]`, clamped. */
  scale(low: number, high: number): Mapped {
    return new Mapped({ scale: [low, high], value: this.node });
  }
}

/** A value through a colormap or onto a range, whose domain can be set. */
export class Mapped extends Expr {
  /** The input values that map to the ends; it fits the values shown unless set. */
  domain(low: number, high: number): Mapped {
    return new Mapped({ ...(this.node as MappedNode), domain: [low, high] });
  }
}

type MappedNode = Extract<ExprNode, { value: unknown }>;

const unary = (op: Unary, a: ExprInput): Expr => new Expr({ op, args: [nodeOf(a)] });
const binary = (op: Binary, a: ExprInput, b: ExprInput): Expr =>
  new Expr({ op, args: [nodeOf(a), nodeOf(b)] });

/** `node` with every field read through `f`; a string starting with `#` is a color, not a field. */
function mapFields(input: ExprInput, f: (field: FieldNode) => FieldNode): ExprNode {
  const node = nodeOf(input);
  if (typeof node === 'string') return node.startsWith('#') ? node : f({ field: node });
  if (typeof node !== 'object') return node;
  const map = (child: ExprInput) => mapFields(child, f);
  if ('field' in node) return f(node);
  if ('op' in node) return { ...node, args: node.args.map(map) } as ExprNode;
  if ('when' in node) {
    const cases = node.when.map(([c, v]): [ExprNode, ExprNode] => [map(c), map(v)]);
    return { when: cases, otherwise: map(node.otherwise) };
  }
  if ('is' in node) return { is: [map(node.is[0]), node.is[1]] };
  if ('contains' in node) return { contains: [map(node.contains[0]), node.contains[1]] };
  if ('value' in node) return { ...node, value: map(node.value) };
  return node;
}

const state = (name: State): Expr => new Expr({ state: name });

/** The field `name` of each row. */
export const field = (name: string): Expr => new Expr({ field: name });
/** A color constant. */
export const color = (css: Color): Expr => new Expr({ color: css });
/** Seconds since the view was created. */
export const elapsed = (): Expr => state('elapsed');
/** A missing value: options that read one take the theme's. */
export const missing = (): Expr => new Expr({ missing: true });
/**
 * A size in position units, so it scales as the view zooms, kept within `atLeast` and `atMost` CSS
 * pixels when given: `units('r', { atLeast: 2 })` grows with the map and never vanishes. A marker
 * keeps its proportions, its larger side held.
 */
export const units = (size: ExprInput, px: { atLeast?: number; atMost?: number } = {}): Size => ({
  units: nodeOf(size),
  ...px,
});

/** Starts a conditional: `when(c).then(a).when(d).then(b).otherwise(e)`. */
export function when(condition: ExprInput): When {
  return new When([], nodeOf(condition));
}

class When {
  constructor(
    private readonly cases: [ExprNode, ExprNode][],
    private readonly condition: ExprNode,
  ) {}
  then(value: ExprInput): Then {
    return new Then([...this.cases, [this.condition, nodeOf(value)]]);
  }
}

class Then {
  constructor(private readonly cases: [ExprNode, ExprNode][]) {}
  when(condition: ExprInput): When {
    return new When(this.cases, nodeOf(condition));
  }
  otherwise(value: ExprInput): Expr {
    return new Expr({ when: this.cases, otherwise: nodeOf(value) });
  }
}

/** Straight-alpha RGBA pixels, compatible with browser ImageData and server-produced pixels. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** An icon marker showing one of `images` for each row, picked by `index`. */
export function icon(images: readonly RgbaImage[], index: ExprInput): Marker {
  return {
    icon: {
      images: images.map((image) => ({
        size: [image.width, image.height],
        rgba: Array.from(image.data),
      })),
      index,
    },
  };
}
