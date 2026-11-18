//! Time tiles: the histories of sampled fields, fetched in spans as the sets drawing them need,
//! from the files [`Snapshot::to_tiles`](crate::Snapshot::to_tiles) writes. Every field needs its
//! coarsest spans, which are drawn as placeholders for any span still loading. A line tracing a
//! field needs the spans at the level of detail the plot window draws at, middle first. A mark
//! showing a field at the view's coordinate needs the frames around that coordinate. A drawn span
//! adds its entries to the set's dataset, and a span no longer drawn removes them. A span the
//! trace drew stays until the spans that replace it land, so a trace turning coarser draws the
//! finer spans meanwhile. A refresh keeps the base and every span the earlier frames filled, and
//! fetches the last span of each level again, which draws what it held until the new one lands.
//! The view takes the refreshed spans together, once they all landed.

use std::ops::Range;
use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::Span;
use super::retry::Retry;
use super::sets::{Reading, Updated};
use super::tiling::{Decoding, Pieces, Requested, Tiling};
use crate::data::{
    Field, Listed, MAX_LEVEL, Manifest, Name, Op, Patch, Run, Samples, Snapshot, bucket_frames, detail, sides,
};
use crate::derive::Jobs;
use crate::host::Request;
use crate::{Error, Pending};

/// The spans of one manifest's sampled fields, shared by every set drawing them. Holds the base
/// dataset without their entries, each field's fetched and decoded spans, and how many times a
/// base was opened.
pub(crate) struct Fetched {
    manifest: Manifest,
    /// The spans' URL template, and the base's URL, resolved against the manifest's URL.
    url: String,
    base_url: String,
    base: Base,
    /// Each listed field's spans.
    pub(super) fields: Vec<Tiling<Span>>,
    opened: u64,
}

/// The base dataset, without its sampled fields' entries, as it arrives.
enum Base {
    /// Being fetched, after a fetch that failed with this retry, if any.
    Fetching(Pending<Vec<u8>>, Option<Retry>),
    Landed(Snapshot),
    /// It could not be read: a fetch that failed, fetched again after its retry, or bytes that
    /// are not a dataset, read again only after a refresh.
    Failed(Error, Option<Retry>),
}

impl Fetched {
    /// Opens the fields that `manifest`, fetched from `url`, lists. Their base dataset is fetched
    /// immediately.
    pub(crate) fn open(url: &str, manifest: Manifest, jobs: &Jobs<'_>) -> Fetched {
        let base_url = crate::url::resolve(url, &manifest.data);
        Fetched {
            url: crate::url::resolve(url, &manifest.url),
            base: Base::Fetching(jobs.fetch(&Request::new(base_url.clone())), None),
            base_url,
            fields: manifest.fields.iter().map(|_| Tiling::default()).collect(),
            manifest,
            opened: 0,
        }
    }

    /// Takes `manifest`, a newer version of this one, fetched again from `url`. A manifest that
    /// names another base, span size, or span template starts over. Otherwise each field keeps the
    /// spans the frames it listed filled, and fetches the rest again, such as the last span of each
    /// level, which the new manifest may extend. A base or span that failed is fetched again too,
    /// without waiting for its retry.
    pub(crate) fn refresh(&mut self, url: &str, manifest: Manifest, jobs: &Jobs<'_>) {
        let old = &self.manifest;
        if manifest.data != old.data || manifest.chunk != old.chunk || manifest.url != old.url {
            let opened = self.opened + 1;
            *self = Fetched::open(url, manifest, jobs);
            self.opened = opened;
            return;
        }
        if let Base::Failed(_, retry) = self.base {
            self.base = Base::Fetching(jobs.fetch(&Request::new(self.base_url.clone())), retry);
        }
        let chunk = u64::from(manifest.chunk);
        let mut fields = Vec::with_capacity(manifest.fields.len());
        for listed in &manifest.fields {
            let held = self.manifest.fields.iter().position(|o| o.table == listed.table && o.field == listed.field);
            fields.push(held.map_or_else(Tiling::default, |old| {
                let end = self.manifest.fields[old].frames.end;
                let mut tiling = std::mem::take(&mut self.fields[old]);
                tiling.renew(|span| {
                    (span.index + 1).saturating_mul(chunk).saturating_mul(bucket_frames(u32::from(span.level))) > end
                });
                tiling
            }));
        }
        (self.fields, self.manifest) = (fields, manifest);
    }

