//! One byte encoding for patches and datasets: a frame of a magic, its length, the name of the
//! dataset its patch changes (empty when it names none), and the patch's operations. Little endian
//! throughout. A frame says its length up front, so frames back to back split without decoding, and a
//! stream knows at once whether it holds a whole one. A dataset's bytes are the patch to it that
//! builds it.
//!
//! | Part     | Layout                                                                                |
//! | -------- | ------------------------------------------------------------------------------------- |
//! | frame    | `b"LATK"`, `u16` version (1), `u16` flags (0), `u64` length of the whole frame, name, `u32` op count, ops                 |
//! | op       | `u8` tag and its payload: axis, replace, set, remove, append, forget, or frames       |
//! | axis     | name, unit                                                                            |
//! | replace  | table, as `set`                                                                       |
//! | remove   | table name, ids                                                                       |
//! | append   | table name, `u8` 1 and ids or `u8` 0 for every row, `u32` frames, `f64` coordinates,  |
//! |          | `u32` field count; per field: name, values frame-major                                |
//! | forget   | `f64` before                                                                          |
//! | frames   | table name, field name, `u32` rows, run                                               |
//! | table    | name, ids, `u32` field count; per field: name, `u8` tag, payload                      |
//! | field    | values; a reference's table and its target ids as values; or samples                  |
//! | ids      | `u8` 0 and `u32` count, or `u8` 1 and values: `u64`, `u32` read as `u64`, or texts    |
//! | values   | `u8` storage, `u32` len, data, `u8` has-validity, validity words (`u64`)              |
//! | samples  | `u32` rows, `u64` first frame read, `u64` frames read, `u8` highest level, `u32` run count, runs; buckets |
//! |          | whose eight entries a level below are held are left out, as they follow from those    |
//! | run      | `u8` level, `u64` first entry, `u32` entries, `f64` coordinates (a frame's own; a     |
//! |          | bucket's first and last frame's), `f32` values entry-major: a frame's per row, or a   |
//! |          | bucket's least per row and, after every bucket's, its greatest (NaN missing)          |
//! | `str`    | `u32` byte length, UTF-8                                                              |

use std::io::Read;
use std::sync::Arc;

use super::bits::Bits;
use super::column::Column;
use super::geometry::Geometry;
use super::ids::{IdList, Ids, RowIds};
use super::name::{Name, Version};
use super::patch::{Op, Patch};
use super::samples::{self, MAX_LEVEL, Run, Samples};
use super::table::{Field, Reference, Table};
use super::text::Text;
use super::values::{Array, Values};
use crate::{Error, Result};

const MAGIC: &[u8; 4] = b"LATK";
/// Magic, version, flags, and total frame length.
const HEADER: usize = 16;
const VERSION: u16 = 1;

/// Limits for one binary frame. These bound encoded bytes and conservative decoded storage
/// accounting; applying a patch and retaining datasets have separate memory costs.
#[derive(Clone, Copy, Debug)]
pub struct DecodeLimits {
    /// Maximum encoded frame size; checked as soon as the header arrives.
    pub frame_bytes: usize,
    /// Budget for decoded vectors, names, operations, pages, and derived sample buckets.
    pub decoded_bytes: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self { frame_bytes: 256 << 20, decoded_bytes: 512 << 20 }
    }
}

const OP_AXIS: u8 = 0;
const OP_REPLACE: u8 = 1;
const OP_SET: u8 = 2;
const OP_REMOVE: u8 = 3;
const OP_APPEND: u8 = 4;
const OP_FORGET: u8 = 5;
const OP_FRAMES: u8 = 6;

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

pub(crate) fn encode(patch: &Patch) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    w.0.extend_from_slice(MAGIC);
    w.0.extend_from_slice(&VERSION.to_le_bytes());
    w.0.extend_from_slice(&0_u16.to_le_bytes());
    w.0.extend_from_slice(&[0; 8]);
    w.str(patch.data.as_deref().unwrap_or(""));
    w.u32(patch.ops.len());
    for op in &patch.ops {
        match op {
            Op::Axis { name, unit } => {
                w.u8(OP_AXIS);
                w.str(name);
                w.str(unit);
            }
            Op::Replace(table) => {
                w.u8(OP_REPLACE);
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
            Op::Append { table, at, ids, fields } => {
                w.u8(OP_APPEND);
                w.str(table);
                match ids {
                    Some(ids) => {
                        w.u8(1);
                        w.ids(ids);
                    }
                    None => w.u8(0),
                }
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
            Op::Frames { table, field, run, at, values } => {
                w.u8(OP_FRAMES);
                w.str(table);
                w.str(field);
                let per_row = run.len() * samples::sides(run.level);
                w.u32(values.len().checked_div(per_row).unwrap_or(0));
                w.run(run, at, values);
            }
        }
    }
    let length = w.0.len() as u64;
    w.0[8..HEADER].copy_from_slice(&length.to_le_bytes());
    w.0
}

/// `values` as bytes, as a field holding them writes them: how jobs hand a column over.
#[cfg(feature = "gpu")]
pub(crate) fn values_bytes(values: &Values) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    w.values(values);
    w.0
}

