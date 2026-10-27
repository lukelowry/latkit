/**
 * Builders for the expressions and colors that scene options take. A scene is plain data, typed in
 * `inputs.ts`; nothing here needs WebAssembly.
 */

import type {
  Binary,
  Colormap,
  ColormapNode,
  ExprNode,
  FieldNode,
  Marker,
  MissingNode,
  PaintNode,
  Px,
  ScaleNode,
  State,
  Unary,
  Units,
} from './inputs.js';

/**
 * A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. In a color option, a string is a color.
 */
export type Color = string;

/** A value option: an {@link Expr}, or its JSON form, in which a string is a field name. */
export type ExprInput = Expr | ExprNode;

/**
 * A color option: a CSS color, a {@link Paint}, or its JSON form. A string here is always a CSS
 * color, never a field name; map a field to colors with `field(name).colormap(map)`.
 */
export type PaintInput = Color | Paint | PaintNode;

const nodeOf = (input: ExprInput): ExprNode => (input instanceof Expr ? input.node : input);

/** A value for every row of a mark: a constant, a field, view state, or arithmetic on them. */
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

  /** Reads this expression's fields from table `table` of dataset `data`, joined by row id. */
  from(data: string, table: string): Expr {
    return new Expr(mapFields(this.node, (f) => ({ ...f, from: [data, table] })));
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
    return binary('add', this, other);
  }
  /** This value minus `other`. */
  sub(other: ExprInput): Expr {
    return binary('sub', this, other);
  }
  /** The product of this value and `other`. */
  mul(other: ExprInput): Expr {
    return binary('mul', this, other);
  }
  /** This value divided by `other`. Dividing by 0 gives a missing value. */
  div(other: ExprInput): Expr {
    return binary('div', this, other);
  }
  /** The remainder of this value divided by `other`, with the sign of `other`: `-1 rem 3` is 2. */
  rem(other: ExprInput): Expr {
    return binary('rem', this, other);
  }
  /** This value raised to the power `other`. */
  pow(other: ExprInput): Expr {
    return binary('pow', this, other);
  }
  /** The smaller of this value and `other`. */
  min(other: ExprInput): Expr {
    return binary('min', this, other);
  }
  /** The larger of this value and `other`. */
  max(other: ExprInput): Expr {
    return binary('max', this, other);
  }
  /** This value limited to the range from `low` to `high`. */
  clamp(low: ExprInput, high: ExprInput): Expr {
    return this.max(low).min(high);
  }
  /** 1 where this value is less than `other`, else 0. */
  lt(other: ExprInput): Expr {
    return binary('lt', this, other);
  }
  /** 1 where this value is at most `other`, else 0. */
  le(other: ExprInput): Expr {
    return binary('le', this, other);
  }
  /** 1 where this value is greater than `other`, else 0. */
  gt(other: ExprInput): Expr {
    return binary('gt', this, other);
  }
  /** 1 where this value is at least `other`, else 0. */
  ge(other: ExprInput): Expr {
    return binary('ge', this, other);
  }
  /** 1 where this value equals `other`, else 0. Colors compare too. */
  eq(other: ExprInput): Expr {
    return binary('eq', this, other);
  }
  /** 1 where this value differs from `other`, else 0. Colors compare too. */
  ne(other: ExprInput): Expr {
    return binary('ne', this, other);
  }
  /** 1 where this value and `other` are both above 0.5, else 0. */
  and(other: ExprInput): Expr {
    return binary('and', this, other);
  }
  /** 1 where this value or `other` is above 0.5, else 0. */
  or(other: ExprInput): Expr {
    return binary('or', this, other);
  }
  /** 1 where this value is at most 0.5, else 0. */
  not(): Expr {
    return unary('not', this);
  }
  /** The value negated. */
  neg(): Expr {
    return unary('neg', this);
  }
  /** The absolute value. */
  abs(): Expr {
    return unary('abs', this);
  }
  /** The square root. Negative values give a missing value. */
  sqrt(): Expr {
    return unary('sqrt', this);
  }
  /** The sine of the value, an angle in radians. */
  sin(): Expr {
    return unary('sin', this);
  }
  /** The cosine of the value, an angle in radians. */
  cos(): Expr {
    return unary('cos', this);
  }
  /** The largest whole number at most the value. */
  floor(): Expr {
    return unary('floor', this);
  }
  /** The natural logarithm. Values at most 0 give a missing value. */
  ln(): Expr {
    return unary('ln', this);
  }
  /** e raised to the value. */
  exp(): Expr {
    return unary('exp', this);
  }

  /** Whether a text field equals `text`. */
  is(text: string): Expr {
    return new Expr({ is: [this.node, text] });
  }

  /**
   * Whether a text field contains `text`, ignoring case. In a mark, the field must be in the mark's
   * own table.
   */
  contains(text: string): Expr {
    return new Expr({ contains: [this.node, text] });
  }

  /**
   * Maps the value to a color for every row through `map`, a catalog name or custom colors. The
   * domain fits the values shown unless set with {@link Colormapped.domain}.
   */
  colormap(map: Colormap): Colormapped {
    return new Colormapped({ colormap: map, value: this.node });
  }

  /**
   * Maps the value linearly onto `[low, high]`, clamped. The domain fits the values shown unless
   * set with {@link Mapped.domain}.
   */
  scale(low: number, high: number): Mapped {
    return new Mapped({ scale: [low, high], value: this.node });
  }
}

/** A value mapped linearly onto a range, with an input domain that can be set. */
export class Mapped extends Expr {
  /** Sets the input values that map to the range's ends, instead of fitting the values shown. */
  domain(low: number, high: number): Mapped {
    return new Mapped({ ...(this.node as ScaleNode), domain: [low, high] });
  }
}

