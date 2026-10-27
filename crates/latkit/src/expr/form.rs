//! JSON forms of expressions, colors, sizes, and colormaps. A number or boolean is a constant, a
//! string is a field name, and an object is one node whose key names its kind. In a color option (a
//! [`Paint`]), a string is a CSS color instead, and a conditional's values are colors:
//!
//! | Form                                                          | Builder                           |
//! | ------------------------------------------------------------- | --------------------------------- |
//! | `{ "field": "x", "from": ["data", "Table"], "step": true }`   | `field("x").from_table(..).step()` |
//! | `{ "color": "#ffb000" }`                                      | a color                           |
//! | `{ "state": "selected" }`                                     | `selected()`, `hovered()`, …      |
//! | `{ "missing": true }`                                         | `Expr::missing()`                 |
//! | `{ "op": "add", "args": [a, b] }`                             | `a + b`, `a.min(b)`, `!a`, …      |
//! | `{ "when": [[c, v], …], "otherwise": e }`                     | `when(c).then(v)…otherwise(e)`    |
//! | `{ "is": [a, "text"] }`, `{ "contains": [a, "text"] }`        | `a.is("text")`, `a.contains(..)`  |
//! | `{ "scale": [0, 1], "value": a, "domain": [lo, hi] }`         | `a.scale(..).domain(..)`          |
//! | `{ "colormap": "viridis", "value": a, "domain": [lo, hi] }`   | `a.colormap(..).domain(..)`       |
//! | `{ "px": a }` (sizes only)                                    | `px(a)`                           |
//! | `{ "units": a, "atLeast": 2, "atMost": 20 }` (sizes only)     | `units(a).at_least(..)`           |
//!
//! An object may have only its kind's keys; a key of another kind is an error. A colormap is a
//! catalog name or `{ "kind": "sequential", "colors": ["black", [0.2, "red"], "white"] }`, where a
//! `[place, color]` pair places a color and `categories` names a categorical map's colors.

use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, IntoDeserializer, MapAccess, SeqAccess, Visitor};

use super::{Binary, Color, Colormap, ColormapKind, Expr, Node, Paint, Size, State, Stop, Unary, Unit, node};
use crate::Name;

impl<'de> Deserialize<'de> for Expr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Expr, D::Error> {
        Written::deserialize(deserializer)?.expr().map_err(de::Error::custom)
    }
}

impl<'de> Deserialize<'de> for Paint {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Paint, D::Error> {
        Written::deserialize(deserializer)?.paint().map(Paint).map_err(de::Error::custom)
    }
}

/// The JSON of an expression, color, size, or label, before its meaning is known: a constant, a
/// string, or an object whose keys decide its kind once all are read. The caller decides what a
/// string means: a field name, or in a color option a CSS color.
pub(crate) enum Written {
    Constant(Expr),
    Text(String),
    Object(Box<Form>),
}

impl Written {
    /// The expression this JSON describes; a string names a field.
    pub(crate) fn expr(self) -> Result<Expr, String> {
        match self {
            Written::Constant(expr) => Ok(expr),
            Written::Text(name) => Ok(super::field(name)),
            Written::Object(form) => form.expr(),
        }
    }

