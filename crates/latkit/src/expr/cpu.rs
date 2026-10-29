//! Evaluates expressions on the CPU, for work that needs only data: a diagram's sheet
//! (positions, sizes, and block label texts), layouts, row priorities, fitted domains of paged
//! tables, and queries (filters, sort keys, and selections). The GPU evaluates the same expressions
//! for drawing. Here they read only fields, with sampled fields read at one axis coordinate.

use std::cell::RefCell;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::{Binary, Domain, Expr, FieldRef, Node, Unary};
use crate::Kind;
use crate::data::{Field, Geometry, Snapshot, Table, Value};

/// The rows an expression reads: a table, and every dataset its joins may name.
pub(crate) struct Rows<'a> {
    pub(crate) table: &'a Table,
    pub(crate) all: &'a [Snapshot],
    /// The axis coordinate at which sampled fields are read. Defaults to infinity, which reads
    /// their last frame.
    at: f64,
    /// Fitted domains already computed, keyed by their input node.
    fitted: RefCell<FxHashMap<*const Node, [f64; 2]>>,
    /// The texts `contains` looks for, lowercased once.
    lowered: RefCell<FxHashMap<Arc<str>, Arc<str>>>,
}

impl<'a> Rows<'a> {
    pub(crate) fn new(table: &'a Table, all: &'a [Snapshot]) -> Rows<'a> {
        Rows { table, all, at: f64::INFINITY, fitted: RefCell::default(), lowered: RefCell::default() }
    }

    /// `text` lowercased for `contains`, cached.
    fn lowered(&self, text: &Arc<str>) -> Arc<str> {
        self.lowered.borrow_mut().entry(text.clone()).or_insert_with(|| text.to_lowercase().into()).clone()
    }

    /// These rows, with sampled fields read at axis coordinate `at`.
    pub(crate) fn at(mut self, at: f64) -> Rows<'a> {
        self.at = at;
        self
    }

    /// `expr` evaluated for `row`. `None` where the result is missing or not a finite number.
    pub(crate) fn number(&self, expr: &Expr, row: usize) -> Option<f64> {
        let v = self.eval(expr, row);
        v.is_finite().then_some(v)
    }

    /// `expr` evaluated for every row and converted by `make`, with NaN for missing values. A
    /// constant fills every row, and a plain field of the table is read page by page. Anything else
    /// is evaluated row by row.
    pub(crate) fn numbers<T>(&self, expr: &Expr, mut make: impl FnMut(f64) -> T) -> Vec<T> {
        let n = self.table.len();
        let mut out = Vec::with_capacity(n);
        match &*expr.0 {
            Node::Number(v) => {
                out.resize_with(n, || make(*v));
                return out;
            }
            Node::Field(f) if f.from.is_none() => {
                if let Some(Field::Values(column, _)) = self.table.field_named(&f.name) {
                    let pages = column.pages().iter().map(|p| &p.values);
                    match (column.kind(), f.component) {
                        (Kind::Number | Kind::Bool, None) => {
                            pages.for_each(|v| v.extend_numbers(&mut out, |x| make(x.unwrap_or(f64::NAN))));
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

    /// The text `expr` gives `row`: a text field's value, or the value a `when` picks. `None` where
    /// it is missing.
    pub(crate) fn text(&self, expr: &Expr, row: usize) -> Option<Arc<str>> {
        match &*expr.0 {
            Node::Field(f) => match self.value(f, row)? {
                Value::Text(text) => Some(text),
                _ => None,
            },
            Node::When(c, a, b) => self.text(if self.eval(c, row) > 0.5 { a } else { b }, row),
            _ => None,
        }
    }

    /// Field `f`'s value in `row`: from the table, or for a join, from the joined table's row with
    /// the same id.
    fn value(&self, f: &FieldRef, row: usize) -> Option<Value> {
        let value = match &f.from {
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

    /// `expr` computed as the GPU computes it, with NaN for missing.
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
                let needle = self.lowered(text);
                f64::from(u8::from(matches!(self.value(f, row), Some(Value::Text(t)) if super::holds(&t, &needle))))
            }
            Node::Scale { input, domain, range } => {
                let x = self.eval(input, row);
                if !x.is_finite() {
                    return x;
                }
                let [lo, hi] = match domain {
                    Domain::Fixed(d) => *d,
                    Domain::Fit | Domain::All => self.fit(input),
                };
                let span = hi - lo;
                let t = if span == 0.0 { 0.5 } else { (x - lo) / span };
                range[0] + (range[1] - range[0]) * t.clamp(0.0, 1.0)
            }
            Node::Color(_) | Node::Missing | Node::State(_) | Node::Colormap { .. } => f64::NAN,
        }
    }

    /// The extent of `input` over every row, as a fitted domain computes it. `[0, 1]` when no row
    /// has a value.
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
        Binary::Fallback => {
            if a.is_finite() {
                a
            } else {
                b
            }
        }
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
    fn cpu_evaluation_matches_the_gpu() {
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
        let filled = field("w").fallback(5.0);
        assert_eq!((0..3).map(|r| rows.number(&filled, r)).collect::<Vec<_>>(), [Some(10.0), Some(5.0), Some(30.0)]);
    }

    #[test]
    fn a_conditional_text_gives_its_field_or_nothing() {
        let table = Table::new("T", Ids::count(2)).field("name", vec!["a", "b"]).field("on", vec![true, false]);
        let rows = Rows::new(&table, &[]);
        let text = when(field("on")).then(field("name")).otherwise(Expr::missing());
        assert_eq!(rows.text(&text, 0).as_deref(), Some("a"));
        assert_eq!(rows.text(&text, 1), None, "a missing text is no text");
    }
}