/**
 * A color for every row of a mark: a constant, a value mapped through a colormap, or a conditional
 * choosing between colors. Color options take a `Paint` or a CSS color string.
 */
export class Paint {
  /** The color's JSON form. */
  readonly node: PaintNode;

  /** Wraps a color's JSON form. The builders cover common cases. */
  constructor(node: PaintNode) {
    this.node = node;
  }

  /** The JSON form, which `JSON.stringify` writes for the color. */
  toJSON(): PaintNode {
    return this.node;
  }
}

/** A value mapped through a colormap, with an input domain that can be set. */
export class Colormapped extends Paint {
  /** Sets the input values that map to the colormap's ends, instead of fitting the values shown. */
  domain(low: number, high: number): Colormapped {
    return new Colormapped({ ...(this.node as ColormapNode), domain: [low, high] });
  }
}

/** A missing value, valid as a value or a color. An option given one uses the theme's value. */
export class Missing extends Expr {
  /** The missing value's JSON form, `{ missing: true }`. */
  declare readonly node: MissingNode;

  /** A missing value. {@link missing} makes one too. */
  constructor() {
    super({ missing: true });
  }

  /** The JSON form, which `JSON.stringify` writes for the missing value. */
  override toJSON(): MissingNode {
    return this.node;
  }
}

const unary = (op: Unary, a: ExprInput): Expr => new Expr({ op, args: [nodeOf(a)] });
const binary = (op: Binary, a: ExprInput, b: ExprInput): Expr =>
  new Expr({ op, args: [nodeOf(a), nodeOf(b)] });

/** Returns `input`'s JSON form with every field node replaced by `f(field)`. */
function mapFields(input: ExprInput, f: (field: FieldNode) => FieldNode): ExprNode {
  const node = nodeOf(input);
  if (typeof node === 'string') return f({ field: node });
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

/** Reads field `name` of each row. */
export const field = (name: string): Expr => new Expr({ field: name });
/** A constant color, from a CSS color string. */
export const color = (css: Color): Paint => new Paint({ color: css });
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
/** A missing value: an option given one uses the theme's value. */
export const missing = (): Missing => new Missing();

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
 * the view zooms. `limits` bound its on-screen size in CSS pixels: `units('r', { atLeast: 2 })`
 * grows with the map and never shrinks below 2 pixels. A marker keeps its proportions, with the
 * limits applied to its larger side. Given only a number, the result also works as a theme length.
 */
export function units(size: number): { units: number };
export function units(size: ExprInput, limits?: Omit<Units, 'units'>): Units;
export function units(size: ExprInput, limits: Omit<Units, 'units'> = {}): Units {
  return { units: nodeOf(size), ...limits };
}

/** One case of a conditional: a condition, and the value or color it selects. */
type Case = [ExprNode, ExprNode | PaintNode];

/** A conditional's value input: {@link PaintInput} for colors, else {@link ExprInput}. */
type InputOf<T> = T extends Paint ? PaintInput : ExprInput;

/**
 * Starts a conditional. `when(c).then(a).when(d).then(b).otherwise(e)` takes the value of the first
 * case whose condition holds, else `e`. If the first `then` gets a color (a CSS string, a
 * {@link Paint}, a missing value, or a color's JSON form), every value of the conditional is a
 * color, and strings are CSS colors. Otherwise every value is an expression.
 */
export function when(condition: ExprInput): When {
  return new When(nodeOf(condition));
}

/** A conditional's first condition, awaiting its value from `then`. */
class When {
  /** @internal */
  constructor(private readonly condition: ExprNode) {}

  /** Sets the color where the condition holds; every value of the conditional is then a color. */
  then(value: PaintInput): Then<Paint>;
  /** Sets the value where the condition holds. */
  then(value: ExprInput): Then<Expr>;
  then(value: PaintInput | ExprInput): Then<Paint> | Then<Expr> {
    const cases: Case[] = [[this.condition, written(value)]];
    return colored(value)
      ? new Then<Paint>(cases, (node) => new Paint(node as PaintNode))
      : new Then<Expr>(cases, (node) => new Expr(node as ExprNode));
  }
}

/** A conditional's cases so far, awaiting another `when` case or the `otherwise` fallback. */
class Then<T extends Expr | Paint> {
  /** @internal */
  constructor(
    private readonly cases: readonly Case[],
    private readonly make: (node: object) => T,
  ) {}

  /** Adds a case, tried when no earlier condition holds. */
  when(condition: ExprInput): Next<T> {
    return new Next(this.cases, nodeOf(condition), this.make);
  }

  /** Sets the value where no condition holds, and returns the finished conditional. */
  otherwise(value: InputOf<T>): T {
    return this.make({ when: this.cases, otherwise: written(value) });
  }
}

/** A conditional's next condition, awaiting its value from `then`. */
class Next<T extends Expr | Paint> {
  /** @internal */
  constructor(
    private readonly cases: readonly Case[],
    private readonly condition: ExprNode,
    private readonly make: (node: object) => T,
  ) {}

  /** Sets the value where this condition holds. */
  then(value: InputOf<T>): Then<T> {
    return new Then([...this.cases, [this.condition, written(value)]], this.make);
  }
}

/** The JSON form of `value`. */
function written(value: ExprInput | PaintInput): ExprNode | PaintNode {
  return value instanceof Expr || value instanceof Paint ? value.node : value;
}

/**
 * Whether a conditional's first value makes it a color conditional: a CSS string, a
 * {@link Paint}, a missing value, or a color's JSON form.
 */
function colored(value: ExprInput | PaintInput): boolean {
  if (typeof value === 'string' || value instanceof Paint || value instanceof Missing) return true;
  if (value instanceof Expr || typeof value !== 'object') return false;
  return 'color' in value || 'colormap' in value || 'missing' in value;
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
