//! Time tiles: a dataset written as files from which a view fetches its sampled fields' histories
//! in spans, on demand. A span of level `k` holds `chunk` entries of that level: frames at level 0,
//! buckets of `8^k` frames above. One span covers the same frames as eight spans of the level
//! below, as one map tile covers four tiles one zoom level in. While a span loads, the view draws
//! the nearest coarser span that has arrived.
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
use super::samples::Run;
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
    /// so other tile formats can be tried, and an error when they are one but invalid.
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

/// Whether `chunk` is a valid number of entries per span: from 8 to 2^20 and a multiple of 8, so a
/// bucket one level up never straddles two spans.
fn chunks(chunk: u32) -> bool {
    (8..=1 << 20).contains(&chunk) && chunk.is_multiple_of(8)
}

impl Snapshot {
    /// Writes the dataset as time tiles, passing each file's path and bytes to `write`:
    ///
    /// - `frames.json`, the manifest;
    /// - `base.latk`, the dataset with each sampled field's frame range but none of its entries;
    /// - `{field}/{level}/{index}.latk`, a patch for each span of `chunk` entries, for every level
    ///   of every sampled field that has entries there.
    ///
    /// A view given the manifest as [`Tiles`](crate::Tiles) fetches the spans its lines draw, at
    /// the level of detail its plot window needs, and the frames around the coordinate it shows.
    /// Until a span arrives, the coarser span above it is drawn.
    ///
    /// The manifest is written last, so a reader that finds it finds every file it names. Errors if
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
                let emptied = samples.emptied();
                base.sampled(&table.name, name, |samples| {
                    *samples = emptied;
                    true
                });
            }
        }
        write(BASE, &base.to_bytes())?;
        let manifest = Manifest { data: BASE.to_owned(), chunk, url: URL.to_owned(), fields };
        write(MANIFEST, serde_json::to_string_pretty(&manifest).expect("JSON").as_bytes())
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
        // 100 frames: 7 spans of 16 at level 0; 12 buckets of 8 in 1 span at level 1; 1 bucket of
        // 64 at level 2.
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
        assert!(data.to_tiles(12, |_, _| Ok(())).is_err());
    }
}
