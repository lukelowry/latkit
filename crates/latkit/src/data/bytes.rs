//! One byte encoding for patches and datasets: a magic, the dataset's name (empty for a patch), and
//! the operations of the patch. Little endian throughout. Every part counts its own length, so
//! patches back to back decode one by one.
//!
//! | Part     | Layout                                                                              |
//! | -------- | ----------------------------------------------------------------------------------- |
//! | header   | `b"LATK"`, name                                                                     |
//! | ops      | `u32` count; per op a `u8` tag and its payload                                      |
//! | axis     | name, unit                                                                          |
//! | table    | name, ids, `u32` field count; per field: name, `u8` tag, payload                    |
//! | ids      | `u8` 0 and `u32` count, or `u8` 1 and values                                        |
//! | column   | `u32` page count, values per page                                                   |
//! | values   | `u8` storage, `u32` len, data, `u8` has-validity, validity words                    |
//! | samples  | `u32` rows, `u32` first frame's number, `u32` frames, `f64` coordinates, `f32` values frame-major (NaN missing) |
//! | `str`    | `u32` byte length, UTF-8                                                            |

use std::sync::Arc;

use super::bits::Bits;
use super::column::{Column, PAGE_ROWS};
use super::geometry::Geometry;
use super::ids::{IdList, Ids, RowIds};
use super::name::{Name, Version};
use super::patch::{Op, Patch};
use super::samples::Samples;
use super::table::{Field, Reference, Table};
use super::text::Text;
use super::values::{Array, Values};
use crate::{Error, Result};

const MAGIC: &[u8; 4] = b"LATK";

const OP_AXIS: u8 = 0;
const OP_PUT: u8 = 1;
const OP_SET: u8 = 2;
const OP_REMOVE: u8 = 3;
const OP_APPEND: u8 = 4;
const OP_FORGET: u8 = 5;

const FIELD_VALUES: u8 = 0;
const FIELD_REFERENCE: u8 = 1;
const FIELD_SAMPLED: u8 = 2;

const STORE_F64: u8 = 0;
const STORE_F32: u8 = 1;
const STORE_I32: u8 = 2;
const STORE_U32: u8 = 3;
const STORE_U64: u8 = 4;
const STORE_BOOL: u8 = 5;
const STORE_TEXT: u8 = 6;
const STORE_GEOMETRY: u8 = 7;

pub(crate) fn encode(name: &str, patch: &Patch) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    w.0.extend_from_slice(MAGIC);
    w.str(name);
    w.u32(patch.ops.len());
    for op in &patch.ops {
        match op {
            Op::Axis { name, unit } => {
                w.u8(OP_AXIS);
                w.str(name);
                w.str(unit);
            }
            Op::Put(table) => {
                w.u8(OP_PUT);
                w.table(table);
            }
            Op::Set(table) => {
                w.u8(OP_SET);
                w.table(table);
            }
            Op::Remove { table, ids } => {
                w.u8(OP_REMOVE);
                w.str(table);
                w.ids(ids);
            }
            Op::Append { table, at, fields } => {
                w.u8(OP_APPEND);
                w.str(table);
                w.u32(at.len());
                for &t in at {
                    w.f64(t);
                }
                w.u32(fields.len());
                for (name, values) in fields {
                    w.str(name);
                    w.values(values);
                }
            }
            Op::Forget { before } => {
                w.u8(OP_FORGET);
                w.f64(*before);
            }
        }
    }
    w.0
}

pub(crate) fn decode(bytes: &[u8]) -> Result<(Name, Patch)> {
    let mut r = Reader { bytes, at: 0, limit: usize::MAX, short: false };
    let decoded = r.message()?;
    if r.at != bytes.len() {
        return Err(malformed("trailing bytes"));
    }
    Ok(decoded)
}

/// The patch at the start of `bytes`, its name, and how many bytes it takes; `None` while `bytes`
/// hold only its start. One its lengths say runs past `limit` bytes is an error at once.
pub(crate) fn decode_prefix(bytes: &[u8], limit: usize) -> Result<Option<(Name, Patch, usize)>> {
    let mut r = Reader { bytes, at: 0, limit, short: false };
    match r.message() {
        Ok((name, patch)) => Ok(Some((name, patch, r.at))),
        Err(_) if r.short => Ok(None),
        Err(e) => Err(e),
    }
}

