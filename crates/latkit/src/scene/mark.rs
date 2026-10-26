use std::sync::Arc;

use super::{Areas, Edges, Faces, Label, Lines, Vertices};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Expr, Name, Paint, Result, Size, Space};

/// One table a scene draws. In JSON: `{ vertices | edges | faces | lines | areas: options }`.
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[non_exhaustive]
pub enum Mark {
    /// Rows drawn as markers.
    Vertices(Vertices),
    /// Rows drawn as strokes between two vertices.
    Edges(Edges),
    /// Rows drawn as triangles between three vertices.
    Faces(Faces),
    /// Rows drawn as lines along their paths, or on a plot through their samples.
    Lines(Lines),
    /// Rows drawn as the areas their polygons cover.
    Areas(Areas),
}

impl From<Vertices> for Mark {
    fn from(mark: Vertices) -> Mark {
        Mark::Vertices(mark)
    }
}

impl From<Edges> for Mark {
    fn from(mark: Edges) -> Mark {
        Mark::Edges(mark)
    }
}

impl From<Faces> for Mark {
    fn from(mark: Faces) -> Mark {
        Mark::Faces(mark)
    }
}

impl From<Lines> for Mark {
    fn from(mark: Lines) -> Mark {
        Mark::Lines(mark)
    }
}

impl From<Areas> for Mark {
    fn from(mark: Areas) -> Mark {
        Mark::Areas(mark)
    }
}

/// The default name of the field a mark reads geometry from, as geographic tables name it.
pub(crate) const GEOMETRY: &str = "geometry";

/// Options every mark has.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Style {
    pub(crate) data: Name,
    pub(crate) table: Name,
    pub(crate) color: Option<Paint>,
    pub(crate) visible: Expr,
    /// Each row's priority, read from its data alone.
    pub(crate) priority: Option<Expr>,
    pub(crate) name: Option<Name>,
    pub(crate) interaction: Interaction,
    pub(crate) label: Option<Label>,
    /// A legend of the colors, under this title.
    pub(crate) legend: Option<Arc<str>>,
}

/// Options of marks that draw strokes: edges and lines.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Stroke {
    pub(crate) width: Option<Size>,
    pub(crate) dash: Expr,
    pub(crate) flow: Expr,
}

impl Default for Stroke {
    fn default() -> Stroke {
        Stroke { width: None, dash: false.into(), flow: 0.0.into() }
    }
}

/// The row words where a stroke mark stores its width, flow, and flags, and the theme slot of its
/// default width.
pub(crate) struct StrokeWords {
    pub(crate) width: u32,
    pub(crate) flow: u32,
    pub(crate) flags: u32,
    pub(crate) theme_width: u32,
}

impl Stroke {
    /// The CSS pixel bounds of the width, from its [`Size`].
    pub(crate) fn px(&self) -> [f32; 2] {
        self.width.as_ref().map_or(crate::Size::ANY, |size| size.px)
    }

    /// Compiles the dash, flow, and width channels. A width is in the space's unit unless it names
    /// its own; the theme's width is always in the space's unit.
    pub(crate) fn compile(&self, c: &mut Compiler<'_>, words: &StrokeWords, diagram: bool) -> Result<()> {
        c.channel("dash", &self.dash, Store::Flag { word: words.flags, bit: wgsl::DASH })?;
        c.channel("flow", &self.flow, Store::Number { word: words.flow, fallback: None })?;
        let width = |units| Store::Size { word: words.width, units, fallback: Some(words.theme_width) };
        match &self.width {
            Some(size) => c.channel("width", &size.expr, width(size.in_units(diagram))),
            None => c.theme("width", words.theme_width, width(diagram)),
        }
    }
}

/// How a mark's rows respond to the pointer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Interaction {
    /// Whether rows respond to hover, clicks, and picks; unset, the mark's kind decides (see
    /// [`Mark::picks`]).
    pub(crate) pick: Option<bool>,
    pub(crate) select: bool,
    pub(crate) drag: bool,
}

impl Default for Interaction {
    fn default() -> Interaction {
        Interaction { pick: None, select: true, drag: false }
    }
}

impl Style {
    pub(crate) fn new(data: Name, table: Name) -> Style {
        Style {
            data,
            table,
            color: None,
            visible: true.into(),
            priority: None,
            name: None,
            interaction: Interaction::default(),
            label: None,
            legend: None,
        }
    }
}

