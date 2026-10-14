use std::ops::Range;
use std::sync::Arc;

use super::bits::{Bits, BitsBuilder};
use super::buffer::Buffer;
use super::geometry::{Geometry, GeometryBuilder};
use super::name::Row;
use super::text::{Text, TextBuilder};
use crate::{Error, Result};

/// One column of values, as given to [`Table::field`](crate::Table::field) or read from a page.
///
/// Converts from vectors and slices of numbers, booleans, texts, and geometries, with `Option` for
/// missing values. Slicing and cloning never copy.
#[derive(Clone)]
pub struct Values {
    pub(crate) array: Array,
    pub(crate) valid: Option<Bits>,
}

#[derive(Clone)]
pub(crate) enum Array {
    F64(Buffer<f64>),
    F32(Buffer<f32>),
    I32(Buffer<i32>),
    U32(Buffer<u32>),
    U64(Buffer<u64>),
    Bool(Bits),
    Text(Text),
    Geometry(Geometry),
}

/// What a field holds.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize), serde(rename_all = "lowercase"))]
pub enum Kind {
    /// Numbers.
    Number,
    /// Booleans.
    Bool,
    /// Texts.
    Text,
    /// Geometries of a depth: 0 point, 1 path, 2 parts (rings or paths), 3 polygons.
    Geometry(u8),
    /// Rows of another table, by id.
    Reference,
    /// Numbers sampled over the data's axis.
    Sampled,
}

/// One value read from a dataset.
#[derive(Clone, PartialEq, Debug)]
pub enum Value {
    /// A number.
    Number(f64),
    /// A boolean.
    Bool(bool),
    /// A text.
    Text(Arc<str>),
    /// A point.
    Point([f64; 2]),
    /// A path.
    Path(Vec<[f64; 2]>),
    /// Parts: the rings of a polygon, or the paths of a multi-path.
    Parts(Vec<Vec<[f64; 2]>>),
    /// Polygons of rings.
    Polygons(Vec<Vec<Vec<[f64; 2]>>>),
    /// The row a reference names.
    Row(Row),
}

/// Where a value of an assembled column comes from: `(source, row)`, or `None` for missing.
pub(crate) type Pick = Option<(usize, usize)>;

impl Values {
    /// The number of values.
    pub fn len(&self) -> usize {
        match &self.array {
            Array::F64(v) => v.len(),
            Array::F32(v) => v.len(),
            Array::I32(v) => v.len(),
            Array::U32(v) => v.len(),
            Array::U64(v) => v.len(),
            Array::Bool(v) => v.len(),
            Array::Text(v) => v.len(),
            Array::Geometry(v) => v.len(),
        }
    }

    /// Whether there are no values.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// What the values are.
    pub fn kind(&self) -> Kind {
        match &self.array {
            Array::F64(_) | Array::F32(_) | Array::I32(_) | Array::U32(_) | Array::U64(_) => Kind::Number,
            Array::Bool(_) => Kind::Bool,
            Array::Text(_) => Kind::Text,
            Array::Geometry(g) => Kind::Geometry(g.depth()),
        }
    }

    /// Whether value `i` is present.
    pub fn is_valid(&self, i: usize) -> bool {
        i < self.len() && self.valid.as_ref().is_none_or(|v| v.get(i))
    }

    /// Value `i`, or `None` when it is missing.
    pub fn get(&self, i: usize) -> Option<Value> {
        if !self.is_valid(i) {
            return None;
        }
        Some(match &self.array {
            Array::Bool(v) => Value::Bool(v.get(i)),
            Array::Text(v) => Value::Text(v.get(i).into()),
            Array::Geometry(v) => v.get(i),
            _ => Value::Number(self.number(i)),
        })
    }

    /// A zero-copy slice.
    #[must_use]
    pub fn slice(&self, range: Range<usize>) -> Values {
        let array = match &self.array {
            Array::F64(v) => Array::F64(v.slice(range.clone())),
            Array::F32(v) => Array::F32(v.slice(range.clone())),
            Array::I32(v) => Array::I32(v.slice(range.clone())),
            Array::U32(v) => Array::U32(v.slice(range.clone())),
            Array::U64(v) => Array::U64(v.slice(range.clone())),
            Array::Bool(v) => Array::Bool(v.slice(range.clone())),
            Array::Text(v) => Array::Text(v.slice(range.clone())),
            Array::Geometry(v) => Array::Geometry(v.slice(range.clone())),
        };
        Values { array, valid: self.valid.as_ref().map(|v| v.slice(range)) }
    }

