/** The types latkit reads, written by `node npm/build.mjs schema` from `npm/schema.json`. Do not edit. */

import type { TableInput } from './data.js';
import type { Color, ExprInput } from './scene.js';

/** Defaults for areas. */
export interface AreaTheme {
  /** The area color. */
  color?: Color;
}

/**
 * Rows drawn as the areas of a polygon field: parcels, states, lakes, the land and water of a map.
 * The view triangulates each row's polygons once, in the background when they are large. On the
 * earth, areas follow the globe's curve and stay unbroken across the antimeridian. To outline
 * areas, add a `Lines` mark of the same table. It draws their rings.
 */
export interface Areas extends MarkOptions {
  /** The dataset and table drawn, `[data, table]`. */
  areas: TableInput;
  /**
   * The polygon field each row fills. It holds one polygon's rings or several polygons. Defaults to
   * the field named `geometry`.
   */
  geometry?: string | null;
}

/** A plot axis. */
export interface Axis {
  /** The axis title. */
  label?: string | null;
  /** Whether grid lines cross the plot at the ticks. Defaults to `true`. */
  grid?: boolean;
  /** Whether the axis is hidden. Defaults to `false`. */
  hidden?: boolean;
  /**
   * Tick positions, each a value or `[value, label]`. A tick without a label shows its value. When
   * unset, ticks fall at round values.
   */
  ticks?: Tick[] | null;
  /** How tick values are formatted. Defaults to `auto`. */
  format?: Format;
  /**
   * Decimal places of fixed values, or of the significand in scientific and engineering formats. At
   * most 15. When unset, as many as the tick step needs.
   */
  precision?: number | null;
}

/** An image of RGBA texels: straight alpha, sRGB, rows top to bottom. */
export interface Bitmap {
  /** Width and height in texels. */
  size: [number, number];
  /** `size[0] * size[1] * 4` bytes. */
  rgba: number[];
}

/** How much GPU memory latkit uses. */
export interface Budget {
  /**
   * GPU memory in bytes for the data all views of the `Gpu` draw: its pages and each view's per-row
   * state. A table too large for a view's share draws as a paged table, with only the pages the
   * camera needs, so it always fits. Pages no view draws stay cached in the rest of the budget, and
   * the least recently drawn are evicted first. Defaults to half the device's largest storage
   * buffer. The page pool grows as data needs it and never shrinks, so set the budget before drawing
   * data.
   */
  bytes: number;
  /**
   * The most bytes uploaded per frame. Larger data streams in over several frames. Defaults to 32
   * MiB.
   */
  uploadPerFrame: number;
}

/**
 * An operation, written as an object with one key: the operation's name, holding its arguments.
 * For example `{ "add": ["$a", 1] }`. The second argument of `is` and `contains` is plain text,
 * not a field or a color.
 */
export type CallNode =
  | {
      /** The value negated. */
      neg: [ExprInput];
    }
  | {
      /** 1 where the value is at most 0.5, else 0. */
      not: [ExprInput];
    }
  | {
      /** The absolute value. */
      abs: [ExprInput];
    }
  | {
      /** The square root. Negative values give a missing value. */
      sqrt: [ExprInput];
    }
  | {
      /** The sine of the value, an angle in radians. */
      sin: [ExprInput];
    }
  | {
      /** The cosine of the value, an angle in radians. */
      cos: [ExprInput];
    }
  | {
      /** The largest whole number at most the value. */
      floor: [ExprInput];
    }
  | {
      /** The natural logarithm. Values at most 0 give a missing value. */
      ln: [ExprInput];
    }
  | {
      /** e raised to the value. */
      exp: [ExprInput];
    }
  | {
      /** The sum of the two values. */
      add: [ExprInput, ExprInput];
    }
  | {
      /** The first value minus the second. */
      sub: [ExprInput, ExprInput];
    }
  | {
      /** The product of the two values. */
      mul: [ExprInput, ExprInput];
    }
  | {
      /** The first value divided by the second. Dividing by 0 gives a missing value. */
      div: [ExprInput, ExprInput];
    }
  | {
      /**
       * The remainder of the first value divided by the second, with the sign of the second: -1 and 3
       * give 2.
       */
      rem: [ExprInput, ExprInput];
    }
  | {
      /** The first value raised to the power of the second. */
      pow: [ExprInput, ExprInput];
    }
  | {
      /** The smaller of the two values. */
      min: [ExprInput, ExprInput];
    }
  | {
      /** The larger of the two values. */
      max: [ExprInput, ExprInput];
    }
  | {
      /** 1 where the first value is less than the second, else 0. */
      lt: [ExprInput, ExprInput];
    }
  | {
      /** 1 where the first value is at most the second, else 0. */
      le: [ExprInput, ExprInput];
    }
  | {
      /** 1 where the first value is greater than the second, else 0. */
      gt: [ExprInput, ExprInput];
    }
  | {
      /** 1 where the first value is at least the second, else 0. */
      ge: [ExprInput, ExprInput];
    }
  | {
      /** 1 where the two values are equal, else 0. Colors compare too. */
      eq: [ExprInput, ExprInput];
    }
  | {
      /** 1 where the two values differ, else 0. Colors compare too. */
      ne: [ExprInput, ExprInput];
    }
  | {
      /** 1 where both values are above 0.5, else 0. */
      and: [ExprInput, ExprInput];
    }
  | {
      /** 1 where either value is above 0.5, else 0. */
      or: [ExprInput, ExprInput];
    }
  | {
      /** Whether a text field equals the plain text exactly. */
      is: [field: ExprInput, text: string];
    }
  | {
      /**
       * Whether a text field contains the plain text, ignoring case. In a mark, the field must belong to
       * the mark's own table.
       */
      contains: [field: ExprInput, text: string];
    };

