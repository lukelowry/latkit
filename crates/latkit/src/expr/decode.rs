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
//! | `{ "units": a }` (sizes only)                            | `units(a)`                      |
//!
//! A map is a catalog name or `{ "kind": "categorical", "colors": [..], "categories": [..] }`, its
//! categories named only when categorical: `Colormap::new(..).categories(..)`.

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

use super::{Binary, Color, Colormap, ColormapKind, Expr, Node, Size, State, Unary, node};
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
            Decoded::Units(expr) => Size { expr, units: true },
            Decoded::Expr(expr) => Size { expr, units: false },
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
                colors: Vec<Color>,
                #[serde(default)]
                categories: Vec<String>,
            },
        }
        match Form::deserialize(deserializer)? {
            Form::Named(name) => {
                Colormap::named(&name).ok_or_else(|| de::Error::custom(format!("no colormap named {name:?}")))
            }
            Form::Colors { colors, .. } if colors.is_empty() => Err(de::Error::custom("a colormap needs a color")),
            Form::Colors { kind, categories, .. } if kind != ColormapKind::Categorical && !categories.is_empty() => {
                Err(de::Error::custom("only a categorical map has categories"))
            }
            Form::Colors { kind, colors, categories } if categories.is_empty() => Ok(Colormap::new(kind, &colors)),
            Form::Colors { kind, colors, categories } => Ok(Colormap::new(kind, &colors).categories(categories)),
        }
    }
}

struct ExprVisitor;

enum Decoded {
    Expr(Expr),
    Units(Expr),
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
            Decoded::Units(_) => Err(de::Error::custom("units measures a size, not a value")),
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
            node(Node::State(match state.as_str() {
                "selected" => State::Selected,
                "hovered" => State::Hovered,
                "pointer" => State::Pointer,
                "elapsed" => State::Elapsed,
                "zoom" => State::Zoom,
                other => {
                    return Err(E::unknown_variant(other, &["selected", "hovered", "pointer", "elapsed", "zoom"]));
                }
            }))
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
            return Ok(Decoded::Units(units));
        } else {
            unreachable!("one kind is set")
        };
        Ok(Decoded::Expr(expr))
    }
}

fn operation<E: de::Error>(op: &str, args: &[Expr]) -> Result<Expr, E> {
    let unary = |u: Unary| -> Result<Expr, E> {
        match args {
            [a] => Ok(node(Node::Unary(u, a.clone()))),
            _ => Err(E::invalid_length(args.len(), &"one argument")),
        }
    };
    let binary = |b: Binary| -> Result<Expr, E> {
        match args {
            [a, c] => Ok(node(Node::Binary(b, a.clone(), c.clone()))),
            _ => Err(E::invalid_length(args.len(), &"two arguments")),
        }
    };
    match op {
        "neg" => unary(Unary::Neg),
        "not" => unary(Unary::Not),
        "abs" => unary(Unary::Abs),
        "sqrt" => unary(Unary::Sqrt),
        "sin" => unary(Unary::Sin),
        "cos" => unary(Unary::Cos),
        "floor" => unary(Unary::Floor),
        "ln" => unary(Unary::Ln),
        "exp" => unary(Unary::Exp),
        "add" => binary(Binary::Add),
        "sub" => binary(Binary::Sub),
        "mul" => binary(Binary::Mul),
        "div" => binary(Binary::Div),
        "rem" => binary(Binary::Rem),
        "pow" => binary(Binary::Pow),
        "min" => binary(Binary::Min),
        "max" => binary(Binary::Max),
        "lt" => binary(Binary::Lt),
        "le" => binary(Binary::Le),
        "gt" => binary(Binary::Gt),
        "ge" => binary(Binary::Ge),
        "eq" => binary(Binary::Eq),
        "ne" => binary(Binary::Ne),
        "and" => binary(Binary::And),
        "or" => binary(Binary::Or),
        other => Err(E::unknown_variant(other, OPS)),
    }
}

const OPS: &[&str] = &[
    "neg", "not", "abs", "sqrt", "sin", "cos", "floor", "ln", "exp", "add", "sub", "mul", "div", "rem", "pow", "min",
    "max", "lt", "le", "gt", "ge", "eq", "ne", "and", "or",
];

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
    }

    #[test]
    fn errors_name_what_is_wrong() {
        let error = serde_json::from_str::<Expr>(r#"{"field": "a", "color": "red"}"#).expect_err("two kinds");
        assert!(error.to_string().contains("exactly one"), "{error}");
        let error = serde_json::from_str::<Expr>(r#"{"op": "frob", "args": []}"#).expect_err("unknown op");
        assert!(error.to_string().contains("frob"), "{error}");
    }
}
