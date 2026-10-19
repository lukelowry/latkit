//! What JSON and JavaScript write for data, decoded once: a patch's changes, a table's fields,
//! values, and ids. A slice of a file is the one form read later, by [`Patch::load`] through a host;
//! everything else is decoded as it is read.

use std::fmt;
use std::sync::Arc;

use std::borrow::Cow;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde::de::{self, DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

use super::ids::Ids;
use super::name::Id;
use super::patch::{Op, Patch};
use super::table::Table;
use super::values::{Value, Values};
use crate::{Error, Result};

/// The largest whole number a number names an id by when written with a fraction: 2^53 − 1.
const SAFE: f64 = 9_007_199_254_740_991.0;

const NUMERIC_ID: &str = "a numeric id is a whole number from 0 to 2^53 - 1";

/// A dataset: its name and the patch that builds it.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct DataForm {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) patch: Vec<OpForm>,
}

/// One change of a patch, named by the method that makes it.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
#[schemars(rename = "Change")]
pub(crate) enum OpForm {
    /// Names the axis sampled fields are recorded over, such as `time` in `s`.
    Axis { name: String, unit: String },
    /// Replaces a table with these rows and fields, or adds it.
    Put(TableForm),
    /// Writes fields for these rows: rows with known ids change, others are added, and fields left
    /// out keep their values.
    Set(TableForm),
    /// Removes the rows with these ids.
    Remove { table: String, ids: IdsForm },
    /// Records a frame at each axis coordinate of `at`: for each field, a value per row at every
    /// coordinate, frame-major.
    Append { at: At, table: String, fields: Fields },
    /// Forgets every sampled field's frames before axis coordinate `before`.
    Forget { before: f64 },
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(inline)]
pub(crate) struct TableForm {
    table: String,
    ids: IdsForm,
    #[serde(default)]
    fields: Fields,
}

/// One axis coordinate, or several.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(inline)]
pub(crate) enum At {
    One(f64),
    Many(Vec<f64>),
}

/// A dataset's JSON document.
impl JsonSchema for super::data::Data {
    fn schema_name() -> Cow<'static, str> {
        "Data".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        DataForm::json_schema(generator)
    }
}

/// A patch's JSON: its changes in order.
impl JsonSchema for Patch {
    fn schema_name() -> Cow<'static, str> {
        "Patch".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        <Vec<OpForm>>::json_schema(generator)
    }
}

impl JsonSchema for Ids {
    fn schema_name() -> Cow<'static, str> {
        "Ids".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        IdsForm::json_schema(generator)
    }
}

impl JsonSchema for IdsForm {
    fn schema_name() -> Cow<'static, str> {
        "Ids".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let id = generator.subschema_for::<Option<Id>>();
        let bytes = Bytes::json_schema(generator);
        let dtype = generator.subschema_for::<Dtype>();
        json_schema!({
            "description": "Row ids: a count naming rows 0..n, numbers or texts (null leaves a reference unwired), or a typed array's bytes.",
            "anyOf": [
                { "type": "integer", "minimum": 0, "maximum": u32::MAX },
                { "type": "array", "items": id },
                { "type": "object", "properties": { "dtype": dtype, "bytes": bytes }, "required": ["dtype", "bytes"], "additionalProperties": false },
            ],
        })
    }
}

impl JsonSchema for Fields {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "Fields".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let column = Column::json_schema(generator);
        json_schema!({ "description": "Fields by name, in the order written.", "type": "object", "additionalProperties": column })
    }
}

impl JsonSchema for Column {
    fn schema_name() -> Cow<'static, str> {
        "Column".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let element = generator.subschema_for::<Element>();
        let ids = generator.subschema_for::<IdsForm>();
        let dtype = generator.subschema_for::<Dtype>();
        let bytes = Bytes::json_schema(generator);
        json_schema!({
            "description": "A field's values: an array of one kind of value; a reference naming another table's rows by id; a slice of a binary file beside the document; or a typed array's bytes.",
            "anyOf": [
                { "type": "array", "items": element },
                { "type": "object", "properties": { "reference": { "type": "string" }, "ids": ids }, "required": ["reference", "ids"], "additionalProperties": false },
                {
                    "type": "object",
                    "properties": { "file": { "type": "string" }, "dtype": dtype, "offset": { "type": "integer", "minimum": 0 }, "count": { "type": "integer", "minimum": 0 } },
                    "required": ["file", "dtype", "count"],
                    "additionalProperties": false,
                },
                { "type": "object", "properties": { "dtype": dtype, "bytes": bytes }, "required": ["dtype", "bytes"], "additionalProperties": false },
            ],
        })
    }
}

