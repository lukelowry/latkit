use std::ops::Range;
use std::sync::Arc;

use super::bits::{Bits, BitsBuilder};
use super::buffer::Buffer;
use super::column::{PAGE_BITS, PAGE_MASK};
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

/// The kind of values a field holds.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Numbers.
    Number,
    /// Booleans.
    Bool,
    /// Texts.
    Text,
    /// `[x, y]` points.
    Point,
    /// Paths of points.
    Path,
    /// Parts: the rings of a polygon, or the paths of a multi-path.
    Parts,
    /// Polygons of rings.
    Polygons,
    /// Rows of another table, by id.
    Reference,
    /// Numbers sampled over the dataset's axis.
    Sampled,
}

impl Kind {
    /// The geometry kind of nesting depth `depth`: 0 a point, 1 a path, 2 parts, 3 or more
    /// polygons.
    pub(crate) fn geometry(depth: u8) -> Kind {
        match depth {
            0 => Kind::Point,
            1 => Kind::Path,
            2 => Kind::Parts,
            _ => Kind::Polygons,
        }
    }

    /// A geometry kind's nesting depth, or `None` for other kinds.
    pub(crate) fn depth(self) -> Option<u8> {
        match self {
            Kind::Point => Some(0),
            Kind::Path => Some(1),
            Kind::Parts => Some(2),
            Kind::Polygons => Some(3),
            _ => None,
        }
    }
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

/// Serializes as JSON. Numbers, booleans, and texts are written as is, with non-finite numbers as
/// `null`. A geometry is nested `[x, y]` points, and a reference is its target row's id.
impl serde::Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Number(n) if n.is_finite() => serializer.serialize_f64(*n),
            Value::Number(_) => serializer.serialize_none(),
            Value::Bool(b) => serializer.serialize_bool(*b),
            Value::Text(t) => serializer.serialize_str(t),
            Value::Point(p) => p.serialize(serializer),
            Value::Path(p) => p.serialize(serializer),
            Value::Parts(p) => p.serialize(serializer),
            Value::Polygons(p) => p.serialize(serializer),
            Value::Row(row) => row.id.serialize(serializer),
        }
    }
}

/// The schema of a value's JSON form.
impl schemars::JsonSchema for Value {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Value".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "A value read from a dataset: a number (`null` when not finite), boolean, or text; a geometry as nested `[x, y]` points; a reference as the id of the row it names.",
            "anyOf": [
                { "type": ["number", "boolean", "string", "null"] },
                { "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2 },
                { "type": "array", "items": { "type": "array" } },
            ],
        })
    }
}