    /// Every value as `number` reads it, `None` where missing, mapped by `f`: a loop per storage, so
    /// the storage is matched once rather than per value.
    pub(crate) fn map_numbers<T>(&self, mut f: impl FnMut(Option<f64>) -> T) -> Vec<T> {
        macro_rules! each {
            ($v:expr, $number:expr) => {
                match &self.valid {
                    None => $v.iter().map(|&x| f(Some($number(x)))).collect(),
                    Some(valid) => $v.iter().enumerate().map(|(i, &x)| f(valid.get(i).then(|| $number(x)))).collect(),
                }
            };
        }
        match &self.array {
            Array::F64(v) => each!(v, |x: f64| x),
            Array::F32(v) => each!(v, f64::from),
            Array::I32(v) => each!(v, f64::from),
            Array::U32(v) => each!(v, f64::from),
            Array::U64(v) => each!(v, |x: u64| x as f64),
            _ => (0..self.len()).map(|i| f(self.is_valid(i).then(|| self.number(i)))).collect(),
        }
    }

    /// Value `i` as a number; booleans are 0 or 1, others NaN.
    pub(crate) fn number(&self, i: usize) -> f64 {
        match &self.array {
            Array::F64(v) => v[i],
            Array::F32(v) => f64::from(v[i]),
            Array::I32(v) => f64::from(v[i]),
            Array::U32(v) => f64::from(v[i]),
            Array::U64(v) => v[i] as f64,
            Array::Bool(v) => f64::from(u8::from(v.get(i))),
            Array::Text(_) | Array::Geometry(_) => f64::NAN,
        }
    }

    pub(crate) fn text(&self) -> Option<&Text> {
        match &self.array {
            Array::Text(t) => Some(t),
            _ => None,
        }
    }

    pub(crate) fn geometry(&self) -> Option<&Geometry> {
        match &self.array {
            Array::Geometry(g) => Some(g),
            _ => None,
        }
    }

    /// Geometries as values, every one present.
    pub(crate) fn of_geometry(geometry: Geometry) -> Values {
        Values { array: Array::Geometry(geometry), valid: None }
    }

    /// `len` values whose `i`th is row `pick(i).1` of source `pick(i).0`, or missing for `None`.
    ///
    /// The result keeps the first source's storage; numbers from other sources convert to it. A
    /// source of another kind is an error.
    pub(crate) fn assemble(sources: &[&Values], len: usize, pick: impl Fn(usize) -> Pick) -> Result<Values> {
        let like = sources.first().expect("a source");
        let kind = like.kind();
        if let Some(other) = sources.iter().find(|s| s.kind() != kind) {
            return Err(Error::invalid(format!("{:?} values for a {kind:?} field", other.kind())));
        }
        macro_rules! numbers {
            ($variant:ident, $t:ty, $store:expr) => {{
                let cast: Vec<Values> = sources.iter().map(|s| s.cast(|x| x as $t, $store)).collect();
                let typed: Vec<&[$t]> = cast
                    .iter()
                    .map(|values| match &values.array {
                        Array::$variant(v) => &v[..],
                        _ => unreachable!("cast to the first source's storage"),
                    })
                    .collect();
                Array::$variant((0..len).map(|i| pick(i).map_or(<$t>::default(), |(s, r)| typed[s][r])).collect())
            }};
        }
        let array = match &like.array {
            Array::F64(_) => numbers!(F64, f64, Store::F64),
            Array::F32(_) => numbers!(F32, f32, Store::F32),
            Array::I32(_) => numbers!(I32, i32, Store::I32),
            Array::U32(_) => numbers!(U32, u32, Store::U32),
            Array::U64(_) => numbers!(U64, u64, Store::U64),
            Array::Bool(_) => Array::Bool(
                (0..len)
                    .map(|i| pick(i).is_some_and(|(s, r)| matches!(&sources[s].array, Array::Bool(v) if v.get(r))))
                    .collect(),
            ),
            Array::Text(_) => {
                let mut builder = TextBuilder::with_capacity(len);
                for i in 0..len {
                    builder.push(pick(i).and_then(|(s, r)| sources[s].text().map(|t| t.get(r))).unwrap_or(""));
                }
                Array::Text(builder.finish())
            }
            Array::Geometry(g) => {
                let mut builder = GeometryBuilder::new(g.depth());
                for i in 0..len {
                    match pick(i).and_then(|(s, r)| sources[s].geometry().map(|g| (g, r))) {
                        Some((geometry, r)) => builder.push_from(geometry, r),
                        None => builder.push_empty(),
                    }
                }
                Array::Geometry(builder.finish())
            }
        };
        let mut bits = BitsBuilder::with_capacity(len);
        let mut all = true;
        for i in 0..len {
            let valid = pick(i).is_some_and(|(s, r)| sources[s].is_valid(r));
            all &= valid;
            bits.push(valid);
        }
        Ok(Values { array, valid: (!all).then(|| bits.finish()) })
    }