impl JsonSchema for Element {
    fn schema_name() -> Cow<'static, str> {
        "Value".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let geometry = generator.subschema_for::<Geometry>();
        json_schema!({
            "description": "One value: a number, boolean, text, or geometry; null, or an empty geometry, is missing.",
            "anyOf": [{ "type": "number" }, { "type": "boolean" }, { "type": "string" }, { "type": "null" }, geometry],
        })
    }
}

impl JsonSchema for Geometry {
    fn schema_name() -> Cow<'static, str> {
        "Geometry".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let geometry = generator.subschema_for::<Geometry>();
        json_schema!({
            "description": "A point `[x, y]` (a third coordinate is read past), or a list of geometries one level shallower: a path, its parts, or polygons.",
            "anyOf": [
                { "type": "array", "prefixItems": [{ "type": "number" }, { "type": "number" }], "items": { "type": "number" }, "minItems": 2, "maxItems": 3 },
                { "type": "array", "items": geometry },
            ],
        })
    }
}

impl JsonSchema for Bytes {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "Bytes".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "Little-endian bytes: a Uint8Array from JavaScript, an array of numbers in JSON.",
            "type": "array",
            "items": { "type": "integer", "minimum": 0, "maximum": 255 },
        })
    }
}

/// A patch deserializes from its JSON, as JavaScript writes it too: every change but a slice of a
/// file, which [`Patch::load`] reads.
impl<'de> Deserialize<'de> for Patch {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Patch, D::Error> {
        patch(Vec::<OpForm>::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// Ids deserialize from a count, a list of numbers and texts, or `{dtype, bytes}` of numbers.
impl<'de> Deserialize<'de> for Ids {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Ids, D::Error> {
        IdsForm::deserialize(deserializer).map(|form| form.0)
    }
}

/// An id is a whole number from 0, or a text.
impl schemars::JsonSchema for Id {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Id".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "A row's id: a whole number from 0, or a text. A number above 2^53 - 1 is written as its decimal text, which names the same row.",
            "anyOf": [{ "type": "integer", "minimum": 0 }, { "type": "string" }],
        })
    }
}

/// An id deserializes from a whole number from 0 to 2^53 − 1, or a text.
impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Id, D::Error> {
        Key::deserialize(deserializer)?.0.ok_or_else(|| de::Error::custom("an id is a whole number or a text"))
    }
}

impl OpForm {
    /// The columns its fields are written as.
    pub(crate) fn columns(&mut self) -> &mut [(String, Column)] {
        match self {
            OpForm::Put(TableForm { fields, .. })
            | OpForm::Set(TableForm { fields, .. })
            | OpForm::Append { fields, .. } => &mut fields.0,
            _ => &mut [],
        }
    }
}

