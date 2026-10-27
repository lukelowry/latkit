use std::sync::Arc;

use super::{Areas, Edges, Faces, Label, Lines, Vertices};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Expr, Name, Result, Size, Space};

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
    pub(crate) color: Option<Expr>,
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

    /// The code shaders tell it by.
    pub(crate) fn code(self) -> u32 {
        match self {
            MarkKind::Vertices => wgsl::MARK_VERTICES,
            MarkKind::Edges => wgsl::MARK_EDGES,
            MarkKind::Faces => wgsl::MARK_FACES,
            MarkKind::Lines => wgsl::MARK_LINES,
            MarkKind::Areas => wgsl::MARK_AREAS,
        }
    }

    /// Kind words per row.
    pub(crate) fn stride(self) -> u32 {
        match self {
            MarkKind::Vertices => wgsl::VERTEX_WORDS,
            MarkKind::Edges => wgsl::EDGE_WORDS,
            MarkKind::Faces => wgsl::FACE_WORDS,
            MarkKind::Lines => wgsl::LINE_WORDS,
            MarkKind::Areas => wgsl::AREA_WORDS,
        }
    }

    /// The shaders that draw its rows: every row, and the rows its focus lights, which faces lack:
    /// a face shows focus by its color alone. With `custom`, a vertex mark's custom marker's.
    pub(crate) fn shaders(self, custom: bool) -> (wgsl::Shader, Option<wgsl::Shader>) {
        use wgsl::Shader;
        match self {
            MarkKind::Vertices if custom => (Shader::PointsCustom, Some(Shader::PointsCustomFocus)),
            MarkKind::Vertices => (Shader::Points, Some(Shader::PointsFocus)),
            MarkKind::Edges | MarkKind::Lines => (Shader::Strokes, Some(Shader::StrokesFocus)),
            MarkKind::Areas => (Shader::Areas, Some(Shader::AreasFocus)),
            MarkKind::Faces => (Shader::Triangles, None),
        }
    }

    /// The bounds shader's entry point that measures its extents for a fit; `None` for edges and
    /// faces, whose rows lie between the vertices that frame them.
    pub(crate) fn bounds(self) -> Option<&'static str> {
        match self {
            MarkKind::Vertices => Some("points"),
            MarkKind::Lines => Some("strokes"),
            MarkKind::Areas => Some("areas"),
            MarkKind::Edges | MarkKind::Faces => None,
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

    /// Vertices per instance: 4 for the quad of a point or segment, 3 for a triangle.
    pub(crate) fn corners(self) -> u32 {
        match self {
            Primitive::Points | Primitive::Strokes => 4,
            Primitive::Triangles => 3,
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
    /// The path a stroke's segments follow, or where a triangle's corners come from: one of the
    /// `PATH_*` codes.
    pub(crate) path: u32,
    /// Extra words per row, after the kind's own.
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
    /// A drawing of a `kind` mark, before its options are compiled. [`Mark::compile`] sets its path.
    pub(crate) fn new(kind: MarkKind) -> Drawing {
        Drawing {
            kind,
            path: wgsl::PATH_ENDS,
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

    /// The path a stroke mark's rows follow, or where a triangle's corners come from: one of the
    /// `PATH_` codes, which its pipelines are built for. A net's star and every wire in a diagram
    /// follow the route the view computes. On a plot a line traces its samples, and elsewhere it
    /// follows its path field. Faces take their corners from the vertices they join, and vertices
    /// have no path, so both read `PATH_ENDS`.
    pub(crate) fn path(&self, space: &Space) -> u32 {
        match self {
            Mark::Edges(e) if e.poles => wgsl::PATH_POLES,
            Mark::Edges(e) if e.joins.is_some() => wgsl::PATH_GEOMETRY,
            Mark::Edges(_) if matches!(space, Space::Diagram(_)) => wgsl::PATH_GEOMETRY,
            Mark::Lines(_) if matches!(space, Space::Plot(_)) => wgsl::PATH_TRACE,
            Mark::Lines(_) | Mark::Areas(_) => wgsl::PATH_GEOMETRY,
            Mark::Vertices(_) | Mark::Edges(_) | Mark::Faces(_) => wgsl::PATH_ENDS,
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
        style.color.iter().chain([&style.visible]).chain(&style.priority).for_each(&mut *f);
        if let Some(label) = &style.label {
            [&label.text].into_iter().chain(&label.color).for_each(&mut *f);
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
            v.ring.iter().chain(v.marker.inputs()).for_each(&mut *f);
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
        drawing.path = self.path(context.space);
        let style = self.style();
        if let Some(priority) = &style.priority {
            compiler.check_data("priority", priority)?;
        }
        if let Some(label) = &style.label {
            compile_label(label, compiler, context, &mut drawing).map_err(|e| e.at("label"))?;
        }
        Ok(drawing)
    }
}

/// Compiles `label`'s text and color into extra words after the mark's own. In a diagram the text
/// reads only data, since the sheet sizes blocks around it.
fn compile_label(label: &Label, c: &mut Compiler<'_>, context: Context<'_>, drawing: &mut Drawing) -> Result<()> {
    if context.diagram() {
        c.check_structure("text", [&label.text])?;
    }
    let theme = context.theme;
    let extra = drawing.extras;
    let word = |k: u32| drawing.kind.stride() + extra + k;
    let column = c.text("text", &label.text, word(wgsl::LABEL_CODE))?;
    let color = Store::Color { word: word(wgsl::LABEL_COLOR), fallback: wgsl::THEME_TEXT };
    match &label.color {
        Some(expr) => c.channel("color", expr, color)?,
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
    paragraphs.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// The options every mark's JSON form has, and those of the marks drawn as strokes.
const MARK_OPTIONS: [&str; 10] =
    ["of", "color", "visible", "priority", "name", "pick", "select", "drag", "label", "legend"];
const STROKE_OPTIONS: [&str; 3] = ["width", "dash", "flow"];

/// A mark's schema from its form's: the options every mark has, and when `stroked` the stroke
/// options, moved to the `MarkOptions` and `StrokeOptions` definitions it extends, so each is
/// described once.
pub(crate) fn extending(
    generator: &mut schemars::SchemaGenerator,
    mut form: schemars::Schema,
    stroked: bool,
) -> schemars::Schema {
    let mut parts = vec![shared(generator, &mut form, "MarkOptions", "The options every mark has.", &MARK_OPTIONS)];
    if stroked {
        let about = "The options of marks drawn as strokes: edges and lines.";
        parts.push(shared(generator, &mut form, "StrokeOptions", about, &STROKE_OPTIONS));
    }
    // The whole refuses keys no part has; a part alone cannot, since it lacks the others' keys.
    form.remove("additionalProperties");
    parts.push(form.into());
    schemars::json_schema!({ "allOf": parts, "unevaluatedProperties": false })
}

/// Moves `keys` from `form`'s properties into definition `name`, described as `about`, which the
/// first mark to share it defines. Returns a reference to it.
fn shared(
    generator: &mut schemars::SchemaGenerator,
    form: &mut schemars::Schema,
    name: &str,
    about: &str,
    keys: &[&str],
) -> serde_json::Value {
    use serde_json::{Value, json};
    let properties = form.get_mut("properties").and_then(Value::as_object_mut).expect("a mark's form has options");
    let moved: serde_json::Map<String, Value> = keys
        .iter()
        .map(|&key| {
            (key.to_owned(), properties.shift_remove(key).unwrap_or_else(|| panic!("every mark has option {key}")))
        })
        .collect();
    let required: Vec<Value> = match form.get_mut("required").and_then(Value::as_array_mut) {
        Some(required) => {
            let (shared, own) = required.drain(..).partition(|key| key.as_str().is_some_and(|key| keys.contains(&key)));
            *required = own;
            shared
        }
        None => Vec::new(),
    };
    if form.get("required").and_then(Value::as_array).is_some_and(Vec::is_empty) {
        form.remove("required");
    }
    generator.definitions_mut().entry(name).or_insert_with(|| {
        let mut definition = json!({ "type": "object", "description": about, "properties": moved });
        if !required.is_empty() {
            definition["required"] = required.into();
        }
        definition
    });
    json!({ "$ref": format!("#/$defs/{name}") })
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
                let form = <Form as schemars::JsonSchema>::json_schema(generator);
                let stroke: &[&str] = &[$(stringify!($stroke)),*];
                let mut schema = $crate::scene::mark::extending(generator, form, !stroke.is_empty());
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
            /// Each row's color: a CSS color, a value through a colormap, or a conditional choosing
            /// between colors. Unset, rows take the theme's default for the mark; faces instead
            /// blend their corners' colors.
            color: Option<$crate::Expr>,
            /// Whether each row is drawn and can be picked. Default `true`.
            #[serde(default = "crate::scene::mark::yes")]
            visible: $crate::Expr,
            /// Each row's priority, from its data alone (no view state). Higher-priority rows draw
            /// on top, and are the last dropped when a table too large to draw whole is thinned to
            /// the tiles in view.
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
            /// Sets each row's color: a [`Color`](crate::Color), a value through a colormap, or a
            /// conditional choosing between colors. Unset, rows take the theme's default for the
            /// mark; faces instead blend their corners' colors.
            #[must_use]
            pub fn color(mut self, color: impl Into<$crate::Expr>) -> Self {
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
            /// draw on top, and are the last dropped when a table too large to draw whole is thinned
            /// to the tiles in view.
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