    /// Numbers converted to `store`; other kinds unchanged.
    fn cast<T: Copy>(&self, convert: impl Fn(f64) -> T, store: Store) -> Values
    where
        Buffer<T>: Into<Array>,
    {
        let same = matches!(
            (&self.array, store),
            (Array::F64(_), Store::F64)
                | (Array::F32(_), Store::F32)
                | (Array::I32(_), Store::I32)
                | (Array::U32(_), Store::U32)
                | (Array::U64(_), Store::U64)
        );
        if same || self.kind() != Kind::Number {
            return self.clone();
        }
        let converted = self.map_numbers(|x| convert(x.unwrap_or(0.0)));
        Values { array: Buffer::from(converted).into(), valid: self.valid.clone() }
    }
}

#[derive(Clone, Copy)]
enum Store {
    F64,
    F32,
    I32,
    U32,
    U64,
}

macro_rules! array_from_buffer {
    ($($variant:ident: $t:ty),*) => {$(
        impl From<Buffer<$t>> for Array {
            fn from(buffer: Buffer<$t>) -> Array {
                Array::$variant(buffer)
            }
        }
    )*};
}

array_from_buffer!(F64: f64, F32: f32, I32: i32, U32: u32, U64: u64);

macro_rules! numbers_from {
    ($($variant:ident: $t:ty),*) => {$(
        impl From<Vec<$t>> for Values {
            fn from(values: Vec<$t>) -> Values {
                Values { array: Array::$variant(values.into()), valid: None }
            }
        }

        impl From<&[$t]> for Values {
            fn from(values: &[$t]) -> Values {
                Values { array: Array::$variant(values.into()), valid: None }
            }
        }

        impl<const N: usize> From<[$t; N]> for Values {
            fn from(values: [$t; N]) -> Values {
                Values::from(&values[..])
            }
        }

        impl From<Vec<Option<$t>>> for Values {
            fn from(values: Vec<Option<$t>>) -> Values {
                let valid = Bits::from_fn(values.len(), |i| values[i].is_some());
                let array = Array::$variant(values.iter().map(|v| v.unwrap_or_default()).collect());
                Values { array, valid: (!valid.all()).then_some(valid) }
            }
        }
    )*};
}

numbers_from!(F64: f64, F32: f32, I32: i32, U32: u32, U64: u64);

impl From<Vec<bool>> for Values {
    fn from(values: Vec<bool>) -> Values {
        Values::from(&values[..])
    }
}

impl From<&[bool]> for Values {
    fn from(values: &[bool]) -> Values {
        Values { array: Array::Bool(Bits::from_fn(values.len(), |i| values[i])), valid: None }
    }
}

impl From<Vec<Option<bool>>> for Values {
    fn from(values: Vec<Option<bool>>) -> Values {
        let valid = Bits::from_fn(values.len(), |i| values[i].is_some());
        let array = Array::Bool(Bits::from_fn(values.len(), |i| values[i] == Some(true)));
        Values { array, valid: (!valid.all()).then_some(valid) }
    }
}

fn texts<'a>(texts: impl IntoIterator<Item = Option<&'a str>>) -> Values {
    let mut builder = TextBuilder::default();
    let mut valid = BitsBuilder::with_capacity(0);
    let mut all = true;
    for text in texts {
        all &= text.is_some();
        valid.push(text.is_some());
        builder.push(text.unwrap_or(""));
    }
    Values { array: Array::Text(builder.finish()), valid: (!all).then(|| valid.finish()) }
}

