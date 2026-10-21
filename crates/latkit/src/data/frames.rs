//! Time tiles: a dataset written as the files a view fetches its sampled fields' histories from, in
//! spans, as it asks for them. A span of level `k` holds `chunk` entries of the level: frames at level
//! 0, else buckets of `8^k` frames. Eight spans make the one a level up, as four map tiles make the
//! tile a zoom out, so a span still loading draws the nearest span above it that has landed.
//!
//! | File          | What it holds                                                                   |
//! | ------------- | ------------------------------------------------------------------------------- |
//! | `frames.json` | the manifest: `data`, `chunk`, `url`, and `frames`, each sampled field's table, |
//! |               | name, and the frames it reads, `[first, end]`                                   |
//! | `base.latk`   | the dataset with every sampled field reading its frames but holding none        |
//! | spans         | at `url`, `{field}` the field's place in `frames`: a patch holding the span's   |
//! |               | entries, one `frames` change for each run of them                               |

use std::ops::Range;

use super::dataset::Data;
use super::name::Name;
use super::patch::{Op, Patch};
use super::samples::Run;
use super::table::Field;
use crate::{Error, Result};

/// The manifest's name.
pub(crate) const MANIFEST: &str = "frames.json";
/// The dataset without its sampled fields' entries.
const BASE: &str = "base.latk";
/// Where each span lies, beside the manifest.
const URL: &str = "{field}/{level}/{index}.latk";

/// A sampled field a manifest lists: its table and name, and the frames it reads, `[first, end]`.
#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct Listed {
    pub(crate) table: Name,
    pub(crate) field: Name,
    pub(crate) levels: u32,
    #[serde(with = "range")]
    pub(crate) frames: Range<u64>,
}

/// What a manifest says: where the dataset without its sampled fields' entries lies, the entries a
/// span holds, where each span lies, and the fields listed.
#[derive(Clone, PartialEq, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct Manifest {
    pub(crate) data: String,
    pub(crate) chunk: u32,
    pub(crate) url: String,
    #[serde(rename = "frames")]
    pub(crate) fields: Vec<Listed>,
}

/// Frames `first..end`, written `[first, end]`.
mod range {
    use std::ops::Range;

    use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

    pub(super) fn serialize<S: Serializer>(frames: &Range<u64>, s: S) -> Result<S::Ok, S::Error> {
        [frames.start, frames.end].serialize(s)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Range<u64>, D::Error> {
        match <[u64; 2]>::deserialize(d)? {
            [first, end] if first <= end => Ok(first..end),
            _ => Err(de::Error::custom("frames are [first, end], the first at most the end")),
        }
    }
}

impl Manifest {
    /// The manifest `bytes` hold; `None` where they hold none, being no JSON object listing `frames`.
    pub(crate) fn from_bytes(bytes: &[u8]) -> Option<Result<Manifest>> {
        let json: serde_json::Value = serde_json::from_slice(bytes).ok()?;
        json.get("frames")?.as_array()?;
        let manifest = crate::json::read::<Manifest, _>(&json).and_then(|m| {
            if !chunks(m.chunk) {
                return Err(Error::invalid("a span holds a multiple of 8 entries, 8 to 2^20").at("chunk"));
            }
            for (i, field) in m.fields.iter().enumerate() {
                if field.levels > super::samples::MAX_LEVEL {
                    return Err(Error::invalid("sample levels run from 0 to 21").at("levels").at(i).at("frames"));
                }
            }
            Ok(m)
        });
        Some(manifest.map_err(|e| e.at(MANIFEST)))
    }

    /// Where span `index` of `level` of the field listed `field`th lies, `url` its template.
    pub(crate) fn span(url: &str, field: usize, level: u32, index: u64) -> String {
        url.replace("{field}", &field.to_string())
            .replace("{level}", &level.to_string())
            .replace("{index}", &index.to_string())
    }
}

/// Whether a span may hold `chunk` entries: a multiple of 8, so a bucket a level up never straddles two.
fn chunks(chunk: u32) -> bool {
    (8..=1 << 20).contains(&chunk) && chunk.is_multiple_of(8)
}

impl Data {
    /// The dataset as time tiles, each file's path and bytes handed to `write`: `frames.json`, the
    /// manifest a view's tiles open; `base.latk`, the dataset with its sampled fields reading their
    /// frames but holding none; and a patch for each span of `chunk` entries of each level of each
    /// sampled field that holds any, at `{field}/{level}/{index}.latk`. A view given the manifest as
    /// [`Tiles`](crate::Tiles) fetches the spans its lines draw, at the level of detail its plot
    /// window asks, and those about the coordinate it shows; until a span lands, the span above it
    /// draws.
    ///
    /// The manifest is written last, so a reader finding it finds every file it names.
    pub fn to_tiles(&self, chunk: u32, mut write: impl FnMut(&str, &[u8]) -> Result<()>) -> Result<()> {
        if !chunks(chunk) {
            return Err(Error::invalid("a span holds a multiple of 8 entries, 8 to 2^20").at("chunk"));
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
                // Runs come level by level, in order, so each span is whole once the next begins.
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
    use crate::{Ids, Table};

    #[test]
    fn a_history_writes_as_spans_a_manifest_names() {
        let mut data = Data::new("grid");
        data.apply(
            Patch::new().axis("time", "s").replace(Table::new("Bus", Ids::count(2)).field("kv", vec![1.0, 2.0])),
        )
        .expect("rows");
        let at: Vec<f64> = (0..100).map(f64::from).collect();
        let values: Vec<f64> = (0..200).map(|v| f64::from(v % 7)).collect();
        data.apply(Patch::new().append(&at, "Bus", [("vm", values)])).expect("frames");
        let mut files = BTreeMap::new();
        data.to_tiles(16, |path, bytes| {
            files.insert(path.to_owned(), bytes.to_vec());
            Ok(())
        })
        .expect("tiles");
        let manifest = Manifest::from_bytes(&files[MANIFEST]).expect("a manifest").expect("valid");
        assert_eq!(manifest.fields, [Listed { table: "Bus".into(), field: "vm".into(), levels: 2, frames: 0..100 }]);
        // 100 frames: 7 spans of 16 at level 0; 12 buckets of 8 in 1 span at level 1; 1 of 64 at level 2.
        let spans: Vec<&str> = files
            .keys()
            .map(String::as_str)
            .filter(|p| std::path::Path::new(p).extension().is_some_and(|e| e == "latk") && *p != BASE)
            .collect();
        assert_eq!(spans.len(), 7 + 1 + 1);
        let mut back = Data::from_bytes(&files[BASE]).expect("the base");
        assert_eq!(back.describe().span, None, "the base holds no entries");
        for path in &spans {
            back.apply(Patch::from_bytes(&files[*path]).expect("a span")).expect("held once");
        }
        assert_eq!(back.to_bytes(), data.to_bytes(), "every span put back makes the history again");
        assert!(Manifest::from_bytes(br#"{"tiles": []}"#).is_none(), "TileJSON is no manifest");
        let backwards =
            br#"{"data": "b", "chunk": 16, "url": "u", "frames": [{"table": "t", "field": "f", "levels": 0, "frames": [3, 1]}]}"#;
        let error = Manifest::from_bytes(backwards).expect("a manifest").unwrap_err();
        assert!(error.to_string().starts_with("frames.json.frames[0].frames"), "{error}");
        assert!(data.to_tiles(12, |_, _| Ok(())).is_err());
    }
}