/// Where each output value of [`Values::assemble`] comes from. Source 0 is the first source. The
/// sources after it are pages of [`PAGE_ROWS`](super::column::PAGE_ROWS) rows, addressed by row.
/// It is a concrete type, not a closure, so [`Values::assemble`] is compiled only once.
#[derive(Clone, Copy)]
pub(crate) enum Picks<'a> {
    /// Value `i` is row `rows[i]` of the pages.
    Rows(&'a [usize]),
    /// Value `i` is row `from[i]` of the pages where it is written, else row `i` of the first
    /// source while `i < kept`, else missing.
    Writes { from: &'a [Option<usize>], kept: usize },
}

/// A run of values to copy, and its length. The run is a source and its first row, with
/// consecutive rows following, or `None` for missing values.
type Run = (Option<(usize, usize)>, usize);

impl Picks<'_> {
    fn len(self) -> usize {
        match self {
            Picks::Rows(rows) => rows.len(),
            Picks::Writes { from, .. } => from.len(),
        }
    }

    /// The source and row of value `i`, or `None` where it is missing.
    #[inline]
    fn get(self, i: usize) -> Option<(usize, usize)> {
        let paged = |row: usize| Some((1 + (row >> PAGE_BITS), row & PAGE_MASK));
        match self {
            Picks::Rows(rows) => paged(rows[i]),
            Picks::Writes { from, kept } => match from[i] {
                Some(row) => paged(row),
                None => (i < kept).then_some((0, i)),
            },
        }
    }

    /// The picks grouped into runs, in order.
    fn runs(self) -> Vec<Run> {
        let mut runs: Vec<Run> = Vec::new();
        for i in 0..self.len() {
            let pick = self.get(i);
            match runs.last_mut() {
                Some((Some((s, r)), n)) if pick == Some((*s, *r + *n)) => *n += 1,
                Some((None, n)) if pick.is_none() => *n += 1,
                _ => runs.push((pick, 1)),
            }
        }
        runs
    }
}

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

    /// The kind of the values.
    pub fn kind(&self) -> Kind {
        match &self.array {
            Array::F64(_) | Array::F32(_) | Array::I32(_) | Array::U32(_) | Array::U64(_) => Kind::Number,
            Array::Bool(_) => Kind::Bool,
            Array::Text(_) => Kind::Text,
            Array::Geometry(g) => Kind::geometry(g.depth()),
        }
    }

    /// Whether any value is present. Values that are all missing fit a field of any kind.
    pub(crate) fn holds_any(&self) -> bool {
        !self.is_empty() && self.valid.as_ref().is_none_or(Bits::any)
    }

    /// Whether value `i` exists and is not missing.
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

    /// Value `i` as a row id. `None` when missing, or when the values are not stored as `u64`
    /// numbers or texts.
    pub fn id(&self, i: usize) -> Option<super::name::Id> {
        super::ids::key(self, i).map(super::name::IdRef::to_id)
    }

    /// Every value as a number, with NaN for missing values. `None` if the values are not numbers.
    pub fn numbers(&self) -> Option<Vec<f64>> {
        (self.kind() == Kind::Number).then(|| self.map_numbers(|x| x.unwrap_or(f64::NAN)))
    }

    /// A slice of the values, without copying. Panics if `range` is out of bounds.
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

    /// Maps every value through `f`. Values are read like `number`, with `None` where missing.
    pub(crate) fn map_numbers<T>(&self, f: impl FnMut(Option<f64>) -> T) -> Vec<T> {
        let mut out = Vec::with_capacity(self.len());
        self.extend_numbers(&mut out, f);
        out
    }

    /// Appends every value to `out`, mapped through `f`. Values are read like `number`, with `None`
    /// where missing. Each storage type has its own loop, so the storage is matched once, not per
    /// value.
    pub(crate) fn extend_numbers<T>(&self, out: &mut Vec<T>, mut f: impl FnMut(Option<f64>) -> T) {
        macro_rules! each {
            ($v:expr, $number:expr) => {
                match &self.valid {
                    None => out.extend($v.iter().map(|&x| f(Some($number(x))))),
                    Some(valid) => out.extend($v.iter().enumerate().map(|(i, &x)| f(valid.get(i).then(|| $number(x))))),
                }
            };
        }
        match &self.array {
            Array::F64(v) => each!(v, |x: f64| x),
            Array::F32(v) => each!(v, f64::from),
            Array::I32(v) => each!(v, f64::from),
            Array::U32(v) => each!(v, f64::from),
            Array::U64(v) => each!(v, |x: u64| x as f64),
            _ => out.extend((0..self.len()).map(|i| f(self.is_valid(i).then(|| self.number(i))))),
        }
    }

    /// Value `i` as a number. Booleans are 0 or 1, and texts and geometries are NaN.
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

    /// The number of points shaders read for the present geometries. That is every coordinate,
    /// plus one break between a row's parts or rings. 0 for values that are not geometries.
    pub(crate) fn points(&self) -> usize {
        let Some(geometry) = self.geometry() else { return 0 };
        (0..self.len()).filter(|&row| self.is_valid(row)).map(|row| geometry.row_points(row)).sum()
    }

    /// Values holding `geometry`, none missing.
    pub(crate) fn of_geometry(geometry: Geometry) -> Values {
        Values { array: Array::Geometry(geometry), valid: None }
    }

    /// Geometry of `depth` that copies each of `rows`. Each is a row of a geometry, or `None` for
    /// an empty row, which draws nothing.
    pub(crate) fn of_rows<'g>(depth: u8, rows: impl IntoIterator<Item = Option<(&'g Geometry, usize)>>) -> Values {
        let mut builder = GeometryBuilder::new(depth);
        for row in rows {
            match row {
                Some((geometry, i)) => builder.push_from(geometry, i),
                None => builder.push_empty(),
            }
        }
        Values::of_geometry(builder.finish())
    }

    /// A field of `values`, typed by the values present. It is numbers if every present value is a
    /// number, booleans if every one is a boolean, and texts otherwise, with other values written
    /// as text. GeoJSON and vector tile properties are typed this way.
    pub(crate) fn infer(values: &[Option<Value>]) -> Values {
        let present = || values.iter().flatten();
        if present().all(|v| matches!(v, Value::Number(_))) {
            let numbers = values.iter().map(|v| if let Some(Value::Number(n)) = v { Some(*n) } else { None });
            return numbers.collect::<Vec<_>>().into();
        }
        if present().all(|v| matches!(v, Value::Bool(_))) {
            let booleans = values.iter().map(|v| if let Some(Value::Bool(b)) = v { Some(*b) } else { None });
            return booleans.collect::<Vec<_>>().into();
        }
        let text = |value: &Value| match value {
            Value::Text(text) => text.to_string(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            other => serde_json::to_string(other).unwrap_or_default(),
        };
        values.iter().map(|v| v.as_ref().map(text)).collect::<Vec<Option<String>>>().into()
    }

    /// The values `picks` names among `sources`, missing where it names none.
    ///
    /// The result keeps the first source's storage, and numbers from other sources convert to it.
    /// A source of another kind is an error.
    pub(crate) fn assemble(sources: &[&Values], picks: Picks<'_>) -> Result<Values> {
        let kind = sources.first().expect("a source").kind();
        if let Some(other) = sources.iter().find(|s| s.kind() != kind) {
            return Err(Error::invalid(format!("{:?} values for a {kind:?} field", other.kind())));
        }
        // Consecutive rows from one source copy as a run.
        Ok(Values::of_runs(sources, &picks.runs()))
    }

    /// `parts` concatenated in the first part's storage, converting numbers from other storages.
    /// Joins a column's pages by copying each part whole. Every part must have the same kind as the
    /// first.
    pub(crate) fn concat(parts: &[&Values]) -> Values {
        debug_assert!(parts.iter().all(|p| p.kind() == parts[0].kind()));
        let runs: Vec<Run> = parts.iter().enumerate().map(|(s, part)| (Some((s, 0)), part.len())).collect();
        Values::of_runs(parts, &runs)
    }

    /// The values `runs` copy from `sources`, in the first source's storage. Numbers from other
    /// sources convert to it.
    fn of_runs(sources: &[&Values], runs: &[Run]) -> Values {
        let len = runs.iter().map(|&(_, n)| n).sum();
        let like = sources.first().expect("a source");
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
                let mut out: Vec<$t> = Vec::with_capacity(len);
                for &(run, n) in runs {
                    match run {
                        Some((s, r)) => out.extend_from_slice(&typed[s][r..r + n]),
                        None => out.resize(out.len() + n, <$t>::default()),
                    }
                }
                Array::$variant(out.into())
            }};
        }
        let array = match &like.array {
            Array::F64(_) => numbers!(F64, f64, Store::F64),
            Array::F32(_) => numbers!(F32, f32, Store::F32),
            Array::I32(_) => numbers!(I32, i32, Store::I32),
            Array::U32(_) => numbers!(U32, u32, Store::U32),
            Array::U64(_) => numbers!(U64, u64, Store::U64),
            Array::Bool(_) => Array::Bool(
                runs.iter()
                    .flat_map(|&(run, n)| (0..n).map(move |k| run.map(|(s, r)| (s, r + k))))
                    .map(|pick| pick.is_some_and(|(s, r)| matches!(&sources[s].array, Array::Bool(v) if v.get(r))))
                    .collect(),
            ),
            Array::Text(_) => {
                let mut builder = TextBuilder::with_capacity(len);
                for &(run, n) in runs {
                    match run.and_then(|(s, r)| Some((sources[s].text()?, r))) {
                        Some((text, r)) => (r..r + n).for_each(|i| builder.push(text.get(i))),
                        None => (0..n).for_each(|_| builder.push("")),
                    }
                }
                Array::Text(builder.finish())
            }
            Array::Geometry(g) => {
                let mut builder = GeometryBuilder::new(g.depth());
                for &(run, n) in runs {
                    match run.and_then(|(s, r)| Some((sources[s].geometry()?, r))) {
                        Some((geometry, r)) => builder.push_rows(geometry, r..r + n),
                        None => (0..n).for_each(|_| builder.push_empty()),
                    }
                }
                Array::Geometry(builder.finish())
            }
        };
        // No validity bits are needed when no run is missing and no source it reads has missing
        // values.
        let gaps = runs.iter().any(|(run, _)| run.is_none_or(|(s, _)| sources[s].valid.is_some()));
        if !gaps {
            return Values { array, valid: None };
        }
        let mut bits = BitsBuilder::with_capacity(len);
        let mut all = true;
        for &(run, n) in runs {
            for k in 0..n {
                let valid = run.is_some_and(|(s, r)| sources[s].is_valid(r + k));
                all &= valid;
                bits.push(valid);
            }
        }
        Values { array, valid: (!all).then(|| bits.finish()) }
    }

    /// Whether `other` holds exactly these values in the same storage. Compares the stored form
    /// without building any [`Value`]. Floats compare by their bits, so NaN equals itself.
    pub(crate) fn same(&self, other: &Values) -> bool {
        let len = self.len();
        if other.len() != len || (0..len).any(|i| self.is_valid(i) != other.is_valid(i)) {
            return false;
        }
        let bits = |a: &[f64], b: &[f64]| a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits());
        match (&self.array, &other.array) {
            (Array::F64(a), Array::F64(b)) => bits(a, b),
            (Array::F32(a), Array::F32(b)) => a.iter().zip(b.iter()).all(|(x, y)| x.to_bits() == y.to_bits()),
            (Array::I32(a), Array::I32(b)) => a[..] == b[..],
            (Array::U32(a), Array::U32(b)) => a[..] == b[..],
            (Array::U64(a), Array::U64(b)) => a[..] == b[..],
            (Array::Bool(a), Array::Bool(b)) => (0..len).all(|i| a.get(i) == b.get(i)),
            (Array::Text(a), Array::Text(b)) => a.iter().eq(b.iter()),
            (Array::Geometry(a), Array::Geometry(b)) => (0..len).all(|i| a.same_row(i, b, i)),
            _ => false,
        }
    }

    /// Whether value `i` equals value `j` of `other` as stored. Floats compare by their bits, so
    /// NaN equals itself. Two missing values are equal, and values in different storages differ.
    pub(crate) fn same_row(&self, i: usize, other: &Values, j: usize) -> bool {
        let valid = self.is_valid(i);
        if valid != other.is_valid(j) {
            return false;
        }
        if !valid {
            return true;
        }
        match (&self.array, &other.array) {
            (Array::F64(a), Array::F64(b)) => a[i].to_bits() == b[j].to_bits(),
            (Array::F32(a), Array::F32(b)) => a[i].to_bits() == b[j].to_bits(),
            (Array::I32(a), Array::I32(b)) => a[i] == b[j],
            (Array::U32(a), Array::U32(b)) => a[i] == b[j],
            (Array::U64(a), Array::U64(b)) => a[i] == b[j],
            (Array::Bool(a), Array::Bool(b)) => a.get(i) == b.get(j),
            (Array::Text(a), Array::Text(b)) => a.get(i) == b.get(j),
            (Array::Geometry(a), Array::Geometry(b)) => a.same_row(i, b, j),
            _ => false,
        }
    }

    /// Numbers converted to `store`. Other kinds are unchanged.
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