impl From<Vec<String>> for Values {
    fn from(values: Vec<String>) -> Values {
        texts(values.iter().map(|t| Some(t.as_str())))
    }
}

impl From<Vec<&str>> for Values {
    fn from(values: Vec<&str>) -> Values {
        texts(values.into_iter().map(Some))
    }
}

impl From<&[&str]> for Values {
    fn from(values: &[&str]) -> Values {
        texts(values.iter().copied().map(Some))
    }
}

impl From<&[String]> for Values {
    fn from(values: &[String]) -> Values {
        texts(values.iter().map(|t| Some(t.as_str())))
    }
}

impl<const N: usize> From<[&str; N]> for Values {
    fn from(values: [&str; N]) -> Values {
        texts(values.into_iter().map(Some))
    }
}

impl From<Vec<Option<String>>> for Values {
    fn from(values: Vec<Option<String>>) -> Values {
        texts(values.iter().map(Option::as_deref))
    }
}

impl From<Vec<Option<&str>>> for Values {
    fn from(values: Vec<Option<&str>>) -> Values {
        texts(values)
    }
}

fn geometries(depth: u8, values: impl IntoIterator<Item = Value>) -> Values {
    let mut builder = GeometryBuilder::new(depth);
    for value in values {
        builder.push_value(&value);
    }
    Values { array: Array::Geometry(builder.finish()), valid: None }
}

impl From<Vec<[f64; 2]>> for Values {
    fn from(points: Vec<[f64; 2]>) -> Values {
        Values { array: Array::Geometry(Geometry::from_parts(0, Vec::new(), points).expect("points")), valid: None }
    }
}

impl From<Vec<Vec<[f64; 2]>>> for Values {
    fn from(paths: Vec<Vec<[f64; 2]>>) -> Values {
        geometries(1, paths.into_iter().map(Value::Path))
    }
}

impl From<Vec<Vec<Vec<[f64; 2]>>>> for Values {
    fn from(parts: Vec<Vec<Vec<[f64; 2]>>>) -> Values {
        geometries(2, parts.into_iter().map(Value::Parts))
    }
}

impl From<Vec<Vec<Vec<Vec<[f64; 2]>>>>> for Values {
    fn from(polygons: Vec<Vec<Vec<Vec<[f64; 2]>>>>) -> Values {
        geometries(3, polygons.into_iter().map(Value::Polygons))
    }
}

impl From<Values> for Vec<Option<Value>> {
    fn from(values: Values) -> Vec<Option<Value>> {
        (0..values.len()).map(|i| values.get(i)).collect()
    }
}

impl std::fmt::Debug for Values {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries((0..self.len()).map(|i| self.get(i))).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assemble_scatters_and_converts() {
        let base = Values::from(vec![1.0_f64, 2.0, 3.0]);
        let source = Values::from(vec![10_i32, 20]);
        let picks = [Some((0, 0)), Some((1, 1)), None, Some((1, 0))];
        let out = Values::assemble(&[&base, &source], 4, |i| picks[i]).expect("numbers");
        assert_eq!(
            Vec::<Option<Value>>::from(out),
            vec![Some(Value::Number(1.0)), Some(Value::Number(20.0)), None, Some(Value::Number(10.0))]
        );
    }

    #[test]
    fn assemble_refuses_another_kind() {
        let base = Values::from(vec![1.0_f64]);
        let source = Values::from(vec!["a"]);
        assert!(Values::assemble(&[&base, &source], 1, |_| Some((1, 0))).is_err());
    }

    #[test]
    fn texts_keep_missing() {
        let values = Values::from(vec![Some("a"), None, Some("c")]);
        assert_eq!(values.get(1), None);
        assert_eq!(values.slice(1..3).get(1), Some(Value::Text("c".into())));
    }

    #[test]
    fn assemble_gathers_across_sources() {
        let a = Values::from(vec!["x", "y"]);
        let b = Values::from(vec!["z"]);
        let joined = Values::assemble(&[&a, &b], 3, |i| Some(if i < 2 { (0, i) } else { (1, 0) })).expect("texts");
        assert_eq!(joined.len(), 3);
        assert_eq!(joined.get(2), Some(Value::Text("z".into())));
    }
}
