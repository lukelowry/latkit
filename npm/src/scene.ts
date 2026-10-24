/**
 * The builders that write scenes' options. A scene is plain data the view reads, its types written
 * from the forms latkit reads (`inputs.ts`); nothing here needs WebAssembly.
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

/** A CSS color, such as `'#ffb000'` or `'rebeccapurple'`: what a string is in a color option. */
export type Color = string;

/** What a value is written as: an {@link Expr}, or its JSON form, in which a string names a field. */
export type ExprInput = Expr | ExprNode;

/**
 * What a color is written as: a CSS color, a {@link Paint}, or its JSON form. A string is a CSS
 * color here; a field reads with {@link field}.
 */
export type PaintInput = Color | Paint | PaintNode;

const nodeOf = (input: ExprInput): ExprNode => (input instanceof Expr ? input.node : input);

/** A value for every row of a mark: a constant, a field, view state, or arithmetic of them. */
export class Expr {
  /** An expression from its JSON form; use the builders for common operations. */
  constructor(readonly node: ExprNode) {}

  toJSON(): ExprNode {
    return this.node;
  }

  /** Reads this expression's fields from `table` of dataset `data`, joined by row id. */
  from(data: string, table: string): Expr {
    return new Expr(mapFields(this.node, (f) => ({ ...f, from: [data, table] })));
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

  /** Whether a text field holds `text`, ignoring case: in a mark, a field of its own table. */
  contains(text: string): Expr {
    return new Expr({ contains: [this.node, text] });
  }

  /** The value through `map`, a color for every row: a catalog name, or your own colors. */
  colormap(map: Colormap): Colormapped {
    return new Colormapped({ colormap: map, value: this.node });
  }

  /** The value mapped linearly onto `[low, high]`, clamped. */
  scale(low: number, high: number): Mapped {
    return new Mapped({ scale: [low, high], value: this.node });
  }
}

/** A value mapped onto a range, whose domain can be set. */
export class Mapped extends Expr {
  /** The input values that map to the ends; it fits the values shown unless set. */
  domain(low: number, high: number): Mapped {
    return new Mapped({ ...(this.node as ScaleNode), domain: [low, high] });
  }
}

/**
 * A color for every row of a mark: a CSS color, a value through a colormap, or a conditional choosing
 * between colors. Color options take one, or a CSS color as it is.
 */
export class Paint {
  /** A color from its JSON form; use the builders for common colors. */
  constructor(readonly node: PaintNode) {}

  toJSON(): PaintNode {
    return this.node;
  }
}

/** A value through a colormap, whose domain can be set. */
export class Colormapped extends Paint {
  /** The input values that map to the ends; it fits the values shown unless set. */
  domain(low: number, high: number): Colormapped {
    return new Colormapped({ ...(this.node as ColormapNode), domain: [low, high] });
  }
}

/** A missing value, which options take the theme's for: a value and a color alike. */
export class Missing extends Expr {
  declare readonly node: MissingNode;

  constructor() {
    super({ missing: true });
  }

