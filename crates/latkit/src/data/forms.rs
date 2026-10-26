//! Serde forms for data written as JSON: a patch's changes, a table's fields, values, and ids.
//! Everything decodes in one pass except a slice of a binary file, which [`Patch::read`] fetches
//! through a host afterwards. JavaScript sends the binary frames instead of JSON.

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

/// The largest float accepted as a numeric id, 2^53 − 1. Larger floats may already be rounded.
const SAFE: f64 = 9_007_199_254_740_991.0;

const NUMERIC_ID: &str = "a numeric id must be a whole number from 0 to 2^53 - 1";

/// A dataset's JSON document: its name and the patch that builds it.
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct DataForm {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) patch: Vec<OpForm>,
}

/// One change in a patch, keyed by the name of the `Patch` method that makes it.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase", deny_unknown_fields)]
#[schemars(rename = "Change")]
pub(crate) enum OpForm {
    /// Sets the axis that sampled fields are recorded over, such as `time` in `s`.
    Axis { name: String, unit: String },
    /// Replaces a table with these rows and fields, or adds it.
    Replace(TableForm),
    /// Writes fields for these rows. Rows with existing ids are updated, new ids add rows, and
    /// fields left out keep their values. A missing table is added.
    Set(TableForm),
    /// Removes the rows with these ids; ids that match no row are ignored.
    Remove { table: String, ids: IdsForm },
    /// Records a frame at each axis coordinate in `at`. Each field gives one value per row per
    /// coordinate, frame-major. Covers every row, or only the rows `ids` names; other rows keep
    /// their last values.
    Append {
        at: At,
        table: String,
        #[serde(default)]
        ids: Option<IdsForm>,
        fields: Fields,
    },
    /// Forgets every sampled field's frames before axis coordinate `before`.
    Forget { before: f64 },
    /// Inserts a run of entries of sampled field `field` at level `level`, numbered from `first`,
    /// as time tiles store them. At level 0 each entry is a frame: one coordinate in `at` and one
    /// value per row in `values`. At level `k` each entry is a bucket of `8^k` frames: its first
    /// and last frame's coordinates in `at`, and in `values` every bucket's least value per row,
    /// followed by every bucket's greatest. Null is missing.
    Frames {
        table: String,
        field: String,
        #[serde(default)]
        level: u32,
        first: u64,
        at: Vec<f64>,
        values: Vec<Option<f64>>,
    },
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
impl JsonSchema for super::source::Data {
    fn schema_name() -> Cow<'static, str> {
        "Data".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        DataForm::json_schema(generator)
    }
}

