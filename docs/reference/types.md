# Scene and result types

Generated from the same schema as the package types. Each field documents its meaning and defaults.

## Areas

```ts
/**
 * Rows drawn as the areas a polygon field holds: parcels, states, lakes, the land and water of a
 * map. The view cuts each row's polygons into triangles once, off the frame when they are large;
 * on the earth they bend with the globe and stay whole across the antimeridian. Outline areas with
 * a `Lines` mark of the same table, which draws their rings.
 */
interface Areas {
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
```

## Axis

```ts
/** A plot axis. */
interface Axis {
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
```

## Binary

```ts
/** An operation of two values. */
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
```

## BinaryNode

```ts
interface BinaryNode {
  op: Binary;
  args: [ExprInput, ExprInput];
}
```

## Bitmap

```ts
/** RGBA texels, straight alpha, sRGB, rows top to bottom. */
interface Bitmap {
  /** Width and height in texels. */
  size: [number, number];
  /** `size[0] * size[1] * 4` bytes. */
  rgba: number[];
}
```

## Budget

```ts
/** How much GPU memory latkit uses. */
interface Budget {
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
```

## Camera

```ts
/** Where a view looks. */
type Camera =
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
```

## ColorNode

```ts
interface ColorNode {
  /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
  color: Color;
}
```

## Colormap

```ts
/** Colors for a range of values: a catalog name, or your own colors. */
type Colormap = ColormapName | CustomColormap;
```

## ColormapKind

```ts
/** How a colormap spans values. */
type ColormapKind = 'sequential' | 'diverging' | 'cyclic' | 'categorical';
```

## ColormapName

```ts
/** A colormap of the catalog. */
type ColormapName =
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
```

## ColormapNode

```ts
/** `value` through `colormap`: from its `domain`, else from the extent of the values shown. */
interface ColormapNode {
  colormap: Colormap;
  value: ExprInput;
  domain?: [low: number, high: number] | null;
}
```

## ContainsNode

```ts
/** Whether a text field holds the text, ignoring case: read by queries, which hold texts. */
interface ContainsNode {
  contains: [field: ExprInput, text: string];
}
```

## Controls

```ts
/**
 * How a view answers the pointer and keyboard, and how much it moves on its own: a preset, or
 * options over the defaults. Each mark says whether its rows pick, select, and drag; these say
 * what the view itself does.
 */
type Controls =
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
```

## CustomColormap

```ts
/** Your own colormap: its kind, its colors, and for a categorical map its categories' names. */
interface CustomColormap {
  kind: ColormapKind;
  /**
   * Colors blended in OKLab, each at its `[place, color]` from 0 to 1 or evenly between its
   * neighbors, as in a CSS gradient; a categorical map's, one per category.
   */
  colors: (Color | [number, Color])[];
  /** The categories' names, in order, for a legend: a categorical map's alone. */
  categories?: string[];
}
```

## Diagram

```ts
/**
 * A sheet for diagrams, flat and seen from straight above: the camera pans and zooms. Positions
 * are units with y down, and every length is a unit, a CSS pixel at zoom 0 (sizes, padding, ports,
 * strokes, text, and the theme's), except glow, halo, and pick radius. Zooming scales one fixed
 * picture. Only a diagram has ports, groups, nets, and orthogonal routes; it lays out blocks.
 */
interface Diagram {
  /** The grid under the marks. */
  grid?: Grid;
}
```

## Direction

```ts
/** A direction on screen. */
type Direction = 'right' | 'left' | 'down' | 'up';
```

## Earth

```ts
/** The earth: positions are longitude and latitude in degrees. */
interface Earth {
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
```

## Edges

```ts
/**
 * Rows drawn as strokes between the vertices two reference fields name: branches, links, wires. In
 * a diagram, a row without ends is a net: it joins every vertex port whose reference field names
 * it.
 */
interface Edges {
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
```

## ExprNode

```ts
/** A value for every row of a mark: a constant, a field, view state, or arithmetic of them. */
type ExprNode =
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
```

## Faces

```ts
/**
 * Rows drawn as triangles between the vertices three reference fields name: meshes, surfaces, and
 * fields interpolated across a network. Faces are lit from the camera, so a flat mesh seen from
 * above shows its exact colors.
 */
interface Faces {
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
```

## FieldNode

```ts
/** A field of each row: of the mark's own table, or of another dataset's table joined by row id. */
interface FieldNode {
  field: string;
  /** The dataset and table the field is read from, joined by row id. */
  of?: [data: string, table: string] | null;
  /** Reads a sampled field at its last frame without interpolating. */
  step?: boolean;
}
```

