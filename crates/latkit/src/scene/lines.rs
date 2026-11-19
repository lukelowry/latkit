use std::borrow::Cow;
use std::fmt;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde::de::value::MapAccessDeserializer;
use serde::de::{self, Deserializer, MapAccess, Visitor};

use super::Interpolation;
use super::mark::{
    Context, Drawing, GEOMETRY, MarkKind, Stroke, StrokeWords, Style, mark, stroke_methods, style_methods,
};
use crate::expr::compile::{Compiler, Store};
use crate::expr::{Binary, Node, Unary};
use crate::gpu::shaders as wgsl;
use crate::{Error, Expr, Kind, Name, Result, Space};

mark!(
/// Rows drawn as lines along a path field (roads, rivers, borders) or a polygon field's rings (area
/// outlines). On a plot, each row traces a sampled field's history across the data's axis, like a
/// monitor. On the earth, paths follow the globe's curve and stay unbroken across the antimeridian.
///
/// ```
/// # use latkit::{Lines, field};
/// let roads = Lines::of("city", "roads").width(2.0);
/// let height = Lines::of("body", "Body").trace("height");
/// let percent = Lines::of("grid", "Bus").trace(field("vm") * 100.0);
/// ```
Lines("lines") + stroke {
    /// The path or polygon field each row runs along. Defaults to the field named `geometry`. Not
    /// allowed on a plot.
    geometry: Option<Name>,
    /// What each row traces across the data's axis: a sampled field's name, with or without `$`, or
    /// an expression that multiplies the field by a number and adds one, such as
    /// `{ "mul": ["$vm", 100] }`. Required on a plot, and allowed only there. A field with no frames
    /// yet draws nothing until its first frame arrives.
    trace: Option<Trace> as "string | ExprInput",
    /// How each row runs between its samples on a plot. Defaults to `linear`.
    interpolation: Interpolation,
});

impl Lines {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Lines {
        Lines {
            style: Style::new(data.into(), table.into()),
            stroke: Stroke::default(),
            geometry: None,
            trace: None,
            interpolation: Interpolation::Linear,
        }
    }

    /// Sets the path or polygon field each row runs along. Defaults to the field named `geometry`.
    /// Not allowed on a plot.
    #[must_use]
    pub fn geometry(mut self, field: impl Into<Name>) -> Lines {
        self.geometry = Some(field.into());
        self
    }

    /// Sets what each row traces across the data's axis: a sampled field, or the field times a
    /// number plus a number, such as `field("vm") * 100.0`. Plots only. Unless the mark is
    /// [named](Lines::named), the field's name identifies it across scenes.
    #[must_use]
    pub fn trace(mut self, trace: impl Into<Trace>) -> Lines {
        self.trace = Some(trace.into());
        self
    }

    /// Sets how each row runs between its samples on a plot. Defaults to linear.
    #[must_use]
    pub fn interpolation(mut self, interpolation: Interpolation) -> Lines {
        self.interpolation = interpolation;
        self
    }

    /// The field each row draws from: the sampled field it traces, else its path field.
    pub(crate) fn traced(&self) -> Name {
        let traced = self.trace.as_ref().map(|trace| trace.field().cloned().unwrap_or_else(|| "trace".into()));
        traced.or_else(|| self.geometry.clone()).unwrap_or_else(|| GEOMETRY.into())
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, context: Context<'_>) -> Result<Drawing> {
        let mut drawing = Drawing::new(MarkKind::Lines);
        drawing.size_px = self.stroke.px();
        if matches!(context.space, Space::Plot(_)) {
            if self.geometry.is_some() {
                return Err(Error::invalid("in a plot, use trace instead of geometry").at("geometry"));
            }
            let Some(trace) = &self.trace else {
                return Err(Error::invalid("name the sampled field each row traces").at("trace"));
            };
            let Some((field, scale)) = &trace.0 else {
                return Err(Error::invalid("trace a sampled field, times a number plus a number").at("trace"));
            };
            drawing.trace = match c.kind(field) {
                // Streamed data may not have its first frame yet. The mark recompiles when it
                // arrives.
                None => wgsl::NONE,
                _ => c.trace(field, *scale).map_err(|e| e.at("trace"))?,
            };
            drawing.scale = *scale;
            drawing.flags = match self.interpolation {
                Interpolation::Linear => 0,
                Interpolation::StepBefore => wgsl::STEP_BEFORE,
                Interpolation::StepAfter => wgsl::STEP_AFTER,
            };
        } else {
            if self.trace.is_some() {
                return Err(Error::invalid("outside a plot, use geometry instead of trace").at("trace"));
            }
            let field = self.geometry.clone().unwrap_or_else(|| GEOMETRY.into());
            match c.kind(&field) {
                Some(Kind::Path | Kind::Parts | Kind::Polygons) => {}
                Some(_) => return Err(Error::invalid("not a path or polygon field").at(&field).at("geometry")),
                None if self.geometry.is_some() => {
                    return Err(Error::invalid("no such field").at(&field).at("geometry"));
                }
                None => return Err(Error::invalid("name the path field each row runs along").at("geometry")),
            }
            // On the earth, a line follows a derived copy of its path that bends with the globe.
            drawing.geometry = if matches!(context.space, Space::Earth(_)) {
                c.derived_path(&path_of(&field))
            } else {
                c.path(&field)
            };
        }
        let color = Store::Color { word: wgsl::LINE_COLOR, fallback: wgsl::THEME_LINE };
        match &self.style.color {
            Some(expr) => c.channel("color", expr, color)?,
            None => c.theme("color", wgsl::THEME_LINE, color)?,
        }
        c.channel(
            "visible",
            &self.style.visible,
            Store::Flag { word: wgsl::LINE_FLAGS, bit: wgsl::VISIBLE, unset: true },
        )?;
        let words = StrokeWords {
            width: wgsl::LINE_WIDTH,
            flow: wgsl::LINE_FLOW,
            flags: wgsl::LINE_FLAGS,
            theme_width: wgsl::THEME_LINE_WIDTH,
        };
        self.stroke.compile(c, &words)?;
        Ok(drawing)
    }
}

