# Scene and result types

Generated from the same schema as the package types. Each field documents its meaning and defaults.

## Scenes

A scene: its space, how it responds to input, and how it is laid out.

### Scene

```ts
/**
 * A view's content and behavior: a space, marks drawn in order, a layout, a theme, controls, an
 * ease duration, and an optional title.
 *
 * A scene is plain data. In JSON, fields are camelCase and each mark is
 * `{ vertices | edges | faces | lines | areas: options }`.
 */
interface Scene {
  /** The coordinate space positions are in. */
  space: Space;
  /** The marks, in drawing order: each draws over the marks before it. */
  marks?: Mark[];
  /**
   * How the view places vertex rows that have no position: a diagram's blocks, or points on a plane
   * or the earth. `none` by default.
   */
  layout?: Layout;
  /** Default colors and sizes, and the look of text, focus, and each space; `dark` by default. */
  theme?: Theme;
  /** How the view responds to the pointer and keyboard. */
  controls?: Controls;
  /** Seconds over which scene and data changes animate; 0.3 by default, 0 for none. */
  ease?: number;
  /** A title drawn at the view's top left, larger than the theme's text. */
  title?: string | null;
  /** A subtitle drawn under the title. */
  subtitle?: string | null;
}
```

### Space

```ts
/**
 * The coordinate space of a scene's positions: a name, or
 * `{ plane | diagram | earth | plot: options }`.
 *
 * The space sets the unit of lengths that do not name their own: units in a diagram, where a unit
 * is a CSS pixel at zoom 0, and CSS pixels elsewhere. Only a diagram has ports, groups, nets, and
 * orthogonal routes.
 */
type Space =
  | 'plane'
  | 'diagram'
  | 'earth'
  | 'plot'
  | {
      /** Longitude and latitude in degrees, on a flat map or a globe. */
      earth: Earth;
    }
  | {
      /** Plane units, with elevation; the camera can turn and tilt. */
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
```

### Plane

```ts
/** A plane: positions are in plane units. */
interface Plane {
  /** The grid drawn under the marks; lines 10 units apart by default. */
  grid?: Grid;
}
```

### Earth

```ts
/**
 * The earth: positions are longitude and latitude in degrees. The ground takes the theme's `earth`
 * colors.
 */
interface Earth {
  /** A flat web mercator map (`mercator`, the default) or a globe (`globe`). */
  projection?: Projection;
  /**
   * Whether lines of longitude and latitude cross the ground, in the theme's `grid` color. Default
   * `true`.
   */
  graticule?: boolean;
  /**
   * Lights the earth by the sun's position this many seconds after the Unix epoch, plus the view's
   * axis coordinate when it has one. The night side darkens the ground and everything on it, down to
   * the theme's `earth.night` brightness. Unset, the earth is lit evenly.
   */
  daylight?: number | null;
  /**
   * Whether air glows around the globe, in the theme's `earth.atmosphere` color, brighter on the day
   * side. Default `false`.
   */
  atmosphere?: boolean;
}
```

### Projection

```ts
/** How the earth is projected. */
type Projection = 'mercator' | 'globe';
```

### Diagram

```ts
/**
 * A flat sheet for diagrams, seen from straight above; the camera pans and zooms but does not
 * turn. Positions are in units with y down. Lengths are in units too, a unit being a CSS pixel at
 * zoom 0: sizes, padding, ports, strokes, text, and the theme's lengths. Sizes given with `px`,
 * the text halo, the focus glow, and the pick radius stay in CSS pixels. Zooming scales the whole
 * picture. Only a diagram has ports, groups, nets, and orthogonal routes, and the scene's layout
 * places its blocks.
 */
interface Diagram {
  /** The grid drawn under the marks; dots 20 units apart by default. */
  grid?: Grid;
}
```

### Plot

```ts
/** A plot: x is the data's axis, y the values. */
interface Plot {
  /** The horizontal axis. */
  x?: Axis;
  /** The vertical axis. */
  y?: Axis;
}
```

### Axis

```ts
/** A plot axis. */
interface Axis {
  /** The axis title. */
  label?: string | null;
  /** Whether grid lines cross the plot at the ticks. Default `true`. */
  grid?: boolean;
  /** Whether the axis is hidden. Default `false`. */
  hidden?: boolean;
  /**
   * Tick positions, each a value or `[value, label]`; a tick without a label shows its value. Unset,
   * ticks fall at round values.
   */
  ticks?: Tick[] | null;
  /** How tick values are formatted; `auto` by default. */
  format?: Format;
  /**
   * Decimal places of fixed values, or of the significand in scientific and engineering formats, at
   * most 15. Unset, as many as the tick step needs.
   */
  precision?: number | null;
}
```

### Tick

```ts
/** A tick in JSON: a value, or `[value, label]`. */
type Tick = number | [number, string | null];
```

### Format

```ts
/** How an axis formats its tick values. */
type Format = 'auto' | 'fixed' | 'scientific' | 'engineering';
```

### Grid

```ts
/** A plane's or a diagram's grid: `"off"`, `{ lines: { pitch } }`, or `{ dots: { pitch, snap } }`. */
type Grid =
  | 'off'
  | {
      /** Lines `pitch` units apart, thinned by factors of ten as the view zooms out. */
      lines: {
        /** Units between lines. */
        pitch: number;
      };
    }
  | {
      /** Dots `pitch` units apart; with `snap`, a diagram's drags snap to them. */
      dots: {
        /** Units between dots. */
        pitch: number;
        /** Whether drag positions snap to the dots, in a diagram. Default `false`. */
        snap?: boolean;
      };
    };
```

### Controls

