//! Expressions, sizes, colors, and colormaps as JSON. A number or boolean is a constant, a string a
//! field (or a hex color when it starts with `#`), and an object one node, named by its key:
//!
//! | Form                                                       | Builder                         |
//! | ---------------------------------------------------------- | ------------------------------- |
//! | `{ "field": "x", "of": ["data", "Table"], "step": true }`   | `field("x").of(..).step()`      |
//! | `{ "color": "#ffb000" }`                                   | a color                         |
//! | `{ "state": "selected" }`                                  | `selected()`, `hovered()`, …    |
//! | `{ "missing": true }`                                      | `Expr::missing()`               |
//! | `{ "op": "add", "args": [a, b] }`                          | `a + b`, `a.min(b)`, `!a`, …    |
//! | `{ "when": [[c, v], …], "otherwise": e }`                  | `when(c).then(v)…otherwise(e)`  |
//! | `{ "is": [a, "text"] }`, `{ "contains": [a, "text"] }`     | `a.is("text")`, `a.contains(..)` |
//! | `{ "scale": [0, 1], "value": a, "domain": [lo, hi] }`      | `a.scale(..).domain(..)`        |
//! | `{ "colormap": "viridis", "value": a, "domain": [lo, hi] }` | `a.colormap(..).domain(..)`     |
//! | `{ "units": a, "atLeast": 2, "atMost": 20 }` (sizes only)  | `units(a).at_least(..)`         |
//!
//! Each object is its kind's form exactly: a key another kind has is refused. A map is a catalog name
//! or `{ "kind": "sequential", "colors": ["black", [0.2, "red"], "white"] }`, a color placed as a
//! `[place, color]` pair, and `categories` naming a categorical map's colors.

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde::de::{self, DeserializeOwned, Deserializer};
use serde_json::{Map, Value};

use super::{Binary, Color, Colormap, ColormapKind, Expr, Node, Size, State, Stop, Unary, node};
use crate::Name;

/// The key naming each kind of expression object.
const KINDS: &[&str] = &["field", "color", "state", "missing", "op", "when", "is", "contains", "scale", "colormap"];

/// `T` read from JSON `value`, or why not.
fn read<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}

