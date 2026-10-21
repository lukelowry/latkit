//! Time tiles: sampled fields' histories fetched in spans as a view asks for them, from the files
//! [`Data::to_tiles`](crate::Data::to_tiles) writes. Every field wants its coarsest spans, which stand
//! in for any span still loading; a line tracing it wants the spans of the level of detail its plot
//! window draws at, middle first; a mark showing it at the view's coordinate wants the frames about
//! that coordinate. A span drawn puts its entries in the dataset; one no longer drawn lets them go.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::super::Jobs;
use super::super::tiling::{Decoding, Requested, Source, Tiling};
use super::Reading;
use crate::data::{
    Data, Field, Listed, MAX_LEVEL, Manifest, Name, Op, Patch, Run, Samples, bucket_frames, detail, sides,
};
use crate::host::Request;
use crate::tiles::Span;
use crate::{Error, Pending};

/// Spans a line wants at most, middle first: those its plot window draws need far fewer.
const MAX_SPANS: usize = 64;

/// Sampled fields fetched in spans, drawn as a dataset the view owns.
pub(crate) struct Frames {
    manifest: Manifest,
    /// Where each span lies, resolved against the manifest's URL.
    url: String,
    /// The dataset without its sampled fields' entries, until it lands.
    base: Option<Pending<Vec<u8>>>,
    /// Per field listed, its spans.
    fields: Vec<Spans>,
    failed: bool,
}

/// One field's spans: fetched and decoded, and those drawn with the runs each put in.
#[derive(Default)]
struct Spans {
    tiling: Tiling<Span>,
    drawn: FxHashMap<Span, Vec<Run>>,
}

impl Frames {
    /// The fields `manifest`, found at `url`, lists; their dataset is fetched at once.
    pub(crate) fn open(url: &str, manifest: Manifest, jobs: &Jobs<'_>) -> Frames {
        let base = jobs.fetch(&Request::new(crate::url::resolve(url, &manifest.data)));
        Frames {
            url: crate::url::resolve(url, &manifest.url),
            base: Some(base),
            fields: manifest.fields.iter().map(|_| Spans::default()).collect(),
            manifest,
            failed: false,
        }
    }

    /// Spans drawn.
    pub(crate) fn drawn(&self) -> usize {
        self.fields.iter().map(|f| f.drawn.len()).sum()
    }

    /// Fetches and decodes under way.
    pub(crate) fn under_way(&self) -> usize {
        usize::from(self.base.is_some()) + self.fields.iter().map(|f| f.tiling.under_way()).sum::<usize>()
    }

    /// Brings `data`, dataset `name`, up to what `reading` reads of it: whether it changed, whether a
    /// span stands in, and a failure to tell.
    pub(crate) fn update(
        &mut self,
        name: &Name,
        data: &mut Data,
        reading: &Reading,
        jobs: &Jobs<'_>,
    ) -> (bool, bool, Option<Error>) {
        let mut changed = false;
        if let Some(pending) = &self.base {
            let Some(landed) = pending.take() else { return (false, true, None) };
            self.base = None;
            match landed.and_then(|bytes| Data::from_bytes(&bytes)) {
                Ok(base) => {
                    *data = base.renamed(name.clone());
                    changed = true;
                }
                Err(error) => {
                    self.failed = true;
                    return (false, false, Some(error));
                }
            }
        }
        if self.failed {
            return (false, false, None);
        }
        let (mut standing_in, mut failure) = (false, None);
        for (k, listed) in self.manifest.fields.iter().enumerate() {
            let reads = reading.reads(name, &listed.table, &listed.field);
            let spans = &mut self.fields[k];
            // Spans drawn may tell more finely where the window lies, which may want finer spans: ask
            // again until what is wanted settles, so what stands in is never taken for what draws.
            let (mut asked, mut standing) = (Vec::new(), false);
            for _ in 0..=MAX_LEVEL {
                let wanted =
                    wanted(&listed.frames, sampled(data, listed), reads, reading, self.manifest.chunk, listed.levels);
                if wanted == asked {
                    break;
                }
                let drawn = spans.tiling.update(&wanted, 0, &mut At { url: &self.url, field: k }, jobs);
                standing = drawn.standing_in;
                failure = failure.or(drawn.failure);
                changed |= spans.draw(&drawn.keys, &listed.table, &listed.field, data);
                asked = wanted;
            }
            standing_in |= standing;
        }
        (changed, standing_in, failure)
    }
}

impl Spans {
    /// Makes `data`'s field `field` of `table` hold the entries of spans `drawn` and of no other:
    /// whether it changed.
    fn draw(&mut self, drawn: &[Span], table: &Name, field: &Name, data: &mut Data) -> bool {
        let gone: Vec<Span> = self.drawn.keys().filter(|s| !drawn.contains(s)).copied().collect();
        let arrived: Vec<(Span, &Patch)> = drawn
            .iter()
            .filter(|s| !self.drawn.contains_key(s))
            .filter_map(|s| Some((*s, self.tiling.decoded(s, 0)?)))
            .collect();
        if gone.is_empty() && arrived.is_empty() {
            return false;
        }
        let mut put: Vec<(Span, Vec<Run>)> = Vec::new();
        let drawn_runs = &mut self.drawn;
        let changed = data.sampled(table, field, |samples| {
            for span in &gone {
                for run in drawn_runs.remove(span).unwrap_or_default() {
                    samples.remove(&run);
                }
            }
            for (span, tile) in &arrived {
                put.push((*span, held(tile, table, field, samples)));
            }
            true
        });
        if changed {
            self.drawn.extend(put);
        }
        changed
    }
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
fn sampled<'a>(data: &'a Data, listed: &Listed) -> Option<&'a Samples> {
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

impl Source<Span> for At<'_> {
    fn request(&mut self, span: Span, _: &Jobs<'_>) -> Requested {
        Requested::Fetch(Request::new(Manifest::span(self.url, self.field, u32::from(span.level), span.index)))
    }

    fn decode(&self, _: Span, bytes: &Arc<Vec<u8>>, _: &Jobs<'_>) -> Decoding {
        Decoding::Now(Patch::from_bytes(bytes).unwrap_or_default())
    }
}
