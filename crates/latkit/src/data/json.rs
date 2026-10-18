//! Datasets and patches as JSON: the format is documented on [`Patch::from_json`].

use std::fmt;
use std::ops::Range;

use serde::Deserialize;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use super::data::Data;
use super::ids::Ids;
use super::patch::{Op, Patch};
use super::table::Table;
use super::values::Values;
use crate::{Error, Result};

/// What reads `bytes` of a file a slice names.
type Reader<'a> = dyn FnMut(&str, Range<u64>) -> Result<Vec<u8>> + 'a;

/// The largest whole number a JSON number names an id by when written with a fraction: 2^53 − 1.
const SAFE: f64 = 9_007_199_254_740_991.0;

impl Patch {
    /// A patch from its JSON: what any language writes without latkit. The patch is a list of the
    /// changes [`Patch`]'s methods make, each named by its method with its parameters by name.
    ///
    /// ```json
    /// [
    ///   {"put": {"table": "Bus", "ids": [101, 205], "fields": {"x": [0, 10], "name": ["North", "South"]}}},
    ///   {"put": {"table": "Branch", "ids": 1, "fields": {"from": {"reference": "Bus", "ids": [101]}}}},
    ///   {"axis": {"name": "time", "unit": "s"}},
    ///   {"append": {"at": [0, 0.5], "table": "Bus", "fields": {"vm": {"file": "vm.f32", "dtype": "f32le", "count": 4}}}}
    /// ]
    /// ```
    ///
    /// - `put` and `set` take `{table, ids, fields}`, `remove` `{table, ids}`, `append` `{at, table,
    ///   fields}`, `forget` `{before}`, and `axis` `{name, unit}`.
    /// - `ids` is a count naming rows `0..n`, or numbers or texts; `null` leaves a reference unwired.
    /// - A field is an array of numbers, booleans, texts, or `[x, y]` geometries (points, paths,
    ///   parts, polygons), `null` missing; `{"reference": table, "ids": ids}`; or a slice of a binary
    ///   file, `{"file", "dtype", "offset", "count"}`: `count` values from byte `offset` (0 unless
    ///   given) of dtype `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, or `u8` (booleans, nonzero true).
    /// - `append`'s `at` is one axis coordinate or several: values are frame-major, every row's
    ///   value at one coordinate, then at the next.
    ///
    /// A slice is read with `read(file, bytes)`, which gives exactly those bytes.
    ///
    /// ```
    /// # use latkit::{Data, Patch};
    /// let json = r#"[{"set": {"table": "Bus", "ids": [1, 2], "fields": {"kv": [345, 138]}}}]"#;
    /// let patch = Patch::from_json(json, |file, _| Err(latkit::Error::invalid(format!("no file {file}"))))?;
    /// let mut grid = Data::new("grid");
    /// grid.apply(patch)?;
    /// # Ok::<(), latkit::Error>(())
    /// ```
    pub fn from_json(json: &str, mut read: impl FnMut(&str, Range<u64>) -> Result<Vec<u8>>) -> Result<Patch> {
        let ops: Vec<OpForm> = serde_json::from_str(json).map_err(|e| Error::invalid(e.to_string()))?;
        patch(ops, &mut read)
    }
}

impl Data {
    /// A dataset from its JSON, `{"name": ..., "patch": [...]}`: its name and the patch that builds it,
    /// as its bytes are. The patch and its slices read as [`Patch::from_json`] reads them.
    pub fn from_json(json: &str, mut read: impl FnMut(&str, Range<u64>) -> Result<Vec<u8>>) -> Result<Data> {
        let form: DataForm = serde_json::from_str(json).map_err(|e| Error::invalid(e.to_string()))?;
        if form.name.is_empty() {
            return Err(Error::invalid("a dataset is named").at("name"));
        }
        let patch = patch(form.patch, &mut read).map_err(|e| e.at("patch"))?;
        let mut data = Data::new(form.name);
        data.apply(patch).map_err(|e| renamed(e, "patch"))?;
        Ok(data)
    }
}

