//! Per-row values: expressions over fields and view state, compiled to bytecode the GPU runs.

mod color;
mod colormap;
pub(crate) mod compile;
pub(crate) mod cpu;
mod form;
mod ramp;

use std::ops::{Add, BitAnd, BitOr, Div, Mul, Neg, Not, RangeInclusive, Rem, Sub};
use std::sync::Arc;

pub use color::Color;
pub(crate) use colormap::ColormapKey;
pub use colormap::{Colormap, ColormapKind, Stop};

use crate::Name;

/// A value for every row of a mark: a constant, a field, view state, or arithmetic of them.
///
/// A `&str` converts to the field of that name, so options read fields by name:
///
/// ```
/// # use latkit::{field, when, selected, Colormap, Color};
/// let color = field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05);
/// let radius = 4.0 + field("load") / 100.0;
/// let status = when(selected()).then(Color::hex("#ffb000").unwrap()).otherwise(color);
/// let high_voltage = field("kv").ge(230.0) & field("kind").is("substation");
/// ```
///
/// Expressions compile to bytecode; changing one never compiles a shader.
#[derive(Clone, PartialEq, Debug)]
pub struct Expr(pub(crate) Arc<Node>);

#[derive(PartialEq, Debug)]
pub(crate) enum Node {
    Number(f64),
    Bool(bool),
    Color(Color),
    Missing,
    Field(FieldRef),
    State(State),
    Unary(Unary, Expr),
    Binary(Binary, Expr, Expr),
    When(Expr, Expr, Expr),
    Is(Expr, Arc<str>),
    Contains(Expr, Arc<str>),
    Scale { input: Expr, domain: Domain, range: [f64; 2] },
    Colormap { input: Expr, colormap: Colormap, domain: Domain },
}

/// A field read: of the mark's own table, or of another dataset's table joined by row id.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct FieldRef {
    pub(crate) name: Name,
    pub(crate) of: Option<(Name, Name)>,
    pub(crate) step: bool,
    /// For a point geometry: 0 for x, 1 for y.
    pub(crate) component: Option<u8>,
}

/// What the view knows of each row.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    Selected,
    Hovered,
    Pointer,
    Elapsed,
    Zoom,
}

/// An operation of one value.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Unary {
    Neg,
    Not,
    Abs,
    Sqrt,
    Sin,
    Cos,
    Floor,
    Ln,
    Exp,
}

/// An operation of two values.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Binary {
    Add,
    Sub,
    Mul,
    Div,
    Rem,
    Pow,
    Min,
    Max,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    And,
    Or,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Domain {
    /// The extent of the values shown, reduced on the GPU.
    Fit,
    Fixed([f64; 2]),
}

pub(crate) fn node(node: Node) -> Expr {
    Expr(Arc::new(node))
}

/// The field `name` of each row.
pub fn field(name: impl Into<Name>) -> Expr {
    node(Node::Field(FieldRef { name: name.into(), of: None, step: false, component: None }))
}

/// Starts a conditional: `when(c).then(a).when(d).then(b).otherwise(e)`.
pub fn when(condition: impl Into<Expr>) -> When {
    When { cases: Vec::new(), condition: condition.into() }
}

/// Whether the row is selected.
pub fn selected() -> Expr {
    node(Node::State(State::Selected))
}

/// Whether the pointer is over the row.
pub fn hovered() -> Expr {
    node(Node::State(State::Hovered))
}

/// CSS pixels from a vertex to the pointer; for vertices only, and not in their position.
pub fn pointer() -> Expr {
    node(Node::State(State::Pointer))
}

/// Seconds since the view was created; a mark that reads it redraws every frame.
pub fn elapsed() -> Expr {
    node(Node::State(State::Elapsed))
}

/// The camera's zoom: the web mercator level on the earth, log₂ CSS pixels per unit elsewhere. Options
/// that read it change with the view, as levels of detail do.
pub fn zoom() -> Expr {
    node(Node::State(State::Zoom))
}

/// A size measured in position units, so it scales as the view zooms; [`Size::at_least`] and
/// [`Size::at_most`] keep it within CSS pixels.
pub fn units(size: impl Into<Expr>) -> Size {
    Size { expr: size.into(), units: true, px: Size::ANY }
}