impl Reader<'_> {
    fn message(&mut self) -> Result<(Name, Patch)> {
        let r = self;
        if r.take(4)? != MAGIC {
            return Err(malformed("not latkit bytes"));
        }
        let name = r.name()?;
        let count = r.u32()?;
        let mut patch = Patch::new();
        for _ in 0..count {
            let op = match r.u8()? {
                OP_AXIS => Op::Axis { name: r.name()?, unit: r.name()? },
                OP_PUT => Op::Put(r.table()?),
                OP_SET => Op::Set(r.table()?),
                OP_REMOVE => Op::Remove { table: r.name()?, ids: r.ids()? },
                OP_APPEND => {
                    let table = r.name()?;
                    let frames = r.len(8)?;
                    let at = (0..frames).map(|_| r.f64()).collect::<Result<_>>()?;
                    let count = r.len(1)?;
                    let fields = (0..count).map(|_| Ok((r.name()?, r.values()?))).collect::<Result<_>>()?;
                    Op::Append { table, at, fields }
                }
                OP_FORGET => Op::Forget { before: r.f64()? },
                tag => return Err(malformed(format!("unknown operation {tag}"))),
            };
            patch.ops.push(op);
        }
        Ok((name, patch))
    }
}

fn malformed(reason: impl Into<std::borrow::Cow<'static, str>>) -> Error {
    Error::invalid(reason).at("bytes")
}

fn too_long(limit: usize) -> Error {
    Error::Limit(format!("a patch longer than {limit} bytes").into())
}

struct Writer(Vec<u8>);

impl Writer {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }

    fn u32(&mut self, v: usize) {
        self.0.extend_from_slice(&u32::try_from(v).expect("counts fit in u32").to_le_bytes());
    }

    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    fn str(&mut self, s: &str) {
        self.u32(s.len());
        self.0.extend_from_slice(s.as_bytes());
    }

    fn slice<T: bytemuck::Pod>(&mut self, values: &[T]) {
        #[cfg(target_endian = "little")]
        self.0.extend_from_slice(bytemuck::cast_slice(values));
        #[cfg(target_endian = "big")]
        compile_error!("latkit's byte format is written on little-endian targets");
    }

    fn table(&mut self, table: &Table) {
        self.str(&table.name);
        match &table.ids {
            RowIds::Count(n) => {
                self.u8(0);
                self.u32(*n as usize);
            }
            RowIds::Listed(column) => {
                self.u8(1);
                self.values(&column.values());
            }
        }
        self.u32(table.fields.len());
        for (name, field) in &table.fields {
            self.str(name);
            match field {
                Field::Values(column, _) => {
                    self.u8(FIELD_VALUES);
                    self.column(column);
                }
                Field::Reference(reference) => {
                    self.u8(FIELD_REFERENCE);
                    self.str(&reference.to);
                    self.column(&reference.ids);
                }
                Field::Sampled(samples, _) => {
                    self.u8(FIELD_SAMPLED);
                    self.u32(table.len());
                    self.u32(samples.start() as usize);
                    self.u32((samples.end() - samples.start()) as usize);
                    for frame in samples.start()..samples.end() {
                        self.f64(samples.at(frame));
                    }
                    self.slice(&samples.frames_of(table.len()));
                }
            }
        }
    }

    fn ids(&mut self, ids: &Ids) {
        match &ids.0 {
            IdList::Count(n) => {
                self.u8(0);
                self.u32(*n as usize);
            }
            IdList::Listed(values) => {
                self.u8(1);
                self.values(values);
            }
        }
    }

    fn column(&mut self, column: &Column) {
        self.u32(column.pages().len());
        if column.pages().is_empty() {
            self.values(column.like());
        }
        for page in column.pages() {
            self.values(&page.values);
        }
    }

    fn values(&mut self, values: &Values) {
        let len = values.len();
        match &values.array {
            Array::F64(v) => self.numbers(STORE_F64, v),
            Array::F32(v) => self.numbers(STORE_F32, v),
            Array::I32(v) => self.numbers(STORE_I32, v),
            Array::U32(v) => self.numbers(STORE_U32, v),
            Array::U64(v) => self.numbers(STORE_U64, v),
            Array::Bool(bits) => {
                self.u8(STORE_BOOL);
                self.u32(len);
                self.slice(&bits.to_words());
            }
            Array::Text(text) => {
                self.u8(STORE_TEXT);
                self.u32(len);
                let (offsets, bytes) = text.compact();
                self.slice(&offsets);
                self.str(bytes);
            }
            Array::Geometry(geometry) => {
                self.u8(STORE_GEOMETRY);
                self.u32(len);
                self.u8(geometry.depth());
                let (levels, coords) = geometry.compact();
                for level in &levels {
                    self.u32(level.len());
                    self.slice(level);
                }
                self.u32(coords.len());
                self.slice(bytemuck::cast_slice::<[f64; 2], f64>(&coords));
            }
        }
        match &values.valid {
            Some(bits) => {
                self.u8(1);
                self.slice(&bits.to_words());
            }
            None => self.u8(0),
        }
    }

    fn numbers<T: bytemuck::Pod>(&mut self, store: u8, values: &[T]) {
        self.u8(store);
        self.u32(values.len());
        self.slice(values);
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    /// The most bytes the message may take: past it, more bytes are not waited for.
    limit: usize,
    /// Whether reading ran out of bytes, which more of a stream may bring.
    short: bool,
}

