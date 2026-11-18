//! Tilings: a source's pieces, fetched by key as the sets drawing the source need them, then
//! decoded into patches. A piece keeps its fetched bytes together with the patches decoded from
//! them, until the cache evicts it for its budget, least recently drawn first. Every set drawing
//! one source shares its tiling, so a piece one set fetched draws in another, and a set that
//! returns to a source finds what it drew before. Each set decodes for a stamp that identifies
//! what its decoding reads. A wanted key draws once it is decoded for that stamp. Until then its
//! nearest decoded ancestor is drawn as a placeholder, and missing pieces are fetched, nearest
//! first. A renewed piece is fetched again and draws what it holds until the new bytes land. A
//! piece whose fetch failed draws nothing and is fetched again once wanted after its
//! [`Retry`]. Earth tiles and spans of a sampled field's history both use tilings.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::Waker;

use rustc_hash::{FxHashMap, FxHashSet};

use super::retry::Retry;
use super::{Key, ancestry};
use crate::data::Patch;
use crate::derive::Jobs;
use crate::host::Request;
use crate::{Error, Pending};

/// The most fetches a tiling runs at once, and separately the most decodes.
const REQUESTS: usize = 8;

/// Counts every tiling's updates, so pieces of different tilings compare by when they last drew.
static UPDATES: AtomicU64 = AtomicU64::new(0);

/// How a source fetches a piece.
pub(crate) enum Requested {
    /// Fetch the bytes `request` returns.
    Fetch(Request),
    /// Not yet. The source must first fetch what locates the piece, such as an archive's
    /// directories.
    Wait,
    /// The source has no such piece, which draws nothing.
    Missing,
    /// What locates the piece failed to fetch. The piece draws nothing until `Retry`.
    Failed(Retry),
}

/// How a piece's bytes become its patch: immediately, or as a job's result.
pub(crate) enum Decoding {
    Now(Patch),
    Job(Pending<Vec<u8>>),
}

