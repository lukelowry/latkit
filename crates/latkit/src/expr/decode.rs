//! Expressions from serde data, mirroring the builders: a number or boolean is a constant, a string a
//! field (or a hex color when it starts with `#`), and an object one node:
//!
//! | Form                                                     | Builder                         |
//! | -------------------------------------------------------- | ------------------------------- |
//! | `{ "field": "x", "of": ["data", "Table"], "step": true }` | `field("x").of(..).step()`      |
//! | `{ "color": "#ffb000" }`                                 | a color                         |
//! | `{ "state": "selected" }`                                | `selected()`, `hovered()`, …    |
//! | `{ "missing": true }`                                    | `Expr::missing()`               |
//! | `{ "op": "add", "args": [a, b] }`                        | `a + b`, `a.min(b)`, `!a`, …    |
//! | `{ "when": [[c, v], …], "otherwise": e }`                | `when(c).then(v)…otherwise(e)`  |
//! | `{ "is": [a, "text"] }`                                  | `a.is("text")`                  |
//! | `{ "scale": a, "range": [0, 1], "domain": [lo, hi] }`    | `a.scale(..).domain(..)`        |
//! | `{ "colormap": a, "map": "viridis", "domain": [lo, hi] }` | `a.colormap(..).domain(..)`     |
//! | `{ "units": a, "atLeast": 2, "atMost": 20 }` (sizes only) | `units(a).at_least(..)`         |
//!
//! A map is a catalog name or `{ "kind": "sequential", "colors": ["black", [0.2, "red"], "white"] }`,
//! a color placed as a `[place, color]` pair, and `categories` naming a categorical map's colors:
//! `Colormap::new(..)?.categories(..)`.

use std::borrow::Cow;
use std::fmt;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::json;

use super::{Binary, Color, Colormap, ColormapKind, Expr, Node, Size, State, Stop, Unary, node};
use crate::Name;

impl<'de> Deserialize<'de> for Expr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Expr, D::Error> {
        deserializer.deserialize_any(ExprVisitor)
    }
}

impl<'de> Deserialize<'de> for Size {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Size, D::Error> {
        let node = deserializer.deserialize_any(NodeVisitor)?;
        Ok(match node {
            Decoded::Units(expr, px) => Size { expr, units: true, px },
            Decoded::Expr(expr) => Size { expr, units: false, px: Size::ANY },
        })
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Color, D::Error> {
        let css = String::deserialize(deserializer)?;
        Color::css(&css).ok_or_else(|| de::Error::custom(format!("not a CSS color: {css:?}")))
    }
}

impl<'de> Deserialize<'de> for Colormap {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Colormap, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Form {
            Named(String),
            Colors {
                kind: ColormapKind,
                colors: Vec<Stop>,
                #[serde(default)]
                categories: Vec<String>,
            },
        }
        match Form::deserialize(deserializer)? {
            Form::Named(name) => {
                Colormap::named(&name).ok_or_else(|| de::Error::custom(format!("no colormap named {name:?}")))
            }
            Form::Colors { kind, categories, .. } if kind != ColormapKind::Categorical && !categories.is_empty() => {
                Err(de::Error::custom("only a categorical map has categories"))
            }
            Form::Colors { kind, colors, categories } => {
                let map = Colormap::new(kind, colors).map_err(|e| match e {
                    crate::Error::Invalid { reason, .. } => de::Error::custom(reason),
                    e => de::Error::custom(e),
                })?;
                Ok(if categories.is_empty() { map } else { map.categories(categories) })
            }
        }
    }
}