/// The values `bytes` hold, every byte of them, as [`values_bytes`] wrote them.
#[cfg(feature = "gpu")]
pub(crate) fn read_values(bytes: &[u8]) -> Result<Values> {
    let mut r = Reader { bytes, at: 0, remaining: DecodeLimits::default().decoded_bytes };
    let values = r.values()?;
    if r.at != bytes.len() {
        return Err(malformed("trailing bytes"));
    }
    Ok(values)
}

/// The patch `bytes` hold, every byte of them.
pub(crate) fn decode(bytes: &[u8]) -> Result<Patch> {
    match frame(bytes, DecodeLimits::default())? {
        Some((patch, used)) if used == bytes.len() => Ok(patch),
        Some(_) => Err(malformed("trailing bytes")),
        None => Err(malformed("truncated")),
    }
}

/// The patches `read` carries, frames back to back, each read once whole: its header, checked
/// against `limits` as it arrives, says how many bytes follow. They end with the bytes, between
/// frames, or at the first error.
pub(crate) fn stream<R: Read>(mut read: R, limits: DecodeLimits) -> impl Iterator<Item = Result<Patch>> {
    let mut ended = false;
    std::iter::from_fn(move || {
        if ended {
            return None;
        }
        let patch = next(&mut read, limits).transpose();
        ended = !matches!(patch, Some(Ok(_)));
        patch
    })
}

/// The patch of the next frame `read` holds; `None` where its bytes end between frames.
fn next(read: &mut impl Read, limits: DecodeLimits) -> Result<Option<Patch>> {
    let failed = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::UnexpectedEof => malformed("truncated"),
        _ => Error::Io(error.to_string().into()),
    };
    let mut bytes = vec![0; HEADER];
    let mut held = 0;
    // The header is checked as its bytes arrive, so bytes that are not latkit's fail at once.
    let length = loop {
        if let Some(length) = length(&bytes[..held], limits.frame_bytes)? {
            break length;
        }
        match read.read(&mut bytes[held..]) {
            Ok(0) if held == 0 => return Ok(None),
            Ok(0) => return Err(malformed("truncated")),
            Ok(n) => held += n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(failed(error)),
        }
    };
    bytes.resize(length, 0);
    read.read_exact(&mut bytes[HEADER..]).map_err(failed)?;
    let (patch, _) = frame(&bytes, limits)?.expect("a whole frame");
    Ok(Some(patch))
}

/// The length of the frame `bytes` begin, as its header says, once the header is checked and the
/// length found within `limit`; `None` while `bytes` hold less than the header.
fn length(bytes: &[u8], limit: usize) -> Result<Option<usize>> {
    let held = bytes.len().min(MAGIC.len());
    if bytes[..held] != MAGIC[..held] {
        return Err(malformed("not latkit bytes"));
    }
    if let Some(version) = bytes.get(4..6)
        && version != VERSION.to_le_bytes()
    {
        return Err(malformed("unsupported LATK version"));
    }
    if let Some(flags) = bytes.get(6..8)
        && flags != [0, 0]
    {
        return Err(malformed("unsupported LATK flags"));
    }
    let Some(length) = bytes.get(8..HEADER) else { return Ok(None) };
    let length = u64::from_le_bytes(length.try_into().expect("eight bytes"));
    let length = usize::try_from(length).map_err(|_| too_long(limit))?;
    if length > limit {
        return Err(too_long(limit));
    }
    if length < HEADER {
        return Err(malformed("a frame shorter than its header"));
    }
    Ok(Some(length))
}

