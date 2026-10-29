//! The binary encoding shared by patches and datasets.
//!
//! A patch encodes as one frame. The frame holds a header (magic and total length), the name of the
//! dataset the patch changes (empty if it names none), and the patch's operations. Everything is
//! little endian. Because the header states the frame's length, back-to-back frames split without
//! decoding, and a reader knows as soon as the header arrives whether it has a whole frame. A
//! dataset encodes as the patch that builds it from an empty dataset.
//!
//! | Part         | Layout                                                                       |
//! | ------------ | ---------------------------------------------------------------------------- |
//! | frame        | `b"LATK"`, `u64` length of the whole frame, name, `u32` op count, ops        |
//! | op           | `u8` tag (0 axis, 1 replace, 2 set, 3 remove, 4 append, 5 forget, 6 frames), |
//! |              | then its payload                                                             |
//! | axis         | name, unit                                                                   |
//! | replace, set | table                                                                        |
//! | remove       | table name, ids                                                              |
//! | append       | table name, `u8` 1 and ids (or `u8` 0 for every row), `u32` frame count,     |
//! |              | `f64` coordinates, `u32` field count; per field: name, values frame-major    |
//! | forget       | `f64` before                                                                 |
//! | frames       | table name, field name, `u32` rows, run                                      |
//! | table        | name, ids, `u32` field count; per field: name, `u8` tag, payload             |
//! | field        | values; a reference's target table name and target ids as values; or samples |
//! | ids          | `u8` 0 and `u32` count, or `u8` 1 and values: `u64`, `u32` (read as `u64`),  |
//! |              | or text                                                                      |
//! | values       | `u8` storage, `u32` length, data, `u8` has-validity, validity words (`u64`)  |
//! | samples      | `u32` rows, `u64` first frame, `u64` frame count, `u8` highest level, `u32`  |
//! |              | run count, runs. Buckets whose eight entries one level below are all present |
//! |              | are omitted, since decoding derives them                                     |
//! | run          | `u8` level, `u64` first entry, `u32` entry count, `f64` coordinates (one per |
//! |              | frame; two per bucket, its first and last frame's), then `f32` values        |
//! |              | entry-major: for frames, one per row; for buckets, every bucket's least      |
//! |              | value per row, then every bucket's greatest. NaN is missing                  |
//! | `str`        | `u32` byte length, UTF-8                                                     |

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
use crate::wire::{In, Out};
use crate::{Error, Result};

const MAGIC: &[u8; 4] = b"LATK";
/// Header size in bytes: the magic and the frame's total length.
const HEADER: usize = 12;

/// Size limits for decoding one binary frame. Exceeding either is an
/// [`Error::Limit`](crate::Error::Limit).
///
/// The limits bound the encoded bytes and a conservative estimate of decoded storage. Memory used
/// afterwards, to apply the patch or keep the dataset, is not counted.
#[derive(Clone, Copy, Debug)]
pub struct DecodeLimits {
    /// The largest encoded frame, in bytes. Checked as soon as the header arrives. Defaults to
    /// 256 MiB.
    pub frame_bytes: usize,
    /// The budget, in bytes, for decoded vectors, names, operations, pages, and derived sample
    /// buckets. Defaults to 512 MiB.
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
    let mut w = Writer(Out::default());
    w.0.0.extend_from_slice(MAGIC);
    w.0.u64(0);
    w.0.str(patch.data.as_deref().unwrap_or(""));
    w.0.len(patch.ops.len());
    for op in &patch.ops {
        match op {
            Op::Axis { name, unit } => {
                w.0.u8(OP_AXIS);
                w.0.str(name);
                w.0.str(unit);
            }
            Op::Replace(table) => {
                w.0.u8(OP_REPLACE);
                w.table(table);
            }
            Op::Set(table) => {
                w.0.u8(OP_SET);
                w.table(table);
            }
            Op::Remove { table, ids } => {
                w.0.u8(OP_REMOVE);
                w.0.str(table);
                w.ids(ids);
            }
            Op::Append { table, at, ids, fields } => {
                w.0.u8(OP_APPEND);
                w.0.str(table);
                match ids {
                    Some(ids) => {
                        w.0.u8(1);
                        w.ids(ids);
                    }
                    None => w.0.u8(0),
                }
                w.0.len(at.len());
                w.0.pod(at);
                w.0.len(fields.len());
                for (name, values) in fields {
                    w.0.str(name);
                    w.values(values);
                }
            }
            Op::Forget { before } => {
                w.0.u8(OP_FORGET);
                w.0.f64(*before);
            }
            Op::Frames { table, field, run, at, values } => {
                w.0.u8(OP_FRAMES);
                w.0.str(table);
                w.0.str(field);
                let per_row = run.len() * samples::sides(run.level);
                w.0.len(values.len().checked_div(per_row).unwrap_or(0));
                w.run(run, at, values);
            }
        }
    }
    let mut bytes = w.0.0;
    let length = bytes.len() as u64;
    bytes[MAGIC.len()..HEADER].copy_from_slice(&length.to_le_bytes());
    bytes
}