/// The patch `ops` make, every slice of a file read already.
pub(crate) fn patch(ops: Vec<OpForm>) -> Result<Patch> {
    let mut patch = Patch::new();
    for (i, op) in ops.into_iter().enumerate() {
        let op = match op {
            OpForm::Axis { name, unit } => Op::Axis { name: name.into(), unit: unit.into() },
            OpForm::Put(form) => Op::Put(form.table().map_err(|e| e.at(i))?),
            OpForm::Set(form) => Op::Set(form.table().map_err(|e| e.at(i))?),
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
                        column => column.values(),
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

impl TableForm {
    fn table(self) -> Result<Table> {
        let name = self.table;
        let mut table = Table::new(name.as_str(), self.ids.0);
        for (field, column) in self.fields.0 {
            table = match column {
                Column::Reference { to, ids } => table.reference(field, to, ids),
                column => {
                    let values = column.values().map_err(|e| e.at(field.as_str()).at(name.as_str()))?;
                    table.field(field, values)
                }
            };
        }
        Ok(table)
    }
}

/// A field's column as written: values, a reference, or a slice of a file.
pub(crate) enum Column {
    Values(Values),
    Reference { to: String, ids: Ids },
    Slice(Slice),
}

/// `count` values of `dtype` from byte `offset` of `file`.
pub(crate) struct Slice {
    pub(crate) file: String,
    dtype: Dtype,
    pub(crate) offset: u64,
    count: u64,
}

impl Slice {
    /// The byte after the slice.
    pub(crate) fn end(&self) -> Result<u64> {
        let length =
            self.count.checked_mul(self.dtype.width()).ok_or_else(|| Error::invalid("the slice is too long"))?;
        self.offset.checked_add(length).ok_or_else(|| Error::invalid("the slice ends past every file"))
    }

    /// The values its fetched `bytes` hold.
    pub(crate) fn read(&self, bytes: &[u8]) -> Result<Values> {
        let length = self.end()? - self.offset;
        if bytes.len() as u64 != length {
            let file = &self.file;
            return Err(Error::Load(format!("{file}: {} bytes of the slice's {length}", bytes.len()).into()));
        }
        Ok(self.dtype.decode(bytes))
    }
}

/// How a slice's or a typed array's bytes hold values: little endian; `u8` holds booleans, nonzero
/// true.
#[derive(Clone, Copy, Deserialize, JsonSchema)]
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

    /// The values little-endian `bytes` hold, whole values only; `u8` holds booleans, nonzero true.
    fn decode(self, bytes: &[u8]) -> Values {
        macro_rules! decode {
            ($t:ty, $n:literal) => {
                bytes.as_chunks::<$n>().0.iter().map(|v| <$t>::from_le_bytes(*v)).collect::<Vec<$t>>().into()
            };
        }
        match self {
            Dtype::F32 => decode!(f32, 4),
            Dtype::F64 => decode!(f64, 8),
            Dtype::I32 => decode!(i32, 4),
            Dtype::U32 => decode!(u32, 4),
            Dtype::U64 => decode!(u64, 8),
            Dtype::U8 => bytes.iter().map(|&b| b != 0).collect::<Vec<bool>>().into(),
        }
    }

    /// The ids little-endian `bytes` hold: whole numbers from 0.
    fn ids(self, bytes: &[u8]) -> std::result::Result<Ids, &'static str> {
        let values = self.decode(bytes);
        Ok(match self {
            Dtype::U32 => Ids::from(values.u32s().expect("u32 storage").to_vec()),
            Dtype::U64 => Ids::from(values.u64s().expect("u64 storage").to_vec()),
            Dtype::U8 => return Err("ids are numbers, not booleans"),
            Dtype::F32 | Dtype::F64 | Dtype::I32 => {
                let whole = |n: f64| (n.fract() == 0.0 && (0.0..=SAFE).contains(&n)).then_some(n as u64);
                let numbers = values.numbers().expect("numbers");
                Ids::from(numbers.into_iter().map(whole).collect::<Option<Vec<u64>>>().ok_or(NUMERIC_ID)?)
            }
        })
    }
}

impl Column {
    /// The values, read already: a slice of a file is read by [`Patch::load`].
    fn values(self) -> Result<Values> {
        match self {
            Column::Values(values) => Ok(values),
            Column::Reference { .. } => unreachable!("references are fields of their own"),
            Column::Slice(slice) => {
                Err(Error::invalid(format!("{}: a slice of a file is read by Patch::load", slice.file)))
            }
        }
    }
}

/// A table's fields in the order written.
#[derive(Default)]
pub(crate) struct Fields(pub(crate) Vec<(String, Column)>);

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

    fn visit_bytes<E: de::Error>(self, v: &[u8]) -> std::result::Result<Column, E> {
        Ok(Column::Values(Dtype::U8.decode(v)))
    }

    fn visit_byte_buf<E: de::Error>(self, v: Vec<u8>) -> std::result::Result<Column, E> {
        self.visit_bytes(&v)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Column, A::Error> {
        let (mut reference, mut ids, mut file, mut dtype, mut offset, mut count, mut bytes) =
            (None, None, None, None, None, None, None);
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                "reference" => reference = Some(map.next_value::<String>()?),
                "ids" => ids = Some(map.next_value::<IdsForm>()?.0),
                "file" => file = Some(map.next_value::<String>()?),
                "dtype" => dtype = Some(map.next_value::<Dtype>()?),
                "offset" => offset = Some(map.next_value::<u64>()?),
                "count" => count = Some(map.next_value::<u64>()?),
                "bytes" => bytes = Some(map.next_value::<Bytes>()?.0),
                other => {
                    map.next_value::<IgnoredAny>()?;
                    return Err(de::Error::custom(format!("field {}: unknown key {other}", self.0)));
                }
            }
        }
        let missing = |what: &str| de::Error::custom(format!("field {}: {what}", self.0));
        match (reference, file, bytes) {
            (Some(to), None, None) if dtype.is_none() && offset.is_none() && count.is_none() => {
                Ok(Column::Reference { to, ids: ids.ok_or_else(|| missing("a reference names its ids"))? })
            }
            (None, Some(file), None) if ids.is_none() => Ok(Column::Slice(Slice {
                file,
                dtype: dtype.ok_or_else(|| missing("a slice names its dtype"))?,
                offset: offset.unwrap_or(0),
                count: count.ok_or_else(|| missing("a slice names its count"))?,
            })),
            (None, None, Some(bytes)) if ids.is_none() && offset.is_none() && count.is_none() => {
                let dtype = dtype.ok_or_else(|| missing("bytes name their dtype"))?;
                if !(bytes.len() as u64).is_multiple_of(dtype.width()) {
                    return Err(missing("bytes hold whole values"));
                }
                Ok(Column::Values(dtype.decode(&bytes)))
            }
            _ => Err(missing("an object is {reference, ids}, {file, dtype, offset, count}, or {dtype, bytes}")),
        }
    }
}