## Fit

```ts
/** What a view's fit frames. */
type Fit =
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
```

## Flow

```ts
/**
 * How comets flowing along edges and lines look: each a round head, brightest at its middle,
 * trailing a tail that thins and fades.
 */
interface Flow {
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
```

## Format

```ts
/** How an axis writes its tick values. */
type Format = 'auto' | 'fixed' | 'scientific' | 'engineering';
```

## Grid

```ts
/** A plane's or a diagram's grid: `"off"`, `{ lines: { pitch } }`, or `{ dots: { pitch, snap } }`. */
type Grid =
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
```

## Id

```ts
/**
 * A row's id: a whole number from 0, or a text. A number above 2^53 - 1 is written as its decimal
 * text, which names the same row.
 */
type Id = number | string;
```

## Ids

```ts
/** Row ids: numbers or texts (null leaves a reference unwired), or `{count}` naming rows 0..count. */
type Ids =
  | (Id | null)[]
  | {
      count: number;
    };
```

## Interpolation

```ts
/** How a line runs between its samples. */
type Interpolation = 'linear' | 'stepBefore' | 'stepAfter';
```

## IsNode

```ts
/** Whether a text field equals the text. */
interface IsNode {
  is: [field: ExprInput, text: string];
}
```

## Label

```ts
type Label =
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
```

## Layered

```ts
/** Layered drawing: vertices in ranks, edges pointing along `flow`, and nets from their outputs. */
interface Layered {
  /** Where edges point. */
  flow?: Direction;
  /** Units between vertices of a rank. */
  gap?: number;
  /** Units between ranks. */
  rankGap?: number;
}
```

## Layout

```ts
/**
 * How the view places vertex rows without positions: a diagram's blocks, sized, or the points of a
 * plane or the earth, among the rows linked to them, gaps in the space's units: a name, or
 * `{ stress | layered: options }`. A place, once given, holds: rows added later are placed around
 * the rest, and `View::arrange` lays every row out again.
 */
type Layout =
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
```

## Lines

```ts
/**
 * Rows drawn as lines: along a path field (roads, rivers, borders) or a polygon field's rings,
 * outlining its areas; on a plot, through a sampled field's history across the data's axis, what a
 * monitor shows. On the earth paths bend with the globe and stay whole across the antimeridian.
 */
interface Lines {
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
```

## Mark

```ts
/** One drawn table of a scene: `{ vertices | edges | faces | lines | areas: options }` as JSON. */
type Mark =
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
```

## Marker

```ts
/**
 * How a vertex is drawn: a shape's name, `"block"`, or
 * `{ shape | block | gauge | pie | icon | wgsl: options }`.
 */
type Marker =
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
```

## MissingNode

```ts
/** A missing value: options that read one take the theme's. */
interface MissingNode {
  missing: true;
}
```

## Motion

```ts
/** How much a view moves on its own. */
type Motion = 'system' | 'full' | 'reduced';
```

## Order

```ts
/** Which way a sort runs; rows a key reads nothing for come last either way. */
type Order = 'ascending' | 'descending';
```

## Plane

```ts
/** A plane: positions are plane units. */
interface Plane {
  /** The grid under the marks. */
  grid?: Grid;
}
```

## Plot

```ts
/** A plot: x is the data's axis, y the values. */
interface Plot {
  /** The horizontal axis. */
  x?: Axis;
  /** The vertical axis. */
  y?: Axis;
}
```

## Port

```ts
/**
 * A vertex's port: where a net its reference field names meets it, on one side of its marker: a
 * side, or options. An output drives its net: layouts rank a net from its outputs, and its arrows
 * point away from them.
 */
type Port =
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
```

## Projection

```ts
/** How the earth is drawn. */
type Projection = 'mercator' | 'globe';
```

## Query

```ts
/** The rows of a table to read back, run through the expressions marks draw with. */
interface Query {
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
  select?: {
    [name: string]: ExprInput;
  };
  /** The axis coordinate sampled fields are read at; their last frame unless set. */
  at?: number | null;
}
```

## Route

```ts
/** How an edge runs between its ends. */
type Route = 'straight' | 'geodesic' | 'orthogonal';
```

## Row

```ts
/** A row of a table in a dataset. It survives any change that keeps the names and the id. */
interface Row {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The row's id in the table. */
  id: Id;
}
```

## Rows

