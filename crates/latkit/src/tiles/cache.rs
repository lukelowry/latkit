//! The tile cache holds each tile source a GPU's views draw, by URL. A source is opened once, and
//! its pieces are fetched and decoded once for every set drawing them. It is released once no set
//! draws it. When work for a source finishes, it wakes every set drawing the source, so a piece one
//! view fetched draws in all of them.

use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::task::Waker;

use rustc_hash::FxHashMap;

use super::{frames, vector};
use crate::data::Manifest;
use crate::derive::Jobs;
use crate::host::Request;
use crate::pending::Watchers;
use crate::{Error, Pending};

/// Bytes first read from an archive source (a URL ending in `.pmtiles`). They hold its header and,
/// in most archives, the root directory after it. Other sources are read whole.
const ARCHIVE_FIRST: u64 = 16_384;

/// Every tile source a GPU's views draw, by URL.
#[derive(Default)]
pub(crate) struct Cache {
    sources: FxHashMap<Arc<str>, Fetched>,
}

/// One tile source: its open state, the sets drawing it, and the waker that wakes them all as the
/// source's work finishes. It fetches with the tiles' own fetch when they have one. `refreshed` is
/// the refresh of the tiles it holds, and `refreshing` the index fetched again for a newer one.
pub(crate) struct Fetched {
    pub(crate) state: State,
    sets: Arc<Watchers>,
    waker: Waker,
    fetch: Option<super::Fetch>,
    refreshed: u64,
    refreshing: Option<Pending<Vec<u8>>>,
}

/// A source's open state.
pub(crate) enum State {
    /// Its first bytes are being fetched. They determine what it holds.
    Opening(Pending<Vec<u8>>),
    Open(Holds),
    /// It could not be opened, with the reason.
    Failed(Error),
}

/// What an open source holds: time tiles, or vector tiles.
pub(crate) enum Holds {
    Frames(Box<frames::Fetched>),
    Vector(Box<vector::Fetched>),
}

impl Cache {
    /// The source of `tiles`, with set `set` registered as drawing it. `jobs`'s waker wakes the set
    /// as the source's work finishes. Starts opening the source if no set drew it before, fetches
    /// its index again when the tiles were refreshed since, and opens it as far as finished work
    /// allows.
    pub(crate) fn open(&mut self, tiles: &super::Tiles, set: u64, jobs: &Jobs<'_>) -> &mut Fetched {
        let url = &tiles.url;
        let fetched = match self.sources.entry(url.clone()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let sets = Arc::new(Watchers::default());
                let waker = Waker::from(sets.clone());
                let fetch = tiles.fetch.clone();
                let state = start(url, &jobs.waking(&waker).fetching(fetch.as_ref()));
                entry.insert(Fetched { state, sets, waker, fetch, refreshed: tiles.refreshed(), refreshing: None })
            }
        };
        fetched.sets.watch(set, jobs.waker());
        if tiles.refreshed() > fetched.refreshed {
            fetched.refresh(url, tiles.refreshed(), jobs);
        }
        fetched.settle(url, jobs);
        fetched
    }

    /// Fetches and decodes in progress for the source at `url`.
    pub(crate) fn under_way(&self, url: &str) -> usize {
        self.sources.get(url).map_or(0, |fetched| {
            usize::from(fetched.refreshing.is_some())
                + match &fetched.state {
                    State::Opening(_) => 1,
                    State::Open(Holds::Frames(frames)) => frames.under_way(),
                    State::Open(Holds::Vector(vector)) => vector.under_way(),
                    State::Failed(_) => 0,
                }
        })
    }

    /// Releases what set `set` drew of the source at `url`, and the source itself once no set draws
    /// it.
    pub(crate) fn release(&mut self, url: &str, set: u64) {
        let Some(fetched) = self.sources.get_mut(url) else { return };
        if fetched.sets.unwatch(set) == 0 {
            self.sources.remove(url);
            return;
        }
        match &mut fetched.state {
            State::Open(Holds::Frames(frames)) => frames.release(set),
            State::Open(Holds::Vector(vector)) => vector.release(set),
            State::Opening(_) | State::Failed(_) => {}
        }
    }
}

impl Fetched {
    /// The waker for every set drawing the source.
    pub(crate) fn waker(&self) -> &Waker {
        &self.waker
    }

    /// The tiles' own fetch, if they have one.
    pub(crate) fn fetch(&self) -> Option<&super::Fetch> {
        self.fetch.as_ref()
    }

    /// `jobs` for the source's work: fetching as the source does, and waking every set drawing it.
    fn jobs<'b>(&'b self, jobs: &'b Jobs<'_>) -> Jobs<'b> {
        jobs.waking(&self.waker).fetching(self.fetch.as_ref())
    }

    /// Fetches the source's index again, for its tiles' refresh `refreshed`. Open time tiles keep
    /// drawing until it arrives. Other sources start over.
    fn refresh(&mut self, url: &Arc<str>, refreshed: u64, jobs: &Jobs<'_>) {
        self.refreshed = refreshed;
        let jobs = self.jobs(jobs);
        if matches!(self.state, State::Open(Holds::Frames(_))) {
            let refreshing = jobs.fetch(&Request::new(url.clone()));
            self.refreshing = Some(refreshing);
        } else {
            let state = start(url, &jobs);
            self.state = state;
        }
    }

    /// Opens the source once its first bytes arrive: as time tiles if they hold a manifest, else as
    /// vector tiles. Takes the index fetched again, once it arrives.
    fn settle(&mut self, url: &Arc<str>, jobs: &Jobs<'_>) {
        if let Some(landed) = self.refreshing.as_ref().and_then(Pending::take) {
            self.refreshing = None;
            let fetch = self.fetch.clone();
            let jobs = jobs.waking(&self.waker).fetching(fetch.as_ref());
            if let (State::Open(Holds::Frames(frames)), Ok(bytes)) = (&mut self.state, landed)
                && let Some(Ok(manifest)) = Manifest::from_bytes(&bytes)
            {
                frames.refresh(url, manifest, &jobs);
            }
        }
        let State::Opening(pending) = &self.state else { return };
        let Some(landed) = pending.take() else { return };
        let (waker, fetch) = (self.waker.clone(), self.fetch.clone());
        let jobs = jobs.waking(&waker).fetching(fetch.as_ref());
        self.state = match landed {
            Err(error) => State::Failed(error),
            Ok(bytes) => match Manifest::from_bytes(&bytes) {
                Some(Ok(manifest)) => State::Open(Holds::Frames(Box::new(frames::Fetched::open(url, manifest, &jobs)))),
                Some(Err(error)) => State::Failed(error),
                None => match vector::Fetched::open(url, &bytes, &jobs) {
                    Ok(vector) => State::Open(Holds::Vector(Box::new(vector))),
                    // The bytes arrived, but they are not a tile index.
                    Err(reason) => State::Failed(Error::invalid(reason)),
                },
            },
        };
    }
}

/// Starts opening the source at `url`. A URL template is vector tiles, open at once. An archive is
/// read in ranges, starting with its header. A document is read whole.
fn start(url: &Arc<str>, jobs: &Jobs<'_>) -> State {
    if url.contains("{z}") {
        return State::Open(Holds::Vector(Box::new(vector::Fetched::template(url))));
    }
    let archive = url.split(['?', '#']).next().is_some_and(|path| path.ends_with(".pmtiles"));
    let request = if archive { Request::range(url.clone(), 0..ARCHIVE_FIRST) } else { Request::new(url.clone()) };
    State::Opening(jobs.fetch(&request))
}
