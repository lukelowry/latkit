//! Time tiles: the histories of sampled fields, fetched in spans as the sets drawing them need,
//! from the files [`Snapshot::to_tiles`](crate::Snapshot::to_tiles) writes. Every field needs its
//! coarsest spans, which are drawn as placeholders for any span still loading. A line tracing a
//! field needs the spans at the level of detail the plot window draws at, middle first. A mark
//! showing a field at the view's coordinate needs the frames around that coordinate. A drawn span
//! adds its entries to the set's dataset, and a span no longer drawn removes them.

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

/// Most spans a line needs, middle first. A plot window normally needs far fewer.
const MAX_SPANS: usize = 64;

/// The spans of one manifest's sampled fields, shared by every set drawing them. Holds the base
/// dataset without their entries, each field's fetched and decoded spans, and how many times the
/// manifest was refreshed.
pub(crate) struct Fetched {
    manifest: Manifest,
    /// The spans' URL template, resolved against the manifest's URL.
    url: String,
    base: Base,
    /// Each listed field's spans.
    fields: Vec<Tiling<Span>>,
    refreshes: u64,
}

/// The base dataset, without its sampled fields' entries, as it arrives.
enum Base {
    Fetching(Pending<Vec<u8>>),
    Landed(Snapshot),
    Failed(Error),
}

impl Fetched {
    /// Opens the fields that `manifest`, fetched from `url`, lists. Their base dataset is fetched
    /// immediately.
    pub(crate) fn open(url: &str, manifest: Manifest, jobs: &Jobs<'_>) -> Fetched {
        let base = jobs.fetch(&Request::new(crate::url::resolve(url, &manifest.data)));
        Fetched {
            url: crate::url::resolve(url, &manifest.url),
            base: Base::Fetching(base),
            fields: manifest.fields.iter().map(|_| Tiling::default()).collect(),
            manifest,
            refreshes: 0,
        }
    }

    /// Takes `manifest`, a newer version of this one, fetched again from `url`. Fetches the base
    /// dataset again. Each field keeps the spans within the frames it held, and drops the spans
    /// that reach past them, which the new manifest may extend.
    pub(crate) fn refresh(&mut self, url: &str, manifest: Manifest, jobs: &Jobs<'_>) {
        let mut fresh = Fetched::open(url, manifest, jobs);
        fresh.refreshes = self.refreshes + 1;
        let chunk = u64::from(self.manifest.chunk);
        for (k, listed) in fresh.manifest.fields.iter().enumerate() {
            let held =
                self.manifest.fields.iter().position(|old| old.table == listed.table && old.field == listed.field);
            let Some(old) = held.filter(|_| fresh.manifest.chunk == self.manifest.chunk) else { continue };
            let end = self.manifest.fields[old].frames.end;
            let mut tiling = std::mem::take(&mut self.fields[old]);
            tiling.forget(|span| {
                (span.index + 1).saturating_mul(chunk).saturating_mul(bucket_frames(u32::from(span.level))) <= end
            });
            fresh.fields[k] = tiling;
        }
        *self = fresh;
    }

    /// Fetches and decodes in progress.
    pub(crate) fn under_way(&self) -> usize {
        usize::from(matches!(self.base, Base::Fetching(_))) + self.fields.iter().map(Tiling::under_way).sum::<usize>()
    }

    /// Releases what set `set` drew.
    pub(crate) fn release(&mut self, set: u64) {
        for tiling in &mut self.fields {
            tiling.release(set);
        }
    }

    /// Takes the base dataset once it arrives.
    fn settle(&mut self) {
        let Base::Fetching(pending) = &self.base else { return };
        let Some(landed) = pending.take() else { return };
        self.base = match landed.and_then(|bytes| Snapshot::from_bytes(&bytes)) {
            Ok(base) => Base::Landed(base),
            Err(error) => Base::Failed(error),
        };
    }
}

/// What one set draws of time tiles: the refresh it draws, whether its dataset holds the base
/// dataset yet, and for each listed field, the spans it draws with the runs each added.
pub(crate) struct Drawing {
    refreshes: u64,
    based: bool,
    fields: Vec<FxHashMap<Span, Vec<Run>>>,
}

impl Drawing {
    pub(crate) fn new(fetched: &Fetched) -> Drawing {
        Drawing {
            refreshes: fetched.refreshes,
            based: false,
            fields: fetched.fields.iter().map(|_| FxHashMap::default()).collect(),
        }
    }

    /// Spans drawn.
    pub(crate) fn drawn(&self) -> usize {
        self.fields.iter().map(FxHashMap::len).sum()
    }

    /// Updates `data`, set `set`'s dataset `name`, to what `reading` reads of it, from what
    /// `fetched` holds. Returns whether it changed, whether any wanted span still shows a
    /// placeholder, and a failure to report.
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
        // Once a refreshed source's base arrives, the set draws it from scratch. Until then it
        // keeps drawing what it drew.
        if self.refreshes != fetched.refreshes {
            if matches!(fetched.base, Base::Fetching(_)) {
                return (false, true, None);
            }
            *self = Drawing::new(fetched);
        }
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
            // Drawn spans may locate the window more precisely, which may need finer spans. Repeat
            // until the wanted spans stop changing, so a placeholder is never mistaken for data.
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

/// Makes field `field` of `table` in `data` hold exactly the entries of spans `drawn`, from those
/// `tiling` decoded. `spans` records the runs each span added. Returns whether it changed.
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

/// Inserts the runs of field `field` of `table` from `tile` into `samples`, returning the runs
/// inserted.
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

/// The samples `data` holds for the field `listed` names.
fn sampled<'a>(data: &'a Snapshot, listed: &Listed) -> Option<&'a Samples> {
    match data.table(&listed.table)?.field_named(&listed.field)? {
        Field::Sampled(samples, _) => Some(samples),
        _ => None,
    }
}

/// The spans a view needs of a field covering `frames`, nearest first. It always needs the spans
/// of the field's coarsest level holding any entry. When a mark shows the field (`(_, true)`), it
/// needs the frames around the shown coordinate. When a line traces it (`(true, _)`), it needs the
/// spans of the level of detail the plot window draws at, middle first. The window's position
/// among the frames comes from the samples already held, as precisely as they allow.
fn wanted(
    frames: &Range<u64>,
    samples: Option<&Samples>,
    (traced, shown): (bool, bool),
    reading: &Reading,
    chunk: u32,
    levels: u32,
) -> Vec<Span> {
    // The bucket indices at each level within `frames`: whole buckets only.
    let chunk = u64::from(chunk);
    let entries = |level: u32| frames.start >> (3 * level)..frames.end >> (3 * level);
    // The spans of `level` covering its entries within frames `window`.
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
        // Choose the nearest spans before allocating: an absolute-index range may be enormous and
        // sparse.
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

/// Locates a field's spans: the spans' URL template and the field's index in the manifest.
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