/** Where a view looks. */
export type Camera =
  /**
   * A camera over the earth, a plane, or a diagram: the point it looks at and turns about, its zoom,
   * its tilt, and its rotation. A diagram is always seen from straight above, upright.
   */ | {
      /**
       * On the earth, longitude, latitude, and elevation, all in degrees (a degree of elevation is a
       * degree of arc, about 111 km). On a plane or a diagram, x, y, and elevation. In JSON, `[x, y]` is
       * shorthand for elevation 0.
       */
      center: [number, number] | [number, number, number];
      /** The web mercator zoom level on the earth. Elsewhere, log₂ of CSS pixels per unit. */
      zoom: number;
      /** Tilt in degrees from looking straight down, up to 75. Ignored in a diagram. */
      pitch: number;
      /** Degrees clockwise from north, or from up on a plane. Ignored in a diagram. */
      bearing: number;
    }
  | /** A plot camera: the x range shown, and the value range, or `null` to fit the values in view. */ {
      /** The x-axis range shown. */
      x: [number, number];
      /** The value range shown, or `null` to fit the values in view. */
      y?: [number, number] | null;
    };

/** Colors for a range of values: a catalog name, or your own colors. */
export type Colormap = ColormapName | CustomColormap;

/**
 * How a colormap maps values: `sequential` and `diverging` maps clamp, `cyclic` maps wrap, and
 * `categorical` maps give each integer its own color.
 */
export type ColormapKind =
  | /** Low to high. */ 'sequential'
  | /** Below and above a midpoint. */ 'diverging'
  | /** Around a circle: values wrap. */ 'cyclic'
  | /** Distinct colors for distinct integers. */ 'categorical';

/** A colormap from the catalog. */
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

/** A value mapped through a colormap. */
export interface ColormapNode {
  /** The colormap. */
  colormap: Colormap;
  /** The value mapped. A categorical map takes each value's integer part as its category. */
  value: ExprInput;
  /**
   * The values mapped to the colormap's ends. Defaults to the extent of the values shown. A
   * categorical map ignores it.
   */
  domain?: [low: number, high: number] | null;
}

/**
 * How a view responds to the pointer and keyboard, and how much it animates on its own: a preset
 * (`"none"` or `"inspect"`), or options that change the defaults. Each mark sets whether its own
 * rows pick, select, and drag. These options control the view itself.
 */
export type Controls =
  | 'none'
  | 'inspect'
  | {
      /** Whether dragging the background pans the camera. Defaults to `true`. */
      pan?: boolean;
      /**
       * Which input zooms the view. `wheel` zooms with the wheel and pinching. `modifier` zooms with
       * pinching, and with the wheel only while Control or Meta is held (as trackpad pinches send it),
       * so the plain wheel scrolls the page. `off` turns zooming off. Defaults to `wheel`.
       */
      zoom?: Zoom;
      /**
       * Whether dragging with the secondary button, or with Shift, rotates and tilts a map or plane.
       * Defaults to `true`.
       */
      turn?: boolean;
      /**
       * Whether the keyboard controls the view. Defaults to `true`. Tab steps to the row nearest the
       * view's center, and the next Tab or Shift+Tab leaves the view, so it is one stop in the page's
       * tab order. Arrow keys step to the nearest row in their direction. Enter opens the row stepped
       * to, Space selects it, and Escape stops stepping. With no row stepped to, arrow keys pan
       * (Shift+arrows turn), `+` and `-` zoom, Home fits everything, and Escape clears the selection.
       */
      keyboard?: boolean;
      /**
       * Whether the hovered row glows and a hovered vertex sized in CSS pixels grows. Defaults to
       * `true`. Hover is tracked either way: a `'hovered'` event still fires and `hovered` still returns
       * the row.
       */
      hover?: boolean;
      /**
       * How far a row can be from the pointer and still be picked, in CSS pixels. Touch adds 8. Defaults
       * to 6.
       */
      pickRadius?: number;
      /**
       * Whether Shift+drag selects the rows inside a box instead of turning the camera. Shift+click
       * still toggles one row. Defaults to `false`.
       */
      selectBox?: boolean;
      /**
       * Whether the user can draw connections by dragging from a port, from a vertex with Alt held, or
       * an edge's end off its vertex. Connections are reported as a `'connect'` event. Defaults to
       * `false`.
       */
      connect?: boolean;
      /** Whether Delete and Backspace report the selection as a `'delete'` event. Defaults to `false`. */
      delete?: boolean;
      /**
       * Whether clicking again at the same point, with the camera unmoved, selects the next row under
       * the pointer, nearest first. This lets overlapping rows each be selected. Defaults to `false`.
       */
      cycle?: boolean;
      /**
       * How many seconds a touch or pen must hold still to request a menu (a `'menu'` event), like the
       * secondary button. 0 turns this off. Defaults to 0.5.
       */
      press?: number;
      /**
       * How much the view animates on its own: eases, camera flights, coasting, orbits, comets, and
       * options that read `elapsed`. `system` follows the user's reduced-motion setting, `full` animates
       * everything, and `reduced` animates only motion the user drives. Defaults to `system`.
       */
      motion?: Motion;
    };

