//! Scenes from serde data, mirroring the builders field for field, in camelCase:
//!
//! ```json
//! {
//!   "space": "globe",
//!   "marks": [
//!     { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"], "flow": { "op": "div", "args": ["p", 20] } } },
//!     { "vertices": { "of": ["grid", "Bus"], "position": ["lon", "lat"], "color": { "colormap": "vm", "map": "balance", "domain": [0.95, 1.05] }, "legend": "Bus voltage · pu" } }
//!   ],
//!   "layout": { "layered": { "flow": "right" } },
//!   "theme": { "base": "light", "vertexRadius": 5 },
//!   "ease": 0.3,
//!   "title": "Voltage"
//! }
//! ```
//!
//! Each type reads a form below, whose documentation is the format's: `latkit schema scene` prints
//! it, and npm's scene types are written from it.

use std::time::Duration;

use schemars::JsonSchema;
use serde::Deserialize;
use serde::de;

use super::{
    Areas, Axis, Controls, Diagram, Direction, Earth, Edges, Faces, Format, Grid, Interpolation, Label, Layered,
    Layout, Lines, Mark, Marker, Motion, Plane, Plot, Port, Projection, Route, Scene, Shape, Side, Space, Stress,
    Theme, Vertices, Zoom,
};
use crate::schema::{from_form, named};
use crate::{Color, Expr, Image, Name, Size};

from_form! {
    Scene => SceneForm,
    Space => SpaceForm,
    Grid => GridForm,
    Axis => AxisForm,
    Label => LabelForm,
    Mark => MarkForm,
    Controls => ControlsForm,
    Marker => MarkerForm,
    Layout => LayoutForm,
    Port => PortForm,
    Theme => ThemeForm,
}

/// What a view draws and how it answers input.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneForm {
    space: Space,
    #[serde(default)]
    marks: Vec<Mark>,
    /// How the view places vertex rows without positions: a diagram's blocks, or points on a plane
    /// or the earth, gaps in the space's units.
    layout: Option<Layout>,
    theme: Option<Theme>,
    controls: Option<Controls>,
    /// Seconds that changes ease over.
    ease: Option<f64>,
    /// Written at the view's top left, larger than the theme's text.
    title: Option<String>,
    /// Written under the title.
    subtitle: Option<String>,
}

impl SceneForm {
    fn build<E: de::Error>(self) -> Result<Scene, E> {
        let mut scene = Scene::new(self.space).layout(self.layout.unwrap_or_default());
        if let Some(title) = self.title {
            scene = scene.title(title);
        }
        if let Some(subtitle) = self.subtitle {
            scene = scene.subtitle(subtitle);
        }
        if let Some(controls) = self.controls {
            scene = scene.controls(controls);
        }
        if let Some(theme) = self.theme {
            scene = scene.theme(theme);
        }
        if let Some(ease) = self.ease {
            let ease =
                Duration::try_from_secs_f64(ease).map_err(|_| E::custom("ease is nonnegative seconds within range"))?;
            scene = scene.ease(ease);
        }
        Ok(self.marks.into_iter().fold(scene, Scene::draw))
    }
}