/// The kind of a mark.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum MarkKind {
    Vertices,
    Edges,
    Faces,
    Lines,
    Areas,
}

impl MarkKind {
    /// The primitive its rows draw with.
    pub(crate) fn primitive(self) -> Primitive {
        match self {
            MarkKind::Vertices => Primitive::Points,
            MarkKind::Edges | MarkKind::Lines => Primitive::Strokes,
            MarkKind::Faces | MarkKind::Areas => Primitive::Triangles,
        }
    }

    /// The key a mark of this kind has in JSON.
    pub(crate) fn name(self) -> &'static str {
        match self {
            MarkKind::Vertices => "vertices",
            MarkKind::Edges => "edges",
            MarkKind::Faces => "faces",
            MarkKind::Lines => "lines",
            MarkKind::Areas => "areas",
        }
    }
}

/// Identifies a mark across scenes: a new scene's mark with the same key eases from the old one.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Key {
    pub(crate) kind: MarkKind,
    pub(crate) data: Name,
    pub(crate) table: Name,
    pub(crate) name: Option<Name>,
}

/// The primitive a mark draws its rows with: points, strokes, or triangles.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Primitive {
    Points,
    Strokes,
    Triangles,
}

impl Primitive {
    pub(crate) fn code(self) -> u32 {
        match self {
            Primitive::Points => wgsl::POINTS,
            Primitive::Strokes => wgsl::STROKES,
            Primitive::Triangles => wgsl::TRIANGLES,
        }
    }
}

/// How a vertex mark's markers draw: the marker kind (built in or custom), its shape, and the
/// inputs it reads.
#[derive(Clone, PartialEq, Debug, Default)]
pub(crate) struct Markers {
    pub(crate) marker: u32,
    pub(crate) shape: u32,
    pub(crate) corner: f32,
    pub(crate) hole: f32,
    /// The number of inputs, and the extra word holding the first.
    pub(crate) inputs: u32,
    pub(crate) input: u32,
    /// A pie's slice colors, packed; for an icon marker, its image layers, filled in when the icons
    /// are packed.
    pub(crate) palette: Vec<u32>,
    /// An icon marker's images.
    pub(crate) icons: Vec<crate::Image>,
    /// A custom marker's WGSL.
    pub(crate) custom: Option<std::sync::Arc<str>>,
}

/// How a compiled mark's labels draw: the extra word where the label words start, the program
/// column of the text, and the font size and wrap width in length units (CSS pixels, or units in a
/// diagram).
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Labeling {
    pub(crate) extra: u32,
    pub(crate) column: u32,
    pub(crate) size: f32,
    pub(crate) max_width: Option<f32>,
    /// The font for the text: the label's, else the theme's.
    pub(crate) font: std::sync::Arc<str>,
    /// The most labels shown at once; `None` for no limit.
    pub(crate) max: Option<u32>,
}

/// The context a mark compiles in: the theme it falls back on, the space, and the layout.
#[derive(Clone, Copy)]
pub(crate) struct Context<'a> {
    pub(crate) theme: &'a super::Theme,
    pub(crate) space: &'a Space,
    pub(crate) layout: &'a super::Layout,
}

impl Context<'_> {
    /// Whether the space is a diagram, where every length is in units and the sheet positions
    /// vertices and routes wires.
    pub(crate) fn diagram(&self) -> bool {
        matches!(self.space, Space::Diagram(_))
    }

    /// Whether the scene's layout places vertex rows without a position outside a diagram, on a
    /// plane or the earth.
    pub(crate) fn placed(&self) -> bool {
        matches!(self.space, Space::Plane(_) | Space::Earth(_)) && !matches!(self.layout, super::Layout::None)
    }
}