/** A custom colormap: its kind, its colors, and for a categorical map, its category names. */
export interface CustomColormap {
  /** How the colors map values. */
  kind: ColormapKind;
  /**
   * The colors, blended in OKLab. Each is a color, spaced evenly between its neighbors like a CSS
   * gradient, or a `[place, color]` pair with a place from 0 to 1. Places must ascend. A categorical
   * map takes one color per category, without places, at most 256.
   */
  colors: (
    /**
     * A CSS color, such as `#ffb000`, `rebeccapurple`, or `oklch(70% 0.15 60)`: hex, a named color,
     * `transparent`, or `rgb`, `hsl`, `hwb`, `lab`, `lch`, `oklab`, or `oklch`.
     */ Color | [number, Color]
  )[];
  /** The category names in category order, shown in legends. Categorical maps only. */
  categories?: string[];
}

/**
 * A flat sheet for diagrams, seen from straight above. The camera pans and zooms but does not
 * turn. Positions are in units with y down, and a unit is a CSS pixel at zoom 0. Sizes, padding,
 * ports, strokes, text, and the theme's lengths are in units too. Sizes given with `px`, the text
 * halo, the focus glow, and the pick radius stay in CSS pixels. Zooming scales the whole picture.
 * Only a diagram has ports, groups, nets, and orthogonal routes, and the scene's layout places its
 * blocks.
 */
export interface Diagram {
  /** The grid drawn under the marks. Defaults to dots 20 units apart. */
  grid?: Grid;
}

/** How a diagram's blocks, groups, ports, and wires look. */
export interface DiagramTheme {
  /** The fill color of group containers. */
  group?: Color;
  /** The color of the one-unit border around blocks and groups. `null` draws no border. */
  outline?: Color | null;
  /** The corner radius of blocks and groups. A block marker can set its own. */
  corner?: number;
  /** The width of ports. */
  portSize?: number;
  /** The bend radius of orthogonal wires. */
  bend?: number;
  /** The space between a group's members and its border. */
  groupPadding?: number;
  /** How blocks and groups cast shadows on the sheet. */
  shadow?: ShadowTheme;
}

/** A direction on screen. */
export type Direction =
  | /** Toward the right. */ 'right'
  | /** Toward the left. */ 'left'
  | /** Toward the bottom. */ 'down'
  | /** Toward the top. */ 'up';

/**
 * The earth: positions are longitude and latitude in degrees. The ground uses the theme's `earth`
 * colors.
 *
 * A flat map shows the world once. Its ground ends at the antimeridian and at Web Mercator's
 * latitude limit. The camera zooms out until the whole world fits the view, and pans until the
 * world's edges meet the view's edges. On a globe, longitude wraps, and the camera zooms out until
 * the globe spans a third of the view's shorter side.
 */
export interface Earth {
  /** A flat web mercator map (`mercator`) or a globe (`globe`). Defaults to `mercator`. */
  projection?: Projection;
  /**
   * Whether lines of longitude and latitude cross the ground, in the theme's `grid` color. Defaults
   * to `true`.
   */
  graticule?: boolean;
  /**
   * Lights the earth by the sun's position this many seconds after the Unix epoch, plus the view's
   * axis coordinate when it has one. The night side darkens the ground and everything on it, down to
   * the theme's `earth.night` brightness. When unset, the earth is lit evenly.
   */
  daylight?: number | null;
  /**
   * Whether air glows around the globe, in the theme's `earth.atmosphere` color, brighter on the day
   * side. Defaults to `false`.
   */
  atmosphere?: boolean;
}

/** How the earth looks. */
export interface EarthTheme {
  /** The ground color. */
  ground?: Color;
  /** The color of the air glowing around the globe, when the earth's `atmosphere` is on. */
  atmosphere?: Color;
  /** The brightness of the night side when the earth has `daylight`, from 0 to 1. */
  night?: number;
}

/** Defaults for edges, and how parallel edges and arrowheads look. */
export interface EdgeTheme {
  /**
   * The edge color. `null` blends the colors of each edge's two vertices. With `null`, a diagram's
   * wires and edges without `ends` (nets and poles) use the text color.
   */
  color?: Color | null;
  /** The edge width, in the space's unit. */
  width?: number;
  /**
   * In a diagram, the distance between edges joining the same two vertices and between parallel
   * orthogonal wires. Wires keep twice this distance from blocks where they can.
   */
  spacing?: number;
  /**
   * Outside a diagram, how far edges joining the same two vertices bow apart. Each lane bows out by
   * this fraction of the edge's length, measured at its middle. Parallel edges spread at most eight
   * lanes wide, and more lanes pack closer. Bows scale with the zoom.
   */
  bow?: number;
  /** How far an arrowhead extends beyond the edge's width. A head's length is this plus the width. */
  arrow?: number;
}

/**
 * Rows drawn as strokes between two vertices named by reference fields: branches, links, wires. In
 * a diagram, a row without ends is a net. It joins every vertex port whose reference field names
 * it.
 */
export interface Edges extends MarkOptions, StrokeOptions {
  /** The dataset and table drawn, `[data, table]`. */
  edges: TableInput;
  /** The reference fields naming each row's two vertices. */
  ends?: [from: string, to: string] | null;
  /** A path field whose points each row passes through between its ends. */
  bends?: string | null;
  /**
   * How each row runs between its ends. Defaults to geodesic on the earth and straight elsewhere.
   * `orthogonal` routes around blocks with rounded bends, in diagrams only.
   */
  route?: Route | null;
  /**
   * Whether each row has an arrowhead at its second end. A net has one at each input it reaches.
   * Defaults to `false`.
   */
  arrows?: boolean;
  /**
   * Draws each row as a pole from its own vertex down to the ground, on a plane or the earth. Poles
   * take no `ends`, `bends`, or `joins`. Defaults to `false`.
   */
  poles?: boolean;
  /**
   * Draws each row as a net on a plane or the earth. The net joins the vertex rows of `table` whose
   * `reference` field names it, as a star from their center to each member.
   */
  joins?: [table: string, reference: string] | null;
}