/// Builds a column from values of one kind, with `None` for missing, as JSON and JavaScript arrays
/// provide them. The first present value sets the kind: numbers, booleans, texts, or geometries of
/// equal nesting. A column with no present values is numbers. A missing point becomes NaN, and a
/// missing path, parts, or polygons value becomes empty. Mixed kinds and [`Value::Row`] are errors.
impl TryFrom<Vec<Option<Value>>> for Values {
    type Error = Error;

    fn try_from(values: Vec<Option<Value>>) -> Result<Values> {
        fn all<T>(values: Vec<Option<Value>>, of: impl Fn(Value) -> Option<T>) -> Result<Vec<Option<T>>> {
            let mixed = || {
                Error::invalid(
                    "a column must hold one kind of value: numbers, booleans, texts, or geometries of one depth",
                )
            };
            values.into_iter().map(|v| v.map(|v| of(v).ok_or_else(mixed)).transpose()).collect()
        }
        let Some(first) = values.iter().flatten().next() else { return Ok(vec![None::<f64>; values.len()].into()) };
        Ok(match first {
            Value::Number(_) => all(values, |v| if let Value::Number(n) = v { Some(n) } else { None })?.into(),
            Value::Bool(_) => all(values, |v| if let Value::Bool(b) = v { Some(b) } else { None })?.into(),
            Value::Text(_) => {
                let texts_of = all(values, |v| if let Value::Text(t) = v { Some(t) } else { None })?;
                texts(texts_of.iter().map(Option::as_deref))
            }
            Value::Point(_) => {
                let points = all(values, |v| if let Value::Point(p) = v { Some(p) } else { None })?;
                points.into_iter().map(|p| p.unwrap_or([f64::NAN; 2])).collect::<Vec<_>>().into()
            }
            Value::Path(_) => {
                let paths = all(values, |v| if let Value::Path(p) = v { Some(p) } else { None })?;
                paths.into_iter().map(Option::unwrap_or_default).collect::<Vec<_>>().into()
            }
            Value::Parts(_) => {
                let parts = all(values, |v| if let Value::Parts(p) = v { Some(p) } else { None })?;
                parts.into_iter().map(Option::unwrap_or_default).collect::<Vec<_>>().into()
            }
            Value::Polygons(_) => {
                let polygons = all(values, |v| if let Value::Polygons(p) = v { Some(p) } else { None })?;
                polygons.into_iter().map(Option::unwrap_or_default).collect::<Vec<_>>().into()
            }
            Value::Row(_) => return Err(Error::invalid("rows must be written as a reference: {reference, ids}")),
        })
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
        let from = [None, Some(1), None, Some(0)];
        let out = Values::assemble(&[&base, &source], Picks::Writes { from: &from, kept: 1 }).expect("numbers");
        assert_eq!(
            Vec::<Option<Value>>::from(out),
            vec![Some(Value::Number(1.0)), Some(Value::Number(20.0)), None, Some(Value::Number(10.0))]
        );
    }