impl<'de> Deserialize<'de> for Expr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Expr, D::Error> {
        Expr::from_json(Value::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl Expr {
    /// The expression JSON `value` writes.
    pub(crate) fn from_json(value: Value) -> Result<Expr, String> {
        match value {
            Value::Number(n) => n.as_f64().map(Expr::from).ok_or_else(|| "a number within range".to_owned()),
            Value::Bool(b) => Ok(b.into()),
            Value::String(text) if text.starts_with('#') => {
                Color::hex(&text).map(Expr::from).ok_or_else(|| format!("not a hex color: {text:?}"))
            }
            Value::String(name) => Ok(super::field(name)),
            Value::Object(map) => object(map),
            Value::Null | Value::Array(_) => {
                Err("an expression is a number, a boolean, a field's name, or an expression object".to_owned())
            }
        }
    }
}

/// The expression an object writes, read by the form of the kind its key names.
fn object(map: Map<String, Value>) -> Result<Expr, String> {
    let Some(&kind) = KINDS.iter().find(|&&k| map.contains_key(k)) else {
        return Err(format!("an expression object has one of {}", KINDS.join(", ")));
    };
    let op = map.get("op").and_then(Value::as_str).map(str::to_owned);
    let value = Value::Object(map);
    Ok(match kind {
        "field" => {
            let FieldForm { field, of, step } = read(value)?;
            let expr = super::field(field);
            let expr = match of {
                Some((data, table)) => expr.of(data, table),
                None => expr,
            };
            if step { expr.step() } else { expr }
        }
        "color" => read::<ColorForm>(value)?.color.into(),
        "state" => node(Node::State(read::<StateForm>(value)?.state)),
        "missing" => {
            if !read::<MissingForm>(value)?.missing {
                return Err("missing is true".to_owned());
            }
            Expr::missing()
        }
        "op" if op.as_deref().is_some_and(|op| named::<Unary>(op).is_ok()) => {
            let UnaryForm { op, args: [a] } = read(value)?;
            node(Node::Unary(op, a))
        }
        "op" => {
            let BinaryForm { op, args: [a, b] } = read(value)?;
            node(Node::Binary(op, a, b))
        }
        "when" => {
            let WhenForm { when, otherwise } = read(value)?;
            when.into_iter().rev().fold(otherwise, |rest, (c, v)| node(Node::When(c, v, rest)))
        }
        "is" => {
            let IsForm { is: (a, text) } = read(value)?;
            a.is(&text)
        }
        "contains" => {
            let ContainsForm { contains: (a, text) } = read(value)?;
            a.contains(&text)
        }
        "scale" => {
            let ScaleForm { scale: [lo, hi], value, domain } = read(value)?;
            domained(value.scale(lo..=hi), domain)
        }
        _ => {
            let ColormapForm { colormap, value, domain } = read(value)?;
            domained(value.colormap(colormap), domain)
        }
    })
}

/// `mapped` with `domain` when given, else fitting the values shown.
fn domained(mapped: super::Mapped, domain: Option<[f64; 2]>) -> Expr {
    match domain {
        Some([lo, hi]) => mapped.domain(lo..=hi).into(),
        None => mapped.into(),
    }
}

/// `name` read as one of the names `T` deserializes from.
fn named<T: DeserializeOwned>(name: &str) -> Result<T, String> {
    read(Value::String(name.to_owned()))
}

/// A field of each row: of the mark's own table, or of another dataset's table joined by row id.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct FieldForm {
    field: Name,
    /// The dataset and table the field is read from, joined by row id.
    #[serde(default)]
    #[schemars(extend("tsType" = "[data: string, table: string]"))]
    of: Option<(Name, Name)>,
    /// Reads a sampled field at its last frame without interpolating.
    #[serde(default)]
    step: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ColorForm {
    color: Color,
}

/// What the view knows of each row.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StateForm {
    state: State,
}

/// A missing value: options that read one take the theme's.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct MissingForm {
    #[schemars(extend("const" = true))]
    missing: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct UnaryForm {
    op: Unary,
    args: [Expr; 1],
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct BinaryForm {
    op: Binary,
    args: [Expr; 2],
}

/// The value of the first case whose condition holds, else `otherwise`.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct WhenForm {
    #[schemars(extend("tsType" = "[condition: ExprInput, value: ExprInput][]"))]
    when: Vec<(Expr, Expr)>,
    otherwise: Expr,
}

/// Whether a text field equals the text.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct IsForm {
    #[schemars(extend("tsType" = "[field: ExprInput, text: string]"))]
    is: (Expr, String),
}

/// Whether a text field holds the text, ignoring case: read by queries, which hold texts.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ContainsForm {
    #[schemars(extend("tsType" = "[field: ExprInput, text: string]"))]
    contains: (Expr, String),
}

/// `value` mapped linearly onto the range `scale`, clamped: from its `domain`, else from the extent of
/// the values shown.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ScaleForm {
    #[schemars(extend("tsType" = "[low: number, high: number]"))]
    scale: [f64; 2],
    value: Expr,
    #[serde(default)]
    #[schemars(extend("tsType" = "[low: number, high: number]"))]
    domain: Option<[f64; 2]>,
}

/// `value` through `colormap`: from its `domain`, else from the extent of the values shown.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ColormapForm {
    colormap: Colormap,
    value: Expr,
    #[serde(default)]
    #[schemars(extend("tsType" = "[low: number, high: number]"))]
    domain: Option<[f64; 2]>,
}

/// A size in position units, so it scales as the view zooms, kept within CSS pixels when given.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnitsForm {
    units: Expr,
    /// CSS pixels it keeps at least, however far the view zooms out.
    #[serde(default)]
    #[schemars(range(min = 0))]
    at_least: Option<f32>,
    /// CSS pixels it keeps at most, however far the view zooms in.
    #[serde(default)]
    #[schemars(range(min = 0))]
    at_most: Option<f32>,
}

/// An expression is its JSON, `ExprNode`; TypeScript also takes the builders that write it.
impl JsonSchema for Expr {
    fn schema_name() -> Cow<'static, str> {
        "Expr".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = generator.subschema_for::<ExprNode>();
        schema.insert("tsType".into(), "ExprInput".into());
        schema
    }
}

/// The JSON an expression is written as.
struct ExprNode;

