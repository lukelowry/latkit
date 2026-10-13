/**
 * Scenes as plain data, and the expression builders that write their options. Nothing here needs
 * the wasm module: a scene is JSON the view decodes.
 */

/** A CSS color, such as `'#ffb000'` or `'rebeccapurple'`. Where an option takes an expression, a
 * string starting with `#` is a hex color and any other string names a field. */
export type Color = string;

/** What an expression is written as: an {@link Expr}, or its JSON form. */
export type ExprInput = Expr | ExprNode;

/** An expression as JSON: a constant, a field name, or one of these objects. {@link Expr} writes it. */
export type ExprNode =
  | number
  | boolean
  | string
  | FieldNode
  | { color: Color }
  | { state: 'selected' | 'hovered' | 'pointer' | 'elapsed' }
  | { missing: true }
  | { op: Unary; args: [ExprNode] }
  | { op: Binary; args: [ExprNode, ExprNode] }
  | { is: [ExprNode, string] }
  | { when: [ExprNode, ExprNode][]; otherwise: ExprNode }
  | {
      colormap: ExprNode;
      map: ColormapName | { kind: ColormapKind; colors: Color[] };
      domain?: [number, number];
    }
  | { scale: ExprNode; range: [number, number]; domain?: [number, number] };

type FieldNode = { field: string; of?: [data: string, table: string]; step?: boolean };
type Unary = 'not' | 'neg' | 'abs' | 'sqrt' | 'sin' | 'cos' | 'floor' | 'ln' | 'exp';
type Binary =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'rem'
  | 'pow'
  | 'min'
  | 'max'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'eq'
  | 'ne'
  | 'and'
  | 'or';

const nodeOf = (input: ExprInput): ExprNode => (input instanceof Expr ? input.node : input);

/** A value for every row of a mark: a constant, a field, view state, or arithmetic of them. */
export class Expr {
  /** @internal */
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

  /** The value through a colormap: a catalog name, or your own colors. */
  colormap(map: ColormapName | { kind: ColormapKind; colors: Color[] }): Mapped {
    return new Mapped({ colormap: this.node, map });
  }

  /** The value mapped linearly onto `[low, high]`, clamped. */
  scale(low: number, high: number): Mapped {
    return new Mapped({ scale: this.node, range: [low, high] });
  }
}

/** A value through a colormap or onto a range, whose domain can be set. */
export class Mapped extends Expr {
  /** The input values that map to the ends; it fits the values shown unless set. */
  domain(low: number, high: number): Mapped {
    return new Mapped({ ...(this.node as MappedNode), domain: [low, high] });
  }
}

type MappedNode = Extract<ExprNode, { map: unknown } | { range: unknown }>;

const unary = (op: Unary, a: ExprInput): Expr => new Expr({ op, args: [nodeOf(a)] });
const binary = (op: Binary, a: ExprInput, b: ExprInput): Expr =>
  new Expr({ op, args: [nodeOf(a), nodeOf(b)] });

/** `node` with every field read through `f`; texts, colors, and names are not fields. */
function mapFields(node: ExprNode, f: (field: FieldNode) => ExprNode): ExprNode {
  if (typeof node === 'string') return f({ field: node });
  if (typeof node !== 'object') return node;
  const map = (child: ExprNode) => mapFields(child, f);
  if ('field' in node) return f(node);
  if ('op' in node) return { ...node, args: node.args.map(map) } as ExprNode;
  if ('when' in node) {
    const cases = node.when.map(([c, v]): [ExprNode, ExprNode] => [map(c), map(v)]);
    return { when: cases, otherwise: map(node.otherwise) };
  }
  if ('is' in node) return { is: [map(node.is[0]), node.is[1]] };
  if ('scale' in node) return { ...node, scale: map(node.scale) };
  if ('colormap' in node) return { ...node, colormap: map(node.colormap) };
  return node;
}

/** The field `name` of each row. */
export const field = (name: string): Expr => new Expr({ field: name });
/** A color constant. */
export const color = (css: Color): Expr => new Expr({ color: css });
/** Whether the row is selected. */
export const selected = (): Expr => new Expr({ state: 'selected' });
/** Whether the pointer is over the row. */
export const hovered = (): Expr => new Expr({ state: 'hovered' });
/** CSS pixels from a vertex to the pointer. */
export const pointer = (): Expr => new Expr({ state: 'pointer' });
/** Seconds since the view was created. */
export const elapsed = (): Expr => new Expr({ state: 'elapsed' });
/** A missing value: options that read one take the theme's. */
export const missing = (): Expr => new Expr({ missing: true });
/** A size in position units, so it scales as the view zooms. */
export const units = (size: ExprInput): Size => ({ units: nodeOf(size) });

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

/** A size: CSS pixels, or position units with {@link units}. */
export type Size = ExprInput | { units: ExprNode };