/// Fetches and decodes a tiling's pieces.
pub(crate) trait Pieces<K: Key> {
    /// How to fetch `key`.
    fn request(&mut self, key: K, jobs: &Jobs<'_>) -> Requested;

    /// Decodes `key`'s fetched `bytes`, which are never empty.
    fn decode(&self, key: K, bytes: &Arc<Vec<u8>>, jobs: &Jobs<'_>) -> Decoding;
}

/// What the cache asks of a tiling, whatever its keys, to keep every source within one budget.
pub(crate) trait Kept {
    /// Releases set `set`'s claim, so pieces no other set draws may be evicted.
    fn release(&mut self, set: u64);

    /// Bytes its pieces take: those fetched, and the patches decoded from them.
    fn bytes(&self) -> usize;

    /// Adds to `idle` each piece no set claims: when it last drew, and the bytes it takes.
    fn idle(&self, idle: &mut Vec<(u64, usize)>);

    /// Evicts the pieces no set claims that last drew at `drew` or before.
    fn evict(&mut self, drew: u64);
}

/// The result of an update. It lists each wanted key if decoded, else its nearest decoded
/// ancestor, each once. It also says whether any wanted key shows a placeholder (an ancestor, or
/// nothing).
pub(crate) struct Drawn<K> {
    pub(crate) keys: Vec<K>,
    pub(crate) standing_in: bool,
    /// A failure to report: a piece that could not be fetched.
    pub(crate) failure: Option<Error>,
}

/// One set's claim on a tiling: the stamp it decodes for, and the keys it keeps. Those are the
/// keys it draws, the keys it wants, and their ancestors, which are drawn as placeholders.
struct Claim<K> {
    stamp: u64,
    keys: FxHashSet<K>,
}

/// A fetched piece, with the patches decoded from it. Empty bytes mean the source has no such
/// piece, or the fetch failed.
struct Held {
    bytes: Arc<Vec<u8>>,
    /// Each patch decoded from the bytes: the stamp it was decoded for, and the bytes it takes.
    decoded: Vec<(u64, Patch, usize)>,
    /// When the piece last drew, as a count of updates.
    used: u64,
    /// When its bytes landed, which changes when a renewal brings new bytes.
    landed: u64,
    /// When it is fetched again, if its last fetch failed.
    retry: Option<Retry>,
}

impl Held {
    /// Bytes it takes: those fetched, and its decoded patches.
    fn size(&self) -> usize {
        self.bytes.len() + self.decoded.iter().map(|(_, _, bytes)| bytes).sum::<usize>()
    }
}

/// A source's pieces: their fetched bytes, and the patches decoded from them for each decoding
/// stamp.
pub(crate) struct Tiling<K: Key> {
    held: FxHashMap<K, Held>,
    fetching: FxHashMap<K, Pending<Vec<u8>>>,
    /// Held pieces to fetch again once wanted. Each draws what it holds until the new bytes land.
    renewing: FxHashSet<K>,
    /// Decodes in progress, by key and stamp.
    decoding: FxHashMap<(K, u64), Pending<Vec<u8>>>,
    /// Each drawing set's claim, by set.
    claims: FxHashMap<u64, Claim<K>>,
    /// The first fetch failure, until no piece is failing. Every set drawing the tiling reports it
    /// once.
    failure: Option<Error>,
    /// The latest update, recording when each piece last drew.
    tick: u64,
}

impl<K: Key> Default for Tiling<K> {
    fn default() -> Tiling<K> {
        Tiling {
            held: FxHashMap::default(),
            fetching: FxHashMap::default(),
            renewing: FxHashSet::default(),
            decoding: FxHashMap::default(),
            claims: FxHashMap::default(),
            failure: None,
            tick: 0,
        }
    }
}

impl<K: Key> Tiling<K> {
    /// Updates the pieces for what set `set` wants, nearest first, decoding for `stamp`. Returns
    /// what the set draws.
    pub(crate) fn update(
        &mut self,
        set: u64,
        wanted: &[K],
        stamp: u64,
        pieces: &mut impl Pieces<K>,
        jobs: &Jobs<'_>,
    ) -> Drawn<K> {
        self.tick = UPDATES.fetch_add(1, Ordering::Relaxed) + 1;
        self.land(jobs.waker());
        // Decode wanted keys once fetched, and the fetched ancestors of keys still loading as
        // placeholders. Fetch the rest. A piece decoded immediately draws immediately.
        let mut decode: Vec<K> = Vec::new();
        for &key in wanted {
            if self.held.get(&key).and_then(|held| held.retry).is_some_and(Retry::due) {
                self.renewing.insert(key);
            }
            if self.renewing.contains(&key) {
                self.fetch(key, pieces, jobs);
            }
            if self.ready(key, stamp) {
                continue;
            }
            let held_up = ancestry(key).find(|k| self.held.contains_key(k));
            if let Some(k) = held_up
                && !self.ready(k, stamp)
                && !decode.contains(&k)
            {
                decode.push(k);
            }
            if !self.held.contains_key(&key) && !decode.contains(&key) {
                self.fetch(key, pieces, jobs);
            }
        }
        for key in decode {
            self.decode(key, stamp, pieces, jobs);
        }
        let mut drawn: Vec<K> = Vec::new();
        let mut standing_in = false;
        for &key in wanted {
            let stands = ancestry(key).find(|&k| self.ready(k, stamp));
            if let Some(stand) = stands
                && !drawn.contains(&stand)
            {
                drawn.push(stand);
            }
            standing_in |= stands != Some(key);
        }
        let tick = self.tick;
        for key in &drawn {
            if let Some(held) = self.held.get_mut(key) {
                held.used = tick;
            }
        }
        // The set keeps what it draws and wants, plus every ancestor of what it wants, which is
        // drawn as a placeholder while zooming. Each walk up stops where an earlier wanted key's
        // walk passed.
        let mut keys: FxHashSet<K> = drawn.iter().copied().collect();
        let mut walked: FxHashSet<K> = FxHashSet::default();
        for &key in wanted {
            for k in ancestry(key) {
                if !walked.insert(k) {
                    break;
                }
                keys.insert(k);
            }
        }
        self.claims.insert(set, Claim { stamp, keys });
        self.forget(set);
        Drawn { keys: drawn, standing_in, failure: self.failure.clone() }
    }

    /// The patch decoded from `key` for `stamp`, once ready.
    pub(crate) fn decoded(&self, key: &K, stamp: u64) -> Option<&Patch> {
        let held = self.held.get(key)?;
        held.decoded.iter().find(|(decoded, ..)| *decoded == stamp).map(|(_, patch, _)| patch)
    }

    /// When `key`'s bytes landed: a set draws a piece again once this changes.
    pub(crate) fn landed(&self, key: &K) -> u64 {
        self.held.get(key).map_or(0, |held| held.landed)
    }

    /// Fetches and decodes in progress.
    pub(crate) fn under_way(&self) -> usize {
        self.fetching.len() + self.decoding.len()
    }

    /// Fetches the pieces `stale` accepts again once wanted, and every piece whose fetch failed,
    /// without waiting for its retry. Each draws what it holds until the new bytes land. Clears
    /// the failure to report.
    pub(crate) fn renew(&mut self, stale: impl Fn(&K) -> bool) {
        // A fetch under way for a stale piece may return its old bytes.
        self.fetching.retain(|key, _| !stale(key));
        let renewed = self.held.iter().filter(|(key, held)| held.retry.is_some() || stale(key)).map(|(key, _)| *key);
        self.renewing.extend(renewed);
        self.failure = None;
    }

    /// Records `error` as the tiling's failure, unless one is recorded already.
    pub(crate) fn fail(&mut self, error: Error) {
        self.failure.get_or_insert(error);
    }

    /// Clears the failure once a fetch succeeds and no piece is failing.
    pub(crate) fn recovered(&mut self) {
        if self.held.values().all(|held| held.retry.is_none()) {
            self.failure = None;
        }
    }

    /// Whether `key` is decoded for `stamp`.
    fn ready(&self, key: K, stamp: u64) -> bool {
        self.decoded(&key, stamp).is_some()
    }

    /// Collects finished fetches and decodes, keeping the first failure. A piece whose fetch
    /// failed is fetched again after its retry, which wakes `waker`. A renewed piece keeps the
    /// bytes it held meanwhile. A cancelled fetch leaves the piece as it was, to be fetched again
    /// once wanted. A decode of a piece evicted since is dropped.
    fn land(&mut self, waker: &Waker) {
        let fetched: Vec<_> = self.fetching.iter().filter_map(|(key, p)| p.take().map(|r| (*key, r))).collect();
        for (key, result) in fetched {
            self.fetching.remove(&key);
            let renewed = self.renewing.remove(&key);
            match result {
                Err(Error::Cancelled) => {
                    if renewed {
                        self.renewing.insert(key);
                    }
                }
                Err(error) => {
                    self.failure.get_or_insert(error);
                    let retry = Some(Retry::after(self.held.get(&key).and_then(|held| held.retry), waker));
                    match self.held.get_mut(&key) {
                        Some(held) if renewed => held.retry = retry,
                        _ => self.hold(key, Vec::new(), retry),
                    }
                }
                Ok(bytes) => {
                    if renewed {
                        self.decoding.retain(|(k, _), _| *k != key);
                    }
                    self.hold(key, bytes, None);
                    self.recovered();
                }
            }
        }
        let decoded: Vec<_> = self.decoding.iter().filter_map(|(at, p)| p.take().map(|r| (*at, r))).collect();
        for ((key, stamp), result) in decoded {
            self.decoding.remove(&(key, stamp));
            let bytes = result.unwrap_or_default();
            let patch = Patch::from_bytes(&bytes).unwrap_or_default();
            if let Some(held) = self.held.get_mut(&key) {
                held.decoded.push((stamp, patch, bytes.len()));
            }
        }
    }

    /// Starts fetching `key`, unless [`REQUESTS`] fetches are already in progress.
    fn fetch(&mut self, key: K, pieces: &mut impl Pieces<K>, jobs: &Jobs<'_>) {
        if self.fetching.contains_key(&key) || self.fetching.len() >= REQUESTS {
            return;
        }
        match pieces.request(key, jobs) {
            Requested::Fetch(request) => {
                self.fetching.insert(key, jobs.fetch(&request));
            }
            Requested::Wait => {}
            Requested::Missing => {
                self.renewing.remove(&key);
                self.hold(key, Vec::new(), None);
            }
            Requested::Failed(retry) => {
                self.renewing.remove(&key);
                self.hold(key, Vec::new(), Some(retry));
            }
        }
    }

    /// Keeps `bytes` as `key`'s, landed now, with nothing decoded from them yet, and the retry of
    /// a fetch that failed.
    fn hold(&mut self, key: K, bytes: Vec<u8>, retry: Option<Retry>) {
        let held = Held { bytes: Arc::new(bytes), decoded: Vec::new(), used: self.tick, landed: self.tick, retry };
        self.held.insert(key, held);
    }

    /// Starts decoding `key` for `stamp`, unless [`REQUESTS`] decodes are already in progress.
    /// Empty bytes decode to an empty patch immediately. A patch decoded immediately takes about
    /// the bytes it was read from.
    fn decode(&mut self, key: K, stamp: u64, pieces: &impl Pieces<K>, jobs: &Jobs<'_>) {
        if self.decoding.contains_key(&(key, stamp)) || self.decoding.len() >= REQUESTS {
            return;
        }
        let Some(held) = self.held.get_mut(&key) else { return };
        if held.bytes.is_empty() {
            held.decoded.push((stamp, Patch::new(), 0));
            return;
        }
        match pieces.decode(key, &held.bytes, jobs) {
            Decoding::Now(patch) => held.decoded.push((stamp, patch, held.bytes.len())),
            Decoding::Job(pending) => {
                self.decoding.insert((key, stamp), pending);
            }
        }
    }

    /// Drops, from the pieces set `set` claims, the patches decoded for stamps none of their
    /// claims decodes for any more, as when a scene comes to draw other layers. A piece no set
    /// claims keeps its patches until it is evicted, so a set that returns finds them.
    fn forget(&mut self, set: u64) {
        let Some(claim) = self.claims.get(&set) else { return };
        for key in &claim.keys {
            let stamps = || self.claims.values().filter(|claim| claim.keys.contains(key)).map(|claim| claim.stamp);
            if let Some(held) = self.held.get_mut(key) {
                held.decoded.retain(|(stamp, ..)| stamps().any(|claimed| claimed == *stamp));
            }
        }
    }

    /// Whether any set claims `key`.
    fn claimed(&self, key: &K) -> bool {
        self.claims.values().any(|claim| claim.keys.contains(key))
    }
}

impl<K: Key> Kept for Tiling<K> {
    fn release(&mut self, set: u64) {
        self.claims.remove(&set);
    }

    fn bytes(&self) -> usize {
        self.held.values().map(Held::size).sum()
    }

    fn idle(&self, idle: &mut Vec<(u64, usize)>) {
        idle.extend(self.held.iter().filter(|(key, _)| !self.claimed(key)).map(|(_, held)| (held.used, held.size())));
    }

    fn evict(&mut self, drew: u64) {
        let (claims, renewing) = (&self.claims, &mut self.renewing);
        self.held.retain(|key, held| {
            let kept = held.used > drew || claims.values().any(|claim| claim.keys.contains(key));
            if !kept {
                renewing.remove(key);
            }
            kept
        });
    }
}
