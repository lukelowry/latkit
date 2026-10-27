/**
 * Builders for the expressions that scene options take. A scene is plain data, typed in
 * `inputs.ts`; nothing here needs WebAssembly.
 */

import type { TableInput } from './data.js';
import type {
  Colormap,
  ColormapNode,
  ExprNode,
  FieldNode,
  Marker,
  Px,
  ScaleNode,
  State,
  Units,
} from './inputs.js';

/**
 * A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. In an expression, a string that does not
 * start with `$` is a color.
 */
export type Color = string;

/**
 * An option's value: an {@link Expr}, or its JSON form. In the JSON form, `null` is a missing
 * value, a string starting with `$` reads a field (`'$kv'` reads field `kv`), and any other string
 * is a CSS color. Color options take a value that computes a color.
 */
export type ExprInput = Expr | ExprNode;

const nodeOf = (input: ExprInput): ExprNode => (input instanceof Expr ? input.node : input);

/**
 * A value for every row of a mark: a constant, a color, a field, view state, or arithmetic on them.
 * Color options take one that computes a color: a CSS color, a value through a colormap, or a
 * conditional choosing between colors.
 */
export class Expr {
  /** The expression's JSON form. */
  readonly node: ExprNode;

  /** Wraps an expression's JSON form. The builders cover common cases. */
  constructor(node: ExprNode) {
    this.node = node;
  }

  /** The JSON form, which `JSON.stringify` writes for the expression. */
  toJSON(): ExprNode {
    return this.node;
  }

  /**
   * Reads this expression's fields from `table`, such as `weather.table('Station')`, joined by row
   * id. A view draws the table's dataset too.
   */
  from(table: TableInput): Expr {
    return new Expr(mapFields(this.node, (f) => ({ ...f, from: table })));
  }

  /**
   * Reads this expression's sampled fields at the last frame at or before the view's `at`, instead
   * of interpolating toward the next frame.
   */
  step(): Expr {
    return new Expr(mapFields(this.node, (f) => ({ ...f, step: true })));
  }

  /** The sum of this value and `other`. */
  add(other: ExprInput): Expr {
    return new Expr({ add: [this.node, nodeOf(other)] });
  }
  /** This value minus `other`. */
  sub(other: ExprInput): Expr {
    return new Expr({ sub: [this.node, nodeOf(other)] });
  }
  /** The product of this value and `other`. */
  mul(other: ExprInput): Expr {
    return new Expr({ mul: [this.node, nodeOf(other)] });
  }
  /** This value divided by `other`. Dividing by 0 gives a missing value. */
  div(other: ExprInput): Expr {
    return new Expr({ div: [this.node, nodeOf(other)] });
  }
  /** The remainder of this value divided by `other`, with the sign of `other`: `-1 rem 3` is 2. */
  rem(other: ExprInput): Expr {
    return new Expr({ rem: [this.node, nodeOf(other)] });
  }
  /** This value raised to the power `other`. */
  pow(other: ExprInput): Expr {
    return new Expr({ pow: [this.node, nodeOf(other)] });
  }
  /** The smaller of this value and `other`. */
  min(other: ExprInput): Expr {
    return new Expr({ min: [this.node, nodeOf(other)] });
  }
  /** The larger of this value and `other`. */
  max(other: ExprInput): Expr {
    return new Expr({ max: [this.node, nodeOf(other)] });
  }
  /** This value limited to the range from `low` to `high`. */
  clamp(low: ExprInput, high: ExprInput): Expr {
    return this.max(low).min(high);
  }
  /** 1 where this value is less than `other`, else 0. */
  lt(other: ExprInput): Expr {
    return new Expr({ lt: [this.node, nodeOf(other)] });
  }
  /** 1 where this value is at most `other`, else 0. */
  le(other: ExprInput): Expr {
    return new Expr({ le: [this.node, nodeOf(other)] });
  }
  /** 1 where this value is greater than `other`, else 0. */
  gt(other: ExprInput): Expr {
    return new Expr({ gt: [this.node, nodeOf(other)] });
  }
  /** 1 where this value is at least `other`, else 0. */
  ge(other: ExprInput): Expr {
    return new Expr({ ge: [this.node, nodeOf(other)] });
  }
  /** 1 where this value equals `other`, else 0. Colors compare too. */
  eq(other: ExprInput): Expr {
    return new Expr({ eq: [this.node, nodeOf(other)] });
  }
  /** 1 where this value differs from `other`, else 0. Colors compare too. */
  ne(other: ExprInput): Expr {
    return new Expr({ ne: [this.node, nodeOf(other)] });
  }
  /** 1 where this value and `other` are both above 0.5, else 0. */
  and(other: ExprInput): Expr {
    return new Expr({ and: [this.node, nodeOf(other)] });
  }
  /** 1 where this value or `other` is above 0.5, else 0. */
  or(other: ExprInput): Expr {
    return new Expr({ or: [this.node, nodeOf(other)] });
  }
  /** 1 where this value is at most 0.5, else 0. */
  not(): Expr {
    return new Expr({ not: [this.node] });
  }
  /** The value negated. */
  neg(): Expr {
    return new Expr({ neg: [this.node] });
  }
  /** The absolute value. */
  abs(): Expr {
    return new Expr({ abs: [this.node] });
  }
  /** The square root. Negative values give a missing value. */
  sqrt(): Expr {
    return new Expr({ sqrt: [this.node] });
  }
  /** The sine of the value, an angle in radians. */
  sin(): Expr {
    return new Expr({ sin: [this.node] });
  }
  /** The cosine of the value, an angle in radians. */
  cos(): Expr {
    return new Expr({ cos: [this.node] });
  }
  /** The largest whole number at most the value. */
  floor(): Expr {
    return new Expr({ floor: [this.node] });
  }
  /** The natural logarithm. Values at most 0 give a missing value. */
  ln(): Expr {
    return new Expr({ ln: [this.node] });
  }
  /** e raised to the value. */
  exp(): Expr {
    return new Expr({ exp: [this.node] });
  }