/**
 * A request for each row's least and greatest value of a sampled field over equal spans of the
 * axis. It reads field `field` of table `table` over `spans` equal spans from `range[0]` to
 * `range[1]`, for every row or for the rows in `ids`, in that order. Like a query, it is plain
 * data that deserializes from JSON.
 */
export interface EnvelopeRequest {
  /** The table to read. */
  table: string;
  /** The sampled field to read. */
  field: string;
  /** The axis range the spans cover, `[first, last]`. Both are finite, with `first <= last`. */
  range: [number, number];
  /** The number of equal spans to divide the range into. At least 1. */
  spans: number;
  /** The rows to read, in this order. Defaults to every row. */
  ids?: Ids | null;
}

/**
 * A value for each row. A number or boolean is a constant and `null` is missing. A string starting
 * with `$` reads that field, and any other string is a CSS color. An object computes a value.
 */
export type ExprNode =
  | number
  | boolean
  | /** A missing value. An option that is missing uses the theme's value. */ null
  | /**
     * A field or a color. `"$kv"` reads field `kv`. Any other string is a CSS color, such as `#ffb000`
     * or `rebeccapurple`. Write a field named `$x` as `{ "field": "$x" }`.
     */ string
  | FieldNode
  | StateNode
  | WhenNode
  | ScaleNode
  | ColormapNode
  | CallNode;

/**
 * Rows drawn as triangles between three vertices named by reference fields: meshes, surfaces, and
 * fields interpolated across a network. Faces are lit from the camera, so a flat mesh seen from
 * above shows its exact colors.
 */
export interface Faces extends MarkOptions {
  /** The dataset and table drawn, `[data, table]`. */
  faces: TableInput;
  /**
   * The reference fields naming each row's three vertices. Required. Without a color, a face blends
   * the colors of its corners.
   */
  corners?: [a: string, b: string, c: string] | null;
}

/**
 * A field's value in each row, from the mark's own table. With `from`, it reads another dataset's
 * table, joined by row id. `"$name"` is the short form of `{ "field": "name" }`.
 */
export interface FieldNode {
  /** The field's name. */
  field: string;
  /** The dataset and table the field is read from, joined by row id. */
  from?: TableInput | null;
  /**
   * For a sampled field, reads the last frame at or before the shown coordinate instead of
   * interpolating. Defaults to `false`.
   */
  step?: boolean;
}

/** The target of a view's fit. */
export type Fit =
  | /** Everything drawn. */ 'all'
  | {
      /** These rows. */
      rows: Rows[];
    }
  | {
      /** Brings this row into view, keeping the zoom. */
      reveal: Row;
    }
  | {
      /** The box from `min` to `max`: x, y, and elevation. */
      bounds: {
        /** The minimum corner. */
        min: [number, number, number];
        /** The maximum corner. */
        max: [number, number, number];
      };
    };

/**
 * How comets along edges and lines look. A comet has a round head, brightest at its middle, and a
 * tail that thins and fades.
 *
 * `spacing` and `length` must use the same unit, and each row's `flow` speed is in that unit too.
 * In position units (degrees on the earth), comets scale with the zoom and stay in place along
 * their lines. In CSS pixels, they keep their size and speed on screen. A plain number is in the
 * space's unit.
 */
export interface FlowTheme {
  /**
   * The comet color. Its alpha sets how strongly a comet covers its stroke. A fully transparent
   * color turns comets off.
   */
  color?: Color;
  /** The distance between consecutive comets. */
  spacing?: Length;
  /** The length of a comet's tail behind its head. */
  length?: Length;
  /** The width of a comet's head, in the space's unit. A head is never narrower than its stroke. */
  width?: number;
}

/** How hovered and selected rows glow, and how rows outside a selection dim. */
export interface FocusTheme {
  /** The glow color around hovered rows. */
  hover?: Color;
  /** The glow color around selected rows. `null` uses each row's own color. */
  selected?: Color | null;
  /** How far the hover and selection glows reach, in CSS pixels. */
  glow?: number;
  /** The opacity of rows outside the selection while any row is selected, from 0 to 1. */
  dim?: number;
  /** The scale factor for a hovered vertex sized in CSS pixels. Vertices sized in units only glow. */
  grow?: number;
}

/** How an axis formats its tick values. */
export type Format =
  | /** Fixed decimals, scientific past a million or below a ten-thousandth. */ 'auto'
  | /** Fixed decimals: `1500.0`. */ 'fixed'
  | /** A significand and a power of ten: `1.5e3`. */ 'scientific'
  | /** A significand and a power of ten that is a multiple of three: `1.5e3`, `150e-6`. */ 'engineering';

/** A plane's or a diagram's grid: `"off"`, `{ lines: { pitch } }`, or `{ dots: { pitch, snap } }`. */
export type Grid =
  | /** No grid. */ 'off'
  | {
      /** Lines `pitch` units apart, thinned by factors of ten as the view zooms out. */
      lines: {
        /** Units between lines. */
        pitch: number;
      };
    }
  | {
      /** Dots `pitch` units apart. With `snap`, drags in a diagram snap to them. */
      dots: {
        /** Units between dots. */
        pitch: number;
        /** Whether drag positions snap to the dots, in a diagram. Defaults to `false`. */
        snap?: boolean;
      };
    };

/**
 * A row's id: a whole number from 0, or a text. A number above 2^53 - 1 is written as its decimal
 * text, which names the same row.
 */
export type Id = number | string;

