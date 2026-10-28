# Scene and result types

The types of the scenes latkit draws and the results it reports, generated from the same schema as
the package's types. Each property gives its meaning and default.

## Scenes

A scene: its space, how it responds to input, and how it is laid out.

(scene)=

### `Scene`

{.signature}
`interface Scene`

A view's content and behavior: a space, marks drawn in order, a layout, a theme, controls, an
ease duration, and an optional title.

A scene is plain data. In JSON, fields are camelCase, and the key naming each mark's kind holds
its dataset and table: `{ "vertices": ["grid", "Bus"], "radius": 4 }`.

{#scene-space .member}
**`space`**`:` [`Space`](#space) [¶](#scene-space){.headerlink}
: The coordinate space positions are in.

{#scene-marks .member}
**`marks`**`?:` [`Mark`](#mark)`[]` [¶](#scene-marks){.headerlink}
: The marks, in drawing order: each draws over the marks before it.

{#scene-layout .member}
**`layout`**`?:` [`Layout`](#layout) [¶](#scene-layout){.headerlink}
: How the view places vertex rows that have no position, such as a diagram's blocks or points on a
  plane or the earth. Defaults to `none`.

{#scene-theme .member}
**`theme`**`?:` [`Theme`](#theme) [¶](#scene-theme){.headerlink}
: Default colors and sizes, and the look of text, focus, and each space. Defaults to `dark`.

{#scene-controls .member}
**`controls`**`?:` [`Controls`](#controls) [¶](#scene-controls){.headerlink}
: How the view responds to the pointer and keyboard.

{#scene-ease .member}
**`ease`**`?: number` [¶](#scene-ease){.headerlink}
: How many seconds scene and data changes take to animate. 0 turns animation off. Defaults to 0.3.

{#scene-title .member}
**`title`**`?: string | null` [¶](#scene-title){.headerlink}
: A title drawn at the view's top left, larger than the theme's text.

{#scene-subtitle .member}
**`subtitle`**`?: string | null` [¶](#scene-subtitle){.headerlink}
: A subtitle drawn under the title.

(space)=

### `Space`

{.signature}
`type Space = 'plane' | 'diagram' | 'earth' | 'plot' | { earth:` [`Earth`](#earth) `} | { plane:` [`Plane`](#plane) `} | { plot:` [`Plot`](#plot) `} | { diagram:` [`Diagram`](#diagram) `}`

The coordinate space of a scene's positions: a name, or
`{ plane | diagram | earth | plot: options }`.

The space sets the unit of lengths that do not name their own. In a diagram it is the diagram
unit, one CSS pixel at zoom 0. Elsewhere it is the CSS pixel. Only a diagram has ports, groups,
nets, and orthogonal routes.

{#space-earth .member}
`{` **`earth`**`:` [`Earth`](#earth) `}` [¶](#space-earth){.headerlink}
: Longitude and latitude in degrees, on a flat map or a globe.

{#space-plane .member}
`{` **`plane`**`:` [`Plane`](#plane) `}` [¶](#space-plane){.headerlink}
: Plane units, with elevation. The camera can turn and tilt.

{#space-plot .member}
`{` **`plot`**`:` [`Plot`](#plot) `}` [¶](#space-plot){.headerlink}
: The data's axis horizontally and values vertically.

{#space-diagram .member}
`{` **`diagram`**`:` [`Diagram`](#diagram) `}` [¶](#space-diagram){.headerlink}
: A flat sheet for diagrams: x right and y down, every length in units.

(plane)=

### `Plane`

{.signature}
`interface Plane`

A plane: positions are in plane units.

{#plane-grid .member}
**`grid`**`?:` [`Grid`](#grid) [¶](#plane-grid){.headerlink}
: The grid drawn under the marks. Defaults to lines 10 units apart.

(earth)=

### `Earth`

{.signature}
`interface Earth`

The earth: positions are longitude and latitude in degrees. The ground uses the theme's `earth`
colors.

A flat map shows the world once. Its ground ends at the antimeridian and at Web Mercator's
latitude limit. The camera zooms out until the whole world fits the view, and pans until the
world's edges meet the view's edges. On a globe, longitude wraps, and the camera zooms out until
the globe spans a third of the view's shorter side.

{#earth-projection .member}
**`projection`**`?:` [`Projection`](#projection) [¶](#earth-projection){.headerlink}
: A flat web mercator map (`mercator`) or a globe (`globe`). Defaults to `mercator`.

{#earth-graticule .member}
**`graticule`**`?: boolean` [¶](#earth-graticule){.headerlink}
: Whether lines of longitude and latitude cross the ground, in the theme's `grid` color. Defaults
  to `true`.

{#earth-daylight .member}
**`daylight`**`?: number | null` [¶](#earth-daylight){.headerlink}
: Lights the earth by the sun's position this many seconds after the Unix epoch, plus the view's
  axis coordinate when it has one. The night side darkens the ground and everything on it, down to
  the theme's `earth.night` brightness. When unset, the earth is lit evenly.

{#earth-atmosphere .member}
**`atmosphere`**`?: boolean` [¶](#earth-atmosphere){.headerlink}
: Whether air glows around the globe, in the theme's `earth.atmosphere` color, brighter on the day
  side. Defaults to `false`.

(projection)=

### `Projection`

{.signature}
`type Projection = 'mercator' | 'globe'`

How the earth is projected.

{#projection-mercator .member}
**`'mercator'`** [¶](#projection-mercator){.headerlink}
: Web mercator.

{#projection-globe .member}
**`'globe'`** [¶](#projection-globe){.headerlink}
: A sphere.

(diagram)=

### `Diagram`

{.signature}
`interface Diagram`

A flat sheet for diagrams, seen from straight above. The camera pans and zooms but does not
turn. Positions are in units with y down, and a unit is a CSS pixel at zoom 0. Sizes, padding,
ports, strokes, text, and the theme's lengths are in units too. Sizes given with `px`, the text
halo, the focus glow, and the pick radius stay in CSS pixels. Zooming scales the whole picture.
Only a diagram has ports, groups, nets, and orthogonal routes, and the scene's layout places its
blocks.

{#diagram-grid .member}
**`grid`**`?:` [`Grid`](#grid) [¶](#diagram-grid){.headerlink}
: The grid drawn under the marks. Defaults to dots 20 units apart.

(plot)=

### `Plot`

{.signature}
`interface Plot`

A plot: x is the data's axis, y the values.

{#plot-x .member}
**`x`**`?:` [`Axis`](#axis) [¶](#plot-x){.headerlink}
: The horizontal axis.

{#plot-y .member}
**`y`**`?:` [`Axis`](#axis) [¶](#plot-y){.headerlink}
: The vertical axis.

(axis)=

### `Axis`

{.signature}
`interface Axis`

A plot axis.

{#axis-label .member}
**`label`**`?: string | null` [¶](#axis-label){.headerlink}
: The axis title.

{#axis-grid .member}
**`grid`**`?: boolean` [¶](#axis-grid){.headerlink}
: Whether grid lines cross the plot at the ticks. Defaults to `true`.

{#axis-hidden .member}
**`hidden`**`?: boolean` [¶](#axis-hidden){.headerlink}
: Whether the axis is hidden. Defaults to `false`.

{#axis-ticks .member}
**`ticks`**`?:` [`Tick`](#tick)`[] | null` [¶](#axis-ticks){.headerlink}
: Tick positions, each a value or `[value, label]`. A tick without a label shows its value. When
  unset, ticks fall at round values.

{#axis-format .member}
**`format`**`?:` [`Format`](#format) [¶](#axis-format){.headerlink}
: How tick values are formatted. Defaults to `auto`.

{#axis-precision .member}
**`precision`**`?: number | null` [¶](#axis-precision){.headerlink}
: Decimal places of fixed values, or of the significand in scientific and engineering formats. At
  most 15. When unset, as many as the tick step needs.

(tick)=

### `Tick`

{.signature}
`type Tick = number | [number, string | null]`

A tick in JSON: a value, or `[value, label]`.

(format)=

### `Format`

{.signature}
`type Format = 'auto' | 'fixed' | 'scientific' | 'engineering'`

How an axis formats its tick values.

{#format-auto .member}
**`'auto'`** [¶](#format-auto){.headerlink}
: Fixed decimals, scientific past a million or below a ten-thousandth.

{#format-fixed .member}
**`'fixed'`** [¶](#format-fixed){.headerlink}
: Fixed decimals: `1500.0`.

{#format-scientific .member}
**`'scientific'`** [¶](#format-scientific){.headerlink}
: A significand and a power of ten: `1.5e3`.

{#format-engineering .member}
**`'engineering'`** [¶](#format-engineering){.headerlink}
: A significand and a power of ten that is a multiple of three: `1.5e3`, `150e-6`.

(grid)=

### `Grid`

{.signature}
`type Grid = 'off' | { lines: { … } } | { dots: { … } }`

A plane's or a diagram's grid: `"off"`, `{ lines: { pitch } }`, or `{ dots: { pitch, snap } }`.

{#grid-off .member}
**`'off'`** [¶](#grid-off){.headerlink}
: No grid.

{#grid-lines .member}
`{` **`lines`**`: { pitch: number } }` [¶](#grid-lines){.headerlink}
: Lines `pitch` units apart, thinned by factors of ten as the view zooms out.

  {#grid-lines-pitch .member}
  **`pitch`**`: number` [¶](#grid-lines-pitch){.headerlink}
  : Units between lines.

{#grid-dots .member}
`{` **`dots`**`: { pitch: number; snap?: boolean } }` [¶](#grid-dots){.headerlink}
: Dots `pitch` units apart. With `snap`, drags in a diagram snap to them.

  {#grid-dots-pitch .member}
  **`pitch`**`: number` [¶](#grid-dots-pitch){.headerlink}
  : Units between dots.

  {#grid-dots-snap .member}
  **`snap`**`?: boolean` [¶](#grid-dots-snap){.headerlink}
  : Whether drag positions snap to the dots, in a diagram. Defaults to `false`.

(controls)=

### `Controls`

{.signature}
`type Controls = 'none' | 'inspect' | { … }`

How a view responds to the pointer and keyboard, and how much it animates on its own: a preset
(`"none"` or `"inspect"`), or options that change the defaults. Each mark sets whether its own
rows pick, select, and drag. These options control the view itself.

{#controls-pan .member}
**`pan`**`?: boolean` [¶](#controls-pan){.headerlink}
: Whether dragging the background pans the camera. Defaults to `true`.

{#controls-zoom .member}
**`zoom`**`?:` [`Zoom`](#zoom) [¶](#controls-zoom){.headerlink}
: Which input zooms the view. `wheel` zooms with the wheel and pinching. `modifier` zooms with
  pinching, and with the wheel only while Control or Meta is held (as trackpad pinches send it),
  so the plain wheel scrolls the page. `off` turns zooming off. Defaults to `wheel`.

{#controls-turn .member}
**`turn`**`?: boolean` [¶](#controls-turn){.headerlink}
: Whether dragging with the secondary button, or with Shift, rotates and tilts a map or plane.
  Defaults to `true`.

{#controls-keyboard .member}
**`keyboard`**`?: boolean` [¶](#controls-keyboard){.headerlink}
: Whether the keyboard controls the view. Defaults to `true`. Tab steps to the row nearest the
  view's center, and the next Tab or Shift+Tab leaves the view, so it is one stop in the page's
  tab order. Arrow keys step to the nearest row in their direction. Enter opens the row stepped
  to, Space selects it, and Escape stops stepping. With no row stepped to, arrow keys pan
  (Shift+arrows turn), `+` and `-` zoom, Home fits everything, and Escape clears the selection.

{#controls-hover .member}
**`hover`**`?: boolean` [¶](#controls-hover){.headerlink}
: Whether the hovered row glows and a hovered vertex sized in CSS pixels grows. Defaults to
  `true`. Hover is tracked either way: a `'hovered'` event still fires and `hovered` still returns
  the row.

{#controls-pickradius .member}
**`pickRadius`**`?: number` [¶](#controls-pickradius){.headerlink}
: How far a row can be from the pointer and still be picked, in CSS pixels. Touch adds 8. Defaults
  to 6.

{#controls-selectbox .member}
**`selectBox`**`?: boolean` [¶](#controls-selectbox){.headerlink}
: Whether Shift+drag selects the rows inside a box instead of turning the camera. Shift+click
  still toggles one row. Defaults to `false`.

{#controls-connect .member}
**`connect`**`?: boolean` [¶](#controls-connect){.headerlink}
: Whether the user can draw connections by dragging from a port, from a vertex with Alt held, or
  an edge's end off its vertex. Connections are reported as a `'connect'` event. Defaults to
  `false`.

{#controls-delete .member}
**`delete`**`?: boolean` [¶](#controls-delete){.headerlink}
: Whether Delete and Backspace report the selection as a `'delete'` event. Defaults to `false`.

{#controls-cycle .member}
**`cycle`**`?: boolean` [¶](#controls-cycle){.headerlink}
: Whether clicking again at the same point, with the camera unmoved, selects the next row under
  the pointer, nearest first. This lets overlapping rows each be selected. Defaults to `false`.

{#controls-press .member}
**`press`**`?: number` [¶](#controls-press){.headerlink}
: How many seconds a touch or pen must hold still to request a menu (a `'menu'` event), like the
  secondary button. 0 turns this off. Defaults to 0.5.

{#controls-motion .member}
**`motion`**`?:` [`Motion`](#motion) [¶](#controls-motion){.headerlink}
: How much the view animates on its own: eases, camera flights, coasting, orbits, comets, and
  options that read `elapsed`. `system` follows the user's reduced-motion setting, `full` animates
  everything, and `reduced` animates only motion the user drives. Defaults to `system`.

(motion)=

### `Motion`

{.signature}
`type Motion = 'system' | 'full' | 'reduced'`

How much a view animates on its own.

{#motion-system .member}
**`'system'`** [¶](#motion-system){.headerlink}
: Follows the system setting: reduced when the user has asked their system for less motion.

{#motion-full .member}
**`'full'`** [¶](#motion-full){.headerlink}
: All motion.

{#motion-reduced .member}
**`'reduced'`** [¶](#motion-reduced){.headerlink}
: Only motion the user drives: changes apply at once, flights jump, nothing coasts or orbits, and
  comets and options that read `elapsed` stay still.

(zoom)=

### `Zoom`

{.signature}
`type Zoom = 'wheel' | 'modifier' | 'off'`

Which input zooms a view.

{#zoom-wheel .member}
**`'wheel'`** [¶](#zoom-wheel){.headerlink}
: The wheel, pinching, and the keys.

{#zoom-modifier .member}
**`'modifier'`** [¶](#zoom-modifier){.headerlink}
: Pinching and the keys, and the wheel only with Control or Meta held (as trackpad pinches send
  it), so the plain wheel scrolls the page.

{#zoom-off .member}
**`'off'`** [¶](#zoom-off){.headerlink}
: No input zooms.

(layout)=

### `Layout`

{.signature}
`type Layout = 'none' | 'stress' | 'layered' | { stress:` [`Stress`](#stress) `} | { layered:` [`Layered`](#layered) `}`

How the view places vertex rows that have no position: a name, or
`{ stress | layered: options }`. In a diagram it places blocks. On a plane or the earth it
places points among the rows they link to. Gaps are in position units: diagram units, plane
units, or degrees on the earth.

A placed row keeps its place. Rows added later are placed around the others, and [`view.arrange`](#view-arrange)
lays out every row again.

{#layout-stress .member}
`{` **`stress`**`:` [`Stress`](#stress) `}` [¶](#layout-stress){.headerlink}
: Drawn distances follow graph distances.

{#layout-layered .member}
`{` **`layered`**`:` [`Layered`](#layered) `}` [¶](#layout-layered){.headerlink}
: Ranks along a direction, for processes and hierarchies.

(layered)=

### `Layered`

{.signature}
`interface Layered`

Layered drawing: vertices in ranks, edges pointing along `direction`, and nets ranked from their
outputs.

{#layered-direction .member}
**`direction`**`?:` [`Direction`](#direction) [¶](#layered-direction){.headerlink}
: The direction edges point. Defaults to `right`.

{#layered-gap .member}
**`gap`**`?: number` [¶](#layered-gap){.headerlink}
: Distance between vertices within a rank, in position units. Defaults to 30.

{#layered-rankgap .member}
**`rankGap`**`?: number` [¶](#layered-rankgap){.headerlink}
: Distance between ranks, in position units. Defaults to 80.

(stress)=

### `Stress`

{.signature}
`interface Stress`

Stress majorization: vertices move until drawn distances match graph distances. Then overlapping
boxes separate, keeping a quarter of `gap` between them.

{#stress-gap .member}
**`gap`**`?: number` [¶](#stress-gap){.headerlink}
: Distance between the centers of linked vertices, in position units. Defaults to 40.

(direction)=

### `Direction`

{.signature}
`type Direction = 'right' | 'left' | 'down' | 'up'`

A direction on screen.

{#direction-right .member}
**`'right'`** [¶](#direction-right){.headerlink}
: Toward the right.

{#direction-left .member}
**`'left'`** [¶](#direction-left){.headerlink}
: Toward the left.

{#direction-down .member}
**`'down'`** [¶](#direction-down){.headerlink}
: Toward the bottom.

{#direction-up .member}
**`'up'`** [¶](#direction-up){.headerlink}
: Toward the top.

(order)=

### `Order`

{.signature}
`type Order = 'ascending' | 'descending'`

Sort direction. Rows where the key has no value sort last in either direction.

{#order-ascending .member}
**`'ascending'`** [¶](#order-ascending){.headerlink}
: Smallest first.

{#order-descending .member}
**`'descending'`** [¶](#order-descending){.headerlink}
: Largest first.

(budget)=

### `Budget`

{.signature}
`interface Budget`

How much GPU memory latkit uses.

{#budget-bytes .member}
**`bytes`**`: number` [¶](#budget-bytes){.headerlink}
: GPU memory in bytes for the data all views of the [`Gpu`](#gpu) draw: its pages and each view's per-row
  state. A table too large for a view's share draws as a paged table, with only the pages the
  camera needs, so it always fits. Pages no view draws stay cached in the rest of the budget, and
  the least recently drawn are evicted first. Defaults to half the device's largest storage
  buffer. The page pool grows as data needs it and never shrinks, so set the budget before drawing
  data.

{#budget-uploadperframe .member}
**`uploadPerFrame`**`: number` [¶](#budget-uploadperframe){.headerlink}
: The most bytes uploaded per frame. Larger data streams in over several frames. Defaults to 32
  MiB.

## Themes

How a scene looks: a group of options for each kind of thing it draws, and the lengths those options take.

(theme)=

### `Theme`

{.signature}
`type Theme = 'dark' | 'light' | { … }`

Default colors and sizes for marks, and the look of text, focus, comets, and each space, grouped
by subject: a base theme's name (`"dark"` or `"light"`), or options that change a base. `base`
names the base and defaults to `dark`. Each option replaces only the base value it sets.

Lengths are in CSS pixels, or units in a diagram. The grid spacing, the text halo, and the focus
glow are always in CSS pixels.

{#theme-background .member}
**`background`**`?:` [`Color`](#color) [¶](#theme-background){.headerlink}
: The background color.

{#theme-grid .member}
**`grid`**`?:` [`Color`](#color) [¶](#theme-grid){.headerlink}
: The color of a plane's or diagram's grid, a plot's grid lines, and the earth's graticule.

{#theme-gridspacing .member}
**`gridSpacing`**`?: number` [¶](#theme-gridspacing){.headerlink}
: The least distance between the lines (or dots) of a plane's or diagram's grid and of the earth's
  graticule, in CSS pixels. Their spacing steps by 1, 2, and 5 times a power of ten (and 30° and
  90° on the earth), and the finer step fades out as it nears this distance.

{#theme-missing .member}
**`missing`**`?:` [`Color`](#color) [¶](#theme-missing){.headerlink}
: The color a colormap gives a missing value, such as a row with no value in the field.

{#theme-dash .member}
**`dash`**`?: number` [¶](#theme-dash){.headerlink}
: The dash period: one dash and one gap of equal length.

{#theme-shading .member}
**`shading`**`?: number` [¶](#theme-shading){.headerlink}
: How much faces darken as they turn away from the camera, from 0 to 1.

{#theme-text .member}
**`text`**`?:` [`TextTheme`](#texttheme) [¶](#theme-text){.headerlink}
: How labels, axis ticks, and titles look.

{#theme-vertex .member}
**`vertex`**`?:` [`VertexTheme`](#vertextheme) [¶](#theme-vertex){.headerlink}
: Defaults for vertices.

{#theme-edge .member}
**`edge`**`?:` [`EdgeTheme`](#edgetheme) [¶](#theme-edge){.headerlink}
: Defaults for edges, and how parallel edges and arrowheads look.

{#theme-line .member}
**`line`**`?:` [`LineTheme`](#linetheme) [¶](#theme-line){.headerlink}
: Defaults for lines.

{#theme-area .member}
**`area`**`?:` [`AreaTheme`](#areatheme) [¶](#theme-area){.headerlink}
: Defaults for areas.

{#theme-focus .member}
**`focus`**`?:` [`FocusTheme`](#focustheme) [¶](#theme-focus){.headerlink}
: How hovered and selected rows glow, and how rows outside a selection dim.

{#theme-flow .member}
**`flow`**`?:` [`FlowTheme`](#flowtheme) [¶](#theme-flow){.headerlink}
: How comets flowing along edges and lines look.

{#theme-diagram .member}
**`diagram`**`?:` [`DiagramTheme`](#diagramtheme) [¶](#theme-diagram){.headerlink}
: How a diagram's blocks, groups, ports, and wires look.

{#theme-earth .member}
**`earth`**`?:` [`EarthTheme`](#earththeme) [¶](#theme-earth){.headerlink}
: How the earth looks.

{#theme-plot .member}
**`plot`**`?:` [`PlotTheme`](#plottheme) [¶](#theme-plot){.headerlink}
: How a plot looks.

{#theme-base .member}
**`base`**`?: 'dark' | 'light'` [¶](#theme-base){.headerlink}
: The theme these options change. Defaults to `dark`.

(texttheme)=

### `TextTheme`

{.signature}
`interface TextTheme`

How labels, axis ticks, and titles look.

{#texttheme-color .member}
**`color`**`?:` [`Color`](#color) [¶](#texttheme-color){.headerlink}
: The text color.

{#texttheme-font .member}
**`font`**`?: string` [¶](#texttheme-font){.headerlink}
: The CSS font family list.

{#texttheme-size .member}
**`size`**`?: number` [¶](#texttheme-size){.headerlink}
: The font size, in the space's unit.

{#texttheme-halo .member}
**`halo`**`?: number` [¶](#texttheme-halo){.headerlink}
: Width of the background-colored halo around label text, in CSS pixels.

(vertextheme)=

### `VertexTheme`

{.signature}
`interface VertexTheme`

Defaults for vertices.

{#vertextheme-color .member}
**`color`**`?:` [`Color`](#color) [¶](#vertextheme-color){.headerlink}
: The vertex color.

{#vertextheme-radius .member}
**`radius`**`?: number` [¶](#vertextheme-radius){.headerlink}
: The vertex radius, in the space's unit.

(edgetheme)=

### `EdgeTheme`

{.signature}
`interface EdgeTheme`

Defaults for edges, and how parallel edges and arrowheads look.

{#edgetheme-color .member}
**`color`**`?:` [`Color`](#color) `| null` [¶](#edgetheme-color){.headerlink}
: The edge color. `null` blends the colors of each edge's two vertices. With `null`, a diagram's
  wires and edges without `ends` (nets and poles) use the text color.

{#edgetheme-width .member}
**`width`**`?: number` [¶](#edgetheme-width){.headerlink}
: The edge width, in the space's unit.

{#edgetheme-spacing .member}
**`spacing`**`?: number` [¶](#edgetheme-spacing){.headerlink}
: In a diagram, the distance between edges joining the same two vertices and between parallel
  orthogonal wires. Wires keep twice this distance from blocks where they can.

{#edgetheme-bow .member}
**`bow`**`?: number` [¶](#edgetheme-bow){.headerlink}
: Outside a diagram, how far edges joining the same two vertices bow apart. Each lane bows out by
  this fraction of the edge's length, measured at its middle. Parallel edges spread at most eight
  lanes wide, and more lanes pack closer. Bows scale with the zoom.

{#edgetheme-arrow .member}
**`arrow`**`?: number` [¶](#edgetheme-arrow){.headerlink}
: How far an arrowhead extends beyond the edge's width. A head's length is this plus the width.

(linetheme)=

### `LineTheme`

{.signature}
`interface LineTheme`

Defaults for lines.

{#linetheme-color .member}
**`color`**`?:` [`Color`](#color) [¶](#linetheme-color){.headerlink}
: The line color.

{#linetheme-width .member}
**`width`**`?: number` [¶](#linetheme-width){.headerlink}
: The line width, in the space's unit.

(areatheme)=

### `AreaTheme`

{.signature}
`interface AreaTheme`

Defaults for areas.

{#areatheme-color .member}
**`color`**`?:` [`Color`](#color) [¶](#areatheme-color){.headerlink}
: The area color.

(flowtheme)=

### `FlowTheme`

{.signature}
`interface FlowTheme`

How comets along edges and lines look. A comet has a round head, brightest at its middle, and a
tail that thins and fades.

`spacing` and `length` must use the same unit, and each row's `flow` speed is in that unit too.
In position units (degrees on the earth), comets scale with the zoom and stay in place along
their lines. In CSS pixels, they keep their size and speed on screen. A plain number is in the
space's unit.

{#flowtheme-color .member}
**`color`**`?:` [`Color`](#color) [¶](#flowtheme-color){.headerlink}
: The comet color. Its alpha sets how strongly a comet covers its stroke. A fully transparent
  color turns comets off.

{#flowtheme-spacing .member}
**`spacing`**`?:` [`Length`](#length) [¶](#flowtheme-spacing){.headerlink}
: The distance between consecutive comets.

{#flowtheme-length .member}
**`length`**`?:` [`Length`](#length) [¶](#flowtheme-length){.headerlink}
: The length of a comet's tail behind its head.

{#flowtheme-width .member}
**`width`**`?: number` [¶](#flowtheme-width){.headerlink}
: The width of a comet's head, in the space's unit. A head is never narrower than its stroke.

(focustheme)=

### `FocusTheme`

{.signature}
`interface FocusTheme`

How hovered and selected rows glow, and how rows outside a selection dim.

{#focustheme-hover .member}
**`hover`**`?:` [`Color`](#color) [¶](#focustheme-hover){.headerlink}
: The glow color around hovered rows.

{#focustheme-selected .member}
**`selected`**`?:` [`Color`](#color) `| null` [¶](#focustheme-selected){.headerlink}
: The glow color around selected rows. `null` uses each row's own color.

{#focustheme-glow .member}
**`glow`**`?: number` [¶](#focustheme-glow){.headerlink}
: How far the hover and selection glows reach, in CSS pixels.

{#focustheme-dim .member}
**`dim`**`?: number` [¶](#focustheme-dim){.headerlink}
: The opacity of rows outside the selection while any row is selected, from 0 to 1.

{#focustheme-grow .member}
**`grow`**`?: number` [¶](#focustheme-grow){.headerlink}
: The scale factor for a hovered vertex sized in CSS pixels. Vertices sized in units only glow.

(diagramtheme)=

### `DiagramTheme`

{.signature}
`interface DiagramTheme`

How a diagram's blocks, groups, ports, and wires look.

{#diagramtheme-group .member}
**`group`**`?:` [`Color`](#color) [¶](#diagramtheme-group){.headerlink}
: The fill color of group containers.

{#diagramtheme-outline .member}
**`outline`**`?:` [`Color`](#color) `| null` [¶](#diagramtheme-outline){.headerlink}
: The color of the one-unit border around blocks and groups. `null` draws no border.

{#diagramtheme-corner .member}
**`corner`**`?: number` [¶](#diagramtheme-corner){.headerlink}
: The corner radius of blocks and groups. A block marker can set its own.

{#diagramtheme-portsize .member}
**`portSize`**`?: number` [¶](#diagramtheme-portsize){.headerlink}
: The width of ports.

{#diagramtheme-bend .member}
**`bend`**`?: number` [¶](#diagramtheme-bend){.headerlink}
: The bend radius of orthogonal wires.

{#diagramtheme-grouppadding .member}
**`groupPadding`**`?: number` [¶](#diagramtheme-grouppadding){.headerlink}
: The space between a group's members and its border.

{#diagramtheme-shadow .member}
**`shadow`**`?:` [`ShadowTheme`](#shadowtheme) [¶](#diagramtheme-shadow){.headerlink}
: How blocks and groups cast shadows on the sheet.

(shadowtheme)=

### `ShadowTheme`

{.signature}
`interface ShadowTheme`

How a diagram's blocks and groups cast shadows on the sheet, for vertex marks with `shadow` on.

{#shadowtheme-color .member}
**`color`**`?:` [`Color`](#color) [¶](#shadowtheme-color){.headerlink}
: The color a shadow darkens toward. Its alpha sets how dark the shadow is under the block.

{#shadowtheme-lift .member}
**`lift`**`?: number` [¶](#shadowtheme-lift){.headerlink}
: How far a shadow falls below its block or group. Its edge softens over the same distance.

(earththeme)=

### `EarthTheme`

{.signature}
`interface EarthTheme`

How the earth looks.

{#earththeme-ground .member}
**`ground`**`?:` [`Color`](#color) [¶](#earththeme-ground){.headerlink}
: The ground color.

{#earththeme-atmosphere .member}
**`atmosphere`**`?:` [`Color`](#color) [¶](#earththeme-atmosphere){.headerlink}
: The color of the air glowing around the globe, when the earth's `atmosphere` is on.

{#earththeme-night .member}
**`night`**`?: number` [¶](#earththeme-night){.headerlink}
: The brightness of the night side when the earth has `daylight`, from 0 to 1.

(plottheme)=

### `PlotTheme`

{.signature}
`interface PlotTheme`

How a plot looks.

{#plottheme-playhead .member}
**`playhead`**`?:` [`Color`](#color) [¶](#plottheme-playhead){.headerlink}
: The color of the line at the view's current axis coordinate.

(length)=

### `Length`

{.signature}
`type Length = number | { px: number } | { units: number }`

A length: a number in CSS pixels, or units in a diagram. `{ px }` is always CSS pixels.
`{ units }` is position units (degrees on the earth), which grow as the view zooms in.

{#length-px .member}
`{` **`px`**`: number }` [¶](#length-px){.headerlink}
: CSS pixels, the same at any zoom.

{#length-units .member}
`{` **`units`**`: number }` [¶](#length-units){.headerlink}
: Position units (degrees on the earth), which grow as the view zooms in.

## Marks

The marks that draw a scene's tables.

(mark)=

### `Mark`

{.signature}
`type Mark =` [`Vertices`](#vertices) `|` [`Edges`](#edges) `|` [`Faces`](#faces) `|` [`Lines`](#lines) `|` [`Areas`](#areas)

One table a scene draws. The mark's kind is the key that holds its table, next to its options:
`{ vertices: [data, table], radius: 4 }`.

(markoptions)=

### `MarkOptions`

{.signature}
`interface MarkOptions`

The options every mark has.

{#markoptions-color .member}
**`color`**`?:` [`ExprInput`](#exprinput) `| null` [¶](#markoptions-color){.headerlink}
: Each row's color: a CSS color, a value through a colormap, or a conditional that picks between
  colors. Defaults to the theme's color for the mark. Faces default to a blend of their corners'
  colors.

{#markoptions-visible .member}
**`visible`**`?:` [`ExprInput`](#exprinput) [¶](#markoptions-visible){.headerlink}
: Whether each row is drawn and can be picked. Defaults to `true`.

{#markoptions-priority .member}
**`priority`**`?:` [`ExprInput`](#exprinput) `| null` [¶](#markoptions-priority){.headerlink}
: Each row's priority. It reads only data, not view state. Higher rows draw on top, keep their
  labels where labels overlap, and are dropped last when a large table is thinned.

{#markoptions-name .member}
**`name`**`?: string | null` [¶](#markoptions-name){.headerlink}
: Distinguishes two marks of the same table across scenes, and names the mark in hits.

{#markoptions-pick .member}
**`pick`**`?: boolean | null` [¶](#markoptions-pick){.headerlink}
: Whether rows respond to hover, clicks, and picks. Defaults to on for vertices, edges, faces, and
  plot traces, and off for geometry: areas, and lines along paths such as coasts, borders, and
  roads.

{#markoptions-select .member}
**`select`**`?: boolean` [¶](#markoptions-select){.headerlink}
: Whether clicking a row selects it. Defaults to `true`.

{#markoptions-drag .member}
**`drag`**`?: boolean` [¶](#markoptions-drag){.headerlink}
: Whether pressing and moving a row drags it instead of panning the camera. Drags are reported as
  a `'drag'` event. Defaults to `false`.

{#markoptions-label .member}
**`label`**`?:` [`Label`](#label) `| null` [¶](#markoptions-label){.headerlink}
: Each row's label: a text field, or label options.

{#markoptions-legend .member}
**`legend`**`?: string | null` [¶](#markoptions-legend){.headerlink}
: A legend of the mark's colors at the view's bottom right, with this title. It shows a ticked
  colormap across its domain, a cell for each category, or a swatch for each name in the
  colormap's `categories`. `color` must map through a colormap with a fixed domain or named
  categories. In a conditional, `otherwise` is searched before the cases.

(strokeoptions)=

### `StrokeOptions`

{.signature}
`interface StrokeOptions`

The options of marks drawn as strokes: edges and lines.

{#strokeoptions-width .member}
**`width`**`?:` [`Size`](#size) `| null` [¶](#strokeoptions-width){.headerlink}
: Each row's width in CSS pixels, or units in a diagram, unless given with `px` or `units`.
  Defaults to the theme's width.

{#strokeoptions-dash .member}
**`dash`**`?:` [`ExprInput`](#exprinput) [¶](#strokeoptions-dash){.headerlink}
: Whether each row is dashed, using the theme's `dash` period. Defaults to `false`.

{#strokeoptions-flow .member}
**`flow`**`?:` [`ExprInput`](#exprinput) [¶](#strokeoptions-flow){.headerlink}
: The speed of comets along each row, per second, in the unit of the theme's `flow` lengths.
  Negative speeds flow backward. 0 draws no comets. Defaults to 0. When the speed changes, comets
  continue from where they are.

(vertices)=

### `Vertices`

{.signature}
`interface Vertices extends` [`MarkOptions`](#markoptions)

Rows drawn as markers: points of a map, nodes of a graph, blocks of a diagram.

{#vertices-vertices .member}
**`vertices`**`:` [`TableInput`](#tableinput) [¶](#vertices-vertices){.headerlink}
: The dataset and table drawn, `[data, table]`.

{#vertices-position .member}
**`position`**`?: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] | null` [¶](#vertices-position){.headerlink}
: Each row's x and y. Rows without a position are placed by the point field `geometry` names. The
  scene's layout places rows that have neither.

{#vertices-geometry .member}
**`geometry`**`?: string | null` [¶](#vertices-geometry){.headerlink}
: The point field that places rows when `position` is not set. Defaults to the field named
  `geometry`.

{#vertices-elevation .member}
**`elevation`**`?:` [`ExprInput`](#exprinput) [¶](#vertices-elevation){.headerlink}
: Height above the ground. On the earth, in degrees of arc like every length there (one is about
  111 km). Defaults to 0. Not allowed in a diagram, which is flat.

{#vertices-radius .member}
**`radius`**`?:` [`Size`](#size) `| null` [¶](#vertices-radius){.headerlink}
: Each row's radius in CSS pixels, or units in a diagram, unless given with `px` or `units`. A
  diagram does not accept `px`. Defaults to the theme's `vertex.radius`.

{#vertices-size .member}
**`size`**`?: [`[`Size`](#size)`,` [`Size`](#size)`] | null` [¶](#vertices-size){.headerlink}
: Each row's width and height, for markers that are not round. In CSS pixels, or units in a
  diagram, unless given with `px` or `units`. A diagram does not accept `px`. In a diagram, a
  block without a size fits its label and ports.

{#vertices-marker .member}
**`marker`**`?:` [`Marker`](#marker) [¶](#vertices-marker){.headerlink}
: How each row is drawn. Defaults to an ellipse.

{#vertices-ring .member}
**`ring`**`?:` [`ExprInput`](#exprinput) `| null` [¶](#vertices-ring){.headerlink}
: A ring around each row's marker in this color. A missing or transparent color draws no ring.

{#vertices-ports .member}
**`ports`**`?: [reference: string, port:` [`Port`](#port)`][]` [¶](#vertices-ports){.headerlink}
: Ports on each row, one for each reference field that names a net. An `edges` mark of the net
  table, without `ends`, draws the nets. Diagrams only.

{#vertices-contains .member}
**`contains`**`?: [table: string, reference: string][]` [¶](#vertices-contains){.headerlink}
: Makes each row a group containing, for each `[table, reference]`, the rows of `table` whose
  `reference` field names it, so a group can hold rows of several tables. A group draws as a
  container around its members, with its label as a title in its header. Diagrams only.

{#vertices-shadow .member}
**`shadow`**`?: boolean` [¶](#vertices-shadow){.headerlink}
: Whether each block or group casts a shadow on the sheet, styled by the theme's `diagram.shadow`.
  Defaults to `false`. Diagrams only.

(edges)=

### `Edges`

{.signature}
`interface Edges extends` [`MarkOptions`](#markoptions)`,` [`StrokeOptions`](#strokeoptions)

Rows drawn as strokes between two vertices named by reference fields: branches, links, wires. In
a diagram, a row without ends is a net. It joins every vertex port whose reference field names
it.

{#edges-edges .member}
**`edges`**`:` [`TableInput`](#tableinput) [¶](#edges-edges){.headerlink}
: The dataset and table drawn, `[data, table]`.

{#edges-ends .member}
**`ends`**`?: [from: string, to: string] | null` [¶](#edges-ends){.headerlink}
: The reference fields naming each row's two vertices.

{#edges-bends .member}
**`bends`**`?: string | null` [¶](#edges-bends){.headerlink}
: A path field whose points each row passes through between its ends.

{#edges-route .member}
**`route`**`?:` [`Route`](#route) `| null` [¶](#edges-route){.headerlink}
: How each row runs between its ends. Defaults to geodesic on the earth and straight elsewhere.
  `orthogonal` routes around blocks with rounded bends, in diagrams only.

{#edges-arrows .member}
**`arrows`**`?: boolean` [¶](#edges-arrows){.headerlink}
: Whether each row has an arrowhead at its second end. A net has one at each input it reaches.
  Defaults to `false`.

{#edges-poles .member}
**`poles`**`?: boolean` [¶](#edges-poles){.headerlink}
: Draws each row as a pole from its own vertex down to the ground, on a plane or the earth. Poles
  take no `ends`, `bends`, or `joins`. Defaults to `false`.

{#edges-joins .member}
**`joins`**`?: [table: string, reference: string] | null` [¶](#edges-joins){.headerlink}
: Draws each row as a net on a plane or the earth. The net joins the vertex rows of `table` whose
  `reference` field names it, as a star from their center to each member.

(lines)=

### `Lines`

{.signature}
`interface Lines extends` [`MarkOptions`](#markoptions)`,` [`StrokeOptions`](#strokeoptions)

Rows drawn as lines along a path field (roads, rivers, borders) or a polygon field's rings (area
outlines). On a plot, each row traces a sampled field's history across the data's axis, like a
monitor. On the earth, paths follow the globe's curve and stay unbroken across the antimeridian.

{#lines-lines .member}
**`lines`**`:` [`TableInput`](#tableinput) [¶](#lines-lines){.headerlink}
: The dataset and table drawn, `[data, table]`.

{#lines-geometry .member}
**`geometry`**`?: string | null` [¶](#lines-geometry){.headerlink}
: The path or polygon field each row runs along. Defaults to the field named `geometry`. Not
  allowed on a plot.

{#lines-trace .member}
**`trace`**`?: string | null` [¶](#lines-trace){.headerlink}
: The sampled field each row traces across the data's axis. Required on a plot, and allowed only
  there. A field with no frames yet draws nothing until its first frame arrives.

{#lines-interpolation .member}
**`interpolation`**`?:` [`Interpolation`](#interpolation) [¶](#lines-interpolation){.headerlink}
: How each row runs between its samples on a plot. Defaults to `linear`.

(areas)=

### `Areas`

{.signature}
`interface Areas extends` [`MarkOptions`](#markoptions)

Rows drawn as the areas of a polygon field: parcels, states, lakes, the land and water of a map.
The view triangulates each row's polygons once, in the background when they are large. On the
earth, areas follow the globe's curve and stay unbroken across the antimeridian. To outline
areas, add a [`Lines`](#lines) mark of the same table. It draws their rings.

{#areas-areas .member}
**`areas`**`:` [`TableInput`](#tableinput) [¶](#areas-areas){.headerlink}
: The dataset and table drawn, `[data, table]`.

{#areas-geometry .member}
**`geometry`**`?: string | null` [¶](#areas-geometry){.headerlink}
: The polygon field each row fills. It holds one polygon's rings or several polygons. Defaults to
  the field named `geometry`.

(faces)=

### `Faces`

{.signature}
`interface Faces extends` [`MarkOptions`](#markoptions)

Rows drawn as triangles between three vertices named by reference fields: meshes, surfaces, and
fields interpolated across a network. Faces are lit from the camera, so a flat mesh seen from
above shows its exact colors.

{#faces-faces .member}
**`faces`**`:` [`TableInput`](#tableinput) [¶](#faces-faces){.headerlink}
: The dataset and table drawn, `[data, table]`.

{#faces-corners .member}
**`corners`**`?: [a: string, b: string, c: string] | null` [¶](#faces-corners){.headerlink}
: The reference fields naming each row's three vertices. Required. Without a color, a face blends
  the colors of its corners.

(marker)=

### `Marker`

{.signature}
`type Marker = 'ellipse' | 'rectangle' | 'rounded' | 'diamond' | 'block' | { shape:` [`Shape`](#shape) `} | { block: { … } } | { gauge: { … } } | { pie: { … } } | { icon: { … } } | { wgsl: { … } }`

How a vertex is drawn: a shape's name, `"block"`, or
`{ shape | block | gauge | pie | icon | wgsl: options }`. Defaults to an ellipse.

{#marker-shape .member}
`{` **`shape`**`:` [`Shape`](#shape) `}` [¶](#marker-shape){.headerlink}
: A filled shape.

{#marker-block .member}
`{` **`block`**`: { corner?: number | null } }` [¶](#marker-block){.headerlink}
: A rectangle with rounded corners that holds its label inside, like a diagram's blocks.

  {#marker-block-corner .member}
  **`corner`**`?: number | null` [¶](#marker-block-corner){.headerlink}
  : Corner radius in CSS pixels, or units in a diagram. Defaults to the theme's `diagram.corner`.

{#marker-gauge .member}
`{` **`gauge`**`: { fill:` [`ExprInput`](#exprinput)`; shape?:` [`Shape`](#shape) `} }` [¶](#marker-gauge){.headerlink}
: A shape's outline, filled to `fill` (0 to 1). A circle fills around its edge, and other shapes
  fill upward.

  {#marker-gauge-fill .member}
  **`fill`**`:` [`ExprInput`](#exprinput) [¶](#marker-gauge-fill){.headerlink}
  : How full each row's gauge is, from 0 to 1.

  {#marker-gauge-shape .member}
  **`shape`**`?:` [`Shape`](#shape) [¶](#marker-gauge-shape){.headerlink}
  : The outline's shape. Defaults to an ellipse.

{#marker-pie .member}
`{` **`pie`**`: { slices:` [`ExprInput`](#exprinput)`[]; colors:` [`Color`](#color)`[]; hole?: number } }` [¶](#marker-pie){.headerlink}
: A circle divided into slices sized in proportion to their values.

  {#marker-pie-slices .member}
  **`slices`**`:` [`ExprInput`](#exprinput)`[]` [¶](#marker-pie-slices){.headerlink}
  : Each slice's value.

  {#marker-pie-colors .member}
  **`colors`**`:` [`Color`](#color)`[]` [¶](#marker-pie-colors){.headerlink}
  : Each slice's color.

  {#marker-pie-hole .member}
  **`hole`**`?: number` [¶](#marker-pie-hole){.headerlink}
  : The hole in the middle, as a fraction of the radius. Defaults to 0.

{#marker-icon .member}
`{` **`icon`**`: { images:` [`Bitmap`](#bitmap)`[]; index:` [`ExprInput`](#exprinput) `} }` [¶](#marker-icon){.headerlink}
: One of `images`, fitted to the marker's box. `index` picks the image for each row.

  {#marker-icon-images .member}
  **`images`**`:` [`Bitmap`](#bitmap)`[]` [¶](#marker-icon-images){.headerlink}
  : The images.

  {#marker-icon-index .member}
  **`index`**`:` [`ExprInput`](#exprinput) [¶](#marker-icon-index){.headerlink}
  : Each row's image index, from 0.

{#marker-wgsl .member}
`{` **`wgsl`**`: { source: string; inputs?:` [`ExprInput`](#exprinput)`[] } }` [¶](#marker-wgsl){.headerlink}
: A custom marker in WGSL. `source` defines `fn marker(f: MarkerFragment) -> MarkerColor`, which
  can read up to eight `inputs` as `f.input[i]`. It compiles once, when the view first draws it.

  {#marker-wgsl-source .member}
  **`source`**`: string` [¶](#marker-wgsl-source){.headerlink}
  : The WGSL source of the `marker` function.

  {#marker-wgsl-inputs .member}
  **`inputs`**`?:` [`ExprInput`](#exprinput)`[]` [¶](#marker-wgsl-inputs){.headerlink}
  : Each row's inputs, at most eight.

(shape)=

### `Shape`

{.signature}
`type Shape = 'ellipse' | 'rectangle' | 'rounded' | 'diamond'`

A marker's outline.

{#shape-ellipse .member}
**`'ellipse'`** [¶](#shape-ellipse){.headerlink}
: An ellipse: a circle when its width and height are equal.

{#shape-rectangle .member}
**`'rectangle'`** [¶](#shape-rectangle){.headerlink}
: A rectangle.

{#shape-rounded .member}
**`'rounded'`** [¶](#shape-rounded){.headerlink}
: A rectangle with rounded corners.

{#shape-diamond .member}
**`'diamond'`** [¶](#shape-diamond){.headerlink}
: A diamond.

(bitmap)=

### `Bitmap`

{.signature}
`interface Bitmap`

An image of RGBA texels: straight alpha, sRGB, rows top to bottom.

{#bitmap-size .member}
**`size`**`: [number, number]` [¶](#bitmap-size){.headerlink}
: Width and height in texels.

{#bitmap-rgba .member}
**`rgba`**`: number[]` [¶](#bitmap-rgba){.headerlink}
: `size[0] * size[1] * 4` bytes.

(port)=

### `Port`

{.signature}
`type Port = 'left' | 'right' | 'top' | 'bottom' | { … }`

A port on one side of a vertex's marker, where a net connects: a side name, or options. The
vertex names the net in a reference field. An output drives its net: layouts rank a net from its
outputs, and the net's arrows point away from them.

{#port-side .member}
**`side`**`:` [`Side`](#side) [¶](#port-side){.headerlink}
: The side of the marker it sits on.

{#port-order .member}
**`order`**`?: number | null` [¶](#port-order){.headerlink}
: Its position among the ports on its side, counted from the top or left. Ports without an `order`
  follow those with one, in declaration order.

{#port-label .member}
**`label`**`?: string | null` [¶](#port-label){.headerlink}
: Its name, drawn beside it inside the marker.

{#port-shape .member}
**`shape`**`?:` [`Shape`](#shape) [¶](#port-shape){.headerlink}
: Its shape. Defaults to an ellipse.

{#port-output .member}
**`output`**`?: boolean` [¶](#port-output){.headerlink}
: Whether it is an output, which drives its net. Defaults to `false` (an input).

(side)=

### `Side`

{.signature}
`type Side = 'left' | 'right' | 'top' | 'bottom'`

A side of a marker.

{#side-left .member}
**`'left'`** [¶](#side-left){.headerlink}
: The left side.

{#side-right .member}
**`'right'`** [¶](#side-right){.headerlink}
: The right side.

{#side-top .member}
**`'top'`** [¶](#side-top){.headerlink}
: The top.

{#side-bottom .member}
**`'bottom'`** [¶](#side-bottom){.headerlink}
: The bottom.

(route)=

### `Route`

{.signature}
`type Route = 'straight' | 'geodesic' | 'orthogonal'`

How an edge runs between its ends.

{#route-straight .member}
**`'straight'`** [¶](#route-straight){.headerlink}
: A straight line on screen.

{#route-geodesic .member}
**`'geodesic'`** [¶](#route-geodesic){.headerlink}
: Along the great circle, on the earth.

{#route-orthogonal .member}
**`'orthogonal'`** [¶](#route-orthogonal){.headerlink}
: Horizontal and vertical runs around vertices that leave and enter at their sides, with rounded
  bends. Diagrams only.

(interpolation)=

### `Interpolation`

{.signature}
`type Interpolation = 'linear' | 'stepBefore' | 'stepAfter'`

How a line runs between its samples.

{#interpolation-linear .member}
**`'linear'`** [¶](#interpolation-linear){.headerlink}
: Straight from each sample to the next.

{#interpolation-stepbefore .member}
**`'stepBefore'`** [¶](#interpolation-stepbefore){.headerlink}
: Each value holds from the previous sample up to its own, so the line steps at the previous
  sample.

{#interpolation-stepafter .member}
**`'stepAfter'`** [¶](#interpolation-stepafter){.headerlink}
: Each value holds until the next sample, where the line steps.

(label)=

### `Label`

{.signature}
`type Label =` [`ExprInput`](#exprinput) `| { … }`

Text for each row, placed beside, inside, or along the row's shape and moving with it: a text
field, or options. A label shows when its row is visible and its text fits, for example inside a
block.

Labels beside or along their rows never overlap. Where they would, the row drawn on top keeps
its label (so `priority` decides), and a dense view labels as many rows as fit. A row whose text
is missing or empty has no label, so a `when` that returns the field or missing labels only some
rows. In a diagram, a label scales with the zoom, fades out when too small to read, and shows
wherever it fits its vertex.

{#label-text .member}
**`text`**`:` [`ExprInput`](#exprinput) [¶](#label-text){.headerlink}
: The text field to show, or a `when` that returns that field or missing. A row whose text is
  missing or empty has no label. In a diagram, the text may read only data, since the sheet sizes
  blocks around it.

{#label-size .member}
**`size`**`?: number | null` [¶](#label-size){.headerlink}
: Font size in CSS pixels, or diagram units in a diagram. Defaults to the theme's `text.size`.

{#label-color .member}
**`color`**`?:` [`ExprInput`](#exprinput) `| null` [¶](#label-color){.headerlink}
: Each row's text color. Defaults to the theme's text color.

{#label-maxwidth .member}
**`maxWidth`**`?: number | null` [¶](#label-maxwidth){.headerlink}
: The width at which lines wrap, in CSS pixels, or diagram units in a diagram.

{#label-font .member}
**`font`**`?: string | null` [¶](#label-font){.headerlink}
: The CSS font family list for the text. Defaults to the theme's `text.font`.

(size)=

### `Size`

{.signature}
`type Size =` [`ExprInput`](#exprinput) `|` [`Px`](#px) `|` [`Units`](#units)

A size: a value in CSS pixels, or units in a diagram. `{ px }` is always CSS pixels. `{ units }`
is position units (degrees on the earth), which grow as the view zooms in.

(px)=

### `Px`

{.signature}
`interface Px`

A size in CSS pixels, regardless of the space's unit.

{#px-px .member}
**`px`**`:` [`ExprInput`](#exprinput) [¶](#px-px){.headerlink}
: The size, in CSS pixels.

(units)=

### `Units`

{.signature}
`interface Units`

A size in position units (degrees on the earth), regardless of the space's unit. It scales with
the zoom. `atLeast` and `atMost` bound it in CSS pixels.

{#units-units .member}
**`units`**`:` [`ExprInput`](#exprinput) [¶](#units-units){.headerlink}
: The size, in position units.

{#units-atleast .member}
**`atLeast`**`?: number | null` [¶](#units-atleast){.headerlink}
: The minimum on-screen size in CSS pixels, however far the view zooms out.

{#units-atmost .member}
**`atMost`**`?: number | null` [¶](#units-atmost){.headerlink}
: The maximum on-screen size in CSS pixels, however far the view zooms in.

## Expressions

Expressions as JSON: a number, a boolean, `null`, a field as `"$name"`, a CSS color, or one of these nodes.

(exprnode)=

### `ExprNode`

{.signature}
`type ExprNode = number | boolean | null | string |` [`FieldNode`](#fieldnode) `|` [`StateNode`](#statenode) `|` [`WhenNode`](#whennode) `|` [`ScaleNode`](#scalenode) `|` [`ColormapNode`](#colormapnode) `|` [`CallNode`](#callnode)

A value for each row. A number or boolean is a constant and `null` is missing. A string starting
with `$` reads that field, and any other string is a CSS color. An object computes a value.

{#exprnode-null .member}
**`null`** [¶](#exprnode-null){.headerlink}
: A missing value. An option that is missing uses the theme's value.

(fieldnode)=

### `FieldNode`

{.signature}
`interface FieldNode`

A field's value in each row, from the mark's own table. With `from`, it reads another dataset's
table, joined by row id. `"$name"` is the short form of `{ "field": "name" }`.

{#fieldnode-field .member}
**`field`**`: string` [¶](#fieldnode-field){.headerlink}
: The field's name.

{#fieldnode-from .member}
**`from`**`?:` [`TableInput`](#tableinput) `| null` [¶](#fieldnode-from){.headerlink}
: The dataset and table the field is read from, joined by row id.

{#fieldnode-step .member}
**`step`**`?: boolean` [¶](#fieldnode-step){.headerlink}
: For a sampled field, reads the last frame at or before the shown coordinate instead of
  interpolating. Defaults to `false`.

(statenode)=

### `StateNode`

{.signature}
`interface StateNode`

View state of each row, such as whether it is selected.

{#statenode-state .member}
**`state`**`:` [`State`](#state) [¶](#statenode-state){.headerlink}
: The state read.

(callnode)=

### `CallNode`

{.signature}
`type CallNode = { neg: [`[`ExprInput`](#exprinput)`] } | { not: [`[`ExprInput`](#exprinput)`] } | { abs: [`[`ExprInput`](#exprinput)`] } | { sqrt: [`[`ExprInput`](#exprinput)`] } | { sin: [`[`ExprInput`](#exprinput)`] } | { cos: [`[`ExprInput`](#exprinput)`] } | { floor: [`[`ExprInput`](#exprinput)`] } | { ln: [`[`ExprInput`](#exprinput)`] } | { exp: [`[`ExprInput`](#exprinput)`] } | { add: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { sub: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { mul: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { div: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { rem: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { pow: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { min: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { max: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { lt: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { le: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { gt: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { ge: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { eq: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { ne: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { and: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { or: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] } | { is: [field:` [`ExprInput`](#exprinput)`, text: string] } | { contains: [field:` [`ExprInput`](#exprinput)`, text: string] }`

An operation, written as an object with one key: the operation's name, holding its arguments.
For example `{ "add": ["$a", 1] }`. The second argument of `is` and `contains` is plain text,
not a field or a color.

{#callnode-neg .member}
`{` **`neg`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-neg){.headerlink}
: The value negated.

{#callnode-not .member}
`{` **`not`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-not){.headerlink}
: 1 where the value is at most 0.5, else 0.

{#callnode-abs .member}
`{` **`abs`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-abs){.headerlink}
: The absolute value.

{#callnode-sqrt .member}
`{` **`sqrt`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-sqrt){.headerlink}
: The square root. Negative values give a missing value.

{#callnode-sin .member}
`{` **`sin`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-sin){.headerlink}
: The sine of the value, an angle in radians.

{#callnode-cos .member}
`{` **`cos`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-cos){.headerlink}
: The cosine of the value, an angle in radians.

{#callnode-floor .member}
`{` **`floor`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-floor){.headerlink}
: The largest whole number at most the value.

{#callnode-ln .member}
`{` **`ln`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-ln){.headerlink}
: The natural logarithm. Values at most 0 give a missing value.

{#callnode-exp .member}
`{` **`exp`**`: [`[`ExprInput`](#exprinput)`] }` [¶](#callnode-exp){.headerlink}
: e raised to the value.

{#callnode-add .member}
`{` **`add`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-add){.headerlink}
: The sum of the two values.

{#callnode-sub .member}
`{` **`sub`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-sub){.headerlink}
: The first value minus the second.

{#callnode-mul .member}
`{` **`mul`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-mul){.headerlink}
: The product of the two values.

{#callnode-div .member}
`{` **`div`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-div){.headerlink}
: The first value divided by the second. Dividing by 0 gives a missing value.

{#callnode-rem .member}
`{` **`rem`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-rem){.headerlink}
: The remainder of the first value divided by the second, with the sign of the second: -1 and 3
  give 2.

{#callnode-pow .member}
`{` **`pow`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-pow){.headerlink}
: The first value raised to the power of the second.

{#callnode-min .member}
`{` **`min`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-min){.headerlink}
: The smaller of the two values.

{#callnode-max .member}
`{` **`max`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-max){.headerlink}
: The larger of the two values.

{#callnode-lt .member}
`{` **`lt`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-lt){.headerlink}
: 1 where the first value is less than the second, else 0.

{#callnode-le .member}
`{` **`le`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-le){.headerlink}
: 1 where the first value is at most the second, else 0.

{#callnode-gt .member}
`{` **`gt`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-gt){.headerlink}
: 1 where the first value is greater than the second, else 0.

{#callnode-ge .member}
`{` **`ge`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-ge){.headerlink}
: 1 where the first value is at least the second, else 0.

{#callnode-eq .member}
`{` **`eq`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-eq){.headerlink}
: 1 where the two values are equal, else 0. Colors compare too.

{#callnode-ne .member}
`{` **`ne`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-ne){.headerlink}
: 1 where the two values differ, else 0. Colors compare too.

{#callnode-and .member}
`{` **`and`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-and){.headerlink}
: 1 where both values are above 0.5, else 0.

{#callnode-or .member}
`{` **`or`**`: [`[`ExprInput`](#exprinput)`,` [`ExprInput`](#exprinput)`] }` [¶](#callnode-or){.headerlink}
: 1 where either value is above 0.5, else 0.

{#callnode-is .member}
`{` **`is`**`: [field:` [`ExprInput`](#exprinput)`, text: string] }` [¶](#callnode-is){.headerlink}
: Whether a text field equals the plain text exactly.

{#callnode-contains .member}
`{` **`contains`**`: [field:` [`ExprInput`](#exprinput)`, text: string] }` [¶](#callnode-contains){.headerlink}
: Whether a text field contains the plain text, ignoring case. In a mark, the field must belong to
  the mark's own table.

(whennode)=

### `WhenNode`

{.signature}
`interface WhenNode`

The value of the first case whose condition holds, else `otherwise`.

{#whennode-when .member}
**`when`**`: [condition:` [`ExprInput`](#exprinput)`, value:` [`ExprInput`](#exprinput)`][]` [¶](#whennode-when){.headerlink}
: The cases, as `[condition, value]` pairs tried in order.

{#whennode-otherwise .member}
**`otherwise`**`:` [`ExprInput`](#exprinput) [¶](#whennode-otherwise){.headerlink}
: The value where no condition holds.

(scalenode)=

### `ScaleNode`

{.signature}
`interface ScaleNode`

A value mapped linearly onto a range, clamped to the range.

{#scalenode-scale .member}
**`scale`**`: [low: number, high: number]` [¶](#scalenode-scale){.headerlink}
: The range.

{#scalenode-value .member}
**`value`**`:` [`ExprInput`](#exprinput) [¶](#scalenode-value){.headerlink}
: The value mapped.

{#scalenode-domain .member}
**`domain`**`?: [low: number, high: number] | null` [¶](#scalenode-domain){.headerlink}
: The values mapped to the range's ends. Defaults to the extent of the values shown.

(colormapnode)=

### `ColormapNode`

{.signature}
`interface ColormapNode`

A value mapped through a colormap.

{#colormapnode-colormap .member}
**`colormap`**`:` [`Colormap`](#colormap) [¶](#colormapnode-colormap){.headerlink}
: The colormap.

{#colormapnode-value .member}
**`value`**`:` [`ExprInput`](#exprinput) [¶](#colormapnode-value){.headerlink}
: The value mapped. A categorical map takes each value's integer part as its category.

{#colormapnode-domain .member}
**`domain`**`?: [low: number, high: number] | null` [¶](#colormapnode-domain){.headerlink}
: The values mapped to the colormap's ends. Defaults to the extent of the values shown. A
  categorical map ignores it.

(state)=

### `State`

{.signature}
`type State = 'selected' | 'hovered' | 'pointer' | 'elapsed' | 'zoom'`

View state of each row: `selected`, `hovered`, `pointer` (CSS pixels from a vertex to the
pointer), `elapsed` (seconds since the view was created), or `zoom` (the camera's zoom).

(colormap)=

### `Colormap`

{.signature}
`type Colormap =` [`ColormapName`](#colormapname) `|` [`CustomColormap`](#customcolormap)

Colors for a range of values: a catalog name, or your own colors.

(colormapname)=

### `ColormapName`

{.signature}
`type ColormapName = 'amber' | 'amp' | 'batlow' | 'cividis' | 'crest' | 'deep' | 'devon' | 'flare' | 'grays' | 'haline' | 'inferno' | 'lajolla' | 'magma' | 'mako' | 'oslo' | 'plasma' | 'rocket' | 'thermal' | 'turku' | 'viridis' | 'balance' | 'berlin' | 'brbg' | 'broc' | 'coolwarm' | 'cork' | 'icefire' | 'managua' | 'piyg' | 'puor' | 'rdbu' | 'spectral' | 'vanimo' | 'vik' | 'vlag' | 'phase' | 'romao' | 'twilight' | 'dark2' | 'okabeito' | 'paired' | 'set2' | 'tab10' | 'tab20' | 'tableau10' | 'turbo'`

A colormap from the catalog.

(colormapkind)=

### `ColormapKind`

{.signature}
`type ColormapKind = 'sequential' | 'diverging' | 'cyclic' | 'categorical'`

How a colormap maps values: `sequential` and `diverging` maps clamp, `cyclic` maps wrap, and
`categorical` maps give each integer its own color.

{#colormapkind-sequential .member}
**`'sequential'`** [¶](#colormapkind-sequential){.headerlink}
: Low to high.

{#colormapkind-diverging .member}
**`'diverging'`** [¶](#colormapkind-diverging){.headerlink}
: Below and above a midpoint.

{#colormapkind-cyclic .member}
**`'cyclic'`** [¶](#colormapkind-cyclic){.headerlink}
: Around a circle: values wrap.

{#colormapkind-categorical .member}
**`'categorical'`** [¶](#colormapkind-categorical){.headerlink}
: Distinct colors for distinct integers.

(customcolormap)=

### `CustomColormap`

{.signature}
`interface CustomColormap`

A custom colormap: its kind, its colors, and for a categorical map, its category names.

{#customcolormap-kind .member}
**`kind`**`:` [`ColormapKind`](#colormapkind) [¶](#customcolormap-kind){.headerlink}
: How the colors map values.

{#customcolormap-colors .member}
**`colors`**`: (`[`Color`](#color) `| [number,` [`Color`](#color)`])[]` [¶](#customcolormap-colors){.headerlink}
: The colors, blended in OKLab. Each is a color, spaced evenly between its neighbors like a CSS
  gradient, or a `[place, color]` pair with a place from 0 to 1. Places must ascend. A categorical
  map takes one color per category, without places, at most 256.

{#customcolormap-categories .member}
**`categories`**`?: string[]` [¶](#customcolormap-categories){.headerlink}
: The category names in category order, shown in legends. Categorical maps only.

## Rows, cameras, and queries

Identifying rows, framing them, and querying them.

(id)=

### `Id`

{.signature}
`type Id = number | string`

A row's id: a whole number from 0, or a text. A number above 2^53 - 1 is written as its decimal
text, which names the same row.

(ids)=

### `Ids`

{.signature}
`type Ids = (`[`Id`](#id) `| null)[] | { count: number }`

Row ids: a list of numbers or texts, or `{count}` for rows 0 to count - 1. In a reference, null
names no row.

{#ids-count .member}
`{` **`count`**`: number }` [¶](#ids-count){.headerlink}
: The number of rows, whose ids are 0 to count - 1.

(row)=

### `Row`

{.signature}
`interface Row`

One row, identified by dataset name, table name, and id. It stays valid across any change that
keeps those names and the id.

{#row-data .member}
**`data`**`: string` [¶](#row-data){.headerlink}
: The dataset's name.

{#row-table .member}
**`table`**`: string` [¶](#row-table){.headerlink}
: The table's name.

{#row-id .member}
**`id`**`:` [`Id`](#id) [¶](#row-id){.headerlink}
: The row's id in the table.

(rows)=

### `Rows`

{.signature}
`interface Rows`

Rows of one table in a dataset, by id. Views use it for selections, fits, and the rows events
report.

{#rows-data .member}
**`data`**`: string` [¶](#rows-data){.headerlink}
: The dataset's name.

{#rows-table .member}
**`table`**`: string` [¶](#rows-table){.headerlink}
: The table's name.

{#rows-ids .member}
**`ids`**`:` [`Id`](#id)`[]` [¶](#rows-ids){.headerlink}
: The rows' ids in the table.

(camera)=

### `Camera`

{.signature}
`type Camera = { … } | { x: [number, number]; y?: [number, number] | null }`

Where a view looks.

A camera over the earth, a plane, or a diagram: the point it looks at and turns about, its zoom,
its tilt, and its rotation. A diagram is always seen from straight above, upright.

{#camera-center .member}
**`center`**`: [number, number] | [number, number, number]` [¶](#camera-center){.headerlink}
: On the earth, longitude, latitude, and elevation, all in degrees (a degree of elevation is a
  degree of arc, about 111 km). On a plane or a diagram, x, y, and elevation. In JSON, `[x, y]` is
  shorthand for elevation 0.

{#camera-zoom .member}
**`zoom`**`: number` [¶](#camera-zoom){.headerlink}
: The web mercator zoom level on the earth. Elsewhere, log₂ of CSS pixels per unit.

{#camera-pitch .member}
**`pitch`**`: number` [¶](#camera-pitch){.headerlink}
: Tilt in degrees from looking straight down, up to 75. Ignored in a diagram.

{#camera-bearing .member}
**`bearing`**`: number` [¶](#camera-bearing){.headerlink}
: Degrees clockwise from north, or from up on a plane. Ignored in a diagram.

A plot camera: the x range shown, and the value range, or `null` to fit the values in view.

{#camera-x .member}
**`x`**`: [number, number]` [¶](#camera-x){.headerlink}
: The x-axis range shown.

{#camera-y .member}
**`y`**`?: [number, number] | null` [¶](#camera-y){.headerlink}
: The value range shown, or `null` to fit the values in view.

(fit)=

### `Fit`

{.signature}
`type Fit = 'all' | { rows:` [`Rows`](#rows)`[] } | { reveal:` [`Row`](#row) `} | { bounds: { … } }`

The target of a view's fit.

{#fit-all .member}
**`'all'`** [¶](#fit-all){.headerlink}
: Everything drawn.

{#fit-rows .member}
`{` **`rows`**`:` [`Rows`](#rows)`[] }` [¶](#fit-rows){.headerlink}
: These rows.

{#fit-reveal .member}
`{` **`reveal`**`:` [`Row`](#row) `}` [¶](#fit-reveal){.headerlink}
: Brings this row into view, keeping the zoom.

{#fit-bounds .member}
`{` **`bounds`**`: { min: [number, number, number]; max: [number, number, number] } }` [¶](#fit-bounds){.headerlink}
: The box from `min` to `max`: x, y, and elevation.

  {#fit-bounds-min .member}
  **`min`**`: [number, number, number]` [¶](#fit-bounds-min){.headerlink}
  : The minimum corner.

  {#fit-bounds-max .member}
  **`max`**`: [number, number, number]` [¶](#fit-bounds-max){.headerlink}
  : The maximum corner.

(query)=

### `Query`

{.signature}
`interface Query`

The rows of a table to read back, run through the expressions marks draw with.

{#query-of .member}
**`of`**`: string` [¶](#query-of){.headerlink}
: The table to read.

{#query-ids .member}
**`ids`**`?:` [`Ids`](#ids) `| null` [¶](#query-ids){.headerlink}
: The rows to read, in this order unless sorted. Defaults to every row. Ids that name no row are
  skipped.

{#query-filter .member}
**`filter`**`?:` [`ExprInput`](#exprinput) `| null` [¶](#query-filter){.headerlink}
: Keeps only the rows for which this is true.

{#query-sort .member}
**`sort`**`?: [`[`ExprInput`](#exprinput)`,` [`Order`](#order)`][]` [¶](#query-sort){.headerlink}
: Keys to sort by. Each key breaks ties left by the keys before it. Rows where a key has no value
  sort last, and rows equal on every key keep their order.

{#query-offset .member}
**`offset`**`?: number` [¶](#query-offset){.headerlink}
: How many of the kept rows to skip.

{#query-limit .member}
**`limit`**`?: number | null` [¶](#query-limit){.headerlink}
: The most rows to return. When sorting with a limit, the first `offset + limit` rows are selected
  in linear time and only those are sorted.

{#query-select .member}
**`select`**`?: { [name: string]:` [`ExprInput`](#exprinput) `} | null` [¶](#query-select){.headerlink}
: Fields to return, by output name. A plain field returns that field as stored, and any other
  expression returns numbers. Defaults to every field. An empty object returns the ids alone.

{#query-at .member}
**`at`**`?: number | null` [¶](#query-at){.headerlink}
: The axis coordinate at which sampled fields are read. Defaults to their last frame.

(enveloperequest)=

### `EnvelopeRequest`

{.signature}
`interface EnvelopeRequest`

A request for each row's least and greatest value of a sampled field over equal spans of the
axis. It reads field `field` of table `table` over `spans` equal spans from `range[0]` to
`range[1]`, for every row or for the rows in `ids`, in that order. Like a query, it is plain
data that deserializes from JSON.

{#enveloperequest-table .member}
**`table`**`: string` [¶](#enveloperequest-table){.headerlink}
: The table to read.

{#enveloperequest-field .member}
**`field`**`: string` [¶](#enveloperequest-field){.headerlink}
: The sampled field to read.

{#enveloperequest-range .member}
**`range`**`: [number, number]` [¶](#enveloperequest-range){.headerlink}
: The axis range the spans cover, `[first, last]`. Both are finite, with `first <= last`.

{#enveloperequest-spans .member}
**`spans`**`: number` [¶](#enveloperequest-spans){.headerlink}
: The number of equal spans to divide the range into. At least 1.

{#enveloperequest-ids .member}
**`ids`**`?:` [`Ids`](#ids) `| null` [¶](#enveloperequest-ids){.headerlink}
: The rows to read, in this order. Defaults to every row.

## Results

View events and hits, dataset descriptions and values, and frame statistics.

(viewevent)=

### `ViewEvent`

{.signature}
`type ViewEvent = { type: 'click'; detail: { … } } | { type: 'open'; detail: { … } } | { type: 'menu'; detail: { … } } | { type: 'drag'; detail: { … } } | { type: 'connect'; detail: { … } } | { type: 'delete'; detail: { … } } | { type: 'hovered'; detail: { … } } | { type: 'selection'; detail: { … } } | { type: 'camera'; detail:` [`Camera`](#camera) `} | { type: 'waiting'; detail:` [`Waiting`](#waiting) `} | { type: 'error'; detail:` [`Failure`](#failure) `}`

Something that happened in a view, as [`view.on`](#view-on) reports it.

{#viewevent-click .member}
**`'click'`** [¶](#viewevent-click){.headerlink}
: A row was clicked.

  {#viewevent-click-hit .member}
  **`hit`**`:` [`Hit`](#hit) [¶](#viewevent-click-hit){.headerlink}
  : The row.

  {#viewevent-click-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) [¶](#viewevent-click-trigger){.headerlink}
  : How the user clicked it.

{#viewevent-open .member}
**`'open'`** [¶](#viewevent-open){.headerlink}
: A row was double-clicked, or Enter was pressed on the row the keyboard points at.

  {#viewevent-open-hit .member}
  **`hit`**`:` [`Hit`](#hit) [¶](#viewevent-open-hit){.headerlink}
  : The row.

  {#viewevent-open-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) [¶](#viewevent-open-trigger){.headerlink}
  : How the user opened it.

{#viewevent-menu .member}
**`'menu'`** [¶](#viewevent-menu){.headerlink}
: A context menu was requested: by a secondary click (or a Control-click on Apple platforms), the
  menu key or Shift+F10, or a touch or pen held still. Lists the rows under the trigger's point,
  for a menu of actions on them.

  {#viewevent-menu-hits .member}
  **`hits`**`:` [`Hit`](#hit)`[]` [¶](#viewevent-menu-hits){.headerlink}
  : The rows under the point, nearest first.

  {#viewevent-menu-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) [¶](#viewevent-menu-trigger){.headerlink}
  : How the user asked.

{#viewevent-drag .member}
**`'drag'`** [¶](#viewevent-drag){.headerlink}
: A row of a draggable mark is dragged. The drag starts once the pointer moves more than 4 CSS
  pixels from where it pressed the row.

  {#viewevent-drag-phase .member}
  **`phase`**`:` [`Phase`](#phase) [¶](#viewevent-drag-phase){.headerlink}
  : Whether the drag starts, moves, or ends.

  {#viewevent-drag-hit .member}
  **`hit`**`:` [`Hit`](#hit) [¶](#viewevent-drag-hit){.headerlink}
  : The row dragged, as it was hit.

  {#viewevent-drag-position .member}
  **`position`**`: [number, number, number]` [¶](#viewevent-drag-position){.headerlink}
  : The row's new position in the space's coordinates. It is the hit point moved with the pointer
    since the press, at the depth where the drag started, so a vertex keeps its offset from the
    pointer. Snapped to a diagram's grid dots when the grid snaps.

  {#viewevent-drag-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) [¶](#viewevent-drag-trigger){.headerlink}
  : The pointer.

{#viewevent-connect .member}
**`'connect'`** [¶](#viewevent-connect){.headerlink}
: A connection was drawn with [`controls.connect`](#controls-connect) on: from a port, from a vertex with Alt held, or
  by dragging an edge's end off it.

  {#viewevent-connect-from .member}
  **`from`**`:` [`End`](#end) [¶](#viewevent-connect-from){.headerlink}
  : The end it was drawn from. For a dragged edge end, the edge's other end.

  {#viewevent-connect-to .member}
  **`to`**`:` [`End`](#end) `| null` [¶](#viewevent-connect-to){.headerlink}
  : The vertex it was released over, if any.

  {#viewevent-connect-edge .member}
  **`edge`**`:` [`Row`](#row) `| null` [¶](#viewevent-connect-edge){.headerlink}
  : The edge whose end was dragged off. `to` replaces that end.

  {#viewevent-connect-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) [¶](#viewevent-connect-trigger){.headerlink}
  : Where it was released.

{#viewevent-delete .member}
**`'delete'`** [¶](#viewevent-delete){.headerlink}
: Delete or Backspace was pressed with rows selected and [`controls.delete`](#controls-delete) on.

  {#viewevent-delete-rows .member}
  **`rows`**`:` [`Rows`](#rows)`[]` [¶](#viewevent-delete-rows){.headerlink}
  : The rows selected.

  {#viewevent-delete-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) [¶](#viewevent-delete-trigger){.headerlink}
  : The key.

{#viewevent-hovered .member}
**`'hovered'`** [¶](#viewevent-hovered){.headerlink}
: The hovered row changed: [`view.hovered`](#view-hovered).

  {#viewevent-hovered-hit .member}
  **`hit`**`:` [`Hit`](#hit) `| null` [¶](#viewevent-hovered-hit){.headerlink}
  : The row now hovered, or `null` if no row is.

  {#viewevent-hovered-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) [¶](#viewevent-hovered-trigger){.headerlink}
  : The pointer, or the keys.

{#viewevent-selection .member}
**`'selection'`** [¶](#viewevent-selection){.headerlink}
: The selection changed: [`view.selection`](#view-selection).

  {#viewevent-selection-rows .member}
  **`rows`**`:` [`Rows`](#rows)`[]` [¶](#viewevent-selection-rows){.headerlink}
  : The rows selected now.

  {#viewevent-selection-trigger .member}
  **`trigger`**`:` [`Trigger`](#trigger) `| null` [¶](#viewevent-selection-trigger){.headerlink}
  : How the user changed it, or `null` when the data dropped rows from it.

{#viewevent-camera .member}
**`'camera'`**`:` [`Camera`](#camera) [¶](#viewevent-camera){.headerlink}
: The camera moved: [`view.camera`](#view-camera). A gesture, fit, flight, coast, or orbit moved it, or it moved
  back within its zoom and pan limits after the view's size, insets, or space changed.

{#viewevent-waiting .member}
**`'waiting'`**`:` [`Waiting`](#waiting) [¶](#viewevent-waiting){.headerlink}
: The work the last frame waited on changed: [`view.waiting`](#view-waiting). Empty once frames are complete.

{#viewevent-error .member}
**`'error'`**`:` [`Failure`](#failure) [¶](#viewevent-error){.headerlink}
: Something failed. Reported once. A mark that no longer fits its data is also listed in
  [`view.failures`](#view-failures).

(hit)=

### `Hit`

{.signature}
`interface Hit`

A row under a point, as the frame drew it.

{#hit-row .member}
**`row`**`:` [`Row`](#row) [¶](#hit-row){.headerlink}
: The row.

{#hit-mark .member}
**`mark`**`?: string` [¶](#hit-mark){.headerlink}
: The name of the mark that drew it, if the mark has one. It tells apart two marks of one table.

{#hit-point .member}
**`point`**`: [number, number]` [¶](#hit-point){.headerlink}
: The row's point nearest the probe, in CSS pixels from the top left: a vertex's or port's middle,
  or the nearest point of a stroke or triangle.

{#hit-position .member}
**`position`**`: [number, number, number]` [¶](#hit-position){.headerlink}
: That point in the space's coordinates: x, y, and elevation.

{#hit-distance .member}
**`distance`**`: number` [¶](#hit-distance){.headerlink}
: CSS pixels from the probe to the row.

{#hit-port .member}
**`port`**`?: string` [¶](#hit-port){.headerlink}
: The port hit, if the hit is on a vertex's port.

{#hit-sample .member}
**`sample`**`?:` [`Sample`](#sample) [¶](#hit-sample){.headerlink}
: The sample hit, if the hit is on a line tracing a sampled field.

(end)=

### `End`

{.signature}
`interface End`

A vertex a connection ends at, and the port the connection meets, if any.

{#end-row .member}
**`row`**`:` [`Row`](#row) [¶](#end-row){.headerlink}
: The vertex.

{#end-port .member}
**`port`**`?: string` [¶](#end-port){.headerlink}
: The port, by the reference field naming its net.

(failure)=

### `Failure`

{.signature}
`interface Failure`

A failure as JSON, in the same form as the npm package's [`LatkitError`](#latkiterror).

{#failure-code .member}
**`code`**`: 'invalid' | 'unsupported' | 'limit' | 'io' | 'device-lost' | 'cancelled' | 'timeout'` [¶](#failure-code){.headerlink}
: The kind of failure. See [`LatkitError.code`](#latkiterror-code).

{#failure-message .member}
**`message`**`: string` [¶](#failure-message){.headerlink}
: A description of what failed.

{#failure-path .member}
**`path`**`?: string` [¶](#failure-path){.headerlink}
: For `invalid` failures, the path of the invalid input, such as `marks[2].color`.

(phase)=

### `Phase`

{.signature}
`type Phase = 'start' | 'move' | 'end'`

The phase of a `Drag`.

{#phase-start .member}
**`'start'`** [¶](#phase-start){.headerlink}
: The pointer moved far enough to drag.

{#phase-move .member}
**`'move'`** [¶](#phase-move){.headerlink}
: The pointer moved.

{#phase-end .member}
**`'end'`** [¶](#phase-end){.headerlink}
: The pointer was released, or the drag was cancelled.

(trigger)=

### `Trigger`

{.signature}
`interface Trigger`

Where the user acted, with which modifier keys and device. For keyboard input, the point is the
row the keys point at, or else the pointer, or else the view's middle.

{#trigger-point .member}
**`point`**`: [number, number]` [¶](#trigger-point){.headerlink}
: CSS pixels from the top left.

{#trigger-modifiers .member}
**`modifiers`**`:` [`Modifiers`](#modifiers) [¶](#trigger-modifiers){.headerlink}
: The modifier keys held.

{#trigger-device .member}
**`device`**`:` [`Device`](#device) [¶](#trigger-device){.headerlink}
: The device used.

(device)=

### `Device`

{.signature}
`type Device = 'mouse' | 'pen' | 'touch' | 'keyboard'`

The input device.

{#device-mouse .member}
**`'mouse'`** [¶](#device-mouse){.headerlink}
: A mouse or a trackpad.

{#device-pen .member}
**`'pen'`** [¶](#device-pen){.headerlink}
: A pen.

{#device-touch .member}
**`'touch'`** [¶](#device-touch){.headerlink}
: A finger. Picks find rows up to 8 CSS pixels farther away.

{#device-keyboard .member}
**`'keyboard'`** [¶](#device-keyboard){.headerlink}
: The keyboard.

(modifiers)=

### `Modifiers`

{.signature}
`interface Modifiers`

Modifier keys held during an input.

{#modifiers-shift .member}
**`shift`**`: boolean` [¶](#modifiers-shift){.headerlink}
: Shift.

{#modifiers-control .member}
**`control`**`: boolean` [¶](#modifiers-control){.headerlink}
: Control.

{#modifiers-alt .member}
**`alt`**`: boolean` [¶](#modifiers-alt){.headerlink}
: Alt or Option.

{#modifiers-meta .member}
**`meta`**`: boolean` [¶](#modifiers-meta){.headerlink}
: Meta: Command or Windows.

(description)=

### `Description`

{.signature}
`interface Description`

A summary of a dataset: its tables with their rows and fields, the axis sampled fields are
recorded over, and the part of the axis they cover.

{#description-name .member}
**`name`**`: string` [¶](#description-name){.headerlink}
: The dataset's name.

{#description-axis .member}
**`axis`**`: [string, string] | null` [¶](#description-axis){.headerlink}
: The axis name and unit, if set.

{#description-span .member}
**`span`**`: [number, number] | null` [¶](#description-span){.headerlink}
: The first and last axis coordinates held by any sampled field, or `null` if no field holds any.

{#description-tables .member}
**`tables`**`:` [`TableDescription`](#tabledescription)`[]` [¶](#description-tables){.headerlink}
: Its tables, sorted by name.

(tabledescription)=

### `TableDescription`

{.signature}
`interface TableDescription`

A summary of one table: its row count and its fields, sorted by name.

{#tabledescription-name .member}
**`name`**`: string` [¶](#tabledescription-name){.headerlink}
: The table's name.

{#tabledescription-rows .member}
**`rows`**`: number` [¶](#tabledescription-rows){.headerlink}
: The number of rows.

{#tabledescription-fields .member}
**`fields`**`:` [`FieldDescription`](#fielddescription)`[]` [¶](#tabledescription-fields){.headerlink}
: Its fields, sorted by name.

(fielddescription)=

### `FieldDescription`

{.signature}
`interface FieldDescription`

A summary of one field: its kind, plus its target table or axis span where those apply.

{#fielddescription-name .member}
**`name`**`: string` [¶](#fielddescription-name){.headerlink}
: The field's name.

{#fielddescription-kind .member}
**`kind`**`:` [`Kind`](#kind) [¶](#fielddescription-kind){.headerlink}
: The kind of values it holds.

{#fielddescription-to .member}
**`to`**`?: string` [¶](#fielddescription-to){.headerlink}
: For a reference, the target table.

{#fielddescription-span .member}
**`span`**`?: [number, number]` [¶](#fielddescription-span){.headerlink}
: For a sampled field, the first and last axis coordinates it holds.

(kind)=

### `Kind`

{.signature}
`type Kind = 'number' | 'bool' | 'text' | 'point' | 'path' | 'parts' | 'polygons' | 'reference' | 'sampled'`

The kind of values a field holds.

{#kind-number .member}
**`'number'`** [¶](#kind-number){.headerlink}
: Numbers.

{#kind-bool .member}
**`'bool'`** [¶](#kind-bool){.headerlink}
: Booleans.

{#kind-text .member}
**`'text'`** [¶](#kind-text){.headerlink}
: Texts.

{#kind-point .member}
**`'point'`** [¶](#kind-point){.headerlink}
: `[x, y]` points.

{#kind-path .member}
**`'path'`** [¶](#kind-path){.headerlink}
: Paths of points.

{#kind-parts .member}
**`'parts'`** [¶](#kind-parts){.headerlink}
: Parts: the rings of a polygon, or the paths of a multi-path.

{#kind-polygons .member}
**`'polygons'`** [¶](#kind-polygons){.headerlink}
: Polygons of rings.

{#kind-reference .member}
**`'reference'`** [¶](#kind-reference){.headerlink}
: Rows of another table, by id.

{#kind-sampled .member}
**`'sampled'`** [¶](#kind-sampled){.headerlink}
: Numbers sampled over the dataset's axis.

(value)=

### `Value`

{.signature}
`type Value = number | boolean | string | null | [number, number] | unknown[][]`

A value read from a dataset: a number (`null` when not finite), boolean, or text; a geometry as
nested `[x, y]` points; a reference as the id of the row it names.

(sample)=

### `Sample`

{.signature}
`interface Sample`

A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value.

{#sample-frame .member}
**`frame`**`:` [`Id`](#id) [¶](#sample-frame){.headerlink}
: The frame, numbered from the first ever recorded. JSON uses a decimal string above 2^53 - 1.

{#sample-at .member}
**`at`**`: number` [¶](#sample-at){.headerlink}
: The axis coordinate.

{#sample-value .member}
**`value`**`: number` [¶](#sample-value){.headerlink}
: The value.

(stats)=

### `Stats`

{.signature}
`interface Stats`

Counters describing a view's frames.

{#stats-frames .member}
**`frames`**`: number` [¶](#stats-frames){.headerlink}
: Frames rendered.

{#stats-rows .member}
**`rows`**`: number` [¶](#stats-rows){.headerlink}
: Rows of every mark's table.

{#stats-drawn .member}
**`drawn`**`: number` [¶](#stats-drawn){.headerlink}
: Rows the marks draw: every row of a fully drawn table, and the rows in the tiles in view of a
  paged table.

{#stats-draws .member}
**`draws`**`: number` [¶](#stats-draws){.headerlink}
: Draw calls the last frame recorded, label draws included.

{#stats-instances .member}
**`instances`**`: number` [¶](#stats-instances){.headerlink}
: Instances the last frame's draws drew: points, segments, triangles, and glyphs. An upper bound
  for segments, which the GPU may cull.

{#stats-tiles .member}
**`tiles`**`: number` [¶](#stats-tiles){.headerlink}
: Fetched tiles the view draws, across all tile sources.

{#stats-tilesloading .member}
**`tilesLoading`**`: number` [¶](#stats-tilesloading){.headerlink}
: Tiles being fetched or decoded, across all tile sources.

{#stats-cpums .member}
**`cpuMs`**`: number` [¶](#stats-cpums){.headerlink}
: Milliseconds the last frame took to record on the CPU.

{#stats-gpums .member}
**`gpuMs`**`: number` [¶](#stats-gpums){.headerlink}
: Milliseconds the GPU takes per frame: the median of recently measured frames. 0 if the device
  cannot measure GPU time.

(waiting)=

### `Waiting`

{.signature}
`type Waiting = ('compiling' | 'data' | 'derived' | 'labels' | 'fit' | 'marks')[]`

What a frame still waits on: pipelines the scene draws with, which compile before the view draws
anything new (`compiling`); pages uploading, or tables not yet built from them (`data`);
layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); label texts being read back, or
not yet set (`labels`); a fit due or being measured (`fit`); segment counts, or a transition
starting (`marks`). Empty once the frame is complete.

(work)=

### `Work`

{.signature}
`interface Work`

Counts of the work a [`Gpu`](#gpu) has done since it was created. Subtract two snapshots to get the work
between them.

{#work-uploaded .member}
**`uploaded`**`: number` [¶](#work-uploaded){.headerlink}
: Bytes of data pages uploaded.

{#work-uploads .member}
**`uploads`**`: number` [¶](#work-uploads){.headerlink}
: Data pages, or pieces of pages, uploaded. A change's uploads count pages here and bytes in
  `uploaded`.

{#work-written .member}
**`written`**`: number` [¶](#work-written){.headerlink}
: Bytes written other than pages: uniforms, programs, label runs, the selection, and textures.

{#work-evaluated .member}
**`evaluated`**`: number` [¶](#work-evaluated){.headerlink}
: Rows whose channels the GPU evaluated.

{#work-resolved .member}
**`resolved`**`: number` [¶](#work-resolved){.headerlink}
: Edge and face rows whose endpoints the GPU resolved to resident vertex rows. These are rows that
  changed, plus every row of a page that references a vertex now resident elsewhere.

{#work-cleared .member}
**`cleared`**`: number` [¶](#work-cleared){.headerlink}
: Bytes of per-row word pages the GPU cleared: pages read before anything writes them, and the
  normals that faces sum from scratch.

{#work-packed .member}
**`packed`**`: number` [¶](#work-packed){.headerlink}
: Rows packed into pages of a paged table's draw order. Each page is packed once, the first time a
  view draws it, and again only when a write changes its rows.

{#work-readbacks .member}
**`readbacks`**`: number` [¶](#work-readbacks){.headerlink}
: Readbacks from the GPU: probes, queries, fits, label texts, segment counts, and pictures. Frame
  timer readbacks, which only some devices support, are not counted.

{#work-jobs .member}
**`jobs`**`: number` [¶](#work-jobs){.headerlink}
: Jobs started: layouts, routes, lanes, triangulations, pyramids, and tiles. They run on the
  host's workers, or immediately without a host.

{#work-texts .member}
**`texts`**`: number` [¶](#work-texts){.headerlink}
: Label texts the host was asked to rasterize.

{#work-pipelines .member}
**`pipelines`**`: number` [¶](#work-pipelines){.headerlink}
: Pipelines compiled. In a browser, each compiles in the background when a view or shot requests
  it ahead of use. Natively, each compiles when first created.

{#work-late .member}
**`late`**`: number` [¶](#work-late){.headerlink}
: Pipelines not requested ahead of use, compiled when first used. In a browser they compile on the
  GPU's thread and delay frames. Zero unless a scene uses a pipeline it did not request.