```ts
/**
 * How a view responds to the pointer and keyboard, and how much it animates on its own: a preset
 * (`"none"` or `"inspect"`), or options over the defaults. Each mark controls whether its own rows
 * pick, select, and drag; these options control the view itself.
 */
type Controls =
  | 'none'
  | 'inspect'
  | {
      /** Whether dragging the background pans the camera. Default `true`. */
      pan?: boolean;
      /**
       * Which input zooms the view: the wheel and pinching (`wheel`, the default); pinching, and the
       * wheel only with Control or Meta held, as trackpad pinches send it, so the plain wheel scrolls
       * the page (`modifier`); or nothing (`off`).
       */
      zoom?: Zoom;
      /**
       * Whether dragging with the secondary button, or with Shift, rotates and tilts a map or plane.
       * Default `true`.
       */
      turn?: boolean;
      /**
       * Whether the keyboard controls the view. Default `true`. Tab and Shift+Tab step through the rows
       * nearest the view's center, and arrow keys step to the nearest row in their direction. Enter
       * opens the stepped-to row and Space selects it. With no row stepped to, arrow keys pan
       * (Shift+arrows turn), `+` and `-` zoom, Home fits everything, and Escape clears the selection.
       */
      keyboard?: boolean;
      /**
       * Whether the hovered row glows, and a hovered vertex sized in CSS pixels grows. Default `true`.
       * Rows are hovered either way: a `'hovered'` event still fires and `hovered` still reads them.
       */
      hover?: boolean;
      /**
       * How far from the pointer, in CSS pixels, a row can be and still be picked; touch adds 8. Default
       * 6.
       */
      pickRadius?: number;
      /**
       * Whether Shift+drag selects the rows inside a box instead of turning the camera. Shift+click
       * still toggles one row. Default `false`.
       */
      selectBox?: boolean;
      /**
       * Whether the user can draw connections, reported as a `'connect'` event: by dragging from a port,
       * from a vertex with Alt held, or an edge's end off its vertex. Default `false`.
       */
      connect?: boolean;
      /** Whether Delete and Backspace report the selection as a `'delete'` event. Default `false`. */
      delete?: boolean;
      /**
       * Whether clicking again at the same point, with the camera unmoved, selects the next row under
       * it, nearest first, so overlapping rows can each be selected. Default `false`.
       */
      cycle?: boolean;
      /**
       * Seconds a touch or pen must hold still to request a menu (a `'menu'` event), as the secondary
       * button does; 0 turns this off. Default 0.5.
       */
      press?: number;
      /**
       * How much the view animates on its own: eases, camera flights, coasting, orbits, label fades,
       * comets, and options that read `elapsed`. `system` (the default) follows the user's
       * reduced-motion setting, `full` animates everything, and `reduced` animates only motion the user
       * drives.
       */
      motion?: Motion;
    };
```

### Motion

```ts
/** How much a view animates on its own. */
type Motion = 'system' | 'full' | 'reduced';
```

### Zoom

```ts
/** Which input zooms a view. */
type Zoom = 'wheel' | 'modifier' | 'off';
```

### Layout

```ts
/**
 * How the view places vertex rows that have no position: a name, or
 * `{ stress | layered: options }`. In a diagram it places blocks; on a plane or the earth it
 * places points among the rows they link to. Gaps are in position units: diagram units, plane
 * units, or degrees on the earth.
 *
 * A row keeps its place once placed: rows added later are placed around the others, and
 * `view.arrange` lays out every row again.
 */
type Layout =
  | 'none'
  | 'stress'
  | 'layered'
  | {
      /** Drawn distances follow graph distances. */
      stress: Stress;
    }
  | {
      /** Ranks along a direction, for flows and hierarchies. */
      layered: Layered;
    };
```

### Layered

```ts
/**
 * Layered drawing: vertices in ranks, edges pointing along `flow`, and nets ranked from their
 * outputs.
 */
interface Layered {
  /** The direction edges point; `right` by default. */
  flow?: Direction;
  /** Distance between vertices within a rank, in position units. Default 30. */
  gap?: number;
  /** Distance between ranks, in position units. Default 80. */
  rankGap?: number;
}
```

### Stress

```ts
/**
 * Stress majorization: vertices move until drawn distances match graph distances, then overlapping
 * boxes separate, keeping a quarter of `gap` between them.
 */
interface Stress {
  /** Distance between the centers of linked vertices, in position units. Default 40. */
  gap?: number;
}
```

### Direction

```ts
/** A direction on screen. */
type Direction = 'right' | 'left' | 'down' | 'up';
```

### Order

```ts
/** Sort direction. Rows where the key has no value sort last in either direction. */
type Order = 'ascending' | 'descending';
```

### Budget

```ts
/** How much GPU memory latkit uses. */
interface Budget {
  /**
   * GPU memory in bytes for the data all views of the `Gpu` draw: its pages and each view's per-row
   * state. A view draws a table too large for its share as a paged table, drawing only the pages the
   * camera needs, so it always fits. Pages no view draws stay cached in the remaining room, least
   * recently drawn evicted first. Defaults to half the device's largest storage buffer. The page
   * pool grows as data needs it and never shrinks, so set the budget before drawing data.
   */
  bytes: number;
  /** Most bytes uploaded per frame; larger data streams in over several frames. Defaults to 32 MiB. */
  uploadPerFrame: number;
}
```

## Themes

How a scene looks, a group for each kind of thing it draws, and the lengths its options take.

### Theme

```ts
/**
 * Default colors and sizes for marks whose options leave them unset or missing, and the look of
 * text, focus, comets, and each space, grouped by subject. Write a base theme's name (`"dark"` or
 * `"light"`), or options over a base (`base`, dark by default); a group's options override only
 * the base values they set.
 *
 * Lengths are in the space's unit (units in a diagram, CSS pixels elsewhere), except the text halo
 * and the focus glow, which are always in CSS pixels.
 */
type Theme =
  | 'dark'
  | 'light'
  | {
      /** The background color. */
      background?: Color;
      /** The color of a plane's or diagram's grid, a plot's grid lines, and the earth's graticule. */
      grid?: Color;
      /** The color a colormap gives a missing value, such as a row whose field has none. */
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
      /** The theme these options change; dark unless set. */
      base?: 'dark' | 'light';
    };
```

### TextTheme

```ts
/** How labels, axis ticks, and titles look. */
interface TextTheme {
  /** The text color. */
  color?: Color;
  /** The CSS font family list. */
  font?: string;
  /** The font size, in the space's unit. */
  size?: number;
  /** Width of the background-colored halo around label text, in CSS pixels. */
  halo?: number;
}
```

### VertexTheme

```ts
/** Defaults for vertices. */
interface VertexTheme {
  /** The vertex color. */
  color?: Color;
  /** The vertex radius, in the space's unit. */
  radius?: number;
}
```

