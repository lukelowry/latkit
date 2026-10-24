//! Time tiles: sampled fields' histories fetched in spans as the sets drawing them ask, from the
//! files [`Snapshot::to_tiles`](crate::Snapshot::to_tiles) writes. Every field wants its coarsest
//! spans, which stand in for any span still loading; a line tracing it wants the spans of the level of
//! detail its plot window draws at, middle first; a mark showing it at the view's coordinate wants the
//! frames about that coordinate. A span drawn puts its entries in the set's dataset; one no longer
//! drawn lets them go.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::Span;
use super::sets::Reading;
use super::tiling::{Decoding, Pieces, Requested, Tiling};
use crate::data::{
    Field, Listed, MAX_LEVEL, Manifest, Name, Op, Patch, Run, Samples, Snapshot, bucket_frames, detail, sides,
};
use crate::derive::Jobs;
use crate::host::Request;
use crate::{Error, Pending};

/// Spans a line wants at most, middle first: those its plot window draws need far fewer.
const MAX_SPANS: usize = 64;

/// Sampled fields' spans of one manifest, as every set drawing them shares them: the dataset without
/// their entries, and each field's spans fetched and decoded.
pub(crate) struct Fetched {
    manifest: Manifest,
    /// Where each span lies, resolved against the manifest's URL.
    url: String,
    base: Base,
    /// Per field listed, its spans.
    fields: Vec<Tiling<Span>>,
}

/// The dataset without its sampled fields' entries, as it lands.
enum Base {
    Fetching(Pending<Vec<u8>>),
    Landed(Snapshot),
    Failed(Error),
}

impl Fetched {
    /// The fields `manifest`, found at `url`, lists; their dataset is fetched at once.
    pub(crate) fn open(url: &str, manifest: Manifest, jobs: &Jobs<'_>) -> Fetched {
        let base = jobs.fetch(&Request::new(crate::url::resolve(url, &manifest.data)));
        Fetched {
            url: crate::url::resolve(url, &manifest.url),
            base: Base::Fetching(base),
            fields: manifest.fields.iter().map(|_| Tiling::default()).collect(),
            manifest,
        }
    }

    /// Fetches and decodes under way.
    pub(crate) fn under_way(&self) -> usize {
        usize::from(matches!(self.base, Base::Fetching(_))) + self.fields.iter().map(Tiling::under_way).sum::<usize>()
    }

    /// Lets go of what set `set` drew.
    pub(crate) fn release(&mut self, set: u64) {
        for tiling in &mut self.fields {
            tiling.release(set);
        }
    }

    /// Takes the dataset without the fields' entries, once it landed.
    fn settle(&mut self) {
        let Base::Fetching(pending) = &self.base else { return };
        let Some(landed) = pending.take() else { return };
        self.base = match landed.and_then(|bytes| Snapshot::from_bytes(&bytes)) {
            Ok(base) => Base::Landed(base),
            Err(error) => Base::Failed(error),
        };
    }
}

/// What one set draws of time tiles: whether its dataset holds the one without the fields' entries
/// yet, and per field listed, the spans it draws with the runs each put in.
pub(crate) struct Drawing {
    based: bool,
    fields: Vec<FxHashMap<Span, Vec<Run>>>,
}

impl Drawing {
    pub(crate) fn new(fetched: &Fetched) -> Drawing {
        Drawing { based: false, fields: fetched.fields.iter().map(|_| FxHashMap::default()).collect() }
    }

    /// Spans drawn.
    pub(crate) fn drawn(&self) -> usize {
        self.fields.iter().map(FxHashMap::len).sum()
    }

    /// Brings `data`, set `set`'s dataset `name`, up to what `reading` reads of it, from what
    /// `fetched` holds: whether it changed, whether a span stands in, and a failure to tell.
    pub(crate) fn update(
        &mut self,
        set: u64,
        name: &Name,
        data: &mut Snapshot,
        reading: &Reading,
        fetched: &mut Fetched,
        jobs: &Jobs<'_>,
    ) -> (bool, bool, Option<Error>) {
        fetched.settle();
        let mut changed = false;
        if !self.based {
            match &fetched.base {
                Base::Fetching(_) => return (false, true, None),
                Base::Failed(error) => return (false, false, Some(error.clone())),
                Base::Landed(base) => {
                    *data = base.renamed(name.clone());
                    self.based = true;
                    changed = true;
                }
            }
        }
        let Fetched { manifest, url, fields, .. } = fetched;
        let (mut standing_in, mut failure) = (false, None);
        for (k, listed) in manifest.fields.iter().enumerate() {
            let reads = reading.reads(name, &listed.table, &listed.field);
            let (tiling, drawn_spans) = (&mut fields[k], &mut self.fields[k]);
            // Spans drawn may tell more finely where the window lies, which may want finer spans: ask
            // again until what is wanted settles, so what stands in is never taken for what draws.
            let (mut asked, mut standing) = (Vec::new(), false);
            for _ in 0..=MAX_LEVEL {
                let wanted =
                    wanted(&listed.frames, sampled(data, listed), reads, reading, manifest.chunk, listed.levels);
                if wanted == asked {
                    break;
                }
                let drawn = tiling.update(set, &wanted, 0, &mut At { url: url.as_str(), field: k }, jobs);
                standing = drawn.standing_in;
                failure = failure.or(drawn.failure);
                changed |= draw(drawn_spans, tiling, &drawn.keys, &listed.table, &listed.field, data);
                asked = wanted;
            }
            standing_in |= standing;
        }
        (changed, standing_in, failure)
    }
}

