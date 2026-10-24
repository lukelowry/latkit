//! What a view draws of the tiles it is given: for each source of tiles a set, whose dataset holds
//! the pieces the view's camera and plot window ask for, which marks draw like any other. The pieces
//! come from the GPU's cache, which every view drawing the same source shares.

use std::sync::atomic::{AtomicU64, Ordering};

use super::cache::{Cache, Holds, State};
use super::{frames, vector};
use crate::data::{Name, Snapshot};
use crate::derive::sight::Sight;
use crate::derive::{Input, Jobs};
use crate::{Error, Tiles};

/// What a view reads of sampled fields: the plot window lines trace across and the pixel columns it
/// spans, the coordinate fields are shown at, and each field marks read, by dataset, table, and
/// name, with whether a line traces it.
#[derive(Default)]
pub(crate) struct Reading {
    pub(crate) across: Option<[f64; 2]>,
    pub(crate) columns: u32,
    pub(crate) at: f64,
    pub(crate) fields: Vec<(Name, Name, Name, bool)>,
}

impl Reading {
    /// Whether a line traces field `field` of `table` in dataset `data`, and whether a mark shows it
    /// at the coordinate.
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

/// What the view asks of its tiles: the tiles the camera shows, on the earth, and what it reads of
/// sampled fields.
pub(crate) struct Asked<'a> {
    pub(crate) sight: Option<&'a Sight<'a>>,
    pub(crate) reading: &'a Reading,
}

/// What a set draws, once its source opened.
enum Drawing {
    Frames(frames::Drawing),
    Vector(vector::Drawing),
}

/// Sets made so far, which numbers each: the cache keeps what each draws apart.
static SETS: AtomicU64 = AtomicU64::new(0);

/// One source of tiles a view draws: its dataset, and what it draws of the source's pieces.
struct TileSet {
    id: u64,
    tiles: Tiles,
    data: Snapshot,
    drawing: Option<Drawing>,
    /// Whether the dataset changed since it was last taken.
    changed: bool,
    /// The rows of vector tiles the view took last, with their shapes: the rows it draws, which a
    /// later update may have moved past until the next frame takes them.
    taken: Option<Snapshot>,
    /// Whether a failure was told: a source that went away tells it once.
    told: bool,
    /// Whether a piece the view wanted at the last update drew an ancestor, or nothing, instead.
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
            taken: None,
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

    /// Brings the dataset up to what the view asks, from what the cache holds of the source; a
    /// failure to tell, if any.
    fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, cache: &mut Cache, jobs: &Jobs<'_>) -> Option<Error> {
        self.standing_in = false;
        let fetched = cache.open(&self.tiles.url, self.id, jobs);
        let waker = fetched.waker().clone();
        let jobs = jobs.waking(&waker);
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

/// Every source of tiles a view was given.
#[derive(Default)]
pub(crate) struct TileSets {
    sets: Vec<TileSet>,
    /// Datasets the last update changed, for the view to take.
    changed: Vec<Snapshot>,
    errors: Vec<Error>,
}

impl TileSets {
    /// Draws `tiles`: tiles of the same name replace these, and what they drew goes.
    pub(crate) fn set(&mut self, tiles: Tiles, cache: &mut Cache) {
        if self.sets.iter().any(|s| s.tiles == tiles) {
            return;
        }
        self.remove(&tiles.name, cache);
        self.sets.push(TileSet::new(tiles));
    }

    /// Stops drawing the tiles drawn as dataset `name`, and what they changed that the view has yet to
    /// take.
    pub(crate) fn remove(&mut self, name: &str, cache: &mut Cache) {
        self.changed.retain(|data| **data.name() != *name);
        self.sets.retain(|set| {
            let kept = *set.tiles.name != *name;
            if !kept {
                cache.release(&set.tiles.url, set.id);
            }
            kept
        });
    }

    /// Stops drawing every source: the view draws no more.
    pub(crate) fn release(&mut self, cache: &mut Cache) {
        self.changed.clear();
        for set in self.sets.drain(..) {
            cache.release(&set.tiles.url, set.id);
        }
    }

    /// Whether every piece the view wants draws itself: none stands in by an ancestor, or by nothing
    /// while its source opens, and the view took every dataset they changed. A piece that could not
    /// be fetched draws nothing, and is final.
    pub(crate) fn complete(&self) -> bool {
        self.changed.is_empty() && self.sets.iter().all(|s| !s.standing_in)
    }

    /// Whether datasets the updates changed wait for the view to take them.
    pub(crate) fn pending(&self) -> bool {
        !self.changed.is_empty()
    }

    /// The pieces every source draws, and those being fetched or decoded.
    pub(crate) fn counts(&self, cache: &Cache) -> [u64; 2] {
        let drawn = self.sets.iter().map(|set| set.drawn() as u64).sum();
        let loading = self.sets.iter().map(|set| cache.under_way(&set.tiles.url) as u64).sum();
        [drawn, loading]
    }

    /// Whether the view draws dataset `name` from tiles: pieces fetched as the view asks, drawn as
    /// they are.
    pub(crate) fn owns(&self, name: &str) -> bool {
        self.sets.iter().any(|s| *s.tiles.name == *name)
    }

    /// The rows of vector tiles of dataset `name` the view took, each table with the fields its
    /// shapes are written as too: row for row the dataset it draws.
    pub(crate) fn shaped(&self, name: &str) -> Option<&Snapshot> {
        self.sets.iter().find(|s| *s.tiles.name == *name)?.taken.as_ref()
    }

    /// The datasets the updates changed since last taken; the rows of vector tiles they hold become
    /// those their shapes are taken from.
    pub(crate) fn take_changed(&mut self) -> Vec<Snapshot> {
        for set in self.sets.iter_mut().filter(|s| self.changed.iter().any(|d| d.name() == s.data.name())) {
            if let Some(Drawing::Vector(vector)) = &set.drawing {
                set.taken = Some(vector.held().clone());
            }
        }
        std::mem::take(&mut self.changed)
    }

    /// Failures since last asked.
    pub(crate) fn take_errors(&mut self) -> Vec<Error> {
        std::mem::take(&mut self.errors)
    }

    /// Brings every set up to what the view asks and the scene draws, from what `cache` holds.
    pub(crate) fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, cache: &mut Cache, jobs: &Jobs<'_>) {
        for set in &mut self.sets {
            if let Some(error) = set.update(input, asked, cache, jobs)
                && !set.told
            {
                set.told = true;
                self.errors.push(Error::Io(format!("tiles {}: {error}", set.tiles.name).into()));
            }
            if std::mem::take(&mut set.changed) {
                self.changed.retain(|data| data.name() != set.data.name());
                self.changed.push(set.data.clone());
            }
        }
    }
}
