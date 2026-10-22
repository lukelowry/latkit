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
use std::fmt;
use std::sync::Arc;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, IntoDeserializer, MapAccess, SeqAccess, Visitor};

use super::{Binary, Color, Colormap, ColormapKind, Expr, Node, Size, State, Stop, Unary, node};
use crate::Name;

impl<'de> Deserialize<'de> for Expr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Expr, D::Error> {
        Written::deserialize(deserializer)?.expr().map_err(de::Error::custom)
    }
}

/// What an expression, a size, or a label is written as, read where it is written: a constant, a
/// text, or an object, whose keys say what it is once all are read.
pub(crate) enum Written {
    Constant(Expr),
    Text(String),
    Object(Box<Form>),
}

impl Written {
    /// The expression it writes: a text names a field, or a color when it starts with `#`.
    pub(crate) fn expr(self) -> Result<Expr, String> {
        match self {
            Written::Constant(expr) => Ok(expr),
            Written::Text(text) if text.starts_with('#') => {
                Color::hex(&text).map(Expr::from).ok_or_else(|| format!("not a hex color: {text:?}"))
            }
            Written::Text(name) => Ok(super::field(name)),
            Written::Object(form) => form.expr(),
        }
    }
}

impl<'de> Deserialize<'de> for Written {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Written, D::Error> {
        deserializer.deserialize_any(Reading)
    }
}

struct Reading;

impl<'de> Visitor<'de> for Reading {
    type Value = Written;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a number, a boolean, a field's name, or an expression object")
    }

    fn visit_bool<E: de::Error>(self, b: bool) -> Result<Written, E> {
        Ok(Written::Constant(b.into()))
    }

    fn visit_i64<E: de::Error>(self, n: i64) -> Result<Written, E> {
        Ok(Written::Constant((n as f64).into()))
    }

    fn visit_u64<E: de::Error>(self, n: u64) -> Result<Written, E> {
        Ok(Written::Constant((n as f64).into()))
    }

    fn visit_f64<E: de::Error>(self, n: f64) -> Result<Written, E> {
        Ok(Written::Constant(n.into()))
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Written, E> {
        Ok(Written::Text(text.to_owned()))
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Written, A::Error> {
        Form::deserialize(MapAccessDeserializer::new(map)).map(|form| Written::Object(Box::new(form)))
    }
}

/// Every key an expression object, a size in units, or a label's options hold; each kind's own
/// alone make it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Form {
    field: Option<Name>,
    color: Option<Written>,
    state: Option<State>,
    missing: Option<bool>,
    op: Option<String>,
    when: Option<Vec<(Expr, Expr)>>,
    is: Option<(Expr, String)>,
    contains: Option<(Expr, String)>,
    scale: Option<[f64; 2]>,
    colormap: Option<Colormap>,
    of: Option<(Name, Name)>,
    step: Option<bool>,
    args: Option<Vec<Expr>>,
    otherwise: Option<Expr>,
    value: Option<Expr>,
    domain: Option<[f64; 2]>,
    pub(crate) units: Option<Expr>,
    pub(crate) at_least: Option<f32>,
    pub(crate) at_most: Option<f32>,
    pub(crate) text: Option<Expr>,
    pub(crate) size: Option<f32>,
    pub(crate) priority: Option<Expr>,
    pub(crate) max_width: Option<f32>,
    pub(crate) font: Option<Arc<str>>,
    pub(crate) max: Option<u32>,
}