  /** Whether a text field equals `text`, a plain text that is neither a field nor a color. */
  is(text: string): Expr {
    return new Expr({ is: [this.node, text] });
  }

  /**
   * Whether a text field contains `text`, a plain text, ignoring case. In a mark, the field must be
   * in the mark's own table.
   */
  contains(text: string): Expr {
    return new Expr({ contains: [this.node, text] });
  }

  /**
   * Maps the value to a color for every row through `map`, a catalog name or custom colors. The
   * domain fits the values shown unless set with {@link Mapped.domain}.
   */
  colormap(map: Colormap): Mapped {
    return new Mapped({ colormap: map, value: this.node });
  }

  /**
   * Maps the value linearly onto `[low, high]`, clamped. The domain fits the values shown unless
   * set with {@link Mapped.domain}.
   */
  scale(low: number, high: number): Mapped {
    return new Mapped({ scale: [low, high], value: this.node });
  }
}

/** A value mapped through a colormap or onto a range, with an input domain that can be set. */
export class Mapped extends Expr {
  /**
   * Sets the input values that map to the colormap's or the range's ends, instead of fitting the
   * values shown.
   */
  domain(low: number, high: number): Mapped {
    return new Mapped({ ...(this.node as ScaleNode | ColormapNode), domain: [low, high] });
  }
}

/** Returns `input`'s JSON form with every field replaced by `f(field)`, in its `{ field }` form. */
function mapFields(input: ExprInput, f: (field: FieldNode) => FieldNode): ExprNode {
  const node = nodeOf(input);
  if (typeof node === 'string') return node.startsWith('$') ? f({ field: node.slice(1) }) : node;
  if (node === null || typeof node !== 'object') return node;
  const map = (child: ExprInput) => mapFields(child, f);
  if ('field' in node) return f(node);
  if ('state' in node) return node;
  if ('when' in node) {
    const cases = node.when.map(([c, v]): [ExprNode, ExprNode] => [map(c), map(v)]);
    return { when: cases, otherwise: map(node.otherwise) };
  }
  if ('value' in node) return { ...node, value: map(node.value) };
  // A call: its one key names the operation. `is` and `contains` take a plain text after the value.
  const [op, args] = Object.entries(node)[0] as [string, ExprInput[]];
  const mapped = op === 'is' || op === 'contains' ? [map(args[0]), args[1]] : args.map(map);
  return { [op]: mapped } as ExprNode;
}