/// The patch of the frame `bytes` begin and the frame's length; `None` while `bytes` hold only its
/// start.
fn frame(bytes: &[u8], limits: DecodeLimits) -> Result<Option<(Patch, usize)>> {
    let Some(length) = length(bytes, limits.frame_bytes)? else { return Ok(None) };
    let Some(frame) = bytes.get(..length) else { return Ok(None) };
    let mut r = Reader { bytes: frame, at: HEADER, remaining: limits.decoded_bytes };
    let patch = r.patch()?;
    if r.at != frame.len() {
        return Err(malformed("a frame longer than its patch"));
    }
    Ok(Some((patch, length)))
}

impl Reader<'_> {
    fn patch(&mut self) -> Result<Patch> {
        let r = self;
        let name = r.name()?;
        let count = r.len(1)?;
        r.charge(count, size_of::<Op>())?;
        let mut patch = Patch { data: (!name.is_empty()).then_some(name), ops: Vec::with_capacity(count) };
        for _ in 0..count {
            let op = match r.u8()? {
                OP_AXIS => Op::Axis { name: r.name()?, unit: r.name()? },
                OP_REPLACE => Op::Replace(r.table()?),
                OP_SET => Op::Set(r.table()?),
                OP_REMOVE => Op::Remove { table: r.name()?, ids: r.ids()? },
                OP_APPEND => {
                    let table = r.name()?;
                    let ids = match r.u8()? {
                        0 => None,
                        1 => Some(r.ids()?),
                        _ => return Err(malformed("an append names its rows or none")),
                    };
                    let frames = r.len(8)?;
                    let at = r.vec(frames)?;
                    let count = r.len(1)?;
                    r.charge(count, size_of::<(Name, Values)>())?;
                    let fields = (0..count).map(|_| Ok((r.name()?, r.values()?))).collect::<Result<_>>()?;
                    Op::Append { table, at, ids, fields }
                }
                OP_FORGET => Op::Forget { before: r.f64()? },
                OP_FRAMES => {
                    let (table, field) = (r.name()?, r.name()?);
                    let rows = r.u32()? as usize;
                    let (run, at, values) = r.run(rows)?;
                    Op::Frames { table, field, run, at, values }
                }
                tag => return Err(malformed(format!("unknown operation {tag}"))),
            };
            patch.ops.push(op);
        }
        Ok(patch)
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

    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
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
                    self.u64(samples.start());
                    self.u64(samples.end() - samples.start());
                    self.u8(samples.levels() as u8);
                    let runs = samples.stored_runs();
                    self.u32(runs.len());
                    let rows: Vec<usize> = (0..table.len()).collect();
                    for run in &runs {
                        let (at, values) = samples.read(run, &rows);
                        self.run(run, &at, &values);
                    }
                }
            }
        }
    }

    /// `run`: its level, first entry, and entries, its coordinates `at`, and its `values`.
    fn run(&mut self, run: &Run, at: &[f64], values: &[f32]) {
        self.u8(run.level as u8);
        self.u64(run.entries.start);
        self.u32(run.len());
        self.slice(at);
        self.slice(values);
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
        self.values(&column.values());
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

/// Reads one frame, whose bytes are all there.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    remaining: usize,
}

