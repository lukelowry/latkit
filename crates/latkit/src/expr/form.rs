//! JSON forms of expressions, sizes, and colormaps. Every value follows one rule: a number or
//! boolean is a constant, `null` is a missing value, a string starting with `$` reads the field it
//! names, any other string is a CSS color, and an object is one node whose key names its kind. A
//! call has one key, which names its operation and holds its arguments:
//!
//! | Form                                                         | Builder                            |
//! | ------------------------------------------------------------ | ---------------------------------- |
//! | `"$x"`                                                       | `field("x")`                       |
//! | `{ "field": "x", "from": ["data", "Table"], "step": true }`  | `field("x").from_table(..).step()` |
//! | `"#ffb000"`, `"rebeccapurple"`                               | a [`Color`]                        |
//! | `null`                                                       | `Expr::missing()`                  |
//! | `{ "state": "selected" }`                                    | `selected()`, `hovered()`, …       |
//! | `{ "add": [a, b] }`, `{ "not": [a] }`                        | `a + b`, `!a`, `a.min(b)`, …       |
//! | `{ "is": [a, "text"] }`, `{ "contains": [a, "text"] }`       | `a.is("text")`, `a.contains(..)`   |
//! | `{ "when": [[c, v], …], "otherwise": e }`                    | `when(c).then(v)…otherwise(e)`     |
//! | `{ "scale": [0, 1], "value": a, "domain": [lo, hi] }`        | `a.scale(..).domain(..)`           |
//! | `{ "colormap": "viridis", "value": a, "domain": [lo, hi] }`  | `a.colormap(..).domain(..)`        |
//! | `{ "px": a }` (sizes only)                                   | `px(a)`                            |
//! | `{ "units": a, "atLeast": 2, "atMost": 20 }` (sizes only)    | `units(a).at_least(..)`            |
//!
//! `neg`, `not`, `abs`, `sqrt`, `sin`, `cos`, `floor`, `ln`, and `exp` take one argument. `add`,
//! `sub`, `mul`, `div`, `rem`, `pow`, `min`, `max`, `lt`, `le`, `gt`, `ge`, `eq`, `ne`, `and`, and
//! `or` take two. `is` and `contains` take a value and a plain text, which is neither a field nor a
//! color. A field whose name starts with `$` is written `{ "field": "$x" }`. An object may have
//! only its kind's keys, and a key of another kind is an error. A colormap is a catalog name or
//! `{ "kind": "sequential", "colors": ["black", [0.2, "red"], "white"] }`. A `[place, color]` pair
//! places a color, and `categories` names a categorical map's colors.

use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, MapAccess, SeqAccess, Visitor};

use super::{Binary, Color, Colormap, ColormapKind, Expr, Node, Size, State, Stop, Unary, Unit, node};
use crate::Name;

impl<'de> Deserialize<'de> for Expr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Expr, D::Error> {
        Written::deserialize(deserializer)?.expr().map_err(de::Error::custom)
    }
}

/// The JSON of an expression, size, or label, before its kind is known: an expression already
/// read, or an object whose keys decide its kind once all are read.
pub(crate) enum Written {
    Expr(Expr),
    Object(Box<Form>),
}