/// The name of the derived field holding path field `field` as drawn on the earth: unwrapped across
/// the antimeridian, with a point added every few degrees along long segments.
pub(crate) fn path_of(field: &str) -> Name {
    format!("{field}.path").into()
}

/// What a line traces across a plot's axis: a sampled field, or the field times a number plus a
/// number, as in `field("vm") * 100.0` to draw per-unit values as percent, or
/// `field("t") - 273.15` to draw kelvin as Celsius. The line, its hits, and the plot's fit all use
/// the value drawn. A name traces that field.
#[derive(Clone, PartialEq, Debug)]
pub struct Trace(
    /// The field, and the scale and offset it draws at (`value × scale + offset`), or `None` when
    /// the expression is not that.
    Option<(Name, [f64; 2])>,
);

impl Trace {
    /// The sampled field traced, unless the expression traces none.
    pub(crate) fn field(&self) -> Option<&Name> {
        self.0.as_ref().map(|(field, _)| field)
    }
}

impl From<&str> for Trace {
    fn from(field: &str) -> Trace {
        Trace(Some((field.into(), [1.0, 0.0])))
    }
}

impl From<String> for Trace {
    fn from(field: String) -> Trace {
        Trace(Some((field.into(), [1.0, 0.0])))
    }
}

impl From<Name> for Trace {
    fn from(field: Name) -> Trace {
        Trace(Some((field, [1.0, 0.0])))
    }
}

impl From<Expr> for Trace {
    fn from(expr: Expr) -> Trace {
        Trace(linear(&expr))
    }
}

/// `expr` as a field of the mark's own table times a number plus a number: the field, and the
/// scale and offset. `None` for any other expression.
fn linear(expr: &Expr) -> Option<(Name, [f64; 2])> {
    match &*expr.0 {
        Node::Field(f) if f.from.is_none() && f.of.is_none() && !f.step && f.component.is_none() => {
            Some((f.name.clone(), [1.0, 0.0]))
        }
        Node::Unary(Unary::Neg, a) => linear(a).map(|(f, [s, o])| (f, [-s, -o])),
        Node::Binary(op, a, b) => {
            let (fa, fb, ka, kb) = (linear(a), linear(b), constant(a), constant(b));
            match (op, fa, fb, ka, kb) {
                (Binary::Add, Some((f, [s, o])), _, _, Some(k)) | (Binary::Add, _, Some((f, [s, o])), Some(k), _) => {
                    Some((f, [s, o + k]))
                }
                (Binary::Sub, Some((f, [s, o])), _, _, Some(k)) => Some((f, [s, o - k])),
                (Binary::Sub, _, Some((f, [s, o])), Some(k), _) => Some((f, [-s, k - o])),
                (Binary::Mul, Some((f, [s, o])), _, _, Some(k)) | (Binary::Mul, _, Some((f, [s, o])), Some(k), _) => {
                    Some((f, [s * k, o * k]))
                }
                (Binary::Div, Some((f, [s, o])), _, _, Some(k)) if k != 0.0 => Some((f, [s / k, o / k])),
                _ => None,
            }
        }
        _ => None,
    }
}

/// `expr` as a number, when it is arithmetic on numbers alone.
fn constant(expr: &Expr) -> Option<f64> {
    match &*expr.0 {
        Node::Number(n) => Some(*n),
        Node::Unary(Unary::Neg, a) => constant(a).map(|n| -n),
        Node::Binary(op, a, b) => {
            let (a, b) = (constant(a)?, constant(b)?);
            match op {
                Binary::Add => Some(a + b),
                Binary::Sub => Some(a - b),
                Binary::Mul => Some(a * b),
                Binary::Div => Some(a / b),
                _ => None,
            }
        }
        _ => None,
    }
}

/// A string names the field, with or without the `$` an expression reads a field with. Anything
/// else is an expression.
impl<'de> Deserialize<'de> for Trace {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Trace, D::Error> {
        struct Reading;

        impl<'de> Visitor<'de> for Reading {
            type Value = Trace;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a sampled field's name, or an expression of one")
            }

            fn visit_str<E: de::Error>(self, field: &str) -> std::result::Result<Trace, E> {
                Ok(Trace::from(field.strip_prefix('$').filter(|name| !name.is_empty()).unwrap_or(field)))
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Trace, A::Error> {
                Expr::deserialize(MapAccessDeserializer::new(map)).map(Trace::from)
            }
        }

        deserializer.deserialize_any(Reading)
    }
}

impl JsonSchema for Trace {
    fn schema_name() -> Cow<'static, str> {
        "Trace".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let expr = generator.subschema_for::<Expr>();
        json_schema!({
            "description": "A sampled field's name, with or without `$`, or an expression that multiplies the field by a number and adds one.",
            "anyOf": [{ "type": "string" }, expr],
        })
    }
}

style_methods!(Lines);
stroke_methods!(Lines);
