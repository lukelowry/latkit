//! The tile cache holds each tile source a GPU's views draw, by URL and fetch. A source is opened
//! once, and its pieces are fetched and decoded once for every set drawing them. When work for a
//! source finishes, it wakes every set drawing the source, so a piece one view fetched draws in all
//! of them.
//!
//! A source stays while a set draws it or any [`Tiles`] naming it lives, so a view that stops
//! drawing tiles and starts again finds what it fetched. Every source's pieces share one budget of
//! bytes. Past it, the pieces no set draws are evicted, least recently drawn first.

use std::collections::hash_map::Entry;
use std::sync::{Arc, Weak};
use std::task::Waker;

use rustc_hash::FxHashMap;

use super::index::Index;
use super::tiling::Kept;
use super::{Refreshes, Shared, Tiles, frames, vector};
use crate::derive::Jobs;
use crate::host::Request;
use crate::pending::Watchers;
use crate::{Error, Pending};

/// Every tile source a GPU's views draw, by URL and fetch.
#[derive(Default)]
pub(crate) struct Cache {
    sources: FxHashMap<Shared, Fetched>,
}

/// One tile source: its open state, the sets drawing it, the tiles naming it, and the waker that
/// wakes the sets as the source's work finishes. It fetches with the tiles' own fetch when they
/// have one. `refreshed` is the refresh of the tiles it holds, and `refreshing` the index fetched
/// again for a newer one.
pub(crate) struct Fetched {
    pub(crate) state: State,
    sets: Arc<Watchers>,
    named: Vec<Weak<Refreshes>>,
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

impl Holds {
    /// Its tilings: one for each sampled field of time tiles, or the vector tiles' one.
    fn kept(&mut self) -> Vec<&mut dyn Kept> {
        match self {
            Holds::Frames(frames) => frames.fields.iter_mut().map(|tiling| tiling as &mut dyn Kept).collect(),
            Holds::Vector(vector) => vec![&mut vector.tiling],
        }
    }
}

impl Cache {
    /// The source of `tiles`, with set `set` registered as drawing it. `jobs`'s waker wakes the set
    /// as the source's work finishes. Starts opening the source if the cache does not hold it,
    /// fetches its index again when the tiles were refreshed since, and opens it as far as finished
    /// work allows.
    pub(crate) fn open(&mut self, tiles: &Tiles, set: u64, jobs: &Jobs<'_>) -> &mut Fetched {
        let url = &tiles.url;
        let fetched = match self.sources.entry(tiles.shared()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let sets = Arc::new(Watchers::default());
                let waker = Waker::from(sets.clone());
                let fetch = tiles.fetch.clone();
                let state = start(url, &jobs.waking(&waker).fetching(fetch.as_ref()));
                let refreshed = tiles.refreshed();
                entry.insert(Fetched { state, sets, named: Vec::new(), waker, fetch, refreshed, refreshing: None })
            }
        };
        fetched.sets.watch(set, jobs.waker());
        if !fetched.named.iter().any(|named| std::ptr::eq(named.as_ptr(), Arc::as_ptr(&tiles.refreshes))) {
            fetched.named.push(Arc::downgrade(&tiles.refreshes));
        }
        if tiles.refreshed() > fetched.refreshed {
            fetched.refresh(url, tiles.refreshed(), jobs);
        }
        fetched.settle(url, jobs);
        fetched
    }

    /// Fetches and decodes in progress for the source of `tiles`.
    pub(crate) fn under_way(&self, tiles: &Tiles) -> usize {
        self.sources.get(&tiles.shared()).map_or(0, |fetched| {
            usize::from(fetched.refreshing.is_some())
                + match &fetched.state {
                    State::Opening(_) => 1,
                    State::Open(Holds::Frames(frames)) => frames.under_way(),
                    State::Open(Holds::Vector(vector)) => vector.under_way(),
                    State::Failed(_) => 0,
                }
        })
    }

