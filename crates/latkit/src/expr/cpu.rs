//! The expression machine on the CPU, for what a diagram's sheet reads (where rows stand, how large
//! they are, and the texts its blocks fit) and what a query keeps, sorts, and selects. The GPU runs
//! the same expressions for everything drawn; here they read fields, sampled ones at a coordinate.

use std::cell::RefCell;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::{Binary, Domain, Expr, FieldRef, Node, Unary};
use crate::Kind;
use crate::data::{Data, Field, Geometry, Table, Value};

/// The rows an expression reads: a table, and every dataset its joins may name.
pub(crate) struct Rows<'a> {
    pub(crate) table: &'a Table,
    pub(crate) all: &'a [Data],
    /// The axis coordinate sampled fields are read at: their last frame by default.
    at: f64,
    /// Fitted domains already reduced, by the input they reduce.
    fitted: RefCell<FxHashMap<*const Node, [f64; 2]>>,
}

impl<'a> Rows<'a> {
    pub(crate) fn new(table: &'a Table, all: &'a [Data]) -> Rows<'a> {
        Rows { table, all, at: f64::INFINITY, fitted: RefCell::default() }
    }

    /// The rows with sampled fields read at axis coordinate `at`.
    pub(crate) fn at(mut self, at: f64) -> Rows<'a> {
        self.at = at;
        self
    }

    /// `expr` for `row` as a number; `None` where it reads missing, or holds no number.
    pub(crate) fn number(&self, expr: &Expr, row: usize) -> Option<f64> {
        let v = self.eval(expr, row);
        v.is_finite().then_some(v)
    }

    /// `expr` for every row, NaN where it reads missing, each made into a `T` by `make`: a plain
    /// field read page by page, anything else row by row.
    pub(crate) fn numbers<T>(&self, expr: &Expr, mut make: impl FnMut(f64) -> T) -> Vec<T> {
        let n = self.table.len();
        let mut out = Vec::with_capacity(n);
        match &*expr.0 {
            Node::Number(v) => {
                out.resize_with(n, || make(*v));
                return out;
            }
            Node::Field(f) if f.of.is_none() => {
                if let Some(Field::Values(column, _)) = self.table.field_named(&f.name) {
                    let pages = column.pages().iter().map(|p| &p.values);
                    match (column.kind(), f.component) {
                        (Kind::Number | Kind::Bool, None) => {
                            pages.for_each(|v| v.each_number(|x| out.push(make(x.unwrap_or(f64::NAN)))));
                            return out;
                        }
                        (Kind::Point, Some(k)) => {
                            let k = usize::from(k.min(1));
                            for v in pages {
                                let coords = v.geometry().map_or(&[][..], Geometry::coords);
                                out.extend(
                                    (0..v.len()).map(|i| make(if v.is_valid(i) { coords[i][k] } else { f64::NAN })),
                                );
                            }
                            return out;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        out.extend((0..n).map(|row| make(self.eval(expr, row))));
        out
    }

    /// The text field `expr` names, for `row`.
    pub(crate) fn text(&self, expr: &Expr, row: usize) -> Option<Arc<str>> {
        let Node::Field(f) = &*expr.0 else { return None };
        match self.value(f, row)? {
            Value::Text(text) => Some(text),
            _ => None,
        }
    }

    /// Field `f`'s value for `row`: of the table, or of a joined one by the row's id.
    fn value(&self, f: &FieldRef, row: usize) -> Option<Value> {
        let value = match &f.of {
            None => self.table.value(row, &f.name, self.at)?,
            Some((data, table)) => {
                let other = self.all.iter().find(|d| d.name() == data)?.table(table)?;
                let key = self.table.ids.key(row)?;
                other.value(other.row(key)?, &f.name, self.at)?
            }
        };
        Some(match (value, f.component) {
            (Value::Point(p), Some(k)) => Value::Number(p[usize::from(k.min(1))]),
            (value, _) => value,
        })
    }

    /// `expr` as the GPU computes it, NaN standing for missing.
    fn eval(&self, expr: &Expr, row: usize) -> f64 {
        match &*expr.0 {
            Node::Number(v) => *v,
            Node::Bool(b) => f64::from(u8::from(*b)),
            Node::Field(f) => match self.value(f, row) {
                Some(Value::Number(n)) => n,
                Some(Value::Bool(b)) => f64::from(u8::from(b)),
                _ => f64::NAN,
            },
            Node::Unary(op, a) => unary(*op, self.eval(a, row)),
            Node::Binary(op, a, b) => binary(*op, self.eval(a, row), self.eval(b, row)),
            Node::When(c, a, b) => {
                if self.eval(c, row) > 0.5 {
                    self.eval(a, row)
                } else {
                    self.eval(b, row)
                }
            }
            Node::Is(a, text) => {
                let Node::Field(f) = &*a.0 else { return f64::NAN };
                f64::from(u8::from(matches!(self.value(f, row), Some(Value::Text(t)) if *t == **text)))
            }
            Node::Contains(a, text) => {
                let Node::Field(f) = &*a.0 else { return f64::NAN };
                let held = |t: &str| t.to_lowercase().contains(&text.to_lowercase());
                f64::from(u8::from(matches!(self.value(f, row), Some(Value::Text(t)) if held(&t))))
            }
            Node::Scale { input, domain, range } => {
                let x = self.eval(input, row);
                if !x.is_finite() {
                    return x;
                }
                let [lo, hi] = match domain {
                    Domain::Fixed(d) => *d,
                    Domain::Fit => self.fit(input),
                };
                let span = hi - lo;
                let t = if span == 0.0 { 0.5 } else { (x - lo) / span };
                range[0] + (range[1] - range[0]) * t.clamp(0.0, 1.0)
            }
            Node::Color(_) | Node::Missing | Node::State(_) | Node::Colormap { .. } => f64::NAN,
        }
    }

    /// The extent of `input` over every row, as a fitted domain reduces it.
    fn fit(&self, input: &Expr) -> [f64; 2] {
        let key = Arc::as_ptr(&input.0);
        if let Some(&extent) = self.fitted.borrow().get(&key) {
            return extent;
        }
        let mut extent = [f64::INFINITY, f64::NEG_INFINITY];
        for row in 0..self.table.len() {
            let x = self.eval(input, row);
            if x.is_finite() {
                extent = [extent[0].min(x), extent[1].max(x)];
            }
        }
        if extent[0] > extent[1] {
            extent = [0.0, 1.0];
        }
        self.fitted.borrow_mut().insert(key, extent);
        extent
    }
}

fn unary(op: Unary, a: f64) -> f64 {
    match op {
        Unary::Neg => -a,
        Unary::Not => f64::from(u8::from(a <= 0.5)),
        Unary::Abs => a.abs(),
        Unary::Sqrt => a.sqrt(),
        Unary::Sin => a.sin(),
        Unary::Cos => a.cos(),
        Unary::Floor => a.floor(),
        Unary::Ln => a.ln(),
        Unary::Exp => a.exp(),
    }
}

fn binary(op: Binary, a: f64, b: f64) -> f64 {
    let truth = |v: bool| f64::from(u8::from(v));
    match op {
        Binary::Add => a + b,
        Binary::Sub => a - b,
        Binary::Mul => a * b,
        Binary::Div => a / b,
        Binary::Rem => a - b * (a / b).floor(),
        Binary::Pow => a.powf(b),
        Binary::Min => a.min(b),
        Binary::Max => a.max(b),
        Binary::Lt => truth(a < b),
        Binary::Le => truth(a <= b),
        Binary::Gt => truth(a > b),
        Binary::Ge => truth(a >= b),
        Binary::Eq => truth(a == b),
        Binary::Ne => truth(a != b),
        Binary::And => truth(a > 0.5 && b > 0.5),
        Binary::Or => truth(a > 0.5 || b > 0.5),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Ids, Table, field, when};

    #[test]
    fn numbers_follow_the_gpu() {
        let table = Table::new("T", Ids::count(3))
            .field("w", vec![Some(10.0), None, Some(30.0)])
            .field("on", vec![true, false, true]);
        let rows = Rows::new(&table, &[]);
        let size = field("w") * 2.0 + 4.0;
        assert_eq!(rows.number(&size, 0), Some(24.0));
        assert_eq!(rows.number(&size, 1), None, "missing stays missing");
        let pick = when(field("on")).then(1.0).otherwise(2.0);
        assert_eq!((0..3).map(|r| rows.number(&pick, r)).collect::<Vec<_>>(), [Some(1.0), Some(2.0), Some(1.0)]);
        let scaled: Expr = field("w").scale(0.0..=1.0).into();
        assert_eq!(rows.number(&scaled, 2), Some(1.0), "a fitted domain spans the values");
    }
}
