//! Tilings: what a source holds, fetched in pieces by key as a view asks for them, decoded into
//! patches, and held under a budget of bytes, the least recently drawn going first. A key wanted draws
//! once it is decoded; until then its nearest decoded ancestor stands in, and what is missing is
//! fetched, nearest first. Tiles of the earth and spans of a sampled field's history share it.

use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::Jobs;
use crate::data::Patch;
use crate::host::Request;
use crate::tiles::{Key, ancestry};
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
pub(crate) trait Source<K: Key> {
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

/// A tiling's pieces: their fetched bytes, and the patches they decoded into for a stamp of what
/// decoding reads.
pub(crate) struct Tiling<K: Key> {
    /// Fetched bytes, as fetched, and when each last drew; empty where the source holds no piece.
    held: FxHashMap<K, (Arc<Vec<u8>>, u64)>,
    fetching: FxHashMap<K, Pending<Vec<u8>>>,
    /// Decodes under way and done, each for the stamp it was asked for.
    decoding: FxHashMap<K, (u64, Pending<Vec<u8>>)>,
    decoded: FxHashMap<K, (u64, Patch)>,
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
            tick: 0,
        }
    }
}

impl<K: Key> Tiling<K> {
    /// Brings the pieces up to `wanted`, nearest first, decoding for `stamp`: what draws.
    pub(crate) fn update(
        &mut self,
        wanted: &[K],
        stamp: u64,
        source: &mut impl Source<K>,
        jobs: &Jobs<'_>,
    ) -> Drawn<K> {
        self.tick += 1;
        let failure = self.land(stamp);
        // Keys not decoded yet decode once held, and so do the held ancestors of those still
        // loading, to stand in for them; the rest fetch. A piece decoded at once draws at once.
        let mut decode: Vec<K> = Vec::new();
        for &key in wanted {
            if self.ready(&key, stamp) {
                continue;
            }
            let held_up = ancestry(key).find(|k| self.held.contains_key(k));
            if let Some(k) = held_up
                && !self.ready(&k, stamp)
                && !decode.contains(&k)
            {
                decode.push(k);
            }
            if !self.held.contains_key(&key) && !decode.contains(&key) {
                self.fetch(key, source, jobs);
            }
        }
        for key in decode {
            self.decode(key, stamp, source, jobs);
        }
        let mut drawn: Vec<K> = Vec::new();
        let mut standing_in = false;
        for &key in wanted {
            let stands = ancestry(key).find(|k| self.ready(k, stamp));
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
        self.evict(&drawn, wanted);
        Drawn { keys: drawn, standing_in, failure }
    }

    /// The patch `key` decoded into for `stamp`, once it did.
    pub(crate) fn decoded(&self, key: &K, stamp: u64) -> Option<&Patch> {
        self.decoded.get(key).filter(|(s, _)| *s == stamp).map(|(_, patch)| patch)
    }

    /// Fetches and decodes under way.
    pub(crate) fn under_way(&self) -> usize {
        self.fetching.len() + self.decoding.len()
    }

    /// Whether `key` is decoded for `stamp`.
    fn ready(&self, key: &K, stamp: u64) -> bool {
        self.decoded.get(key).is_some_and(|(s, _)| *s == stamp)
    }

    /// Takes fetches and decodes that landed; a failure to tell, if any.
    fn land(&mut self, stamp: u64) -> Option<Error> {
        let mut failure = None;
        let fetched: Vec<_> = self.fetching.iter().filter_map(|(key, p)| p.take().map(|r| (*key, r))).collect();
        for (key, result) in fetched {
            self.fetching.remove(&key);
            let bytes = result.unwrap_or_else(|error| {
                failure.get_or_insert(error);
                Vec::new()
            });
            self.held.insert(key, (Arc::new(bytes), self.tick));
        }
        let decoded: Vec<_> =
            self.decoding.iter().filter_map(|(key, (s, p))| p.take().map(|r| (*key, *s, r))).collect();
        for (key, s, result) in decoded {
            self.decoding.remove(&key);
            let patch = result.ok().and_then(|bytes| Patch::from_bytes(&bytes).ok()).unwrap_or_default();
            if s == stamp {
                self.decoded.insert(key, (s, patch));
            }
        }
        failure
    }

    /// Starts fetching `key`, within the requests under way at once.
    fn fetch(&mut self, key: K, source: &mut impl Source<K>, jobs: &Jobs<'_>) {
        if self.fetching.contains_key(&key) || self.fetching.len() >= REQUESTS {
            return;
        }
        match source.request(key, jobs) {
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
    fn decode(&mut self, key: K, stamp: u64, source: &impl Source<K>, jobs: &Jobs<'_>) {
        if self.decoding.get(&key).is_some_and(|(s, _)| *s == stamp) || self.decoding.len() >= REQUESTS {
            return;
        }
        let Some((bytes, _)) = self.held.get(&key) else { return };
        if bytes.is_empty() {
            self.decoded.insert(key, (stamp, Patch::new()));
            return;
        }
        match source.decode(key, bytes, jobs) {
            Decoding::Now(patch) => {
                self.decoded.insert(key, (stamp, patch));
            }
            Decoding::Job(pending) => {
                self.decoding.insert(key, (stamp, pending));
            }
        }
    }

    /// Lets go of the least recently drawn pieces' bytes past the budget, and of decodes no longer
    /// drawn, wanted, or covering a wanted key.
    fn evict(&mut self, drawn: &[K], wanted: &[K]) {
        let kept = |k: &K| drawn.contains(k) || wanted.contains(k);
        let mut bytes: usize = self.held.values().map(|(b, _)| b.len()).sum();
        if bytes > KEPT_BYTES {
            let mut old: Vec<(u64, K)> =
                self.held.iter().filter(|(k, _)| !kept(k)).map(|(k, (_, used))| (*used, *k)).collect();
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
        self.decoded.retain(|k, _| kept(k) || wanted.iter().any(|w| ancestry(*w).skip(1).any(|a| a == *k)));
    }
}