    /// Fetches and decodes in progress.
    pub(crate) fn under_way(&self) -> usize {
        usize::from(matches!(self.base, Base::Fetching(..))) + self.fields.iter().map(Tiling::under_way).sum::<usize>()
    }

    /// Takes the base dataset once it arrives: a patch applied to an empty dataset. Each set draws
    /// it under the tiles' name, so the patch need not name one. A fetch that failed runs again
    /// after its retry, and a cancelled one at once.
    fn settle(&mut self, jobs: &Jobs<'_>) {
        let fetch = |url: &str, retry| Base::Fetching(jobs.fetch(&Request::new(url.to_owned())), retry);
        match &self.base {
            Base::Fetching(pending, last) => {
                let last = *last;
                let Some(landed) = pending.take() else { return };
                self.base = match landed {
                    Ok(bytes) => {
                        let patch = Patch::from_bytes(&bytes);
                        let base = patch.and_then(|patch| {
                            Snapshot::new(patch.data.clone().unwrap_or_else(|| Name::from("base"))).applied(patch)
                        });
                        base.map_or_else(
                            |error| Base::Failed(error.at(self.manifest.data.as_str()), None),
                            Base::Landed,
                        )
                    }
                    Err(Error::Cancelled) => fetch(&self.base_url, last),
                    Err(error) => Base::Failed(error, Some(Retry::after(last, jobs.waker()))),
                };
            }
            Base::Failed(_, Some(retry)) if retry.due() => self.base = fetch(&self.base_url, Some(*retry)),
            Base::Landed(_) | Base::Failed(..) => {}
        }
    }
}

/// The spans a set draws of one field, with the tick each landed at and the runs it added.
type DrawnSpans = FxHashMap<Span, (u64, Vec<Run>)>;

/// What one set draws of time tiles: the base it draws, whether its dataset holds that base yet,
/// and for each field by table and name, the spans it draws.
pub(crate) struct Drawing {
    opened: u64,
    based: bool,
    fields: FxHashMap<(Name, Name), DrawnSpans>,
}

impl Drawing {
    pub(crate) fn new(fetched: &Fetched) -> Drawing {
        Drawing { opened: fetched.opened, based: false, fields: FxHashMap::default() }
    }

    /// Spans drawn.
    pub(crate) fn drawn(&self) -> usize {
        self.fields.values().map(FxHashMap::len).sum()
    }

    /// Updates `data`, set `set`'s dataset `name`, to what `reading` reads of it, from what
    /// `fetched` holds, and says what it found.
    pub(crate) fn update(
        &mut self,
        set: u64,
        name: &Name,
        data: &mut Snapshot,
        reading: &Reading,
        fetched: &mut Fetched,
        jobs: &Jobs<'_>,
    ) -> Updated {
        fetched.settle(jobs);
        // Once a new base arrives, the set draws it from scratch. Until then it keeps drawing what
        // it drew, and the view keeps the version before until each wanted span draws something.
        let mut updated = Updated::default();
        if self.opened != fetched.opened {
            if matches!(fetched.base, Base::Fetching(..)) {
                return Updated::loading();
            }
            *self = Drawing::new(fetched);
            updated.rebased = true;
        }
        if !self.based {
            match &fetched.base {
                Base::Fetching(..) => return Updated::loading(),
                Base::Failed(error, _) => return Updated { failure: Some(error.clone()), ..updated },
                Base::Landed(base) => {
                    *data = base.renamed(name.clone());
                    self.based = true;
                    updated.changed = true;
                }
            }
        }
        let Fetched { manifest, url, fields, .. } = fetched;
        // A field the refreshed manifest no longer lists keeps no entries.
        let unlisted: Vec<(Name, Name)> = (self.fields.keys())
            .filter(|(table, field)| !manifest.fields.iter().any(|l| l.table == *table && l.field == *field))
            .cloned()
            .collect();
        for (table, field) in unlisted {
            let spans = self.fields.remove(&(table.clone(), field.clone())).unwrap_or_default();
            updated.changed |= data.sampled(&table, &field, |samples| {
                spans.values().flat_map(|(_, runs)| runs).for_each(|run| samples.remove(run));
                true
            });
        }
        for (k, listed) in manifest.fields.iter().enumerate() {
            let reads = reading.reads(name, &listed.table, &listed.field);
            let tiling = &mut fields[k];
            let drawn_spans = self.fields.entry((listed.table.clone(), listed.field.clone())).or_default();
            // Drawn spans may locate the window more precisely, which may need finer spans. Repeat
            // until the wanted spans stop changing, so a placeholder is never mistaken for data.
            let (mut asked, mut last) = (Vec::new(), None);
            for _ in 0..=MAX_LEVEL {
                let wanted =
                    wanted(&listed.frames, sampled(data, listed), reads, reading, manifest.chunk, listed.levels);
                if wanted == asked {
                    break;
                }
                let drawn = tiling.update(set, &wanted, 0, &mut At { url: url.as_str(), field: k }, jobs);
                updated.changed |= draw(drawn_spans, tiling, &drawn.keys, &listed.table, &listed.field, data);
                last = Some(drawn);
                asked = wanted;
            }
            if let Some(drawn) = &last {
                updated.add(drawn);
            }
        }
        updated
    }
}