/**
 * Row ids: a list of numbers or texts, or `{count}` for rows 0 to count - 1. In a reference, null
 * names no row.
 */
export type Ids =
  | (Id | null)[]
  | {
      /** The number of rows, whose ids are 0 to count - 1. */
      count: number;
    };

/** How a line runs between its samples. */
export type Interpolation =
  | /** Straight from each sample to the next. */ 'linear'
  | /**
     * Each value holds from the previous sample up to its own, so the line steps at the previous
     * sample.
     */ 'stepBefore'
  | /** Each value holds until the next sample, where the line steps. */ 'stepAfter';

/**
 * Text for each row, placed beside, inside, or along the row's shape and moving with it: a text
 * field, or options. A label shows when its row is visible and its text fits, for example inside a
 * block.
 *
 * Labels beside or along their rows never overlap. Where they would, the row drawn on top keeps
 * its label (so `priority` decides), and a dense view labels as many rows as fit. A row whose text
 * is missing or empty has no label, so a `when` that returns the field or missing labels only some
 * rows. In a diagram, a label scales with the zoom, fades out when too small to read, and shows
 * wherever it fits its vertex.
 */
export type Label =
  | ExprInput
  | {
      /**
       * The text field to show, or a `when` that returns that field or missing. A row whose text is
       * missing or empty has no label. In a diagram, the text may read only data, since the sheet sizes
       * blocks around it.
       */
      text: ExprInput;
      /** Font size in CSS pixels, or diagram units in a diagram. Defaults to the theme's `text.size`. */
      size?: number | null;
      /** Each row's text color. Defaults to the theme's text color. */
      color?: ExprInput | null;
      /** The width at which lines wrap, in CSS pixels, or diagram units in a diagram. */
      maxWidth?: number | null;
      /** The CSS font family list for the text. Defaults to the theme's `text.font`. */
      font?: string | null;
    };

/**
 * Layered drawing: vertices in ranks, edges pointing along `direction`, and nets ranked from their
 * outputs.
 */
export interface Layered {
  /** The direction edges point. Defaults to `right`. */
  direction?: Direction;
  /** Distance between vertices within a rank, in position units. Defaults to 30. */
  gap?: number;
  /** Distance between ranks, in position units. Defaults to 80. */
  rankGap?: number;
}

/**
 * How the view places vertex rows that have no position: a name, or
 * `{ stress | layered: options }`. In a diagram it places blocks. On a plane or the earth it
 * places points among the rows they link to. Gaps are in position units: diagram units, plane
 * units, or degrees on the earth.
 *
 * A placed row keeps its place. Rows added later are placed around the others, and `view.arrange`
 * lays out every row again.
 */
export type Layout =
  | 'none'
  | 'stress'
  | 'layered'
  | {
      /** Drawn distances follow graph distances. */
      stress: Stress;
    }
  | {
      /** Ranks along a direction, for processes and hierarchies. */
      layered: Layered;
    };

/**
 * A length: a number in CSS pixels, or units in a diagram. `{ px }` is always CSS pixels.
 * `{ units }` is position units (degrees on the earth), which grow as the view zooms in.
 */
export type Length =
  | number
  | {
      /** CSS pixels, the same at any zoom. */
      px: number;
    }
  | {
      /** Position units (degrees on the earth), which grow as the view zooms in. */
      units: number;
    };

/** Defaults for lines. */
export interface LineTheme {
  /** The line color. */
  color?: Color;
  /** The line width, in the space's unit. */
  width?: number;
}

/**
 * Rows drawn as lines along a path field (roads, rivers, borders) or a polygon field's rings (area
 * outlines). On a plot, each row traces a sampled field's history across the data's axis, like a
 * monitor. On the earth, paths follow the globe's curve and stay unbroken across the antimeridian.
 */
export interface Lines extends MarkOptions, StrokeOptions {
  /** The dataset and table drawn, `[data, table]`. */
  lines: TableInput;
  /**
   * The path or polygon field each row runs along. Defaults to the field named `geometry`. Not
   * allowed on a plot.
   */
  geometry?: string | null;
  /**
   * The sampled field each row traces across the data's axis. Required on a plot, and allowed only
   * there. A field with no frames yet draws nothing until its first frame arrives.
   */
  trace?: string | null;
  /** How each row runs between its samples on a plot. Defaults to `linear`. */
  interpolation?: Interpolation;
}

/**
 * One table a scene draws. The mark's kind is the key that holds its table, next to its options:
 * `{ vertices: [data, table], radius: 4 }`.
 */
export type Mark = Vertices | Edges | Faces | Lines | Areas;

/** The options every mark has. */
export interface MarkOptions {
  /**
   * Each row's color: a CSS color, a value through a colormap, or a conditional that picks between
   * colors. Defaults to the theme's color for the mark. Faces default to a blend of their corners'
   * colors.
   */
  color?: ExprInput | null;
  /** Whether each row is drawn and can be picked. Defaults to `true`. */
  visible?: ExprInput;
  /**
   * Each row's priority. It reads only data, not view state. Higher rows draw on top, keep their
   * labels where labels overlap, and are dropped last when a large table is thinned.
   */
  priority?: ExprInput | null;
  /** Distinguishes two marks of the same table across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows respond to hover, clicks, and picks. Defaults to on for vertices, edges, faces, and
   * plot traces, and off for geometry: areas, and lines along paths such as coasts, borders, and
   * roads.
   */
  pick?: boolean | null;
  /** Whether clicking a row selects it. Defaults to `true`. */
  select?: boolean;
  /**
   * Whether pressing and moving a row drags it instead of panning the camera. Drags are reported as
   * a `'drag'` event. Defaults to `false`.
   */
  drag?: boolean;
  /** Each row's label: a text field, or label options. */
  label?: Label | null;
  /**
   * A legend of the mark's colors at the view's bottom right, with this title. It shows a ticked
   * colormap across its domain, a cell for each category, or a swatch for each name in the
   * colormap's `categories`. `color` must map through a colormap with a fixed domain or named
   * categories. In a conditional, `otherwise` is searched before the cases.
   */
  legend?: string | null;
}