/// The coordinate space positions are in. A diagram is a flat sheet seen from straight above: y runs
/// down, and every length is a unit, a CSS pixel at zoom 0, except glow, halo, and pick radius. Only a
/// diagram has ports, groups, nets, orthogonal routes, and layouts.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a space: a name, or { plane | diagram | earth | plot: options }")]
enum SpaceForm {
    Name(#[schemars(with = "SpaceName")] String),
    Tagged(SpaceTagged),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
enum SpaceName {
    Plane,
    Diagram,
    Earth,
    Mercator,
    Globe,
    Plot,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
enum SpaceTagged {
    Plane(PlaneForm),
    Diagram(PlaneForm),
    Earth(EarthForm),
    Plot(PlotForm),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct EarthForm {
    projection: Option<Projection>,
    surface: Option<Color>,
    graticule: Option<bool>,
    /// Lit by the sun as it stands this many seconds after the Unix epoch, plus the view's axis
    /// coordinate: night falls on the ground and what stands on it. Unlit unless set.
    daylight: Option<f64>,
    /// Air glowing around the globe, in the theme's atmosphere color.
    atmosphere: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct PlaneForm {
    grid: Option<Grid>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct PlotForm {
    x: Option<Axis>,
    y: Option<Axis>,
}

impl SpaceForm {
    fn build<E: de::Error>(self) -> Result<Space, E> {
        Ok(match self {
            SpaceForm::Name(name) => match named(&name)? {
                SpaceName::Plane => Space::Plane(Plane::default()),
                SpaceName::Diagram => Space::Diagram(Diagram::default()),
                SpaceName::Earth | SpaceName::Mercator => Space::Earth(Earth::mercator()),
                SpaceName::Globe => Space::Earth(Earth::globe()),
                SpaceName::Plot => Space::Plot(Plot::default()),
            },
            SpaceForm::Tagged(SpaceTagged::Earth(e)) => Space::Earth(Earth {
                projection: e.projection.unwrap_or_default(),
                surface: e.surface,
                graticule: e.graticule.unwrap_or(true),
                daylight: e.daylight,
                atmosphere: e.atmosphere.unwrap_or(false),
            }),
            SpaceForm::Tagged(SpaceTagged::Plane(p)) => {
                Space::Plane(Plane { grid: p.grid.unwrap_or(Plane::default().grid) })
            }
            SpaceForm::Tagged(SpaceTagged::Diagram(d)) => {
                Space::Diagram(Diagram { grid: d.grid.unwrap_or(Diagram::default().grid) })
            }
            SpaceForm::Tagged(SpaceTagged::Plot(p)) => {
                Space::Plot(Plot { x: p.x.unwrap_or_default(), y: p.y.unwrap_or_default() })
            }
        })
    }
}

/// A plane's or a diagram's grid: lines or dots `pitch` units apart; drags snap to dots when `snap`.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a grid: \"off\", { lines: pitch }, or { dots: pitch, snap }")]
enum GridForm {
    Off(#[schemars(with = "GridOff")] String),
    Lines(GridLines),
    Dots(GridDots),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
enum GridOff {
    Off,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
struct GridLines {
    lines: f64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
struct GridDots {
    dots: f64,
    snap: Option<bool>,
}

impl GridForm {
    fn build<E: de::Error>(self) -> Result<Grid, E> {
        Ok(match self {
            GridForm::Off(off) => match named(&off)? {
                GridOff::Off => Grid::Off,
            },
            GridForm::Lines(l) => Grid::Lines { pitch: l.lines },
            GridForm::Dots(d) => Grid::Dots { pitch: d.dots, snap: d.snap.unwrap_or(false) },
        })
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AxisForm {
    label: Option<String>,
    grid: Option<bool>,
    hidden: Option<bool>,
    /// Ticks at these values, with these labels or their values written; round values unless given.
    ticks: Option<Vec<Tick>>,
    /// How tick values are written: `auto` (fixed, scientific when very large or small).
    format: Option<Format>,
    /// Decimals of fixed values, or of the significand otherwise; as many as the ticks need unless set.
    precision: Option<u8>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a tick: a value, or [value, label]")]
#[schemars(inline)]
enum Tick {
    At(f64),
    Labeled(f64, Option<String>),
}

impl AxisForm {
    #[allow(clippy::unnecessary_wraps, reason = "every form builds through a Result")]
    fn build<E: de::Error>(self) -> Result<Axis, E> {
        let ticks = self.ticks.map(|ticks| {
            ticks
                .into_iter()
                .map(|t| match t {
                    Tick::At(v) => (v, None),
                    Tick::Labeled(v, text) => (v, text),
                })
                .collect()
        });
        Ok(Axis {
            label: self.label,
            grid: self.grid.unwrap_or(true),
            hidden: self.hidden.unwrap_or(false),
            ticks,
            format: self.format.unwrap_or_default(),
            precision: self.precision,
        })
    }
}

/// A mark's form: `of`, the options given, then the options every mark has.
macro_rules! mark_form {
    ($(#[$meta:meta])* $form:ident as $name:literal { $($(#[$doc:meta])* $field:ident: $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(rename = $name)]
        struct $form {
            /// The dataset and table drawn.
            #[schemars(extend("tsType" = "[data: string, table: string]"))]
            of: (Name, Name),
            $(
                $(#[$doc])*
                $field: Option<$ty>,
            )*
            color: Option<Expr>,
            visible: Option<Expr>,
            /// Each row's priority, from its data alone: what matters more draws on top, stays drawn as
            /// a table too large to draw whole thins to the tiles in view, and is labeled first.
            priority: Option<Expr>,
            /// Tells two marks of one table apart across scenes.
            name: Option<Name>,
            /// Whether rows are hovered, clicked, and probed; on by default.
            pick: Option<bool>,
            /// Whether a click selects a row; on by default.
            select: Option<bool>,
            /// Whether pressing a row drags it instead of panning; off by default.
            drag: Option<bool>,
            /// Each row's text: a text field, or a label's options.
            label: Option<Label>,
            /// Whether each row casts a shadow onto the ground and onto faces, away from the theme's
            /// light.
            shadow: Option<bool>,
            /// A legend of the colors at the view's bottom right, under this title: the colormap
            /// across its domain, ticked; a cell for each category; or a swatch beside each name of a
            /// map's `categories`. The color maps through a colormap with a domain or named
            /// categories; a conditional's `otherwise` is read before its cases.
            legend: Option<String>,
        }
    };
}

/// Applies each option of `form` given, by the builder method of its name.
macro_rules! apply {
    ($form:ident, $mark:expr; $($field:ident),* $(,)?) => {{
        let mut mark = $mark;
        $(
            if let Some(value) = $form.$field {
                mark = mark.$field(value);
            }
        )*
        mark
    }};
}

/// Applies the options every mark has.
macro_rules! style {
    ($form:ident, $mark:expr) => {{
        let mark = apply!($form, $mark; color, visible, priority, pick, select, drag, label, shadow, legend);
        match $form.name {
            Some(name) => mark.named(name),
            None => mark,
        }
    }};
}

/// A row's text, placed beside, inside, or along what its mark draws; overlapping labels give way by
/// priority, and among equals those already shown keep their place. In a diagram a label scales with
/// the zoom and fades out once too small to read.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a label: a text field, or { text, size, color, priority, maxWidth }")]
enum LabelForm {
    Text(Expr),
    Full(Box<LabelFull>),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct LabelFull {
    /// A text field.
    text: Expr,
    /// CSS pixels, or units in a diagram; the theme's font size unless set.
    size: Option<f32>,
    color: Option<Expr>,
    /// Where labels would overlap, the higher shows; the mark's priority unless set.
    priority: Option<Expr>,
    /// How far a line runs before it wraps: CSS pixels, or units in a diagram.
    max_width: Option<f32>,
    /// The CSS font family list its texts are set in; the theme's font unless set.
    font: Option<String>,
    /// The most labels shown at once, those of highest priority among the rows in view; where they
    /// would overlap, fewer.
    max: Option<u32>,
}

impl LabelForm {
    #[allow(clippy::unnecessary_wraps, reason = "every form builds through a Result")]
    fn build<E: de::Error>(self) -> Result<Label, E> {
        let form = match self {
            LabelForm::Text(text) => return Ok(Label::new(text)),
            LabelForm::Full(form) => form,
        };
        let mut label = Label::new(form.text);
        if let Some(size) = form.size {
            label = label.size(size);
        }
        if let Some(color) = form.color {
            label = label.color(color);
        }
        if let Some(priority) = form.priority {
            label = label.priority(priority);
        }
        if let Some(width) = form.max_width {
            label = label.max_width(width);
        }
        if let Some(font) = form.font {
            label = label.font(font);
        }
        if let Some(max) = form.max {
            label = label.max(max);
        }
        Ok(label)
    }
}

/// What a scene draws: rows of a table as vertices, edges, faces, lines, or areas.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
enum MarkForm {
    Vertices(VerticesForm),
    Edges(EdgesForm),
    Faces(FacesForm),
    Lines(LinesForm),
    Areas(AreasForm),
}

impl MarkForm {
    #[allow(clippy::unnecessary_wraps, reason = "every form builds through a Result")]
    fn build<E: de::Error>(self) -> Result<Mark, E> {
        Ok(match self {
            MarkForm::Vertices(v) => Mark::Vertices(v.build()),
            MarkForm::Edges(e) => Mark::Edges(e.build()),
            MarkForm::Faces(f) => Mark::Faces(f.build()),
            MarkForm::Lines(l) => Mark::Lines(l.build()),
            MarkForm::Areas(a) => Mark::Areas(a.build()),
        })
    }
}

mark_form!(
    /// Rows drawn as markers where they stand.
    VerticesForm as "Vertices" {
        /// Without one, a point field named `geometry` places rows; rows without either the scene's
        /// layout places.
        position: (Expr, Expr),
        /// Height above the ground; not in a diagram, which is flat.
        elevation: Expr,
        /// CSS pixels, or position units with `units`; units in a diagram.
        radius: Size,
        /// Width and height: CSS pixels, or position units with `units`; units in a diagram, where a
        /// block without a size fits its label and ports.
        size: (Size, Size),
        marker: Marker,
        /// A ring around each row's marker in this color.
        status: Expr,
        /// A port on each row for each reference field naming a net, which an `edges` mark of the net
        /// table without ends draws. Diagrams only.
        #[schemars(extend("tsType" = "[reference: string, port: Port][]"))]
        ports: Vec<(Name, Port)>,
        /// Makes each row a group: it holds the rows of `table` whose reference field names it, and is
        /// drawn as a container around them, its label a title in its header. Diagrams only.
        #[schemars(extend("tsType" = "[table: string, reference: string]"))]
        contains: (Name, Name),
    }
);

impl VerticesForm {
    fn build(self) -> Vertices {
        let mut v = apply!(self, Vertices::of(self.of.0, self.of.1); elevation, radius, marker, status);
        if let Some((x, y)) = self.position {
            v = v.position(x, y);
        }
        if let Some((w, h)) = self.size {
            v = v.size(w, h);
        }
        for (reference, port) in self.ports.unwrap_or_default() {
            v = v.port(reference, port);
        }
        if let Some((table, reference)) = self.contains {
            v = v.contains(table, reference);
        }
        style!(self, v)
    }
}

mark_form!(
    /// Rows drawn as strokes between the vertices two reference fields name; without ends, each row is
    /// a net joining every vertex port whose reference field names it.
    EdgesForm as "Edges" {
        #[schemars(extend("tsType" = "[from: string, to: string]"))]
        ends: (Name, Name),
        /// CSS pixels, or position units with `units`; units in a diagram.
        width: Size,
        dash: Expr,
        /// Comets flowing along each row at this speed a second: CSS pixels, units in a diagram, or
        /// position units where the theme's flow is in units; negative flows backward. A speed that
        /// changes carries comets on from where they are.
        flow: Expr,
        /// A path field of points each row runs through between its ends.
        bends: Name,
        /// How each row runs between its ends; on the earth geodesic, elsewhere straight, unless set.
        /// Orthogonal routes run around blocks, bends rounded; diagrams only.
        route: Route,
        /// Whether each row ends in an arrowhead at its second end; a net's at each input it reaches.
        arrows: bool,
        /// Draws each row as a pole from its own vertex down to the ground beneath it, on a plane or
        /// the earth; it has no ends.
        poles: bool,
        /// Draws each row as a net on a plane or the earth: it joins the vertex rows of `table` whose
        /// reference field names it, as a star from their middle to each.
        #[schemars(extend("tsType" = "[table: string, reference: string]"))]
        joins: (Name, Name),
    }
);

impl EdgesForm {
    fn build(self) -> Edges {
        let mut e = apply!(self, Edges::of(self.of.0, self.of.1); width, dash, flow, bends, route, arrows);
        if self.poles == Some(true) {
            e = e.poles();
        }
        if let Some((table, reference)) = self.joins {
            e = e.joins(table, reference);
        }
        if let Some((from, to)) = self.ends {
            e = e.ends(from, to);
        }
        style!(self, e)
    }
}

mark_form!(
    /// Triangles between three vertices; without a color, each blends its corners' colors.
    FacesForm as "Faces" {
        #[schemars(extend("tsType" = "[a: string, b: string, c: string]"))]
        corners: (Name, Name, Name),
    }
);

impl FacesForm {
    fn build(self) -> Faces {
        let mut f = Faces::of(self.of.0, self.of.1);
        if let Some((a, b, c)) = self.corners {
            f = f.corners(a, b, c);
        }
        style!(self, f)
    }
}

mark_form!(
    /// Rows drawn as lines along the field each traces: a path or polygon field (rings outline their
    /// areas), or on a plot a sampled field's history. On the earth a line's path bends with the globe.
    LinesForm as "Lines" {
        /// The field each row traces: a path or polygon field, or on a plot a sampled field.
        /// `geometry` unless set.
        trace: Name,
        /// CSS pixels, or position units with `units`; units in a diagram.
        width: Size,
        dash: Expr,
        /// Comets flowing along each row at this speed a second, as an edge's flow.
        flow: Expr,
        /// How each row runs between its samples, on a plot.
        interpolation: Interpolation,
    }
);

impl LinesForm {
    fn build(self) -> Lines {
        let l = apply!(self, Lines::of(self.of.0, self.of.1); trace, width, dash, flow, interpolation);
        style!(self, l)
    }
}

mark_form!(
    /// Rows drawn as the areas a polygon field covers, cut into triangles off the frame when large; on
    /// the earth they bend with the globe. Outline them with a `lines` mark of the same table.
    AreasForm as "Areas" {
        /// The polygon field each row fills: one polygon's rings, or polygons. `geometry` unless set.
        rings: Name,
    }
);

impl AreasForm {
    fn build(self) -> Areas {
        let a = apply!(self, Areas::of(self.of.0, self.of.1); rings);
        style!(self, a)
    }
}

/// How a view answers the pointer and keyboard, and how much it moves on its own: a preset, or
/// options over the defaults.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "controls: \"none\", \"inspect\", or options")]
enum ControlsForm {
    Name(#[schemars(with = "ControlsName")] String),
    Full(ControlsFull),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
enum ControlsName {
    /// Answers nothing: a still picture, its camera where the application puts it.
    None,
    /// Rows glow, select, and step with the keys; the camera stays where the application puts it.
    Inspect,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct ControlsFull {
    /// Dragging the background moves the camera; on unless set.
    pan: Option<bool>,
    /// What zooms: `wheel` (and pinching and the keys, unless set), `modifier` (the wheel only with
    /// Control or Meta held, as a trackpad's pinch sends it, so the plain wheel scrolls the page), or
    /// `off`.
    zoom: Option<Zoom>,
    /// Dragging with the secondary button, or with Shift, turns and tilts a map or plane; a diagram
    /// never turns. On unless set.
    turn: Option<bool>,
    /// Tab steps through rows and arrows to the nearest row their way, Enter opens and Space selects
    /// it; otherwise arrows pan, `+` and `-` zoom, Home fits, and Escape clears the selection. On
    /// unless set.
    keyboard: Option<bool>,
    /// Rows under the pointer glow; on unless set.
    hover: Option<bool>,
    /// CSS pixels around the pointer that picks reach, 6 unless set; touch reaches 8 more.
    pick_radius: Option<f32>,
    /// Dragging the background with Shift selects the rows in a box, instead of turning. Off unless
    /// set.
    select_box: Option<bool>,
    /// Dragging from a port, from a vertex with Alt, or an edge off its end draws a connection, told
    /// as a `connect` event. Off unless set.
    connect: Option<bool>,
    /// Delete and Backspace tell a `delete` event with the selection. Off unless set.
    delete: Option<bool>,
    /// Clicking again where nothing moved selects the next row under the point, nearest first, so
    /// rows drawn over one another can each be selected. Off unless set.
    cycle: Option<bool>,
    /// Seconds a touch or a pen held still asks for a menu, 0.5 unless set; 0 never does.
    press: Option<f64>,
    /// How much the view moves on its own: `system` (as the user's system asks, unless set), `full`,
    /// or `reduced` (changes apply at once, flights jump, nothing coasts or orbits, labels show
    /// without fading, and comets and what reads `elapsed()` hold still).
    motion: Option<Motion>,
}

impl ControlsForm {
    fn build<E: de::Error>(self) -> Result<Controls, E> {
        let form = match self {
            ControlsForm::Name(name) => {
                return Ok(match named(&name)? {
                    ControlsName::None => Controls::none(),
                    ControlsName::Inspect => Controls::inspect(),
                });
            }
            ControlsForm::Full(form) => form,
        };
        let d = Controls::default();
        let press = match form.press {
            Some(seconds) => Duration::try_from_secs_f64(seconds)
                .map_err(|_| E::custom("press is nonnegative seconds within range"))?,
            None => d.press,
        };
        Ok(Controls {
            pan: form.pan.unwrap_or(d.pan),
            zoom: form.zoom.unwrap_or(d.zoom),
            turn: form.turn.unwrap_or(d.turn),
            keyboard: form.keyboard.unwrap_or(d.keyboard),
            hover: form.hover.unwrap_or(d.hover),
            pick_radius: form.pick_radius.unwrap_or(d.pick_radius),
            select_box: form.select_box.unwrap_or(d.select_box),
            connect: form.connect.unwrap_or(d.connect),
            delete: form.delete.unwrap_or(d.delete),
            cycle: form.cycle.unwrap_or(d.cycle),
            press,
            motion: form.motion.unwrap_or(d.motion),
        })
    }
}

/// How a vertex is drawn: a shape, a block, or a marker of its own.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a marker: a shape's name, \"block\", or { block | gauge | pie | icon | wgsl: options }")]
enum MarkerForm {
    Name(#[schemars(with = "MarkerName")] String),
    Tagged(MarkerTagged),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
enum MarkerName {
    Disc,
    Ellipse,
    Rectangle,
    Rounded,
    Diamond,
    Block,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
enum MarkerTagged {
    Block(BlockForm),
    /// A shape's outline filled to `fill`, from 0 to 1.
    Gauge(GaugeForm),
    /// A circle cut into slices as large as their values.
    Pie(PieForm),
    /// One of `images` per row, by `index`; npm's `icon` writes it from `ImageData`.
    Icon(IconForm),
    /// WGSL defining `fn marker(f: MarkerFragment) -> MarkerColor`, reading `inputs` as `f.input[i]`.
    Wgsl(WgslForm),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct BlockForm {
    /// Corner radius, CSS pixels; 4 unless set.
    corner: Option<f32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct GaugeForm {
    fill: Expr,
    shape: Option<Shape>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct PieForm {
    slices: Vec<Expr>,
    colors: Vec<Color>,
    hole: Option<f32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct IconForm {
    images: Vec<ImageForm>,
    index: Expr,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct ImageForm {
    size: [u32; 2],
    rgba: Vec<u8>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct WgslForm {
    source: String,
    #[serde(default)]
    inputs: Vec<Expr>,
}

impl MarkerForm {
    fn build<E: de::Error>(self) -> Result<Marker, E> {
        Ok(match self {
            MarkerForm::Name(name) => match named(&name)? {
                MarkerName::Disc | MarkerName::Ellipse => Marker::Shape(Shape::Ellipse),
                MarkerName::Rectangle => Marker::Shape(Shape::Rectangle),
                MarkerName::Rounded => Marker::Shape(Shape::Rounded),
                MarkerName::Diamond => Marker::Shape(Shape::Diamond),
                MarkerName::Block => Marker::block(),
            },
            MarkerForm::Tagged(MarkerTagged::Block(b)) => Marker::Block { corner: b.corner.unwrap_or(4.0) },
            MarkerForm::Tagged(MarkerTagged::Gauge(g)) => {
                Marker::Gauge { fill: g.fill, shape: g.shape.unwrap_or_default() }
            }
            MarkerForm::Tagged(MarkerTagged::Pie(p)) => {
                Marker::Pie { slices: p.slices, colors: p.colors, hole: p.hole.unwrap_or(0.0) }
            }
            MarkerForm::Tagged(MarkerTagged::Wgsl(w)) => Marker::Wgsl { source: w.source.into(), inputs: w.inputs },
            MarkerForm::Tagged(MarkerTagged::Icon(i)) => {
                let mut images = Vec::with_capacity(i.images.len());
                for image in i.images {
                    if image.rgba.len() != (image.size[0] * image.size[1] * 4) as usize {
                        return Err(E::custom("an image's rgba holds four bytes per texel of its size"));
                    }
                    images.push(Image { size: image.size, rgba: image.rgba.into() });
                }
                Marker::Icon { images, index: i.index }
            }
        })
    }
}

/// How the view places vertex rows without positions: a diagram's blocks, or points on a plane or the
/// earth, among the rows linked to them. Places hold once given; `arrange` lays out again.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a layout: \"none\", \"stress\", \"layered\", or { stress | layered: options }")]
enum LayoutForm {
    Name(#[schemars(with = "LayoutName")] String),
    Tagged(LayoutTagged),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
enum LayoutName {
    None,
    Stress,
    Layered,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
enum LayoutTagged {
    Stress(StressForm),
    Layered(LayeredForm),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct StressForm {
    gap: Option<f64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct LayeredForm {
    flow: Option<Direction>,
    gap: Option<f64>,
    rank_gap: Option<f64>,
}

impl LayoutForm {
    fn build<E: de::Error>(self) -> Result<Layout, E> {
        Ok(match self {
            LayoutForm::Name(name) => match named(&name)? {
                LayoutName::None => Layout::None,
                LayoutName::Stress => Layout::Stress(Stress::default()),
                LayoutName::Layered => Layout::Layered(Layered::default()),
            },
            LayoutForm::Tagged(LayoutTagged::Stress(s)) => {
                Layout::Stress(Stress { gap: s.gap.unwrap_or(Stress::default().gap) })
            }
            LayoutForm::Tagged(LayoutTagged::Layered(l)) => {
                let d = Layered::default();
                Layout::Layered(Layered {
                    flow: l.flow.unwrap_or(d.flow),
                    gap: l.gap.unwrap_or(d.gap),
                    rank_gap: l.rank_gap.unwrap_or(d.rank_gap),
                })
            }
        })
    }
}

/// A vertex's port: where a net its reference field names meets it, on one side of its marker. An
/// output drives its net: layouts rank the net from it, and its wires point away from it.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a port: a side, or { side, order, label, shape, output }")]
enum PortForm {
    Side(Side),
    Full(PortFull),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
struct PortFull {
    side: Side,
    /// Its place among the ports on that side, from the top or the left; in declaration order unless
    /// set.
    order: Option<u32>,
    /// Its name, drawn beside it inside the marker.
    label: Option<String>,
    shape: Option<Shape>,
    /// Whether it drives its net; an input unless set.
    output: Option<bool>,
}

impl PortForm {
    #[allow(clippy::unnecessary_wraps, reason = "every form builds through a Result")]
    fn build<E: de::Error>(self) -> Result<Port, E> {
        Ok(match self {
            PortForm::Side(side) => Port::new(side),
            PortForm::Full(full) => Port {
                side: full.side,
                order: full.order,
                label: full.label,
                shape: full.shape.unwrap_or_default(),
                output: full.output.unwrap_or(false),
            },
        })
    }
}

/// Colors and sizes marks take unless set: a base theme's name, or options over one. Lengths are CSS
/// pixels; in a diagram, units, except `glow` and `halo`.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged, expecting = "a theme: \"dark\", \"light\", or options")]
enum ThemeForm {
    Name(#[schemars(with = "Base")] String),
    Full(Box<ThemeFull>),
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(inline)]
enum Base {
    Dark,
    Light,
}

impl Base {
    fn theme(self) -> Theme {
        match self {
            Base::Dark => Theme::dark(),
            Base::Light => Theme::light(),
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
#[allow(clippy::option_option, reason = "absent keeps the base theme's color; null removes it")]
struct ThemeFull {
    /// The theme these options change; the dark one unless set.
    base: Option<Base>,
    background: Option<Color>,
    /// The earth's ground, and a group's container.
    surface: Option<Color>,
    grid: Option<Color>,
    vertex: Option<Color>,
    vertex_radius: Option<f32>,
    /// `null` draws edges without a theme color in their mark's own.
    #[serde(default, deserialize_with = "present")]
    #[schemars(with = "Option<Color>")]
    edge: Option<Option<Color>>,
    edge_width: Option<f32>,
    line: Option<Color>,
    line_width: Option<f32>,
    area: Option<Color>,
    /// How much a face turned away from the camera darkens, 0 to 1.
    shading: Option<f32>,
    /// Text: labels, axis ticks, and titles.
    text: Option<Color>,
    /// A CSS font family list.
    font: Option<String>,
    font_size: Option<f32>,
    /// The line a plot draws at the shown coordinate.
    playhead: Option<Color>,
    missing: Option<Color>,
    hover: Option<Color>,
    /// `null` marks the selection by glow alone.
    #[serde(default, deserialize_with = "present")]
    #[schemars(with = "Option<Color>")]
    selected: Option<Option<Color>>,
    glow: Option<f32>,
    dim: Option<f32>,
    hover_scale: Option<f32>,
    dash: Option<f32>,
    /// How comets flowing along edges and lines look.
    flow: Option<FlowForm>,
    /// In a diagram, between the lanes of edges joining the same two vertices; orthogonal wires keep
    /// twice it apart.
    edge_spacing: Option<f32>,
    /// Elsewhere, how far edges joining the same two vertices bow apart: each lane by this fraction
    /// of the edge's length at its middle.
    lane_bow: Option<f32>,
    /// How far an arrowhead reaches past its edge's width.
    arrow: Option<f32>,
    /// CSS pixels of background around label text.
    halo: Option<f32>,
    /// Between a group's members and its outline.
    group_padding: Option<f32>,
    /// How marks that cast shadows cast them.
    shadow: Option<ShadowForm>,
    /// The air around the globe, where the earth has an atmosphere.
    atmosphere: Option<Color>,
    /// How bright the earth's night side stays under daylight, 0 to 1.
    night: Option<f32>,
}

/// How comets flowing along edges and lines look: each a round head, brightest at its middle,
/// trailing a tail that thins and fades.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "Flow")]
struct FlowForm {
    /// A comet's color; its alpha is how strongly a comet covers its stroke.
    color: Option<Color>,
    /// Distance between comets.
    spacing: Option<f32>,
    /// How far a comet's tail trails its head.
    length: Option<f32>,
    /// How wide a comet's head is, CSS pixels, or units in a diagram; never narrower than its stroke.
    width: Option<f32>,
    /// Whether comets are part of the drawing: their spacing, length, and each row's flow in position
    /// units, degrees on the earth, so they zoom with the view and stay where they are on their lines.
    /// Otherwise they keep their size and speed on screen, and slide along their lines as it zooms.
    units: Option<bool>,
}

/// How marks that cast shadows cast them onto the ground and onto faces.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "Shadow")]
struct ShadowForm {
    /// What a shadow darkens toward; its alpha is how dark a shadow at contact gets.
    color: Option<Color>,
    /// The direction toward the light, fixed in the world: shadows fall away from it.
    light: Option<[f32; 3]>,
    /// How much a shadow spreads per unit of a caster's height.
    softness: Option<f32>,
    /// CSS pixels flat marks cast from, as if raised.
    lift: Option<f32>,
}

impl ThemeForm {
    fn build<E: de::Error>(self) -> Result<Theme, E> {
        let form = match self {
            ThemeForm::Name(name) => return Ok(named::<Base, E>(&name)?.theme()),
            ThemeForm::Full(form) => form,
        };
        let mut t = form.base.map_or_else(Theme::default, Base::theme);
        // Each field the form gives replaces the base theme's.
        macro_rules! set {
            ($form:expr => $theme:expr; $($field:ident),*) => {$(
                if let Some(v) = $form.$field {
                    $theme.$field = v;
                }
            )*};
        }
        set!(form => t; background, surface, grid, vertex, vertex_radius, edge, edge_width, missing, hover, selected);
        set!(form => t; glow, dim, hover_scale, dash, line, line_width, shading, text, font_size, playhead);
        set!(form => t; edge_spacing, lane_bow, arrow, halo, group_padding, area, atmosphere, night);
        if let Some(font) = form.font {
            t.font = font.into();
        }
        if let Some(flow) = form.flow {
            set!(flow => t.flow; color, spacing, length, width, units);
        }
        if let Some(shadow) = form.shadow {
            set!(shadow => t.shadow; color, light, softness, lift);
        }
        Ok(t)
    }
}

/// Reads a field that is present, so `null` stays apart from absent: `Some(None)`, not `None`.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Colormap, ColormapKind, Flow, field};

    #[test]
    fn scenes_match_builders() {
        let json = r#"{
            "space": "globe",
            "marks": [
                { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"], "width": 2 } },
                { "vertices": { "of": ["grid", "Bus"], "position": ["lon", "lat"], "radius": { "units": 3 },
                    "color": { "colormap": "vm", "map": "balance", "domain": [0.95, 1.05] } } }
            ],
            "theme": { "base": "light", "vertexRadius": 5 },
            "ease": 0
        }"#;
        let scene: Scene = serde_json::from_str(json).expect("a scene");
        let built = Scene::new(Earth::globe())
            .theme(Theme { vertex_radius: 5.0, ..Theme::light() })
            .ease(Duration::ZERO)
            .draw(Edges::of("grid", "Branch").ends("from", "to").width(2.0))
            .draw(
                Vertices::of("grid", "Bus")
                    .position("lon", "lat")
                    .radius(crate::units(3.0))
                    .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05)),
            );
        assert_eq!(scene, built);
    }

    #[test]
    fn faces_lines_and_controls_match_builders() {
        let json = r##"{
            "space": "plane",
            "controls": { "turn": false, "pickRadius": 12 },
            "marks": [
                { "faces": { "of": ["mesh", "Face"], "corners": ["a", "b", "c"], "pick": false, "shadow": true } },
                { "lines": { "of": ["mesh", "Body"], "trace": "height", "color": "#66c7ff", "width": 2, "flow": 8 } },
                { "vertices": { "of": ["mesh", "Vertex"], "select": false, "drag": true } }
            ]
        }"##;
        let scene: Scene = serde_json::from_str(json).expect("a scene");
        let built = Scene::new(Plane::default())
            .controls(Controls { turn: false, pick_radius: 12.0, ..Controls::default() })
            .draw(Faces::of("mesh", "Face").corners("a", "b", "c").pick(false).shadow(true))
            .draw(
                Lines::of("mesh", "Body")
                    .trace("height")
                    .color(Color::hex("#66c7ff").expect("hex"))
                    .width(2.0)
                    .flow(8.0),
            )
            .draw(Vertices::of("mesh", "Vertex").select(false).drag(true));
        assert_eq!(scene, built);
    }

    #[test]
    fn areas_and_the_earths_look_match_builders() {
        let json = r##"{
            "space": { "earth": { "projection": "globe", "daylight": 1782043200, "atmosphere": true } },
            "marks": [
                { "areas": { "of": ["map", "states"], "rings": "outline", "color": "#336699" } },
                { "lines": { "of": ["map", "states"], "trace": "outline" } }
            ],
            "theme": { "area": "#223344", "night": 0.4 }
        }"##;
        let scene: Scene = serde_json::from_str(json).expect("a scene");
        let built = Scene::new(Earth::globe().daylight(1_782_043_200.0).atmosphere(true))
            .theme(Theme { area: Color::hex("#223344").expect("hex"), night: 0.4, ..Theme::default() })
            .draw(Areas::of("map", "states").rings("outline").color(Color::hex("#336699").expect("hex")))
            .draw(Lines::of("map", "states").trace("outline"));
        assert_eq!(scene, built);
    }

    #[test]
    fn comets_and_named_categories_match_builders() {
        let json = r##"{
            "space": "plane",
            "marks": [
                { "vertices": { "of": ["grid", "Bus"], "legend": "Kind",
                    "color": { "colormap": "k", "map": { "kind": "categorical", "colors": ["#ff0000", "#0000ff"],
                        "categories": ["red", "blue"] } } } }
            ],
            "theme": { "flow": { "color": "#00ff00", "width": 6 } }
        }"##;
        let scene: Scene = serde_json::from_str(json).expect("a scene");
        let map =
            Colormap::new(ColormapKind::Categorical, [Color::rgb(1.0, 0.0, 0.0), Color::rgb(0.0, 0.0, 1.0)]).unwrap();
        let flow = Flow { color: Color::rgb(0.0, 1.0, 0.0), width: 6.0, ..Theme::default().flow };
        let built = Scene::new(Plane::default()).theme(Theme { flow, ..Theme::default() }).draw(
            Vertices::of("grid", "Bus").legend("Kind").color(field("k").colormap(map.categories(["red", "blue"]))),
        );
        assert_eq!(scene, built);
        let continuous =
            r#"{ "colormap": "k", "map": { "kind": "sequential", "colors": ["red"], "categories": ["a"] } }"#;
        assert!(serde_json::from_str::<crate::Expr>(continuous).is_err(), "only a categorical map has categories");
    }

    #[test]
    fn null_removes_a_theme_color_and_absent_keeps_it() {
        let theme = |json: &str| serde_json::from_str::<Theme>(json).expect("a theme");
        assert!(Theme::default().selected.is_some());
        assert_eq!(theme(r#"{ "selected": null }"#).selected, None);
        assert_eq!(theme("{}").selected, Theme::default().selected);
    }

    #[test]
    fn controls_read_presets_and_options() {
        let controls = |json: &str| serde_json::from_str::<Controls>(json).expect("controls");
        assert_eq!(controls(r#""inspect""#), Controls::inspect());
        assert_eq!(controls(r#""none""#), Controls::none());
        let options = controls(r#"{ "zoom": "modifier", "cycle": true, "press": 0.8, "motion": "reduced" }"#);
        assert_eq!(
            options,
            Controls {
                zoom: Zoom::Modifier,
                cycle: true,
                press: Duration::from_millis(800),
                motion: Motion::Reduced,
                ..Controls::default()
            }
        );
        assert!(serde_json::from_str::<Controls>(r#"{ "zoom": true }"#).is_err(), "zoom names what zooms");
    }

    #[test]
    fn unknown_options_are_refused() {
        let error = serde_json::from_str::<Scene>(
            r#"{"space": "plane", "marks": [{"vertices": {"of": ["a", "b"], "colour": "x"}}]}"#,
        )
        .expect_err("a typo");
        assert!(error.to_string().contains("colour"), "{error}");
    }
}