/// `error` with its path's first step, the patch's `ops`, named `name` instead.
fn renamed(error: Error, name: &str) -> Error {
    match error {
        Error::Invalid { mut path, reason } => {
            if let Some(first) = path.0.first_mut() {
                *first = name.into();
            }
            Error::Invalid { path, reason }
        }
        other => other,
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DataForm {
    name: String,
    #[serde(default)]
    patch: Vec<OpForm>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
enum OpForm {
    Axis { name: String, unit: String },
    Put(TableForm),
    Set(TableForm),
    Remove { table: String, ids: IdsForm },
    Append { at: At, table: String, fields: Fields },
    Forget { before: f64 },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableForm {
    table: String,
    ids: IdsForm,
    #[serde(default)]
    fields: Fields,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum At {
    One(f64),
    Many(Vec<f64>),
}

/// The patch `ops` make, their slices read with `read`.
fn patch(ops: Vec<OpForm>, read: &mut Reader<'_>) -> Result<Patch> {
    let mut patch = Patch::new();
    for (i, op) in ops.into_iter().enumerate() {
        let op = match op {
            OpForm::Axis { name, unit } => Op::Axis { name: name.into(), unit: unit.into() },
            OpForm::Put(form) => Op::Put(table(form, read).map_err(|e| e.at(i))?),
            OpForm::Set(form) => Op::Set(table(form, read).map_err(|e| e.at(i))?),
            OpForm::Remove { table, ids } => Op::Remove { table: table.into(), ids: ids.0 },
            OpForm::Append { at, table, fields } => {
                let at = match at {
                    At::One(at) => vec![at],
                    At::Many(at) => at,
                };
                let mut columns = Vec::with_capacity(fields.0.len());
                for (name, column) in fields.0 {
                    let values = match column {
                        Column::Reference { .. } => Err(Error::invalid("append records values, not references")),
                        column => column.values(read),
                    };
                    let values = values.map_err(|e| e.at(name.as_str()).at(table.as_str()).at(i))?;
                    columns.push((name.into(), values));
                }
                Op::Append { table: table.into(), at, fields: columns }
            }
            OpForm::Forget { before } => Op::Forget { before },
        };
        patch.ops.push(op);
    }
    Ok(patch)
}

/// The table `form` writes, its slices read with `read`.
fn table(form: TableForm, read: &mut Reader<'_>) -> Result<Table> {
    let name = form.table;
    let mut table = Table::new(name.as_str(), form.ids.0);
    for (field, column) in form.fields.0 {
        table = match column {
            Column::Reference { to, ids } => table.reference(field, to, ids),
            column => {
                let values = column.values(read).map_err(|e| e.at(field.as_str()).at(name.as_str()))?;
                table.field(field, values)
            }
        };
    }
    Ok(table)
}

/// A field's column as written: values, a reference, or a slice of a file.
enum Column {
    Values(Values),
    Reference { to: String, ids: Ids },
    Slice { file: String, dtype: Dtype, offset: u64, count: u64 },
}

#[derive(Clone, Copy, Deserialize)]
enum Dtype {
    #[serde(rename = "f32le")]
    F32,
    #[serde(rename = "f64le")]
    F64,
    #[serde(rename = "i32le")]
    I32,
    #[serde(rename = "u32le")]
    U32,
    #[serde(rename = "u64le")]
    U64,
    #[serde(rename = "u8")]
    U8,
}

impl Dtype {
    fn width(self) -> u64 {
        match self {
            Dtype::U8 => 1,
            Dtype::F32 | Dtype::I32 | Dtype::U32 => 4,
            Dtype::F64 | Dtype::U64 => 8,
        }
    }
}

impl Column {
    /// The values, a slice read with `read`.
    fn values(self, read: &mut Reader<'_>) -> Result<Values> {
        let (file, dtype, offset, count) = match self {
            Column::Values(values) => return Ok(values),
            Column::Reference { .. } => unreachable!("references are fields of their own"),
            Column::Slice { file, dtype, offset, count } => (file, dtype, offset, count),
        };
        let length = count.checked_mul(dtype.width()).ok_or_else(|| Error::invalid("the slice is too long"))?;
        let end = offset.checked_add(length).ok_or_else(|| Error::invalid("the slice ends past every file"))?;
        let bytes = read(&file, offset..end)?;
        if bytes.len() as u64 != length {
            return Err(Error::invalid(format!("{file}: {} bytes read of the slice's {length}", bytes.len())));
        }
        macro_rules! decode {
            ($t:ty, $n:literal) => {
                bytes.as_chunks::<$n>().0.iter().map(|v| <$t>::from_le_bytes(*v)).collect::<Vec<$t>>().into()
            };
        }
        Ok(match dtype {
            Dtype::F32 => decode!(f32, 4),
            Dtype::F64 => decode!(f64, 8),
            Dtype::I32 => decode!(i32, 4),
            Dtype::U32 => decode!(u32, 4),
            Dtype::U64 => decode!(u64, 8),
            Dtype::U8 => bytes.iter().map(|&b| b != 0).collect::<Vec<bool>>().into(),
        })
    }
}

/// A table's fields in the order written.
#[derive(Default)]
struct Fields(Vec<(String, Column)>);

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Fields, D::Error> {
        struct Map;
        impl<'de> Visitor<'de> for Map {
            type Value = Fields;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an object of fields")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Fields, A::Error> {
                let mut fields = Vec::new();
                while let Some(name) = map.next_key::<String>()? {
                    if fields.iter().any(|(n, _)| *n == name) {
                        return Err(de::Error::custom(format!("field {name} is written twice")));
                    }
                    let column = map.next_value_seed(ColumnSeed(&name))?;
                    fields.push((name, column));
                }
                Ok(Fields(fields))
            }
        }
        deserializer.deserialize_map(Map)
    }
}

/// A column, named for its errors.
struct ColumnSeed<'a>(&'a str);

impl<'de> DeserializeSeed<'de> for ColumnSeed<'_> {
    type Value = Column;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> std::result::Result<Column, D::Error> {
        deserializer.deserialize_any(ColumnVisitor(self.0))
    }
}

struct ColumnVisitor<'a>(&'a str);