/// Makes `data`'s field `field` of `table` hold the entries of spans `drawn` and of no other, of
/// those `tiling` decoded; `spans` holds the runs each span put in. Whether it changed.
fn draw(
    spans: &mut FxHashMap<Span, Vec<Run>>,
    tiling: &Tiling<Span>,
    drawn: &[Span],
    table: &Name,
    field: &Name,
    data: &mut Snapshot,
) -> bool {
    let gone: Vec<Span> = spans.keys().filter(|s| !drawn.contains(s)).copied().collect();
    let arrived: Vec<(Span, &Patch)> =
        drawn.iter().filter(|s| !spans.contains_key(s)).filter_map(|s| Some((*s, tiling.decoded(s, 0)?))).collect();
    if gone.is_empty() && arrived.is_empty() {
        return false;
    }
    let mut put: Vec<(Span, Vec<Run>)> = Vec::new();
    let changed = data.sampled(table, field, |samples| {
        for span in &gone {
            for run in spans.remove(span).unwrap_or_default() {
                samples.remove(&run);
            }
        }
        for (span, tile) in &arrived {
            put.push((*span, held(tile, table, field, samples)));
        }
        true
    });
    if changed {
        spans.extend(put);
    }
    changed
}

/// Puts the runs of field `field` of `table` that `tile` holds in `samples`: those it put.
fn held(tile: &Patch, table: &Name, field: &Name, samples: &mut Samples) -> Vec<Run> {
    let mut runs = Vec::new();
    for op in &tile.ops {
        let Op::Frames { table: t, field: f, run, at, values } = op else { continue };
        if t != table || f != field {
            continue;
        }
        let per_row = run.len() * sides(run.level);
        let rows = values.len().checked_div(per_row).unwrap_or(0);
        if samples.insert(run, at, values, rows).is_ok() {
            runs.push(run.clone());
        }
    }
    runs
}

/// The samples `data` holds of the field `listed` names.
fn sampled<'a>(data: &'a Snapshot, listed: &Listed) -> Option<&'a Samples> {
    match data.table(&listed.table)?.field_named(&listed.field)? {
        Field::Sampled(samples, _) => Some(samples),
        _ => None,
    }
}

/// The spans of a field reading `frames` a view wants, nearest first: those of its coarsest level
/// holding any entry always; where a mark shows it, `(_, true)`, the frames about the coordinate shown;
/// where a line traces it, `(true, _)`, those of the level of detail the plot window draws at, middle
/// first. Where the window lies among the frames, what is held tells, as finely as it is held.
fn wanted(
    frames: &Range<u64>,
    samples: Option<&Samples>,
    (traced, shown): (bool, bool),
    reading: &Reading,
    chunk: u32,
    levels: u32,
) -> Vec<Span> {
    // The entries of each level a history of `frames` holds: whole buckets only.
    let chunk = u64::from(chunk);
    let entries = |level: u32| frames.start >> (3 * level)..frames.end >> (3 * level);
    // The spans of `level` holding its entries over frames `window`.
    let spans = |level: u32, window: &Range<u64>| {
        let (held, span) = (entries(level), bucket_frames(level));
        let first = (window.start / span).max(held.start);
        let end = window.end.div_ceil(span).min(held.end);
        (first / chunk..end.div_ceil(chunk)).map(move |index| Span { level: level as u8, index })
    };
    let top = (0..=levels).rev().find(|&level| !entries(level).is_empty()).unwrap_or(0);
    let mut wanted: Vec<Span> = spans(top, frames).take(MAX_SPANS).collect();
    let held = samples.filter(|s| !s.is_empty());
    if shown && let Some(samples) = held {
        let frame = samples.bound(reading.at, true).saturating_sub(1);
        wanted.extend(spans(0, &(frame..frame.saturating_add(2))));
    }
    if traced {
        let window = match (held, reading.across) {
            (Some(samples), Some(across)) => samples.across(across),
            _ => frames.clone(),
        };
        let level = detail(window.end - window.start, reading.columns).min(top);
        let (held, span) = (entries(level), bucket_frames(level));
        let first = (window.start / span).max(held.start) / chunk;
        let end = window.end.div_ceil(span).min(held.end).div_ceil(chunk);
        // Choose nearest spans before allocating: an absolute-index range may be enormous and sparse.
        let count = end.saturating_sub(first);
        let middle = first + count.saturating_sub(1) / 2;
        wanted.extend((0..count.min(MAX_SPANS as u64)).map(|offset| {
            let index = if offset % 2 == 0 { middle - offset / 2 } else { middle + offset.div_ceil(2) };
            Span { level: level as u8, index }
        }));
    }
    let mut seen = FxHashSet::default();
    wanted.retain(|span| seen.insert(*span));
    wanted
}

/// Where a field's spans lie: the field's place in the manifest, in the spans' URL template.
struct At<'a> {
    url: &'a str,
    field: usize,
}

impl Pieces<Span> for At<'_> {
    fn request(&mut self, span: Span, _: &Jobs<'_>) -> Requested {
        Requested::Fetch(Request::new(Manifest::span(self.url, self.field, u32::from(span.level), span.index)))
    }

    fn decode(&self, _: Span, bytes: &Arc<Vec<u8>>, _: &Jobs<'_>) -> Decoding {
        Decoding::Now(Patch::from_bytes(bytes).unwrap_or_default())
    }
}