    #[test]
    fn assemble_refuses_another_kind() {
        let base = Values::from(vec![1.0_f64]);
        let source = Values::from(vec!["a"]);
        assert!(Values::assemble(&[&base, &source], Picks::Rows(&[0])).is_err());
    }

    #[test]
    fn same_compares_the_stored_representation() {
        let a = Values::from(vec![Some(1.0_f64), None, Some(f64::NAN)]);
        assert!(a.same(&a.slice(0..3)), "a NaN equals itself");
        assert!(!a.same(&Values::from(vec![Some(1.0_f64), Some(0.0), Some(f64::NAN)])), "missing differs");
        assert!(!a.same(&Values::from(vec![1.0_f32, 0.0, 0.0])), "another storage differs");
        let path = |x: f64| Values::from(vec![vec![[0.0, 0.0], [x, 1.0]]]);
        assert!(path(2.0).same(&path(2.0)));
        assert!(!path(2.0).same(&path(3.0)));
    }

    #[test]
    fn concat_joins_parts_in_the_first_storage() {
        let a = Values::from(vec![Some(1.0_f64), None]);
        let b = Values::from(vec![3_i32]);
        let joined = Values::concat(&[&a, &b]);
        assert_eq!(Vec::<Option<Value>>::from(joined), vec![Some(Value::Number(1.0)), None, Some(Value::Number(3.0))]);
        let texts = Values::concat(&[&Values::from(vec!["x"]), &Values::from(vec![Some("y"), None])]);
        assert_eq!(texts.get(1), Some(Value::Text("y".into())));
        assert_eq!(texts.get(2), None);
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
        let from = [None, None, Some(0)];
        let joined = Values::assemble(&[&a, &b], Picks::Writes { from: &from, kept: 2 }).expect("texts");
        assert_eq!(joined.len(), 3);
        assert_eq!(joined.get(2), Some(Value::Text("z".into())));
    }
}
