//! Tilings: a source's pieces, fetched by key as the sets drawing the source need them, then
//! decoded into patches. A tiling keeps pieces within a byte budget and evicts the least recently
//! drawn first. Every set drawing one source shares its tiling, so a piece one set fetched draws in
//! another. Each set decodes for a stamp that identifies what its decoding reads. A wanted key
//! draws once it is decoded for that stamp. Until then its nearest decoded ancestor is drawn as a
//! placeholder, and missing pieces are fetched, nearest first. Earth tiles and spans of a sampled
//! field's history both use tilings.

use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::{Key, ancestry};
use crate::data::Patch;
use crate::derive::Jobs;
use crate::host::Request;
use crate::{Error, Pending};

/// The most fetches a tiling runs at once, and separately the most decodes.
const REQUESTS: usize = 8;
/// Bytes of fetched pieces a tiling keeps. Past this, the least recently drawn are evicted.
const KEPT_BYTES: usize = 64 << 20;

/// How a source fetches a piece.
pub(crate) enum Requested {
    /// Fetch the bytes `request` returns.
    Fetch(Request),
    /// Not yet. The source must first fetch what locates the piece, such as an archive's
    /// directories.
    Wait,
    /// The source has no such piece, which draws nothing.
    Missing,
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

/// The result of an update. It lists each wanted key if decoded, else its nearest decoded
/// ancestor, each once. It also says whether any wanted key shows a placeholder (an ancestor, or
/// nothing).
pub(crate) struct Drawn<K> {
    pub(crate) keys: Vec<K>,
    pub(crate) standing_in: bool,
    /// A failure to report: a piece that could not be fetched.
    pub(crate) failure: Option<Error>,
}

/// One set's claim on a tiling: the stamp it decodes for, and the keys whose decodes it keeps.
/// Those are the keys it draws, the keys it wants, and their ancestors, which are drawn as
/// placeholders.
struct Claim<K> {
    stamp: u64,
    keys: FxHashSet<K>,
}

/// A source's pieces: their fetched bytes, and the patches decoded from them for each decoding
/// stamp.
pub(crate) struct Tiling<K: Key> {
    /// Fetched bytes and the tick each piece last drew at. Empty bytes mean the source has no such
    /// piece or the fetch failed.
    held: FxHashMap<K, (Arc<Vec<u8>>, u64)>,
    fetching: FxHashMap<K, Pending<Vec<u8>>>,
    /// Decodes in progress (`decoding`) and finished (`decoded`), by key and stamp.
    decoding: FxHashMap<(K, u64), Pending<Vec<u8>>>,
    decoded: FxHashMap<(K, u64), Patch>,
    /// Each drawing set's claim, by set.
    claims: FxHashMap<u64, Claim<K>>,
    /// The first fetch failure. Every set drawing the tiling reports it once.
    failure: Option<Error>,
    /// Update counter, recording when each piece last drew.
    tick: u64,
}

impl<K: Key> Default for Tiling<K> {
    fn default() -> Tiling<K> {
        Tiling {
            held: FxHashMap::default(),
            fetching: FxHashMap::default(),
            decoding: FxHashMap::default(),
            decoded: FxHashMap::default(),
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
        self.tick += 1;
        self.land();
        // Decode wanted keys once fetched, and the fetched ancestors of keys still loading as
        // placeholders. Fetch the rest. A piece decoded immediately draws immediately.
        let mut decode: Vec<K> = Vec::new();
        for &key in wanted {
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
            if let Some((_, used)) = self.held.get_mut(key) {
                *used = tick;
            }
        }
        // The set keeps the decodes of what it draws and wants, plus every ancestor of what it
        // wants, which is drawn as a placeholder while zooming. Each walk up stops where an earlier
        // wanted key's walk passed.
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
        self.evict();
        Drawn { keys: drawn, standing_in, failure: self.failure.clone() }
    }

    /// The patch decoded from `key` for `stamp`, once ready.
    pub(crate) fn decoded(&self, key: &K, stamp: u64) -> Option<&Patch> {
        self.decoded.get(&(*key, stamp))
    }

    /// Fetches and decodes in progress.
    pub(crate) fn under_way(&self) -> usize {
        self.fetching.len() + self.decoding.len()
    }

    /// Records `error` as the tiling's failure, unless one is recorded already.
    pub(crate) fn fail(&mut self, error: Error) {
        self.failure.get_or_insert(error);
    }

    /// Releases set `set`'s claim, so pieces no other set draws may be evicted.
    pub(crate) fn release(&mut self, set: u64) {
        if self.claims.remove(&set).is_some() {
            self.evict();
        }
    }

    /// Whether `key` is decoded for `stamp`.
    fn ready(&self, key: K, stamp: u64) -> bool {
        self.decoded.contains_key(&(key, stamp))
    }

    /// Collects finished fetches and decodes, keeping the first failure. A decode is kept only if
    /// some set still decodes for its stamp.
    fn land(&mut self) {
        let fetched: Vec<_> = self.fetching.iter().filter_map(|(key, p)| p.take().map(|r| (*key, r))).collect();
        for (key, result) in fetched {
            self.fetching.remove(&key);
            let bytes = result.unwrap_or_else(|error| {
                self.failure.get_or_insert(error);
                Vec::new()
            });
            self.held.insert(key, (Arc::new(bytes), self.tick));
        }
        let decoded: Vec<_> = self.decoding.iter().filter_map(|(at, p)| p.take().map(|r| (*at, r))).collect();
        for (at, result) in decoded {
            self.decoding.remove(&at);
            let patch = result.ok().and_then(|bytes| Patch::from_bytes(&bytes).ok()).unwrap_or_default();
            if self.claims.values().any(|claim| claim.stamp == at.1) {
                self.decoded.insert(at, patch);
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
                self.held.insert(key, (Arc::new(Vec::new()), self.tick));
            }
        }
    }

    /// Starts decoding `key` for `stamp`, unless [`REQUESTS`] decodes are already in progress.
    /// Empty bytes decode to an empty patch immediately.
    fn decode(&mut self, key: K, stamp: u64, pieces: &impl Pieces<K>, jobs: &Jobs<'_>) {
        if self.decoding.contains_key(&(key, stamp)) || self.decoding.len() >= REQUESTS {
            return;
        }
        let Some((bytes, _)) = self.held.get(&key) else { return };
        if bytes.is_empty() {
            self.decoded.insert((key, stamp), Patch::new());
            return;
        }
        match pieces.decode(key, bytes, jobs) {
            Decoding::Now(patch) => {
                self.decoded.insert((key, stamp), patch);
            }
            Decoding::Job(pending) => {
                self.decoding.insert((key, stamp), pending);
            }
        }
    }

    /// While over budget, evicts the bytes of the least recently drawn pieces no set claims. Drops
    /// decodes no set keeps.
    fn evict(&mut self) {
        let claims = &self.claims;
        let claimed = |key: &K| claims.values().any(|claim| claim.keys.contains(key));
        let mut bytes: usize = self.held.values().map(|(b, _)| b.len()).sum();
        if bytes > KEPT_BYTES {
            let mut old: Vec<(u64, K)> =
                self.held.iter().filter(|(k, _)| !claimed(k)).map(|(k, (_, used))| (*used, *k)).collect();
            old.sort_unstable();
            for (_, key) in old {
                if bytes <= KEPT_BYTES {
                    break;
                }
                if let Some((b, _)) = self.held.remove(&key) {
                    bytes -= b.len();
                }
            }
        }
        self.decoded.retain(|(key, stamp), _| claims.values().any(|c| c.stamp == *stamp && c.keys.contains(key)));
    }
}
