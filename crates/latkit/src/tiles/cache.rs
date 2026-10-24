//! What a GPU fetched of each source of tiles, by URL: opened once, its pieces fetched and decoded
//! once for every set drawing them, and let go of once none does. Work landing for the source wakes
//! every set drawing it, so a piece one view fetched draws in each.

use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Wake, Waker};

use rustc_hash::FxHashMap;

use super::{frames, vector};
use crate::data::Manifest;
use crate::derive::Jobs;
use crate::host::Request;
use crate::{Error, Pending};

/// Bytes read first of a source that is an archive, as a URL ending in `.pmtiles` names: its header,
/// and in most archives the root directory after it. Any other source is read whole.
const ARCHIVE_FIRST: u64 = 16_384;

/// Every source of tiles a GPU's views draw, by URL.
#[derive(Default)]
pub(crate) struct Cache {
    sources: FxHashMap<Arc<str>, Fetched>,
}

/// One source of tiles: how far it opened, and what wakes the sets drawing it.
pub(crate) struct Fetched {
    pub(crate) state: State,
    sets: Arc<Sets>,
    waker: Waker,
}

/// How far a source opened.
pub(crate) enum State {
    /// Its first bytes are being fetched; they say what it holds.
    Opening(Pending<Vec<u8>>),
    Open(Holds),
    /// It could not be opened, and why.
    Failed(Error),
}

/// What an open source holds: time tiles, or vector tiles.
pub(crate) enum Holds {
    Frames(Box<frames::Fetched>),
    Vector(Box<vector::Fetched>),
}

/// The sets drawing a source, each with what wakes it: work landing for the source wakes them all.
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
    /// The source at `url`, with set `set` drawing it and woken by `jobs`'s waker as its work lands:
    /// opened as far as what landed allows, its first bytes asked for where no set drew it before.
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

    /// Fetches and decodes under way for the source at `url`.
    pub(crate) fn under_way(&self, url: &str) -> usize {
        self.sources.get(url).map_or(0, |fetched| match &fetched.state {
            State::Opening(_) => 1,
            State::Open(Holds::Frames(frames)) => frames.under_way(),
            State::Open(Holds::Vector(vector)) => vector.under_way(),
            State::Failed(_) => 0,
        })
    }

    /// Lets go of what set `set` drew of the source at `url`; once no set draws it, of the source.
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
    /// What wakes every set drawing the source.
    pub(crate) fn waker(&self) -> &Waker {
        &self.waker
    }

    /// Opens the source once its first bytes landed: time tiles where they hold a manifest, else
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

/// How the source at `url` starts opening: a URL template holds vector tiles at once; an archive is
/// read in ranges, from its header; a document is read whole.
fn start(url: &Arc<str>, jobs: &Jobs<'_>) -> State {
    if url.contains("{z}") {
        return State::Open(Holds::Vector(Box::new(vector::Fetched::template(url))));
    }
    let archive = url.split(['?', '#']).next().is_some_and(|path| path.ends_with(".pmtiles"));
    let request = if archive { Request::range(url.clone(), 0..ARCHIVE_FIRST) } else { Request::new(url.clone()) };
    State::Opening(jobs.fetch(&request))
}
