use std::sync::Arc;

use schemars::JsonSchema;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use super::form::{Presets, preset_schema, presets};
use crate::Color;

/// Default colors and sizes for marks, and the look of text, focus, comets, and each space, grouped
/// by subject: a base theme's name (`"dark"` or `"light"`), or options that change a base. `base`
/// names the base and defaults to `dark`. Each option replaces only the base value it sets.
///
/// Lengths are in CSS pixels, except comet lengths given in position units.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(remote = "Self", default, rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = with_base)]
pub struct Theme {
    /// The background color.
    pub background: Color,
    /// The color of a plane's grid, a plot's grid lines, and the earth's graticule.
    pub grid: Color,
    /// The least distance between the lines (or dots) of a plane's grid and of the earth's
    /// graticule, in CSS pixels. Their spacing steps by 1, 2, and 5 times a power of ten
    /// (and 30° and 90° on the earth), and the finer step fades out as it nears this distance.
    pub grid_spacing: f32,
    /// The color a colormap gives a missing value, such as a row with no value in the field.
    pub missing: Color,
    /// The least contrast ratio with the background, as WCAG measures it, that colormap colors
    /// keep. A color with less is made lighter or darker, keeping its hue. Defaults to 1, which
    /// changes no color. 3 is WCAG's minimum for graphics.
    pub contrast: f32,
    /// The dash period: one dash and one gap of equal length.
    pub dash: f32,
    /// How much faces darken as they turn away from the camera, from 0 to 1.
    pub shading: f32,
    /// How labels, axis ticks, and titles look.
    pub text: TextTheme,
    /// Defaults for vertices.
    pub vertex: VertexTheme,
    /// Defaults for edges, and how parallel edges and arrowheads look.
    pub edge: EdgeTheme,
    /// Defaults for lines.
    pub line: LineTheme,
    /// Defaults for areas.
    pub area: AreaTheme,
    /// How hovered and selected rows glow, and how rows outside a selection dim.
    pub focus: FocusTheme,
    /// How comets flowing along edges and lines look.
    pub flow: FlowTheme,
    /// How the earth looks.
    pub earth: EarthTheme,
    /// How a plot looks.
    pub plot: PlotTheme,
}

/// How labels, axis ticks, and titles look.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct TextTheme {
    /// The text color.
    pub color: Color,
    /// The CSS font family list.
    pub font: Arc<str>,
    /// The font size, in CSS pixels.
    pub size: f32,
    /// Width of the background-colored halo around label text, in CSS pixels.
    pub halo: f32,
}

/// Defaults for vertices.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct VertexTheme {
    /// The vertex color.
    pub color: Color,
    /// The vertex radius, in CSS pixels.
    pub radius: f32,
    /// The corner radius of block markers, in CSS pixels. A block marker can set its own.
    pub corner: f32,
}

/// Defaults for edges, and how parallel edges and arrowheads look.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct EdgeTheme {
    /// The edge color. `None` blends the colors of each edge's two vertices, also for rows whose
    /// own color is missing. With `None`, edges without `ends` (nets and poles) use the text color.
    pub color: Option<Color>,
    /// The edge width, in CSS pixels.
    pub width: f32,
    /// How far edges joining the same two vertices bow apart. Each lane bows out
    /// by this fraction of the edge's length, measured at its middle. Parallel edges spread at most
    /// eight lanes wide, and more lanes pack closer. Bows scale with the zoom.
    pub bow: f32,
    /// How far an arrowhead extends beyond the edge's width. A head's length is this plus the
    /// width.
    pub arrow: f32,
}

/// Defaults for lines.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct LineTheme {
    /// The line color.
    pub color: Color,
    /// The line width, in CSS pixels.
    pub width: f32,
}

/// Defaults for areas.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct AreaTheme {
    /// The area color.
    pub color: Color,
}