/// Everything a compiled mark draws with besides its program.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Drawing {
    pub(crate) kind: MarkKind,
    /// The primitive the mark draws its rows with.
    pub(crate) primitive: Primitive,
    /// The path a stroke's segments follow, or where a triangle's corners come from: one of the
    /// `PATH_*` codes.
    pub(crate) path: u32,
    /// Kind words per row, then the extra words per row that follow them.
    pub(crate) stride: u32,
    pub(crate) extras: u32,
    pub(crate) flags: u32,
    pub(crate) markers: Markers,
    /// The program column a line traces, or `NONE`.
    pub(crate) trace: u32,
    /// Program columns, `NONE` when absent: the geometry a stroke's path runs through (a diagram
    /// route, bends, or a line's path) or an area's triangles; and each row's lane among edges
    /// joining the same two vertices.
    pub(crate) geometry: u32,
    pub(crate) lane: u32,
    pub(crate) label: Option<Labeling>,
    /// A vertex mark's ports: the reference field naming each port's nets, the port, and the
    /// program column that reads the field.
    pub(crate) ports: Vec<(Name, super::Port, u32)>,
    /// The font size of a vertex mark's port labels, in length units.
    pub(crate) port_label_size: f32,
    /// CSS pixel bounds on the mark's size: a vertex's half-size, or a stroke's width.
    pub(crate) size_px: [f32; 2],
}

impl Drawing {
    pub(crate) fn new(kind: MarkKind, stride: u32) -> Drawing {
        let path = match kind {
            MarkKind::Edges | MarkKind::Faces => wgsl::PATH_ENDS,
            MarkKind::Lines => wgsl::PATH_TRACE,
            MarkKind::Areas => wgsl::PATH_GEOMETRY,
            MarkKind::Vertices => wgsl::NONE,
        };
        Drawing {
            kind,
            primitive: kind.primitive(),
            path,
            stride,
            extras: 0,
            flags: 0,
            markers: Markers::default(),
            trace: wgsl::NONE,
            geometry: wgsl::NONE,
            lane: wgsl::NONE,
            label: None,
            ports: Vec::new(),
            port_label_size: 0.0,
            size_px: crate::Size::ANY,
        }
    }
}

impl Mark {
    pub(crate) fn style(&self) -> &Style {
        match self {
            Mark::Vertices(m) => &m.style,
            Mark::Edges(m) => &m.style,
            Mark::Faces(m) => &m.style,
            Mark::Lines(m) => &m.style,
            Mark::Areas(m) => &m.style,
        }
    }

    fn style_mut(&mut self) -> &mut Style {
        match self {
            Mark::Vertices(m) => &mut m.style,
            Mark::Edges(m) => &mut m.style,
            Mark::Faces(m) => &mut m.style,
            Mark::Lines(m) => &mut m.style,
            Mark::Areas(m) => &mut m.style,
        }
    }

    pub(crate) fn kind(&self) -> MarkKind {
        match self {
            Mark::Vertices(_) => MarkKind::Vertices,
            Mark::Edges(_) => MarkKind::Edges,
            Mark::Faces(_) => MarkKind::Faces,
            Mark::Lines(_) => MarkKind::Lines,
            Mark::Areas(_) => MarkKind::Areas,
        }
    }

    /// Whether the mark's rows respond to hover, clicks, and picks. `pick` decides when set.
    /// Otherwise vertices, edges, faces, and plot traces pick, and geometry (areas, and lines along
    /// paths such as coasts, borders, and roads) does not, so hovering never probes it.
    pub(crate) fn picks(&self) -> bool {
        self.style().interaction.pick.unwrap_or(match self {
            Mark::Vertices(_) | Mark::Edges(_) | Mark::Faces(_) => true,
            Mark::Lines(lines) => lines.trace.is_some(),
            Mark::Areas(_) => false,
        })
    }

    /// `error`, found in this mark's options, placed under the mark's JSON path as the scene's
    /// `i`th mark, such as `marks[i].vertices`.
    pub(crate) fn within(&self, i: usize, error: Error) -> Error {
        error.at(self.kind().name()).at(i).at("marks")
    }

    /// The error when `data`, the dataset this mark names, lacks the mark's table; `None` when the
    /// table exists.
    pub(crate) fn absent_from(&self, data: &crate::Snapshot) -> Option<Error> {
        let style = self.style();
        data.table(&style.table)
            .is_none()
            .then(|| Error::invalid(format!("dataset '{}' has no table '{}'", style.data, style.table)).at("of"))
    }

    /// Whether the mark's rows can carry comets: a stroke mark whose `flow` is anything but the
    /// constant 0.
    pub(crate) fn flows(&self) -> bool {
        let stroke = match self {
            Mark::Edges(m) => &m.stroke,
            Mark::Lines(m) => &m.stroke,
            Mark::Vertices(_) | Mark::Faces(_) | Mark::Areas(_) => return false,
        };
        stroke.flow != Stroke::default().flow
    }