/// A patch's JSON form: its changes, in order.
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
        json_schema!({
            "description": "Row ids: numbers or texts, or `{count}` for rows 0 to count - 1. In a reference, null names no row.",
            "anyOf": [
                { "type": "array", "items": id },
                {
                    "type": "object",
                    "properties": { "count": { "type": "integer", "minimum": 0, "maximum": u32::MAX } },
                    "required": ["count"],
                    "additionalProperties": false,
                },
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
        json_schema!({
            "description": "A field's values: an array of one kind of value; a reference naming another table's rows by id; or a slice of a binary file beside the document.",
            "anyOf": [
                { "type": "array", "items": element },
                { "type": "object", "properties": { "reference": { "type": "string" }, "ids": ids }, "required": ["reference", "ids"], "additionalProperties": false },
                {
                    "type": "object",
                    "properties": { "file": { "type": "string" }, "dtype": dtype, "offset": { "type": "integer", "minimum": 0 }, "count": { "type": "integer", "minimum": 0 } },
                    "required": ["file", "dtype", "count"],
                    "additionalProperties": false,
                },
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
            "description": "A point `[x, y]` (a third coordinate is ignored), or a list of geometries one level down: a path is a list of points, parts a list of paths, and polygons a list of parts.",
            "anyOf": [
                { "type": "array", "prefixItems": [{ "type": "number" }, { "type": "number" }], "items": { "type": "number" }, "minItems": 2, "maxItems": 3 },
                { "type": "array", "items": geometry },
            ],
        })
    }
}

/// Deserializes a patch from its JSON form. A field given as a slice of a binary file is an error
/// here; [`Patch::read`] fetches those.
impl<'de> Deserialize<'de> for Patch {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Patch, D::Error> {
        patch(Vec::<OpForm>::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// Deserializes ids from a list of numbers or texts, or from `{count}`.
impl<'de> Deserialize<'de> for Ids {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Ids, D::Error> {
        IdsForm::deserialize(deserializer).map(|form| form.0)
    }
}

/// An id's schema: a non-negative whole number, or a text.
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

/// Deserializes an id from a non-negative whole number or a text. A number parsed as a float must
/// be at most 2^53 − 1. Null is an error.
impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Id, D::Error> {
        Key::deserialize(deserializer)?.0.ok_or_else(|| de::Error::custom("an id must be a whole number or a text"))
    }
}

impl OpForm {
    /// The field columns of a replace, set, or append; empty for other changes.
    pub(crate) fn columns(&mut self) -> &mut [(String, Column)] {
        match self {
            OpForm::Replace(TableForm { fields, .. })
            | OpForm::Set(TableForm { fields, .. })
            | OpForm::Append { fields, .. } => &mut fields.0,
            _ => &mut [],
        }
    }
}

/// Builds the patch for `ops`. Every slice of a file must already be replaced by its values.
pub(crate) fn patch(ops: Vec<OpForm>) -> Result<Patch> {
    let mut patch = Patch::new();
    for (i, op) in ops.into_iter().enumerate() {
        let op = match op {
            OpForm::Axis { name, unit } => Op::Axis { name: name.into(), unit: unit.into() },
            OpForm::Replace(form) => Op::Replace(form.table().map_err(|e| e.at(i))?),
            OpForm::Set(form) => Op::Set(form.table().map_err(|e| e.at(i))?),
            OpForm::Remove { table, ids } => Op::Remove { table: table.into(), ids: ids.0 },
            OpForm::Append { at, table, ids, fields } => {
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
                Op::Append { table: table.into(), at, ids: ids.map(|ids| ids.0), fields: columns }
            }
            OpForm::Forget { before } => Op::Forget { before },
            OpForm::Frames { table, field, level, first, at, values } => {
                let values = values.iter().map(|v| v.map_or(f32::NAN, |v| v as f32)).collect();
                Op::frames(table.into(), field.into(), level, first, at, values)
            }
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

/// A field's column as written in JSON: values, a reference, or a slice of a binary file.
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
    /// The offset just past the slice's last byte. Errors on overflow.
    pub(crate) fn end(&self) -> Result<u64> {
        let length =
            self.count.checked_mul(self.dtype.width()).ok_or_else(|| Error::invalid("the slice is too long"))?;
        self.offset.checked_add(length).ok_or_else(|| Error::invalid("the slice's end offset overflows"))
    }

    /// Decodes the slice's fetched `bytes`. Errors unless exactly the slice's length arrived.
    pub(crate) fn read(&self, bytes: &[u8]) -> Result<Values> {
        let length = self.end()? - self.offset;
        if bytes.len() as u64 != length {
            let file = &self.file;
            return Err(Error::Io(format!("{file}: read {} of the slice's {length} bytes", bytes.len()).into()));
        }
        Ok(self.dtype.decode(bytes))
    }
}

/// The value type of a slice's bytes. Numbers are little endian; `bool` is one byte each, nonzero
/// meaning true.
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
    #[serde(rename = "bool")]
    Bool,
}

impl Dtype {
    fn width(self) -> u64 {
        match self {
            Dtype::U8 | Dtype::Bool => 1,
            Dtype::F32 | Dtype::I32 | Dtype::U32 => 4,
            Dtype::F64 | Dtype::U64 => 8,
        }
    }

    /// Decodes little-endian `bytes`, ignoring a trailing partial value.
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
            Dtype::U8 => bytes.iter().map(|&b| u32::from(b)).collect::<Vec<u32>>().into(),
            Dtype::Bool => bytes.iter().map(|&b| b != 0).collect::<Vec<bool>>().into(),
        }
    }
}

impl Column {
    /// The column's values. Errors for a slice of a file, which only [`Patch::read`] can fetch.
    fn values(self) -> Result<Values> {
        match self {
            Column::Values(values) => Ok(values),
            Column::Reference { .. } => unreachable!("callers handle reference columns first"),
            Column::Slice(slice) => {
                Err(Error::invalid(format!("{}: a slice of a file must be read with Patch::read", slice.file)))
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
                        return Err(de::Error::custom(format!("field {name} appears twice")));
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

/// Deserializes a column, naming its field in errors.
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
                Ok(Column::Reference { to, ids: ids.ok_or_else(|| missing("a reference needs ids"))? })
            }
            (None, Some(file)) if ids.is_none() => Ok(Column::Slice(Slice {
                file,
                dtype: dtype.ok_or_else(|| missing("a slice needs a dtype"))?,
                offset: offset.unwrap_or(0),
                count: count.ok_or_else(|| missing("a slice needs a count"))?,
            })),
            _ => Err(missing("an object must be {reference, ids} or {file, dtype, offset, count}")),
        }
    }
}

/// One value of an array column: a number, boolean, text, or geometry of `[x, y]` points. `null`
/// and an empty geometry are missing.
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
    /// Its nesting depth, following the first item at each level: 0 a point, 1 a path, 2 parts,
    /// 3 polygons.
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

    /// The geometry as a [`Value`]; `None` when it is empty. Errors when nested deeper than
    /// polygons.
    fn value(self) -> std::result::Result<Option<Value>, &'static str> {
        if matches!(&self, Geometry::List(items) if items.is_empty()) {
            return Ok(None);
        }
        Ok(Some(match self.depth() {
            0 => Value::Point(self.point()),
            1 => Value::Path(self.list(Geometry::point)),
            2 => Value::Parts(self.list(|path| path.list(Geometry::point))),
            3 => Value::Polygons(self.list(|parts| parts.list(|path| path.list(Geometry::point)))),
            _ => return Err("geometry nests deeper than polygons of rings of [x, y] points"),
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
                // Skip a third coordinate (GeoJSON elevation) and any after it.
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

/// Ids as written in JSON: a list of numbers or texts with `null` for none, as [`Ids`] takes them,
/// or `{count}`.
pub(crate) struct IdsForm(pub(crate) Ids);

impl<'de> Deserialize<'de> for IdsForm {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<IdsForm, D::Error> {
        struct Any;
        impl<'de> Visitor<'de> for Any {
            type Value = IdsForm;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("ids: numbers or texts, or {count}")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<IdsForm, A::Error> {
                let mut count = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "count" => count = Some(map.next_value::<u32>()?),
                        other => return Err(de::Error::custom(format!("ids: unknown key {other}"))),
                    }
                }
                count.map(|n| IdsForm(Ids::count(n))).ok_or_else(|| de::Error::custom("an ids object must be {count}"))
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

/// One id as written in JSON; `null` is `None`.
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

    #[test]
    fn patches_decode_from_json() {
        let ops = serde_json::json!([
            {"replace": {"table": "Bus", "ids": [7, 9], "fields": {
                "kv": [1.5, 2.5],
                "on": [true, false],
                "name": ["a", null],
            }}},
            {"remove": {"table": "Bus", "ids": [9]}},
        ]);
        let patch: Patch = serde_json::from_value(ops).expect("a patch");
        let data = Data::new("grid");
        data.apply(patch).expect("valid");
        let data = data.snapshot();
        let bus = data.table("Bus").expect("Bus");
        assert_eq!(bus.ids().collect::<Vec<_>>(), [Id::Number(7)]);
        assert_eq!(bus.get(7_u64, "kv"), Some(Value::Number(1.5)));
        assert_eq!(bus.get(7_u64, "on"), Some(Value::Bool(true)));
        assert_eq!(bus.get(7_u64, "name"), Some(Value::Text("a".into())));
    }

    #[test]
    fn forms_refuse_file_slices_bare_counts_and_invalid_ids() {
        let slice = serde_json::json!([{"replace": {"table": "Bus", "ids": {"count": 1}, "fields": {
            "kv": {"file": "kv.f64", "dtype": "f64le", "count": 1}}}}]);
        let error = serde_json::from_value::<Patch>(slice).expect_err("a slice needs Patch::read").to_string();
        assert!(error.contains("Patch::read"), "{error}");
        assert!(serde_json::from_value::<Ids>(serde_json::json!(3)).is_err(), "a bare number is not a count");
        assert_eq!(serde_json::from_value::<Ids>(serde_json::json!({"count": 3})).expect("a count").len(), 3);
        assert_eq!(serde_json::from_value::<Id>(serde_json::json!(3)).expect("an id"), Id::Number(3));
        assert!(serde_json::from_value::<Id>(serde_json::json!(1.5)).is_err());
        assert!(serde_json::from_value::<Id>(serde_json::json!(null)).is_err());
    }
}