impl Form {
    /// The keys it holds, as written.
    fn held(&self) -> Vec<&'static str> {
        [
            ("field", self.field.is_some()),
            ("color", self.color.is_some()),
            ("state", self.state.is_some()),
            ("missing", self.missing.is_some()),
            ("op", self.op.is_some()),
            ("when", self.when.is_some()),
            ("is", self.is.is_some()),
            ("contains", self.contains.is_some()),
            ("scale", self.scale.is_some()),
            ("colormap", self.colormap.is_some()),
            ("of", self.of.is_some()),
            ("step", self.step.is_some()),
            ("args", self.args.is_some()),
            ("otherwise", self.otherwise.is_some()),
            ("value", self.value.is_some()),
            ("domain", self.domain.is_some()),
            ("units", self.units.is_some()),
            ("atLeast", self.at_least.is_some()),
            ("atMost", self.at_most.is_some()),
            ("text", self.text.is_some()),
            ("size", self.size.is_some()),
            ("priority", self.priority.is_some()),
            ("maxWidth", self.max_width.is_some()),
            ("font", self.font.is_some()),
            ("max", self.max.is_some()),
        ]
        .into_iter()
        .filter_map(|(key, held)| held.then_some(key))
        .collect()
    }

    /// Why it is not `what`, holding only `keys`: the first other key it holds.
    pub(crate) fn only(&self, what: &str, keys: &[&str]) -> Result<(), String> {
        match self.held().into_iter().find(|key| !keys.contains(key)) {
            Some(key) => Err(format!("{what} has no {key}")),
            None => Ok(()),
        }
    }

    /// Its color: an expression's, or a label's.
    pub(crate) fn color(&mut self) -> Result<Option<Expr>, String> {
        self.color.take().map(Written::expr).transpose()
    }

    /// The expression it writes: the first kind it holds, and only that kind's keys.
    pub(crate) fn expr(self) -> Result<Expr, String> {
        let held = self.held();
        let Some(own) = held.iter().find_map(|key| KINDS.iter().find(|keys| keys[0] == *key)) else {
            let mut kinds: Vec<&str> = KINDS.iter().map(|keys| keys[0]).collect();
            kinds.dedup();
            return Err(format!("an expression object has one of {}", kinds.join(", ")));
        };
        let kind = own[0];
        self.only(kind, own)?;
        let Form { field, color, state, missing, op, when, is, contains, scale, colormap, .. } = self;
        let needs = |key: &str| format!("{kind} needs {key}");
        Ok(match kind {
            "field" => {
                let expr = super::field(field.expect("held"));
                let expr = match self.of {
                    Some((data, table)) => expr.of(data, table),
                    None => expr,
                };
                if self.step == Some(true) { expr.step() } else { expr }
            }
            "color" => match color {
                Some(Written::Text(css)) => Color::css(&css).ok_or_else(|| format!("not a CSS color: {css:?}"))?.into(),
                _ => return Err("a color is a CSS color".to_owned()),
            },
            "state" => node(Node::State(state.expect("held"))),
            "missing" => {
                if missing != Some(true) {
                    return Err("missing is true".to_owned());
                }
                Expr::missing()
            }
            "op" => {
                let op = op.expect("held");
                let args = self.args.ok_or_else(|| needs("args"))?;
                let name = || IntoDeserializer::<de::value::Error>::into_deserializer(op.as_str());
                if let Ok(unary) = Unary::deserialize(name()) {
                    let [a] =
                        <[Expr; 1]>::try_from(args).map_err(|a| format!("{op} takes 1 argument, not {}", a.len()))?;
                    node(Node::Unary(unary, a))
                } else {
                    let binary = Binary::deserialize(name()).map_err(|_| format!("no op {op:?}"))?;
                    let [a, b] =
                        <[Expr; 2]>::try_from(args).map_err(|a| format!("{op} takes 2 arguments, not {}", a.len()))?;
                    node(Node::Binary(binary, a, b))
                }
            }
            "when" => {
                let otherwise = self.otherwise.ok_or_else(|| needs("otherwise"))?;
                when.expect("held").into_iter().rev().fold(otherwise, |rest, (c, v)| node(Node::When(c, v, rest)))
            }
            "is" => {
                let (a, text) = is.expect("held");
                a.is(&text)
            }
            "contains" => {
                let (a, text) = contains.expect("held");
                a.contains(&text)
            }
            "scale" => {
                let [lo, hi] = scale.expect("held");
                domained(self.value.ok_or_else(|| needs("a value"))?.scale(lo..=hi), self.domain)
            }
            _ => {
                let value = self.value.ok_or_else(|| needs("a value"))?;
                domained(value.colormap(colormap.expect("held")), self.domain)
            }
        })
    }
}

/// `mapped` with `domain` when given, else fitting the values shown.
fn domained(mapped: super::Mapped, domain: Option<[f64; 2]>) -> Expr {
    match domain {
        Some([lo, hi]) => mapped.domain(lo..=hi).into(),
        None => mapped.into(),
    }
}