const state = (name: State): Expr => new Expr({ state: name });

/**
 * Reads field `name` of each row, written `'$name'` in JSON. `from()` and `step()` give it its
 * `{ field }` form.
 */
export const field = (name: string): Expr => new Expr(`$${name}`);
/** Whether the row is selected. */
export const selected = (): Expr => state('selected');
/** Whether the pointer is over the row. */
export const hovered = (): Expr => state('hovered');
/** CSS pixels from a vertex to the pointer. Vertex marks only, and not in a vertex's position. */
export const pointer = (): Expr => state('pointer');
/** Seconds since the view was created. A mark that reads it redraws every frame. */
export const elapsed = (): Expr => state('elapsed');
/** The camera's zoom: the web mercator level on the earth, log₂ CSS pixels per unit elsewhere. */
export const zoom = (): Expr => state('zoom');

/**
 * A size in CSS pixels regardless of the space's unit, so it stays the same on screen as the view
 * zooms: `px(1)` keeps a diagram's stroke 1 pixel wide at any zoom. Given a number, the result also
 * works as a theme length.
 */
export function px(size: number): { px: number };
export function px(size: ExprInput): Px;
export function px(size: ExprInput): Px {
  return { px: nodeOf(size) };
}

/**
 * A size in position units (degrees on the earth) regardless of the space's unit, so it scales as
 * the view zooms. `limits` bound its on-screen size in CSS pixels: `units('$r', { atLeast: 2 })`
 * grows with the map and never shrinks below 2 pixels. A marker keeps its proportions, with the
 * limits applied to its larger side. Given only a number, the result also works as a theme length.
 */
export function units(size: number): { units: number };
export function units(size: ExprInput, limits?: Omit<Units, 'units'>): Units;
export function units(size: ExprInput, limits: Omit<Units, 'units'> = {}): Units {
  return { units: nodeOf(size), ...limits };
}

/** One case of a conditional: a condition, and the value it selects. */
type Case = [condition: ExprNode, value: ExprNode];

/**
 * Starts a conditional. `when(c).then(a).when(d).then(b).otherwise(e)` takes the value of the first
 * case whose condition holds, else `e`. The values may be numbers, colors, or a text field and
 * `null`, as the option takes.
 */
export function when(condition: ExprInput): When {
  return new When(nodeOf(condition));
}

/** A conditional's first condition, awaiting its value from `then`. */
class When {
  /** @internal */
  constructor(private readonly condition: ExprNode) {}

  /** Sets the value where the condition holds. */
  then(value: ExprInput): Then {
    return new Then([[this.condition, nodeOf(value)]]);
  }
}

/** A conditional's cases so far, awaiting another `when` case or the `otherwise` fallback. */
class Then {
  /** @internal */
  constructor(private readonly cases: readonly Case[]) {}

  /** Adds a case, tried when no earlier condition holds. */
  when(condition: ExprInput): Next {
    return new Next(this.cases, nodeOf(condition));
  }

  /** Sets the value where no condition holds, and returns the finished conditional. */
  otherwise(value: ExprInput): Expr {
    return new Expr({ when: [...this.cases], otherwise: nodeOf(value) });
  }
}

/** A conditional's next condition, awaiting its value from `then`. */
class Next {
  /** @internal */
  constructor(
    private readonly cases: readonly Case[],
    private readonly condition: ExprNode,
  ) {}

  /** Sets the value where this condition holds. */
  then(value: ExprInput): Then {
    return new Then([...this.cases, [this.condition, nodeOf(value)]]);
  }
}

/** RGBA pixels with straight alpha, rows top to bottom. A browser `ImageData` has this shape. */
export interface RgbaImage {
  /** The width in pixels. */
  width: number;
  /** The height in pixels. */
  height: number;
  /** 4 bytes per pixel, red, green, blue, and alpha, row after row. */
  data: Uint8ClampedArray;
}

/**
 * An icon marker: each row shows `images[index]`, fitted in the marker's box, with `index` counting
 * from 0. The pixels are copied into the marker.
 */
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
