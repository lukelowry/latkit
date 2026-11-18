//! Time tiles: a dataset written as files, from which a view fetches the history of sampled fields
//! in spans, on demand. A span at level `k` holds `chunk` entries of that level. The entries are
//! frames at level 0 and buckets of `8^k` frames above it. One span covers the same frames as eight
//! spans of the level below, as one map tile covers four tiles one zoom level in. While a span
//! loads, the view draws the nearest coarser span that has arrived.
//!
//! | File          | Contents                                                                     |
//! | ------------- | ---------------------------------------------------------------------------- |
//! | `frames.json` | the manifest: `data`, `chunk`, `url`, and `frames`, which lists each sampled |
//! |               | field's `table`, `field`, `levels` (highest level stored), and `frames`      |
//! |               | (`[first, end]`)                                                             |
//! | `base.latk`   | the dataset with each sampled field's frame range but none of its entries    |
//! | spans         | at `url`, with `{field}` the field's index in `frames`: a patch with one     |
//! |               | `frames` change per run of the span's entries                                |

use std::ops::Range;

use super::name::Name;
use super::patch::{Op, Patch};
use super::samples::{LEVELS, Run, Samples};
use super::snapshot::Snapshot;
use super::table::Field;
use crate::{Error, Result};

/// The manifest's file name.
pub(crate) const MANIFEST: &str = "frames.json";
/// The file name of the dataset without its sampled fields' entries.
const BASE: &str = "base.latk";
/// The path template of each span, relative to the manifest.
const URL: &str = "{field}/{level}/{index}.latk";

/// A sampled field listed in a manifest: its table and name, its highest stored level, and the
/// frames it covers, written `[first, end]`.
#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct Listed {
    pub(crate) table: Name,
    pub(crate) field: Name,
    pub(crate) levels: u32,
    #[serde(with = "range")]
    pub(crate) frames: Range<u64>,
}

/// The contents of `frames.json`: the path of the base dataset (`data`), the entries per span
/// (`chunk`), the span path template (`url`), and the listed fields.
#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct Manifest {
    pub(crate) data: String,
    pub(crate) chunk: u32,
    pub(crate) url: String,
    #[serde(rename = "frames")]
    pub(crate) fields: Vec<Listed>,
}

/// Serializes frames `first..end` as `[first, end]`.
mod range {
    use std::ops::Range;

    use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

    pub(super) fn serialize<S: Serializer>(frames: &Range<u64>, s: S) -> Result<S::Ok, S::Error> {
        [frames.start, frames.end].serialize(s)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Range<u64>, D::Error> {
        match <[u64; 2]>::deserialize(d)? {
            [first, end] if first <= end => Ok(first..end),
            _ => Err(de::Error::custom("frames must be [first, end] with first at most end")),
        }
    }
}

impl Manifest {
    /// Parses a manifest. Returns `None` when `bytes` are not a JSON object with a `frames` list,
    /// so other tile formats can be tried. Returns an error when they are such an object but it is
    /// invalid.
    pub(crate) fn from_bytes(bytes: &[u8]) -> Option<Result<Manifest>> {
        /// The key every manifest has, used to recognize one.
        #[derive(serde::Deserialize)]
        struct Listing {
            #[serde(rename = "frames")]
            _frames: Vec<serde::de::IgnoredAny>,
        }
        crate::json::from_bytes::<Listing>(bytes).ok()?;
        let manifest = crate::json::from_bytes::<Manifest>(bytes).and_then(|m| {
            if !chunks(m.chunk) {
                return Err(Error::invalid("a span must hold a multiple of 8 entries, from 8 to 2^20").at("chunk"));
            }
            // Without these, different spans would share a URL, and draw each other's entries.
            let names = |part: &str| m.url.contains(part);
            if !(names("{level}") && names("{index}")) || (m.fields.len() > 1 && !names("{field}")) {
                return Err(Error::invalid(
                    "the span template must name {level} and {index}, and {field} when several fields are listed",
                )
                .at("url"));
            }
            for (i, field) in m.fields.iter().enumerate() {
                if field.levels > super::samples::MAX_LEVEL {
                    return Err(Error::invalid("sample levels must be from 0 to 21").at("levels").at(i).at("frames"));
                }
            }
            Ok(m)
        });
        Some(manifest.map_err(|e| e.at(MANIFEST)))
    }