impl<'de> Deserialize<'de> for Stop {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Stop, D::Error> {
        #[derive(serde::Deserialize)]
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

struct ExprVisitor;

enum Decoded {
    Expr(Expr),
    /// A size in units, and the CSS pixels it keeps within.
    Units(Expr, [f32; 2]),
}

struct NodeVisitor;

impl<'de> Visitor<'de> for ExprVisitor {
    type Value = Expr;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a number, boolean, field name, or expression object")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Expr, E> {
        Ok(v.into())
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Expr, E> {
        Ok(node(Node::Number(v as f64)))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Expr, E> {
        Ok(node(Node::Number(v as f64)))
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Expr, E> {
        Ok(v.into())
    }

    /// A string is a field, or a hex color when it starts with `#`.
    fn visit_str<E: de::Error>(self, v: &str) -> Result<Expr, E> {
        if v.starts_with('#') {
            return Color::hex(v).map(Expr::from).ok_or_else(|| de::Error::custom(format!("not a hex color: {v:?}")));
        }
        Ok(super::field(v))
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Expr, A::Error> {
        match NodeVisitor.visit_map(map)? {
            Decoded::Expr(expr) => Ok(expr),
            Decoded::Units(..) => Err(de::Error::custom("units measures a size, not a value")),
        }
    }
}

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Decoded;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a number, boolean, field name, or expression object")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Decoded, E> {
        ExprVisitor.visit_bool(v).map(Decoded::Expr)
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Decoded, E> {
        ExprVisitor.visit_i64(v).map(Decoded::Expr)
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Decoded, E> {
        ExprVisitor.visit_u64(v).map(Decoded::Expr)
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Decoded, E> {
        ExprVisitor.visit_f64(v).map(Decoded::Expr)
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Decoded, E> {
        ExprVisitor.visit_str(v).map(Decoded::Expr)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Decoded, A::Error> {
        let mut form = Form::default();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "field" => form.field = Some(map.next_value()?),
                "of" => form.of = Some(map.next_value()?),
                "step" => form.step = map.next_value()?,
                "color" => form.color = Some(map.next_value()?),
                "state" => form.state = Some(map.next_value()?),
                "missing" => form.missing = map.next_value()?,
                "op" => form.op = Some(map.next_value()?),
                "args" => form.args = Some(map.next_value()?),
                "when" => form.when = Some(map.next_value::<Cases>()?.0),
                "otherwise" => form.otherwise = Some(map.next_value()?),
                "is" => form.is = Some(map.next_value()?),
                "scale" => form.scale = Some(map.next_value()?),
                "range" => form.range = Some(map.next_value()?),
                "domain" => form.domain = Some(map.next_value()?),
                "colormap" => form.colormap = Some(map.next_value()?),
                "map" => form.map = Some(map.next_value()?),
                "units" => form.units = Some(map.next_value()?),
                "atLeast" => form.at_least = Some(map.next_value()?),
                "atMost" => form.at_most = Some(map.next_value()?),
                other => return Err(de::Error::unknown_field(other, FIELDS)),
            }
        }
        form.build()
    }
}

const FIELDS: &[&str] = &[
    "field",
    "of",
    "step",
    "color",
    "state",
    "missing",
    "op",
    "args",
    "when",
    "otherwise",
    "is",
    "scale",
    "range",
    "domain",
    "colormap",
    "map",
    "units",
    "atLeast",
    "atMost",
];

/// `[[condition, value], …]`.
struct Cases(Vec<(Expr, Expr)>);

impl<'de> Deserialize<'de> for Cases {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Cases, D::Error> {
        struct CasesVisitor;
        impl<'de> Visitor<'de> for CasesVisitor {
            type Value = Cases;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a list of [condition, value] pairs")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Cases, A::Error> {
                let mut cases = Vec::new();
                while let Some(pair) = seq.next_element::<(Expr, Expr)>()? {
                    cases.push(pair);
                }
                Ok(Cases(cases))
            }
        }
        deserializer.deserialize_seq(CasesVisitor)
    }
}

#[derive(Default)]
struct Form {
    field: Option<Name>,
    of: Option<(Name, Name)>,
    step: bool,
    color: Option<Color>,
    state: Option<String>,
    missing: bool,
    op: Option<String>,
    args: Option<Vec<Expr>>,
    when: Option<Vec<(Expr, Expr)>>,
    otherwise: Option<Expr>,
    is: Option<(Expr, String)>,
    scale: Option<Expr>,
    range: Option<[f64; 2]>,
    domain: Option<[f64; 2]>,
    colormap: Option<Expr>,
    map: Option<Colormap>,
    units: Option<Expr>,
    at_least: Option<f32>,
    at_most: Option<f32>,
}

impl Form {
    fn build<E: de::Error>(self) -> Result<Decoded, E> {
        let kinds = [
            self.field.is_some(),
            self.color.is_some(),
            self.state.is_some(),
            self.missing,
            self.op.is_some(),
            self.when.is_some(),
            self.is.is_some(),
            self.scale.is_some(),
            self.colormap.is_some(),
            self.units.is_some(),
        ];
        if kinds.iter().filter(|&&k| k).count() != 1 {
            return Err(E::custom(
                "an expression object has exactly one of field, color, state, missing, op, when, is, scale, colormap, units",
            ));
        }
        if (self.at_least.is_some() || self.at_most.is_some()) && self.units.is_none() {
            return Err(E::custom("atLeast and atMost keep a size in units within CSS pixels"));
        }
        let domain = |mapped: super::Mapped| match self.domain {
            Some([lo, hi]) => mapped.domain(lo..=hi),
            None => mapped,
        };
        let expr = if let Some(name) = self.field {
            let mut expr = super::field(name);
            if let Some((data, table)) = self.of {
                expr = expr.of(data, table);
            }
            if self.step { expr.step() } else { expr }
        } else if let Some(color) = self.color {
            color.into()
        } else if let Some(state) = self.state {
            node(Node::State(by_name(STATES, "state", &state)?))
        } else if self.missing {
            Expr::missing()
        } else if let Some(op) = self.op {
            operation::<E>(&op, &self.args.unwrap_or_default())?
        } else if let Some(cases) = self.when {
            let otherwise = self.otherwise.ok_or_else(|| E::missing_field("otherwise"))?;
            cases.into_iter().rev().fold(otherwise, |rest, (c, v)| node(Node::When(c, v, rest)))
        } else if let Some((a, text)) = self.is {
            a.is(&text)
        } else if let Some(input) = self.scale {
            let [lo, hi] = self.range.ok_or_else(|| E::missing_field("range"))?;
            domain(input.scale(lo..=hi)).into()
        } else if let Some(input) = self.colormap {
            let map = self.map.ok_or_else(|| E::missing_field("map"))?;
            domain(input.colormap(map)).into()
        } else if let Some(units) = self.units {
            let px = [self.at_least.unwrap_or(0.0).max(0.0), self.at_most.unwrap_or(f32::INFINITY).max(0.0)];
            return Ok(Decoded::Units(units, px));
        } else {
            unreachable!("one kind is set")
        };
        Ok(Decoded::Expr(expr))
    }
}

/// The unary operations by name.
const UNARY: &[(&str, Unary)] = &[
    ("neg", Unary::Neg),
    ("not", Unary::Not),
    ("abs", Unary::Abs),
    ("sqrt", Unary::Sqrt),
    ("sin", Unary::Sin),
    ("cos", Unary::Cos),
    ("floor", Unary::Floor),
    ("ln", Unary::Ln),
    ("exp", Unary::Exp),
];

/// The binary operations by name.
const BINARY: &[(&str, Binary)] = &[
    ("add", Binary::Add),
    ("sub", Binary::Sub),
    ("mul", Binary::Mul),
    ("div", Binary::Div),
    ("rem", Binary::Rem),
    ("pow", Binary::Pow),
    ("min", Binary::Min),
    ("max", Binary::Max),
    ("lt", Binary::Lt),
    ("le", Binary::Le),
    ("gt", Binary::Gt),
    ("ge", Binary::Ge),
    ("eq", Binary::Eq),
    ("ne", Binary::Ne),
    ("and", Binary::And),
    ("or", Binary::Or),
];

/// The view state an expression reads, by name.
const STATES: &[(&str, State)] = &[
    ("selected", State::Selected),
    ("hovered", State::Hovered),
    ("pointer", State::Pointer),
    ("elapsed", State::Elapsed),
    ("zoom", State::Zoom),
];

/// The value `name` names in `table`, or an error listing the names.
fn by_name<T: Copy, E: de::Error>(table: &[(&str, T)], what: &str, name: &str) -> Result<T, E> {
    table.iter().find(|(n, _)| *n == name).map(|&(_, value)| value).ok_or_else(|| {
        let names: Vec<&str> = table.iter().map(|(n, _)| *n).collect();
        E::custom(format!("unknown {what} `{name}`, expected one of {}", names.join(", ")))
    })
}

fn operation<E: de::Error>(op: &str, args: &[Expr]) -> Result<Expr, E> {
    if let Some(&(_, unary)) = UNARY.iter().find(|(name, _)| *name == op) {
        let [a] = args else { return Err(E::invalid_length(args.len(), &"one argument")) };
        return Ok(node(Node::Unary(unary, a.clone())));
    }
    if let Some(&(_, binary)) = BINARY.iter().find(|(name, _)| *name == op) {
        let [a, b] = args else { return Err(E::invalid_length(args.len(), &"two arguments")) };
        return Ok(node(Node::Binary(binary, a.clone(), b.clone())));
    }
    let names: Vec<&str> = UNARY.iter().map(|(name, _)| *name).chain(BINARY.iter().map(|(name, _)| *name)).collect();
    Err(E::custom(format!("unknown op `{op}`, expected one of {}", names.join(", "))))
}

/// The names of `table`, for a schema's `enum`.
fn names<T>(table: &[(&str, T)]) -> Vec<serde_json::Value> {
    table.iter().map(|(name, _)| json!(name)).collect()
}

/// A fixed-length array of `items`.
fn tuple(items: &[serde_json::Value]) -> serde_json::Value {
    json!({ "type": "array", "prefixItems": items, "minItems": items.len(), "maxItems": items.len() })
}

/// An object of exactly `properties`, those in `required` required.
fn object(properties: serde_json::Value, required: &[&str]) -> serde_json::Value {
    let mut object = json!({ "type": "object", "required": required, "additionalProperties": false });
    object["properties"] = properties;
    object
}

/// `value` as a schema.
fn schema(value: serde_json::Value) -> Schema {
    Schema::try_from(value).expect("a schema object")
}

impl JsonSchema for Expr {
    fn schema_name() -> Cow<'static, str> {
        "Expr".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let expr = serde_json::Value::from(generator.subschema_for::<Expr>());
        let color = serde_json::Value::from(generator.subschema_for::<Color>());
        let colormap = serde_json::Value::from(generator.subschema_for::<Colormap>());
        let number = json!({ "type": "number" });
        let domain = tuple(&[number.clone(), number.clone()]);
        schema(json!({
            "description": "A value for every row of a mark: a constant, a field, view state, or arithmetic of them.",
            "tsType": "ExprInput",
            "anyOf": [
                number,
                { "type": "boolean" },
                { "type": "string", "description": "A field's name, or a hex color when it starts with `#`." },
                object(json!({ "field": { "type": "string" }, "of": tuple(&[json!({ "type": "string" }), json!({ "type": "string" })]), "step": { "type": "boolean" } }), &["field"]),
                object(json!({ "color": color }), &["color"]),
                object(json!({ "state": { "enum": names(STATES) } }), &["state"]),
                object(json!({ "missing": { "const": true } }), &["missing"]),
                object(json!({ "op": { "enum": names(UNARY) }, "args": tuple(std::slice::from_ref(&expr)) }), &["op", "args"]),
                object(json!({ "op": { "enum": names(BINARY) }, "args": tuple(&[expr.clone(), expr.clone()]) }), &["op", "args"]),
                object(json!({ "is": tuple(&[expr.clone(), json!({ "type": "string" })]) }), &["is"]),
                object(json!({ "when": { "type": "array", "items": tuple(&[expr.clone(), expr.clone()]) }, "otherwise": expr }), &["when", "otherwise"]),
                object(json!({ "colormap": expr, "map": colormap, "domain": domain }), &["colormap", "map"]),
                object(json!({ "scale": expr, "range": domain, "domain": domain }), &["scale", "range"]),
            ],
        }))
    }
}

impl JsonSchema for Size {
    fn schema_name() -> Cow<'static, str> {
        "Size".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let expr = serde_json::Value::from(generator.subschema_for::<Expr>());
        schema(json!({
            "description": "A size: CSS pixels, or position units with `units`.",
            "tsType": "Size",
            "anyOf": [
                expr.clone(),
                object(
                    json!({
                        "units": expr,
                        "atLeast": { "type": "number", "minimum": 0, "description": "CSS pixels it keeps at least, however far the view zooms out." },
                        "atMost": { "type": "number", "minimum": 0, "description": "CSS pixels it keeps at most, however far the view zooms in." },
                    }),
                    &["units"],
                ),
            ],
        }))
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
        schema(json!({
            "description": "A CSS color, such as `#ffb000` or `rebeccapurple`.",
            "tsType": "Color",
            "type": "string",
        }))
    }
}

impl JsonSchema for Colormap {
    fn schema_name() -> Cow<'static, str> {
        "Colormap".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let color = serde_json::Value::from(generator.subschema_for::<Color>());
        // npm names the kinds as a type of their own.
        generator.subschema_for::<ColormapKind>();
        let names: Vec<&str> = super::colormap::catalog().collect();
        generator.definitions_mut().insert(
            "ColormapName".into(),
            json!({ "description": "A colormap of the catalog.", "type": "string", "enum": names }),
        );
        let placed = json!({
            "type": "array",
            "prefixItems": [{ "type": "number", "minimum": 0, "maximum": 1 }, color],
            "minItems": 2,
            "maxItems": 2,
        });
        let stops = json!({
            "type": "array",
            "items": { "anyOf": [color, placed] },
            "minItems": 1,
            "description": "Colors blended in OKLab, each at its `[place, color]` from 0 to 1 or evenly between its neighbors, as in a CSS gradient.",
        });
        let categories = json!({ "type": "array", "items": color, "minItems": 1, "maxItems": 256, "description": "A color per category: category `i` takes color `i`." });
        let continuous = json!({ "enum": ["sequential", "diverging", "cyclic"] });
        let names = json!({ "type": "array", "items": { "type": "string" }, "description": "The categories' names, in order, for a legend." });
        schema(json!({
            "description": "Colors for a range of values: a catalog name, or your own colors.",
            "anyOf": [
                { "$ref": "#/$defs/ColormapName" },
                object(json!({ "kind": continuous, "colors": stops }), &["kind", "colors"]),
                object(json!({ "kind": { "const": "categorical" }, "colors": categories, "categories": names }), &["kind", "colors"]),
            ],
        }))
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
        assert_eq!(
            parse(r##"{"when": [[{"state": "selected"}, {"color": "#ff0000"}]], "otherwise": "c"}"##),
            when(selected()).then(Color::rgb(1.0, 0.0, 0.0)).otherwise(field("c"))
        );
        assert_eq!(
            parse(r#"{"colormap": "vm", "map": "balance", "domain": [0.9, 1.1]}"#),
            field("vm").colormap(Colormap::BALANCE).domain(0.9..=1.1).into()
        );
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
        assert!(error.to_string().contains("exactly one"), "{error}");
        let error = serde_json::from_str::<Expr>(r#"{"op": "frob", "args": []}"#).expect_err("unknown op");
        assert!(error.to_string().contains("frob"), "{error}");
        let error = serde_json::from_str::<Colormap>(r#"{"kind": "cyclic", "colors": [[0.5, "red"], [0.2, "blue"]]}"#)
            .expect_err("descending places");
        assert!(error.to_string().contains("ascend"), "{error}");
    }
}