impl<'de> Visitor<'de> for ColumnVisitor<'_> {
    type Value = Column;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "field {}: an array of values, a reference, or a slice of a file", self.0)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Column, A::Error> {
        let mut column = Builder::default();
        while let Some(element) = seq.next_element::<Element>()? {
            column.push(element).map_err(|reason| de::Error::custom(format!("field {}: {reason}", self.0)))?;
        }
        Ok(Column::Values(column.finish()))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Column, A::Error> {
        let (mut reference, mut ids, mut file, mut dtype, mut offset, mut count) = (None, None, None, None, None, None);
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "reference" => reference = Some(map.next_value::<String>()?),
                "ids" => ids = Some(map.next_value::<IdsForm>()?.0),
                "file" => file = Some(map.next_value::<String>()?),
                "dtype" => dtype = Some(map.next_value::<Dtype>()?),
                "offset" => offset = Some(map.next_value::<u64>()?),
                "count" => count = Some(map.next_value::<u64>()?),
                other => {
                    map.next_value::<IgnoredAny>()?;
                    return Err(de::Error::custom(format!("field {}: unknown key {other}", self.0)));
                }
            }
        }
        let missing = |what: &str| de::Error::custom(format!("field {}: {what}", self.0));
        match (reference, file) {
            (Some(to), None) if dtype.is_none() && offset.is_none() && count.is_none() => {
                Ok(Column::Reference { to, ids: ids.ok_or_else(|| missing("a reference names its ids"))? })
            }
            (None, Some(file)) if ids.is_none() => Ok(Column::Slice {
                file,
                dtype: dtype.ok_or_else(|| missing("a slice names its dtype"))?,
                offset: offset.unwrap_or(0),
                count: count.ok_or_else(|| missing("a slice names its count"))?,
            }),
            _ => Err(missing("an object is {reference, ids} or {file, dtype, offset, count}")),
        }
    }
}