    /// The path of span `index` at `level` of the field at index `field` in the manifest, from
    /// template `url`.
    pub(crate) fn span(url: &str, field: usize, level: u32, index: u64) -> String {
        url.replace("{field}", &field.to_string())
            .replace("{level}", &level.to_string())
            .replace("{index}", &index.to_string())
    }
}

/// Whether `chunk` is a valid number of entries per span. It must be from 8 to 2^20 and a multiple
/// of 8, so a bucket one level up never straddles two spans.
fn chunks(chunk: u32) -> bool {
    (8..=1 << 20).contains(&chunk) && chunk.is_multiple_of(8)
}

impl Snapshot {
    /// Writes the dataset as time tiles, passing each file's path and bytes to `write`:
    ///
    /// - `frames.json`, the manifest.
    /// - `base.latk`, the dataset with each sampled field's frame range but none of its entries.
    /// - `{field}/{level}/{index}.latk`, a patch for each span of `chunk` entries, for every level
    ///   of every sampled field that has entries there.
    ///
    /// A view given the manifest as [`Tiles`](crate::Tiles) fetches the spans its lines draw, at
    /// the level of detail the plot window needs. It also fetches the frames around the coordinate
    /// it shows. Until a span arrives, the view draws the coarser span above it.
    ///
    /// The manifest is written last, so a reader that finds it finds every file it names. Returns
    /// an error if
    /// `chunk` is not a multiple of 8 from 8 to 2^20, or if `write` fails.
    pub fn to_tiles(&self, chunk: u32, mut write: impl FnMut(&str, &[u8]) -> Result<()>) -> Result<()> {
        if !chunks(chunk) {
            return Err(Error::invalid("a span must hold a multiple of 8 entries, from 8 to 2^20").at("chunk"));
        }
        let entries_per_span = u64::from(chunk);
        let mut base = self.clone();
        let mut fields = Vec::new();
        for table in self.tables() {
            let rows: Vec<usize> = (0..table.len()).collect();
            for (name, field) in &table.fields {
                let Field::Sampled(samples, _) = field else { continue };
                let place = fields.len();
                fields.push(Listed {
                    table: table.name.clone(),
                    field: name.clone(),
                    levels: samples.levels(),
                    frames: samples.start()..samples.end(),
                });
                // Runs come level by level in entry order, so a span is complete once the next one
                // begins.
                let mut span: Option<((u32, u64), Patch)> = None;
                for run in samples.runs() {
                    for index in run.entries.start / entries_per_span..run.entries.end.div_ceil(entries_per_span) {
                        let entries = run.entries.start.max(index * entries_per_span)
                            ..run.entries.end.min((index + 1).saturating_mul(entries_per_span));
                        let part = Run { level: run.level, entries };
                        let (at, values) = samples.read(&part, &rows);
                        let op =
                            Op::frames(table.name.clone(), name.clone(), part.level, part.entries.start, at, values);
                        if span.as_ref().is_some_and(|(key, _)| *key != (part.level, index))
                            && let Some(((level, index), tile)) = span.take()
                        {
                            write(&Manifest::span(URL, place, level, index), &tile.to_bytes())?;
                        }
                        span.get_or_insert_with(|| ((part.level, index), Patch::to(self.name().clone())))
                            .1
                            .ops
                            .push(op);
                    }
                }
                if let Some(((level, index), tile)) = span {
                    write(&Manifest::span(URL, place, level, index), &tile.to_bytes())?;
                }
            }
        }
        write_index(&mut base, chunk, fields, &mut write)
    }
}

/// Writes `base` with each of `fields` holding its frame range but no entries, then the manifest
/// listing them in spans of `chunk` entries. The manifest comes last, so a reader that finds it
/// finds every file it names.
fn write_index(
    base: &mut Snapshot,
    chunk: u32,
    fields: Vec<Listed>,
    write: &mut impl FnMut(&str, &[u8]) -> Result<()>,
) -> Result<()> {
    for listed in &fields {
        base.sampled(&listed.table, &listed.field, |samples| {
            *samples = Samples::over(listed.frames.clone());
            true
        });
    }
    write(BASE, &base.to_bytes())?;
    let manifest = Manifest { data: BASE.to_owned(), chunk, url: URL.to_owned(), fields };
    write(MANIFEST, serde_json::to_string_pretty(&manifest).expect("JSON").as_bytes())
}

/// Writes a history as time tiles while it is recorded: the files [`Snapshot::to_tiles`] writes
/// for the same frames. It holds only what is still to be written, each level's span and bucket in
/// progress, so its memory stays the same however long the history grows.
///
/// It applies patches of [`append`](Patch::append)s of every row to the tables of its base, as a
/// [`Data`](crate::Data) would. Levels of detail are built as appends build them. A span is written
/// once it fills. [`flush`](TileWriter::flush) writes the spans in progress as they stand, then the
/// base and the manifest, so a view drawing the manifest as [`Tiles`](crate::Tiles) finds every
/// frame appended so far.
///
/// ```
/// use latkit::{Data, Ids, Patch, Table, TileWriter};
/// let grid = Data::new("grid");
/// grid.apply(Patch::new().axis("time", "s").replace(Table::new("Bus", Ids::count(2))))?;
/// let mut writer = TileWriter::new(grid.snapshot(), 256)?;
/// let mut files = std::collections::BTreeMap::new();
/// let mut write = |path: &str, bytes: &[u8]| {
///     files.insert(path.to_owned(), bytes.to_vec());
///     Ok::<(), latkit::Error>(())
/// };
/// writer.apply(Patch::new().append("Bus", [0.0, 0.5], [("vm", vec![1.0, 0.9, 1.01, 0.98])]), &mut write)?;
/// writer.flush(&mut write)?;
/// assert!(files.contains_key("frames.json"));
/// # Ok::<(), latkit::Error>(())
/// ```
pub struct TileWriter {
    base: Snapshot,
    chunk: u32,
    fields: Vec<Streamed>,
}

/// A sampled field as it streams: how the manifest lists it, its rows, the coordinate of its last
/// frame, and each level from frames up.
struct Streamed {
    listed: Listed,
    rows: usize,
    last: Option<f64>,
    levels: Vec<Level>,
}

/// One level of detail as it streams.
#[derive(Default)]
struct Level {
    /// Above frames, the bucket in progress: the entries one level below folded into it, its first
    /// and last coordinates, and each row's least and greatest value.
    folded: u32,
    first: f64,
    last: f64,
    low: Vec<f32>,
    high: Vec<f32>,
    /// The span in progress: its first entry, its entries' coordinates, and their values, the
    /// least of each before the greatest above frames.
    start: u64,
    at: Vec<f64>,
    values: [Vec<f32>; 2],
}

impl TileWriter {
    /// A writer of the frames appended to the tables of `base`, in spans of `chunk` entries. Fails
    /// unless `chunk` is a multiple of 8 from 8 to 2^20.
    pub fn new(base: Snapshot, chunk: u32) -> Result<TileWriter> {
        if !chunks(chunk) {
            return Err(Error::invalid("a span must hold a multiple of 8 entries, from 8 to 2^20").at("chunk"));
        }
        Ok(TileWriter { base, chunk, fields: Vec::new() })
    }