### EdgeTheme

```ts
/** Defaults for edges, and how parallel edges and arrowheads look. */
interface EdgeTheme {
  /**
   * The edge color. `null` blends the colors of each edge's two vertices; a diagram's wires and
   * edges without `ends` (nets and poles) then take the text color.
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
   * Outside a diagram, how far edges joining the same two vertices bow apart: each lane by this
   * fraction of the edge's length at its middle. A family spreads at most eight lanes wide, and more
   * lanes pack closer. A bow is part of the drawing, so it scales with the zoom.
   */
  bow?: number;
  /** How far an arrowhead extends beyond the edge's width: a head is this plus the width long. */
  arrow?: number;
}
```

### LineTheme

```ts
/** Defaults for lines. */
interface LineTheme {
  /** The line color. */
  color?: Color;
  /** The line width, in the space's unit. */
  width?: number;
}
```

### AreaTheme

```ts
/** Defaults for areas. */
interface AreaTheme {
  /** The area color. */
  color?: Color;
}
```

### FlowTheme

```ts
/**
 * How comets flowing along edges and lines look: a round head, brightest at its middle, trailing a
 * tail that thins and fades.
 *
 * `spacing` and `length` must be in the same unit, which also measures each row's `flow` speed. In
 * position units (degrees on the earth), comets are part of the drawing: they scale with the zoom
 * and stay in place along their lines. In CSS pixels, they keep their on-screen size and speed. A
 * plain number is in the space's unit.
 */
interface FlowTheme {
  /**
   * The comet color. Its alpha sets how strongly a comet covers its stroke; a fully transparent
   * color turns comets off.
   */
  color?: Color;
  /** The distance between consecutive comets. */
  spacing?: Length;
  /** The length of a comet's tail behind its head. */
  length?: Length;
  /** The width of a comet's head, in the space's unit; never narrower than its stroke. */
  width?: number;
}
```

### FocusTheme

```ts
/** How hovered and selected rows glow, and how rows outside a selection dim. */
interface FocusTheme {
  /** The glow color around hovered rows. */
  hover?: Color;
  /** The glow color around selected rows; `null` glows in each row's own color. */
  selected?: Color | null;
  /** How far the hover and selection glows reach, in CSS pixels. */
  glow?: number;
  /** The opacity of rows outside the selection while any row is selected, from 0 to 1. */
  dim?: number;
  /** The scale factor for a hovered vertex sized in CSS pixels; vertices sized in units only glow. */
  grow?: number;
}
```

### DiagramTheme

```ts
/** How a diagram's blocks, groups, ports, and wires look. */
interface DiagramTheme {
  /** The fill color of group containers. */
  group?: Color;
  /** The color of the one-unit border around blocks and groups; `null` draws no border. */
  outline?: Color | null;
  /** The corner radius of blocks and groups; a block marker can set its own. */
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
```

### ShadowTheme

```ts
/** How a diagram's blocks and groups cast shadows on the sheet, for vertex marks with `shadow` on. */
interface ShadowTheme {
  /** The color a shadow darkens toward; its alpha sets how dark the shadow is under the block. */
  color?: Color;
  /** How far a shadow falls below its block or group; its edge softens over the same distance. */
  lift?: number;
}
```

### EarthTheme

```ts
/** How the earth looks. */
interface EarthTheme {
  /** The ground color. */
  ground?: Color;
  /** The color of the air glowing around the globe, when the earth's `atmosphere` is on. */
  atmosphere?: Color;
  /** The brightness of the night side when the earth has `daylight`, from 0 to 1. */
  night?: number;
}
```

### PlotTheme

```ts
/** How a plot looks. */
interface PlotTheme {
  /** The color of the line at the view's current axis coordinate. */
  playhead?: Color;
}
```

### Length

```ts
/**
 * A length: a number in the space's unit (units in a diagram, CSS pixels elsewhere), `{ px }` in
 * CSS pixels, or `{ units }` in position units (degrees on the earth), which grow on screen as the
 * view zooms in.
 */
type Length =
  | number
  | {
      /** CSS pixels, at any zoom. */
      px: number;
    }
  | {
      /** Position units (degrees on the earth), which grow on screen as the view zooms in. */
      units: number;
    };
```

## Marks

The marks that draw the tables of a scene.

### Mark

```ts
/** One table a scene draws. In JSON: `{ vertices | edges | faces | lines | areas: options }`. */
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

### Vertices

```ts
/** Rows drawn as markers: points of a map, nodes of a graph, blocks of a diagram. */
interface Vertices {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * Each row's x and y. Without a position, the point field that `geometry` names places rows, and
   * the scene's layout places rows that have neither.
   */
  position?: [ExprInput, ExprInput] | null;
  /**
   * The point field that places rows when `position` is not set; the field named `geometry` by
   * default.
   */
  geometry?: string | null;
  /**
   * Height above the ground; on the earth, a fraction of the earth's radius. Default 0. Not allowed
   * in a diagram, which is flat.
   */
  elevation?: ExprInput;
  /**
   * Each row's radius, in the space's unit (units in a diagram, CSS pixels elsewhere) unless given
   * with `px` or `units`; a diagram refuses `px`. The theme's `vertex.radius` unless set.
   */
  radius?: Size | null;
  /**
   * Each row's width and height, for markers that are not round, in the space's unit unless given
   * with `px` or `units`; a diagram refuses `px`. In a diagram, a block without a size fits its
   * label and ports.
   */
  size?: [Size, Size] | null;
  /** How each row is drawn; an ellipse by default. */
  marker?: Marker;
  /** A ring around each row's marker in this color; a missing or transparent color draws none. */
  ring?: PaintInput | null;
  /**
   * Ports on each row, one for each reference field that names a net. An `edges` mark of the net
   * table, without `ends`, draws the nets. Diagrams only.
   */
  ports?: [reference: string, port: Port][];
  /**
   * Makes each row a group containing the rows of `table` whose `reference` field names it. A group
   * draws as a container around its members, with its label as a title in its header. Diagrams only.
   */
  contains?: [table: string, reference: string] | null;
  /**
   * Whether each block or group casts a shadow on the sheet, styled by the theme's `diagram.shadow`.
   * Default `false`. Diagrams only.
   */
  shadow?: boolean;
  /**
   * Each row's color. Unset, rows take the theme's default for the mark; faces instead blend their
   * corners' colors.
   */
  color?: PaintInput | null;
  /** Whether each row is drawn and can be picked. Default `true`. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone (no view state). Higher-priority rows draw on top, are
   * the last dropped when a table too large to draw whole is thinned to the tiles in view, and are
   * labeled first.
   */
  priority?: ExprInput | null;
  /** Distinguishes two marks of the same table across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows respond to hover, clicks, and picks. Unset, vertices, edges, faces, and plot traces
   * do, and geometry (areas, and lines along paths such as coasts, borders, and roads) does not.
   */
  pick?: boolean | null;
  /** Whether clicking a row selects it. Default `true`. */
  select?: boolean;
  /**
   * Whether pressing and moving a row drags it, reported as a `'drag'` event, instead of panning the
   * camera. Default `false`.
   */
  drag?: boolean;
  /** Each row's label: a text field, or label options. */
  label?: Label | null;
  /**
   * A legend of the mark's colors at the view's bottom right, under this title: a ticked colormap
   * across its domain, a cell for each category, or a swatch beside each name of a map's
   * `categories`. `color` must map through a colormap with a fixed domain or named categories; in a
   * conditional, `otherwise` is searched before the cases.
   */
  legend?: string | null;
}
```

### Edges

```ts
/**
 * Rows drawn as strokes between the vertices named by two reference fields: branches, links,
 * wires. In a diagram, a row without ends is a net, joining every vertex port whose reference
 * field names it.
 */
