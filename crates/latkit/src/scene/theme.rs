use std::sync::Arc;

use schemars::JsonSchema;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use super::form::{Presets, presets};
use crate::Color;

/// Colors and sizes marks take where their options read nothing, and the look of text, focus,
/// motion, and each space, grouped by what they style: a base theme's name, or options over one
/// (`base`, dark unless set), each group's over the base's. Lengths are in the space's unit, units in a
/// diagram and CSS pixels elsewhere, but for a text's halo and focus's glow, CSS pixels everywhere.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", default, rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = with_base)]
pub struct Theme {
    /// Behind everything.
    pub background: Color,
    /// A plane's or a diagram's grid, and the earth's graticule.
    pub grid: Color,
    /// What a missing color reads as.
    pub missing: Color,
    /// Length of a dash.
    pub dash: f32,
    /// How much a face turned away from the camera darkens, 0 to 1.
    pub shading: f32,
    /// Labels, axis ticks, and titles.
    pub text: TextTheme,
    /// Vertices where their options say nothing.
    pub vertex: VertexTheme,
    /// Edges where their options say nothing, their lanes, and their arrowheads.
    pub edge: EdgeTheme,
    /// Lines where their options say nothing.
    pub line: LineTheme,
    /// Areas where their options say nothing.
    pub area: AreaTheme,
    /// How hovered and selected rows glow, and rows outside a selection dim.
    pub focus: FocusTheme,
    /// How comets flowing along edges and lines look.
    pub flow: FlowTheme,
    /// How a diagram's blocks, groups, ports, and wires look.
    pub diagram: DiagramTheme,
    /// How the earth looks.
    pub earth: EarthTheme,
    /// How a plot looks.
    pub plot: PlotTheme,
}

/// Labels, axis ticks, and titles.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct TextTheme {
    /// Text's color.
    pub color: Color,
    /// The CSS font family text is set in.
    pub font: Arc<str>,
    /// Text's size.
    pub size: f32,
    /// CSS pixels of background around label text.
    pub halo: f32,
}

/// Vertices where their options say nothing.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct VertexTheme {
    /// A vertex's color.
    pub color: Color,
    /// A vertex's radius.
    pub radius: f32,
}

/// Edges where their options say nothing, their lanes, and their arrowheads.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct EdgeTheme {
    /// An edge's color; `None` blends the colors of each edge's two vertices, and in a diagram takes
    /// the text color.
    pub color: Option<Color>,
    /// An edge's width.
    pub width: f32,
    /// In a diagram, distance between the lanes of edges joining the same two vertices, and between
    /// parallel orthogonal wires, which keep twice it apart.
    pub spacing: f32,
    /// Elsewhere, how far edges joining the same two vertices bow apart: each lane by this fraction
    /// of the edge's length at its middle, as wide as eight lanes at most, more packing closer. A bow
    /// is part of the drawing, so zooming never moves it.
    pub bow: f32,
    /// How far an arrowhead reaches past its edge's width.
    pub arrow: f32,
}

/// Lines where their options say nothing.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct LineTheme {
    /// A line's color.
    pub color: Color,
    /// A line's width.
    pub width: f32,
}

/// Areas where their options say nothing.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct AreaTheme {
    /// An area's color.
    pub color: Color,
}

/// How hovered and selected rows glow, and rows outside a selection dim.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct FocusTheme {
    /// The glow around hovered rows.
    pub hover: Color,
    /// The glow around selected rows; `None` glows in each row's own color.
    pub selected: Option<Color>,
    /// How far focus glows reach, CSS pixels.
    pub glow: f32,
    /// The opacity of rows outside a selection.
    pub dim: f32,
    /// How much a hovered vertex sized in CSS pixels grows.
    pub grow: f32,
}