/// How hovered and selected rows glow, and how rows outside a selection dim.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct FocusTheme {
    /// The glow color around hovered rows.
    pub hover: Color,
    /// The glow color around selected rows. `None` uses each row's own color.
    pub selected: Option<Color>,
    /// How far the hover and selection glows reach, in CSS pixels.
    pub glow: f32,
    /// The opacity of rows outside the selection while any row is selected, from 0 to 1.
    pub dim: f32,
    /// The scale factor for a hovered vertex sized in CSS pixels. Vertices sized in units only
    /// glow.
    pub grow: f32,
}

/// How comets along edges and lines look. A comet has a round head, brightest at its middle, and a
/// tail that thins and fades.
///
/// `spacing` and `length` must use the same unit, and each row's `flow` speed is in that unit too.
/// In position units (degrees on the earth), comets scale with the zoom and stay in place along
/// their lines. In CSS pixels, they keep their size and speed on screen.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct FlowTheme {
    /// The comet color. Its alpha sets how strongly a comet covers its stroke. A fully transparent
    /// color turns comets off.
    pub color: Color,
    /// The distance between consecutive comets.
    pub spacing: Length,
    /// The length of a comet's tail behind its head.
    pub length: Length,
    /// The width of a comet's head, in CSS pixels. A head is never narrower than its stroke.
    pub width: f32,
}

/// How the earth looks.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct EarthTheme {
    /// The ground color.
    pub ground: Color,
    /// The color of the air glowing around the globe, when the earth's `atmosphere` is on.
    pub atmosphere: Color,
    /// The brightness of the night side when the earth has `daylight`, from 0 to 1.
    pub night: f32,
}

/// How a plot looks.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = merged)]
pub struct PlotTheme {
    /// The color of the line at the view's current axis coordinate.
    pub playhead: Color,
}

/// A theme length: a plain number in CSS pixels, the same at any zoom, or `{ "units": n }` in
/// position units (degrees on the earth), which scale with the zoom.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Length {
    /// CSS pixels.
    Px(f32),
    /// Position units (degrees on the earth).
    Units(f32),
}

impl Length {
    /// The number, in the length's own unit.
    pub(crate) fn value(self) -> f32 {
        match self {
            Length::Px(v) | Length::Units(v) => v,
        }
    }

    /// Whether `other` is in the same unit.
    pub(crate) fn alike(self, other: Length) -> bool {
        std::mem::discriminant(&self) == std::mem::discriminant(&other)
    }
}

/// A length's JSON form: a number, or `{ "units": n }` with no other keys.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum LengthForm {
    Px(f32),
    Units(UnitsLength),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UnitsLength {
    units: f32,
}

impl Serialize for Length {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match *self {
            Length::Px(px) => LengthForm::Px(px),
            Length::Units(units) => LengthForm::Units(UnitsLength { units }),
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Length {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Length, D::Error> {
        LengthForm::deserialize(deserializer)
            .map(|form| match form {
                LengthForm::Px(px) => Length::Px(px),
                LengthForm::Units(UnitsLength { units }) => Length::Units(units),
            })
            .map_err(|_| de::Error::custom("a length must be a number or { units: n }"))
    }
}

impl JsonSchema for Length {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Length".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "A length: a number in CSS pixels, or `{ units }` in position units (degrees on the earth), which grow as the view zooms in.",
            "anyOf": [
                { "type": "number" },
                {
                    "type": "object",
                    "properties": { "units": { "type": "number", "description": "Position units (degrees on the earth), which grow as the view zooms in." } },
                    "required": ["units"],
                    "additionalProperties": false,
                },
            ],
        })
    }
}