macro_rules! unary {
    ($($(#[$doc:meta])* $name:ident => $op:ident),* $(,)?) => {$(
        $(#[$doc])*
        #[must_use]
        pub fn $name(self) -> Expr {
            node(Node::Unary(Unary::$op, self))
        }
    )*};
}

macro_rules! binary {
    ($($(#[$doc:meta])* $name:ident => $op:ident),* $(,)?) => {$(
        $(#[$doc])*
        #[must_use]
        pub fn $name(self, other: impl Into<Expr>) -> Expr {
            node(Node::Binary(Binary::$op, self, other.into()))
        }
    )*};
}

impl Expr {
    /// A missing value: options that read one take the theme's value.
    pub fn missing() -> Expr {
        node(Node::Missing)
    }

    unary!(
        /// The absolute value.
        abs => Abs,
        /// The square root.
        sqrt => Sqrt,
        /// The sine of radians.
        sin => Sin,
        /// The cosine of radians.
        cos => Cos,
        /// The largest integer at most the value.
        floor => Floor,
        /// The natural logarithm.
        ln => Ln,
        /// `e` raised to the value.
        exp => Exp,
    );

    binary!(
        /// The smaller value.
        min => Min,
        /// The larger value.
        max => Max,
        /// The value raised to `other`.
        pow => Pow,
        /// Whether the value is less than `other`.
        lt => Lt,
        /// Whether the value is at most `other`.
        le => Le,
        /// Whether the value is greater than `other`.
        gt => Gt,
        /// Whether the value is at least `other`.
        ge => Ge,
        /// Whether the value equals `other`.
        eq => Eq,
        /// Whether the value differs from `other`.
        ne => Ne,
    );

    /// The value clamped to `low..=high`.
    #[must_use]
    pub fn clamp(self, low: impl Into<Expr>, high: impl Into<Expr>) -> Expr {
        self.max(low).min(high)
    }

    /// 0 below `from`, 1 above `to`, and a smooth step between.
    #[must_use]
    pub fn smoothstep(self, from: impl Into<Expr>, to: impl Into<Expr>) -> Expr {
        let (from, to) = (from.into(), to.into());
        let t = ((self - from.clone()) / (to - from)).clamp(0.0, 1.0);
        t.clone() * t.clone() * (3.0 - 2.0 * t)
    }

    /// Whether a text field equals `text`.
    #[must_use]
    pub fn is(self, text: &str) -> Expr {
        node(Node::Is(self, text.into()))
    }

    /// Whether a text field holds `text`, ignoring case. Only a [`Query`](crate::Query) reads it, as
    /// the GPU holds no texts.
    #[must_use]
    pub fn contains(self, text: &str) -> Expr {
        node(Node::Contains(self, text.into()))
    }

    /// Reads this expression's fields from `table` of dataset `data`, joined by row id.
    #[must_use]
    pub fn of(self, data: impl Into<Name>, table: impl Into<Name>) -> Expr {
        let of = (data.into(), table.into());
        self.map_fields(&|f| FieldRef { of: Some(of.clone()), ..f.clone() })
    }

    /// Reads sampled fields at the last frame at or before the shown coordinate, without
    /// interpolating to the next.
    #[must_use]
    pub fn step(self) -> Expr {
        self.map_fields(&|f| FieldRef { step: true, ..f.clone() })
    }

    /// The value through `colormap`; the domain fits the values shown unless set by
    /// [`Mapped::domain`].
    pub fn colormap(self, colormap: impl Into<Colormap>) -> Mapped {
        Mapped(node(Node::Colormap { input: self, colormap: colormap.into(), domain: Domain::Fit }))
    }

    /// The value mapped linearly onto `range`, clamped; the domain fits the values shown unless set
    /// by [`Mapped::domain`].
    pub fn scale(self, range: RangeInclusive<f64>) -> Mapped {
        let range = [*range.start(), *range.end()];
        Mapped(node(Node::Scale { input: self, domain: Domain::Fit, range }))
    }

    pub(crate) fn component(name: impl Into<Name>, component: u8) -> Expr {
        node(Node::Field(FieldRef { name: name.into(), of: None, step: false, component: Some(component) }))
    }

    fn map_fields(&self, f: &impl Fn(&FieldRef) -> FieldRef) -> Expr {
        match &*self.0 {
            Node::Field(field) => node(Node::Field(f(field))),
            Node::Unary(op, a) => node(Node::Unary(*op, a.map_fields(f))),
            Node::Binary(op, a, b) => node(Node::Binary(*op, a.map_fields(f), b.map_fields(f))),
            Node::When(c, a, b) => node(Node::When(c.map_fields(f), a.map_fields(f), b.map_fields(f))),
            Node::Is(a, text) => node(Node::Is(a.map_fields(f), text.clone())),
            Node::Contains(a, text) => node(Node::Contains(a.map_fields(f), text.clone())),
            Node::Scale { input, domain, range } => {
                node(Node::Scale { input: input.map_fields(f), domain: *domain, range: *range })
            }
            Node::Colormap { input, colormap, domain } => {
                node(Node::Colormap { input: input.map_fields(f), colormap: colormap.clone(), domain: *domain })
            }
            Node::Number(_) | Node::Bool(_) | Node::Color(_) | Node::Missing | Node::State(_) => self.clone(),
        }
    }

    /// Calls `f` with every field the expression reads.
    pub(crate) fn for_each_field<'e>(&'e self, f: &mut impl FnMut(&'e FieldRef)) {
        match &*self.0 {
            Node::Field(field) => f(field),
            Node::Unary(_, a)
            | Node::Is(a, _)
            | Node::Contains(a, _)
            | Node::Scale { input: a, .. }
            | Node::Colormap { input: a, .. } => a.for_each_field(f),
            Node::Binary(_, a, b) => {
                a.for_each_field(f);
                b.for_each_field(f);
            }
            Node::When(c, a, b) => {
                c.for_each_field(f);
                a.for_each_field(f);
                b.for_each_field(f);
            }
            Node::Number(_) | Node::Bool(_) | Node::Color(_) | Node::Missing | Node::State(_) => {}
        }
    }

    /// Whether a domain fits the values of every row: each row's value then reads them all.
    pub(crate) fn fits(&self) -> bool {
        match &*self.0 {
            Node::Scale { domain: Domain::Fit, .. } | Node::Colormap { domain: Domain::Fit, .. } => true,
            Node::Unary(_, a)
            | Node::Is(a, _)
            | Node::Contains(a, _)
            | Node::Scale { input: a, .. }
            | Node::Colormap { input: a, .. } => a.fits(),
            Node::Binary(_, a, b) => a.fits() || b.fits(),
            Node::When(c, a, b) => c.fits() || a.fits() || b.fits(),
            Node::Number(_) | Node::Bool(_) | Node::Color(_) | Node::Missing | Node::Field(_) | Node::State(_) => false,
        }
    }

    /// The field's name, when the expression is a field of its own table read as it is.
    pub(crate) fn field_name(&self) -> Option<&Name> {
        match &*self.0 {
            Node::Field(f) if f.of.is_none() && f.component.is_none() => Some(&f.name),
            _ => None,
        }
    }

    /// The first colormap a color maps through, and its domain when set: what a legend shows. A
    /// conditional's general case, its `otherwise`, comes before the cases it makes exceptions for.
    pub(crate) fn colormap_of(&self) -> Option<(&Colormap, Option<[f64; 2]>)> {
        match &*self.0 {
            Node::Colormap { colormap, domain, .. } => {
                Some((colormap, if let Domain::Fixed(domain) = domain { Some(*domain) } else { None }))
            }
            Node::Unary(_, a) | Node::Is(a, _) | Node::Contains(a, _) => a.colormap_of(),
            Node::Binary(_, a, b) => a.colormap_of().or_else(|| b.colormap_of()),
            Node::When(c, a, b) => b.colormap_of().or_else(|| a.colormap_of()).or_else(|| c.colormap_of()),
            Node::Scale { input, .. } => input.colormap_of(),
            Node::Number(_) | Node::Bool(_) | Node::Color(_) | Node::Missing | Node::Field(_) | Node::State(_) => None,
        }
    }
}

/// A value mapped through a colormap or onto a range, whose domain can be set.
#[derive(Clone, PartialEq, Debug)]
pub struct Mapped(Expr);

impl Mapped {
    /// The input values that map to the ends of the range or colormap.
    #[must_use]
    pub fn domain(self, domain: RangeInclusive<f64>) -> Mapped {
        let fixed = Domain::Fixed([*domain.start(), *domain.end()]);
        Mapped(match &*self.0.0 {
            Node::Colormap { input, colormap, .. } => {
                node(Node::Colormap { input: input.clone(), colormap: colormap.clone(), domain: fixed })
            }
            Node::Scale { input, range, .. } => {
                node(Node::Scale { input: input.clone(), domain: fixed, range: *range })
            }
            _ => unreachable!("a mapped value is a colormap or a scale"),
        })
    }
}

impl From<Mapped> for Expr {
    fn from(mapped: Mapped) -> Expr {
        mapped.0
    }
}

/// The open cases of a [`when`].
pub struct When {
    cases: Vec<(Expr, Expr)>,
    condition: Expr,
}

/// The cases of a [`when`], waiting for another case or the value otherwise.
pub struct Then {
    cases: Vec<(Expr, Expr)>,
}

impl When {
    /// The value where the condition holds.
    pub fn then(mut self, value: impl Into<Expr>) -> Then {
        self.cases.push((self.condition, value.into()));
        Then { cases: self.cases }
    }
}

impl Then {
    /// Another case, tried when the earlier ones do not hold.
    pub fn when(self, condition: impl Into<Expr>) -> When {
        When { cases: self.cases, condition: condition.into() }
    }

    /// The value where no case holds.
    pub fn otherwise(self, value: impl Into<Expr>) -> Expr {
        self.cases.into_iter().rev().fold(value.into(), |otherwise, (c, v)| node(Node::When(c, v, otherwise)))
    }
}

/// A size: CSS pixels, or position units with [`units`], kept within a range of CSS pixels.
#[derive(Clone, PartialEq, Debug)]
pub struct Size {
    pub(crate) expr: Expr,
    pub(crate) units: bool,
    /// The CSS pixels it keeps within, at any zoom.
    pub(crate) px: [f32; 2],
}

impl Size {
    /// Any number of CSS pixels.
    pub(crate) const ANY: [f32; 2] = [0.0, f32::INFINITY];

    /// Keeps at least `px` CSS pixels however far the view zooms out: `units(field("r")).at_least(2.0)`
    /// grows with the map and never vanishes. A marker keeps its proportions, its larger side held.
    #[must_use]
    pub fn at_least(mut self, px: f32) -> Size {
        self.px[0] = px.max(0.0);
        self
    }

    /// Keeps at most `px` CSS pixels however far the view zooms in.
    #[must_use]
    pub fn at_most(mut self, px: f32) -> Size {
        self.px[1] = px.max(0.0);
        self
    }
}

impl<T: Into<Expr>> From<T> for Size {
    fn from(value: T) -> Size {
        Size { expr: value.into(), units: false, px: Size::ANY }
    }
}

impl From<&str> for Expr {
    fn from(name: &str) -> Expr {
        field(name)
    }
}

impl From<String> for Expr {
    fn from(name: String) -> Expr {
        field(name)
    }
}

impl From<&Name> for Expr {
    fn from(name: &Name) -> Expr {
        field(name)
    }
}

impl From<f64> for Expr {
    fn from(value: f64) -> Expr {
        node(Node::Number(value))
    }
}

impl From<f32> for Expr {
    fn from(value: f32) -> Expr {
        node(Node::Number(f64::from(value)))
    }
}

impl From<i32> for Expr {
    fn from(value: i32) -> Expr {
        node(Node::Number(f64::from(value)))
    }
}

impl From<bool> for Expr {
    fn from(value: bool) -> Expr {
        node(Node::Bool(value))
    }
}

impl From<Color> for Expr {
    fn from(value: Color) -> Expr {
        node(Node::Color(value))
    }
}

impl From<&Expr> for Expr {
    fn from(value: &Expr) -> Expr {
        value.clone()
    }
}

macro_rules! operators {
    ($($trait:ident $method:ident $op:ident),*) => {$(
        impl<R: Into<Expr>> $trait<R> for Expr {
            type Output = Expr;

            fn $method(self, other: R) -> Expr {
                node(Node::Binary(Binary::$op, self, other.into()))
            }
        }

        impl $trait<Expr> for f64 {
            type Output = Expr;

            fn $method(self, other: Expr) -> Expr {
                node(Node::Binary(Binary::$op, Expr::from(self), other))
            }
        }
    )*};
}

operators!(Add add Add, Sub sub Sub, Mul mul Mul, Div div Div, Rem rem Rem, BitAnd bitand And, BitOr bitor Or);

impl Neg for Expr {
    type Output = Expr;

    fn neg(self) -> Expr {
        node(Node::Unary(Unary::Neg, self))
    }
}

impl Not for Expr {
    type Output = Expr;

    fn not(self) -> Expr {
        node(Node::Unary(Unary::Not, self))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn when_folds_right_to_left() {
        let e = when(selected()).then(1.0).when(hovered()).then(2.0).otherwise(3.0);
        let Node::When(c, a, rest) = &*e.0 else { panic!("a when") };
        assert_eq!(c, &selected());
        assert_eq!(a, &Expr::from(1.0));
        assert!(matches!(&*rest.0, Node::When(..)));
    }

    #[test]
    fn domain_applies_to_the_mapping_whatever_the_order() {
        let a: Expr = field("vm").colormap(Colormap::BALANCE).domain(0.9..=1.1).into();
        let Node::Colormap { domain, .. } = &*a.0 else { panic!("a colormap") };
        assert_eq!(*domain, Domain::Fixed([0.9, 1.1]));
    }

    #[test]
    fn of_reaches_every_field() {
        let e = (field("a") + field("b")).of("weather", "Station");
        let Node::Binary(_, a, b) = &*e.0 else { panic!("a sum") };
        for side in [a, b] {
            let Node::Field(f) = &*side.0 else { panic!("a field") };
            assert_eq!(f.of, Some(("weather".into(), "Station".into())));
        }
    }
}
