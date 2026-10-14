//! What the view works out from the GPU's state (the shadow map, normals, segment counts, label
//! placement) is made again only when the stamp of what it reads changes: at once on the frame, or
//! by a readback that lands later.

use std::hash::{Hash, Hasher};

use rustc_hash::FxHasher;

use crate::gpu::readback::Readback;

/// A stamp of `inputs`: never 0, which no value is made from.
pub(crate) fn stamp_of(inputs: impl Hash) -> u64 {
    let mut hasher = FxHasher::default();
    inputs.hash(&mut hasher);
    hasher.finish().max(1)
}

/// A derived product: its value, the stamp it was made from, and the readback under way toward the
/// value of a newer stamp.
#[derive(Default)]
pub(crate) struct Derived<T> {
    pub(crate) value: T,
    stamp: u64,
    working: Option<(u64, Readback)>,
}

impl<T> Derived<T> {
    /// The stamp the value was made from; 0 before it was.
    pub(crate) fn stamp(&self) -> u64 {
        self.stamp
    }

    /// Whether `stamp` is neither what the value was made from nor what work under way is for.
    pub(crate) fn due(&self, stamp: u64) -> bool {
        stamp != self.stamp && self.working.as_ref().is_none_or(|(s, _)| *s != stamp)
    }

    /// Takes `value` as made from `stamp`, dropping any work under way.
    pub(crate) fn make(&mut self, stamp: u64, value: T) {
        self.value = value;
        self.stamp = stamp;
        self.working = None;
    }

    /// Takes the value as made from `stamp` as it stands, dropping any work under way.
    pub(crate) fn mark(&mut self, stamp: u64) {
        self.stamp = stamp;
        self.working = None;
    }

    /// Starts `readback` toward the value of `stamp`, replacing any under way.
    pub(crate) fn start(&mut self, stamp: u64, readback: Readback) {
        self.working = Some((stamp, readback));
    }

    /// The bytes of a readback that landed, and the stamp it was for. One that failed lands as made,
    /// keeping the value, so it is not tried again until what it reads changes.
    pub(crate) fn landed(&mut self) -> Option<(u64, Vec<u8>)> {
        let (stamp, readback) = self.working.as_ref()?;
        let stamp = *stamp;
        let landed = readback.take()?;
        self.working = None;
        let Ok(bytes) = landed else {
            self.stamp = stamp;
            return None;
        };
        Some((stamp, bytes))
    }

    /// Whether work is under way.
    pub(crate) fn busy(&self) -> bool {
        self.working.is_some()
    }
}