/// Each kind of expression object, declared once: the schema of its JSON, which reading never builds,
/// and the keys reading lets an object of that kind hold, its own key first.
macro_rules! kinds {
    ($($(#[$meta:meta])* $node:ident { $($(#[$attr:meta])* $key:ident: $ty:ty),+ $(,)? })+) => {
        $(
            $(#[$meta])*
            #[derive(JsonSchema)]
            #[expect(dead_code, reason = "its schema alone: expressions read through `Form`")]
            #[serde(deny_unknown_fields)]
            struct $node {
                $($(#[$attr])* $key: $ty,)+
            }
        )+

        /// Each kind's keys, its own first, in the order an object's keys name its kind.
        const KINDS: &[&[&str]] = &[$(&[$(stringify!($key)),+]),+];

        /// Each kind's schema, in that order.
        fn kinds(generator: &mut SchemaGenerator) -> Vec<Schema> {
            vec![$(generator.subschema_for::<$node>()),+]
        }
    };
}

kinds! {
    /// A field of each row: of the mark's own table, or of another dataset's table joined by row id.
    FieldNode {
        field: Name,
        /// The dataset and table the field is read from, joined by row id.
        #[serde(default)]
        #[schemars(extend("tsType" = "[data: string, table: string]"))]
        of: Option<(Name, Name)>,
        /// Reads a sampled field at its last frame without interpolating.
        #[serde(default)]
        step: bool,
    }
    ColorNode {
        color: Color,
    }
    /// What the view knows of each row.
    StateNode {
        state: State,
    }
    /// A missing value: options that read one take the theme's.
    MissingNode {
        #[schemars(extend("const" = true))]
        missing: bool,
    }
    UnaryNode {
        op: Unary,
        args: [Expr; 1],
    }
    BinaryNode {
        op: Binary,
        args: [Expr; 2],
    }
    /// The value of the first case whose condition holds, else `otherwise`.
    WhenNode {
        #[schemars(extend("tsType" = "[condition: ExprInput, value: ExprInput][]"))]
        when: Vec<(Expr, Expr)>,
        otherwise: Expr,
    }
    /// Whether a text field equals the text.
    IsNode {
        #[schemars(extend("tsType" = "[field: ExprInput, text: string]"))]
        is: (Expr, String),
    }
    /// Whether a text field holds the text, ignoring case: read by queries, which hold texts.
    ContainsNode {
        #[schemars(extend("tsType" = "[field: ExprInput, text: string]"))]
        contains: (Expr, String),
    }
    /// `value` mapped linearly onto the range `scale`, clamped: from its `domain`, else from the extent of
    /// the values shown.
    ScaleNode {
        #[schemars(extend("tsType" = "[low: number, high: number]"))]
        scale: [f64; 2],
        value: Expr,
        #[serde(default)]
        #[schemars(extend("tsType" = "[low: number, high: number]"))]
        domain: Option<[f64; 2]>,
    }
    /// `value` through `colormap`: from its `domain`, else from the extent of the values shown.
    ColormapNode {
        colormap: Colormap,
        value: Expr,
        #[serde(default)]
        #[schemars(extend("tsType" = "[low: number, high: number]"))]
        domain: Option<[f64; 2]>,
    }
}

/// A size in position units, so it scales as the view zooms, kept within CSS pixels when given.
#[derive(JsonSchema)]
#[expect(dead_code, reason = "its schema alone: expressions read through `Form`")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_field_names, reason = "its JSON is `{units, atLeast, atMost}`")]
struct Units {
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
        let forms = kinds(generator);
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
        let size = |written: Written| match written {
            Written::Object(form) if form.units.is_some() => {
                form.only("a size in units", &["units", "atLeast", "atMost"])?;
                let px = [form.at_least.unwrap_or(0.0).max(0.0), form.at_most.unwrap_or(f32::INFINITY)];
                Ok(Size { expr: form.units.expect("held"), units: true, px })
            }
            written => written.expr().map(Size::from),
        };
        size(Written::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

impl JsonSchema for Size {
    fn schema_name() -> Cow<'static, str> {
        "Size".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let expr = generator.subschema_for::<Expr>();
        let units = generator.subschema_for::<Units>();
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
struct CustomColormap {
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
        struct Reading;

        impl<'de> Visitor<'de> for Reading {
            type Value = Colormap;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a catalog colormap's name, or your own colors")
            }

            fn visit_str<E: de::Error>(self, name: &str) -> Result<Colormap, E> {
                Colormap::named(name).ok_or_else(|| E::custom(format!("no colormap named {name:?}")))
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Colormap, A::Error> {
                let CustomColormap { kind, colors, categories } =
                    CustomColormap::deserialize(MapAccessDeserializer::new(map))?;
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

        deserializer.deserialize_any(Reading)
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
        let colors = generator.subschema_for::<CustomColormap>();
        json_schema!({
            "description": "Colors for a range of values: a catalog name, or your own colors.",
            "anyOf": [{ "$ref": "#/$defs/ColormapName" }, colors],
        })
    }
}

impl<'de> Deserialize<'de> for Stop {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Stop, D::Error> {
        struct Reading;

        impl<'de> Visitor<'de> for Reading {
            type Value = Stop;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a color, or a [place, color] pair")
            }

            fn visit_str<E: de::Error>(self, css: &str) -> Result<Stop, E> {
                Color::css(css).map(Stop::from).ok_or_else(|| E::custom(format!("not a CSS color: {css:?}")))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Stop, A::Error> {
                let at: f32 = seq.next_element()?.ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let color: Color = seq.next_element()?.ok_or_else(|| de::Error::invalid_length(1, &self))?;
                if seq.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::invalid_length(3, &self));
                }
                Ok((at, color).into())
            }
        }

        deserializer.deserialize_any(Reading)
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
