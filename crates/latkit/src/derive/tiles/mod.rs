//! Tiles: what a view fetches in pieces as it asks for them, kept as datasets the view owns, which
//! marks draw like any other. A source's first bytes say what it holds: a manifest of time tiles,
//! whose spans of sampled fields the plot window and the shown coordinate ask for; or a PMTiles
//! archive, a TileJSON document, or a URL template, which hold vector tiles the camera asks for (the
//! `geo` part).

mod frames;
mod vector;

use super::sight::Sight;
use super::{Input, Jobs};
use crate::data::{Data, Manifest, Name};
use crate::host::Request;
use crate::{Error, Pending, Tiles};

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
    fn reads(&self, data: &str, table: &str, field: &str) -> (bool, bool) {
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

/// What a source holds, once its first bytes said.
enum Holds {
    Frames(Box<frames::Frames>),
    Vector(Box<vector::Vector>),
}

impl Holds {
    /// Pieces drawn.
    fn drawn(&self) -> usize {
        match self {
            Holds::Frames(frames) => frames.drawn(),
            Holds::Vector(vector) => vector.drawn(),
        }
    }

    /// Fetches and decodes under way.
    fn under_way(&self) -> usize {
        match self {
            Holds::Frames(frames) => frames.under_way(),
            Holds::Vector(vector) => vector.under_way(),
        }
    }

    /// Brings `data`, dataset `name`, up to what the view asks: whether it changed, whether a piece
    /// stands in, and a failure to tell.
    fn update(
        &mut self,
        input: &Input<'_>,
        name: &Name,
        data: &mut Data,
        asked: &Asked<'_>,
        jobs: &Jobs<'_>,
    ) -> (bool, bool, Option<Error>) {
        match self {
            Holds::Frames(frames) => frames.update(name, data, asked.reading, jobs),
            Holds::Vector(vector) => vector.update(input, name, data, asked.sight, jobs),
        }
    }
}

/// What the view asks of its tiles: the tiles the camera shows, on the earth, and what it reads of
/// sampled fields.
pub(crate) struct Asked<'a> {
    pub(crate) sight: Option<&'a Sight<'a>>,
    pub(crate) reading: &'a Reading,
}

/// Where a set's pieces come from, as its source opens.
enum Source {
    Unopened,
    /// The URL's first bytes, which say what it holds.
    Opening(Pending<Vec<u8>>),
    Open(Holds),
    Failed,
}

/// A source's pieces: where they come from, and the dataset they make.
struct TileSet {
    tiles: Tiles,
    source: Source,
    data: Data,
    /// Whether the dataset changed since it was last taken.
    changed: bool,
    /// Whether a failure was told: a source that went away tells it once.
    told: bool,
    /// Whether a piece the view wanted at the last update drew an ancestor, or nothing, instead.
    standing_in: bool,
}

impl TileSet {
    fn new(tiles: Tiles) -> TileSet {
        TileSet {
            data: Data::new(tiles.name.clone()),
            tiles,
            source: Source::Unopened,
            changed: false,
            told: false,
            standing_in: false,
        }
    }
}

/// Every source of tiles a view was given.
#[derive(Default)]
pub(crate) struct TileSets {
    sets: Vec<TileSet>,
    /// Datasets the last update changed, for the view to take.
    changed: Vec<Data>,
    errors: Vec<Error>,
}

impl TileSets {
    /// Fetches tiles from `tiles` as the view asks; tiles of the same name replace these.
    pub(crate) fn set(&mut self, tiles: Tiles) {
        if self.sets.iter().any(|s| s.tiles == tiles) {
            return;
        }
        self.sets.retain(|s| s.tiles.name != tiles.name);
        self.sets.push(TileSet::new(tiles));
    }

    /// Whether every piece the view wants draws itself: none stands in by an ancestor, or by nothing
    /// while its source opens. A piece that could not be fetched draws nothing, and is final.
    pub(crate) fn complete(&self) -> bool {
        self.sets.iter().all(|s| !matches!(s.source, Source::Unopened | Source::Opening(_)) && !s.standing_in)
    }