    /// Appends the frames of `patch`, passing each span they fill to `write` with its path. Fails,
    /// changing nothing, unless every operation appends frames to every row of a table of the base,
    /// at finite coordinates that do not decrease.
    pub fn apply(&mut self, patch: Patch, mut write: impl FnMut(&str, &[u8]) -> Result<()>) -> Result<()> {
        if patch.data.as_ref().is_some_and(|data| data != self.base.name()) {
            return Err(Error::invalid(format!("the patch is for another dataset than {}", self.base.name())));
        }
        // Check every append first, so a patch that fails changes nothing.
        let mut lasts: Vec<((Name, Name), Option<f64>)> = Vec::new();
        let mut appends = Vec::with_capacity(patch.ops.len());
        for op in patch.ops {
            let Op::Append { table, at, ids: None, fields } = op else {
                return Err(Error::invalid("a tile writer takes appends of every row, and its base holds the rest"));
            };
            let held = self.base.table(&table).ok_or_else(|| Error::invalid("no such table").at(&table))?;
            let rows = held.len();
            for (name, values) in &fields {
                if held.field_named(name).is_some_and(|field| !matches!(field, Field::Sampled(..))) {
                    return Err(Error::invalid("not a sampled field").at(name).at(&table));
                }
                if at.len().checked_mul(rows) != Some(values.len()) {
                    let counts = format!("{} values for {} frames of {rows} rows", values.len(), at.len());
                    return Err(Error::invalid(counts).at(name).at(&table));
                }
                let key = (table.clone(), name.clone());
                let i = lasts.iter().position(|(k, _)| *k == key).unwrap_or_else(|| {
                    lasts.push((key, self.streamed(&table, name).and_then(|s| s.last)));
                    lasts.len() - 1
                });
                for &t in &at {
                    if !t.is_finite() || lasts[i].1.is_some_and(|last| t < last) {
                        let why = "a frame's coordinate must be finite and not below the last one";
                        return Err(Error::invalid(why).at(name).at(&table));
                    }
                    lasts[i].1 = Some(t);
                }
            }
            appends.push((table, rows, at, fields));
        }
        for (table, rows, at, fields) in appends {
            for (name, values) in fields {
                let place = self.place(&table, &name, rows);
                let streamed = &mut self.fields[place];
                let mut frame = vec![0.0_f32; rows];
                for (f, &t) in at.iter().enumerate() {
                    for (row, value) in frame.iter_mut().enumerate() {
                        let i = f * rows + row;
                        *value = if values.is_valid(i) { values.number(i) as f32 } else { f32::NAN };
                    }
                    streamed.add(t, &frame, place, u64::from(self.chunk), &self.base, &mut write)?;
                }
            }
        }
        Ok(())
    }