```ts
/** Rows of one table in a dataset, by id: what a view selects, fits, and tells as sets of rows. */
interface Rows {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The rows' ids in the table. */
  ids: Id[];
}
```

## ScaleNode

```ts
/**
 * `value` mapped linearly onto the range `scale`, clamped: from its `domain`, else from the extent
 * of the values shown.
 */
interface ScaleNode {
  scale: [low: number, high: number];
  value: ExprInput;
  domain?: [low: number, high: number] | null;
}
```

## Scene

```ts
/**
 * What a view draws and how it answers input: a space, marks in drawing order, a layout, a theme,
 * controls, how long changes ease, and the title written over it. Plain data: as JSON, each field
 * by its name in camelCase, each mark `{ vertices | edges | faces | lines | areas: options }`.
 */
interface Scene {
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
```

## Shadow

```ts
/** How marks that cast shadows cast them onto the ground and onto faces. */
interface Shadow {
  /** What a shadow darkens toward; its alpha is how dark a shadow at contact gets. */
  color?: Color;
  /** The direction toward the light, fixed in the world: shadows fall away from it. */
  light?: [number, number, number];
  /** How much a shadow spreads per unit of a caster's height: the light's size. */
  softness?: number;
  /** CSS pixels flat marks cast from, as if raised. */
  lift?: number;
}
```

## Shape

```ts
/** A marker's outline. */
type Shape = 'ellipse' | 'rectangle' | 'rounded' | 'diamond';
```

## Side

```ts
/** A side of a marker. */
type Side = 'left' | 'right' | 'top' | 'bottom';
```

## Size

```ts
/** A size: CSS pixels, or position units with `units`. */
type Size = ExprInput | Units;
```

## Space

```ts
/**
 * The coordinate space a scene's positions are in: a name, or
 * `{ plane | diagram | earth | plot: options }`. A diagram is a flat sheet seen from straight
 * above: y runs down, and every length is a unit, a CSS pixel at zoom 0, except glow, halo, and
 * pick radius. Only a diagram has ports, groups, nets, orthogonal routes, and layouts.
 */
type Space =
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
```

## State

```ts
/** What the view knows as it draws: the time. */
type State = 'elapsed';
```

## StateNode

```ts
/** What the view knows as it draws. */
interface StateNode {
  state: State;
}
```

## Stress

```ts
/**
 * Stress majorization: each pair of vertices pulls toward its graph distance; then their boxes
 * part, keeping a quarter of the gap clear.
 */
interface Stress {
  /** Units between adjacent vertices' centers. */
  gap?: number;
}
```

## Theme

```ts
/**
 * Colors and sizes marks take where their options read nothing, and the look of focus and motion:
 * a base theme's name, or options over one (`base`, dark unless set). Lengths are CSS pixels; in a
 * diagram they are units, except `glow` and `halo`.
 */
type Theme =
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
```

## Tick

```ts
/** A tick as written: a value, or `[value, label]`. */
type Tick = number | [number, string | null];
```

## Unary

```ts
/** An operation of one value. */
type Unary = 'neg' | 'not' | 'abs' | 'sqrt' | 'sin' | 'cos' | 'floor' | 'ln' | 'exp';
```

## UnaryNode

```ts
interface UnaryNode {
  op: Unary;
  args: [ExprInput];
}
```

## Units

```ts
/** A size in position units, so it scales as the view zooms, kept within CSS pixels when given. */
interface Units {
  units: ExprInput;
  /** CSS pixels it keeps at least, however far the view zooms out. */
  atLeast?: number | null;
  /** CSS pixels it keeps at most, however far the view zooms in. */
  atMost?: number | null;
}
```

## Vertices

```ts
/** Rows drawn as markers: points of a map, nodes of a graph, blocks of a diagram. */
interface Vertices {
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
```

## WhenNode

```ts
/** The value of the first case whose condition holds, else `otherwise`. */
interface WhenNode {
  when: [condition: ExprInput, value: ExprInput][];
  otherwise: ExprInput;
}
```

## Zoom

```ts
/** What zooms a view. */
type Zoom = 'wheel' | 'modifier' | 'off';
```

## Description

```ts
/**
 * What a dataset holds: its tables, their rows and fields, and the axis its sampled fields are
 * recorded over and span.
 */
interface Description {
  /** The dataset's name. */
  name: string;
  /** The axis's name and unit. */
  axis: [string, string] | null;
  /** The first and last coordinates its sampled fields hold. */
  span: [number, number] | null;
  /** Its tables, by name. */
  tables: TableDescription[];
}
```