    /// The pieces every source draws, and those being fetched or decoded.
    pub(crate) fn counts(&self) -> [u64; 2] {
        let mut counts = [0, 0];
        for set in &self.sets {
            if let Source::Open(holds) = &set.source {
                counts[0] += holds.drawn() as u64;
                counts[1] += holds.under_way() as u64;
            }
        }
        counts
    }

    /// Whether the view owns dataset `name`: pieces fetched as the view asks, drawn as they are.
    pub(crate) fn owns(&self, name: &str) -> bool {
        self.sets.iter().any(|s| *s.tiles.name == *name)
    }

    /// Stops fetching the pieces drawn as dataset `name`.
    pub(crate) fn remove(&mut self, name: &str) {
        self.sets.retain(|s| s.tiles.name != name);
    }

    /// The datasets the last update changed.
    pub(crate) fn take_changed(&mut self) -> Vec<Data> {
        std::mem::take(&mut self.changed)
    }

    /// Failures since last asked.
    pub(crate) fn take_errors(&mut self) -> Vec<Error> {
        std::mem::take(&mut self.errors)
    }

    /// Brings every source up to what the view asks and the scene draws.
    pub(crate) fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, jobs: &Jobs<'_>) {
        for set in &mut self.sets {
            if let Some(error) = set.update(input, asked, jobs)
                && !set.told
            {
                set.told = true;
                self.errors.push(Error::Io(format!("tiles {}: {error}", set.tiles.name).into()));
            }
            if std::mem::take(&mut set.changed) {
                self.changed.push(set.data.clone());
            }
        }
    }
}

impl TileSet {
    /// Brings the pieces up to what the view asks; a failure to tell, if any.
    fn update(&mut self, input: &Input<'_>, asked: &Asked<'_>, jobs: &Jobs<'_>) -> Option<Error> {
        self.standing_in = false;
        let failure = self.open(jobs);
        let Source::Open(holds) = &mut self.source else { return failure };
        let (changed, standing_in, failed) = holds.update(input, &self.tiles.name, &mut self.data, asked, jobs);
        self.changed |= changed;
        self.standing_in = standing_in;
        failure.or(failed)
    }

    /// Opens the source as far as what landed allows; a failure to tell, if any.
    fn open(&mut self, jobs: &Jobs<'_>) -> Option<Error> {
        let url = self.tiles.url.clone();
        if matches!(self.source, Source::Unopened) {
            if url.contains("{z}") {
                return self.vector(|| Ok(vector::Vector::template(&url)));
            }
            // An archive is read in ranges, from its header; a document whole.
            let archive = url.split(['?', '#']).next().is_some_and(|path| path.ends_with(".pmtiles"));
            let request = if archive {
                Request::range(url.clone(), 0..crate::tiles::ARCHIVE_FIRST)
            } else {
                Request::new(url.clone())
            };
            self.source = Source::Opening(jobs.fetch(&request));
        }
        let Source::Opening(pending) = &self.source else { return None };
        let bytes = match pending.take()? {
            Ok(bytes) => bytes,
            Err(error) => {
                self.source = Source::Failed;
                return Some(error);
            }
        };
        match Manifest::from_bytes(&bytes) {
            Some(Ok(manifest)) => {
                self.source = Source::Open(Holds::Frames(Box::new(frames::Frames::open(&url, manifest, jobs))));
                return None;
            }
            Some(Err(error)) => {
                self.source = Source::Failed;
                return Some(error);
            }
            None => {}
        }
        self.vector(|| vector::Vector::open(&url, &bytes, jobs))
    }

    /// Opens the source as vector tiles `make` makes.
    fn vector(&mut self, make: impl FnOnce() -> Result<vector::Vector, String>) -> Option<Error> {
        match make() {
            Ok(vector) => {
                self.source = Source::Open(Holds::Vector(Box::new(vector)));
                None
            }
            Err(reason) => {
                self.source = Source::Failed;
                Some(Error::Io(reason.into()))
            }
        }
    }
}
