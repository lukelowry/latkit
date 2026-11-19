//! Tile sets: for each tile source a view is given, a set whose dataset holds the pieces the view's
//! camera and plot window need. Marks draw it like any other dataset, except that a vector set's
//! tables are always paged, and their tiles are the vector tiles drawn. The pieces come from the
//! GPU's cache, shared by every view drawing the same source.

use std::sync::atomic::{AtomicU64, Ordering};

use super::cache::{Cache, Holds, State};
use super::{frames, vector};
use crate::data::{Name, Snapshot};
use crate::derive::sight::Sight;
use crate::derive::tiled::{Choices, Draw, Plans};
use crate::derive::{Input, Jobs};
use crate::{Error, Tiles};

/// What a view reads of sampled fields. It holds the plot window that lines trace across
/// (`across`), its width in pixel columns, and the most entries a trace may hold (`most`), and the
/// coordinate at which fields are shown (`at`). It also holds each field that marks read, by
/// dataset, table, and name, with whether a line traces it.
#[derive(Default)]
pub(crate) struct Reading {
    pub(crate) across: Option<[f64; 2]>,
    pub(crate) columns: u32,
    pub(crate) most: u64,
    pub(crate) at: f64,
    pub(crate) fields: Vec<(Name, Name, Name, bool)>,
}

impl Reading {
    /// Whether a line traces field `field` of `table` in dataset `data`, and whether a mark shows
    /// it at the coordinate.
    pub(crate) fn reads(&self, data: &str, table: &str, field: &str) -> (bool, bool) {
        let mut reads = (false, false);
        for (d, t, f, traced) in &self.fields {
            if d == data && t == table && f == field {
                if *traced {
                    reads.0 = true;
                } else {
                    reads.1 = true;
                }
            }
        }
        reads
    }
}

/// What the view needs of its tiles: what the camera shows of the earth (`sight`), and what it
/// reads of sampled fields.
pub(crate) struct Asked<'a> {
    pub(crate) sight: Option<&'a Sight<'a>>,
    pub(crate) reading: &'a Reading,
}

/// What a set draws, once its source is open.
enum Drawing {
    Frames(frames::Drawing),
    Vector(vector::Drawing),
}

/// What an update of a set's drawing found.
#[derive(Default)]
pub(super) struct Updated {
    /// Whether the dataset changed.
    pub(super) changed: bool,
    /// Whether a wanted piece shows a placeholder, or nothing.
    pub(super) standing_in: bool,
    /// Whether a wanted piece draws nothing, or the source's base has not landed.
    pub(super) bare: bool,
    /// Whether a wanted piece is being fetched again after a refresh.
    pub(super) renewing: bool,
    /// Whether the drawing started over on its source's new base.
    pub(super) rebased: bool,
    /// A failure to report.
    pub(super) failure: Option<Error>,
}

impl Updated {
    /// While the source's base loads: every wanted piece draws nothing.
    pub(super) fn loading() -> Updated {
        Updated { standing_in: true, bare: true, ..Updated::default() }
    }

    /// Takes in what `drawn`, the update of one tiling of the set, found.
    pub(super) fn add<K>(&mut self, drawn: &super::tiling::Drawn<K>) {
        self.standing_in |= drawn.standing_in;
        self.bare |= drawn.bare;
        self.renewing |= drawn.renewing;
        if self.failure.is_none() {
            self.failure.clone_from(&drawn.failure);
        }
    }
}

/// Counter that numbers each set, so the cache can tell sets apart.
static SETS: AtomicU64 = AtomicU64::new(0);

/// One tile source a view draws: its dataset, and what it draws of the source's pieces.
struct TileSet {
    id: u64,
    tiles: Tiles,
    data: Snapshot,
    drawing: Option<Drawing>,
    /// Whether the dataset changed since it was last taken.
    changed: bool,
    /// Why the source or a piece the view wants could not be fetched, until it is.
    failure: Option<Error>,
    /// Whether a piece the view wanted at the last update showed a placeholder: an ancestor, finer
    /// pieces, or nothing.
    standing_in: bool,
    /// Whether a piece the view wanted at the last update drew nothing, or the base had not
    /// landed.
    bare: bool,
    /// Whether a piece the view wanted at the last update was being fetched again after a
    /// refresh.
    renewing: bool,
    /// Whether the set starts over on its source's new base, while the view draws the version
    /// before until each piece it wants draws something.
    rebasing: bool,
}

impl TileSet {
    fn new(tiles: Tiles) -> TileSet {
        TileSet {
            id: SETS.fetch_add(1, Ordering::Relaxed),
            data: Snapshot::new(tiles.name.clone()),
            tiles,
            drawing: None,
            changed: false,
            failure: None,
            standing_in: true,
            bare: true,
            renewing: false,
            rebasing: false,
        }
    }

    /// Whether the view may take the dataset: it is a whole version. That is never a new base
    /// before each piece the view wants draws something, nor part of a refresh, whose pieces
    /// land one by one. A piece that failed draws nothing, which counts as final.
    fn whole(&self) -> bool {
        !self.renewing && !self.rebasing
    }