impl JsonSchema for ExprNode {
    fn schema_name() -> Cow<'static, str> {
        "ExprNode".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let forms = [
            generator.subschema_for::<FieldForm>(),
            generator.subschema_for::<ColorForm>(),
            generator.subschema_for::<StateForm>(),
            generator.subschema_for::<MissingForm>(),
            generator.subschema_for::<UnaryForm>(),
            generator.subschema_for::<BinaryForm>(),
            generator.subschema_for::<WhenForm>(),
            generator.subschema_for::<IsForm>(),
            generator.subschema_for::<ContainsForm>(),
            generator.subschema_for::<ScaleForm>(),
            generator.subschema_for::<ColormapForm>(),
        ];
        let mut any = vec![
            json_schema!({ "type": "number" }),
            json_schema!({ "type": "boolean" }),
            json_schema!({ "type": "string", "description": "A field's name, or a hex color when it starts with `#`." }),
        ];
        any.extend(forms);
        json_schema!({
            "description": "A value for every row of a mark: a constant, a field, view state, or arithmetic of them.",
            "anyOf": any,
        })
    }
}

impl<'de> Deserialize<'de> for Size {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Size, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if !value.as_object().is_some_and(|map| map.contains_key("units")) {
            return Expr::from_json(value).map(Size::from).map_err(de::Error::custom);
        }
        let UnitsForm { units, at_least, at_most } = read(value).map_err(de::Error::custom)?;
        Ok(Size { expr: units, units: true, px: [at_least.unwrap_or(0.0).max(0.0), at_most.unwrap_or(f32::INFINITY)] })
    }
}

impl JsonSchema for Size {
    fn schema_name() -> Cow<'static, str> {
        "Size".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let expr = generator.subschema_for::<Expr>();
        let units = generator.subschema_for::<UnitsForm>();
        json_schema!({
            "description": "A size: CSS pixels, or position units with `units`.",
            "anyOf": [expr, units],
        })
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Color, D::Error> {
        let css = String::deserialize(deserializer)?;
        Color::css(&css).ok_or_else(|| de::Error::custom(format!("not a CSS color: {css:?}")))
    }
}

/// A color writes as CSS `rgba(…)`, read back exactly: whole channels as bytes, alpha as it is.
impl serde::Serialize for Color {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let channel = |v: f32| {
            let byte = v * 255.0;
            if (byte - byte.round()).abs() < 1e-3 { byte.round() } else { byte }
        };
        let [r, g, b] = [self.r, self.g, self.b].map(channel);
        serializer.serialize_str(&format!("rgba({r}, {g}, {b}, {})", self.a))
    }
}

impl JsonSchema for Color {
    fn schema_name() -> Cow<'static, str> {
        "Color".into()
    }

    fn inline_schema() -> bool {
        true
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A CSS color, such as `#ffb000` or `rebeccapurple`.",
            "tsType": "Color",
            "type": "string",
        })
    }
}

/// Your own colormap: its kind, its colors, and for a categorical map its categories' names.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ColorsForm {
    kind: ColormapKind,
    /// Colors blended in OKLab, each at its `[place, color]` from 0 to 1 or evenly between its
    /// neighbors, as in a CSS gradient; a categorical map's, one per category.
    colors: Vec<Stop>,
    /// The categories' names, in order, for a legend: a categorical map's alone.
    #[serde(default)]
    categories: Vec<String>,
}

impl<'de> Deserialize<'de> for Colormap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Colormap, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if let Value::String(name) = &value {
            return Colormap::named(name).ok_or_else(|| de::Error::custom(format!("no colormap named {name:?}")));
        }
        let ColorsForm { kind, colors, categories } = read(value).map_err(de::Error::custom)?;
        if kind != ColormapKind::Categorical && !categories.is_empty() {
            return Err(de::Error::custom("only a categorical map has categories"));
        }
        let map = Colormap::new(kind, colors).map_err(|e| match e {
            crate::Error::Invalid { reason, .. } => de::Error::custom(reason),
            e => de::Error::custom(e),
        })?;
        Ok(if categories.is_empty() { map } else { map.categories(categories) })
    }
}