impl Written {
    /// The expression this JSON describes.
    pub(crate) fn expr(self) -> Result<Expr, String> {
        match self {
            Written::Expr(expr) => Ok(expr),
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
        f.write_str("a number, a boolean, null, a field or a color, or an expression object")
    }

    fn visit_bool<E: de::Error>(self, b: bool) -> Result<Written, E> {
        Ok(Written::Expr(b.into()))
    }

    fn visit_i64<E: de::Error>(self, n: i64) -> Result<Written, E> {
        Ok(Written::Expr((n as f64).into()))
    }

    fn visit_u64<E: de::Error>(self, n: u64) -> Result<Written, E> {
        Ok(Written::Expr((n as f64).into()))
    }

    fn visit_f64<E: de::Error>(self, n: f64) -> Result<Written, E> {
        Ok(Written::Expr(n.into()))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Written, E> {
        Ok(Written::Expr(Expr::missing()))
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Written, E> {
        string(text).map(Written::Expr).map_err(E::custom)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Written, A::Error> {
        let mut form = Form::default();
        while let Some(key) = map.next_key::<String>()? {
            form.read(&key, &mut map)?;
        }
        Ok(Written::Object(Box::new(form)))
    }
}

/// The expression a string writes: `$name` reads field `name`, and any other string is a CSS
/// color.
fn string(text: &str) -> Result<Expr, String> {
    match text.strip_prefix('$') {
        Some("") => Err("\"$\" names no field".to_owned()),
        Some(name) => Ok(super::field(name)),
        None => Color::css(text)
            .map(Expr::from)
            .ok_or_else(|| format!("{text:?} is not a CSS color; \"${text}\" reads field {text}")),
    }
}

/// Declares `Form` and how it reads, from one list of keys, each with its JSON spelling. `null`
/// leaves a key unset, except a key marked `as value`, which holds an expression and reads `null`
/// as a missing value.
macro_rules! form {
    (@read $map:ident, $ty:ty) => {
        $map.next_value::<Option<$ty>>()?
    };
    (@read $map:ident, $ty:ty, value) => {
        Some($map.next_value::<$ty>()?)
    };
    ($($vis:vis $key:ident $json:literal: $ty:ty $(as $how:ident)?),+ $(,)?) => {
        /// Every key that an expression object, a size, or label options can have, and the call
        /// made by a key that names an operation. Each kind accepts only its own keys.
        #[derive(Default)]
        pub(crate) struct Form {
            $($vis $key: Option<$ty>,)+
            /// The operation a key names, and the call it makes with the key's arguments.
            call: Option<(&'static str, Expr)>,
        }

        impl Form {
            /// The keys present, as JSON spells them.
            fn held(&self) -> Vec<&'static str> {
                let mut held = Vec::new();
                $(if self.$key.is_some() {
                    held.push($json);
                })+
                if let Some((operation, _)) = &self.call {
                    held.push(*operation);
                }
                held
            }

            /// Reads `key`'s value from `map`. Any other key names an operation, and this makes
            /// its call.
            fn read<'de, A: MapAccess<'de>>(&mut self, key: &str, map: &mut A) -> Result<(), A::Error> {
                match key {
                    $($json => {
                        if self.$key.is_some() {
                            return Err(de::Error::custom(format!("{key} is given twice")));
                        }
                        self.$key = form!(@read map, $ty $(, $how)?);
                        Ok(())
                    })+
                    _ => self.read_call(key, map),
                }
            }
        }
    };
}

form! {
    field "field": Name,
    state "state": State,
    when "when": Vec<(Expr, Expr)>,
    scale "scale": [f64; 2],
    colormap "colormap": Colormap,
    from "from": (Name, Name),
    step "step": bool,
    otherwise "otherwise": Expr as value,
    value "value": Expr as value,
    domain "domain": [f64; 2],
    pub(crate) px "px": Expr as value,
    pub(crate) units "units": Expr as value,
    pub(crate) at_least "atLeast": f32,
    pub(crate) at_most "atMost": f32,
    pub(crate) text "text": Expr as value,
    pub(crate) size "size": f32,
    pub(crate) color "color": Expr as value,
    pub(crate) max_width "maxWidth": f32,
    pub(crate) font "font": Arc<str>,
}

impl Form {
    /// Errors unless every key present is one of `keys`, naming `what` and the first other key.
    pub(crate) fn only(&self, what: &str, keys: &[&str]) -> Result<(), String> {
        match self.held().into_iter().find(|key| !keys.contains(key)) {
            Some(key) => Err(format!("{what} takes no {key}")),
            None => Ok(()),
        }
    }

    /// Reads from `map` the arguments of the operation `key` names, and makes the call. The
    /// arguments are values, or a value and a text for `is` and `contains`.
    fn read_call<'de, A: MapAccess<'de>>(&mut self, key: &str, map: &mut A) -> Result<(), A::Error> {
        let Some(&(name, operation, _)) = OPERATIONS.iter().find(|(name, ..)| *name == key) else {
            return Err(de::Error::custom(format!("{key:?} names no option or operation")));
        };
        if let Some((first, _)) = &self.call {
            return Err(de::Error::custom(format!("an object names one operation, not {first} and {name}")));
        }
        let count = |want: usize, got: usize| -> A::Error {
            let plural = if want == 1 { "" } else { "s" };
            de::Error::custom(format!("{name} takes {want} argument{plural}, not {got}"))
        };
        let call = match operation {
            Operation::Unary(op) => {
                let [a] = <[Expr; 1]>::try_from(map.next_value::<Vec<Expr>>()?).map_err(|a| count(1, a.len()))?;
                node(Node::Unary(op, a))
            }
            Operation::Binary(op) => {
                let [a, b] = <[Expr; 2]>::try_from(map.next_value::<Vec<Expr>>()?).map_err(|a| count(2, a.len()))?;
                node(Node::Binary(op, a, b))
            }
            Operation::Is => {
                let (a, text): (Expr, String) = map.next_value()?;
                a.is(&text)
            }
            Operation::Contains => {
                let (a, text): (Expr, String) = map.next_value()?;
                a.contains(&text)
            }
        };
        self.call = Some((name, call));
        Ok(())
    }

    /// The expression this object describes: the call its operation makes, or the node of its
    /// first kind key. It may have only that kind's keys.
    pub(crate) fn expr(mut self) -> Result<Expr, String> {
        if let Some((operation, call)) = self.call.take() {
            self.only(operation, &[])?;
            return Ok(call);
        }
        let held = self.held();
        let Some(own) = held.iter().find_map(|key| KINDS.iter().find(|keys| keys[0] == *key)) else {
            let kinds: Vec<&str> = KINDS.iter().map(|keys| keys[0]).collect();
            let found = if held.is_empty() { String::new() } else { format!("; found {}", held.join(", ")) };
            return Err(format!("an expression object needs an operation or one of {}{found}", kinds.join(", ")));
        };
        let kind = own[0];
        self.only(kind, own)?;
        let Form { field, state, when, scale, colormap, from, step, otherwise, value, domain, .. } = self;
        let needs = |key: &str| format!("{kind} needs {key}");
        Ok(match kind {
            "field" => {
                let expr = super::field(field.expect("present"));
                let expr = match from {
                    Some((data, table)) => expr.from_table(data, table),
                    None => expr,
                };
                if step == Some(true) { expr.step() } else { expr }
            }
            "state" => node(Node::State(state.expect("present"))),
            "when" => {
                let otherwise = otherwise.ok_or_else(|| needs("otherwise"))?;
                let cases = when.expect("present");
                cases.into_iter().rev().fold(otherwise, |rest, (c, v)| node(Node::When(c, v, rest)))
            }
            "scale" => {
                let [lo, hi] = scale.expect("present");
                domained(value.ok_or_else(|| needs("a value"))?.scale(lo..=hi), domain)
            }
            _ => domained(value.ok_or_else(|| needs("a value"))?.colormap(colormap.expect("present")), domain),
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

/// What a call computes from its arguments.
#[derive(Clone, Copy)]
enum Operation {
    Unary(Unary),
    Binary(Binary),
    Is,
    Contains,
}

/// Each operation a call can name: the key that names it, what it computes, and its description.
const OPERATIONS: [(&str, Operation, &str); 27] = [
    ("neg", Operation::Unary(Unary::Neg), "The value negated."),
    ("not", Operation::Unary(Unary::Not), "1 where the value is at most 0.5, else 0."),
    ("abs", Operation::Unary(Unary::Abs), "The absolute value."),
    ("sqrt", Operation::Unary(Unary::Sqrt), "The square root. Negative values give a missing value."),
    ("sin", Operation::Unary(Unary::Sin), "The sine of the value, an angle in radians."),
    ("cos", Operation::Unary(Unary::Cos), "The cosine of the value, an angle in radians."),
    ("floor", Operation::Unary(Unary::Floor), "The largest whole number at most the value."),
    ("ln", Operation::Unary(Unary::Ln), "The natural logarithm. Values at most 0 give a missing value."),
    ("exp", Operation::Unary(Unary::Exp), "e raised to the value."),
    ("add", Operation::Binary(Binary::Add), "The sum of the two values."),
    ("sub", Operation::Binary(Binary::Sub), "The first value minus the second."),
    ("mul", Operation::Binary(Binary::Mul), "The product of the two values."),
    (
        "div",
        Operation::Binary(Binary::Div),
        "The first value divided by the second. Dividing by 0 gives a missing value.",
    ),
    (
        "rem",
        Operation::Binary(Binary::Rem),
        "The remainder of the first value divided by the second, with the sign of the second: -1 and 3 give 2.",
    ),
    ("pow", Operation::Binary(Binary::Pow), "The first value raised to the power of the second."),
    ("min", Operation::Binary(Binary::Min), "The smaller of the two values."),
    ("max", Operation::Binary(Binary::Max), "The larger of the two values."),
    ("lt", Operation::Binary(Binary::Lt), "1 where the first value is less than the second, else 0."),
    ("le", Operation::Binary(Binary::Le), "1 where the first value is at most the second, else 0."),
    ("gt", Operation::Binary(Binary::Gt), "1 where the first value is greater than the second, else 0."),
    ("ge", Operation::Binary(Binary::Ge), "1 where the first value is at least the second, else 0."),
    ("eq", Operation::Binary(Binary::Eq), "1 where the two values are equal, else 0. Colors compare too."),
    ("ne", Operation::Binary(Binary::Ne), "1 where the two values differ, else 0. Colors compare too."),
    ("and", Operation::Binary(Binary::And), "1 where both values are above 0.5, else 0."),
    ("or", Operation::Binary(Binary::Or), "1 where either value is above 0.5, else 0."),
    ("is", Operation::Is, "Whether a text field equals the plain text exactly."),
    (
        "contains",
        Operation::Contains,
        "Whether a text field contains the plain text, ignoring case. In a mark, the field must belong to the mark's own table.",
    ),
];

/// Declares each kind of expression object once. Each kind gets a struct for its JSON schema (never
/// built, since reading goes through `Form`) and the list of keys an object of that kind may have,
/// its own key first.
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
    /// A field's value in each row, from the mark's own table. With `from`, it reads another
    /// dataset's table, joined by row id. `"$name"` is the short form of `{ "field": "name" }`.
    FieldNode {
        /// The field's name.
        field: Name,
        /// The dataset and table the field is read from, joined by row id.
        #[serde(default)]
        #[schemars(extend("tsType" = "TableInput"))]
        from: Option<(Name, Name)>,
        /// For a sampled field, reads the last frame at or before the shown coordinate instead of
        /// interpolating. Defaults to `false`.
        #[serde(default)]
        step: bool,
    }
    /// View state of each row, such as whether it is selected.
    StateNode {
        /// The state read.
        state: State,
    }
    /// The value of the first case whose condition holds, else `otherwise`.
    WhenNode {
        /// The cases, as `[condition, value]` pairs tried in order.
        #[schemars(extend("tsType" = "[condition: ExprInput, value: ExprInput][]"))]
        when: Vec<(Expr, Expr)>,
        /// The value where no condition holds.
        otherwise: Expr,
    }
    /// A value mapped linearly onto a range, clamped to the range.
    ScaleNode {
        /// The range.
        #[schemars(extend("tsType" = "[low: number, high: number]"))]
        scale: [f64; 2],
        /// The value mapped.
        value: Expr,
        /// The values mapped to the range's ends. Defaults to the extent of the values shown.
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
        /// The values mapped to the colormap's ends. Defaults to the extent of the values shown. A
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

/// A size in position units (degrees on the earth), regardless of the space's unit. It scales with
/// the zoom. `atLeast` and `atMost` bound it in CSS pixels.
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

/// An expression's schema is `ExprNode`. Its TypeScript type also accepts the builders.
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
        let mut any = vec![
            json_schema!({ "type": "number" }),
            json_schema!({ "type": "boolean" }),
            json_schema!({
                "type": "null",
                "description": "A missing value. An option that is missing uses the theme's value.",
            }),
            json_schema!({
                "type": "string",
                "description": "A field or a color. `\"$kv\"` reads field `kv`. Any other string is a CSS color, such as `#ffb000` or `rebeccapurple`. Write a field named `$x` as `{ \"field\": \"$x\" }`.",
            }),
        ];
        any.extend(kinds(generator));
        any.push(generator.subschema_for::<CallNode>());
        json_schema!({
            "description": "A value for each row. A number or boolean is a constant and `null` is missing. A string starting with `$` reads that field, and any other string is a CSS color. An object computes a value.",
            "anyOf": any,
        })
    }
}

/// The JSON form of a call: an object whose one key names an operation and holds its arguments.
struct CallNode;

impl JsonSchema for CallNode {
    fn schema_name() -> Cow<'static, str> {
        "CallNode".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let value = generator.subschema_for::<Expr>();
        let calls: Vec<Schema> = OPERATIONS
            .iter()
            .map(|&(name, operation, description)| {
                let mut arguments = match operation {
                    Operation::Unary(_) => {
                        json_schema!({ "type": "array", "prefixItems": [value], "minItems": 1, "maxItems": 1 })
                    }
                    Operation::Binary(_) => {
                        json_schema!({ "type": "array", "prefixItems": [value, value], "minItems": 2, "maxItems": 2 })
                    }
                    Operation::Is | Operation::Contains => json_schema!({
                        "type": "array",
                        "prefixItems": [value, { "type": "string" }],
                        "minItems": 2,
                        "maxItems": 2,
                        "tsType": "[field: ExprInput, text: string]",
                    }),
                };
                arguments.insert("description".into(), description.into());
                json_schema!({
                    "type": "object",
                    "properties": { name: arguments },
                    "required": [name],
                    "additionalProperties": false,
                })
            })
            .collect();
        json_schema!({
            "description": "An operation, written as an object with one key: the operation's name, holding its arguments. For example `{ \"add\": [\"$a\", 1] }`. The second argument of `is` and `contains` is plain text, not a field or a color.",
            "anyOf": calls,
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
            "description": "A size: a value in CSS pixels, or units in a diagram. `{ px }` is always CSS pixels. `{ units }` is position units (degrees on the earth), which grow as the view zooms in.",
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
    /// The colors, blended in OKLab. Each is a color, spaced evenly between its neighbors like a
    /// CSS gradient, or a `[place, color]` pair with a place from 0 to 1. Places must ascend. A
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
            serde_json::json!({ "description": "A colormap from the catalog.", "type": "string", "enum": names }),
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

    fn error(json: &str) -> String {
        serde_json::from_str::<Expr>(json).expect_err("an error").to_string()
    }

    #[test]
    fn forms_match_builders() {
        assert_eq!(parse("\"$vm\""), field("vm"));
        assert_eq!(parse("2.5"), Expr::from(2.5));
        assert_eq!(parse("null"), Expr::missing());
        assert_eq!(parse(r#"{"add": ["$a", 1]}"#), field("a") + 1.0);
        assert_eq!(parse(r#"{"not": ["$on"]}"#), !field("on"));
        assert_eq!(parse(r#"{"min": ["$a", {"abs": ["$b"]}]}"#), field("a").min(field("b").abs()));
        assert_eq!(
            parse(r##"{"when": [[{"state": "selected"}, "#ff0000"]], "otherwise": "$c"}"##),
            when(selected()).then(Color::rgb(1.0, 0.0, 0.0)).otherwise(field("c"))
        );
        assert_eq!(
            parse(r#"{"when": [["$on", "$name"]], "otherwise": null}"#),
            when(field("on")).then(field("name")).otherwise(Expr::missing()),
            "a label's text where `on` holds, and none elsewhere"
        );
        assert_eq!(
            parse(r#"{"field": "vm", "from": ["weather", "Station"], "step": true}"#),
            field("vm").from_table("weather", "Station").step()
        );
        assert_eq!(
            parse(r#"{"colormap": "balance", "value": "$vm", "domain": [0.9, 1.1]}"#),
            field("vm").colormap(Colormap::BALANCE).domain(0.9..=1.1).into()
        );
        assert_eq!(parse(r#"{"scale": [2, 8], "value": "$kv"}"#), field("kv").scale(2.0..=8.0).into());
        assert_eq!(parse(r#"{"is": ["$kind", "substation"]}"#), field("kind").is("substation"));
        assert_eq!(parse(r#"{"contains": ["$name", "lake"]}"#), field("name").contains("lake"));
        let size = |json: &str| serde_json::from_str::<Size>(json).expect("a size");
        assert_eq!(size("3"), Size::from(3.0));
        assert_eq!(size("\"$r\""), Size::from(field("r")));
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
    fn a_string_with_a_dollar_reads_a_field_and_any_other_is_a_color() {
        let red = Expr::from(Color::rgb(1.0, 0.0, 0.0));
        assert_eq!(parse("\"red\""), red);
        assert_eq!(parse("\"#ff0000\""), red);
        assert_eq!(parse("\"$#ff0000\""), field("#ff0000"), "after the `$`, any text names a field");
        assert_eq!(parse(r#"{"field": "$x"}"#), field("$x"), "the long form names any field");
        let wrong = error("\"level\"");
        assert!(wrong.starts_with(r#""level" is not a CSS color; "$level" reads field level"#), "{wrong}");
        assert!(error("\"$\"").contains("names no field"));
        // A call's text is plain: neither a field nor a color.
        assert_eq!(parse(r#"{"is": ["$kind", "$red"]}"#), field("kind").is("$red"));
        assert_eq!(parse(r#"{"contains": ["$name", "level"]}"#), field("name").contains("level"));
    }

    #[test]
    fn null_is_a_missing_value_wherever_a_value_goes() {
        let chosen = parse(r#"{"when": [["$on", null]], "otherwise": "$v"}"#);
        assert_eq!(chosen, when(field("on")).then(Expr::missing()).otherwise(field("v")));
        assert_eq!(parse(r#"{"max": ["$v", null]}"#), field("v").max(Expr::missing()));
        assert_eq!(
            parse(r#"{"colormap": "viridis", "value": null}"#),
            Expr::missing().colormap(Colormap::VIRIDIS).into()
        );
        let size = serde_json::from_str::<Size>(r#"{"px": null}"#).expect("a size");
        assert_eq!(size, crate::px(Expr::missing()));
        // An option of a node that is no value stays unset.
        assert_eq!(parse(r#"{"field": "v", "from": null}"#), field("v"));
    }

    #[test]
    fn errors_name_the_offending_part() {
        assert!(error(r#"{"field": "a", "state": "selected"}"#).contains("field takes no state"));
        assert!(error(r#"{"field": "a", "map": "viridis"}"#).contains("map"));
        assert!(error(r#"{"frob": []}"#).contains("frob"));
        let arguments = error(r#"{"add": ["$a"]}"#);
        assert!(arguments.contains("add takes 2 arguments, not 1"), "{arguments}");
        assert!(error(r#"{"add": ["$a", 1], "field": "b"}"#).contains("add takes no field"));
        assert!(error(r#"{"add": [1, 2], "mul": [3, 4]}"#).contains("one operation"));
        assert!(error(r#"{"color": "red"}"#).contains("found color"), "a color is a string, not a node");
        assert!(error(r#"{"missing": true}"#).contains("missing"));
        assert!(error(r#"{"op": "add", "args": ["$a", 1]}"#).contains("op"));
        let error = serde_json::from_str::<Colormap>(r#"{"kind": "cyclic", "colors": [[0.5, "red"], [0.2, "blue"]]}"#)
            .expect_err("descending places");
        assert!(error.to_string().contains("ascend"), "{error}");
    }
}
