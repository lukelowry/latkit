/** Written by `node npm/build.mjs schema` from `npm/schema.json`, what latkit reads: do not edit. */

import type { Color, ExprInput } from './scene.js';

/**
 * Rows drawn as the areas a polygon field holds: parcels, states, lakes, the land and water of a
 * map. The view cuts each row's polygons into triangles once, off the frame when they are large;
 * on the earth they bend with the globe and stay whole across the antimeridian. Outline areas with
 * a `Lines` mark of the same table, which draws their rings.
 */
export interface Areas {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /** The polygon field each row fills: one polygon's rings, or polygons. `geometry` unless set. */
  geometry?: string | null;
  /** Each row's color; the theme's unless set. */
  color?: ExprInput | null;
  /** Whether each row is drawn and picked. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows are hovered, clicked, and probed. Unless set, rows that are things are (vertices,
   * edges, faces, a plot's traces) and geometry is not (areas, and lines along paths: coasts,
   * borders, roads).
   */
  pick?: boolean | null;
  /** Whether a click selects a row. */
  select?: boolean;
  /** Whether pressing a row drags it instead of panning. */
  drag?: boolean;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** A plot axis. */
export interface Axis {
  /** The axis title. */
  label?: string | null;
  /** Whether grid lines cross the plot at the ticks. */
  grid?: boolean;
  /** Whether the axis is hidden. */
  hidden?: boolean;
  /**
   * Ticks at these values, each a value or `[value, label]`, their values written unless labeled;
   * round values unless set.
   */
  ticks?: Tick[] | null;
  /** How tick values are written. */
  format?: Format;
  /**
   * Decimals of fixed values, or of the significand of scientific and engineering ones; as many as
   * the ticks' step needs unless set.
   */
  precision?: number | null;
}

/** An operation of two values. */
export type Binary =
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

export interface BinaryNode {
  op: Binary;
  args: [ExprInput, ExprInput];
}

/** RGBA texels, straight alpha, sRGB, rows top to bottom. */
export interface Bitmap {
  /** Width and height in texels. */
  size: [number, number];
  /** `size[0] * size[1] * 4` bytes. */
  rgba: number[];
}

/** How much GPU memory latkit uses. */
export interface Budget {
  /**
   * Bytes the data every view of the `Gpu` draws may take on the GPU: its pages, and each view's
   * rows. A view draws a table too large for its share through the tiles the camera asks for, so
   * what it draws always fits; pages no view draws stay cached in the room left, the least recently
   * drawn going first. By default half the device's largest storage buffer. The pool of pages grows
   * as data needs it, and never shrinks: set the budget before data draws.
   */
  bytes: number;
  /** Bytes uploaded per frame at most; larger data streams in over frames. */
  uploadPerFrame: number;
}

/** Where a view looks. */
export type Camera =
  | {
      /**
       * Longitude, latitude, and elevation on the earth; x, y, and elevation on a plane or a diagram. In
       * JSON, `[x, y]` looks at the ground.
       */
      center: [number, number] | [number, number, number];
      /** On the earth the web mercator level; elsewhere, log₂ of pixels per unit. */
      zoom: number;
      /** Degrees from looking straight down, up to 75; 0 in a diagram. */
      pitch: number;
      /** Degrees clockwise from north, or from up on a plane; 0 in a diagram. */
      bearing: number;
    }
  | {
      /** The axis range shown. */
      x: [number, number];
      /** The value range shown, or none to fit what is in view. */
      y?: [number, number] | null;
    };

export interface ColorNode {
  /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
  color: Color;
}

/** Colors for a range of values: a catalog name, or your own colors. */
export type Colormap = ColormapName | CustomColormap;

/** How a colormap spans values. */
export type ColormapKind = 'sequential' | 'diverging' | 'cyclic' | 'categorical';

/** A colormap of the catalog. */
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

/** `value` through `colormap`: from its `domain`, else from the extent of the values shown. */
export interface ColormapNode {
  colormap: Colormap;
  value: ExprInput;
  domain?: [low: number, high: number] | null;
}

/** Whether a text field holds the text, ignoring case: read by queries, which hold texts. */
export interface ContainsNode {
  contains: [field: ExprInput, text: string];
}

/**
 * How a view answers the pointer and keyboard, and how much it moves on its own: a preset, or
 * options over the defaults. Each mark says whether its rows pick, select, and drag; these say
 * what the view itself does.
 */
export type Controls =
  | 'none'
  | 'inspect'
  | {
      /** Dragging the background moves the camera. */
      pan?: boolean;
      /**
       * What zooms: the wheel and pinching, or the wheel only with Control or Meta held (as a trackpad's
       * pinch sends it), leaving the plain wheel to scroll the page; or nothing.
       */
      zoom?: Zoom;
      /** Dragging with the secondary button, or with Shift, turns and tilts a map or plane. */
      turn?: boolean;
      /**
       * Tab steps through the rows nearest the view's middle and arrows to the nearest row their way;
       * Enter opens the row stepped to and Space selects it. Otherwise arrows pan, `+` and `-` zoom,
       * Home fits, and Escape clears the selection.
       */
      keyboard?: boolean;
      /** The row the user points at glows. It is hovered either way: events tell it. */
      hover?: boolean;
      /** CSS pixels around the pointer that picks reach; touch reaches 8 more. */
      pickRadius?: number;
      /**
       * Dragging with Shift selects the rows in a box, instead of turning; a Shift click still toggles
       * its row.
       */
      selectBox?: boolean;
      /**
       * Dragging from a port, from a vertex with Alt, or an edge off its end draws a connection, told as
       * `Event::Connect`.
       */
      connect?: boolean;
      /** Delete and Backspace tell `Event::Delete` with the selection. */
      delete?: boolean;
      /**
       * Clicking again where nothing moved selects the next row under the point, nearest first, so rows
       * drawn over one another can each be selected.
       */
      cycle?: boolean;
      /**
       * Seconds a touch or a pen held still asks for a menu, as the secondary button does; zero never
       * does.
       */
      press?: number;
      /**
       * How much the view moves on its own: eases, flights, coasting, orbits, label fades, comets, and
       * what reads `elapsed()`.
       */
      motion?: Motion;
    };

/** Your own colormap: its kind, its colors, and for a categorical map its categories' names. */
export interface CustomColormap {
  kind: ColormapKind;
  /**
   * Colors blended in OKLab, each at its `[place, color]` from 0 to 1 or evenly between its
   * neighbors, as in a CSS gradient; a categorical map's, one per category.
   */
  colors: (Color | [number, Color])[];
  /** The categories' names, in order, for a legend: a categorical map's alone. */
  categories?: string[];
}

/**
 * A sheet for diagrams, flat and seen from straight above: the camera pans and zooms. Positions
 * are units with y down, and every length is a unit, a CSS pixel at zoom 0 (sizes, padding, ports,
 * strokes, text, and the theme's), except glow, halo, and pick radius. Zooming scales one fixed
 * picture. Only a diagram has ports, groups, nets, and orthogonal routes; it lays out blocks.
 */
export interface Diagram {
  /** The grid under the marks. */
  grid?: Grid;
}

/** A direction on screen. */
export type Direction = 'right' | 'left' | 'down' | 'up';

/** The earth: positions are longitude and latitude in degrees. */
export interface Earth {
  /** A flat map or a globe. */
  projection?: Projection;
  /** The ground's color; the theme's surface unless set. */
  surface?: Color | null;
  /** Whether lines of longitude and latitude cross the ground, in the theme's grid color. */
  graticule?: boolean;
  /**
   * Lit by the sun as it stands this many seconds after the Unix epoch, plus the view's axis
   * coordinate when it shows one: night falls on the ground and what stands on it, down to the
   * theme's night. Lit evenly unless set.
   */
  daylight?: number | null;
  /** Whether air glows around the globe, in the theme's atmosphere color, brighter where it is day. */
  atmosphere?: boolean;
}

/**
 * Rows drawn as strokes between the vertices two reference fields name: branches, links, wires. In
 * a diagram, a row without ends is a net: it joins every vertex port whose reference field names
 * it.
 */
export interface Edges {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /** The reference fields naming each row's two vertices. */
  ends?: [from: string, to: string] | null;
  /** A path field of points each row runs through between its ends. */
  bends?: string | null;
  /**
   * How each row runs between its ends; on the earth geodesic, elsewhere straight, unless set.
   * Orthogonal routes run around blocks, bends rounded; diagrams only.
   */
  route?: Route | null;
  /** Whether each row ends in an arrowhead at its second end; a net's at each input it reaches. */
  arrows?: boolean;
  /**
   * Draws each row as a pole from its own vertex down to the ground beneath it, on a plane or the
   * earth; it has no ends.
   */
  poles?: boolean;
  /**
   * Draws each row as a net on a plane or the earth: it joins the vertex rows of `table` whose
   * reference field names it, as a star from their middle to each.
   */
  joins?: [table: string, reference: string] | null;
  /** CSS pixels, or position units with `units`; units in a diagram. */
  width?: Size | null;
  /** Whether each row is dashed. */
  dash?: ExprInput;
  /**
   * Comets flowing along each row at this speed a second: CSS pixels, units in a diagram, or
   * position units where the theme's flow is in units; negative flows backward. A speed that changes
   * carries comets on from where they are.
   */
  flow?: ExprInput;
  /** Each row's color; the theme's unless set. */
  color?: ExprInput | null;
  /** Whether each row is drawn and picked. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows are hovered, clicked, and probed. Unless set, rows that are things are (vertices,
   * edges, faces, a plot's traces) and geometry is not (areas, and lines along paths: coasts,
   * borders, roads).
   */
  pick?: boolean | null;
  /** Whether a click selects a row. */
  select?: boolean;
  /** Whether pressing a row drags it instead of panning. */
  drag?: boolean;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** A value for every row of a mark: a constant, a field, view state, or arithmetic of them. */
export type ExprNode =
  | number
  | boolean
  | string
  | FieldNode
  | ColorNode
  | StateNode
  | MissingNode
  | UnaryNode
  | BinaryNode
  | WhenNode
  | IsNode
  | ContainsNode
  | ScaleNode
  | ColormapNode;

/**
 * Rows drawn as triangles between the vertices three reference fields name: meshes, surfaces, and
 * fields interpolated across a network. Faces are lit from the camera, so a flat mesh seen from
 * above shows its exact colors.
 */
export interface Faces {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * The reference fields naming each row's three vertices. Without a color, a face blends the colors
   * of its corners.
   */
  corners?: [a: string, b: string, c: string] | null;
  /** Each row's color; the theme's unless set. */
  color?: ExprInput | null;
  /** Whether each row is drawn and picked. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows are hovered, clicked, and probed. Unless set, rows that are things are (vertices,
   * edges, faces, a plot's traces) and geometry is not (areas, and lines along paths: coasts,
   * borders, roads).
   */
  pick?: boolean | null;
  /** Whether a click selects a row. */
  select?: boolean;
  /** Whether pressing a row drags it instead of panning. */
  drag?: boolean;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** A field of each row: of the mark's own table, or of another dataset's table joined by row id. */
export interface FieldNode {
  field: string;
  /** The dataset and table the field is read from, joined by row id. */
  of?: [data: string, table: string] | null;
  /** Reads a sampled field at its last frame without interpolating. */
  step?: boolean;
}

/** What a view's fit frames. */
export type Fit =
  | 'all'
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
        /** The least corner. */
        min: [number, number, number];
        /** The greatest corner. */
        max: [number, number, number];
      };
    };

/**
 * How comets flowing along edges and lines look: each a round head, brightest at its middle,
 * trailing a tail that thins and fades.
 */
export interface Flow {
  /** A comet's color; its alpha is how strongly a comet covers its stroke. */
  color?: Color;
  /** Distance between comets. */
  spacing?: number;
  /** How far a comet's tail trails its head. */
  length?: number;
  /** How wide a comet's head is, CSS pixels, or units in a diagram; never narrower than its stroke. */
  width?: number;
  /**
   * Whether comets are part of the drawing: their spacing, length, and each row's flow in position
   * units, degrees on the earth, so they zoom with the view and stay where they are on their lines.
   * Otherwise they keep their size and speed on screen, and slide along their lines as it zooms.
   */
  units?: boolean;
}

/** How an axis writes its tick values. */
export type Format = 'auto' | 'fixed' | 'scientific' | 'engineering';

/** A plane's or a diagram's grid: `"off"`, `{ lines: { pitch } }`, or `{ dots: { pitch, snap } }`. */
export type Grid =
  | 'off'
  | {
      /** Lines `pitch` units apart, thinned by tens as the view zooms out. */
      lines: {
        /** Units between lines. */
        pitch: number;
      };
    }
  | {
      /** Dots `pitch` units apart; drags snap to them when `snap`. */
      dots: {
        /** Units between dots. */
        pitch: number;
        /** Whether moved vertices snap to the dots. */
        snap?: boolean;
      };
    };

/**
 * A row's id: a whole number from 0, or a text. A number above 2^53 - 1 is written as its decimal
 * text, which names the same row.
 */
export type Id = number | string;

/** Row ids: numbers or texts (null leaves a reference unwired), or `{count}` naming rows 0..count. */
export type Ids = (Id | null)[] | { count: number };

/** How a line runs between its samples. */
export type Interpolation = 'linear' | 'stepBefore' | 'stepAfter';

/** Whether a text field equals the text. */
export interface IsNode {
  is: [field: ExprInput, text: string];
}

export type Label =
  | ExprInput
  | {
      /** A text field. */
      text: ExprInput;
      /** CSS pixels, or units in a diagram; the theme's font size unless set. */
      size?: number | null;
      /** Each row's text color; the theme's text color unless set. */
      color?: ExprInput | null;
      /** Where labels would overlap, the higher shows; the mark's priority unless set. */
      priority?: ExprInput | null;
      /** How far a line runs before it wraps: CSS pixels, or units in a diagram. */
      maxWidth?: number | null;
      /** The CSS font family list its texts are set in; the theme's font unless set. */
      font?: string | null;
      /**
       * The most labels shown at once, those of highest priority among the rows in view; where they
       * would overlap, fewer.
       */
      max?: number | null;
    };

/** Layered drawing: vertices in ranks, edges pointing along `flow`, and nets from their outputs. */
export interface Layered {
  /** Where edges point. */
  flow?: Direction;
  /** Units between vertices of a rank. */
  gap?: number;
  /** Units between ranks. */
  rankGap?: number;
}

/**
 * How the view places vertex rows without positions: a diagram's blocks, sized, or the points of a
 * plane or the earth, among the rows linked to them, gaps in the space's units: a name, or
 * `{ stress | layered: options }`. A place, once given, holds: rows added later are placed around
 * the rest, and `View::arrange` lays every row out again.
 */
export type Layout =
  | 'none'
  | 'stress'
  | 'layered'
  | {
      /** Distances on the drawing follow distances in the graph. */
      stress: Stress;
    }
  | {
      /** Ranks along a direction, for flows and hierarchies. */
      layered: Layered;
    };

/**
 * Rows drawn as lines: along a path field (roads, rivers, borders) or a polygon field's rings,
 * outlining its areas; on a plot, through a sampled field's history across the data's axis, what a
 * monitor shows. On the earth paths bend with the globe and stay whole across the antimeridian.
 */
export interface Lines {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /** The path or polygon field each row runs along; `geometry` unless set. Not on a plot. */
  geometry?: string | null;
  /**
   * The sampled field each row traces across the data's axis, on a plot alone. A field not recorded
   * yet draws nothing until its first frame.
   */
  trace?: string | null;
  /** How each row runs between its samples, on a plot. */
  interpolation?: Interpolation;
  /** CSS pixels, or position units with `units`; units in a diagram. */
  width?: Size | null;
  /** Whether each row is dashed. */
  dash?: ExprInput;
  /**
   * Comets flowing along each row at this speed a second: CSS pixels, units in a diagram, or
   * position units where the theme's flow is in units; negative flows backward. A speed that changes
   * carries comets on from where they are.
   */
  flow?: ExprInput;
  /** Each row's color; the theme's unless set. */
  color?: ExprInput | null;
  /** Whether each row is drawn and picked. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows are hovered, clicked, and probed. Unless set, rows that are things are (vertices,
   * edges, faces, a plot's traces) and geometry is not (areas, and lines along paths: coasts,
   * borders, roads).
   */
  pick?: boolean | null;
  /** Whether a click selects a row. */
  select?: boolean;
  /** Whether pressing a row drags it instead of panning. */
  drag?: boolean;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** One drawn table of a scene: `{ vertices | edges | faces | lines | areas: options }` as JSON. */
export type Mark =
  | {
      /** Rows drawn as markers. */
      vertices: Vertices;
    }
  | {
      /** Rows drawn as strokes between two vertices. */
      edges: Edges;
    }
  | {
      /** Rows drawn as triangles between three vertices. */
      faces: Faces;
    }
  | {
      /** Rows drawn as lines along their paths, or on a plot through their samples. */
      lines: Lines;
    }
  | {
      /** Rows drawn as the areas their polygons cover. */
      areas: Areas;
    };

/**
 * How a vertex is drawn: a shape's name, `"block"`, or
 * `{ shape | block | gauge | pie | icon | wgsl: options }`.
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
      /** A block: a rectangle with rounded corners of `corner` CSS pixels, sized for diagrams. */
      block: {
        /** Corner radius, CSS pixels; 4 unless set. */
        corner?: number;
      };
    }
  | {
      /** A shape's outline, filled to `fill` from 0 to 1: around a circle, up other shapes. */
      gauge: {
        /** How full each row's gauge is. */
        fill: ExprInput;
        /** The outline. */
        shape?: Shape;
      };
    }
  | {
      /** A circle cut into slices, each as large as its value. */
      pie: {
        /** Each slice's value. */
        slices: ExprInput[];
        /** Each slice's color. */
        colors: Color[];
        /** The hole in the middle, as a fraction of the radius. */
        hole?: number;
      };
    }
  | {
      /** One of `images`, fitted in the marker's box; `index` picks which for each row. */
      icon: {
        /** The images. */
        images: Bitmap[];
        /** Each row's image, from 0. */
        index: ExprInput;
      };
    }
  | {
      /**
       * A marker in WGSL: `source` defines `fn marker(f: MarkerFragment) -> MarkerColor`, reading up to
       * eight `inputs` as `f.input[i]`. It compiles once, when the view first draws it.
       */
      wgsl: {
        /** The function's source. */
        source: string;
        /** Each row's inputs. */
        inputs?: ExprInput[];
      };
    };

/** A missing value: options that read one take the theme's. */
export interface MissingNode {
  missing: true;
}

/** How much a view moves on its own. */
export type Motion = 'system' | 'full' | 'reduced';

/** Which way a sort runs; rows a key reads nothing for come last either way. */
export type Order = 'ascending' | 'descending';

/** A plane: positions are plane units. */
export interface Plane {
  /** The grid under the marks. */
  grid?: Grid;
}

/** A plot: x is the data's axis, y the values. */
export interface Plot {
  /** The horizontal axis. */
  x?: Axis;
  /** The vertical axis. */
  y?: Axis;
}

/**
 * A vertex's port: where a net its reference field names meets it, on one side of its marker: a
 * side, or options. An output drives its net: layouts rank a net from its outputs, and its arrows
 * point away from them.
 */
export type Port =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | {
      /** The side it sits on. */
      side: Side;
      /**
       * Its place among the ports on that side, from the top or the left; in declaration order unless
       * set.
       */
      order?: number | null;
      /** Its name, drawn beside it inside the marker. */
      label?: string | null;
      /** Its marker. */
      shape?: Shape;
      /** Whether it drives the net its reference field names; an input unless set. */
      output?: boolean;
    };

/** How the earth is drawn. */
export type Projection = 'mercator' | 'globe';

/** The rows of a table to read back, run through the expressions marks draw with. */
export interface Query {
  /** The table read. */
  of: string;
  /**
   * The rows read, in this order unless sorted; every row unless set. Ids that name no row are
   * passed over.
   */
  ids?: Ids | null;
  /** Keeps the rows it is true for. */
  filter?: ExprInput | null;
  /**
   * Keys to sort by, each after those before it; rows a key reads nothing for come last, and rows
   * all keys order alike keep their order.
   */
  sort?: [ExprInput, Order][];
  /** The kept rows skipped first. */
  offset?: number;
  /** The most rows read; a limit picks them in linear time before sorting only those. */
  limit?: number | null;
  /** Fields to read by name: a field as it is, anything else as numbers. Every field unless set. */
  select?: { [name: string]: ExprInput };
  /** The axis coordinate sampled fields are read at; their last frame unless set. */
  at?: number | null;
}

/** How an edge runs between its ends. */
export type Route = 'straight' | 'geodesic' | 'orthogonal';

/** A row of a table in a dataset. It survives any change that keeps the names and the id. */
export interface Row {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The row's id in the table. */
  id: Id;
}

/** Rows of one table in a dataset, by id: what a view selects, fits, and tells as sets of rows. */
export interface Rows {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The rows' ids in the table. */
  ids: Id[];
}

/**
 * `value` mapped linearly onto the range `scale`, clamped: from its `domain`, else from the extent
 * of the values shown.
 */
export interface ScaleNode {
  scale: [low: number, high: number];
  value: ExprInput;
  domain?: [low: number, high: number] | null;
}

/**
 * What a view draws and how it answers input: a space, marks in drawing order, a layout, a theme,
 * controls, how long changes ease, and the title written over it. Plain data: as JSON, each field
 * by its name in camelCase, each mark `{ vertices | edges | faces | lines | areas: options }`.
 */
export interface Scene {
  space: Space;
  /** What the view draws, in drawing order. */
  marks?: Mark[];
  /**
   * How the view places vertex rows without positions: a diagram's blocks, or points on a plane or
   * the earth, gaps in the space's units.
   */
  layout?: Layout;
  theme?: Theme;
  controls?: Controls;
  /** Seconds that changes ease over; 0.3 unless set. */
  ease?: number;
  /** Written at the view's top left, larger than the theme's text. */
  title?: string | null;
  /** Written under the title. */
  subtitle?: string | null;
}

/** How marks that cast shadows cast them onto the ground and onto faces. */
export interface Shadow {
  /** What a shadow darkens toward; its alpha is how dark a shadow at contact gets. */
  color?: Color;
  /** The direction toward the light, fixed in the world: shadows fall away from it. */
  light?: [number, number, number];
  /** How much a shadow spreads per unit of a caster's height: the light's size. */
  softness?: number;
  /** CSS pixels flat marks cast from, as if raised. */
  lift?: number;
}

/** A marker's outline. */
export type Shape = 'ellipse' | 'rectangle' | 'rounded' | 'diamond';

/** A side of a marker. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/** A size: CSS pixels, or position units with `units`. */
export type Size = ExprInput | Units;

/**
 * The coordinate space a scene's positions are in: a name, or
 * `{ plane | diagram | earth | plot: options }`. A diagram is a flat sheet seen from straight
 * above: y runs down, and every length is a unit, a CSS pixel at zoom 0, except glow, halo, and
 * pick radius. Only a diagram has ports, groups, nets, orthogonal routes, and layouts.
 */
export type Space =
  | 'plane'
  | 'diagram'
  | 'mercator'
  | 'globe'
  | 'plot'
  | {
      /** Longitude and latitude in degrees, on a map or a globe. */
      earth: Earth;
    }
  | {
      /** Plane units with elevation: graphs and scenes the camera turns and tilts around. */
      plane: Plane;
    }
  | {
      /** The data's axis across, values up. */
      plot: Plot;
    }
  | {
      /** A sheet for diagrams: x right and y down in units, every length a unit. */
      diagram: Diagram;
    };

/** What the view knows as it draws: the time. */
export type State = 'elapsed';

/** What the view knows as it draws. */
export interface StateNode {
  state: State;
}

/**
 * Stress majorization: each pair of vertices pulls toward its graph distance; then their boxes
 * part, keeping a quarter of the gap clear.
 */
export interface Stress {
  /** Units between adjacent vertices' centers. */
  gap?: number;
}

/**
 * Colors and sizes marks take where their options read nothing, and the look of focus and motion:
 * a base theme's name, or options over one (`base`, dark unless set). Lengths are CSS pixels; in a
 * diagram they are units, except `glow` and `halo`.
 */
export type Theme =
  | 'dark'
  | 'light'
  | {
      /** Behind everything. */
      background?: Color;
      /** The earth's ground, and a group's container. */
      surface?: Color;
      /** A plane's or a diagram's grid. */
      grid?: Color;
      /** Vertex color. */
      vertex?: Color;
      /** Vertex radius. */
      vertexRadius?: number;
      /**
       * Edge color; `null` blends the colors of each edge's two vertices, and in a diagram takes the
       * text color.
       */
      edge?: Color | null;
      /** Edge width. */
      edgeWidth?: number;
      /** Line color. */
      line?: Color;
      /** Line width. */
      lineWidth?: number;
      /** Area color. */
      area?: Color;
      /** How much a face turned away from the camera darkens, 0 to 1. */
      shading?: number;
      /** Text: labels, axis ticks, and titles. */
      text?: Color;
      /** The CSS font family text is set in. */
      font?: string;
      /** Text size. */
      fontSize?: number;
      /** The line a plot draws at the shown coordinate. */
      playhead?: Color;
      /** What a missing color reads as. */
      missing?: Color;
      /** The glow around hovered rows. */
      hover?: Color;
      /** The glow around selected rows; `null` glows in each row's own color. */
      selected?: Color | null;
      /** How far focus glows reach, CSS pixels. */
      glow?: number;
      /** The opacity of rows outside a selection. */
      dim?: number;
      /** How much a hovered vertex sized in CSS pixels grows. */
      hoverScale?: number;
      /** Length of a dash. */
      dash?: number;
      /** How comets flowing along edges and lines look. */
      flow?: Flow;
      /**
       * In a diagram, distance between the lanes of edges joining the same two vertices, and between
       * parallel orthogonal wires, which keep twice it apart.
       */
      edgeSpacing?: number;
      /**
       * Elsewhere, how far edges joining the same two vertices bow apart: each lane by this fraction of
       * the edge's length at its middle. A bow is part of the drawing, so zooming never moves it.
       */
      laneBow?: number;
      /** How far an arrowhead reaches past its edge's width. */
      arrow?: number;
      /** CSS pixels of background around label text. */
      halo?: number;
      /** Distance between a group's members and its outline. */
      groupPadding?: number;
      /** How marks that cast shadows cast them. */
      shadow?: Shadow;
      /** The air glowing around the globe, where the earth has an atmosphere. */
      atmosphere?: Color;
      /** How bright the earth's night side stays where it is lit by daylight, 0 to 1. */
      night?: number;
      /** The theme these options change; dark unless set. */
      base?: 'dark' | 'light';
    };

/** A tick as written: a value, or `[value, label]`. */
export type Tick = number | [number, string | null];

/** An operation of one value. */
export type Unary = 'neg' | 'not' | 'abs' | 'sqrt' | 'sin' | 'cos' | 'floor' | 'ln' | 'exp';

export interface UnaryNode {
  op: Unary;
  args: [ExprInput];
}

/** A size in position units, so it scales as the view zooms, kept within CSS pixels when given. */
export interface Units {
  units: ExprInput;
  /** CSS pixels it keeps at least, however far the view zooms out. */
  atLeast?: number | null;
  /** CSS pixels it keeps at most, however far the view zooms in. */
  atMost?: number | null;
}

/** Rows drawn as markers: points of a map, nodes of a graph, blocks of a diagram. */
export interface Vertices {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * Each row's x and y. Without them, the point field `geometry` names places rows; rows without
   * either the scene's layout places.
   */
  position?: [ExprInput, ExprInput] | null;
  /** The point field placing each row where `position` is not given; `geometry` unless set. */
  geometry?: string | null;
  /**
   * Height above the ground: on the earth, a fraction of its radius. Not in a diagram, which is
   * flat.
   */
  elevation?: ExprInput;
  /** CSS pixels, or position units with `units`; units in a diagram. */
  radius?: Size | null;
  /**
   * Width and height, for markers that are not round: CSS pixels, or position units with `units`;
   * units in a diagram, where a block without a size fits its label and ports.
   */
  size?: [Size, Size] | null;
  /** How each row is drawn. */
  marker?: Marker;
  /** A ring around each row's marker in this color; a missing or transparent color draws none. */
  ring?: ExprInput | null;
  /**
   * A port on each row for each reference field naming a net, which an `edges` mark of the net table
   * without ends draws. Diagrams only.
   */
  ports?: [reference: string, port: Port][];
  /**
   * Makes each row a group: it holds the rows of `table` whose reference field names it, and is
   * drawn as a container around them, its label a title in its header. Diagrams only.
   */
  contains?: [table: string, reference: string] | null;
  /** Each row's color; the theme's unless set. */
  color?: ExprInput | null;
  /** Whether each row is drawn and picked. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows are hovered, clicked, and probed. Unless set, rows that are things are (vertices,
   * edges, faces, a plot's traces) and geometry is not (areas, and lines along paths: coasts,
   * borders, roads).
   */
  pick?: boolean | null;
  /** Whether a click selects a row. */
  select?: boolean;
  /** Whether pressing a row drags it instead of panning. */
  drag?: boolean;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** The value of the first case whose condition holds, else `otherwise`. */
export interface WhenNode {
  when: [condition: ExprInput, value: ExprInput][];
  otherwise: ExprInput;
}

/** What zooms a view. */
export type Zoom = 'wheel' | 'modifier' | 'off';