interface Edges {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /** The reference fields naming each row's two vertices. */
  ends?: [from: string, to: string] | null;
  /** A path field whose points each row passes through between its ends. */
  bends?: string | null;
  /**
   * How each row runs between its ends: geodesic on the earth and straight elsewhere unless set.
   * `orthogonal` routes around blocks with rounded bends, in diagrams only.
   */
  route?: Route | null;
  /**
   * Whether each row has an arrowhead at its second end; a net has one at each input it reaches.
   * Default `false`.
   */
  arrows?: boolean;
  /**
   * Draws each row as a pole from its own vertex down to the ground, on a plane or the earth. Poles
   * take no `ends`, `bends`, or `joins`. Default `false`.
   */
  poles?: boolean;
  /**
   * Draws each row as a net on a plane or the earth, joining the vertex rows of `table` whose
   * `reference` field names it: a star from their center to each member.
   */
  joins?: [table: string, reference: string] | null;
  /**
   * Each row's width, in the space's unit (units in a diagram, CSS pixels elsewhere) unless given
   * with `px` or `units`. The theme's width unless set.
   */
  width?: Size | null;
  /** Whether each row is dashed, with the theme's `dash` period. Default `false`. */
  dash?: ExprInput;
  /**
   * The speed of comets flowing along each row, per second, in the unit of the theme's `flow`
   * lengths. Negative speeds flow backward; 0, the default, draws no comets. When the speed changes,
   * comets continue from where they are.
   */
  flow?: ExprInput;
  /**
   * Each row's color. Unset, rows take the theme's default for the mark; faces instead blend their
   * corners' colors.
   */
  color?: PaintInput | null;
  /** Whether each row is drawn and can be picked. Default `true`. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone (no view state). Higher-priority rows draw on top, are
   * the last dropped when a table too large to draw whole is thinned to the tiles in view, and are
   * labeled first.
   */
  priority?: ExprInput | null;
  /** Distinguishes two marks of the same table across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows respond to hover, clicks, and picks. Unset, vertices, edges, faces, and plot traces
   * do, and geometry (areas, and lines along paths such as coasts, borders, and roads) does not.
   */
  pick?: boolean | null;
  /** Whether clicking a row selects it. Default `true`. */
  select?: boolean;
  /**
   * Whether pressing and moving a row drags it, reported as a `'drag'` event, instead of panning the
   * camera. Default `false`.
   */
  drag?: boolean;
  /** Each row's label: a text field, or label options. */
  label?: Label | null;
  /**
   * A legend of the mark's colors at the view's bottom right, under this title: a ticked colormap
   * across its domain, a cell for each category, or a swatch beside each name of a map's
   * `categories`. `color` must map through a colormap with a fixed domain or named categories; in a
   * conditional, `otherwise` is searched before the cases.
   */
  legend?: string | null;
}
```

### Lines

```ts
/**
 * Rows drawn as lines along a path field (roads, rivers, borders) or a polygon field's rings (area
 * outlines). On a plot, each row instead traces a sampled field's history across the data's axis,
 * as a monitor does. On the earth, paths follow the globe's curve and stay whole across the
 * antimeridian.
 */
interface Lines {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * The path or polygon field each row runs along; the field named `geometry` by default. Not
   * allowed on a plot.
   */
  geometry?: string | null;
  /**
   * The sampled field each row traces across the data's axis; plots only, where it is required. A
   * field with no frames yet draws nothing until its first frame arrives.
   */
  trace?: string | null;
  /** How each row runs between its samples on a plot; `linear` by default. */
  interpolation?: Interpolation;
  /**
   * Each row's width, in the space's unit (units in a diagram, CSS pixels elsewhere) unless given
   * with `px` or `units`. The theme's width unless set.
   */
  width?: Size | null;
  /** Whether each row is dashed, with the theme's `dash` period. Default `false`. */
  dash?: ExprInput;
  /**
   * The speed of comets flowing along each row, per second, in the unit of the theme's `flow`
   * lengths. Negative speeds flow backward; 0, the default, draws no comets. When the speed changes,
   * comets continue from where they are.
   */
  flow?: ExprInput;
  /**
   * Each row's color. Unset, rows take the theme's default for the mark; faces instead blend their
   * corners' colors.
   */
  color?: PaintInput | null;
  /** Whether each row is drawn and can be picked. Default `true`. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone (no view state). Higher-priority rows draw on top, are
   * the last dropped when a table too large to draw whole is thinned to the tiles in view, and are
   * labeled first.
   */
  priority?: ExprInput | null;
  /** Distinguishes two marks of the same table across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows respond to hover, clicks, and picks. Unset, vertices, edges, faces, and plot traces
   * do, and geometry (areas, and lines along paths such as coasts, borders, and roads) does not.
   */
  pick?: boolean | null;
  /** Whether clicking a row selects it. Default `true`. */
  select?: boolean;
  /**
   * Whether pressing and moving a row drags it, reported as a `'drag'` event, instead of panning the
   * camera. Default `false`.
   */
  drag?: boolean;
  /** Each row's label: a text field, or label options. */
  label?: Label | null;
  /**
   * A legend of the mark's colors at the view's bottom right, under this title: a ticked colormap
   * across its domain, a cell for each category, or a swatch beside each name of a map's
   * `categories`. `color` must map through a colormap with a fixed domain or named categories; in a
   * conditional, `otherwise` is searched before the cases.
   */
  legend?: string | null;
}
```

### Areas

```ts
/**
 * Rows drawn as the areas of a polygon field: parcels, states, lakes, the land and water of a map.
 * The view triangulates each row's polygons once, in the background when they are large. On the
 * earth, areas follow the globe's curve and stay whole across the antimeridian. To outline areas,
 * add a `Lines` mark of the same table, which draws their rings.
 */
