/** Written by `node npm/build.mjs schema` from `npm/schema.json`, the forms latkit reads: do not edit. */

import type { Color, ExprInput, Size } from './scene.js';

/**
 * Rows drawn as the areas a polygon field covers, cut into triangles off the frame when large; on
 * the earth they bend with the globe. Outline them with a `lines` mark of the same table.
 */
export interface Areas {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /** The polygon field each row fills: one polygon's rings, or polygons. `geometry` unless set. */
  rings?: string | null;
  color?: ExprInput | null;
  visible?: ExprInput | null;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes. */
  name?: string | null;
  /** Whether rows are hovered, clicked, and probed; on by default. */
  pick?: boolean | null;
  /** Whether a click selects a row; on by default. */
  select?: boolean | null;
  /** Whether pressing a row drags it instead of panning; off by default. */
  drag?: boolean | null;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean | null;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

export interface Axis {
  label?: string | null;
  grid?: boolean | null;
  hidden?: boolean | null;
  /** Ticks at these values, with these labels or their values written; round values unless given. */
  ticks?: (number | [number, string | null])[] | null;
  /** How tick values are written: `auto` (fixed, scientific when very large or small). */
  format?: Format | null;
  /** Decimals of fixed values, or of the significand otherwise; as many as the ticks need unless set. */
  precision?: number | null;
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

/** Colors for a range of values: a catalog name, or your own colors. */
export type Colormap =
  | ColormapName
  | {
      kind: 'sequential' | 'diverging' | 'cyclic';
      /**
       * Colors blended in OKLab, each at its `[place, color]` from 0 to 1 or evenly between its
       * neighbors, as in a CSS gradient.
       */
      colors: (Color | [number, Color])[];
    }
  | {
      kind: 'categorical';
      /** A color per category: category `i` takes color `i`. */
      colors: Color[];
      /** The categories' names, in order, for a legend. */
      categories?: string[];
    };

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

/**
 * How a view answers the pointer and keyboard, and how much it moves on its own: a preset, or
 * options over the defaults.
 */
export type Controls =
  | 'none'
  | 'inspect'
  | {
      /** Dragging the background moves the camera; on unless set. */
      pan?: boolean | null;
      /**
       * What zooms: `wheel` (and pinching and the keys, unless set), `modifier` (the wheel only with
       * Control or Meta held, as a trackpad's pinch sends it, so the plain wheel scrolls the page), or
       * `off`.
       */
      zoom?: Zoom | null;
      /**
       * Dragging with the secondary button, or with Shift, turns and tilts a map or plane; a diagram
       * never turns. On unless set.
       */
      turn?: boolean | null;
      /**
       * Tab steps through rows and arrows to the nearest row their way, Enter opens and Space selects
       * it; otherwise arrows pan, `+` and `-` zoom, Home fits, and Escape clears the selection. On
       * unless set.
       */
      keyboard?: boolean | null;
      /** Rows under the pointer glow; on unless set. */
      hover?: boolean | null;
      /** CSS pixels around the pointer that picks reach, 6 unless set; touch reaches 8 more. */
      pickRadius?: number | null;
      /**
       * Dragging the background with Shift selects the rows in a box, instead of turning. Off unless
       * set.
       */
      selectBox?: boolean | null;
      /**
       * Dragging from a port, from a vertex with Alt, or an edge off its end draws a connection, told as
       * a `connect` event. Off unless set.
       */
      connect?: boolean | null;
      /** Delete and Backspace tell a `delete` event with the selection. Off unless set. */
      delete?: boolean | null;
      /**
       * Clicking again where nothing moved selects the next row under the point, nearest first, so rows
       * drawn over one another can each be selected. Off unless set.
       */
      cycle?: boolean | null;
      /** Seconds a touch or a pen held still asks for a menu, 0.5 unless set; 0 never does. */
      press?: number | null;
      /**
       * How much the view moves on its own: `system` (as the user's system asks, unless set), `full`, or
       * `reduced` (changes apply at once, flights jump, nothing coasts or orbits, labels show without
       * fading, and comets and what reads `elapsed()` hold still).
       */
      motion?: Motion | null;
    };

/** A direction on screen. */
export type Direction = 'right' | 'left' | 'down' | 'up';

/**
 * Rows drawn as strokes between the vertices two reference fields name; without ends, each row is
 * a net joining every vertex port whose reference field names it.
 */
export interface Edges {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  ends?: [from: string, to: string] | null;
  /** CSS pixels, or position units with `units`; units in a diagram. */
  width?: Size | null;
  dash?: ExprInput | null;
  /**
   * Comets flowing along each row at this speed a second: CSS pixels, units in a diagram, or
   * position units where the theme's flow is in units; negative flows backward. A speed that changes
   * carries comets on from where they are.
   */
  flow?: ExprInput | null;
  /** A path field of points each row runs through between its ends. */
  bends?: string | null;
  /**
   * How each row runs between its ends; on the earth geodesic, elsewhere straight, unless set.
   * Orthogonal routes run around blocks, bends rounded; diagrams only.
   */
  route?: Route | null;
  /** Whether each row ends in an arrowhead at its second end; a net's at each input it reaches. */
  arrows?: boolean | null;
  /**
   * Draws each row as a pole from its own vertex down to the ground beneath it, on a plane or the
   * earth; it has no ends.
   */
  poles?: boolean | null;
  /**
   * Draws each row as a net on a plane or the earth: it joins the vertex rows of `table` whose
   * reference field names it, as a star from their middle to each.
   */
  joins?: [table: string, reference: string] | null;
  color?: ExprInput | null;
  visible?: ExprInput | null;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes. */
  name?: string | null;
  /** Whether rows are hovered, clicked, and probed; on by default. */
  pick?: boolean | null;
  /** Whether a click selects a row; on by default. */
  select?: boolean | null;
  /** Whether pressing a row drags it instead of panning; off by default. */
  drag?: boolean | null;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean | null;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** Triangles between three vertices; without a color, each blends its corners' colors. */
export interface Faces {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  corners?: [a: string, b: string, c: string] | null;
  color?: ExprInput | null;
  visible?: ExprInput | null;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes. */
  name?: string | null;
  /** Whether rows are hovered, clicked, and probed; on by default. */
  pick?: boolean | null;
  /** Whether a click selects a row; on by default. */
  select?: boolean | null;
  /** Whether pressing a row drags it instead of panning; off by default. */
  drag?: boolean | null;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean | null;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** What a view's fit frames. */
export type Fit =
  | 'all'
  | {
      /** These rows. */
      rows: Row[];
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
  color?: Color | null;
  /** Distance between comets. */
  spacing?: number | null;
  /** How far a comet's tail trails its head. */
  length?: number | null;
  /** How wide a comet's head is, CSS pixels, or units in a diagram; never narrower than its stroke. */
  width?: number | null;
  /**
   * Whether comets are part of the drawing: their spacing, length, and each row's flow in position
   * units, degrees on the earth, so they zoom with the view and stay where they are on their lines.
   * Otherwise they keep their size and speed on screen, and slide along their lines as it zooms.
   */
  units?: boolean | null;
}

/** How an axis writes its tick values. */
export type Format = 'auto' | 'fixed' | 'scientific' | 'engineering';

/**
 * A plane's or a diagram's grid: lines or dots `pitch` units apart; drags snap to dots when
 * `snap`.
 */
export type Grid = 'off' | { lines: number } | { dots: number; snap?: boolean | null };

/**
 * A row's id: a whole number from 0, or a text. A number above 2^53 - 1 is written as its decimal
 * text, which names the same row.
 */
export type Id = number | string;

/** How a line runs between its samples. */
export type Interpolation = 'linear' | 'stepBefore' | 'stepAfter';

/**
 * A row's text, placed beside, inside, or along what its mark draws; overlapping labels give way
 * by priority, and among equals those already shown keep their place. In a diagram a label scales
 * with the zoom and fades out once too small to read.
 */
export type Label =
  | ExprInput
  | {
      /** A text field. */
      text: ExprInput;
      /** CSS pixels, or units in a diagram; the theme's font size unless set. */
      size?: number | null;
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

/**
 * How the view places vertex rows without positions: a diagram's blocks, or points on a plane or
 * the earth, among the rows linked to them. Places hold once given; `arrange` lays out again.
 */
export type Layout =
  | 'none'
  | 'stress'
  | 'layered'
  | { stress: { gap?: number | null } }
  | { layered: { flow?: Direction | null; gap?: number | null; rankGap?: number | null } };

/**
 * Rows drawn as lines along the field each traces: a path or polygon field (rings outline their
 * areas), or on a plot a sampled field's history. On the earth a line's path bends with the globe.
 */
export interface Lines {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * The field each row traces: a path or polygon field, or on a plot a sampled field. `geometry`
   * unless set.
   */
  trace?: string | null;
  /** CSS pixels, or position units with `units`; units in a diagram. */
  width?: Size | null;
  dash?: ExprInput | null;
  /** Comets flowing along each row at this speed a second, as an edge's flow. */
  flow?: ExprInput | null;
  /** How each row runs between its samples, on a plot. */
  interpolation?: Interpolation | null;
  color?: ExprInput | null;
  visible?: ExprInput | null;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes. */
  name?: string | null;
  /** Whether rows are hovered, clicked, and probed; on by default. */
  pick?: boolean | null;
  /** Whether a click selects a row; on by default. */
  select?: boolean | null;
  /** Whether pressing a row drags it instead of panning; off by default. */
  drag?: boolean | null;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean | null;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** What a scene draws: rows of a table as vertices, edges, faces, lines, or areas. */
export type Mark =
  | { vertices: Vertices }
  | { edges: Edges }
  | { faces: Faces }
  | { lines: Lines }
  | { areas: Areas };

/** How a vertex is drawn: a shape, a block, or a marker of its own. */
export type Marker =
  | 'disc'
  | 'ellipse'
  | 'rectangle'
  | 'rounded'
  | 'diamond'
  | 'block'
  | {
      block: {
        /** Corner radius, CSS pixels; 4 unless set. */
        corner?: number | null;
      };
    }
  | {
      /** A shape's outline filled to `fill`, from 0 to 1. */
      gauge: { fill: ExprInput; shape?: Shape | null };
    }
  | {
      /** A circle cut into slices as large as their values. */
      pie: { slices: ExprInput[]; colors: Color[]; hole?: number | null };
    }
  | {
      /** One of `images` per row, by `index`; npm's `icon` writes it from `ImageData`. */
      icon: { images: { size: [number, number]; rgba: number[] }[]; index: ExprInput };
    }
  | {
      /** WGSL defining `fn marker(f: MarkerFragment) -> MarkerColor`, reading `inputs` as `f.input[i]`. */
      wgsl: { source: string; inputs?: ExprInput[] };
    };

/** How much a view moves on its own. */
export type Motion = 'system' | 'full' | 'reduced';

/** Which way a sort runs; rows a key reads nothing for come last either way. */
export type Order = 'ascending' | 'descending';

/**
 * A vertex's port: where a net its reference field names meets it, on one side of its marker. An
 * output drives its net: layouts rank the net from it, and its wires point away from it.
 */
export type Port =
  | Side
  | {
      side: Side;
      /**
       * Its place among the ports on that side, from the top or the left; in declaration order unless
       * set.
       */
      order?: number | null;
      /** Its name, drawn beside it inside the marker. */
      label?: string | null;
      shape?: Shape | null;
      /** Whether it drives its net; an input unless set. */
      output?: boolean | null;
    };

/** How the earth is drawn. */
export type Projection = 'mercator' | 'globe';

/** The rows of a table to read back, run through the expressions marks draw with. */
export interface Query {
  /** The table read. */
  of: string;
  /** Keeps the rows it is true for. */
  where?: ExprInput | null;
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

/** What a view draws and how it answers input. */
export interface Scene {
  space: Space;
  marks?: Mark[];
  /**
   * How the view places vertex rows without positions: a diagram's blocks, or points on a plane or
   * the earth, gaps in the space's units.
   */
  layout?: Layout | null;
  theme?: Theme | null;
  controls?: Controls | null;
  /** Seconds that changes ease over. */
  ease?: number | null;
  /** Written at the view's top left, larger than the theme's text. */
  title?: string | null;
  /** Written under the title. */
  subtitle?: string | null;
}

/** How marks that cast shadows cast them onto the ground and onto faces. */
export interface Shadow {
  /** What a shadow darkens toward; its alpha is how dark a shadow at contact gets. */
  color?: Color | null;
  /** The direction toward the light, fixed in the world: shadows fall away from it. */
  light?: [number, number, number] | null;
  /** How much a shadow spreads per unit of a caster's height. */
  softness?: number | null;
  /** CSS pixels flat marks cast from, as if raised. */
  lift?: number | null;
}

/** A marker's outline. */
export type Shape = 'ellipse' | 'rectangle' | 'rounded' | 'diamond';

/** A side of a marker. */
export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * The coordinate space positions are in. A diagram is a flat sheet seen from straight above: y
 * runs down, and every length is a unit, a CSS pixel at zoom 0, except glow, halo, and pick
 * radius. Only a diagram has ports, groups, nets, orthogonal routes, and layouts.
 */
export type Space =
  | 'plane'
  | 'diagram'
  | 'earth'
  | 'mercator'
  | 'globe'
  | 'plot'
  | { plane: { grid?: Grid | null } }
  | { diagram: { grid?: Grid | null } }
  | {
      earth: {
        projection?: Projection | null;
        /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
        surface?: Color | null;
        graticule?: boolean | null;
        /**
         * Lit by the sun as it stands this many seconds after the Unix epoch, plus the view's axis
         * coordinate: night falls on the ground and what stands on it. Unlit unless set.
         */
        daylight?: number | null;
        /** Air glowing around the globe, in the theme's atmosphere color. */
        atmosphere?: boolean | null;
      };
    }
  | { plot: { x?: Axis | null; y?: Axis | null } };

/**
 * Colors and sizes marks take unless set: a base theme's name, or options over one. Lengths are
 * CSS pixels; in a diagram, units, except `glow` and `halo`.
 */
export type Theme =
  | 'dark'
  | 'light'
  | {
      /** The theme these options change; the dark one unless set. */
      base?: 'dark' | 'light' | null;
      /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
      background?: Color | null;
      /** The earth's ground, and a group's container. */
      surface?: Color | null;
      /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
      grid?: Color | null;
      /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
      vertex?: Color | null;
      vertexRadius?: number | null;
      /** `null` draws edges without a theme color in their mark's own. */
      edge?: Color | null;
      edgeWidth?: number | null;
      /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
      line?: Color | null;
      lineWidth?: number | null;
      /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
      area?: Color | null;
      /** How much a face turned away from the camera darkens, 0 to 1. */
      shading?: number | null;
      /** Text: labels, axis ticks, and titles. */
      text?: Color | null;
      /** A CSS font family list. */
      font?: string | null;
      fontSize?: number | null;
      /** The line a plot draws at the shown coordinate. */
      playhead?: Color | null;
      /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
      missing?: Color | null;
      /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
      hover?: Color | null;
      /** `null` marks the selection by glow alone. */
      selected?: Color | null;
      glow?: number | null;
      dim?: number | null;
      hoverScale?: number | null;
      dash?: number | null;
      /** How comets flowing along edges and lines look. */
      flow?: Flow | null;
      /**
       * In a diagram, between the lanes of edges joining the same two vertices; orthogonal wires keep
       * twice it apart.
       */
      edgeSpacing?: number | null;
      /**
       * Elsewhere, how far edges joining the same two vertices bow apart: each lane by this fraction of
       * the edge's length at its middle.
       */
      laneBow?: number | null;
      /** How far an arrowhead reaches past its edge's width. */
      arrow?: number | null;
      /** CSS pixels of background around label text. */
      halo?: number | null;
      /** Between a group's members and its outline. */
      groupPadding?: number | null;
      /** How marks that cast shadows cast them. */
      shadow?: Shadow | null;
      /** The air around the globe, where the earth has an atmosphere. */
      atmosphere?: Color | null;
      /** How bright the earth's night side stays under daylight, 0 to 1. */
      night?: number | null;
    };

/** Rows drawn as markers where they stand. */
export interface Vertices {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * Without one, a point field named `geometry` places rows; rows without either the scene's layout
   * places.
   */
  position?: [ExprInput, ExprInput] | null;
  /** Height above the ground; not in a diagram, which is flat. */
  elevation?: ExprInput | null;
  /** CSS pixels, or position units with `units`; units in a diagram. */
  radius?: Size | null;
  /**
   * Width and height: CSS pixels, or position units with `units`; units in a diagram, where a block
   * without a size fits its label and ports.
   */
  size?: [Size, Size] | null;
  marker?: Marker | null;
  /** A ring around each row's marker in this color. */
  status?: ExprInput | null;
  /**
   * A port on each row for each reference field naming a net, which an `edges` mark of the net table
   * without ends draws. Diagrams only.
   */
  ports?: [reference: string, port: Port][] | null;
  /**
   * Makes each row a group: it holds the rows of `table` whose reference field names it, and is
   * drawn as a container around them, its label a title in its header. Diagrams only.
   */
  contains?: [table: string, reference: string] | null;
  color?: ExprInput | null;
  visible?: ExprInput | null;
  /**
   * Each row's priority, from its data alone: what matters more draws on top, stays drawn as a table
   * too large to draw whole thins to the tiles in view, and is labeled first.
   */
  priority?: ExprInput | null;
  /** Tells two marks of one table apart across scenes. */
  name?: string | null;
  /** Whether rows are hovered, clicked, and probed; on by default. */
  pick?: boolean | null;
  /** Whether a click selects a row; on by default. */
  select?: boolean | null;
  /** Whether pressing a row drags it instead of panning; off by default. */
  drag?: boolean | null;
  /** Each row's text: a text field, or a label's options. */
  label?: Label | null;
  /** Whether each row casts a shadow onto the ground and onto faces, away from the theme's light. */
  shadow?: boolean | null;
  /**
   * A legend of the colors at the view's bottom right, under this title: the colormap across its
   * domain, ticked; a cell for each category; or a swatch beside each name of a map's `categories`.
   * The color maps through a colormap with a domain or named categories; a conditional's `otherwise`
   * is read before its cases.
   */
  legend?: string | null;
}

/** What zooms a view. */
export type Zoom = 'wheel' | 'modifier' | 'off';