    /// Stops drawing, so the source's pieces it claimed may be evicted.
    fn release(&self, cache: &mut Cache) {
        self.tiles.refreshes.views.unwatch(self.id);
        cache.release(&self.tiles, self.id);
    }

    /// Pieces drawn.
    fn drawn(&self) -> usize {
        match &self.drawing {
            Some(Drawing::Frames(frames)) => frames.drawn(),
            Some(Drawing::Vector(vector)) => vector.drawn(),
            None => 0,
        }
    }

    /// Updates the dataset to what the view needs, from what the cache holds of the source. Returns
    /// the failure that lasts, if any.
    fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, cache: &mut Cache, jobs: &Jobs<'_>) -> Option<Error> {
        self.tiles.refreshes.views.watch(self.id, jobs.waker());
        let fetched = cache.open(&self.tiles, self.id, jobs);
        let (waker, fetch) = (fetched.waker().clone(), fetched.fetch().cloned());
        let jobs = jobs.waking(&waker).fetching(fetch.as_ref());
        let holds = match &mut fetched.state {
            // A source opening again after the set drew, as vector tiles do when refreshed, starts
            // over like a new base.
            State::Opening(_) => {
                (self.standing_in, self.bare, self.renewing) = (true, true, false);
                self.rebasing |= self.drawing.is_some();
                return None;
            }
            State::Failed(error) => {
                (self.standing_in, self.bare, self.renewing) = (false, false, false);
                return Some(error.clone());
            }
            State::Open(holds) => holds,
        };
        let updated = match holds {
            Holds::Frames(fetched) => {
                if !matches!(self.drawing, Some(Drawing::Frames(_))) {
                    self.drawing = Some(Drawing::Frames(frames::Drawing::new(fetched)));
                }
                let Some(Drawing::Frames(drawing)) = &mut self.drawing else { unreachable!("made above") };
                drawing.update(self.id, &self.tiles.name, &mut self.data, asked.reading, fetched, &jobs)
            }
            Holds::Vector(fetched) => {
                if !matches!(self.drawing, Some(Drawing::Vector(_))) {
                    self.drawing = Some(Drawing::Vector(vector::Drawing::new()));
                }
                let Some(Drawing::Vector(drawing)) = &mut self.drawing else { unreachable!("made above") };
                drawing.update(self.id, input, &self.tiles.name, &mut self.data, asked.sight, fetched, &jobs)
            }
        };
        self.changed |= updated.changed;
        (self.standing_in, self.bare, self.renewing) = (updated.standing_in, updated.bare, updated.renewing);
        self.rebasing = (self.rebasing || updated.rebased) && updated.bare;
        updated.failure
    }
}

/// Every tile source a view was given.
#[derive(Default)]
pub(crate) struct TileSets {
    sets: Vec<TileSet>,
    /// Sets loading for sources given while the view draws others. They show nothing until every
    /// one of them can draw, then swap in together (see [`loaded`](TileSets::loaded)).
    incoming: Vec<TileSet>,
    /// Datasets the last update changed, for the view to take.
    changed: Vec<Snapshot>,
    /// Whether the failures of the sets drawn changed since last taken.
    failures_due: bool,
}

impl TileSets {
    /// Draws `tiles`, replacing any tiles of the same name and what they drew. Equal tiles keep what
    /// they drew, and follow the refreshes of `tiles`. Tiles that loaded beside the sets drawn swap
    /// in with what they loaded.
    pub(crate) fn set(&mut self, tiles: Tiles, cache: &mut Cache) {
        if let Some(set) = self.sets.iter_mut().find(|s| s.tiles == tiles) {
            set.tiles.refreshes.views.unwatch(set.id);
            set.tiles = tiles;
            return;
        }
        self.remove(&tiles.name, cache);
        let set = match self.incoming.iter().position(|s| s.tiles == tiles) {
            // The view takes what it loaded at once, in the frame the sources swap.
            Some(at) => {
                let mut set = self.incoming.swap_remove(at);
                set.changed = false;
                self.changed.push(set.data.clone());
                set
            }
            None => TileSet::new(tiles),
        };
        self.failures_due |= set.failure.is_some();
        self.sets.push(set);
    }