interface Areas {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * The polygon field each row fills, holding one polygon's rings or several polygons; the field
   * named `geometry` by default.
   */
  geometry?: string | null;
  /**
   * Each row's color. Unset, rows take the theme's default for the mark; faces instead blend their
   * corners' colors.
   */
  color?: PaintInput | null;
  /** Whether each row is drawn and can be picked. Default `true`. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone (no view state). Higher-priority rows draw on top, are
   * the last dropped when a table too large to draw whole is thinned to the tiles in view, and are
   * labeled first.
   */
  priority?: ExprInput | null;
  /** Distinguishes two marks of the same table across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows respond to hover, clicks, and picks. Unset, vertices, edges, faces, and plot traces
   * do, and geometry (areas, and lines along paths such as coasts, borders, and roads) does not.
   */
  pick?: boolean | null;
  /** Whether clicking a row selects it. Default `true`. */
  select?: boolean;
  /**
   * Whether pressing and moving a row drags it, reported as a `'drag'` event, instead of panning the
   * camera. Default `false`.
   */
  drag?: boolean;
  /** Each row's label: a text field, or label options. */
  label?: Label | null;
  /**
   * A legend of the mark's colors at the view's bottom right, under this title: a ticked colormap
   * across its domain, a cell for each category, or a swatch beside each name of a map's
   * `categories`. `color` must map through a colormap with a fixed domain or named categories; in a
   * conditional, `otherwise` is searched before the cases.
   */
  legend?: string | null;
}
```

### Faces

```ts
/**
 * Rows drawn as triangles between the vertices named by three reference fields: meshes, surfaces,
 * and fields interpolated across a network. Faces are lit from the camera, so a flat mesh seen
 * from above shows its exact colors.
 */
interface Faces {
  /** The dataset and table drawn. */
  of: [data: string, table: string];
  /**
   * The reference fields naming each row's three vertices; required. Without a color, a face blends
   * the colors of its corners.
   */
  corners?: [a: string, b: string, c: string] | null;
  /**
   * Each row's color. Unset, rows take the theme's default for the mark; faces instead blend their
   * corners' colors.
   */
  color?: PaintInput | null;
  /** Whether each row is drawn and can be picked. Default `true`. */
  visible?: ExprInput;
  /**
   * Each row's priority, from its data alone (no view state). Higher-priority rows draw on top, are
   * the last dropped when a table too large to draw whole is thinned to the tiles in view, and are
   * labeled first.
   */
  priority?: ExprInput | null;
  /** Distinguishes two marks of the same table across scenes, and names the mark in hits. */
  name?: string | null;
  /**
   * Whether rows respond to hover, clicks, and picks. Unset, vertices, edges, faces, and plot traces
   * do, and geometry (areas, and lines along paths such as coasts, borders, and roads) does not.
   */
  pick?: boolean | null;
  /** Whether clicking a row selects it. Default `true`. */
  select?: boolean;
  /**
   * Whether pressing and moving a row drags it, reported as a `'drag'` event, instead of panning the
   * camera. Default `false`.
   */
  drag?: boolean;
  /** Each row's label: a text field, or label options. */
  label?: Label | null;
  /**
   * A legend of the mark's colors at the view's bottom right, under this title: a ticked colormap
   * across its domain, a cell for each category, or a swatch beside each name of a map's
   * `categories`. `color` must map through a colormap with a fixed domain or named categories; in a
   * conditional, `otherwise` is searched before the cases.
   */
  legend?: string | null;
}
```

### Marker

```ts
/**
 * How a vertex is drawn: a shape's name, `"block"`, or
 * `{ shape | block | gauge | pie | icon | wgsl: options }`. An ellipse by default.
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
      /** A rectangle with rounded corners that holds its label inside, as a diagram's blocks do. */
      block: {
        /**
         * Corner radius in the space's unit (units in a diagram, CSS pixels elsewhere); the theme's
         * `diagram.corner` unless set.
         */
        corner?: number | null;
      };
    }
  | {
      /** A shape's outline, filled to `fill` from 0 to 1: around a circle, or upward in other shapes. */
      gauge: {
        /** How full each row's gauge is, from 0 to 1. */
        fill: ExprInput;
        /** The outline's shape; an ellipse by default. */
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
        /** The hole in the middle, as a fraction of the radius; 0 by default. */
        hole?: number;
      };
    }
  | {
      /** One of `images`, fitted to the marker's box; `index` picks the image for each row. */
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
```

### Shape

```ts
/** A marker's outline. */
type Shape = 'ellipse' | 'rectangle' | 'rounded' | 'diamond';
```

### Bitmap

```ts
/** An image of RGBA texels: straight alpha, sRGB, rows top to bottom. */
interface Bitmap {
  /** Width and height in texels. */
  size: [number, number];
  /** `size[0] * size[1] * 4` bytes. */
  rgba: number[];
}
```

### Port

```ts
/**
 * A port on one side of a vertex's marker, where a net connects: a side name, or options. The
 * vertex names the net in a reference field. An output drives its net: layouts rank a net from its
 * outputs, and the net's arrows point away from them.
 */
type Port =
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
      /** Its shape; an ellipse by default. */
      shape?: Shape;
      /** Whether it is an output, which drives its net. Default `false`, an input. */
      output?: boolean;
    };
