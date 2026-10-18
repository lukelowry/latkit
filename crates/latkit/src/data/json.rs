//! Datasets and patches as JSON: the format is documented on [`Patch::load`].

use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;

use serde::Deserialize;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use super::data::Data;
use super::ids::Ids;
use super::name::Id;
use super::patch::{Op, Patch};
use super::table::Table;
use super::values::{Value, Values};
use crate::host::{Host, Request};
use crate::{Error, Pending, Result};

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
    /// - A field is an array of one kind of value, as [`Values`] takes them; `{"reference": table,
    ///   "ids": ids}`; or a slice of a binary file, `{"file", "dtype", "offset", "count"}`: `count`
    ///   values from byte `offset` (0 unless given) of dtype `f32le`, `f64le`, `i32le`, `u32le`,
    ///   `u64le`, or `u8` (booleans, nonzero true).
    /// - `append`'s `at` is one axis coordinate or several, as [`Patch::append`] takes them.
    ///
    /// Slices are fetched through `host`, all at once: a file's path or URL relative to `base`, the
    /// document's own, or as it is when `base` is empty or the file's is absolute.
    ///
    /// ```no_run
    /// # async fn example(host: &dyn latkit::host::Host) -> latkit::Result<()> {
    /// let json = r#"[{"append": {"at": 0.5, "table": "Bus", "fields": {"vm": {"file": "vm.f32", "dtype": "f32le", "count": 3}}}}]"#;
    /// let patch = latkit::Patch::load(json, "data/grid.json", host).await?; // reads data/vm.f32
    /// # Ok(()) }
    /// ```
    pub async fn load(json: &str, base: &str, host: &dyn Host) -> Result<Patch> {
        let ops: Vec<OpForm> = serde_json::from_str(json).map_err(|e| Error::invalid(e.to_string()))?;
        build(ops, base, host).await
    }
}

impl Data {
    /// A dataset from its JSON, `{"name": ..., "patch": [...]}`: its name and the patch that builds it,
    /// as its bytes are. The patch loads as [`Patch::load`] loads one.
    pub async fn load(json: &str, base: &str, host: &dyn Host) -> Result<Data> {
        let form: DataForm = serde_json::from_str(json).map_err(|e| Error::invalid(e.to_string()))?;
        if form.name.is_empty() {
            return Err(Error::invalid("a dataset is named").at("name"));
        }
        let patch = build(form.patch, base, host).await.map_err(|e| e.at("patch"))?;
        let mut data = Data::new(form.name);
        data.apply(patch)?;
        Ok(data)
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

/// The patch `ops` make: their slices fetched through `host` at once, relative to `base`, then each
/// change built in order.
async fn build(ops: Vec<OpForm>, base: &str, host: &dyn Host) -> Result<Patch> {
    let mut fetching = VecDeque::new();
    for op in &ops {
        let (OpForm::Put(TableForm { fields, .. })
        | OpForm::Set(TableForm { fields, .. })
        | OpForm::Append { fields, .. }) = op
        else {
            continue;
        };
        for (_, column) in &fields.0 {
            if let Column::Slice(slice) = column {
                let url = resolve(base, &slice.file);
                fetching.push_back(host.fetch(&Request::range(url, slice.offset..slice.end()?)));
            }
        }
    }
    let mut patch = Patch::new();
    for (i, op) in ops.into_iter().enumerate() {
        let op = match op {
            OpForm::Axis { name, unit } => Op::Axis { name: name.into(), unit: unit.into() },
            OpForm::Put(form) => Op::Put(table(form, &mut fetching).await.map_err(|e| e.at(i))?),
            OpForm::Set(form) => Op::Set(table(form, &mut fetching).await.map_err(|e| e.at(i))?),
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
                        column => column.values(&mut fetching).await,
                    };
                    columns.push((
                        name.as_str().into(),
                        values.map_err(|e| e.at(name.as_str()).at(table.as_str()).at(i))?,
                    ));
                }
                Op::Append { table: table.into(), at, fields: columns }
            }
            OpForm::Forget { before } => Op::Forget { before },
        };
        patch.ops.push(op);
    }
    Ok(patch)
}