/// One value of an array column.
enum Element {
    Missing,
    Number(f64),
    Bool(bool),
    Text(String),
    Geometry(Geometry),
}

/// A geometry as written: a point, or a list of geometries one level shallower.
enum Geometry {
    Point([f64; 2]),
    List(Vec<Geometry>),
}

impl Geometry {
    /// How deep it nests below its points: 0 a point, 1 a path, 2 parts, 3 polygons. An empty list
    /// counts as a path.
    fn depth(&self) -> usize {
        match self {
            Geometry::Point(_) => 0,
            Geometry::List(items) => 1 + items.first().map_or(0, Geometry::depth),
        }
    }

    /// Whether it nests as deep as `depth`: an empty list nests as deep as any list.
    fn nests(&self, depth: usize) -> bool {
        matches!(self, Geometry::List(items) if items.is_empty() && depth > 0) || self.depth() == depth
    }

    fn point(self) -> [f64; 2] {
        match self {
            Geometry::Point(p) => p,
            Geometry::List(_) => [f64::NAN; 2],
        }
    }

    fn list<T>(self, item: impl Fn(Geometry) -> T) -> Vec<T> {
        match self {
            Geometry::Point(_) => Vec::new(),
            Geometry::List(items) => items.into_iter().map(item).collect(),
        }
    }
}