impl JsonSchema for Colormap {
    fn schema_name() -> Cow<'static, str> {
        "Colormap".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let names: Vec<&str> = super::colormap::catalog().collect();
        generator.definitions_mut().insert(
            "ColormapName".into(),
            serde_json::json!({ "description": "A colormap of the catalog.", "type": "string", "enum": names }),
        );
        let colors = generator.subschema_for::<ColorsForm>();
        json_schema!({
            "description": "Colors for a range of values: a catalog name, or your own colors.",
            "anyOf": [{ "$ref": "#/$defs/ColormapName" }, colors],
        })
    }
}

impl<'de> Deserialize<'de> for Stop {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Stop, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Form {
            Color(Color),
            Placed(f32, Color),
        }
        Ok(match Form::deserialize(deserializer)? {
            Form::Color(color) => color.into(),
            Form::Placed(at, color) => (at, color).into(),
        })
    }
}

impl JsonSchema for Stop {
    fn schema_name() -> Cow<'static, str> {
        "Stop".into()
    }

    fn inline_schema() -> bool {
        true
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let color = generator.subschema_for::<Color>();
        json_schema!({
            "anyOf": [
                color,
                {
                    "type": "array",
                    "prefixItems": [{ "type": "number", "minimum": 0, "maximum": 1 }, color],
                    "minItems": 2,
                    "maxItems": 2,
                },
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{field, selected, when};

    fn parse(json: &str) -> Expr {
        serde_json::from_str(json).expect("an expression")
    }

    #[test]
    fn forms_match_builders() {
        assert_eq!(parse("\"vm\""), field("vm"));
        assert_eq!(parse("2.5"), Expr::from(2.5));
        assert_eq!(parse(r#"{"op": "add", "args": ["a", 1]}"#), field("a") + 1.0);
        assert_eq!(parse(r#"{"op": "not", "args": ["on"]}"#), !field("on"));
        assert_eq!(
            parse(r##"{"when": [[{"state": "selected"}, {"color": "#ff0000"}]], "otherwise": "c"}"##),
            when(selected()).then(Color::rgb(1.0, 0.0, 0.0)).otherwise(field("c"))
        );
        assert_eq!(
            parse(r#"{"colormap": "balance", "value": "vm", "domain": [0.9, 1.1]}"#),
            field("vm").colormap(Colormap::BALANCE).domain(0.9..=1.1).into()
        );
        assert_eq!(parse(r#"{"scale": [2, 8], "value": "kv"}"#), field("kv").scale(2.0..=8.0).into());
        assert_eq!(parse(r#"{"contains": ["name", "lake"]}"#), field("name").contains("lake"));
        let size: Size = serde_json::from_str(r#"{"units": 3}"#).expect("a size");
        assert_eq!(size, crate::units(3.0));
        let size: Size = serde_json::from_str(r#"{"units": 3, "atLeast": 2, "atMost": 20}"#).expect("a size");
        assert_eq!(size, crate::units(3.0).at_least(2.0).at_most(20.0));
        let map: Colormap =
            serde_json::from_str(r#"{"kind": "sequential", "colors": ["black", [0.25, "red"], "white"]}"#)
                .expect("a map");
        let stops = [Stop::from(Color::BLACK), (0.25, Color::rgb(1.0, 0.0, 0.0)).into(), Color::WHITE.into()];
        assert_eq!(map, Colormap::new(ColormapKind::Sequential, stops).unwrap());
    }

    #[test]
    fn errors_name_what_is_wrong() {
        let error = serde_json::from_str::<Expr>(r#"{"field": "a", "color": "red"}"#).expect_err("two kinds");
        assert!(error.to_string().contains("color"), "{error}");
        let error = serde_json::from_str::<Expr>(r#"{"field": "a", "map": "viridis"}"#).expect_err("a stray key");
        assert!(error.to_string().contains("map"), "{error}");
        let error = serde_json::from_str::<Expr>(r#"{"op": "frob", "args": []}"#).expect_err("unknown op");
        assert!(error.to_string().contains("frob"), "{error}");
        let error = serde_json::from_str::<Expr>(r#"{"op": "add", "args": ["a"]}"#).expect_err("two arguments");
        assert!(error.to_string().contains('2'), "{error}");
        let error = serde_json::from_str::<Colormap>(r#"{"kind": "cyclic", "colors": [[0.5, "red"], [0.2, "blue"]]}"#)
            .expect_err("descending places");
        assert!(error.to_string().contains("ascend"), "{error}");
    }
}