/// How comets flowing along edges and lines look: each a round head, brightest at its middle, trailing
/// a tail that thins and fades. Their spacing and length are in one unit, and each row's flow is in it
/// too: in position units, degrees on the earth, comets are part of the drawing, zooming with the
/// view and staying where they are on their lines; otherwise they keep their size and speed as it
/// zooms.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct FlowTheme {
    /// A comet's color; its alpha is how strongly a comet covers its stroke.
    pub color: Color,
    /// Distance between comets.
    pub spacing: Length,
    /// How far a comet's tail trails its head.
    pub length: Length,
    /// How wide a comet's head is; never narrower than its stroke.
    pub width: f32,
}

/// How a diagram's blocks, groups, ports, and wires look.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct DiagramTheme {
    /// What a group's container is filled with.
    pub group: Color,
    /// The border of blocks and groups, a unit wide; `None` draws none.
    pub outline: Option<Color>,
    /// The radius of block and group corners; a block's marker may set its own.
    pub corner: f32,
    /// How wide ports are.
    pub port_size: f32,
    /// The radius of an orthogonal wire's bends.
    pub bend: f32,
    /// Distance between a group's members and its outline.
    pub group_padding: f32,
    /// How blocks and groups drop shadows onto the sheet.
    pub shadow: ShadowTheme,
}

/// How a diagram's blocks and groups drop shadows onto its sheet.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct ShadowTheme {
    /// What a shadow darkens toward; its alpha is how dark it gets under the block.
    pub color: Color,
    /// How far a block's or a group's shadow falls below it, and as far again it softens.
    pub lift: f32,
}

/// How the earth looks.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct EarthTheme {
    /// The ground's color.
    pub ground: Color,
    /// The air glowing around the globe, where the earth has an atmosphere.
    pub atmosphere: Color,
    /// How bright the night side stays where daylight lights the earth, 0 to 1.
    pub night: f32,
}

/// How a plot looks.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct PlotTheme {
    /// The line drawn at the shown coordinate.
    pub playhead: Color,
}

/// A length the theme sets: a number, in the space's unit, units in a diagram and CSS pixels
/// elsewhere; `{ "px": n }`, CSS pixels however the view zooms; or `{ "units": n }`, position units,
/// which scale as it zooms.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Length {
    /// In the space's unit.
    Space(f32),
    /// CSS pixels.
    Px(f32),
    /// Position units.
    Units(f32),
}

impl Length {
    /// How long it is, in its unit.
    pub(crate) fn value(self) -> f32 {
        match self {
            Length::Space(v) | Length::Px(v) | Length::Units(v) => v,
        }
    }

    /// Whether `other` is in its unit.
    pub(crate) fn alike(self, other: Length) -> bool {
        std::mem::discriminant(&self) == std::mem::discriminant(&other)
    }
}