/// Encodes `values` alone, in the format's `values` layout. Jobs use it to pass columns to and
/// from the host.
#[cfg(feature = "gpu")]
pub(crate) fn values_bytes(values: &Values) -> Vec<u8> {
    let mut w = Writer(Out::default());
    w.values(values);
    w.0.0
}

/// Decodes values written by [`values_bytes`]. Errors if `bytes` are malformed or extend past
/// the values.
#[cfg(feature = "gpu")]
pub(crate) fn read_values(bytes: &[u8]) -> Result<Values> {
    let mut r = Reader { input: In::new(bytes), remaining: DecodeLimits::default().decoded_bytes };
    let values = r.values()?;
    if !r.input.is_empty() {
        return Err(malformed("trailing bytes"));
    }
    Ok(values)
}

/// Decodes one frame that fills `bytes` exactly, with default limits. Errors if `bytes` are
/// malformed, truncated, or extend past the frame.
pub(crate) fn decode(bytes: &[u8]) -> Result<Patch> {
    match frame(bytes, DecodeLimits::default())? {
        Some((patch, used)) if used == bytes.len() => Ok(patch),
        Some(_) => Err(malformed("trailing bytes")),
        None => Err(malformed("truncated")),
    }
}

/// Decodes back-to-back frames from `read`, yielding each patch once its frame has fully arrived.
/// Each header is checked against `limits` as it arrives and gives the number of bytes to read.
/// The iterator ends when the input ends between frames, or after the first error.
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