export type ColormapKind = 'sequential' | 'diverging' | 'cyclic' | 'categorical';
export type ColormapName =
  | 'amber'
  | 'amp'
  | 'batlow'
  | 'cividis'
  | 'crest'
  | 'deep'
  | 'devon'
  | 'flare'
  | 'grays'
  | 'haline'
  | 'inferno'
  | 'lajolla'
  | 'magma'
  | 'mako'
  | 'oslo'
  | 'plasma'
  | 'rocket'
  | 'thermal'
  | 'turku'
  | 'viridis'
  | 'balance'
  | 'berlin'
  | 'brbg'
  | 'broc'
  | 'coolwarm'
  | 'cork'
  | 'icefire'
  | 'managua'
  | 'piyg'
  | 'puor'
  | 'rdbu'
  | 'spectral'
  | 'vanimo'
  | 'vik'
  | 'vlag'
  | 'phase'
  | 'romao'
  | 'twilight'
  | 'dark2'
  | 'okabeito'
  | 'paired'
  | 'set2'
  | 'tab10'
  | 'tab20'
  | 'tableau10'
  | 'turbo';

/** What a view draws and how it answers input. */
export interface Scene {
  space: Space;
  marks?: Mark[];
  layout?: Layout;
  theme?: 'dark' | 'light' | Theme;
  controls?: Controls;
  /** Seconds that changes ease over. */
  ease?: number;
}

/** How a view answers the pointer and keyboard; every option is on by default. */
export interface Controls {
  /** Dragging the background moves the camera. */
  pan?: boolean;
  /** The wheel and pinching zoom. */
  zoom?: boolean;
  /** Dragging with the secondary button, or with Shift, turns and tilts a map or plane. */
  turn?: boolean;
  /** Arrows pan, `+` and `-` zoom, Home fits, and Escape clears the selection. */
  keyboard?: boolean;
  /** Rows under the pointer glow. */
  hover?: boolean;
  /** CSS pixels around the pointer that picks reach, 6 by default; touch reaches 8 more. */
  pickRadius?: number;
}

export type Space =
  | 'plane'
  | 'earth'
  | 'mercator'
  | 'globe'
  | 'plot'
  | { plane: { grid?: 'off' | { lines: number } | { dots: number; snap?: boolean } } }
  | { earth: { projection?: 'mercator' | 'globe'; surface?: Color; graticule?: boolean } }
  | { plot: { x?: Axis; y?: Axis } };

export interface Axis {
  label?: string;
  grid?: boolean;
  hidden?: boolean;
}

export type Layout =
  | 'none'
  | 'stress'
  | 'layered'
  | { stress: { gap?: number } }
  | { layered: { flow?: 'right' | 'left' | 'down' | 'up'; gap?: number; rankGap?: number } };

export interface Theme {
  base?: 'dark' | 'light';
  background?: Color;
  surface?: Color;
  grid?: Color;
  vertex?: Color;
  vertexRadius?: number;
  edge?: Color | null;
  edgeWidth?: number;
  line?: Color;
  lineWidth?: number;
  /** How much a face turned away from the camera darkens, 0 to 1. */
  shading?: number;
  /** Text: axis ticks and titles. */
  text?: Color;
  /** A CSS font family list. */
  font?: string;
  fontSize?: number;
  /** The line a plot draws at the shown coordinate. */
  playhead?: Color;
  missing?: Color;
  hover?: Color;
  selected?: Color | null;
  glow?: number;
  dim?: number;
  hoverScale?: number;
  dash?: number;
  flow?: Color;
  flowSpacing?: number;
  /** What shadows darken with. */
  shadow?: Color;
}

interface Style {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  color?: ExprInput;
  visible?: ExprInput;
  /** Tells two marks of one table apart across scenes. */
  name?: string;
  /** Whether rows are hovered, clicked, and probed; on by default. */
  pick?: boolean;
  /** Whether a click selects a row; on by default. */
  select?: boolean;
  /** Whether pressing a row drags it instead of panning; off by default. */
  drag?: boolean;
}

export type Marker =
  | 'disc'
  | 'ellipse'
  | 'rectangle'
  | 'rounded'
  | 'diamond'
  | 'block'
  | { block: { corner?: number } };

export type Mark =
  | {
      vertices: Style & {
        position?: [ExprInput, ExprInput];
        elevation?: ExprInput;
        radius?: Size;
        size?: [Size, Size];
        marker?: Marker;
        /** Whether each row casts a soft shadow. */
        shadow?: boolean;
      };
    }
  | {
      edges: Style & {
        ends: [from: string, to: string];
        width?: Size;
        dash?: ExprInput;
        flow?: ExprInput;
      };
    }
  | {
      /** Triangles between three vertices; without a color, each blends its corners' colors. */
      faces: Style & {
        corners: [a: string, b: string, c: string];
        /** Whether each face casts a shadow straight down onto the ground. */
        shadow?: boolean;
      };
    }
  | {
      /** On a plot, each row traces the sampled field `samples` across the axis. */
      lines: Style & { samples: string; width?: Size; dash?: ExprInput };
    };
