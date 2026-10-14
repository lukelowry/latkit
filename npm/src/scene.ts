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
  | { state: 'selected' | 'hovered' | 'pointer' | 'elapsed' | 'zoom' }
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
/** The camera's zoom: the web mercator level on the earth, log₂ CSS pixels per unit elsewhere. */
export const zoom = (): Expr => new Expr({ state: 'zoom' });
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
  /** Dragging the background with Shift selects the rows in a box, instead of turning. Off by default. */
  selectBox?: boolean;
  /** Dragging from a port, from a vertex with Alt, or an edge off its end draws a connection, told as
   * a `connect` event. Off by default. */
  connect?: boolean;
  /** Delete and Backspace tell a `delete` event with the selection. Off by default. */
  delete?: boolean;
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
  /** Ticks at these values, with these labels or their values written; round values unless given. */
  ticks?: (number | [number, string | null])[];
  /** How tick values are written: `auto` (fixed, scientific when very large or small). */
  format?: 'auto' | 'fixed' | 'scientific' | 'engineering';
  /** Decimals of fixed values, or of the significand otherwise; as many as the ticks need unless set. */
  precision?: number;
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
  /** CSS pixels between the lanes of edges joining the same two vertices. */
  edgeSpacing?: number;
  /** CSS pixels an arrowhead reaches past its edge's width. */
  arrow?: number;
  /** CSS pixels of background around label text. */
  halo?: number;
  /** CSS pixels between a group's members and its outline. */
  groupPadding?: number;
  /** How marks that cast shadows cast them. */
  shadow?: Shadow;
}

/** How marks that cast shadows cast them onto the ground and onto faces. */
export interface Shadow {
  /** What a shadow darkens toward; its alpha is how dark a shadow at contact gets. */
  color?: Color;
  /** The direction toward the light, fixed in the world: shadows fall away from it. */
  light?: [number, number, number];
  /** How much a shadow spreads per unit of a caster's height. */
  softness?: number;
  /** CSS pixels flat marks cast from, as if raised. */
  lift?: number;
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
  /** Each row's text: a text field, or a {@link Label}. */
  label?: ExprInput | Label;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean;
}

/** Options of marks that draw strokes: edges and lines. */
interface Stroke {
  /** CSS pixels, or position units with {@link units}. */
  width?: Size;
  dash?: ExprInput;
  /** Comets flowing along each row, CSS pixels per second; negative flows backward. */
  flow?: ExprInput;
}

/** A row's text, placed beside, inside, or along what its mark draws; overlapping labels give way by priority. */
export interface Label {
  /** A text field. */
  text: ExprInput;
  /** CSS pixels; the theme's font size unless set. */
  size?: number;
  color?: ExprInput;
  /** Where labels would overlap, the higher shows. */
  priority?: ExprInput;
  /** CSS pixels a line runs to before it wraps. */
  maxWidth?: number;
}

export type Shape = 'ellipse' | 'rectangle' | 'rounded' | 'diamond';

/** A side of a marker. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** A vertex's port: where a net its reference field names meets it, on one side of its marker. */
export type Port =
  | Side
  | {
      side: Side;
      /** Its place among the ports on that side, from the top or the left; in declaration order unless set. */
      order?: number;
      /** Its name drawn beside it. */
      label?: string;
      shape?: Shape;
    };

export type Marker =
  | 'disc'
  | Shape
  | 'block'
  | { block: { corner?: number } }
  /** A shape's outline filled to `fill`, from 0 to 1. */
  | { gauge: { fill: ExprInput; shape?: Shape } }
  /** A circle cut into slices as large as their values. */
  | { pie: { slices: ExprInput[]; colors: Color[]; hole?: number } }
  /** One of `images` per row, by `index`; {@link icon} writes it from `ImageData`. */
  | { icon: { images: { size: [number, number]; rgba: number[] }[]; index: ExprInput } }
  /** WGSL defining `fn marker(f: MarkerFragment) -> MarkerColor`, reading `inputs` as `f.input[i]`. */
  | { wgsl: { source: string; inputs?: ExprInput[] } };

/** An icon marker showing one of `images` for each row, picked by `index`. */
export function icon(images: ImageData[], index: ExprInput): Marker {
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

export type Mark =
  | {
      vertices: Style & {
        /** Without one, a point field named `geometry` places rows, else the scene's layout does. */
        position?: [ExprInput, ExprInput];
        elevation?: ExprInput;
        radius?: Size;
        size?: [Size, Size];
        marker?: Marker;
        /** A ring around each row's marker in this color. */
        status?: ExprInput;
        /** A port on each row for each reference field naming a net, which an `edges` mark of the
         * net table without ends draws. */
        ports?: [reference: string, port: Port][];
        /** Makes each row a group: it holds the rows of `table` whose reference field names it, and is
         * drawn around them. */
        contains?: [table: string, reference: string];
        /** Whether each group hides its members inside it; edges to them end at the group. */
        collapsed?: ExprInput;
      };
    }
  | {
      /** Rows drawn as strokes between the vertices two reference fields name; without ends, each
       * row is a net joining every vertex port whose reference field names it. */
      edges: Style &
        Stroke & {
          ends?: [from: string, to: string];
          /** A path field of points each row runs through between its ends. */
          bends?: string;
          /** How each row runs between its ends; on the earth geodesic, elsewhere straight, unless set. */
          route?: 'straight' | 'geodesic' | 'orthogonal';
          /** Whether each row ends in an arrowhead at its second end. */
          arrows?: boolean;
        };
    }
  | {
      /** Triangles between three vertices; without a color, each blends its corners' colors. */
      faces: Style & {
        corners: [a: string, b: string, c: string];
      };
    }
  | {
      /** Rows drawn as lines through the field each traces. */
      lines: Style &
        Stroke & {
          /** The field each row traces: a sampled field across the plot's axis. `geometry` unless set. */
          trace?: string;
          /** How each row runs between its samples. */
          interpolation?: 'linear' | 'stepBefore' | 'stepAfter';
        };
    };