/// The table `form` writes, its slices taken in order from `fetching`.
async fn table(form: TableForm, fetching: &mut VecDeque<Pending<Vec<u8>>>) -> Result<Table> {
    let name = form.table;
    let mut table = Table::new(name.as_str(), form.ids.0);
    for (field, column) in form.fields.0 {
        table = match column {
            Column::Reference { to, ids } => table.reference(field, to, ids),
            column => {
                let values = column.values(fetching).await.map_err(|e| e.at(field.as_str()).at(name.as_str()))?;
                table.field(field, values)
            }
        };
    }
    Ok(table)
}

/// `file` relative to `base`, a document's path or URL: in its directory unless absolute.
fn resolve(base: &str, file: &str) -> String {
    let absolute = file.contains("://") || file.starts_with(['/', '\\']) || file.as_bytes().get(1) == Some(&b':');
    match base.rfind(['/', '\\']) {
        Some(at) if !absolute => format!("{}{file}", &base[..=at]),
        _ => file.to_owned(),
    }
}

/// A field's column as written: values, a reference, or a slice of a file.
enum Column {
    Values(Values),
    Reference { to: String, ids: Ids },
    Slice(Slice),
}

/// `count` values of `dtype` from byte `offset` of `file`.
struct Slice {
    file: String,
    dtype: Dtype,
    offset: u64,
    count: u64,
}

impl Slice {
    /// The byte after the slice.
    fn end(&self) -> Result<u64> {
        let length =
            self.count.checked_mul(self.dtype.width()).ok_or_else(|| Error::invalid("the slice is too long"))?;
        self.offset.checked_add(length).ok_or_else(|| Error::invalid("the slice ends past every file"))
    }
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
    /// The values: a slice's once its fetch, the next in `fetching`, lands.
    async fn values(self, fetching: &mut VecDeque<Pending<Vec<u8>>>) -> Result<Values> {
        let slice = match self {
            Column::Values(values) => return Ok(values),
            Column::Reference { .. } => unreachable!("references are fields of their own"),
            Column::Slice(slice) => slice,
        };
        let length = slice.end()? - slice.offset;
        let bytes = fetching.pop_front().expect("a fetch for every slice").await?;
        if bytes.len() as u64 != length {
            let file = &slice.file;
            return Err(Error::Load(format!("{file}: {} bytes of the slice's {length}", bytes.len()).into()));
        }
        macro_rules! decode {
            ($t:ty, $n:literal) => {
                bytes.as_chunks::<$n>().0.iter().map(|v| <$t>::from_le_bytes(*v)).collect::<Vec<$t>>().into()
            };
        }
        Ok(match slice.dtype {
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
        let mut values = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(Element(value)) = seq.next_element()? {
            values.push(value);
        }
        Values::try_from(values).map(Column::Values).map_err(|e| {
            let reason = if let Error::Invalid { reason, .. } = e { reason } else { e.to_string().into() };
            de::Error::custom(format!("field {}: {reason}", self.0))
        })
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
            (None, Some(file)) if ids.is_none() => Ok(Column::Slice(Slice {
                file,
                dtype: dtype.ok_or_else(|| missing("a slice names its dtype"))?,
                offset: offset.unwrap_or(0),
                count: count.ok_or_else(|| missing("a slice names its count"))?,
            })),
            _ => Err(missing("an object is {reference, ids} or {file, dtype, offset, count}")),
        }
    }
}

/// One value of an array column: a number, boolean, text, or `[x, y]` geometry; `null`, or an empty
/// geometry, missing.
struct Element(Option<Value>);

impl<'de> Deserialize<'de> for Element {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Element, D::Error> {
        struct One;
        impl<'de> Visitor<'de> for One {
            type Value = Element;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a number, boolean, text, [x, y] geometry, or null")
            }
            fn visit_unit<E>(self) -> std::result::Result<Element, E> {
                Ok(Element(None))
            }
            fn visit_none<E>(self) -> std::result::Result<Element, E> {
                Ok(Element(None))
            }
            fn visit_f64<E>(self, v: f64) -> std::result::Result<Element, E> {
                Ok(Element(Some(Value::Number(v))))
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<Element, E> {
                Ok(Element(Some(Value::Number(v as f64))))
            }
            fn visit_i64<E>(self, v: i64) -> std::result::Result<Element, E> {
                Ok(Element(Some(Value::Number(v as f64))))
            }
            fn visit_bool<E>(self, v: bool) -> std::result::Result<Element, E> {
                Ok(Element(Some(Value::Bool(v))))
            }
            fn visit_str<E>(self, v: &str) -> std::result::Result<Element, E> {
                Ok(Element(Some(Value::Text(Arc::from(v)))))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> std::result::Result<Element, A::Error> {
                GeometryVisitor.visit_seq(seq)?.value().map(Element).map_err(de::Error::custom)
            }
        }
        deserializer.deserialize_any(One)
    }
}

/// A geometry as written: a point, or a list of geometries one level shallower.
enum Geometry {
    Point([f64; 2]),
    List(Vec<Geometry>),
}

impl Geometry {
    /// How deep it nests below its points: 0 a point, 1 a path, 2 parts, 3 polygons.
    fn depth(&self) -> usize {
        match self {
            Geometry::Point(_) => 0,
            Geometry::List(items) => 1 + items.first().map_or(0, Geometry::depth),
        }
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

    /// The value it writes: `None` when it is empty.
    fn value(self) -> std::result::Result<Option<Value>, &'static str> {
        if matches!(&self, Geometry::List(items) if items.is_empty()) {
            return Ok(None);
        }
        Ok(Some(match self.depth() {
            0 => Value::Point(self.point()),
            1 => Value::Path(self.list(Geometry::point)),
            2 => Value::Parts(self.list(|path| path.list(Geometry::point))),
            3 => Value::Polygons(self.list(|parts| parts.list(|path| path.list(Geometry::point)))),
            _ => return Err("geometries nest at most polygons of rings of [x, y] points"),
        }))
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

/// Ids as written: a count, or numbers or texts with `null` for none, as [`Ids`] takes them.
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
                let mut ids = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(Key(id)) = seq.next_element()? {
                    ids.push(id);
                }
                Ok(IdsForm(Ids::from(ids)))
            }
        }
        deserializer.deserialize_any(Any)
    }
}