/// Makes field `field` of `table` in `data` hold exactly the entries of spans `drawn`, from those
/// `tiling` decoded. `spans` records when each span landed and the runs it added. A span fetched
/// again leaves and arrives in one change, so it never blinks. Returns whether it changed.
fn draw(
    spans: &mut DrawnSpans,
    tiling: &Tiling<Span>,
    drawn: &[Span],
    table: &Name,
    field: &Name,
    data: &mut Snapshot,
) -> bool {
    let current = |span: &Span, landed: u64| drawn.contains(span) && tiling.landed(span) == landed;
    let gone: Vec<Span> = spans.iter().filter(|(s, (landed, _))| !current(s, *landed)).map(|(s, _)| *s).collect();
    let arrived: Vec<(Span, u64, &Patch)> = (drawn.iter())
        .filter(|s| spans.get(s).is_none_or(|(landed, _)| *landed != tiling.landed(s)))
        .filter_map(|s| Some((*s, tiling.landed(s), tiling.decoded(s, 0)?)))
        .collect();
    if gone.is_empty() && arrived.is_empty() {
        return false;
    }
    let mut put: Vec<(Span, (u64, Vec<Run>))> = Vec::new();
    let changed = data.sampled(table, field, |samples| {
        for span in &gone {
            for run in spans.remove(span).map(|(_, runs)| runs).unwrap_or_default() {
                samples.remove(&run);
            }
        }
        for (span, landed, tile) in &arrived {
            put.push((*span, (*landed, held(tile, table, field, samples))));
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
/// of the field's coarsest level holding any entry, as many as a window could draw. When a mark
/// shows the field (`(_, true)`), it needs the frames around the shown coordinate. When a line
/// traces it (`(true, _)`), it needs the spans of the level of detail the plot window draws at,
/// middle first, then the finer spans of the frames past that level's whole buckets (see
/// `covering`). That is what the trace draws, so what is fetched is what is drawn. The window's
/// position among the frames comes from the samples already held, as precisely as they allow.
fn wanted(
    frames: &Range<u64>,
    samples: Option<&Samples>,
    (traced, shown): (bool, bool),
    reading: &Reading,
    chunk: u32,
    levels: u32,
) -> Vec<Span> {
    let chunk = u64::from(chunk);
    // The spans holding `level`'s entries `entries`.
    let spans = |level: u32, entries: &Range<u64>| {
        (entries.start / chunk..entries.end.div_ceil(chunk)).map(move |index| Span { level: level as u8, index })
    };
    // `level`'s whole buckets within frames `window`.
    let within = |level: u32, window: &Range<u64>| {
        let (held, span) = (written(frames, level), bucket_frames(level));
        (window.start / span).max(held.start)..window.end.div_ceil(span).min(held.end)
    };
    let top = (0..=levels).rev().find(|&level| !written(frames, level).is_empty()).unwrap_or(0);
    // A window draws at most a bucket's eight entries per pixel column, within what a trace holds.
    let drawable = reading.most.min(bucket_frames(1) * u64::from(reading.columns.max(1)));
    let placeholders = usize::try_from(drawable.div_ceil(chunk)).unwrap_or(usize::MAX);
    let mut wanted: Vec<Span> = spans(top, &within(top, frames)).take(placeholders).collect();
    let held = samples.filter(|s| !s.is_empty());
    if shown && let Some(samples) = held {
        let frame = samples.bound(reading.at, true).saturating_sub(1);
        wanted.extend(spans(0, &within(0, &(frame..frame.saturating_add(2)))));
    }
    if traced {
        // Frames past those held may lie in view, where the samples cannot place the window, so
        // there it runs on to the field's first or last frame.
        let window = match (held, reading.across) {
            (Some(samples), Some(across)) => {
                let window = samples.across(across);
                let start = if window.start <= samples.start() { frames.start } else { window.start };
                let end = if window.end >= samples.end() { frames.end } else { window.end };
                start..end.max(start)
            }
            _ => frames.clone(),
        };
        // A trace draws from one level: the one whose entries fit a pixel column, or a coarser one
        // when the trace may not hold that many. Fine spans between coarse placeholders would
        // break the line where they overlap.
        let level = detail(window.end - window.start, reading.columns, reading.most).min(top);
        let mut runs = Vec::new();
        covering(frames, window, level, &mut runs);
        for run in &runs {
            if run.level != level {
                continue;
            }
            let indices = run.entries.start / chunk..run.entries.end.div_ceil(chunk);
            let middle = indices.start + (indices.end - indices.start).saturating_sub(1) / 2;
            wanted.extend((0..indices.end - indices.start).map(|offset| {
                let index = if offset % 2 == 0 { middle - offset / 2 } else { middle + offset.div_ceil(2) };
                Span { level: level as u8, index }
            }));
        }
        for run in runs.iter().filter(|run| run.level != level) {
            wanted.extend(spans(run.level, &run.entries));
        }
    }
    let mut seen = FxHashSet::default();
    wanted.retain(|span| seen.insert(*span));
    wanted
}

/// The entries of `level` a field over `frames` holds: whole buckets only, since a bucket is
/// written once the eight entries below it are all present.
fn written(frames: &Range<u64>, level: u32) -> Range<u64> {
    let span = bucket_frames(level);
    frames.start.div_ceil(span)..frames.end / span
}

/// The runs that draw frames `window` of a field over `frames` at `level` once fetched: that
/// level's whole buckets, and at either end the next finer level for the frames they leave out, as
/// [`Samples::cover`] draws them.
fn covering(frames: &Range<u64>, window: Range<u64>, level: u32, runs: &mut Vec<Run>) {
    let window = window.start.max(frames.start)..window.end.min(frames.end);
    if window.is_empty() {
        return;
    }
    if level == 0 {
        runs.push(Run { level: 0, entries: window });
        return;
    }
    let (held, span) = (written(frames, level), bucket_frames(level));
    let entries = (window.start / span).max(held.start)..window.end.div_ceil(span).min(held.end);
    if entries.is_empty() {
        covering(frames, window, level - 1, runs);
        return;
    }
    covering(frames, window.start..entries.start * span, level - 1, runs);
    runs.push(Run { level, entries: entries.clone() });
    covering(frames, entries.end * span..window.end, level - 1, runs);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trace_fetches_the_one_level_it_draws_from() {
        let traced = |most: u64, level: u8| {
            let reading = Reading { columns: 1000, most, ..Reading::default() };
            let all = wanted(&(0..100_000), None, (true, false), &reading, 64, 5);
            all.into_iter().filter(|span| span.level == level).count()
        };
        // 100,000 frames over 1,000 columns draw from level 2, whose 1,562 whole buckets of 64
        // frames each fit a column, in 25 spans.
        assert_eq!(traced(u64::MAX, 2), 25);
        // A trace that may hold only 512 entries draws from level 3 across the whole window,
        // rather than a middle of level 2 between coarse placeholders.
        assert_eq!(traced(512, 3), 4);
    }

    #[test]
    fn every_frame_a_trace_shows_is_fetched_at_a_level_that_holds_it() {
        // Five whole buckets of 512 frames, and three frames past them that only finer levels hold.
        let frames = 0..512 * 5 + 3;
        let reading = Reading { columns: 4, most: u64::MAX, ..Reading::default() };
        let wanted = wanted(&frames, None, (true, false), &reading, 8, 3);
        for frame in frames.clone() {
            let fetched = wanted.iter().any(|span| {
                let entry = frame / bucket_frames(u32::from(span.level));
                written(&frames, u32::from(span.level)).contains(&entry) && entry / 8 == span.index
            });
            assert!(fetched, "frame {frame} is fetched: {wanted:?}");
        }
    }
}