    /// The color this JSON describes, as a color option reads it: a string is a CSS color, and a
    /// conditional's values are colors.
    pub(crate) fn paint(self) -> Result<Expr, String> {
        match self {
            Written::Constant(expr) => Ok(expr),
            Written::Text(css) => Color::css(&css)
                .map(Expr::from)
                .ok_or_else(|| format!("not a CSS color: {css:?}; for a field, use field({css:?})")),
            Written::Object(form) => form.paint(),
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
        f.write_str("a number, a boolean, a text, or an expression object")
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

/// Declares `Form` and `Form::held` from one list of keys, each with its JSON spelling.
macro_rules! form {
    ($($vis:vis $key:ident $json:literal: $ty:ty),+ $(,)?) => {
        /// Every key that an expression object, a size, or label options can have; each kind
        /// accepts only its own keys. A conditional's values are read as the caller decides.
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        pub(crate) struct Form {
            $(#[serde(rename = $json)] $vis $key: Option<$ty>,)+
        }

        impl Form {
            /// The keys present, as JSON spells them.
            fn held(&self) -> Vec<&'static str> {
                let mut held = Vec::new();
                $(if self.$key.is_some() {
                    held.push($json);
                })+
                held
            }
        }
    };
}

form! {
    field "field": Name,
    color "color": Written,
    state "state": State,
    missing "missing": bool,
    op "op": String,
    when "when": Vec<(Expr, Written)>,
    is "is": (Expr, String),
    contains "contains": (Expr, String),
    scale "scale": [f64; 2],
    colormap "colormap": Colormap,
    from "from": (Name, Name),
    step "step": bool,
    args "args": Vec<Expr>,
    otherwise "otherwise": Written,
    value "value": Expr,
    domain "domain": [f64; 2],
    pub(crate) px "px": Expr,
    pub(crate) units "units": Expr,
    pub(crate) at_least "atLeast": f32,
    pub(crate) at_most "atMost": f32,
    pub(crate) text "text": Expr,
    pub(crate) size "size": f32,
    pub(crate) priority "priority": Expr,
    pub(crate) max_width "maxWidth": f32,
    pub(crate) font "font": Arc<str>,
    pub(crate) max "max": u32,
}

impl Form {
    /// Errors unless every key present is one of `keys`, naming `what` and the first other key.
    pub(crate) fn only(&self, what: &str, keys: &[&str]) -> Result<(), String> {
        match self.held().into_iter().find(|key| !keys.contains(key)) {
            Some(key) => Err(format!("{what} takes no {key}")),
            None => Ok(()),
        }
    }

    /// A label's color, as a color option reads it.
    pub(crate) fn color(&mut self) -> Result<Option<Expr>, String> {
        self.color.take().map(Written::paint).transpose()
    }

    /// The color this object describes, as a color option reads it: a conditional's values are
    /// colors, and any other object is an expression, which must produce a color.
    pub(crate) fn paint(self) -> Result<Expr, String> {
        if self.when.is_none() {
            return self.expr();
        }
        self.conditional(Written::paint)
    }

    /// The conditional this object describes, each value read by `value`.
    fn conditional(self, value: fn(Written) -> Result<Expr, String>) -> Result<Expr, String> {
        self.only("when", &["when", "otherwise"])?;
        let otherwise = value(self.otherwise.ok_or("when needs otherwise")?)?;
        let cases = self.when.expect("present");
        cases.into_iter().rev().try_fold(otherwise, |rest, (c, v)| Ok(node(Node::When(c, value(v)?, rest))))
    }

    /// The expression this object describes. Its kind is that of its first kind key, and it may
    /// have only that kind's keys.
    pub(crate) fn expr(self) -> Result<Expr, String> {
        let held = self.held();
        let Some(own) = held.iter().find_map(|key| KINDS.iter().find(|keys| keys[0] == *key)) else {
            let mut kinds: Vec<&str> = KINDS.iter().map(|keys| keys[0]).collect();
            kinds.dedup();
            return Err(format!("an expression object needs one of {}", kinds.join(", ")));
        };
        let kind = own[0];
        self.only(kind, own)?;
        if kind == "when" {
            return self.conditional(Written::expr);
        }
        let Form { field, color, state, missing, op, is, contains, scale, colormap, .. } = self;
        let needs = |key: &str| format!("{kind} needs {key}");
        Ok(match kind {
            "field" => {
                let expr = super::field(field.expect("present"));
                let expr = match self.from {
                    Some((data, table)) => expr.from_table(data, table),
                    None => expr,
                };
                if self.step == Some(true) { expr.step() } else { expr }
            }
            "color" => match color {
                Some(Written::Text(css)) => Color::css(&css).ok_or_else(|| format!("not a CSS color: {css:?}"))?.into(),
                _ => return Err("color must be a CSS color".to_owned()),
            },
            "state" => node(Node::State(state.expect("present"))),
            "missing" => {
                if missing != Some(true) {
                    return Err("missing must be true".to_owned());
                }
                Expr::missing()
            }
            "op" => {
                let op = op.expect("present");
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
            "is" => {
                let (a, text) = is.expect("present");
                a.is(&text)
            }
            "contains" => {
                let (a, text) = contains.expect("present");
                a.contains(&text)
            }
            "scale" => {
                let [lo, hi] = scale.expect("present");
                domained(self.value.ok_or_else(|| needs("a value"))?.scale(lo..=hi), self.domain)
            }
            _ => {
                let value = self.value.ok_or_else(|| needs("a value"))?;
                domained(value.colormap(colormap.expect("present")), self.domain)
            }
        })
    }
}

/// `mapped` with `domain` when given, else fitted to the values shown.
fn domained(mapped: super::Mapped, domain: Option<[f64; 2]>) -> Expr {
    match domain {
        Some([lo, hi]) => mapped.domain(lo..=hi).into(),
        None => mapped.into(),
    }
}

/// Declares each kind of expression object once: a struct for its JSON schema, never built because
/// reading goes through `Form`, and the keys an object of that kind may have, its own key first.
macro_rules! kinds {
    ($($(#[$meta:meta])* $node:ident { $($(#[$attr:meta])* $key:ident: $ty:ty),+ $(,)? })+) => {
        $(
            $(#[$meta])*
            #[derive(JsonSchema)]
            #[expect(dead_code, reason = "used for its schema only; `Form` reads expressions")]
            #[serde(deny_unknown_fields)]
            struct $node {
                $($(#[$attr])* $key: $ty,)+
            }
        )+

        /// Each kind's keys, its own key first.
        const KINDS: &[&[&str]] = &[$(&[$(stringify!($key)),+]),+];

        /// Each kind's schema, in `KINDS` order.
        fn kinds(generator: &mut SchemaGenerator) -> Vec<Schema> {
            vec![$(generator.subschema_for::<$node>()),+]
        }
    };
}

kinds! {
    /// A field's value in each row: from the mark's own table, or with `from`, from another
    /// dataset's table joined by row id.
    FieldNode {
        /// The field's name.
        field: Name,
        /// The dataset and table the field is read from, joined by row id.
        #[serde(default)]
        #[schemars(extend("tsType" = "[data: string, table: string]"))]
        from: Option<(Name, Name)>,
        /// For a sampled field, reads the last frame at or before the shown coordinate instead of
        /// interpolating. Default `false`.
        #[serde(default)]
        step: bool,
    }
    /// A constant color.
    ColorNode {
        color: Color,
    }
    /// View state of each row, such as whether it is selected.
    StateNode {
        /// The state read.
        state: State,
    }
    /// A missing value. An option that evaluates to missing uses the theme's value.
    MissingNode {
        /// Always `true`.
        #[schemars(extend("const" = true))]
        missing: bool,
    }
    /// A one-argument operation, such as `{ "op": "abs", "args": ["x"] }`.
    UnaryNode {
        /// The operation.
        op: Unary,
        /// Its argument.
        args: [Expr; 1],
    }
    /// A two-argument operation, such as `{ "op": "add", "args": ["a", 1] }`.
    BinaryNode {
        /// The operation.
        op: Binary,
        /// Its arguments, left and right.
        args: [Expr; 2],
    }
    /// The value of the first case whose condition holds, else `otherwise`.
    WhenNode {
        /// The cases, as `[condition, value]` pairs tried in order.
        #[schemars(extend("tsType" = "[condition: ExprInput, value: ExprInput][]"))]
        when: Vec<(Expr, Expr)>,
        /// The value where no condition holds.
        otherwise: Expr,
    }
    /// Whether a text field equals a text exactly.
    IsNode {
        /// The text field, and the text it must equal.
        #[schemars(extend("tsType" = "[field: ExprInput, text: string]"))]
        is: (Expr, String),
    }
    /// Whether a text field contains a text, ignoring case. In a mark, the field must belong to the
    /// mark's own table.
    ContainsNode {
        /// The text field, and the text it must contain.
        #[schemars(extend("tsType" = "[field: ExprInput, text: string]"))]
        contains: (Expr, String),
    }
    /// A value mapped linearly onto a range, clamped to the range.
    ScaleNode {
        /// The range.
        #[schemars(extend("tsType" = "[low: number, high: number]"))]
        scale: [f64; 2],
        /// The value mapped.
        value: Expr,
        /// The values mapped to the range's ends; the extent of the values shown when unset.
        #[serde(default)]
        #[schemars(extend("tsType" = "[low: number, high: number]"))]
        domain: Option<[f64; 2]>,
    }
    /// A value mapped through a colormap.
    ColormapNode {
        /// The colormap.
        colormap: Colormap,
        /// The value mapped. A categorical map takes each value's integer part as its category.
        value: Expr,
        /// The values mapped to the colormap's ends; the extent of the values shown when unset. A
        /// categorical map ignores it.
        #[serde(default)]
        #[schemars(extend("tsType" = "[low: number, high: number]"))]
        domain: Option<[f64; 2]>,
    }
}

/// A size in CSS pixels, regardless of the space's unit.
#[derive(JsonSchema)]
#[expect(dead_code, reason = "used for its schema only; `Form` reads sizes")]
#[serde(deny_unknown_fields)]
struct Px {
    /// The size, in CSS pixels.
    px: Expr,
}

/// A size in position units (degrees on the earth), regardless of the space's unit, so it scales
/// as the view zooms. `atLeast` and `atMost` bound it in CSS pixels.
#[derive(JsonSchema)]
#[expect(dead_code, reason = "used for its schema only; `Form` reads sizes")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(clippy::struct_field_names, reason = "its JSON is `{units, atLeast, atMost}`")]
struct Units {
    /// The size, in position units.
    units: Expr,
    /// The minimum on-screen size in CSS pixels, however far the view zooms out.
    #[serde(default)]
    #[schemars(range(min = 0))]
    at_least: Option<f32>,
    /// The maximum on-screen size in CSS pixels, however far the view zooms in.
    #[serde(default)]
    #[schemars(range(min = 0))]
    at_most: Option<f32>,
}

/// An expression's schema is `ExprNode`; its TypeScript type also accepts the builders.
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

/// The JSON form of an expression.
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
            json_schema!({ "type": "string", "description": "A field's name." }),
        ];
        any.extend(forms);
        json_schema!({
            "description": "A value for each row: a number, a boolean, a field's name, or a node that computes one.",
            "anyOf": any,
        })
    }
}

/// A conditional color: the color of the first case whose condition holds, else `otherwise`.
#[derive(JsonSchema)]
#[expect(dead_code, reason = "used for its schema only; `Form` reads colors")]
#[serde(deny_unknown_fields)]
struct WhenPaintNode {
    /// The cases, as `[condition, color]` pairs tried in order.
    #[schemars(extend("tsType" = "[condition: ExprInput, color: PaintInput][]"))]
    when: Vec<(Expr, Paint)>,
    /// The color where no condition holds.
    otherwise: Paint,
}

/// A color option's schema is `PaintNode`; its TypeScript type also accepts the builders.
impl JsonSchema for Paint {
    fn schema_name() -> Cow<'static, str> {
        "Paint".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = generator.subschema_for::<PaintNode>();
        schema.insert("tsType".into(), "PaintInput".into());
        schema
    }
}

/// The JSON form of a color option.
struct PaintNode;

impl JsonSchema for PaintNode {
    fn schema_name() -> Cow<'static, str> {
        "PaintNode".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let any = vec![
            generator.subschema_for::<Color>(),
            generator.subschema_for::<ColorNode>(),
            generator.subschema_for::<ColormapNode>(),
            generator.subschema_for::<WhenPaintNode>(),
            generator.subschema_for::<MissingNode>(),
        ];
        json_schema!({
            "description": "A color for each row: a CSS color, a value through a colormap, or a conditional choosing between colors.",
            "anyOf": any,
        })
    }
}

impl<'de> Deserialize<'de> for Size {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Size, D::Error> {
        let size = |written: Written| match written {
            Written::Object(form) if form.px.is_some() => {
                form.only("a size in CSS pixels", &["px"])?;
                Ok(Size { expr: form.px.expect("present"), unit: Some(Unit::Px), px: Size::ANY })
            }
            Written::Object(form) if form.units.is_some() => {
                form.only("a size in units", &["units", "atLeast", "atMost"])?;
                let px = [form.at_least.unwrap_or(0.0).max(0.0), form.at_most.unwrap_or(f32::INFINITY)];
                Ok(Size { expr: form.units.expect("present"), unit: Some(Unit::Units), px })
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
        let px = generator.subschema_for::<Px>();
        let units = generator.subschema_for::<Units>();
        json_schema!({
            "description": "A size: a value in the space's unit (units in a diagram, CSS pixels elsewhere), `{ px }` in CSS pixels, or `{ units }` in position units (degrees on the earth), which grow on screen as the view zooms in.",
            "anyOf": [expr, px, units],
        })
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Color, D::Error> {
        let css = String::deserialize(deserializer)?;
        Color::css(&css).ok_or_else(|| de::Error::custom(format!("not a CSS color: {css:?}")))
    }
}

/// Writes a color as CSS `rgba(…)` that reads back exactly: channels as byte values, fractional
/// where needed, and alpha unchanged.
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

/// A custom colormap: its kind, its colors, and for a categorical map, its category names.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CustomColormap {
    /// How the colors map values.
    kind: ColormapKind,
    /// The colors, blended in OKLab. Each is a color, spaced evenly between its neighbors as in a
    /// CSS gradient, or a `[place, color]` pair with a place from 0 to 1, in ascending order. A
    /// categorical map takes one color per category, without places, at most 256.
    colors: Vec<Stop>,
    /// The category names in category order, shown in legends. Categorical maps only.
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
        let names: Vec<&str> = Colormap::catalog().filter_map(|map| map.name()).collect();
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

    fn paint(json: &str) -> Result<Expr, String> {
        serde_json::from_str::<Paint>(json).map(|paint| paint.0).map_err(|e| e.to_string())
    }

    #[test]
    fn forms_match_builders() {
        assert_eq!(parse("\"vm\""), field("vm"));
        assert_eq!(parse("\"#ff0000\""), field("#ff0000"), "a text in a value is a field's name");
        assert_eq!(parse("2.5"), Expr::from(2.5));
        assert_eq!(parse(r#"{"op": "add", "args": ["a", 1]}"#), field("a") + 1.0);
        assert_eq!(parse(r#"{"op": "not", "args": ["on"]}"#), !field("on"));
        assert_eq!(
            parse(r##"{"when": [[{"state": "selected"}, {"color": "#ff0000"}]], "otherwise": "c"}"##),
            when(selected()).then(Color::rgb(1.0, 0.0, 0.0)).otherwise(field("c"))
        );
        assert_eq!(
            parse(r#"{"field": "vm", "from": ["weather", "Station"], "step": true}"#),
            field("vm").from_table("weather", "Station").step()
        );
        assert_eq!(
            parse(r#"{"colormap": "balance", "value": "vm", "domain": [0.9, 1.1]}"#),
            field("vm").colormap(Colormap::BALANCE).domain(0.9..=1.1).into()
        );
        assert_eq!(parse(r#"{"scale": [2, 8], "value": "kv"}"#), field("kv").scale(2.0..=8.0).into());
        assert_eq!(parse(r#"{"contains": ["name", "lake"]}"#), field("name").contains("lake"));
        let size = |json: &str| serde_json::from_str::<Size>(json).expect("a size");
        assert_eq!(size("3"), Size::from(3.0));
        assert_eq!(size(r#"{"px": 3}"#), crate::px(3.0));
        assert_eq!(size(r#"{"units": 3}"#), crate::units(3.0));
        assert_eq!(size(r#"{"units": 3, "atLeast": 2, "atMost": 20}"#), crate::units(3.0).at_least(2.0).at_most(20.0));
        assert!(serde_json::from_str::<Size>(r#"{"px": 3, "atLeast": 2}"#).is_err(), "px sizes take no bounds");
        let map: Colormap =
            serde_json::from_str(r#"{"kind": "sequential", "colors": ["black", [0.25, "red"], "white"]}"#)
                .expect("a map");
        let stops = [Stop::from(Color::BLACK), (0.25, Color::rgb(1.0, 0.0, 0.0)).into(), Color::WHITE.into()];
        assert_eq!(map, Colormap::new(ColormapKind::Sequential, stops).unwrap());
    }

    #[test]
    fn a_text_in_a_color_is_a_css_color() {
        let red = Expr::from(Color::rgb(1.0, 0.0, 0.0));
        assert_eq!(paint("\"red\""), Ok(red.clone()));
        assert_eq!(paint("\"#ff0000\""), Ok(red.clone()));
        let error = paint("\"kv\"").expect_err("a field's name");
        assert!(error.starts_with(r#"not a CSS color: "kv"; for a field, use field("kv")"#), "{error}");
        // A conditional's values are colors and its conditions are values; a colormap's input is a
        // value.
        let chosen = paint(r#"{"when": [["on", "red"]], "otherwise": {"colormap": "viridis", "value": "kv"}}"#);
        let mapped = field("kv").colormap(Colormap::VIRIDIS);
        assert_eq!(chosen, Ok(when(field("on")).then(Color::rgb(1.0, 0.0, 0.0)).otherwise(mapped)));
        assert_eq!(paint(r#"{"field": "kv"}"#), Ok(field("kv")), "a field parses here and must compile to a color");
    }

    #[test]
    fn errors_name_the_offending_part() {
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