impl Reader<'_> {
    fn charge(&mut self, count: usize, size: usize) -> Result<()> {
        let bytes = count.checked_mul(size).ok_or_else(|| malformed("decoded size overflow"))?;
        self.remaining = self
            .remaining
            .checked_sub(bytes)
            .ok_or_else(|| Error::Limit("decoded patch exceeds its storage budget".into()))?;
        Ok(())
    }

    /// Whether `n` more bytes are in the frame.
    fn reach(&self, n: usize) -> Result<()> {
        if self.at.saturating_add(n) > self.bytes.len() {
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

    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().expect("eight bytes")))
    }

    fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into().expect("eight bytes")))
    }

    fn name(&mut self) -> Result<Name> {
        let n = self.len(1)?;
        self.charge(n, 1)?;
        self.charge(1, size_of::<Name>())?;
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes).map(Name::from).map_err(|_| malformed("text is not UTF-8"))
    }

    /// `n` values, copied whole.
    fn vec<T: bytemuck::Pod>(&mut self, n: usize) -> Result<Vec<T>> {
        // Includes conversion into column pages and the sampled levels derived from runs.
        self.charge(n, 4 * size_of::<T>())?;
        let bytes = self.take(n.checked_mul(size_of::<T>()).ok_or_else(|| malformed("too large"))?)?;
        let mut out = vec![T::zeroed(); n];
        bytemuck::cast_slice_mut::<T, u8>(&mut out).copy_from_slice(bytes);
        Ok(out)
    }

    fn ids(&mut self) -> Result<Ids> {
        match self.u8()? {
            0 => Ok(Ids(IdList::Count(self.u32()?))),
            1 => Ok(Ids(IdList::Listed(self.id_values()?))),
            tag => Err(malformed(format!("unknown ids {tag}"))),
        }
    }

    fn column(&mut self) -> Result<Column> {
        Ok(Column::new(&self.values()?))
    }

    /// Ids as values: `u32` ids, as writers without 64-bit integers send them, read as the `u64` every
    /// numbered id is.
    fn id_values(&mut self) -> Result<Values> {
        let values = self.values()?;
        Ok(match values.array {
            Array::U32(ids) => {
                Values { array: Array::U64(ids.iter().map(|&id| u64::from(id)).collect::<Vec<_>>().into()), ..values }
            }
            _ => values,
        })
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
        self.charge(fields, size_of::<(Name, Field)>())?;
        for _ in 0..fields {
            let name = self.name()?;
            let field = match self.u8()? {
                FIELD_VALUES => Field::Values(self.column()?, Version::next()),
                FIELD_REFERENCE => {
                    let to = self.name()?;
                    Field::Reference(Reference::new(to, Column::new(&self.id_values()?)))
                }
                FIELD_SAMPLED => Field::Sampled(self.samples().map_err(|e| e.at(&name))?, Version::next()),
                tag => return Err(malformed(format!("unknown field {tag}"))),
            };
            table.insert(name, field);
        }
        Ok(table)
    }

    /// A sampled field: its runs put in level by level, each level's buckets that follow from the
    /// level below written before its own runs.
    fn samples(&mut self) -> Result<Samples> {
        let rows = self.u32()? as usize;
        let first = self.u64()?;
        let frames = self.u64()?;
        let end = first.checked_add(frames).ok_or_else(|| malformed("too many frames"))?;
        let levels = u32::from(self.u8()?);
        if levels > MAX_LEVEL {
            return Err(malformed("unsupported sample level"));
        }
        let count = self.len(13)?;
        self.charge(count, size_of::<(Run, Vec<f64>, Vec<f32>)>())?;
        let runs = (0..count).map(|_| self.run(rows)).collect::<Result<Vec<_>>>()?;
        let mut samples = Samples::from_frame(first);
        if runs.iter().any(|(run, ..)| run.level > levels) {
            return Err(malformed("run above sample levels"));
        }
        for level in 0..=levels {
            if level > 0 {
                samples.derive(level);
            }
            for (run, at, values) in runs.iter().filter(|(run, ..)| run.level == level) {
                samples.insert(run, at, values, rows)?;
            }
        }
        samples.reads(first..end);
        Ok(samples)
    }

    /// A run of entries of `rows` rows: what it holds, its coordinates, and its values.
    fn run(&mut self, rows: usize) -> Result<(Run, Vec<f64>, Vec<f32>)> {
        let level = u32::from(self.u8()?);
        if level > MAX_LEVEL {
            return Err(malformed(format!("no level {level}")));
        }
        let first = self.u64()?;
        let n = self.u32()?;
        let run = Run {
            level,
            entries: first..first.checked_add(u64::from(n)).ok_or_else(|| malformed("too many entries"))?,
        };
        let n = n as usize;
        let coordinates = n.checked_mul(samples::coordinates(level));
        let values = n.checked_mul(rows).and_then(|v| v.checked_mul(samples::sides(level)));
        let (Some(coordinates), Some(values)) = (coordinates, values) else { return Err(malformed("too large")) };
        let at = self.vec(coordinates)?;
        let values = self.vec(values)?;
        Ok((run, at, values))
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
                let offsets = self.vec::<u32>(len.checked_add(1).ok_or_else(|| malformed("too many text values"))?)?;
                let n = self.len(1)?;
                self.charge(n, 2)?;
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
                let coords: Vec<[f64; 2]> = self.vec(n)?;
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
    use crate::{Data, Row, Snapshot, Value};

    #[test]
    fn v1_fixture_and_large_indexes_are_stable() {
        let hex = include_str!("../../tests/fixtures/latk-v1.hex").trim();
        let bytes: Vec<u8> =
            (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        let patch = Patch::new().frames("T", "v", 0, (1_u64 << 32) + 3, [0.0, 1.0], [1.0, 2.0]);
        assert_eq!(patch.to_bytes(), bytes);
        assert_eq!(Patch::from_bytes(&bytes).unwrap().to_bytes(), bytes);
        let data = Data::new("test");
        data.apply(Patch::new().replace(Table::new("T", Ids::count(1))).extend(patch)).unwrap();
        data.apply(Patch::new().append("T", [2.0], [("v", vec![3.0_f32])])).unwrap();
        let data = data.snapshot();
        assert_eq!(data.span(), Some([0.0, 2.0]));
        assert_eq!(Snapshot::from_bytes(&data.to_bytes()).unwrap().to_bytes(), data.to_bytes());
        let mut files = std::collections::HashMap::new();
        data.to_tiles(8, |path, bytes| {
            files.insert(path.to_owned(), bytes.to_vec());
            Ok(())
        })
        .unwrap();
        assert!(files.keys().any(|p| p.contains("536870912")));
        let mut version = bytes.clone();
        version[4] = 2;
        assert!(Patch::from_bytes(&version).is_err());
        let mut flags = bytes.clone();
        flags[6] = 1;
        assert!(Patch::from_bytes(&flags).is_err());
        let tight = DecodeLimits { frame_bytes: 1024, decoded_bytes: 1 };
        assert!(matches!(Patch::stream(&bytes[..], tight).next(), Some(Err(Error::Limit(_)))));
    }

    #[test]
    fn frame_overflow_is_atomic_and_high_levels_round_trip() {
        let data = Data::new("test");
        data.apply(Patch::new().replace(Table::new("T", Ids::count(1))).frames(
            "T",
            "v",
            0,
            u64::MAX - 1,
            [0.0],
            [1.0],
        ))
        .unwrap();
        let before = data.snapshot().to_bytes();
        assert!(data.apply(Patch::new().append("T", [1.0], [("v", vec![2.0_f32])])).is_err());
        assert_eq!(data.snapshot().to_bytes(), before);
        let data = Data::new("test");
        data.apply(Patch::new().replace(Table::new("T", Ids::count(1))).frames(
            "T",
            "v",
            12,
            0,
            [0.0, 1.0],
            [1.0, 2.0],
        ))
        .unwrap();
        let data = data.snapshot();
        assert_eq!(Snapshot::from_bytes(&data.to_bytes()).unwrap().to_bytes(), data.to_bytes());
    }

    fn grid() -> Data {
        let data = Data::new("grid");
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
                .set(Table::new("Branch", Ids::count(2)).reference("from", "Bus", vec!["a", "b"]).reference(
                    "to",
                    "Bus",
                    vec!["b", "c"],
                )),
        )
        .expect("valid");
        data.apply(Patch::new().append("Bus", [1.0], [("vm", vec![1.0, 1.01, 0.99])])).expect("frame");
        data.apply(Patch::new().append("Bus", [2.0], [("vm", vec![1.02, f64::NAN, 0.98])])).expect("frame");
        data
    }

    #[test]
    fn datasets_round_trip() {
        let data = grid().snapshot();
        let bytes = data.to_bytes();
        let back = Snapshot::from_bytes(&bytes).expect("decodes");
        assert_eq!(back.name(), "grid");
        assert_eq!(back.axis(), Some(("time", "s")));
        for field in ["kv", "name", "point", "open", "vm"] {
            for id in ["a", "b", "c"] {
                assert_eq!(back.get("Bus", id, field, None), data.get("Bus", id, field, None), "{field} of {id}");
            }
        }
        assert_eq!(back.get("Bus", "a", "vm", 1.5), Some(Value::Number(f64::from(1.0_f32))));
        assert_eq!(back.get("Branch", 1_u64, "to", None), Some(Value::Row(Row::new("grid", "Bus", "c"))));
        assert_eq!(back.to_bytes(), bytes, "encoding is deterministic");
    }

    #[test]
    fn patches_round_trip() {
        let patch = Patch::new().remove("Bus", vec!["a"]).append("Bus", [3.0], [("vm", vec![1.0, 1.0, 1.0])]);
        let bytes = patch.to_bytes();
        assert_eq!(Patch::from_bytes(&bytes).expect("decodes").to_bytes(), bytes);
        assert!(Snapshot::from_bytes(&bytes).is_err());
    }

    /// Bytes handed over at most `n` a read, as a socket hands them.
    struct Trickle<'a>(&'a [u8], usize);

    impl Read for Trickle<'_> {
        fn read(&mut self, into: &mut [u8]) -> std::io::Result<usize> {
            let n = self.1.min(into.len()).min(self.0.len());
            into[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    #[test]
    fn patches_back_to_back_stream_one_by_one() {
        let patches = [grid().snapshot().to_patch(), Patch::new().forget(1.5), Patch::new().remove("Bus", vec!["a"])];
        let bytes: Vec<u8> = patches.iter().flat_map(Patch::to_bytes).collect();
        let read: Vec<Vec<u8>> = Patch::stream(Trickle(&bytes, 5), DecodeLimits::default())
            .map(|patch| patch.expect("valid").to_bytes())
            .collect();
        assert_eq!(read, patches.iter().map(Patch::to_bytes).collect::<Vec<_>>());
        let first = |bytes: &[u8], limits: DecodeLimits| Patch::stream(bytes, limits).next();
        assert!(first(&[], DecodeLimits::default()).is_none(), "no bytes, no patches");
        let foreign = first(b"LATX", DecodeLimits::default());
        assert!(foreign.is_some_and(|e| e.is_err_and(|e| e.to_string().contains("not latkit bytes"))), "at once");
        // A length past the limit fails as its header arrives rather than waiting for bytes that may
        // never come.
        let long = Patch::new().set(Table::new("Bus", Ids::count(1)).field("name", vec!["x".repeat(100)])).to_bytes();
        let short = DecodeLimits { frame_bytes: 64, ..DecodeLimits::default() };
        assert!(matches!(first(&long[..HEADER], short), Some(Err(Error::Limit(_)))));
        assert!(matches!(first(&long[..70], DecodeLimits::default()), Some(Err(Error::Invalid { .. }))), "truncated");
        let mut twice = Patch::stream(&long[..70], DecodeLimits::default());
        assert!(twice.next().is_some_and(|patch| patch.is_err()) && twice.next().is_none(), "ends at an error");
    }

    #[test]
    fn frames_keep_their_numbers_through_bytes_and_gathers() {
        let data = grid();
        data.apply(Patch::new().forget(1.5)).expect("forget");
        let first = |data: &Snapshot| match data.table("Bus").and_then(|t| t.field_named("vm")) {
            Some(Field::Sampled(samples, _)) => samples.start(),
            _ => panic!("sampled"),
        };
        assert_eq!(first(&data.snapshot()), 1);
        assert_eq!(first(&Snapshot::from_bytes(&data.snapshot().to_bytes()).expect("decodes")), 1);
        data.apply(Patch::new().remove("Bus", vec!["b"])).expect("remove");
        assert_eq!(first(&data.snapshot()), 1, "rows removed keep the frames' numbers");
    }

    #[test]
    fn time_tiles_round_trip_with_their_holes() {
        let data = grid();
        // The bucket of frames 64..72, and frames 200 and 201, past a hole.
        let bucket = Patch::new().frames("Bus", "vm", 1, 8, [64.0, 71.0], [0.9, 0.95, 0.97, 1.1, 1.05, 1.0]);
        let tile = bucket.frames("Bus", "vm", 0, 200, [200.0, 201.0], [1.0, 1.0, 1.0, 0.5, 0.5, 0.5]);
        let bytes = tile.to_bytes();
        assert_eq!(Patch::from_bytes(&bytes).expect("decodes").to_bytes(), bytes);
        data.apply(tile.clone()).expect("tiles");
        assert!(data.apply(tile).is_err(), "entries held already");
        let data = data.snapshot();
        let back = Snapshot::from_bytes(&data.to_bytes()).expect("decodes");
        assert_eq!(back.to_bytes(), data.to_bytes());
        assert_eq!(back.get("Bus", "c", "vm", 201.5), Some(Value::Number(0.5)));
        assert_eq!(back.get("Bus", "a", "vm", 100.0), None, "a hole holds no frame");
        assert_eq!(back.describe().span, Some([1.0, 201.0]));
    }

    #[test]
    fn malformed_bytes_are_invalid_not_panics() {
        let bytes = grid().snapshot().to_bytes();
        for end in 0..bytes.len() {
            assert!(Snapshot::from_bytes(&bytes[..end]).is_err());
        }
        let mut flipped = bytes.clone();
        for i in (0..flipped.len()).step_by(7) {
            flipped[i] ^= 0x5a;
            let _ = Snapshot::from_bytes(&flipped);
        }
    }
}