/**
 * How a vertex is drawn: a shape's name, `"block"`, or
 * `{ shape | block | gauge | pie | icon | wgsl: options }`. Defaults to an ellipse.
 */
export type Marker =
  | 'ellipse'
  | 'rectangle'
  | 'rounded'
  | 'diamond'
  | 'block'
  | {
      /** A filled shape. */
      shape: Shape;
    }
  | {
      /** A rectangle with rounded corners that holds its label inside, like a diagram's blocks. */
      block: {
        /** Corner radius in CSS pixels, or units in a diagram. Defaults to the theme's `diagram.corner`. */
        corner?: number | null;
      };
    }
  | {
      /**
       * A shape's outline, filled to `fill` (0 to 1). A circle fills around its edge, and other shapes
       * fill upward.
       */
      gauge: {
        /** How full each row's gauge is, from 0 to 1. */
        fill: ExprInput;
        /** The outline's shape. Defaults to an ellipse. */
        shape?: Shape;
      };
    }
  | {
      /** A circle divided into slices sized in proportion to their values. */
      pie: {
        /** Each slice's value. */
        slices: ExprInput[];
        /** Each slice's color. */
        colors: Color[];
        /** The hole in the middle, as a fraction of the radius. Defaults to 0. */
        hole?: number;
      };
    }
  | {
      /** One of `images`, fitted to the marker's box. `index` picks the image for each row. */
      icon: {
        /** The images. */
        images: Bitmap[];
        /** Each row's image index, from 0. */
        index: ExprInput;
      };
    }
  | {
      /**
       * A custom marker in WGSL. `source` defines `fn marker(f: MarkerFragment) -> MarkerColor`, which
       * can read up to eight `inputs` as `f.input[i]`. It compiles once, when the view first draws it.
       */
      wgsl: {
        /** The WGSL source of the `marker` function. */
        source: string;
        /** Each row's inputs, at most eight. */
        inputs?: ExprInput[];
      };
    };

/** How much a view animates on its own. */
export type Motion =
  | /** Follows the system setting: reduced when the user has asked their system for less motion. */ 'system'
  | /** All motion. */ 'full'
  | /**
     * Only motion the user drives: changes apply at once, flights jump, nothing coasts or orbits, and
     * comets and options that read `elapsed` stay still.
     */ 'reduced';

/** Sort direction. Rows where the key has no value sort last in either direction. */
export type Order = /** Smallest first. */ 'ascending' | /** Largest first. */ 'descending';

/** A plane: positions are in plane units. */
export interface Plane {
  /** The grid drawn under the marks. Defaults to lines 10 units apart. */
  grid?: Grid;
}

/** A plot: x is the data's axis, y the values. */
export interface Plot {
  /** The horizontal axis. */
  x?: Axis;
  /** The vertical axis. */
  y?: Axis;
}

/** How a plot looks. */
export interface PlotTheme {
  /** The color of the line at the view's current axis coordinate. */
  playhead?: Color;
}

/**
 * A port on one side of a vertex's marker, where a net connects: a side name, or options. The
 * vertex names the net in a reference field. An output drives its net: layouts rank a net from its
 * outputs, and the net's arrows point away from them.
 */
export type Port =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | {
      /** The side of the marker it sits on. */
      side: Side;
      /**
       * Its position among the ports on its side, counted from the top or left. Ports without an `order`
       * follow those with one, in declaration order.
       */
      order?: number | null;
      /** Its name, drawn beside it inside the marker. */
      label?: string | null;
      /** Its shape. Defaults to an ellipse. */
      shape?: Shape;
      /** Whether it is an output, which drives its net. Defaults to `false` (an input). */
      output?: boolean;
    };

/** How the earth is projected. */
export type Projection = /** Web mercator. */ 'mercator' | /** A sphere. */ 'globe';

/** A size in CSS pixels, regardless of the space's unit. */
export interface Px {
  /** The size, in CSS pixels. */
  px: ExprInput;
}

/** The rows of a table to read back, run through the expressions marks draw with. */
export interface Query {
  /** The table to read. */
  of: string;
  /**
   * The rows to read, in this order unless sorted. Defaults to every row. Ids that name no row are
   * skipped.
   */
  ids?: Ids | null;
  /** Keeps only the rows for which this is true. */
  filter?: ExprInput | null;
  /**
   * Keys to sort by. Each key breaks ties left by the keys before it. Rows where a key has no value
   * sort last, and rows equal on every key keep their order.
   */
  sort?: [ExprInput, Order][];
  /** How many of the kept rows to skip. */
  offset?: number;
  /**
   * The most rows to return. When sorting with a limit, the first `offset + limit` rows are selected
   * in linear time and only those are sorted.
   */
  limit?: number | null;
  /**
   * Fields to return, by output name. A plain field returns that field as stored, and any other
   * expression returns numbers. Defaults to every field. An empty object returns the ids alone.
   */
  select?: { [name: string]: ExprInput } | null;
  /** The axis coordinate at which sampled fields are read. Defaults to their last frame. */
  at?: number | null;
}