    /// The path a stroke mark's rows follow, or where an area's triangles come from: one of the
    /// `PATH_` codes, which its pipelines are built for; `None` for vertices and faces. In a
    /// diagram every wire follows the route its sheet computed. On a plot a line traces its
    /// samples, and elsewhere it follows its path field.
    pub(crate) fn path(&self, space: &Space) -> Option<u32> {
        match self {
            Mark::Edges(e) if e.poles => Some(wgsl::PATH_POLES),
            Mark::Edges(e) if e.joins.is_some() => Some(wgsl::PATH_GEOMETRY),
            Mark::Edges(_) if matches!(space, Space::Diagram(_)) => Some(wgsl::PATH_GEOMETRY),
            Mark::Edges(_) => Some(wgsl::PATH_ENDS),
            Mark::Lines(_) if matches!(space, Space::Plot(_)) => Some(wgsl::PATH_TRACE),
            Mark::Lines(_) | Mark::Areas(_) => Some(wgsl::PATH_GEOMETRY),
            Mark::Vertices(_) | Mark::Faces(_) => None,
        }
    }

    /// The first option of this mark that its space does not allow, with the reason. Outside a
    /// diagram: ports, groups, nets (edges without ends), orthogonal routes, and shadows. In a
    /// diagram: elevation, poles, and joins.
    pub(crate) fn misplaced(&self, diagram: bool) -> Option<(&'static str, &'static str)> {
        const ONLY: &str = "only a diagram has ports, groups, nets, orthogonal routes, and shadows";
        if diagram {
            if let Mark::Edges(e) = self
                && e.poles
            {
                return Some(("poles", "a diagram is flat, so it cannot have poles"));
            }
            if let Mark::Edges(e) = self
                && e.joins.is_some()
            {
                return Some(("joins", "in a diagram, nets join vertex ports instead"));
            }
            if let Mark::Vertices(v) = self
                && v.elevation != Expr::from(0.0)
            {
                return Some(("elevation", "a diagram is flat, so vertices cannot have elevation"));
            }
            return None;
        }
        match self {
            Mark::Vertices(v) if !v.ports.is_empty() => Some(("port", ONLY)),
            Mark::Vertices(v) if v.contains.is_some() => Some(("contains", ONLY)),
            Mark::Vertices(v) if v.shadow => Some(("shadow", ONLY)),
            Mark::Edges(e) if e.ends.is_none() && !e.poles && e.joins.is_none() => Some(("ends", ONLY)),
            Mark::Edges(e) if e.route == Some(super::Route::Orthogonal) => Some(("route", ONLY)),
            _ => None,
        }
    }

    /// Calls `f` with every expression in the mark's options.
    pub(crate) fn for_each_expr<'a>(&'a self, f: &mut impl FnMut(&'a Expr)) {
        let style = self.style();
        style.color.iter().map(|paint| &paint.0).chain([&style.visible]).chain(&style.priority).for_each(&mut *f);
        if let Some(label) = &style.label {
            [&label.text]
                .into_iter()
                .chain(label.color.iter().map(|paint| &paint.0))
                .chain(&label.priority)
                .for_each(&mut *f);
        }
        let stroke = match self {
            Mark::Edges(m) => Some(&m.stroke),
            Mark::Lines(m) => Some(&m.stroke),
            Mark::Vertices(_) | Mark::Faces(_) | Mark::Areas(_) => None,
        };
        if let Some(stroke) = stroke {
            stroke.width.iter().map(|size| &size.expr).chain([&stroke.dash, &stroke.flow]).for_each(&mut *f);
        }
        if let Mark::Vertices(v) = self {
            v.position.iter().flatten().chain([&v.elevation]).for_each(&mut *f);
            v.radius.iter().chain(v.size.iter().flatten()).map(|size| &size.expr).for_each(&mut *f);
            v.ring.iter().map(|paint| &paint.0).chain(v.marker.inputs()).for_each(&mut *f);
        }
    }

    /// The key that identifies this mark across scenes. An unnamed line mark is keyed by the field
    /// it draws.
    pub(crate) fn key(&self) -> Key {
        let style = self.style();
        let name = match self {
            Mark::Lines(lines) => style.name.clone().or_else(|| Some(lines.traced().clone())),
            _ => style.name.clone(),
        };
        Key { kind: self.kind(), data: style.data.clone(), table: style.table.clone(), name }
    }