    /// Releases what set `set` drew of the source of `tiles`. The source keeps its pieces, for a
    /// set that draws it again.
    pub(crate) fn release(&mut self, tiles: &Tiles, set: u64) {
        let Some(fetched) = self.sources.get_mut(&tiles.shared()) else { return };
        fetched.sets.unwatch(set);
        if let State::Open(holds) = &mut fetched.state {
            holds.kept().into_iter().for_each(|tiling| tiling.release(set));
        }
    }

    /// Drops each source that no set draws and no `Tiles` names any more. Then, while the pieces
    /// kept take more than `budget` bytes, evicts those no set draws, least recently drawn first.
    /// Pieces a set draws always stay.
    pub(crate) fn trim(&mut self, budget: u64) {
        self.sources.retain(|_, fetched| {
            fetched.named.retain(|named| named.strong_count() > 0);
            !fetched.named.is_empty() || !fetched.sets.is_empty()
        });
        let mut tilings: Vec<&mut dyn Kept> = (self.sources.values_mut())
            .filter_map(|fetched| match &mut fetched.state {
                State::Open(holds) => Some(holds.kept()),
                State::Opening(_) | State::Failed(_) => None,
            })
            .flatten()
            .collect();
        let held: u64 = tilings.iter().map(|tiling| tiling.bytes() as u64).sum();
        if held <= budget {
            return;
        }
        let mut idle: Vec<(u64, usize)> = Vec::new();
        tilings.iter().for_each(|tiling| tiling.idle(&mut idle));
        idle.sort_unstable();
        // Evict every idle piece up to the one whose bytes bring the cache within its budget.
        let (mut over, mut drew) = (held - budget, None);
        for (used, bytes) in idle {
            if over == 0 {
                break;
            }
            (over, drew) = (over.saturating_sub(bytes as u64), Some(used));
        }
        if let Some(drew) = drew {
            tilings.iter_mut().for_each(|tiling| tiling.evict(drew));
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

    /// Opens the source once its first bytes arrive, as what its index says it holds. Takes the
    /// index fetched again, once it arrives.
    fn settle(&mut self, url: &Arc<str>, jobs: &Jobs<'_>) {
        if let Some(landed) = self.refreshing.as_ref().and_then(Pending::take) {
            self.refreshing = None;
            let fetch = self.fetch.clone();
            let jobs = jobs.waking(&self.waker).fetching(fetch.as_ref());
            if let (State::Open(Holds::Frames(frames)), Ok(bytes)) = (&mut self.state, landed)
                && let Ok(Index::Frames(manifest)) = Index::read(url, &bytes)
            {
                frames.refresh(url, manifest, &jobs);
            }
        }
        let State::Opening(pending) = &self.state else { return };
        let Some(landed) = pending.take() else { return };
        let (waker, fetch) = (self.waker.clone(), self.fetch.clone());
        let jobs = jobs.waking(&waker).fetching(fetch.as_ref());
        self.state = match landed.and_then(|bytes| opened(url, Index::read(url, &bytes)?, &bytes, &jobs)) {
            Ok(holds) => State::Open(holds),
            Err(error) => State::Failed(error),
        };
    }
}

/// Starts opening the source at `url`. A URL template is vector tiles, open at once. Any other
/// source opens once its first bytes arrive.
fn start(url: &Arc<str>, jobs: &Jobs<'_>) -> State {
    match Index::given(url) {
        Some(index) => opened(url, index, &[], jobs).map_or_else(State::Failed, State::Open),
        None => State::Opening(jobs.fetch(&Index::request(url))),
    }
}

/// What the source at `url` holds, by its `index`, read from its first `bytes`.
fn opened(url: &Arc<str>, index: Index, bytes: &[u8], jobs: &Jobs<'_>) -> crate::Result<Holds> {
    Ok(match index {
        Index::Frames(manifest) => Holds::Frames(Box::new(frames::Fetched::open(url, manifest, jobs))),
        Index::Template(template, _) => Holds::Vector(Box::new(vector::Fetched::template(url, template))),
        Index::Archive(header) => {
            Holds::Vector(Box::new(vector::Fetched::archive(url, header, bytes, jobs).map_err(Error::invalid)?))
        }
    })
}