```

### Side

```ts
/** A side of a marker. */
type Side = 'left' | 'right' | 'top' | 'bottom';
```

### Route

```ts
/** How an edge runs between its ends. */
type Route = 'straight' | 'geodesic' | 'orthogonal';
```

### Interpolation

```ts
/** How a line runs between its samples. */
type Interpolation = 'linear' | 'stepBefore' | 'stepAfter';
```

### Label

```ts
/**
 * Text for each row, placed beside, inside, or along the row's shape and following it every frame:
 * a text field, or options. Where labels would overlap, the higher priority shows; among equals,
 * labels already shown stay. In a diagram a label is part of the drawing: it scales with the zoom,
 * fades out when too small to read, and shows wherever it fits its vertex.
 */
type Label =
  | ExprInput
  | {
      /** The text field to show. */
      text: ExprInput;
      /**
       * Font size in the space's unit (units in a diagram, CSS pixels elsewhere); the theme's
       * `text.size` unless set.
       */
      size?: number | null;
      /** Each row's text color; the theme's text color unless set. */
      color?: PaintInput | null;
      /** Where labels would overlap, the higher priority shows; the mark's `priority` unless set. */
      priority?: ExprInput | null;
      /** The width at which lines wrap, in the space's unit (units in a diagram, CSS pixels elsewhere). */
      maxWidth?: number | null;
      /** The CSS font family list for the text; the theme's `text.font` unless set. */
      font?: string | null;
      /**
       * The most labels shown at once: those of highest priority among the rows in view, or fewer where
       * they would overlap. No limit unless set.
       */
      max?: number | null;
    };
```

### Size

```ts
/**
 * A size: a value in the space's unit (units in a diagram, CSS pixels elsewhere), `{ px }` in CSS
 * pixels, or `{ units }` in position units (degrees on the earth), which grow on screen as the
 * view zooms in.
 */
type Size = ExprInput | Px | Units;
```

### Px

```ts
/** A size in CSS pixels, regardless of the space's unit. */
interface Px {
  /** The size, in CSS pixels. */
  px: ExprInput;
}
```

### Units

```ts
/**
 * A size in position units (degrees on the earth), regardless of the space's unit, so it scales as
 * the view zooms. `atLeast` and `atMost` bound it in CSS pixels.
 */
interface Units {
  /** The size, in position units. */
  units: ExprInput;
  /** The minimum on-screen size in CSS pixels, however far the view zooms out. */
  atLeast?: number | null;
  /** The maximum on-screen size in CSS pixels, however far the view zooms in. */
  atMost?: number | null;
}
```

## Expressions

Expressions as JSON: a constant, a field, or one of these nodes. Colors take CSS strings where values take field names.

### ExprNode

```ts
/** A value for each row: a number, a boolean, a field's name, or a node that computes one. */
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

### PaintNode

```ts
/**
 * A color for each row: a CSS color, a value through a colormap, or a conditional choosing between
 * colors.
 */
type PaintNode = Color | ColorNode | ColormapNode | WhenPaintNode | MissingNode;
```

### FieldNode

```ts
/**
 * A field's value in each row: from the mark's own table, or with `from`, from another dataset's
 * table joined by row id.
 */
interface FieldNode {
  /** The field's name. */
  field: string;
  /** The dataset and table the field is read from, joined by row id. */
  from?: [data: string, table: string] | null;
  /**
   * For a sampled field, reads the last frame at or before the shown coordinate instead of
   * interpolating. Default `false`.
   */
  step?: boolean;
}
```

### ColorNode

```ts
/** A constant color. */
interface ColorNode {
  /** A CSS color, such as `#ffb000` or `rebeccapurple`. */
  color: Color;
}
```

### StateNode

```ts
/** View state of each row, such as whether it is selected. */
interface StateNode {
  state: State;
}
```

### MissingNode

```ts
/** A missing value. An option that evaluates to missing uses the theme's value. */
interface MissingNode {
  missing: true;
}
```

### UnaryNode

```ts
/** A one-argument operation, such as `{ "op": "abs", "args": ["x"] }`. */
interface UnaryNode {
  op: Unary;
  args: [ExprInput];
}
```

### BinaryNode

```ts
/** A two-argument operation, such as `{ "op": "add", "args": ["a", 1] }`. */
interface BinaryNode {
  op: Binary;
  args: [ExprInput, ExprInput];
}
```

### WhenNode

```ts
/** The value of the first case whose condition holds, else `otherwise`. */
interface WhenNode {
  /** The cases, as `[condition, value]` pairs tried in order. */
  when: [condition: ExprInput, value: ExprInput][];
  /** The value where no condition holds. */
  otherwise: ExprInput;
}
```

### WhenPaintNode

```ts
/** A conditional color: the color of the first case whose condition holds, else `otherwise`. */
interface WhenPaintNode {
  /** The cases, as `[condition, color]` pairs tried in order. */
  when: [condition: ExprInput, color: PaintInput][];
  /** The color where no condition holds. */
  otherwise: PaintInput;
}
```

### IsNode

```ts
/** Whether a text field equals the text exactly. */
interface IsNode {
  is: [field: ExprInput, text: string];
}
```

### ContainsNode

```ts
/**
 * Whether a text field contains the text, ignoring case. In a mark, the field must belong to the
 * mark's own table.
 */
interface ContainsNode {
  contains: [field: ExprInput, text: string];
}
```

### ScaleNode

```ts
/**
 * `value` mapped linearly from `domain` onto the range `scale`, clamped to the range. Without a
 * `domain`, the extent of the values shown is used.
 */
interface ScaleNode {
  scale: [low: number, high: number];
  value: ExprInput;
  domain?: [low: number, high: number] | null;
}
```

### ColormapNode

```ts
/**
 * `value` mapped through `colormap` over `domain`, or without a `domain`, over the extent of the
 * values shown. A categorical map ignores the domain and bins values by their integer part.
 */