## Device

```ts
/** What the user acts with. */
type Device = 'mouse' | 'pen' | 'touch' | 'keyboard';
```

## End

```ts
/** A vertex a connection ends at, and its port when it has the one the connection meets. */
interface End {
  /** The vertex. */
  row: Row;
  /** The port, by the reference field naming its net. */
  port?: string;
}
```

## Failure

```ts
/**
 * What failed: its `code`, the message, and for invalid input the `path` to the part, such as
 * `marks[2].vertices.color`.
 */
interface Failure {
  code: 'invalid' | 'unsupported' | 'limit' | 'io' | 'device-lost' | 'cancelled' | 'timeout';
  message: string;
  path?: string;
}
```

## FieldDescription

```ts
/** A field described: what it holds, the table a reference names, the coordinates samples span. */
interface FieldDescription {
  /** The field's name. */
  name: string;
  /** What it holds. */
  kind: Kind;
  /** The table a reference names. */
  to?: string;
  /** The first and last coordinates a sampled field holds. */
  span?: [number, number];
}
```

## Hit

```ts
/** A row under a point, as the frame drew it. */
interface Hit {
  /** The row. */
  row: Row;
  /** The name of the mark that drew it, when it has one: what tells two marks of one table apart. */
  mark?: string;
  /**
   * The point of the row nearest the probe, CSS pixels from the top left: a vertex's or a port's
   * middle, the nearest point of a stroke or a triangle.
   */
  point: [number, number];
  /** That point in the space's coordinates: x, y, and elevation. */
  position: [number, number, number];
  /** CSS pixels from the probe to the row. */
  distance: number;
  /** The port hit, when a vertex's port was. */
  port?: string;
  /** The sample hit, when a line tracing a sampled field was. */
  sample?: Sample;
}
```

## Kind

```ts
/** What a field holds. */
type Kind =
  'number' | 'bool' | 'text' | 'point' | 'path' | 'parts' | 'polygons' | 'reference' | 'sampled';
```

## Modifiers

```ts
/** Keys held during an input. */
interface Modifiers {
  /** Shift. */
  shift: boolean;
  /** Control. */
  control: boolean;
  /** Alt or Option. */
  alt: boolean;
  /** Meta: Command or Windows. */
  meta: boolean;
}
```

## Phase

```ts
/** The phase of a `Drag`. */
type Phase = 'start' | 'move' | 'end';
```

## Sample

```ts
/** A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value. */
interface Sample {
  /** The frame, numbered from the first ever recorded. JSON uses a decimal string above 2^53 - 1. */
  frame: Id;
  /** The axis coordinate. */
  at: number;
  /** The value. */
  value: number;
}
```

## Stats

```ts
/** What a view does each frame. */
interface Stats {
  /** Frames rendered. */
  frames: number;
  /** Rows of every mark's table. */
  rows: number;
  /**
   * Rows every mark draws: every row of a table drawn whole, the rows of the tiles in view of one
   * drawn through tiles.
   */
  drawn: number;
  /** Draw calls the last frame recorded, shadows and labels with the marks. */
  draws: number;
  /**
   * Instances the last frame's draws drew: points, segments, triangles, glyphs; at most, for
   * segments the GPU culls.
   */
  instances: number;
  /** Fetched tiles the view draws, of every tile source. */
  tiles: number;
  /** Tiles being fetched or decoded, of every tile source. */
  tilesLoading: number;
  /** Bytes of data waiting to upload. */
  uploading: number;
  /** Bytes of data pages on the GPU, for every view of its `Gpu`. */
  resident: number;
  /** Bytes the GPU's `Budget` lets data take. */
  budget: number;
  /**
   * The work under way the last frame stood in for; nothing when it drew everything as the data,
   * scene, and camera say: see `View::complete`.
   */
  waiting: Waiting;
  /** Milliseconds the last frame took to record on the CPU. */
  cpuMs: number;
  /**
   * Milliseconds the GPU takes on a frame: the median of the last frames it measured; 0 where the
   * device cannot measure.
   */
  gpuMs: number;
}
```

## TableDescription

```ts
/** A table described: its rows, and its fields by name. */
interface TableDescription {
  /** The table's name. */
  name: string;
  /** How many rows it has. */
  rows: number;
  /** Its fields, by name. */
  fields: FieldDescription[];
}
```

## Trigger