    /// Writes the spans in progress as they stand, then the base and the manifest, so a reader
    /// finds every frame appended so far. A span written again as it grows replaces the one
    /// before.
    pub fn flush(&mut self, mut write: impl FnMut(&str, &[u8]) -> Result<()>) -> Result<()> {
        for (place, streamed) in self.fields.iter().enumerate() {
            for (level, open) in streamed.levels.iter().enumerate() {
                if !open.at.is_empty() {
                    streamed.write(level as u32, open, place, u64::from(self.chunk), &self.base, &mut write)?;
                }
            }
        }
        let fields = self.fields.iter().map(|streamed| streamed.listed.clone()).collect();
        write_index(&mut self.base.clone(), self.chunk, fields, &mut write)
    }

    /// Field `field` of `table` as it streams, if frames were appended to it.
    fn streamed(&self, table: &Name, field: &Name) -> Option<&Streamed> {
        self.fields.iter().find(|s| s.listed.table == *table && s.listed.field == *field)
    }

    /// The index in the manifest of field `field` of `table`, with `rows` rows, listing it if new.
    fn place(&mut self, table: &Name, field: &Name, rows: usize) -> usize {
        if let Some(place) = self.fields.iter().position(|s| s.listed.table == *table && s.listed.field == *field) {
            return place;
        }
        let listed = Listed { table: table.clone(), field: field.clone(), levels: 0, frames: 0..0 };
        self.fields.push(Streamed { listed, rows, last: None, levels: Vec::new() });
        self.fields.len() - 1
    }
}

impl Streamed {
    /// Adds the next frame, at coordinate `at` with one value per row, then folds it into the
    /// buckets above, as appending a frame seals the buckets it completes.
    fn add(
        &mut self,
        at: f64,
        values: &[f32],
        place: usize,
        chunk: u64,
        base: &Snapshot,
        write: &mut impl FnMut(&str, &[u8]) -> Result<()>,
    ) -> Result<()> {
        let mut index = self.listed.frames.end;
        self.listed.frames.end += 1;
        self.last = Some(at);
        self.put(0, index, &[at], values, values, place, chunk, base, write)?;
        let (mut first, mut last, mut low, mut high) = (at, at, values.to_vec(), values.to_vec());
        for level in 1..=LEVELS as usize {
            if self.levels.len() <= level {
                self.levels.resize_with(level + 1, Level::default);
            }
            let bucket = &mut self.levels[level];
            if bucket.folded == 0 {
                (bucket.first, bucket.low, bucket.high) = (first, vec![f32::NAN; self.rows], vec![f32::NAN; self.rows]);
            }
            bucket.last = last;
            // `min` and `max` skip a missing value, as sealing does.
            bucket.low.iter_mut().zip(&low).for_each(|(out, &v)| *out = out.min(v));
            bucket.high.iter_mut().zip(&high).for_each(|(out, &v)| *out = out.max(v));
            bucket.folded += 1;
            if bucket.folded < 8 {
                break;
            }
            bucket.folded = 0;
            (first, last) = (bucket.first, bucket.last);
            low = std::mem::take(&mut bucket.low);
            high = std::mem::take(&mut bucket.high);
            index /= 8;
            self.put(level as u32, index, &[first, last], &low, &high, place, chunk, base, write)?;
        }
        Ok(())
    }

