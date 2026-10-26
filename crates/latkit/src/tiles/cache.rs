//! The tile cache: each tile source a GPU's views draw, by URL. A source is opened once, its pieces
//! are fetched and decoded once for every set drawing them, and it is released once no set draws
//! it. Work finishing for a source wakes every set drawing it, so a piece one view fetched draws in
//! all of them.

use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Wake, Waker};

use rustc_hash::FxHashMap;

use super::{frames, vector};
use crate::data::Manifest;
use crate::derive::Jobs;
use crate::host::Request;
use crate::{Error, Pending};

/// Bytes first read from an archive source (a URL ending in `.pmtiles`): its header, and in most
/// archives the root directory after it. Other sources are read whole.
const ARCHIVE_FIRST: u64 = 16_384;

/// Every tile source a GPU's views draw, by URL.
#[derive(Default)]
pub(crate) struct Cache {
    sources: FxHashMap<Arc<str>, Fetched>,
}

/// One tile source: its open state, and the waker for the sets drawing it.
pub(crate) struct Fetched {
    pub(crate) state: State,
    sets: Arc<Sets>,
    waker: Waker,
}

/// A source's open state.
pub(crate) enum State {
    /// Its first bytes are being fetched; they determine what it holds.
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

/// The sets drawing a source, each with its waker. Work finishing for the source wakes them all.
#[derive(Default)]
struct Sets(Mutex<Vec<(u64, Waker)>>);

impl Wake for Sets {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        let wakers: Vec<Waker> =
            self.0.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, w)| w.clone()).collect();
        for waker in wakers {
            waker.wake();
        }
    }
}

impl Cache {
    /// The source at `url`, registering set `set` as drawing it, to be woken by `jobs`'s waker as
    /// the source's work finishes. Starts opening the source if no set drew it before, and opens it
    /// as far as finished work allows.
    pub(crate) fn open(&mut self, url: &Arc<str>, set: u64, jobs: &Jobs<'_>) -> &mut Fetched {
        let fetched = match self.sources.entry(url.clone()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let sets = Arc::new(Sets::default());
                let waker = Waker::from(sets.clone());
                let state = start(url, &jobs.waking(&waker));
                entry.insert(Fetched { state, sets, waker })
            }
        };
        {
            let mut sets = fetched.sets.0.lock().unwrap_or_else(PoisonError::into_inner);
            if !sets.iter().any(|(s, _)| *s == set) {
                sets.push((set, jobs.waker().clone()));
            }
        }
        fetched.settle(url, jobs);
        fetched
    }

    /// Fetches and decodes in progress for the source at `url`.
    pub(crate) fn under_way(&self, url: &str) -> usize {
        self.sources.get(url).map_or(0, |fetched| match &fetched.state {
            State::Opening(_) => 1,
            State::Open(Holds::Frames(frames)) => frames.under_way(),
            State::Open(Holds::Vector(vector)) => vector.under_way(),
            State::Failed(_) => 0,
        })
    }

    /// Releases what set `set` drew of the source at `url`, and the source itself once no set draws
    /// it.
    pub(crate) fn release(&mut self, url: &str, set: u64) {
        let Some(fetched) = self.sources.get_mut(url) else { return };
        let left = {
            let mut sets = fetched.sets.0.lock().unwrap_or_else(PoisonError::into_inner);
            sets.retain(|(s, _)| *s != set);
            sets.len()
        };
        if left == 0 {
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

    /// Opens the source once its first bytes arrive: as time tiles if they hold a manifest, else as
    /// vector tiles.
    fn settle(&mut self, url: &Arc<str>, jobs: &Jobs<'_>) {
        let State::Opening(pending) = &self.state else { return };
        let Some(landed) = pending.take() else { return };
        let waker = self.waker.clone();
        let jobs = jobs.waking(&waker);
        self.state = match landed {
            Err(error) => State::Failed(error),
            Ok(bytes) => match Manifest::from_bytes(&bytes) {
                Some(Ok(manifest)) => State::Open(Holds::Frames(Box::new(frames::Fetched::open(url, manifest, &jobs)))),
                Some(Err(error)) => State::Failed(error),
                None => match vector::Fetched::open(url, &bytes, &jobs) {
                    Ok(vector) => State::Open(Holds::Vector(Box::new(vector))),
                    Err(reason) => State::Failed(Error::Io(reason.into())),
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