impl<'de> Deserialize<'de> for Element {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Element, D::Error> {
        struct One;
        impl<'de> Visitor<'de> for One {
            type Value = Element;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a number, boolean, text, [x, y] geometry, or null")
            }
            fn visit_unit<E>(self) -> std::result::Result<Element, E> {
                Ok(Element::Missing)
            }
            fn visit_none<E>(self) -> std::result::Result<Element, E> {
                Ok(Element::Missing)
            }
            fn visit_f64<E>(self, v: f64) -> std::result::Result<Element, E> {
                Ok(Element::Number(v))
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<Element, E> {
                Ok(Element::Number(v as f64))
            }
            fn visit_i64<E>(self, v: i64) -> std::result::Result<Element, E> {
                Ok(Element::Number(v as f64))
            }
            fn visit_bool<E>(self, v: bool) -> std::result::Result<Element, E> {
                Ok(Element::Bool(v))
            }
            fn visit_str<E>(self, v: &str) -> std::result::Result<Element, E> {
                Ok(Element::Text(v.to_owned()))
            }
            fn visit_string<E>(self, v: String) -> std::result::Result<Element, E> {
                Ok(Element::Text(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Element, A::Error> {
                GeometryVisitor.visit_seq(seq).map(Element::Geometry)
            }
        }
        deserializer.deserialize_any(One)
    }
}

struct GeometryVisitor;

impl<'de> Visitor<'de> for GeometryVisitor {
    type Value = Geometry;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an [x, y] point or a list of geometries")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Geometry, A::Error> {
        let Some(first) = seq.next_element::<Part>()? else { return Ok(Geometry::List(Vec::new())) };
        match first {
            Part::Number(x) => {
                let y: f64 = seq.next_element()?.ok_or_else(|| de::Error::custom("a point is [x, y]"))?;
                // A third coordinate, elevation in GeoJSON, is read past.
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Geometry::Point([x, y]))
            }
            Part::Geometry(first) => {
                let mut items = vec![first];
                while let Some(item) = seq.next_element_seed(GeometrySeed)? {
                    items.push(item);
                }
                Ok(Geometry::List(items))
            }
        }
    }
}

struct GeometrySeed;

impl<'de> DeserializeSeed<'de> for GeometrySeed {
    type Value = Geometry;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> std::result::Result<Geometry, D::Error> {
        deserializer.deserialize_seq(GeometryVisitor)
    }
}

/// The first item of a geometry's list: a coordinate, or a geometry.
enum Part {
    Number(f64),
    Geometry(Geometry),
}

impl<'de> Deserialize<'de> for Part {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Part, D::Error> {
        struct One;
        impl<'de> Visitor<'de> for One {
            type Value = Part;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a coordinate or a geometry")
            }
            fn visit_f64<E>(self, v: f64) -> std::result::Result<Part, E> {
                Ok(Part::Number(v))
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<Part, E> {
                Ok(Part::Number(v as f64))
            }
            fn visit_i64<E>(self, v: i64) -> std::result::Result<Part, E> {
                Ok(Part::Number(v as f64))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Part, A::Error> {
                GeometryVisitor.visit_seq(seq).map(Part::Geometry)
            }
        }
        deserializer.deserialize_any(One)
    }
}

/// An array column as it is read: what its first present value is decides what the rest are.
#[derive(Default)]
struct Builder {
    len: usize,
    kind: Option<Kind>,
}

enum Kind {
    Numbers(Vec<Option<f64>>),
    Bools(Vec<Option<bool>>),
    Texts(Vec<Option<String>>),
    Geometries(usize, Vec<Option<Geometry>>),
}

impl Builder {
    fn push(&mut self, element: Element) -> std::result::Result<(), &'static str> {
        let missing = self.len;
        self.len += 1;
        if matches!(element, Element::Missing) {
            match &mut self.kind {
                None => {}
                Some(Kind::Numbers(v)) => v.push(None),
                Some(Kind::Bools(v)) => v.push(None),
                Some(Kind::Texts(v)) => v.push(None),
                Some(Kind::Geometries(_, v)) => v.push(None),
            }
            return Ok(());
        }
        let kind = self.kind.get_or_insert_with(|| match &element {
            Element::Bool(_) => Kind::Bools(vec![None; missing]),
            Element::Text(_) => Kind::Texts(vec![None; missing]),
            Element::Geometry(g) => Kind::Geometries(g.depth(), (0..missing).map(|_| None).collect()),
            _ => Kind::Numbers(vec![None; missing]),
        });
        match (kind, element) {
            (Kind::Numbers(v), Element::Number(n)) => v.push(Some(n)),
            (Kind::Bools(v), Element::Bool(b)) => v.push(Some(b)),
            (Kind::Texts(v), Element::Text(t)) => v.push(Some(t)),
            (Kind::Geometries(depth, v), Element::Geometry(g)) => {
                if *depth > 3 {
                    return Err("geometries nest at most polygons of rings of [x, y] points");
                }
                if !g.nests(*depth) {
                    return Err("geometries of a column nest alike");
                }
                v.push(Some(g));
            }
            _ => return Err("a column holds numbers, booleans, texts, or geometries, not a mix"),
        }
        Ok(())
    }