interface ColormapNode {
  colormap: Colormap;
  value: ExprInput;
  domain?: [low: number, high: number] | null;
}
```

### Unary

```ts
/** An operation on one value. `sin` and `cos` take radians; `not` treats values above 0.5 as true. */
type Unary = 'neg' | 'not' | 'abs' | 'sqrt' | 'sin' | 'cos' | 'floor' | 'ln' | 'exp';
```

### Binary

```ts
/**
 * An operation on two values: arithmetic, `min` and `max`, comparisons (1 for true, 0 for false),
 * and logic. `rem` is a floored remainder, which takes the sign of the divisor. `and` and `or`
 * treat values above 0.5 as true.
 */
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

### State

```ts
/**
 * View state of each row: `selected`, `hovered`, `pointer` (CSS pixels from a vertex to the
 * pointer), `elapsed` (seconds since the view was created), or `zoom` (the camera's zoom).
 */
type State = 'selected' | 'hovered' | 'pointer' | 'elapsed' | 'zoom';
```

### Colormap

```ts
/** Colors for a range of values: a catalog name, or your own colors. */
type Colormap = ColormapName | CustomColormap;
```

### ColormapName

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

### ColormapKind

```ts
/**
 * How a colormap maps values: `sequential` and `diverging` maps clamp, `cyclic` maps wrap, and
 * `categorical` maps give each integer its own color.
 */
type ColormapKind = 'sequential' | 'diverging' | 'cyclic' | 'categorical';
```

### CustomColormap

```ts
/** A custom colormap: its kind, its colors, and for a categorical map, its category names. */
interface CustomColormap {
  kind: ColormapKind;
  /**
   * The colors, blended in OKLab. Each is a color, spaced evenly between its neighbors as in a CSS
   * gradient, or a `[place, color]` pair with a place from 0 to 1, in ascending order. A categorical
   * map takes one color per category, without places, at most 256.
   */
  colors: (Color | [number, Color])[];
  /** The category names in category order, shown in legends. Categorical maps only. */
  categories?: string[];
}
```

## Rows, cameras, and queries

Identifying rows, framing them, and querying them.

### Id

```ts
/**
 * A row's id: a whole number from 0, or a text. A number above 2^53 - 1 is written as its decimal
 * text, which names the same row.
 */
type Id = number | string;
```

### Ids

```ts
/**
 * Row ids: numbers or texts, or `{count}` for rows 0 to count - 1. In a reference, null names no
 * row.
 */
type Ids =
  | (Id | null)[]
  | {
      count: number;
    };
```

### Row

```ts
/**
 * One row, identified by dataset name, table name, and id. It stays valid across any change that
 * keeps those names and the id.
 */
interface Row {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The row's id in the table. */
  id: Id;
}
```

### Rows

```ts
/**
 * Rows of one table in a dataset, by id. Views use it for selections, fits, and the rows events
 * report.
 */
interface Rows {
  /** The dataset's name. */
  data: string;
  /** The table's name. */
  table: string;
  /** The rows' ids in the table. */
  ids: Id[];
}
```

### Camera

```ts
/** Where a view looks. */
type Camera =
  | {
      /**
       * Longitude, latitude, and elevation on the earth; x, y, and elevation on a plane or a diagram. In
       * JSON, `[x, y]` is shorthand for elevation 0.
       */
      center: [number, number] | [number, number, number];
      /** The web mercator zoom level on the earth; elsewhere, log₂ of CSS pixels per unit. */
      zoom: number;
      /** Tilt in degrees from looking straight down, up to 75. Ignored in a diagram. */
      pitch: number;
      /** Degrees clockwise from north, or from up on a plane. Ignored in a diagram. */
      bearing: number;
    }
  | {
      /** The x-axis range shown. */
      x: [number, number];
      /** The value range shown, or `null` to fit the values in view. */
      y?: [number, number] | null;
    };
```

### Fit

```ts
/** The target of a view's fit. */
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

### Query

```ts
/** The rows of a table to read back, run through the expressions marks draw with. */
interface Query {
  /** The table to read. */
  of: string;
  /**
   * The rows to read, in this order unless sorted; every row when unset. Ids that name no row are
   * skipped.
   */
  ids?: Ids | null;
  /** Keeps only the rows for which this is true. */
  filter?: ExprInput | null;
  /**
   * Keys to sort by, each breaking ties left by the keys before it. Rows where a key has no value
   * sort last; rows equal on every key keep their order.
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
   * Fields to return, by output name. A plain field returns that field as stored; any other
   * expression returns numbers. Every field when unset; an empty object returns the ids alone.
   */
  select?: {
    [name: string]: ExprInput;
  } | null;
  /** The axis coordinate at which sampled fields are read; their last frame when unset. */
  at?: number | null;
}
```

### EnvelopeRequest

```ts
/**
 * A request for each row's least and greatest value of a sampled field over equal spans of the
 * axis: field `field` of table `table`, over `spans` equal spans from `range[0]` to `range[1]`,
 * for every row or for the rows `ids` names, in that order. Plain data that deserializes from
 * JSON, like a query.
 */