/// Reads the next frame from `read`. Returns `None` if the input ends between frames. An end
/// inside a frame is a truncation error.
fn next(read: &mut impl Read, limits: DecodeLimits) -> Result<Option<Patch>> {
    let failed = |error: std::io::Error| match error.kind() {
        std::io::ErrorKind::UnexpectedEof => malformed("truncated"),
        _ => Error::Io(error.to_string().into()),
    };
    let mut bytes = vec![0; HEADER];
    let mut held = 0;
    // Check the header as its bytes arrive, so input that is not latkit's fails immediately.
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

/// The total length of the frame starting at `bytes`, read from its header. Validates the part
/// of the magic that has arrived, so foreign input fails early. Returns `None` until the whole
/// header is present. Errors if the length exceeds `limit` or is shorter than the header.
fn length(bytes: &[u8], limit: usize) -> Result<Option<usize>> {
    let held = bytes.len().min(MAGIC.len());
    if bytes[..held] != MAGIC[..held] {
        return Err(malformed("not latkit bytes"));
    }
    let Some(length) = bytes.get(MAGIC.len()..HEADER) else { return Ok(None) };
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

/// Decodes the frame starting at `bytes`, returning its patch and length. Returns `None` while
/// `bytes` holds only part of the frame.
fn frame(bytes: &[u8], limits: DecodeLimits) -> Result<Option<(Patch, usize)>> {
    let Some(length) = length(bytes, limits.frame_bytes)? else { return Ok(None) };
    let Some(frame) = bytes.get(HEADER..length) else { return Ok(None) };
    let mut r = Reader { input: In::new(frame), remaining: limits.decoded_bytes };
    let patch = r.patch()?;
    if !r.input.is_empty() {
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
                        _ => return Err(malformed("an append's ids flag is neither 0 nor 1")),
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

/// Writes the format's parts.
struct Writer(Out);

impl Writer {
    fn table(&mut self, table: &Table) {
        self.0.str(&table.name);
        match &table.ids {
            RowIds::Count(n) => {
                self.0.u8(0);
                self.0.u32(*n);
            }
            RowIds::Listed(column) => {
                self.0.u8(1);
                self.values(&column.values());
            }
        }
        self.0.len(table.fields.len());
        for (name, field) in &table.fields {
            self.0.str(name);
            match field {
                Field::Values(column, _) => {
                    self.0.u8(FIELD_VALUES);
                    self.column(column);
                }
                Field::Reference(reference) => {
                    self.0.u8(FIELD_REFERENCE);
                    self.0.str(&reference.to);
                    self.column(&reference.ids);
                }
                Field::Sampled(samples, _) => {
                    self.0.u8(FIELD_SAMPLED);
                    self.0.len(table.len());
                    self.0.u64(samples.start());
                    self.0.u64(samples.end() - samples.start());
                    self.0.u8(samples.levels() as u8);
                    let runs = samples.stored_runs();
                    self.0.len(runs.len());
                    let rows: Vec<usize> = (0..table.len()).collect();
                    for run in &runs {
                        let (at, values) = samples.read(run, &rows);
                        self.run(run, &at, &values);
                    }
                }
            }
        }
    }

    /// Writes `run`: its level, first entry, and entry count, then its coordinates `at` and its
    /// `values`.
    fn run(&mut self, run: &Run, at: &[f64], values: &[f32]) {
        self.0.u8(run.level as u8);
        self.0.u64(run.entries.start);
        self.0.len(run.len());
        self.0.pod(at);
        self.0.pod(values);
    }

    fn ids(&mut self, ids: &Ids) {
        match &ids.0 {
            IdList::Count(n) => {
                self.0.u8(0);
                self.0.u32(*n);
            }
            IdList::Listed(values) => {
                self.0.u8(1);
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
                self.0.u8(STORE_BOOL);
                self.0.len(len);
                self.0.pod(&bits.to_words());
            }
            Array::Text(text) => {
                self.0.u8(STORE_TEXT);
                self.0.len(len);
                let (offsets, bytes) = text.compact();
                self.0.pod(&offsets);
                self.0.str(bytes);
            }
            Array::Geometry(geometry) => {
                self.0.u8(STORE_GEOMETRY);
                self.0.len(len);
                self.0.u8(geometry.depth());
                let (levels, coords) = geometry.compact();
                for level in &levels {
                    self.0.len(level.len());
                    self.0.pod(level);
                }
                self.0.len(coords.len());
                self.0.pod(&coords);
            }
        }
        match &values.valid {
            Some(bits) => {
                self.0.u8(1);
                self.0.pod(&bits.to_words());
            }
            None => self.0.u8(0),
        }
    }

    fn numbers<T: bytemuck::Pod>(&mut self, store: u8, values: &[T]) {
        self.0.u8(store);
        self.0.len(values.len());
        self.0.pod(values);
    }
}

/// Decodes one frame whose bytes are all present. `remaining` is the decoded-storage budget left.
struct Reader<'a> {
    input: In<'a>,
    remaining: usize,
}

fn truncated() -> Error {
    malformed("truncated")
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

    fn take(&mut self, n: usize) -> Result<&[u8]> {
        self.input.bytes(n).ok_or_else(truncated)
    }

    fn u8(&mut self) -> Result<u8> {
        self.input.u8().ok_or_else(truncated)
    }

    fn u32(&mut self) -> Result<u32> {
        self.input.u32().ok_or_else(truncated)
    }

    /// Reads a `u32` count of items of at least `size` bytes each. Errors if the remaining bytes
    /// cannot hold that many, so a corrupt count cannot cause a huge allocation.
    fn len(&mut self, size: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        if !self.input.has(n.saturating_mul(size)) {
            return Err(truncated());
        }
        Ok(n)
    }

    fn u64(&mut self) -> Result<u64> {
        self.input.u64().ok_or_else(truncated)
    }

    fn f64(&mut self) -> Result<f64> {
        self.input.f64().ok_or_else(truncated)
    }

    fn name(&mut self) -> Result<Name> {
        let n = self.len(1)?;
        self.charge(n, 1)?;
        self.charge(1, size_of::<Name>())?;
        let bytes = self.take(n)?;
        std::str::from_utf8(bytes).map(Name::from).map_err(|_| malformed("text is not UTF-8"))
    }

    /// Reads `n` plain values by copying their bytes.
    fn vec<T: bytemuck::Pod>(&mut self, n: usize) -> Result<Vec<T>> {
        // Charge four times the raw size, to cover conversion into column pages and the sample
        // levels derived from runs.
        self.charge(n, 4 * size_of::<T>())?;
        if n.checked_mul(size_of::<T>()).is_none() {
            return Err(malformed("too large"));
        }
        self.input.pod(n).ok_or_else(truncated)
    }

    fn ids(&mut self) -> Result<Ids> {
        match self.u8()? {
            0 => Ok(Ids(IdList::Count(self.u32()?))),
            1 => Ok(Ids(IdList::Listed(self.id_values()?))),
            tag => Err(malformed(format!("unknown ids encoding {tag}"))),
        }
    }

    fn column(&mut self) -> Result<Column> {
        Ok(Column::new(&self.values()?))
    }

    /// Reads ids as values. `u32` ids, sent by writers without 64-bit integers, are widened to
    /// `u64`, which stores every numeric id.
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
                tag => return Err(malformed(format!("unknown field kind {tag}"))),
            };
            table.insert(name, field);
        }
        Ok(table)
    }

    /// Reads a sampled field. Runs are inserted level by level. Before each level's own runs, the
    /// buckets derivable from the level below are rebuilt.
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

    /// Reads a run of entries for `rows` rows: the run, its coordinates, and its values.
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
                Array::Text(Text::from_parts(offsets, bytes).ok_or_else(|| malformed("invalid text offsets"))?)
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
                    Geometry::from_parts(depth, levels, coords).ok_or_else(|| malformed("invalid geometry offsets"))?;
                if geometry.len() != len {
                    return Err(malformed("geometry count does not match the value count"));
                }
                Array::Geometry(geometry)
            }
            store => return Err(malformed(format!("unknown storage {store}"))),
        };
        let valid = match self.u8()? {
            0 => None,
            1 => Some(Bits::from_words(self.vec(len.div_ceil(64))?, len)),
            _ => return Err(malformed("the validity flag is neither 0 nor 1")),
        };
        Ok(Values { array, valid })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Data, Row, Snapshot, Value};

    #[test]
    fn the_patch_fixture_and_large_indexes_are_stable() {
        let hex = include_str!("../../tests/fixtures/patch.hex").trim();
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

    /// A reader that returns at most `n` bytes per read, like a socket.
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
    fn back_to_back_patches_stream_individually() {
        let patches = [grid().snapshot().to_patch(), Patch::new().forget(1.5), Patch::new().remove("Bus", vec!["a"])];
        let bytes: Vec<u8> = patches.iter().flat_map(Patch::to_bytes).collect();
        let read: Vec<Vec<u8>> = Patch::stream(Trickle(&bytes, 5), DecodeLimits::default())
            .map(|patch| patch.expect("valid").to_bytes())
            .collect();
        assert_eq!(read, patches.iter().map(Patch::to_bytes).collect::<Vec<_>>());
        let first = |bytes: &[u8], limits: DecodeLimits| Patch::stream(bytes, limits).next();
        assert!(first(&[], DecodeLimits::default()).is_none(), "empty input yields no patch");
        let foreign = first(b"LATX", DecodeLimits::default());
        assert!(foreign.is_some_and(|e| e.is_err_and(|e| e.to_string().contains("not latkit bytes"))), "immediately");
        // A length over the limit fails as soon as the header arrives, without waiting for bytes
        // that may never come.
        let long = Patch::new().set(Table::new("Bus", Ids::count(1)).field("name", vec!["x".repeat(100)])).to_bytes();
        let short = DecodeLimits { frame_bytes: 64, ..DecodeLimits::default() };
        assert!(matches!(first(&long[..HEADER], short), Some(Err(Error::Limit(_)))));
        assert!(matches!(first(&long[..70], DecodeLimits::default()), Some(Err(Error::Invalid { .. }))), "truncated");
        let mut twice = Patch::stream(&long[..70], DecodeLimits::default());
        assert!(twice.next().is_some_and(|patch| patch.is_err()) && twice.next().is_none(), "ends after an error");
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
        assert_eq!(first(&data.snapshot()), 1, "removing rows keeps frame numbers");
    }

    #[test]
    fn time_tiles_round_trip_with_gaps() {
        let data = grid();
        // The level-1 bucket of frames 64..72, then frames 200 and 201 after a gap.
        let bucket = Patch::new().frames("Bus", "vm", 1, 8, [64.0, 71.0], [0.9, 0.95, 0.97, 1.1, 1.05, 1.0]);
        let tile = bucket.frames("Bus", "vm", 0, 200, [200.0, 201.0], [1.0, 1.0, 1.0, 0.5, 0.5, 0.5]);
        let bytes = tile.to_bytes();
        assert_eq!(Patch::from_bytes(&bytes).expect("decodes").to_bytes(), bytes);
        data.apply(tile.clone()).expect("tiles");
        let middle = Patch::new().frames("Bus", "vm", 0, 200, [200.0], [1.0, 1.0, 1.0]);
        assert!(data.apply(middle).is_err(), "entries before a level's last are refused");
        data.apply(tile).expect("a level's last entries are written again");
        let data = data.snapshot();
        let back = Snapshot::from_bytes(&data.to_bytes()).expect("decodes");
        assert_eq!(back.to_bytes(), data.to_bytes());
        assert_eq!(back.get("Bus", "c", "vm", 201.5), Some(Value::Number(0.5)));
        assert_eq!(back.get("Bus", "a", "vm", 100.0), None, "a gap reads as missing");
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