    fn finish(self) -> Values {
        let path = |g: Option<Geometry>| g.map_or_else(Vec::new, |g| g.list(Geometry::point));
        match self.kind {
            None => vec![None::<f64>; self.len].into(),
            Some(Kind::Numbers(v)) => v.into(),
            Some(Kind::Bools(v)) => v.into(),
            Some(Kind::Texts(v)) => v.into(),
            Some(Kind::Geometries(depth, v)) => match depth {
                0 => v.into_iter().map(|g| g.map_or([f64::NAN; 2], Geometry::point)).collect::<Vec<_>>().into(),
                1 => v.into_iter().map(path).collect::<Vec<_>>().into(),
                2 => v
                    .into_iter()
                    .map(|g| g.map_or_else(Vec::new, |g| g.list(|p| path(Some(p)))))
                    .collect::<Vec<_>>()
                    .into(),
                _ => v
                    .into_iter()
                    .map(|g| g.map_or_else(Vec::new, |g| g.list(|parts| parts.list(|p| path(Some(p))))))
                    .collect::<Vec<_>>()
                    .into(),
            },
        }
    }
}

/// Ids as written: a count, or numbers or texts with `null` for none.
struct IdsForm(Ids);

impl<'de> Deserialize<'de> for IdsForm {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<IdsForm, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = IdsForm;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("ids: a row count, or numbers or texts")
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<IdsForm, E> {
                let count = u32::try_from(v).map_err(|_| E::custom("a row count is at most 2^32 - 1"))?;
                Ok(IdsForm(count.into()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<IdsForm, A::Error> {
                let mut keys = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(key) = seq.next_element::<Key>()? {
                    keys.push(key);
                }
                let texts = keys.iter().any(|k| matches!(k, Key::Text(_)));
                if texts && keys.iter().any(|k| matches!(k, Key::Number(_))) {
                    return Err(de::Error::custom("ids are all numbers or all texts"));
                }
                let ids = if texts {
                    let texts: Vec<Option<String>> =
                        keys.into_iter().map(|k| if let Key::Text(t) = k { Some(t) } else { None }).collect();
                    texts.into()
                } else {
                    let numbers: Vec<Option<u64>> =
                        keys.into_iter().map(|k| if let Key::Number(n) = k { Some(n) } else { None }).collect();
                    numbers.into()
                };
                Ok(IdsForm(ids))
            }
        }
        deserializer.deserialize_any(Any)
    }
}

/// One id as written.
enum Key {
    Missing,
    Number(u64),
    Text(String),
}

impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Key, D::Error> {
        struct One;
        impl Visitor<'_> for One {
            type Value = Key;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an id: a whole number, a text, or null")
            }
            fn visit_unit<E>(self) -> std::result::Result<Key, E> {
                Ok(Key::Missing)
            }
            fn visit_none<E>(self) -> std::result::Result<Key, E> {
                Ok(Key::Missing)
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<Key, E> {
                Ok(Key::Number(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Key, E> {
                u64::try_from(v).map(Key::Number).map_err(|_| E::custom("a numeric id is a whole number from 0"))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Key, E> {
                if v.fract() == 0.0 && (0.0..=SAFE).contains(&v) {
                    Ok(Key::Number(v as u64))
                } else {
                    Err(E::custom("a numeric id is a whole number from 0"))
                }
            }
            fn visit_str<E>(self, v: &str) -> std::result::Result<Key, E> {
                Ok(Key::Text(v.to_owned()))
            }
            fn visit_string<E>(self, v: String) -> std::result::Result<Key, E> {
                Ok(Key::Text(v))
            }
        }
        deserializer.deserialize_any(One)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Kind as FieldKind, Row, Value};

    fn none(file: &str, _: Range<u64>) -> Result<Vec<u8>> {
        Err(Error::Load(format!("no file {file}").into()))
    }

    #[test]
    fn a_dataset_reads_its_tables_references_and_geometry() {
        let json = r#"{"name": "grid", "patch": [
            {"put": {"table": "Bus", "ids": ["b", "a"], "fields": {
                "x": [1.5, null], "on": [true, false], "name": ["B", null],
                "at": [[0, 1], [2, 3, 9]], "path": [[[0, 0], [1, 1]], null]}}},
            {"put": {"table": "Branch", "ids": 1, "fields": {"from": {"reference": "Bus", "ids": ["a"]}}}}
        ]}"#;
        let data = Data::from_json(json, none).unwrap();
        let bus = data.table("Bus").unwrap();
        assert_eq!(bus.get("b", "x"), Some(Value::Number(1.5)));
        assert_eq!(bus.get("a", "x"), None);
        assert_eq!(bus.get("a", "on"), Some(Value::Bool(false)));
        assert_eq!(bus.get("b", "name"), Some(Value::Text("B".into())));
        assert_eq!(bus.get("a", "at"), Some(Value::Point([2.0, 3.0])));
        assert_eq!(bus.kind("path"), Some(FieldKind::Geometry(1)));
        assert_eq!(bus.get("b", "path"), Some(Value::Path(vec![[0.0, 0.0], [1.0, 1.0]])));
        let row = Row { data: "grid".into(), table: "Branch".into(), id: 0_u64.into() };
        let target = Row { data: "grid".into(), table: "Bus".into(), id: "a".into() };
        assert_eq!(data.get(&row, "from"), Some(Value::Row(target)));
    }

    #[test]
    fn slices_read_exactly_their_bytes_and_append_frames() {
        let floats: Vec<u8> = [9_f32, 1.0, 2.0, 3.0, 4.0].into_iter().flat_map(f32::to_le_bytes).collect();
        let mut asked = Vec::new();
        let mut read = |file: &str, range: Range<u64>| {
            asked.push((file.to_owned(), range.clone()));
            Ok(floats[range.start as usize..range.end as usize].to_vec())
        };
        let json = r#"[
            {"put": {"table": "Bus", "ids": 2, "fields": {"kv": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 2}}}},
            {"axis": {"name": "time", "unit": "s"}},
            {"append": {"at": [0, 1], "table": "Bus", "fields": {"vm": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 4}}}},
            {"forget": {"before": -1}}
        ]"#;
        let patch = Patch::from_json(json, &mut read).unwrap();
        assert_eq!(asked, [("v.f32".to_owned(), 4..12), ("v.f32".to_owned(), 4..20)]);
        let mut data = Data::new("grid");
        data.apply(patch).unwrap();
        assert_eq!(data.axis(), Some(("time", "s")));
        assert_eq!(data.span(), Some([0.0, 1.0]));
        let row = |id: u64| Row { data: "grid".into(), table: "Bus".into(), id: id.into() };
        assert_eq!(data.get(&row(1), "kv"), Some(Value::Number(2.0)));
        assert_eq!(data.get_at(&row(1), "vm", 0.0), Some(Value::Number(2.0)));
        assert_eq!(data.get_at(&row(1), "vm", 1.0), Some(Value::Number(4.0)));
    }

    #[test]
    fn errors_name_the_change_table_and_field() {
        let error = |json: &str| Patch::from_json(json, none).map(|_| ()).unwrap_err().to_string();
        assert!(error(r#"[{"put": {"table": "Bus", "ids": 2, "fields": {"x": [1, "a"]}}}]"#).contains("field x"));
        assert!(error(r#"[{"put": {"table": "Bus", "ids": [1, "a"]}}]"#).contains("all numbers or all texts"));
        assert!(error(r#"[{"bend": {}}]"#).contains("unknown variant"));
        assert!(
            error(r#"[{"put": {"table": "Bus", "ids": 1, "fields": {"x": {"file": "f", "count": 1}}}}]"#)
                .contains("dtype")
        );
        let missing = Patch::from_json(
            r#"[{"put": {"table": "Bus", "ids": 1, "fields": {"x": {"file": "f.bin", "dtype": "u8", "count": 1}}}}]"#,
            none,
        );
        assert!(missing.unwrap_err().to_string().contains("no file f.bin"));
        let short = Patch::from_json(
            r#"[{"put": {"table": "Bus", "ids": 1, "fields": {"x": {"file": "f", "dtype": "f64le", "count": 1}}}}]"#,
            |_, _| Ok(vec![0; 3]),
        );
        assert!(short.unwrap_err().to_string().contains("3 bytes read"));
        let invalid = Data::from_json(r#"{"name": "grid", "patch": [{"put": {"table": "Bus", "ids": [1, 1]}}]}"#, none);
        assert!(matches!(invalid, Err(Error::Invalid { path, .. }) if path.to_string().starts_with("patch[0]")));
    }
}
