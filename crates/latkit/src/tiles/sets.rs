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

/// What a view reads of sampled fields. It holds the plot window that lines trace across (`across`)
/// and its width in pixel columns, and the coordinate at which fields are shown (`at`). It also
/// holds each field that marks read, by dataset, table, and name, with whether a line traces it.
#[derive(Default)]
pub(crate) struct Reading {
    pub(crate) across: Option<[f64; 2]>,
    pub(crate) columns: u32,
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
    /// Whether a failure was reported. A failed source reports it once.
    told: bool,
    /// Whether a piece the view wanted at the last update showed a placeholder: an ancestor, or
    /// nothing.
    standing_in: bool,
}

impl TileSet {
    fn new(tiles: Tiles) -> TileSet {
        TileSet {
            id: SETS.fetch_add(1, Ordering::Relaxed),
            data: Snapshot::new(tiles.name.clone()),
            tiles,
            drawing: None,
            changed: false,
            told: false,
            standing_in: true,
        }
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
    /// a failure to report, if any.
    fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, cache: &mut Cache, jobs: &Jobs<'_>) -> Option<Error> {
        self.standing_in = false;
        self.tiles.refreshes.views.watch(self.id, jobs.waker());
        let fetched = cache.open(&self.tiles, self.id, jobs);
        let (waker, fetch) = (fetched.waker().clone(), fetched.fetch().cloned());
        let jobs = jobs.waking(&waker).fetching(fetch.as_ref());
        let holds = match &mut fetched.state {
            State::Opening(_) => {
                self.standing_in = true;
                return None;
            }
            State::Failed(error) => return Some(error.clone()),
            State::Open(holds) => holds,
        };
        let (changed, standing_in, failure) = match holds {
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
        self.changed |= changed;
        self.standing_in = standing_in;
        failure
    }
}

/// Every tile source a view was given.
#[derive(Default)]
pub(crate) struct TileSets {
    sets: Vec<TileSet>,
    /// Datasets the last update changed, for the view to take.
    changed: Vec<Snapshot>,
    errors: Vec<Error>,
}

impl TileSets {
    /// Draws `tiles`, replacing any tiles of the same name and what they drew. Equal tiles keep what
    /// they drew, and follow the refreshes of `tiles`.
    pub(crate) fn set(&mut self, tiles: Tiles, cache: &mut Cache) {
        if let Some(set) = self.sets.iter_mut().find(|s| s.tiles == tiles) {
            set.tiles.refreshes.views.unwatch(set.id);
            set.tiles = tiles;
            return;
        }
        self.remove(&tiles.name, cache);
        self.sets.push(TileSet::new(tiles));
    }

    /// Stops drawing the tiles drawn as dataset `name`, and drops their changes the view has not
    /// taken yet.
    pub(crate) fn remove(&mut self, name: &str, cache: &mut Cache) {
        self.changed.retain(|data| **data.name() != *name);
        self.sets.retain(|set| {
            let kept = *set.tiles.name != *name;
            if !kept {
                set.tiles.refreshes.views.unwatch(set.id);
                cache.release(&set.tiles.url, set.id);
            }
            kept
        });
    }

    /// Stops drawing every source, because the view no longer draws.
    pub(crate) fn release(&mut self, cache: &mut Cache) {
        self.changed.clear();
        for set in self.sets.drain(..) {
            set.tiles.refreshes.views.unwatch(set.id);
            cache.release(&set.tiles.url, set.id);
        }
    }

    /// Whether every piece the view wants is drawn rather than a placeholder (an ancestor, or
    /// nothing while its source opens), and the view took every changed dataset. A piece that could
    /// not be fetched draws nothing, which counts as final.
    pub(crate) fn complete(&self) -> bool {
        self.changed.is_empty() && self.sets.iter().all(|s| !s.standing_in)
    }

    /// Whether changed datasets are waiting for the view to take them.
    pub(crate) fn pending(&self) -> bool {
        !self.changed.is_empty()
    }

    /// The number of pieces drawn across all sources, and the number being fetched or decoded.
    pub(crate) fn counts(&self, cache: &Cache) -> [u64; 2] {
        let drawn = self.sets.iter().map(|set| set.drawn() as u64).sum();
        let loading = self.sets.iter().map(|set| cache.under_way(&set.tiles.url) as u64).sum();
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

    /// Failures since the last call.
    pub(crate) fn take_errors(&mut self) -> Vec<Error> {
        std::mem::take(&mut self.errors)
    }

    /// Updates every set to what the view needs and the scene draws, from what `cache` holds.
    pub(crate) fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, cache: &mut Cache, jobs: &Jobs<'_>) {
        for set in &mut self.sets {
            if let Some(error) = set.update(input, asked, cache, jobs)
                && !set.told
            {
                set.told = true;
                self.errors.push(error.within(&set.tiles.name));
            }
            if std::mem::take(&mut set.changed) {
                self.changed.retain(|data| data.name() != set.data.name());
                self.changed.push(set.data.clone());
            }
        }
    }
}