  override toJSON(): MissingNode {
    return this.node;
  }
}

const unary = (op: Unary, a: ExprInput): Expr => new Expr({ op, args: [nodeOf(a)] });
const binary = (op: Binary, a: ExprInput, b: ExprInput): Expr =>
  new Expr({ op, args: [nodeOf(a), nodeOf(b)] });

/** `node` with every field read through `f`. */
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

/** The field `name` of each row. */
export const field = (name: string): Expr => new Expr({ field: name });
/** A color constant. */
export const color = (css: Color): Paint => new Paint({ color: css });
/** Whether the row is selected. */
export const selected = (): Expr => state('selected');
/** Whether the pointer is over the row. */
export const hovered = (): Expr => state('hovered');
/** CSS pixels from a vertex to the pointer. */
export const pointer = (): Expr => state('pointer');
/** Seconds since the view was created. */
export const elapsed = (): Expr => state('elapsed');
/** The camera's zoom: the web mercator level on the earth, log₂ CSS pixels per unit elsewhere. */
export const zoom = (): Expr => state('zoom');
/** A missing value: options that read one take the theme's. */
export const missing = (): Missing => new Missing();

/** The CSS pixels a size in position units keeps within. */
export interface Within {
  /** CSS pixels it keeps at least, however far the view zooms out. */
  atLeast?: number;
  /** CSS pixels it keeps at most, however far the view zooms in. */
  atMost?: number;
}

/**
 * A size in CSS pixels, whatever the space's own unit: a stroke keeps its width on screen as a
 * diagram zooms. A number makes a theme's length too.
 */
export function px(size: number): { px: number };
export function px(size: ExprInput): Px;
export function px(size: ExprInput): Px {
  return { px: nodeOf(size) };
}

/**
 * A size in position units, whatever the space's own unit, so it scales as the view zooms, kept
 * within `atLeast` and `atMost` CSS pixels when given: `units('r', { atLeast: 2 })` grows with the map
 * and never vanishes. A marker keeps its proportions, its larger side held. A number alone makes a
 * theme's length too.
 */
export function units(size: number): { units: number };
export function units(size: ExprInput, within?: Within): Units;
export function units(size: ExprInput, within: Within = {}): Units {
  return { units: nodeOf(size), ...within };
}

/** A case of a conditional: its condition, and its value or color. */
type Case = [ExprNode, ExprNode | PaintNode];

/** What a conditional's values are written as, a value's or a color's. */
type InputOf<T> = T extends Paint ? PaintInput : ExprInput;

/**
 * Starts a conditional: `when(c).then(a).when(d).then(b).otherwise(e)`. Its values are colors, a
 * string a CSS color, where its first is one; else values.
 */
export function when(condition: ExprInput): When {
  return new When(nodeOf(condition));
}

/** A conditional's first case, waiting for its value where the condition holds. */
class When {
  /** @internal */
  constructor(private readonly condition: ExprNode) {}

  /** The color where the condition holds: every value of the conditional is a color. */
  then(value: PaintInput): Then<Paint>;
  /** The value where the condition holds. */
  then(value: ExprInput): Then<Expr>;
  then(value: PaintInput | ExprInput): Then<Paint> | Then<Expr> {
    const cases: Case[] = [[this.condition, written(value)]];
    return colored(value)
      ? new Then<Paint>(cases, (node) => new Paint(node as PaintNode))
      : new Then<Expr>(cases, (node) => new Expr(node as ExprNode));
  }
}

/** A conditional's cases so far, waiting for another or the value where none holds. */
class Then<T extends Expr | Paint> {
  /** @internal */
  constructor(
    private readonly cases: readonly Case[],
    private readonly make: (node: object) => T,
  ) {}

  /** Another case, tried when those before it do not hold. */
  when(condition: ExprInput): Next<T> {
    return new Next(this.cases, nodeOf(condition), this.make);
  }

  /** The value where no case holds. */
  otherwise(value: InputOf<T>): T {
    return this.make({ when: this.cases, otherwise: written(value) });
  }
}

/** A conditional's next case, waiting for its value where the condition holds. */
class Next<T extends Expr | Paint> {
  /** @internal */
  constructor(
    private readonly cases: readonly Case[],
    private readonly condition: ExprNode,
    private readonly make: (node: object) => T,
  ) {}

  /** The value where the condition holds. */
  then(value: InputOf<T>): Then<T> {
    return new Then([...this.cases, [this.condition, written(value)]], this.make);
  }
}

/** `value` as it is written. */
function written(value: ExprInput | PaintInput): ExprNode | PaintNode {
  return value instanceof Expr || value instanceof Paint ? value.node : value;
}

/**
 * Whether a conditional's first value makes it choose colors, as the types say: a CSS color, a color,
 * a missing value, or a color's own form.
 */
function colored(value: ExprInput | PaintInput): boolean {
  if (typeof value === 'string' || value instanceof Paint || value instanceof Missing) return true;
  if (value instanceof Expr || typeof value !== 'object') return false;
  return 'color' in value || 'colormap' in value || 'missing' in value;
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