impl Theme {
    /// Light marks on a dark background. The default theme.
    pub fn dark() -> Theme {
        let hex = |hex: &str| Color::hex(hex).expect("hex");
        Theme {
            background: hex("#0f141a"),
            grid: Color::WHITE.alpha(0.07),
            grid_spacing: 24.0,
            missing: hex("#6b7480"),
            contrast: 1.0,
            dash: 8.0,
            shading: 0.6,
            text: TextTheme {
                color: hex("#a8b2c2"),
                font: "system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif".into(),
                size: 11.0,
                halo: 2.0,
            },
            vertex: VertexTheme { color: hex("#7cc4ff"), radius: 4.0, corner: 6.0 },
            edge: EdgeTheme { color: None, width: 1.5, bow: 0.12, arrow: 7.0 },
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
                spacing: Length::Px(64.0),
                length: Length::Px(24.0),
                width: 4.0,
            },
            earth: EarthTheme { ground: hex("#18212b"), atmosphere: hex("#5aa9ff").alpha(0.55), night: 0.3 },
            plot: PlotTheme { playhead: hex("#ffe5d4").alpha(0.8) },
        }
    }

    /// Dark marks on a light background.
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

presets!(Theme { "dark" => Theme::dark(), "light" => Theme::light() }; read by hand);

/// Reads a base theme's name, or options merged group by group over the base's serialized form. An
/// omitted option keeps the base's value, and `null` clears an optional color.
impl<'de> Deserialize<'de> for Theme {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Theme, D::Error> {
        let named = |name: &str| {
            Theme::preset(name).ok_or_else(|| de::Error::custom(format!("theme {name:?} is not dark or light")))
        };
        let mut options = match Value::deserialize(deserializer)? {
            Value::String(name) => return named(&name),
            Value::Object(options) => options,
            _ => return Err(de::Error::custom("a theme must be \"dark\", \"light\", or options")),
        };
        let base = match options.remove("base") {
            None => Theme::dark(),
            Some(Value::String(name)) => named(&name)?,
            Some(_) => return Err(de::Error::custom("base must be dark or light")),
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

/// Merges `options` into `base` object by object. A length in units replaces the base's value
/// outright.
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

/// Whether `options` is a length in units, `{ units }`.
fn is_length(options: &serde_json::Map<String, Value>) -> bool {
    options.len() == 1 && options.contains_key("units")
}

/// Makes every option of a theme group optional in the schema, since each merges over the base.
fn merged(schema: &mut schemars::Schema) {
    schema.remove("required");
}

/// The theme schema: a base theme's name, or options over the base that `base` names.
fn with_base(schema: &mut schemars::Schema) {
    merged(schema);
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        let base = serde_json::json!({ "description": "The theme these options change. Defaults to `dark`.", "enum": Theme::NAMES });
        properties.insert("base".into(), base);
    }
    preset_schema::<Theme>(schema);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn theme(json: &str) -> Theme {
        serde_json::from_str(json).expect("a theme")
    }

    #[test]
    fn options_merge_over_their_base_group_by_group() {
        let theme = theme(
            r#"{"base": "light", "vertex": {"radius": 3}, "edge": {"color": null}, "focus": {"selected": null}}"#,
        );
        let light = Theme::light();
        assert_eq!(
            theme.vertex,
            VertexTheme { radius: 3.0, ..light.vertex },
            "the group's other options keep the base's values"
        );
        assert_eq!((theme.edge.color, theme.focus.selected), (None, None), "null clears a color");
        assert_eq!(theme.text, light.text);
    }

    #[test]
    fn a_length_keeps_its_unit_and_replaces_the_base_value() {
        let flow = theme(r#"{"flow": {"spacing": {"units": 40}, "length": {"units": 30}}}"#).flow;
        assert_eq!((flow.spacing, flow.length), (Length::Units(40.0), Length::Units(30.0)));
        let back: Theme = theme(&serde_json::to_string(&Theme { flow, ..Theme::dark() }).expect("serializes"));
        assert_eq!(back.flow, flow, "a theme round-trips through JSON");
        let px = theme(r#"{"flow": {"spacing": 40}}"#).flow;
        assert_eq!(px.spacing, Length::Px(40.0), "a plain number is CSS pixels");
        assert!(
            serde_json::from_str::<Theme>(r#"{"flow": {"spacing": {"px": 40}}}"#).is_err(),
            "a plain number is already CSS pixels"
        );
        assert!(serde_json::from_str::<Theme>(r#"{"radius": 3}"#).is_err(), "radius belongs in the vertex group");
    }
}