/// Bytes as given: a JavaScript `Uint8Array`, or in JSON an array of numbers.
struct Bytes(Vec<u8>);

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Bytes, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = Bytes;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("bytes")
            }
            fn visit_bytes<E>(self, v: &[u8]) -> std::result::Result<Bytes, E> {
                Ok(Bytes(v.to_vec()))
            }
            fn visit_byte_buf<E>(self, v: Vec<u8>) -> std::result::Result<Bytes, E> {
                Ok(Bytes(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Bytes, A::Error> {
                let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(b) = seq.next_element::<u8>()? {
                    bytes.push(b);
                }
                Ok(Bytes(bytes))
            }
        }
        deserializer.deserialize_byte_buf(Any)
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

/// Ids as written: a count, or numbers or texts with `null` for none, as [`Ids`] takes them, or
/// `{dtype, bytes}` of numbers.
pub(crate) struct IdsForm(pub(crate) Ids);

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
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<IdsForm, E> {
                self.visit_u64(u64::try_from(v).map_err(|_| E::custom("a row count is a whole number from 0"))?)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<IdsForm, A::Error> {
                let (mut dtype, mut bytes) = (None, None);
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "dtype" => dtype = Some(map.next_value::<Dtype>()?),
                        "bytes" => bytes = Some(map.next_value::<Bytes>()?.0),
                        other => return Err(de::Error::custom(format!("ids: unknown key {other}"))),
                    }
                }
                let (Some(dtype), Some(bytes)) = (dtype, bytes) else {
                    return Err(de::Error::custom("ids as bytes are {dtype, bytes}"));
                };
                if !(bytes.len() as u64).is_multiple_of(dtype.width()) {
                    return Err(de::Error::custom("bytes hold whole values"));
                }
                dtype.ids(&bytes).map(IdsForm).map_err(de::Error::custom)
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
                let n = u64::try_from(v).map_err(|_| E::custom(NUMERIC_ID))?;
                Ok(Key(Some(Id::Number(n))))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Key, E> {
                if v.fract() == 0.0 && (0.0..=SAFE).contains(&v) {
                    Ok(Key(Some(Id::Number(v as u64))))
                } else {
                    Err(E::custom(NUMERIC_ID))
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
    use crate::{Data, Id, Ids, Patch, Value};

    fn le<T: bytemuck::Pod>(values: &[T]) -> Vec<u8> {
        bytemuck::cast_slice(values).to_vec()
    }

    #[test]
    fn patches_decode_as_written_bytes_and_all() {
        let ops = serde_json::json!([
            {"put": {"table": "Bus", "ids": {"dtype": "u32le", "bytes": le(&[7_u32, 9])}, "fields": {
                "kv": {"dtype": "f64le", "bytes": le(&[1.5_f64, 2.5])},
                "on": {"dtype": "u8", "bytes": [1, 0]},
                "name": ["a", null],
            }}},
            {"remove": {"table": "Bus", "ids": {"dtype": "f64le", "bytes": le(&[9.0_f64])}}},
        ]);
        let patch: Patch = serde_json::from_value(ops).expect("a patch");
        let mut data = Data::new("grid");
        data.apply(patch).expect("valid");
        let bus = data.table("Bus").expect("Bus");
        assert_eq!(bus.ids().collect::<Vec<_>>(), [Id::Number(7)]);
        assert_eq!(bus.get(7_u64, "kv"), Some(Value::Number(1.5)));
        assert_eq!(bus.get(7_u64, "on"), Some(Value::Bool(true)));
        assert_eq!(bus.get(7_u64, "name"), Some(Value::Text("a".into())));
    }

    #[test]
    fn forms_refuse_what_they_cannot_read_now() {
        let slice = serde_json::json!([{"put": {"table": "Bus", "ids": 1, "fields": {
            "kv": {"file": "kv.f64", "dtype": "f64le", "count": 1}}}}]);
        let error = serde_json::from_value::<Patch>(slice).expect_err("a slice needs Patch::load").to_string();
        assert!(error.contains("Patch::load"), "{error}");
        let ragged = serde_json::json!({"dtype": "f64le", "bytes": [0, 0, 0]});
        assert!(serde_json::from_value::<Ids>(ragged).is_err(), "bytes hold whole values");
        let fraction = serde_json::json!({"dtype": "f64le", "bytes": le(&[1.5_f64])});
        assert!(serde_json::from_value::<Ids>(fraction).is_err(), "ids are whole");
        assert_eq!(serde_json::from_value::<Id>(serde_json::json!(3)).expect("an id"), Id::Number(3));
        assert!(serde_json::from_value::<Id>(serde_json::json!(1.5)).is_err());
        assert!(serde_json::from_value::<Id>(serde_json::json!(null)).is_err());
    }
}