    /// Whether `other` draws the same, ignoring interaction options.
    pub(crate) fn draws_like(&self, other: &Mark) -> bool {
        let mut a = self.clone();
        a.style_mut().interaction = other.style().interaction;
        a == *other
    }

    pub(crate) fn compile(&self, compiler: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        let mut drawing = match self {
            Mark::Vertices(m) => m.compile(compiler, context),
            Mark::Edges(m) => m.compile(compiler, context),
            Mark::Faces(m) => m.compile(compiler),
            Mark::Lines(m) => m.compile(compiler, context),
            Mark::Areas(m) => m.compile(compiler, context),
        }?;
        let style = self.style();
        if let Some(priority) = &style.priority {
            compiler.check_data("priority", priority)?;
        }
        if let Some(label) = &style.label {
            let priority = label.priority.as_ref().or(style.priority.as_ref());
            compile_label(label, priority, compiler, context.theme, &mut drawing).map_err(|e| e.at("label"))?;
        }
        Ok(drawing)
    }
}

/// Compiles `label`'s text, `priority` (the label's, else the mark's), and color into extra words
/// after the mark's own.
fn compile_label(
    label: &Label,
    priority: Option<&Expr>,
    c: &mut Compiler<'_>,
    theme: &super::Theme,
    drawing: &mut Drawing,
) -> Result<()> {
    let extra = drawing.extras;
    let word = |k: u32| drawing.stride + extra + k;
    let column = c.text("text", &label.text, word(wgsl::LABEL_CODE))?;
    let priority: Expr = priority.cloned().unwrap_or_else(|| 0.0.into()).scale(0.0..=255.0).into();
    c.channel("priority", &priority, Store::Number { word: word(wgsl::LABEL_PRIORITY), fallback: None })?;
    let color = Store::Color { word: word(wgsl::LABEL_COLOR), fallback: wgsl::THEME_TEXT };
    match &label.color {
        Some(paint) => c.channel("color", &paint.0, color)?,
        None => c.theme("color", wgsl::THEME_TEXT, color)?,
    }
    drawing.extras += wgsl::LABEL_WORDS;
    drawing.flags |= wgsl::LABELED;
    drawing.label = Some(Labeling {
        extra,
        column,
        size: label.size.unwrap_or(theme.text.size),
        max_width: label.max_width,
        font: label.font.clone().unwrap_or_else(|| theme.text.font.clone()),
        max: label.max,
    });
    Ok(())
}

/// A mark's doc lines as its schema description: the prose before the first code block, with lines
/// joined into paragraphs.
pub(crate) fn described(lines: &[&str]) -> String {
    let prose =
        lines.iter().map(|line| line.strip_prefix(' ').unwrap_or(line)).take_while(|line| !line.starts_with("```"));
    let paragraphs: Vec<String> =
        prose.collect::<Vec<_>>().split(|line| line.is_empty()).map(|p| p.join(" ")).collect();
    paragraphs.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(
        "

",
    )
}