/// How a length writes: a number, or `{ "px": n }` or `{ "units": n }`, each exactly.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum LengthForm {
    Space(f32),
    Px(PxLength),
    Units(UnitsLength),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PxLength {
    px: f32,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitsLength {
    units: f32,
}

impl Serialize for Length {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match *self {
            Length::Space(v) => LengthForm::Space(v),
            Length::Px(px) => LengthForm::Px(PxLength { px }),
            Length::Units(units) => LengthForm::Units(UnitsLength { units }),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Length {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Length, D::Error> {
        LengthForm::deserialize(deserializer)
            .map(|form| match form {
                LengthForm::Space(v) => Length::Space(v),
                LengthForm::Px(PxLength { px }) => Length::Px(px),
                LengthForm::Units(UnitsLength { units }) => Length::Units(units),
            })
            .map_err(|_| de::Error::custom("a length: a number, { px: n }, or { units: n }"))
    }
}

impl JsonSchema for Length {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Length".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let exactly = |key: &str, description: &str| {
            serde_json::json!({
                "type": "object",
                "properties": { key: { "type": "number", "description": description } },
                "required": [key],
                "additionalProperties": false,
            })
        };
        schemars::json_schema!({
            "description": "A length: a number, in the space's unit, units in a diagram and CSS pixels elsewhere; `{ px }`, CSS pixels; or `{ units }`, position units.",
            "anyOf": [
                { "type": "number" },
                exactly("px", "CSS pixels, however the view zooms."),
                exactly("units", "Position units, which scale as the view zooms."),
            ],
        })
    }
}

impl Theme {
    /// Light marks on a dark ground.
    pub fn dark() -> Theme {
        let hex = |hex: &str| Color::hex(hex).expect("hex");
        Theme {
            background: hex("#0f141a"),
            grid: Color::WHITE.alpha(0.07),
            missing: hex("#6b7480"),
            dash: 8.0,
            shading: 0.6,
            text: TextTheme {
                color: hex("#a8b2c2"),
                font: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif".into(),
                size: 11.0,
                halo: 2.0,
            },
            vertex: VertexTheme { color: hex("#7cc4ff"), radius: 4.0 },
            edge: EdgeTheme { color: None, width: 1.5, spacing: 4.0, bow: 0.12, arrow: 7.0 },
            line: LineTheme { color: hex("#7cc4ff"), width: 1.5 },
            area: AreaTheme { color: hex("#2b3d50") },
            focus: FocusTheme {
                hover: Color::WHITE.alpha(0.6),
                selected: Some(hex("#ffb000").alpha(0.9)),
                glow: 6.0,
                dim: 0.35,
                grow: 1.25,
            },
            flow: FlowTheme {
                color: Color::WHITE.alpha(0.85),
                spacing: Length::Space(64.0),
                length: Length::Space(24.0),
                width: 4.0,
            },
            diagram: DiagramTheme {
                group: hex("#18212b"),
                outline: Some(Color::WHITE.alpha(0.12)),
                corner: 6.0,
                port_size: 7.0,
                bend: 6.0,
                group_padding: 16.0,
                shadow: ShadowTheme { color: Color::BLACK.alpha(0.45), lift: 3.0 },
            },
            earth: EarthTheme { ground: hex("#18212b"), atmosphere: hex("#5aa9ff").alpha(0.55), night: 0.3 },
            plot: PlotTheme { playhead: hex("#ffe5d4").alpha(0.8) },
        }
    }

    /// Dark marks on a light ground.
    pub fn light() -> Theme {
        let hex = |hex: &str| Color::hex(hex).expect("hex");
        let dark = Theme::dark();
        Theme {
            background: hex("#f7f8fa"),
            grid: Color::BLACK.alpha(0.08),
            missing: hex("#9aa3ad"),
            text: TextTheme { color: hex("#4a5361"), ..dark.text },
            vertex: VertexTheme { color: hex("#1f6feb"), ..dark.vertex },
            line: LineTheme { color: hex("#1f6feb"), ..dark.line },
            area: AreaTheme { color: hex("#c5d2df") },
            focus: FocusTheme {
                hover: Color::BLACK.alpha(0.35),
                selected: Some(hex("#e36209").alpha(0.9)),
                ..dark.focus
            },
            flow: FlowTheme { color: Color::WHITE.alpha(0.9), ..dark.flow },
            diagram: DiagramTheme {
                group: hex("#e8ecf0"),
                outline: Some(Color::BLACK.alpha(0.14)),
                shadow: ShadowTheme { color: Color::BLACK.alpha(0.22), ..dark.diagram.shadow },
                ..dark.diagram
            },
            earth: EarthTheme { ground: hex("#e8ecf0"), atmosphere: hex("#6cb4ff").alpha(0.45), night: 0.55 },
            plot: PlotTheme { playhead: hex("#e36209").alpha(0.8) },
            ..dark
        }
    }
}

impl Default for Theme {
    fn default() -> Theme {
        Theme::dark()
    }
}

impl Presets for Theme {
    const NAMES: &'static [&'static str] = &["dark", "light"];

    fn preset(name: &str) -> Option<Theme> {
        match name {
            "dark" => Some(Theme::dark()),
            "light" => Some(Theme::light()),
            _ => None,
        }
    }

    fn options<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Theme, D::Error> {
        Theme::deserialize(deserializer)
    }
}