/** How an edge runs between its ends. */
export type Route =
  | /** A straight line on screen. */ 'straight'
  | /** Along the great circle, on the earth. */ 'geodesic'
  | /**
     * Horizontal and vertical runs around vertices that leave and enter at their sides, with rounded
     * bends. Diagrams only.
     */ 'orthogonal';

/**
 * One row, identified by dataset name, table name, and id. It stays valid across any change that
 * keeps those names and the id.
 */
export interface Row {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The row's id in the table. */
  id: Id;
}

/**
 * Rows of one table in a dataset, by id. Views use it for selections, fits, and the rows events
 * report.
 */
export interface Rows {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The rows' ids in the table. */
  ids: Id[];
}

/** A value mapped linearly onto a range, clamped to the range. */
export interface ScaleNode {
  /** The range. */
  scale: [low: number, high: number];
  /** The value mapped. */
  value: ExprInput;
  /** The values mapped to the range's ends. Defaults to the extent of the values shown. */
  domain?: [low: number, high: number] | null;
}

/**
 * A view's content and behavior: a space, marks drawn in order, a layout, a theme, controls, an
 * ease duration, and an optional title.
 *
 * A scene is plain data. In JSON, fields are camelCase, and the key naming each mark's kind holds
 * its dataset and table: `{ "vertices": ["grid", "Bus"], "radius": 4 }`.
 */
export interface Scene {
  /** The coordinate space positions are in. */
  space: Space;
  /** The marks, in drawing order: each draws over the marks before it. */
  marks?: Mark[];
  /**
   * How the view places vertex rows that have no position, such as a diagram's blocks or points on a
   * plane or the earth. Defaults to `none`.
   */
  layout?: Layout;
  /** Default colors and sizes, and the look of text, focus, and each space. Defaults to `dark`. */
  theme?: Theme;
  /** How the view responds to the pointer and keyboard. */
  controls?: Controls;
  /** How many seconds scene and data changes take to animate. 0 turns animation off. Defaults to 0.3. */
  ease?: number;
  /** A title drawn at the view's top left, larger than the theme's text. */
  title?: string | null;
  /** A subtitle drawn under the title. */
  subtitle?: string | null;
}

/** How a diagram's blocks and groups cast shadows on the sheet, for vertex marks with `shadow` on. */
export interface ShadowTheme {
  /** The color a shadow darkens toward. Its alpha sets how dark the shadow is under the block. */
  color?: Color;
  /** How far a shadow falls below its block or group. Its edge softens over the same distance. */
  lift?: number;
}

/** A marker's outline. */
export type Shape =
  | /** An ellipse: a circle when its width and height are equal. */ 'ellipse'
  | /** A rectangle. */ 'rectangle'
  | /** A rectangle with rounded corners. */ 'rounded'
  | /** A diamond. */ 'diamond';

/** A side of a marker. */
export type Side =
  | /** The left side. */ 'left'
  | /** The right side. */ 'right'
  | /** The top. */ 'top'
  | /** The bottom. */ 'bottom';

/**
 * A size: a value in CSS pixels, or units in a diagram. `{ px }` is always CSS pixels. `{ units }`
 * is position units (degrees on the earth), which grow as the view zooms in.
 */
export type Size = ExprInput | Px | Units;

/**
 * The coordinate space of a scene's positions: a name, or
 * `{ plane | diagram | earth | plot: options }`.
 *
 * The space sets the unit of lengths that do not name their own. In a diagram it is the diagram
 * unit, one CSS pixel at zoom 0. Elsewhere it is the CSS pixel. Only a diagram has ports, groups,
 * nets, and orthogonal routes.
 */
export type Space =
  | 'plane'
  | 'diagram'
  | 'earth'
  | 'plot'
  | {
      /** Longitude and latitude in degrees, on a flat map or a globe. */
      earth: Earth;
    }
  | {
      /** Plane units, with elevation. The camera can turn and tilt. */
      plane: Plane;
    }
  | {
      /** The data's axis horizontally and values vertically. */
      plot: Plot;
    }
  | {
      /** A flat sheet for diagrams: x right and y down, every length in units. */
      diagram: Diagram;
    };

/**
 * View state of each row: `selected`, `hovered`, `pointer` (CSS pixels from a vertex to the
 * pointer), `elapsed` (seconds since the view was created), or `zoom` (the camera's zoom).
 */
export type State = 'selected' | 'hovered' | 'pointer' | 'elapsed' | 'zoom';

/** View state of each row, such as whether it is selected. */
export interface StateNode {
  /** The state read. */
  state: State;
}

/**
 * Stress majorization: vertices move until drawn distances match graph distances. Then overlapping
 * boxes separate, keeping a quarter of `gap` between them.
 */
export interface Stress {
  /** Distance between the centers of linked vertices, in position units. Defaults to 40. */
  gap?: number;
}

/** The options of marks drawn as strokes: edges and lines. */
export interface StrokeOptions {
  /**
   * Each row's width in CSS pixels, or units in a diagram, unless given with `px` or `units`.
   * Defaults to the theme's width.
   */
  width?: Size | null;
  /** Whether each row is dashed, using the theme's `dash` period. Defaults to `false`. */
  dash?: ExprInput;
  /**
   * The speed of comets along each row, per second, in the unit of the theme's `flow` lengths.
   * Negative speeds flow backward. 0 draws no comets. Defaults to 0. When the speed changes, comets
   * continue from where they are.
   */
  flow?: ExprInput;
}

/** How labels, axis ticks, and titles look. */
export interface TextTheme {
  /** The text color. */
  color?: Color;
  /** The CSS font family list. */
  font?: string;
  /** The font size, in the space's unit. */
  size?: number;
  /** Width of the background-colored halo around label text, in CSS pixels. */
  halo?: number;
}