interface EnvelopeRequest {
  /** The table to read. */
  table: string;
  /** The sampled field to read. */
  field: string;
  /** The axis range the spans cover, `[first, last]`: finite, with `first <= last`. */
  range: [number, number];
  /** The number of equal spans to divide the range into; at least 1. */
  spans: number;
  /** The rows to read, in this order; every row when unset. */
  ids?: Ids | null;
}
```

## Results

View events and hits, dataset descriptions and values, and frame statistics.

### ViewEvent

```ts
/** Something that happened in a view, as `view.on` reports it. */
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
        /** The rows under the point, nearest first. */
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
         * The row's new position in the space's coordinates: the hit point moved with the pointer since
         * the press, at the depth where the drag started, so a vertex keeps its grab offset. Snapped to a
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
        /** The edge whose end was dragged off; `to` replaces that end. */
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
      type: 'hovered';
      detail: {
        /** The row now hovered; `null` once no row is. */
        hit: Hit | null;
        /** The pointer, or the keys. */
        trigger: Trigger;
      };
    }
  | {
      type: 'selection';
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

### Hit

```ts
/** A row under a point, as the frame drew it. */
interface Hit {
  /** The row. */
  row: Row;
  /** The name of the mark that drew it, if named. It tells two marks of one table apart. */
  mark?: string;
  /**
   * The row's point nearest the probe, in CSS pixels from the top left: a vertex's or port's middle,
   * or the nearest point of a stroke or triangle.
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

### End

```ts
/** A vertex a connection ends at, and the port the connection meets, if any. */
interface End {
  /** The vertex. */
  row: Row;
  /** The port, by the reference field naming its net. */
  port?: string;
}
```

### Failure

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

### Phase

```ts
/** The phase of a `Drag`. */
type Phase = 'start' | 'move' | 'end';
```

### Trigger

```ts
/**
 * Where the user acted, with which modifier keys, and with which device. For keyboard input, the
 * point is the row the keys point at, else the pointer, else the view's middle.
 */
interface Trigger {
  /** CSS pixels from the top left. */
  point: [number, number];
  /** The modifier keys held. */
  modifiers: Modifiers;
  /** The device used. */
  device: Device;
}
```

### Device

```ts
/** The input device. */
type Device = 'mouse' | 'pen' | 'touch' | 'keyboard';
```

### Modifiers

```ts
/** Modifier keys held during an input. */
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

### Description

```ts
/**
 * A summary of a dataset: its tables with their rows and fields, the axis sampled fields are
 * recorded over, and the part of the axis they cover.
 */
interface Description {
  /** The dataset's name. */
  name: string;
  /** The axis name and unit, if set. */
  axis: [string, string] | null;
  /** The first and last axis coordinates held by any sampled field; `null` when none holds any. */
  span: [number, number] | null;
  /** Its tables, sorted by name. */
  tables: TableDescription[];
}
```

### TableDescription

```ts
/** A summary of one table: its row count and its fields, sorted by name. */
interface TableDescription {
  /** The table's name. */
  name: string;
  /** The number of rows. */
  rows: number;
  /** Its fields, sorted by name. */
  fields: FieldDescription[];
}
```

### FieldDescription

```ts
/** A summary of one field: its kind, plus its target table or axis span where those apply. */
interface FieldDescription {
  /** The field's name. */
  name: string;
  /** The kind of values it holds. */
  kind: Kind;
  /** For a reference, the target table. */
  to?: string;
  /** For a sampled field, the first and last axis coordinates it holds. */
  span?: [number, number];
}
```

### Kind

```ts
/** The kind of values a field holds. */
type Kind =
  'number' | 'bool' | 'text' | 'point' | 'path' | 'parts' | 'polygons' | 'reference' | 'sampled';
```

### Value

```ts
/**
 * A value read from a dataset: a number (`null` when not finite), boolean, or text; a geometry as
 * nested `[x, y]` points; a reference as the id of the row it names.
 */
type Value = number | boolean | string | null | [number, number] | unknown[][];
```

### Sample

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

### Stats

```ts
/** Counters describing a view's frames. */
interface Stats {
  /** Frames rendered. */
  frames: number;
  /** Rows of every mark's table. */
  rows: number;
  /**
   * Rows every mark draws: every row of a table drawn whole, and the rows of the tiles in view of a
   * paged table.
   */
  drawn: number;
  /** Draw calls the last frame recorded, label draws included. */
  draws: number;
  /**
   * Instances the last frame's draws drew: points, segments, triangles, and glyphs. An upper bound
   * for segments, which the GPU may cull.
   */
  instances: number;
  /** Fetched tiles the view draws, of every tile source. */
  tiles: number;
  /** Tiles being fetched or decoded, of every tile source. */
  tilesLoading: number;
  /** Milliseconds the last frame took to record on the CPU. */
  cpuMs: number;
  /**
   * Milliseconds the GPU takes per frame: the median of recently measured frames; 0 if the device
   * cannot measure.
   */
  gpuMs: number;
}
```

### Waiting

```ts
/**
 * What a frame still waits on: pipelines the scene draws with, which compile before the view draws
 * anything new (`compiling`); pages uploading, or tables not yet built from them (`data`);
 * layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); label placement, or text not yet
 * set (`labels`); a fit due or being measured (`fit`); segment counts, or a transition starting
 * (`marks`). Empty once the frame is complete.
 */
type Waiting = ('compiling' | 'data' | 'derived' | 'labels' | 'fit' | 'marks')[];
```

### Work

```ts
/**
 * Counts of the work a `Gpu` has done since it was created. Subtract two snapshots to get the work
 * between them.
 */
interface Work {
  /** Bytes of data pages uploaded. */
  uploaded: number;
  /**
   * Data pages, or pieces of pages, uploaded. A change's uploads count pages here and bytes in
   * `uploaded`.
   */
  uploads: number;
  /** Bytes written other than pages: uniforms, programs, label runs, the selection, and textures. */
  written: number;
  /** Rows whose channels the GPU evaluated. */
  evaluated: number;
  /**
   * Edge and face rows whose endpoints the GPU resolved to their vertices' resident rows: rows that
   * changed, plus every row of a page that references a vertex now resident elsewhere.
   */
  resolved: number;
  /**
   * Bytes of per-row word pages the GPU cleared: pages read before anything writes them, and the
   * normals that faces sum from scratch.
   */
  cleared: number;
  /**
   * Rows packed into pages of a paged table's draw order. Each page is packed once, the first time a
   * view draws it, and again only when a write changes its rows.
   */
  packed: number;
  /**
   * Readbacks from the GPU: probes, queries, fits, label placements, segment counts, and pictures.
   * Frame timer readbacks, which only some devices support, are not counted.
   */
  readbacks: number;
  /**
   * Jobs started: layouts, routes, lanes, triangulations, pyramids, and tiles. They run on the
   * host's workers, or immediately without a host.
   */
  jobs: number;
  /** Label texts the host was asked to rasterize. */
  texts: number;
  /**
   * Pipelines compiled. In a browser, each compiles in the background when a view or shot requests
   * it ahead of use. Natively, each compiles when first created.
   */
  pipelines: number;
  /**
   * Pipelines not requested ahead of use, compiled when first used. In a browser they compile on the
   * GPU's thread and delay frames. Zero unless a scene uses a pipeline it did not request.
   */
  late: number;
}
```