```ts
/**
 * Where, with what keys, and with what the user acted. For keys, the point is the row they point
 * at, else the pointer, else the view's middle.
 */
interface Trigger {
  /** CSS pixels from the top left. */
  point: [number, number];
  /** The keys held. */
  modifiers: Modifiers;
  /** What acted. */
  device: Device;
}
```

## Value

```ts
/**
 * A value read from a dataset: a number (`null` when not finite), boolean, or text; a geometry as
 * nested `[x, y]` points; a reference as the id of the row it names.
 */
type Value = number | boolean | string | null | [number, number] | unknown[][];
```

## ViewEvent

```ts
/** What happened in a view, for the application to act on. Drain them with `View::events`. */
type ViewEvent =
  | {
      type: 'click';
      detail: {
        /** The row. */
        hit: Hit;
        /** How the user clicked it. */
        trigger: Trigger;
      };
    }
  | {
      type: 'open';
      detail: {
        /** The row. */
        hit: Hit;
        /** How the user opened it. */
        trigger: Trigger;
      };
    }
  | {
      type: 'menu';
      detail: {
        /** What lies under the point, nearest first. */
        hits: Hit[];
        /** How the user asked. */
        trigger: Trigger;
      };
    }
  | {
      type: 'drag';
      detail: {
        /** Whether the drag starts, moves, or ends. */
        phase: Phase;
        /** The row dragged, as it was hit. */
        hit: Hit;
        /**
         * Where the row goes, in the space's coordinates: where it was hit, moved as the pointer moved
         * since the press, at the depth the drag started; a vertex keeps where it was grabbed. On a
         * diagram's dots when its grid snaps.
         */
        position: [number, number, number];
        /** The pointer. */
        trigger: Trigger;
      };
    }
  | {
      type: 'connect';
      detail: {
        /** The end it was drawn from: for an edge, the end that stayed. */
        from: End;
        /** The vertex it was released over, if any. */
        to: End | null;
        /** The edge whose other end was dragged, which `to` replaces. */
        edge: Row | null;
        /** Where it was released. */
        trigger: Trigger;
      };
    }
  | {
      type: 'delete';
      detail: {
        /** The rows selected. */
        rows: Rows[];
        /** The key. */
        trigger: Trigger;
      };
    }
  | {
      type: 'hover';
      detail: {
        /** The row now pointed at; `null` once it left every row. */
        hit: Hit | null;
        /** The pointer, or the keys. */
        trigger: Trigger;
      };
    }
  | {
      type: 'select';
      detail: {
        /** The rows selected now. */
        rows: Rows[];
        /** How the user changed it; `null` when the data dropped rows from it. */
        trigger: Trigger | null;
      };
    }
  | {
      type: 'camera';
      detail: Camera;
    }
  | {
      type: 'waiting';
      detail: Waiting;
    }
  | {
      type: 'error';
      detail: Failure;
    };
```

## Waiting

```ts
/**
 * Work under way a frame stands in for: pipelines the scene draws with compiling, until which the
 * view draws nothing new (`compiling`); pages uploading or tables not yet built from them
 * (`data`); layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); a label placement or
 * texts not yet set (`labels`); a fit due or being measured (`fit`); row regions laid out again,
 * segment counts, or a transition beginning (`marks`). Empty once a frame is complete.
 */
type Waiting = ('compiling' | 'data' | 'derived' | 'labels' | 'fit' | 'marks')[];
```

## Work

```ts
/** What a `Gpu` did since it was made; subtract two for what happened between. */
interface Work {
  /** Bytes of data pages uploaded. */
  uploaded: number;
  /** Bytes written besides pages: uniforms, programs, label runs, the selection, textures. */
  written: number;
  /** Rows whose channels the GPU evaluated. */
  evaluated: number;
  /**
   * Reads back from the GPU: probes, queries, fits, label placements, segment counts, pictures; not
   * the frame timer's, which only some devices have.
   */
  readbacks: number;
  /**
   * Jobs handed out: layouts, routes, lanes, triangulations, pyramids, tiles; to the host's workers,
   * or done at once without a host.
   */
  jobs: number;
  /** Label texts the host was asked to set. */
  texts: number;
  /**
   * Pipelines compiled: in a browser, each as a view or a shot asks for it ahead, off the GPU's
   * thread; natively, where it is first made.
   */
  pipelines: number;
  /**
   * Pipelines made without being asked for ahead, each compiled where it is first used: in a browser
   * on the GPU's thread, holding frames back. None, unless a scene uses what it did not ask for.
   */
  late: number;
}
```