    /// Adds entry `index` of `level` to that level's span in progress, and writes the span once
    /// it fills.
    #[allow(clippy::too_many_arguments, reason = "one entry, and where its span goes")]
    fn put(
        &mut self,
        level: u32,
        index: u64,
        at: &[f64],
        low: &[f32],
        high: &[f32],
        place: usize,
        chunk: u64,
        base: &Snapshot,
        write: &mut impl FnMut(&str, &[u8]) -> Result<()>,
    ) -> Result<()> {
        if self.levels.len() <= level as usize {
            self.levels.resize_with(level as usize + 1, Level::default);
        }
        self.listed.levels = self.listed.levels.max(level);
        let open = &mut self.levels[level as usize];
        if open.at.is_empty() {
            open.start = index;
        }
        open.at.extend_from_slice(at);
        open.values[0].extend_from_slice(low);
        if level > 0 {
            open.values[1].extend_from_slice(high);
        }
        if (index + 1).is_multiple_of(chunk) {
            self.write(level, &self.levels[level as usize], place, chunk, base, write)?;
            let open = &mut self.levels[level as usize];
            open.at.clear();
            open.values.iter_mut().for_each(Vec::clear);
        }
        Ok(())
    }

    /// Writes `open`, the span of `level` in progress, as the patch its tile holds.
    fn write(
        &self,
        level: u32,
        open: &Level,
        place: usize,
        chunk: u64,
        base: &Snapshot,
        write: &mut impl FnMut(&str, &[u8]) -> Result<()>,
    ) -> Result<()> {
        let values = [open.values[0].as_slice(), open.values[1].as_slice()].concat();
        let op = Op::frames(
            self.listed.table.clone(),
            self.listed.field.clone(),
            level,
            open.start,
            open.at.clone(),
            values,
        );
        let mut tile = Patch::to(base.name().clone());
        tile.ops.push(op);
        write(&Manifest::span(URL, place, level, open.start / chunk), &tile.to_bytes())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{Data, Ids, Table};

    #[test]
    fn a_history_writes_as_spans_listed_in_a_manifest() {
        let grid = Data::new("grid");
        grid.apply(
            Patch::new().axis("time", "s").replace(Table::new("Bus", Ids::count(2)).field("kv", vec![1.0, 2.0])),
        )
        .expect("rows");
        let at: Vec<f64> = (0..100).map(f64::from).collect();
        let values: Vec<f64> = (0..200).map(|v| f64::from(v % 7)).collect();
        grid.apply(Patch::new().append("Bus", &at, [("vm", values)])).expect("frames");
        let data = grid.snapshot();
        let mut files = BTreeMap::new();
        data.to_tiles(16, |path, bytes| {
            files.insert(path.to_owned(), bytes.to_vec());
            Ok(())
        })
        .expect("tiles");
        let manifest = Manifest::from_bytes(&files[MANIFEST]).expect("a manifest").expect("valid");
        assert_eq!(manifest.fields, [Listed { table: "Bus".into(), field: "vm".into(), levels: 2, frames: 0..100 }]);
        // 100 frames: 7 spans of 16 at level 0, 12 buckets of 8 in 1 span at level 1, and 1 bucket
        // of 64 at level 2.
        let spans: Vec<&str> = files
            .keys()
            .map(String::as_str)
            .filter(|p| std::path::Path::new(p).extension().is_some_and(|e| e == "latk") && *p != BASE)
            .collect();
        assert_eq!(spans.len(), 7 + 1 + 1);
        let back = Data::from(Snapshot::from_bytes(&files[BASE]).expect("the base"));
        assert_eq!(back.snapshot().describe().span, None, "the base holds no entries");
        for path in &spans {
            back.apply(Patch::from_bytes(&files[*path]).expect("a span")).expect("each span applies once");
        }
        assert_eq!(back.snapshot().to_bytes(), data.to_bytes(), "applying every span rebuilds the history");
        assert!(Manifest::from_bytes(br#"{"tiles": []}"#).is_none(), "TileJSON is not a manifest");
        let backwards =
            br#"{"data": "b", "chunk": 16, "url": "u", "frames": [{"table": "t", "field": "f", "levels": 0, "frames": [3, 1]}]}"#;
        let error = Manifest::from_bytes(backwards).expect("a manifest").unwrap_err();
        assert!(error.to_string().starts_with("frames.json.frames[0].frames"), "{error}");
        let listing = |url: &str, fields: usize| {
            let field = r#"{"table": "t", "field": "f", "levels": 0, "frames": [0, 8]}"#;
            let fields = vec![field; fields].join(", ");
            format!(r#"{{"data": "b", "chunk": 16, "url": "{url}", "frames": [{fields}]}}"#)
        };
        let template =
            |url: &str, fields: usize| Manifest::from_bytes(listing(url, fields).as_bytes()).expect("a manifest");
        assert!(template("{level}/{index}.latk", 1).is_ok(), "one field needs no {{field}}");
        let error = template("{field}/{index}.latk", 1).unwrap_err();
        assert!(error.to_string().starts_with("frames.json.url"), "{error}");
        assert!(template("{level}/{index}.latk", 2).is_err(), "two fields need {{field}}");
        assert!(data.to_tiles(12, |_, _| Ok(())).is_err());
    }

    #[test]
    fn a_writer_streams_the_tiles_a_snapshot_writes() {
        let grid = Data::new("grid");
        let rows = Table::new("Bus", Ids::count(2)).field("kv", vec![1.0, 2.0]);
        grid.apply(Patch::new().axis("time", "s").replace(rows)).expect("rows");
        let mut writer = TileWriter::new(grid.snapshot(), 16).expect("a chunk of 16");
        let mut streamed = BTreeMap::new();
        // 100 frames in uneven batches, as a recording arrives.
        for frames in [0..1, 1..37, 37..100] {
            let at: Vec<f64> = frames.clone().map(f64::from).collect();
            let values: Vec<f64> = frames.flat_map(|f| [f64::from(f % 7), f64::from(f % 5)]).collect();
            grid.apply(Patch::new().append("Bus", &at, [("vm", values.clone())])).expect("frames");
            let patch = Patch::new().append("Bus", &at, [("vm", values)]);
            writer
                .apply(patch, |path, bytes| {
                    streamed.insert(path.to_owned(), bytes.to_vec());
                    Ok(())
                })
                .expect("spans");
        }
        writer
            .flush(|path, bytes| {
                streamed.insert(path.to_owned(), bytes.to_vec());
                Ok(())
            })
            .expect("the spans in progress");
        let mut whole = BTreeMap::new();
        grid.snapshot()
            .to_tiles(16, |path, bytes| {
                whole.insert(path.to_owned(), bytes.to_vec());
                Ok(())
            })
            .expect("tiles");
        assert_eq!(streamed, whole, "the same files, byte for byte");
        let back = Patch::new().append("Bus", [50.0], [("vm", vec![1.0, 1.0])]);
        assert!(writer.apply(back, |_, _| Ok(())).is_err(), "a coordinate below the last");
    }
}