    /// Starts loading each of `tiles` that no set draws, beside the sets drawn, and stops loading
    /// any other. Returns whether any loads.
    pub(crate) fn load<'a>(&mut self, tiles: impl IntoIterator<Item = &'a Tiles>, cache: &mut Cache) -> bool {
        let new: Vec<&Tiles> = tiles.into_iter().filter(|&t| !self.sets.iter().any(|set| set.tiles == *t)).collect();
        self.incoming.retain(|set| {
            let kept = new.contains(&&set.tiles);
            if !kept {
                set.release(cache);
            }
            kept
        });
        for tiles in new {
            if !self.incoming.iter().any(|set| set.tiles == *tiles) {
                self.incoming.push(TileSet::new(tiles.clone()));
            }
        }
        !self.incoming.is_empty()
    }

    /// Whether every set loading beside the sets drawn can draw: its base landed, and each piece
    /// the view wants draws something, if only a placeholder. A source or piece that failed counts
    /// as final.
    pub(crate) fn loaded(&self) -> bool {
        self.incoming.iter().all(|set| !set.bare)
    }

    /// Stops drawing the tiles drawn as dataset `name`, and drops their changes the view has not
    /// taken yet.
    pub(crate) fn remove(&mut self, name: &str, cache: &mut Cache) {
        self.changed.retain(|data| **data.name() != *name);
        let due = &mut self.failures_due;
        self.sets.retain(|set| {
            let kept = *set.tiles.name != *name;
            if !kept {
                *due |= set.failure.is_some();
                set.release(cache);
            }
            kept
        });
    }

    /// Stops drawing every source, because the view no longer draws.
    pub(crate) fn release(&mut self, cache: &mut Cache) {
        self.changed.clear();
        self.failures_due |= self.sets.iter().any(|set| set.failure.is_some());
        for set in self.sets.drain(..).chain(self.incoming.drain(..)) {
            set.release(cache);
        }
    }

    /// Whether every piece the view wants is drawn rather than a placeholder (an ancestor, finer
    /// pieces, or nothing while its source opens), no refresh or source given is still loading,
    /// and the view took every changed dataset. A piece that could not be fetched draws nothing,
    /// which counts as final.
    pub(crate) fn complete(&self) -> bool {
        self.incoming.is_empty() && self.changed.is_empty() && self.sets.iter().all(|s| !s.standing_in && s.whole())
    }

    /// Whether changed datasets are waiting for the view to take them.
    pub(crate) fn pending(&self) -> bool {
        !self.changed.is_empty()
    }

    /// The number of pieces drawn across all sources, and the number being fetched or decoded.
    pub(crate) fn counts(&self, cache: &Cache) -> [u64; 2] {
        let drawn = self.sets.iter().map(|set| set.drawn() as u64).sum();
        let loading = self.sets.iter().chain(&self.incoming).map(|set| cache.under_way(&set.tiles) as u64).sum();
        [drawn, loading]
    }

    /// Whether the view draws dataset `name` from tiles, fetched as the view needs them.
    pub(crate) fn owns(&self, name: &str) -> bool {
        self.sets.iter().any(|s| *s.tiles.name == *name)
    }

    /// Whether the view draws dataset `name` from vector tiles, whose tables are always paged.
    pub(crate) fn vector(&self, name: &str) -> bool {
        self.sets.iter().any(|s| *s.tiles.name == *name && matches!(s.drawing, Some(Drawing::Vector(_))))
    }

    /// Adds to `choices` what each table of vector tiles draws, for the tables that `plans` draws
    /// by tile. A table draws the spans of the vector tiles drawn, within the plan's rows.
    pub(crate) fn choose(&self, plans: &Plans, choices: &mut Choices) {
        for set in &self.sets {
            let Some(Drawing::Vector(vector)) = &set.drawing else { continue };
            for table in set.data.tables() {
                let key = (set.tiles.name.clone(), table.name.clone());
                if let Some(Draw::Tiles { rows }) = plans.get(&key).map(|planned| planned.draw) {
                    choices.insert(key, vector.chosen(table, rows));
                }
            }
        }
    }

    /// The rows vector tiles supplied for dataset `name`, including their derived shape fields. The
    /// view takes them as the frame begins, so they match what it draws row for row.
    pub(crate) fn shaped(&self, name: &str) -> Option<&Snapshot> {
        let set = self.sets.iter().find(|s| *s.tiles.name == *name)?;
        match &set.drawing {
            Some(Drawing::Vector(vector)) => Some(vector.held()),
            _ => None,
        }
    }

    /// The datasets the updates changed since last taken.
    pub(crate) fn take_changed(&mut self) -> Vec<Snapshot> {
        std::mem::take(&mut self.changed)
    }

    /// Each source drawn that failed, or whose piece the view wants failed, named by the tiles'
    /// dataset, until it is fetched.
    pub(crate) fn failures(&self) -> impl Iterator<Item = Error> + '_ {
        self.sets.iter().filter_map(|set| set.failure.clone().map(|error| error.within(&set.tiles.name)))
    }

    /// Whether the failures changed since the last call.
    pub(crate) fn take_failures_due(&mut self) -> bool {
        std::mem::take(&mut self.failures_due)
    }

    /// Updates every set to what the view needs and the scene draws, from what `cache` holds.
    /// The view takes a set's dataset only as a whole version (see `TileSet::whole`). Sets loading
    /// beside them update alike, and show nothing until they swap in, failures included.
    pub(crate) fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, cache: &mut Cache, jobs: &Jobs<'_>) {
        for set in &mut self.sets {
            let failure = set.update(input, asked, cache, jobs);
            if failure != set.failure {
                set.failure = failure;
                self.failures_due = true;
            }
            if set.whole() && std::mem::take(&mut set.changed) {
                self.changed.retain(|data| data.name() != set.data.name());
                self.changed.push(set.data.clone());
            }
        }
        for set in &mut self.incoming {
            set.failure = set.update(input, asked, cache, jobs);
        }
    }
}
