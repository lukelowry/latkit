//! What views draw from: a [`Data`] changing in place, which every view drawing it follows; a
//! [`Snapshot`], one version kept as it is; or [`Tiles`](crate::Tiles), fetched in pieces.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::Waker;

use super::name::Name;
use super::patch::Patch;
use super::snapshot::Snapshot;
use crate::{Error, Result};

/// A dataset that changes in place: named tables of columns, changed only by patches. Clones share
/// it, and a view drawing it draws its latest version from the frame after a patch applies. A
/// [`Snapshot`] keeps one version as it was, which costs only the pages later versions write.
///
/// ```
/// # use latkit::{Data, Ids, Patch, Table};
/// let grid = Data::new("grid");
/// grid.apply(
///     Patch::new()
///         .axis("time", "s")
///         .replace(Table::new("Bus", vec![1_u64, 2]).field("kv", vec![230.0, 115.0]))
///         .replace(Table::new("Branch", Ids::count(1)).reference("from", "Bus", vec![1_u64]).reference("to", "Bus", vec![2_u64])),
/// )?;
/// let before = grid.snapshot();
/// grid.apply(Patch::new().append("Bus", [0.0], [("vm", vec![1.01, 0.99])]))?;
/// grid.restore(&before)?;
/// # Ok::<(), latkit::Error>(())
/// ```
#[derive(Clone)]
pub struct Data(Arc<Shared>);

struct Shared {
    name: Name,
    current: Mutex<Snapshot>,
    /// What wakes each view drawing the dataset, by view: a patch applied asks each for a frame.
    watchers: Mutex<Vec<(u64, Waker)>>,
}

impl Data {
    /// An empty dataset named `name`.
    pub fn new(name: impl Into<Name>) -> Data {
        Data::from(Snapshot::new(name))
    }

    /// The dataset's name.
    pub fn name(&self) -> &Name {
        &self.0.name
    }

    /// Applies every change in `patch`, or none of them when one is invalid. A patch to another
    /// dataset is an error. Every view drawing the dataset draws the new version from its next frame.
    ///
    /// The error's path names the change and part, such as `patch[1].Bus.kv`.
    pub fn apply(&self, patch: impl Into<Patch>) -> Result<()> {
        let mut current = self.current();
        *current = current.applied(patch.into())?;
        drop(current);
        self.wake();
        Ok(())
    }

    /// The version the dataset holds now, kept as it is while patches change the dataset: O(1).
    pub fn snapshot(&self) -> Snapshot {
        self.current().clone()
    }

    /// Makes `snapshot`, a version of this dataset, the one it holds: what an undo does. Every view
    /// drawing the dataset draws it from its next frame. A snapshot of another dataset is an error.
    pub fn restore(&self, snapshot: &Snapshot) -> Result<()> {
        if snapshot.name() != self.name() {
            return Err(Error::invalid(format!("a snapshot of '{}' restored to '{}'", snapshot.name(), self.name())));
        }
        *self.current() = snapshot.clone();
        self.wake();
        Ok(())
    }

    /// Asks view `view` for a frame through `waker` whenever a patch applies.
    #[cfg(feature = "gpu")]
    pub(crate) fn watch(&self, view: u64, waker: Waker) {
        let mut watchers = self.0.watchers.lock().unwrap_or_else(PoisonError::into_inner);
        watchers.retain(|(v, _)| *v != view);
        watchers.push((view, waker));
    }

    /// Stops asking view `view` for frames.
    #[cfg(feature = "gpu")]
    pub(crate) fn unwatch(&self, view: u64) {
        self.0.watchers.lock().unwrap_or_else(PoisonError::into_inner).retain(|(v, _)| *v != view);
    }

    fn current(&self) -> MutexGuard<'_, Snapshot> {
        self.0.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Asks every view drawing the dataset for a frame.
    fn wake(&self) {
        let wakers: Vec<Waker> =
            self.0.watchers.lock().unwrap_or_else(PoisonError::into_inner).iter().map(|(_, w)| w.clone()).collect();
        for waker in wakers {
            waker.wake();
        }
    }
}

impl From<Snapshot> for Data {
    /// A dataset holding `snapshot`, which patches change from there.
    fn from(snapshot: Snapshot) -> Data {
        Data(Arc::new(Shared {
            name: snapshot.name().clone(),
            current: Mutex::new(snapshot),
            watchers: Mutex::default(),
        }))
    }
}

impl std::fmt::Debug for Data {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Data").field(&*self.current()).finish()
    }
}

/// What a view draws a dataset from, by the dataset's name: a [`Data`], drawn as it changes; a
/// [`Snapshot`], drawn as it is; or [`Tiles`](crate::Tiles), fetched in pieces as the view asks for
/// them.
#[cfg(feature = "gpu")]
#[derive(Clone, Debug)]
pub enum Source {
    /// A dataset drawn as it changes.
    Data(Data),
    /// A version drawn as it is.
    Snapshot(Snapshot),
    /// Pieces fetched as the view asks for them.
    Tiles(crate::Tiles),
}

#[cfg(feature = "gpu")]
impl Source {
    /// The name of the dataset it gives.
    pub fn name(&self) -> &Name {
        match self {
            Source::Data(data) => data.name(),
            Source::Snapshot(snapshot) => snapshot.name(),
            Source::Tiles(tiles) => tiles.name(),
        }
    }
}

#[cfg(feature = "gpu")]
impl From<Data> for Source {
    fn from(data: Data) -> Source {
        Source::Data(data)
    }
}

#[cfg(feature = "gpu")]
impl From<&Data> for Source {
    fn from(data: &Data) -> Source {
        Source::Data(data.clone())
    }
}

#[cfg(feature = "gpu")]
impl From<Snapshot> for Source {
    fn from(snapshot: Snapshot) -> Source {
        Source::Snapshot(snapshot)
    }
}

#[cfg(feature = "gpu")]
impl From<&Snapshot> for Source {
    fn from(snapshot: &Snapshot) -> Source {
        Source::Snapshot(snapshot.clone())
    }
}

#[cfg(feature = "gpu")]
impl From<crate::Tiles> for Source {
    fn from(tiles: crate::Tiles) -> Source {
        Source::Tiles(tiles)
    }
}

#[cfg(feature = "gpu")]
impl From<&crate::Tiles> for Source {
    fn from(tiles: &crate::Tiles) -> Source {
        Source::Tiles(tiles.clone())
    }
}