/**
 * Default colors and sizes for marks, and the look of text, focus, comets, and each space, grouped
 * by subject: a base theme's name (`"dark"` or `"light"`), or options that change a base. `base`
 * names the base and defaults to `dark`. Each option replaces only the base value it sets.
 *
 * Lengths are in CSS pixels, or units in a diagram. The grid spacing, the text halo, and the focus
 * glow are always in CSS pixels.
 */
export type Theme =
  | 'dark'
  | 'light'
  | {
      /** The background color. */
      background?: Color;
      /** The color of a plane's or diagram's grid, a plot's grid lines, and the earth's graticule. */
      grid?: Color;
      /**
       * The least distance between the lines (or dots) of a plane's or diagram's grid and of the earth's
       * graticule, in CSS pixels. Their spacing steps by 1, 2, and 5 times a power of ten (and 30° and
       * 90° on the earth), and the finer step fades out as it nears this distance.
       */
      gridSpacing?: number;
      /** The color a colormap gives a missing value, such as a row with no value in the field. */
      missing?: Color;
      /** The dash period: one dash and one gap of equal length. */
      dash?: number;
      /** How much faces darken as they turn away from the camera, from 0 to 1. */
      shading?: number;
      /** How labels, axis ticks, and titles look. */
      text?: TextTheme;
      /** Defaults for vertices. */
      vertex?: VertexTheme;
      /** Defaults for edges, and how parallel edges and arrowheads look. */
      edge?: EdgeTheme;
      /** Defaults for lines. */
      line?: LineTheme;
      /** Defaults for areas. */
      area?: AreaTheme;
      /** How hovered and selected rows glow, and how rows outside a selection dim. */
      focus?: FocusTheme;
      /** How comets flowing along edges and lines look. */
      flow?: FlowTheme;
      /** How a diagram's blocks, groups, ports, and wires look. */
      diagram?: DiagramTheme;
      /** How the earth looks. */
      earth?: EarthTheme;
      /** How a plot looks. */
      plot?: PlotTheme;
      /** The theme these options change. Defaults to `dark`. */
      base?: 'dark' | 'light';
    };

/** A tick in JSON: a value, or `[value, label]`. */
export type Tick = number | [number, string | null];

/**
 * A size in position units (degrees on the earth), regardless of the space's unit. It scales with
 * the zoom. `atLeast` and `atMost` bound it in CSS pixels.
 */
export interface Units {
  /** The size, in position units. */
  units: ExprInput;
  /** The minimum on-screen size in CSS pixels, however far the view zooms out. */
  atLeast?: number | null;
  /** The maximum on-screen size in CSS pixels, however far the view zooms in. */
  atMost?: number | null;
}

/** Defaults for vertices. */
export interface VertexTheme {
  /** The vertex color. */
  color?: Color;
  /** The vertex radius, in the space's unit. */
  radius?: number;
}

/** Rows drawn as markers: points of a map, nodes of a graph, blocks of a diagram. */
export interface Vertices extends MarkOptions {
  /** The dataset and table drawn, `[data, table]`. */
  vertices: TableInput;
  /**
   * Each row's x and y. Rows without a position are placed by the point field `geometry` names. The
   * scene's layout places rows that have neither.
   */
  position?: [ExprInput, ExprInput] | null;
  /**
   * The point field that places rows when `position` is not set. Defaults to the field named
   * `geometry`.
   */
  geometry?: string | null;
  /**
   * Height above the ground. On the earth, in degrees of arc like every length there (one is about
   * 111 km). Defaults to 0. Not allowed in a diagram, which is flat.
   */
  elevation?: ExprInput;
  /**
   * Each row's radius in CSS pixels, or units in a diagram, unless given with `px` or `units`. A
   * diagram does not accept `px`. Defaults to the theme's `vertex.radius`.
   */
  radius?: Size | null;
  /**
   * Each row's width and height, for markers that are not round. In CSS pixels, or units in a
   * diagram, unless given with `px` or `units`. A diagram does not accept `px`. In a diagram, a
   * block without a size fits its label and ports.
   */
  size?: [Size, Size] | null;
  /** How each row is drawn. Defaults to an ellipse. */
  marker?: Marker;
  /** A ring around each row's marker in this color. A missing or transparent color draws no ring. */
  ring?: ExprInput | null;
  /**
   * Ports on each row, one for each reference field that names a net. An `edges` mark of the net
   * table, without `ends`, draws the nets. Diagrams only.
   */
  ports?: [reference: string, port: Port][];
  /**
   * Makes each row a group containing, for each `[table, reference]`, the rows of `table` whose
   * `reference` field names it, so a group can hold rows of several tables. A group draws as a
   * container around its members, with its label as a title in its header. Diagrams only.
   */
  contains?: [table: string, reference: string][];
  /**
   * Whether each block or group casts a shadow on the sheet, styled by the theme's `diagram.shadow`.
   * Defaults to `false`. Diagrams only.
   */
  shadow?: boolean;
}

/** The value of the first case whose condition holds, else `otherwise`. */
export interface WhenNode {
  /** The cases, as `[condition, value]` pairs tried in order. */
  when: [condition: ExprInput, value: ExprInput][];
  /** The value where no condition holds. */
  otherwise: ExprInput;
}

/** Which input zooms a view. */
export type Zoom =
  | /** The wheel, pinching, and the keys. */ 'wheel'
  | /**
     * Pinching and the keys, and the wheel only with Control or Meta held (as trackpad pinches send
     * it), so the plain wheel scrolls the page.
     */ 'modifier'
  | /** No input zooms. */ 'off';