/// One id as written.
struct Key(Option<Id>);

impl<'de> Deserialize<'de> for Key {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Key, D::Error> {
        struct One;
        impl Visitor<'_> for One {
            type Value = Key;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an id: a whole number, a text, or null")
            }
            fn visit_unit<E>(self) -> std::result::Result<Key, E> {
                Ok(Key(None))
            }
            fn visit_none<E>(self) -> std::result::Result<Key, E> {
                Ok(Key(None))
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<Key, E> {
                Ok(Key(Some(Id::Number(v))))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Key, E> {
                let n = u64::try_from(v).map_err(|_| E::custom("a numeric id is a whole number from 0"))?;
                Ok(Key(Some(Id::Number(n))))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Key, E> {
                if v.fract() == 0.0 && (0.0..=SAFE).contains(&v) {
                    Ok(Key(Some(Id::Number(v as u64))))
                } else {
                    Err(E::custom("a numeric id is a whole number from 0"))
                }
            }
            fn visit_str<E>(self, v: &str) -> std::result::Result<Key, E> {
                Ok(Key(Some(Id::from(v))))
            }
        }
        deserializer.deserialize_any(One)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::host::{Raster, TextRun};
    use crate::{Kind, Row};

    /// A host fetching from files in memory, and counting what it fetched.
    #[derive(Default)]
    struct Files(HashMap<String, Vec<u8>>, std::sync::Mutex<Vec<Request>>);

    impl Host for Files {
        fn rasterize(&self, _: &TextRun) -> Result<Raster> {
            Err(Error::Unsupported("no text".into()))
        }

        fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
            self.1.lock().unwrap().push(request.clone());
            let bytes = self.0.get(&*request.url).map_or_else(Vec::new, |bytes| {
                let range = request.range.clone().unwrap_or(0..bytes.len() as u64);
                bytes[range.start as usize..(range.end as usize).min(bytes.len())].to_vec()
            });
            Pending::ready(Ok(bytes))
        }
    }

    fn load_data(json: &str, host: &Files) -> Result<Data> {
        pollster::block_on(Data::load(json, "docs/grid.json", host))
    }

    #[test]
    fn a_dataset_reads_its_tables_references_and_geometry() {
        let json = r#"{"name": "grid", "patch": [
            {"put": {"table": "Bus", "ids": ["b", "a"], "fields": {
                "x": [1.5, null], "on": [true, false], "name": ["B", null],
                "at": [[0, 1], [2, 3, 9]], "path": [[[0, 0], [1, 1]], []]}}},
            {"put": {"table": "Branch", "ids": 1, "fields": {"from": {"reference": "Bus", "ids": ["a"]}}}}
        ]}"#;
        let data = load_data(json, &Files::default()).unwrap();
        let bus = data.table("Bus").unwrap();
        assert_eq!(bus.get("b", "x"), Some(Value::Number(1.5)));
        assert_eq!(bus.get("a", "x"), None);
        assert_eq!(bus.get("a", "on"), Some(Value::Bool(false)));
        assert_eq!(bus.get("b", "name"), Some(Value::Text("B".into())));
        assert_eq!(bus.get("a", "at"), Some(Value::Point([2.0, 3.0])));
        assert_eq!(bus.kind("path"), Some(Kind::Geometry(1)));
        assert_eq!(bus.get("b", "path"), Some(Value::Path(vec![[0.0, 0.0], [1.0, 1.0]])));
        let row = Row { data: "grid".into(), table: "Branch".into(), id: 0_u64.into() };
        let target = Row { data: "grid".into(), table: "Bus".into(), id: "a".into() };
        assert_eq!(data.get(&row, "from"), Some(Value::Row(target)));
    }

    #[test]
    fn slices_fetch_at_once_relative_to_the_document_and_append_frames() {
        let floats: Vec<u8> = [9_f32, 1.0, 2.0, 3.0, 4.0].into_iter().flat_map(f32::to_le_bytes).collect();
        let host = Files([("docs/v.f32".to_owned(), floats)].into(), std::sync::Mutex::default());
        let json = r#"{"name": "grid", "patch": [
            {"put": {"table": "Bus", "ids": 2, "fields": {"kv": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 2}}}},
            {"axis": {"name": "time", "unit": "s"}},
            {"append": {"at": [0, 1], "table": "Bus", "fields": {"vm": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 4}}}},
            {"forget": {"before": -1}}
        ]}"#;
        let data = load_data(json, &host).unwrap();
        let asked: Vec<Request> = host.1.lock().unwrap().clone();
        assert_eq!(asked, [Request::range("docs/v.f32", 4..12), Request::range("docs/v.f32", 4..20)]);
        assert_eq!(data.span(), Some([0.0, 1.0]));
        let row = |id: u64| Row { data: "grid".into(), table: "Bus".into(), id: id.into() };
        assert_eq!(data.get(&row(1), "kv"), Some(Value::Number(2.0)));
        assert_eq!(data.get_at(&row(1), "vm", 1.0), Some(Value::Number(4.0)));
        assert_eq!(resolve("https://x/data/grid.json", "v.f32"), "https://x/data/v.f32");
        assert_eq!(resolve("C:\\data\\grid.json", "D:\\v.f32"), "D:\\v.f32");
        assert_eq!(resolve("", "v.f32"), "v.f32");
    }

    #[test]
    fn errors_name_the_change_table_and_field() {
        let error = |json: &str| {
            pollster::block_on(Patch::load(json, "", &Files::default())).map(|_| ()).unwrap_err().to_string()
        };
        assert!(error(r#"[{"put": {"table": "Bus", "ids": 2, "fields": {"x": [1, "a"]}}}]"#).contains("field x"));
        assert!(error(r#"[{"bend": {}}]"#).contains("unknown variant"));
        assert!(
            error(r#"[{"put": {"table": "Bus", "ids": 1, "fields": {"x": {"file": "f", "count": 1}}}}]"#)
                .contains("dtype")
        );
        let missing = r#"[{"put": {"table": "Bus", "ids": 1, "fields": {"x": {"file": "f.bin", "dtype": "f64le", "count": 1}}}}]"#;
        assert_eq!(error(missing), "load: f.bin: 0 bytes of the slice's 8");
        let invalid =
            load_data(r#"{"name": "grid", "patch": [{"put": {"table": "Bus", "ids": [1, 1]}}]}"#, &Files::default());
        assert!(matches!(invalid, Err(Error::Invalid { path, .. }) if path.to_string().starts_with("patch[0]")));
    }
}