/// A theme reads a base theme's name, or options over one: written over the base as it serializes,
/// group by group, so an option left out keeps the base's and `null` clears a color the base has.
impl<'de> Deserialize<'de> for Theme {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Theme, D::Error> {
        let named = |name: &str| {
            Theme::preset(name).ok_or_else(|| de::Error::custom(format!("no theme {name:?}: dark or light")))
        };
        let mut options = match Value::deserialize(deserializer)? {
            Value::String(name) => return named(&name),
            Value::Object(options) => options,
            _ => return Err(de::Error::custom("a theme: \"dark\", \"light\", or options")),
        };
        let base = match options.remove("base") {
            None => Theme::dark(),
            Some(Value::String(name)) => named(&name)?,
            Some(_) => return Err(de::Error::custom("base names a theme: dark or light")),
        };
        let mut theme = serde_json::to_value(base).map_err(de::Error::custom)?;
        over(&mut theme, Value::Object(options));
        Theme::deserialize(theme).map_err(de::Error::custom)
    }
}

impl Serialize for Theme {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        Theme::serialize(self, serializer)
    }
}

/// Writes `options` over `base`, object by object: a length's own object replaces the base's.
fn over(base: &mut Value, options: Value) {
    match (base, options) {
        (Value::Object(base), Value::Object(options)) if !is_length(&options) => {
            for (key, value) in options {
                over(base.entry(key).or_insert(Value::Null), value);
            }
        }
        (slot, value) => *slot = value,
    }
}

/// Whether `options` are a length's own object, `{ px }` or `{ units }`, which replaces the base's.
fn is_length(options: &serde_json::Map<String, Value>) -> bool {
    options.len() == 1 && (options.contains_key("px") || options.contains_key("units"))
}

/// Options a theme merges over its base's, each of them optional.
fn merged(schema: &mut schemars::Schema) {
    schema.remove("required");
}

/// A theme's schema: a base's name, or options over the base `base` names.
fn with_base(schema: &mut schemars::Schema) {
    merged(schema);
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        let base = serde_json::json!({ "description": "The theme these options change; dark unless set.", "enum": Theme::NAMES });
        properties.insert("base".into(), base);
    }
    presets::<Theme>(schema);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme(json: &str) -> Theme {
        serde_json::from_str(json).expect("a theme")
    }

    #[test]
    fn options_go_over_their_base_group_by_group() {
        let theme = theme(
            r#"{"base": "light", "vertex": {"radius": 3}, "edge": {"color": null}, "focus": {"selected": null}}"#,
        );
        let light = Theme::light();
        assert_eq!(
            theme.vertex,
            VertexTheme { radius: 3.0, ..light.vertex },
            "the group's other options stay the base's"
        );
        assert_eq!((theme.edge.color, theme.focus.selected), (None, None), "null clears a color");
        assert_eq!(theme.text, light.text);
    }

    #[test]
    fn a_length_says_its_unit_and_replaces_the_base_s() {
        let flow = theme(r#"{"flow": {"spacing": {"units": 40}, "length": {"units": 30}}}"#).flow;
        assert_eq!((flow.spacing, flow.length), (Length::Units(40.0), Length::Units(30.0)));
        let back: Theme = theme(&serde_json::to_string(&Theme { flow, ..Theme::dark() }).expect("serializes"));
        assert_eq!(back.flow, flow, "a theme reads what it writes");
        let px = theme(r#"{"flow": {"spacing": {"px": 40}}}"#).flow;
        assert_eq!(px.spacing, Length::Px(40.0));
        assert!(serde_json::from_str::<Theme>(r#"{"radius": 3}"#).is_err(), "a vertex's radius is in its group");
    }
}
