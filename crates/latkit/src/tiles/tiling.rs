//! Tilings: what a source holds, fetched in pieces by key as the sets drawing it ask for them, decoded
//! into patches, and held under a budget of bytes, the least recently drawn going first. Every set
//! drawing one source shares its tiling, so what one fetched another draws; each decodes for a stamp
//! of what its decoding reads. A key wanted draws once it is decoded for that stamp; until then its
//! nearest decoded ancestor stands in, and what is missing is fetched, nearest first. Tiles of the
//! earth and spans of a sampled field's history share it.

use std::sync::Arc;

use rustc_hash::{FxHashMap, FxHashSet};

use super::{Key, ancestry};
use crate::data::Patch;
use crate::derive::Jobs;
use crate::host::Request;
use crate::{Error, Pending};

/// Fetches, and decodes, a tiling has under way at once.
const REQUESTS: usize = 8;
/// Bytes of fetched pieces a tiling keeps, past which the least recently drawn go.
const KEPT_BYTES: usize = 64 << 20;

/// How a source fetches a piece.
pub(crate) enum Requested {
    /// The bytes `request` answers.
    Fetch(Request),
    /// Not yet: the source first fetches what finds the piece, as an archive its directories.
    Wait,
    /// Nowhere: the source holds no such piece, which draws nothing.
    Missing,
}

/// What a piece's bytes become, the patch it draws: at once, or the answer of a job.
pub(crate) enum Decoding {
    Now(Patch),
    Job(Pending<Vec<u8>>),
}

/// Where a tiling's pieces come from, and what they become.
pub(crate) trait Pieces<K: Key> {
    /// How to fetch `key`.
    fn request(&mut self, key: K, jobs: &Jobs<'_>) -> Requested;

    /// What `key`'s fetched `bytes`, never empty, decode into.
    fn decode(&self, key: K, bytes: &Arc<Vec<u8>>, jobs: &Jobs<'_>) -> Decoding;
}

/// What an update draws: each wanted key decoded, else its nearest decoded ancestor, each once; and
/// whether any key stands in, by an ancestor or by nothing.
pub(crate) struct Drawn<K> {
    pub(crate) keys: Vec<K>,
    pub(crate) standing_in: bool,
    /// A failure to tell: a piece that could not be fetched.
    pub(crate) failure: Option<Error>,
}

/// What one set draws of a tiling: the stamp it decodes for, and the keys whose decodes it keeps,
/// those it draws, wants, and the ancestors of those it wants, which stand in for them.
struct Claim<K> {
    stamp: u64,
    keys: FxHashSet<K>,
}

/// A source's pieces: their fetched bytes, and the patches they decoded into for each stamp of what
/// decoding reads.
pub(crate) struct Tiling<K: Key> {
    /// Fetched bytes, as fetched, and when each last drew; empty where the source holds no piece.
    held: FxHashMap<K, (Arc<Vec<u8>>, u64)>,
    fetching: FxHashMap<K, Pending<Vec<u8>>>,
    /// Decodes under way and done, by key and the stamp each was asked for.
    decoding: FxHashMap<(K, u64), Pending<Vec<u8>>>,
    decoded: FxHashMap<(K, u64), Patch>,
    /// What each set drawing the tiling draws of it, by set.
    claims: FxHashMap<u64, Claim<K>>,
    /// The first piece that could not be fetched: every set drawing the tiling tells it once.
    failure: Option<Error>,
    /// Counts updates, for drawn pieces to note when they last drew.
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
    /// Brings the pieces up to what set `set` wants, nearest first, decoding for `stamp`: what it
    /// draws.
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
        // Keys not decoded yet decode once held, and so do the held ancestors of those still
        // loading, to stand in for them; the rest fetch. A piece decoded at once draws at once.
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
        // The set keeps what it draws and wants decoded, and every ancestor of what it wants, which
        // stands in as it zooms; the walk up stops where another wanted key's walk passed.
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

    /// The patch `key` decoded into for `stamp`, once it did.
    pub(crate) fn decoded(&self, key: &K, stamp: u64) -> Option<&Patch> {
        self.decoded.get(&(*key, stamp))
    }

    /// Fetches and decodes under way.
    pub(crate) fn under_way(&self) -> usize {
        self.fetching.len() + self.decoding.len()
    }

    /// Keeps `error` as the tiling's failure, unless it kept one already.
    pub(crate) fn fail(&mut self, error: Error) {
        self.failure.get_or_insert(error);
    }

    /// Lets go of what set `set` drew: pieces no other set draws may go.
    pub(crate) fn release(&mut self, set: u64) {
        if self.claims.remove(&set).is_some() {
            self.evict();
        }
    }

    /// Whether `key` is decoded for `stamp`.
    fn ready(&self, key: K, stamp: u64) -> bool {
        self.decoded.contains_key(&(key, stamp))
    }

    /// Takes fetches and decodes that landed, keeping the first failure.
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

    /// Starts fetching `key`, within the requests under way at once.
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

    /// Starts decoding `key` for `stamp`, within the decodes under way at once.
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

    /// Lets go of the least recently drawn pieces' bytes no set draws or wants, past the budget, and
    /// of decodes no set keeps.
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