impl Reader<'_> {
    /// Whether `n` more bytes are there: an error past the limit, short past the bytes held.
    fn reach(&mut self, n: usize) -> Result<()> {
        let end = self.at.saturating_add(n);
        if end > self.limit {
            return Err(too_long(self.limit));
        }
        if end > self.bytes.len() {
            self.short = true;
            return Err(malformed("truncated"));
        }
        Ok(())
    }

    fn take(&mut self, n: usize) -> Result<&[u8]> {
        self.reach(n)?;
        let end = self.at + n;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().expect("four bytes")))
    }

    /// A count of items at least `size` bytes each, checked against the bytes left.
    fn len(&mut self, size: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        self.reach(n.saturating_mul(size))?;
        Ok(n)
    }

    fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().expect("eight bytes")))
    }

    fn name(&mut self) -> Result<Name> {
        let n = self.len(1)?;
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes).map(Name::from).map_err(|_| malformed("text is not UTF-8"))
    }

    fn vec<T: bytemuck::Pod>(&mut self, n: usize) -> Result<Vec<T>> {
        let bytes = self.take(n.checked_mul(size_of::<T>()).ok_or_else(|| malformed("too large"))?)?;
        Ok(bytes.chunks_exact(size_of::<T>()).map(bytemuck::pod_read_unaligned).collect())
    }

    fn ids(&mut self) -> Result<Ids> {
        match self.u8()? {
            0 => Ok(Ids(IdList::Count(self.u32()?))),
            1 => Ok(Ids(IdList::Listed(self.values()?))),
            tag => Err(malformed(format!("unknown ids {tag}"))),
        }
    }

    fn column(&mut self) -> Result<Column> {
        let pages = self.len(1)?;
        if pages == 0 {
            return Ok(Column::missing(&self.values()?, 0));
        }
        let pages: Vec<Values> = (0..pages).map(|_| self.values()).collect::<Result<_>>()?;
        if pages.iter().rev().skip(1).any(|p| p.len() != PAGE_ROWS) {
            return Err(malformed("a page short of a full page before the last"));
        }
        let like = pages[0].clone();
        if pages.iter().any(|p| p.kind() != like.kind()) {
            return Err(malformed("pages of different kinds"));
        }
        Ok(Column::from_pages(pages, &like))
    }

    fn table(&mut self) -> Result<Table> {
        let name = self.name()?;
        let ids = match self.ids()? {
            Ids(IdList::Count(n)) => RowIds::Count(n),
            Ids(IdList::Listed(values)) => RowIds::Listed(Column::new(&values)),
        };
        let structure = Version::next();
        let mut table = Table { name, ids, index: Arc::default(), fields: Vec::new(), structure, order: structure };
        let fields = self.len(1)?;
        for _ in 0..fields {
            let name = self.name()?;
            let field = match self.u8()? {
                FIELD_VALUES => Field::Values(self.column()?, Version::next()),
                FIELD_REFERENCE => {
                    let to = self.name()?;
                    Field::Reference(Reference::new(to, self.column()?))
                }
                FIELD_SAMPLED => {
                    let rows = self.u32()? as usize;
                    let first = self.u32()?;
                    let frames = self.len(8)?;
                    let at: Vec<f64> = (0..frames).map(|_| self.f64()).collect::<Result<_>>()?;
                    let values: Vec<f32> = self.vec(frames.checked_mul(rows).ok_or_else(|| malformed("too large"))?)?;
                    let mut samples = Samples::from_frame(first);
                    samples.append(&at, &Values::from(values), rows).map_err(|e| e.at(&name))?;
                    Field::Sampled(samples, Version::next())
                }
                tag => return Err(malformed(format!("unknown field {tag}"))),
            };
            table.insert(name, field);
        }
        Ok(table)
    }

    fn values(&mut self) -> Result<Values> {
        let store = self.u8()?;
        let len = self.u32()? as usize;
        let array = match store {
            STORE_F64 => Array::F64(self.vec::<f64>(len)?.into()),
            STORE_F32 => Array::F32(self.vec::<f32>(len)?.into()),
            STORE_I32 => Array::I32(self.vec::<i32>(len)?.into()),
            STORE_U32 => Array::U32(self.vec::<u32>(len)?.into()),
            STORE_U64 => Array::U64(self.vec::<u64>(len)?.into()),
            STORE_BOOL => Array::Bool(Bits::from_words(self.vec(len.div_ceil(64))?, len)),
            STORE_TEXT => {
                let offsets = self.vec::<u32>(len + 1)?;
                let n = self.len(1)?;
                let bytes = String::from_utf8(self.take(n)?.to_vec()).map_err(|_| malformed("text is not UTF-8"))?;
                Array::Text(Text::from_parts(offsets, bytes).ok_or_else(|| malformed("text offsets"))?)
            }
            STORE_GEOMETRY => {
                let depth = self.u8()?;
                let levels = (0..depth.min(4))
                    .map(|_| {
                        let n = self.len(4)?;
                        self.vec::<u32>(n)
                    })
                    .collect::<Result<Vec<_>>>()?;
                let n = self.len(16)?;
                let flat: Vec<f64> = self.vec(n * 2)?;
                let coords = flat.as_chunks::<2>().0.to_vec();
                let geometry =
                    Geometry::from_parts(depth, levels, coords).ok_or_else(|| malformed("geometry offsets"))?;
                if geometry.len() != len {
                    return Err(malformed("geometry length"));
                }
                Array::Geometry(geometry)
            }
            store => return Err(malformed(format!("unknown storage {store}"))),
        };
        let valid = match self.u8()? {
            0 => None,
            1 => Some(Bits::from_words(self.vec(len.div_ceil(64))?, len)),
            _ => return Err(malformed("validity")),
        };
        Ok(Values { array, valid })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Data, Row, Value};

    fn grid() -> Data {
        let mut data = Data::new("grid");
        data.apply(
            Patch::new()
                .axis("time", "s")
                .set(
                    Table::new("Bus", vec!["a", "b", "c"])
                        .field("kv", vec![Some(230.0), None, Some(115.0)])
                        .field("name", vec!["North", "Mid", "South"])
                        .field("point", vec![[0.0, 1.0], [2.0, 3.0], [4.0, 5.0]])
                        .field("open", vec![true, false, true]),
                )
                .set(Table::new("Branch", 2).reference("from", "Bus", vec!["a", "b"]).reference(
                    "to",
                    "Bus",
                    vec!["b", "c"],
                )),
        )
        .expect("valid");
        data.apply(Patch::new().append([1.0], "Bus", [("vm", vec![1.0, 1.01, 0.99])])).expect("frame");
        data.apply(Patch::new().append([2.0], "Bus", [("vm", vec![1.02, f64::NAN, 0.98])])).expect("frame");
        data
    }

    #[test]
    fn datasets_round_trip() {
        let data = grid();
        let bytes = data.to_bytes();
        let back = Data::from_bytes(&bytes).expect("decodes");
        assert_eq!(back.name(), "grid");
        assert_eq!(back.axis(), Some(("time", "s")));
        let bus = |id: &str| Row::new("grid", "Bus", id);
        for field in ["kv", "name", "point", "open", "vm"] {
            for id in ["a", "b", "c"] {
                assert_eq!(back.get(&bus(id), field), data.get(&bus(id), field), "{field} of {id}");
            }
        }
        assert_eq!(back.get_at(&bus("a"), "vm", 1.5), Some(Value::Number(f64::from(1.0_f32))));
        assert_eq!(back.get(&Row::new("grid", "Branch", 1_u64), "to"), Some(Value::Row(bus("c"))));
        assert_eq!(back.to_bytes(), bytes, "encoding is deterministic");
    }

    #[test]
    fn patches_round_trip() {
        let patch = Patch::new().remove("Bus", vec!["a"]).append([3.0], "Bus", [("vm", vec![1.0, 1.0, 1.0])]);
        let bytes = patch.to_bytes();
        assert_eq!(Patch::from_bytes(&bytes).expect("decodes").to_bytes(), bytes);
        assert!(Data::from_bytes(&bytes).is_err());
    }

    #[test]
    fn patches_back_to_back_decode_one_by_one() {
        let patches = [grid().to_patch(), Patch::new().forget(1.5), Patch::new().remove("Bus", vec!["a"])];
        let stream: Vec<u8> = patches.iter().flat_map(Patch::to_bytes).collect();
        let (mut at, mut read) = (0, Vec::new());
        // Arriving a few bytes at a time, as from a socket.
        for end in (0..=stream.len()).step_by(5).chain([stream.len()]) {
            while let Some((patch, used)) = Patch::decode(&stream[at..end], usize::MAX).expect("valid so far") {
                read.push(patch.to_bytes());
                at += used;
            }
        }
        assert_eq!(read, patches.iter().map(Patch::to_bytes).collect::<Vec<_>>());
        assert!(Patch::decode(b"LATX....", 64).is_err(), "not latkit bytes, however many follow");
        // A length past the limit fails at once rather than waiting for bytes that may never come.
        let long = Patch::new().set(Table::new("Bus", 1).field("name", vec!["x".repeat(100)])).to_bytes();
        assert!(matches!(Patch::decode(&long[..70], 64), Err(Error::Limit(_))));
        assert!(Patch::decode(&long[..70], 1 << 20).expect("short").is_none());
    }

    #[test]
    fn frames_keep_their_numbers_through_bytes_and_gathers() {
        let mut data = grid();
        data.apply(Patch::new().forget(1.5)).expect("forget");
        let first = |data: &Data| match data.table("Bus").and_then(|t| t.field_named("vm")) {
            Some(Field::Sampled(samples, _)) => samples.start(),
            _ => panic!("sampled"),
        };
        assert_eq!(first(&data), 1);
        assert_eq!(first(&Data::from_bytes(&data.to_bytes()).expect("decodes")), 1);
        data.apply(Patch::new().remove("Bus", vec!["b"])).expect("remove");
        assert_eq!(first(&data), 1, "rows removed keep the frames' numbers");
    }

    #[test]
    fn malformed_bytes_are_invalid_not_panics() {
        let bytes = grid().to_bytes();
        for end in 0..bytes.len() {
            assert!(Data::from_bytes(&bytes[..end]).is_err());
        }
        let mut flipped = bytes.clone();
        for i in (0..flipped.len()).step_by(7) {
            flipped[i] ^= 0x5a;
            let _ = Data::from_bytes(&flipped);
        }
    }
}