/// Declares a mark type: a struct holding the options every mark has, the stroke options when it
/// draws strokes, and its own options; and its flat JSON form, with `of` naming the dataset and
/// table, which it deserializes from and derives its schema from. Each option is declared once,
/// here.
macro_rules! mark {
    ($(#[doc = $line:literal])* $name:ident $(+ $stroke:ident)? {
        $($(#[$doc:meta])* $field:ident: $ty:ty $(as $ts:literal)? $(= $default:literal)?),* $(,)?
    }) => {
        $(#[doc = $line])*
        #[derive(Clone, PartialEq, Debug)]
        pub struct $name {
            pub(crate) style: $crate::scene::mark::Style,
            $(pub(crate) $stroke: $crate::scene::mark::Stroke,)?
            $($(#[$doc])* pub(crate) $field: $ty,)*
        }

        $crate::scene::mark::mark!(@form $name $(+ $stroke)? { $($(#[$doc])* $field: $ty $(as $ts)? $(= $default)?),* });

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<$name, D::Error> {
                let form = <Form as serde::Deserialize>::deserialize(deserializer)?;
                Ok($name {
                    style: form.style(),
                    $($stroke: form.stroke(),)?
                    $($field: form.$field,)*
                })
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                stringify!($name).into()
            }

            fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
                let mut schema = <Form as schemars::JsonSchema>::json_schema(generator);
                schema.insert("description".into(), $crate::scene::mark::described(&[$($line),*]).into());
                schema
            }
        }
    };
    (@form $name:ident { $($(#[$doc:meta])* $field:ident: $ty:ty $(as $ts:literal)? $(= $default:literal)?),* }) => {
        $crate::scene::mark::mark!(@struct { $($(#[$doc])* $field: $ty $(as $ts)? $(= $default)?),* } {});
    };
    (@form $name:ident + stroke { $($(#[$doc:meta])* $field:ident: $ty:ty $(as $ts:literal)? $(= $default:literal)?),* }) => {
        $crate::scene::mark::mark!(@struct { $($(#[$doc])* $field: $ty $(as $ts)? $(= $default)?),* } {
            /// Each row's width, in the space's unit (units in a diagram, CSS pixels elsewhere)
            /// unless given with `px` or `units`. The theme's width unless set.
            width: Option<$crate::Size>,
            /// Whether each row is dashed, with the theme's `dash` period. Default `false`.
            #[serde(default = "crate::scene::mark::no")]
            dash: $crate::Expr,
            /// The speed of comets flowing along each row, per second, in the unit of the theme's
            /// `flow` lengths. Negative speeds flow backward; 0, the default, draws no comets. When
            /// the speed changes, comets continue from where they are.
            #[serde(default = "crate::scene::mark::still")]
            flow: $crate::Expr,
        });

        impl Form {
            fn stroke(&self) -> $crate::scene::mark::Stroke {
                $crate::scene::mark::Stroke { width: self.width.clone(), dash: self.dash.clone(), flow: self.flow.clone() }
            }
        }
    };
    (@struct { $($(#[$doc:meta])* $field:ident: $ty:ty $(as $ts:literal)? $(= $default:literal)?),* } { $($stroke:tt)* }) => {
        /// The mark's JSON form: `of`, its own options, then the stroke options and the options
        /// every mark has.
        #[derive(serde::Deserialize, schemars::JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Form {
            /// The dataset and table drawn.
            #[schemars(extend("tsType" = "[data: string, table: string]"))]
            of: ($crate::Name, $crate::Name),
            $($(#[$doc])* $(#[schemars(extend("tsType" = $ts))])? #[serde(default $(= $default)?)] $field: $ty,)*
            $($stroke)*
            /// Each row's color. Unset, rows take the theme's default for the mark; faces instead
            /// blend their corners' colors.
            color: Option<$crate::Paint>,
            /// Whether each row is drawn and can be picked. Default `true`.
            #[serde(default = "crate::scene::mark::yes")]
            visible: $crate::Expr,
            /// Each row's priority, from its data alone (no view state). Higher-priority rows draw
            /// on top, are the last dropped when a table too large to draw whole is thinned to the
            /// tiles in view, and are labeled first.
            priority: Option<$crate::Expr>,
            /// Distinguishes two marks of the same table across scenes, and names the mark in hits.
            name: Option<$crate::Name>,
            /// Whether rows respond to hover, clicks, and picks. Unset, vertices, edges, faces, and
            /// plot traces do, and geometry (areas, and lines along paths such as coasts, borders,
            /// and roads) does not.
            pick: Option<bool>,
            /// Whether clicking a row selects it. Default `true`.
            #[serde(default = "crate::scene::mark::on")]
            select: bool,
            /// Whether pressing and moving a row drags it, reported as
            /// [`Event::Drag`](crate::Event), instead of panning the camera. Default `false`.
            #[serde(default)]
            drag: bool,
            /// Each row's label: a text field, or label options.
            label: Option<$crate::Label>,
            /// A legend of the mark's colors at the view's bottom right, under this title: a ticked
            /// colormap across its domain, a cell for each category, or a swatch beside each name
            /// of a map's `categories`. `color` must map through a colormap with a fixed domain or
            /// named categories; in a conditional, `otherwise` is searched before the cases.
            legend: Option<std::sync::Arc<str>>,
        }

        impl Form {
            fn style(&self) -> $crate::scene::mark::Style {
                $crate::scene::mark::Style {
                    data: self.of.0.clone(),
                    table: self.of.1.clone(),
                    color: self.color.clone(),
                    visible: self.visible.clone(),
                    priority: self.priority.clone(),
                    name: self.name.clone(),
                    interaction: $crate::scene::mark::Interaction { pick: self.pick, select: self.select, drag: self.drag },
                    label: self.label.clone(),
                    legend: self.legend.clone(),
                }
            }
        }
    };
}

pub(crate) use mark;

/// Defaults for options of the JSON forms.
pub(crate) fn yes() -> Expr {
    true.into()
}

pub(crate) fn no() -> Expr {
    false.into()
}

pub(crate) fn still() -> Expr {
    0.0.into()
}

pub(crate) fn on() -> bool {
    true
}

pub(crate) fn zero() -> Expr {
    0.0.into()
}

/// Builder methods for the options every mark has.
macro_rules! style_methods {
    ($mark:ty) => {
        impl $mark {
            /// Sets each row's color. Unset, rows take the theme's default for the mark; faces
            /// instead blend their corners' colors.
            #[must_use]
            pub fn color(mut self, color: impl Into<$crate::Paint>) -> Self {
                self.style.color = Some(color.into());
                self
            }

            /// Sets whether each row is drawn and can be picked; all rows by default.
            #[must_use]
            pub fn visible(mut self, visible: impl Into<$crate::Expr>) -> Self {
                self.style.visible = visible.into();
                self
            }

            /// Sets each row's priority, from its data alone (no view state). Higher-priority rows
            /// draw on top, are the last dropped when a table too large to draw whole is thinned to
            /// the tiles in view, and are labeled first.
            #[must_use]
            pub fn priority(mut self, priority: impl Into<$crate::Expr>) -> Self {
                self.style.priority = Some(priority.into());
                self
            }

            /// Names the mark, to distinguish two marks of the same table across scenes and to
            /// identify the mark in hits.
            #[must_use]
            pub fn named(mut self, name: impl Into<$crate::Name>) -> Self {
                self.style.name = Some(name.into());
                self
            }

            /// Sets whether rows respond to hover, clicks, and picks. Unset, vertices, edges,
            /// faces, and plot traces do, and geometry (areas, and lines along paths such as
            /// coasts, borders, and roads) does not.
            #[must_use]
            pub fn pick(mut self, on: bool) -> Self {
                self.style.interaction.pick = Some(on);
                self
            }

            /// Sets whether clicking a row selects it; on by default.
            #[must_use]
            pub fn select(mut self, on: bool) -> Self {
                self.style.interaction.select = on;
                self
            }

            /// Sets whether pressing and moving a row drags it instead of panning the camera; off
            /// by default.
            #[must_use]
            pub fn drag(mut self, on: bool) -> Self {
                self.style.interaction.drag = on;
                self
            }

            /// Labels each row.
            #[must_use]
            pub fn label(mut self, label: $crate::Label) -> Self {
                self.style.label = Some(label);
                self
            }

            /// Draws a legend of the mark's colors at the view's bottom right, under `title`: a
            /// ticked colormap across its domain, a cell for each category, or a swatch beside each
            /// of the [named categories](crate::Colormap::categories). The color must map through a
            /// colormap with a fixed domain or named categories; in a conditional, `otherwise` is
            /// searched before the cases. Legends stack upward in mark order.
            #[must_use]
            pub fn legend(mut self, title: impl Into<std::sync::Arc<str>>) -> Self {
                self.style.legend = Some(title.into());
                self
            }
        }
    };
}

/// Builder methods for the stroke options of edges and lines.
macro_rules! stroke_methods {
    ($mark:ty) => {
        impl $mark {
            /// Sets each row's width, in the space's unit (units in a diagram, CSS pixels
            /// elsewhere) unless given with [`px`](crate::px) or [`units`](crate::units).
            #[must_use]
            pub fn width(mut self, width: impl Into<$crate::Size>) -> Self {
                self.stroke.width = Some(width.into());
                self
            }

            /// Sets whether each row is dashed, with the theme's dash period.
            #[must_use]
            pub fn dash(mut self, dash: impl Into<$crate::Expr>) -> Self {
                self.stroke.dash = dash.into();
                self
            }

            /// Sets the speed of comets flowing along each row, per second, in the unit of the
            /// theme's [`flow`](crate::FlowTheme) lengths. Negative speeds flow backward, and 0
            /// draws no comets. When the speed changes, comets continue from where they are.
            #[must_use]
            pub fn flow(mut self, speed: impl Into<$crate::Expr>) -> Self {
                self.stroke.flow = speed.into();
                self
            }
        }
    };
}

pub(crate) use {stroke_methods, style_methods};
