//! A graph to lay out, and the buckets layouts sort its vertices and links into.

/// A graph to lay out, in plane units with y up: each vertex's pinned center if any, and the links
/// between vertices, directed where a layout reads direction. Vertices are points.
pub(crate) struct Graph<'a> {
    pub(crate) pinned: &'a [Option<[f64; 2]>],
    pub(crate) links: &'a [[u32; 2]],
}

impl Graph<'_> {
    /// The number of vertices.
    pub(crate) fn len(&self) -> usize {
        self.pinned.len()
    }

    /// Each vertex's pin, dropping pins that are not finite.
    pub(crate) fn pins(&self) -> Vec<Option<[f64; 2]>> {
        self.pinned.iter().map(|pin| pin.filter(|at| at[0].is_finite() && at[1].is_finite())).collect()
    }

    /// The links whose ends are both vertices of the graph.
    pub(crate) fn links(&self) -> Vec<[u32; 2]> {
        let count = self.len();
        self.links.iter().copied().filter(|link| link.iter().all(|&v| (v as usize) < count)).collect()
    }
}

/// The box holding `points`: its least x and y, then its greatest. A point at the origin for none.
pub(crate) fn bounds(points: impl Iterator<Item = [f64; 2]>) -> [f64; 4] {
    points
        .map(|[x, y]| [x, y, x, y])
        .reduce(|a, b| [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])])
        .unwrap_or([0.0; 4])
}

/// Items bucketed by key, each bucket in the order given: bucket `k` is
/// `items[offsets[k]..offsets[k + 1]]`.
pub(crate) struct Runs<T> {
    offsets: Vec<usize>,
    /// Every bucket's items, bucket after bucket. Reordering within a bucket keeps them bucketed.
    pub(crate) items: Vec<T>,
}

impl<T: Copy + Default> Runs<T> {
    /// Buckets `keyed` items into `buckets` buckets. Each key must be below `buckets`.
    pub(crate) fn new(buckets: usize, keyed: impl Iterator<Item = (usize, T)> + Clone) -> Runs<T> {
        let mut offsets = vec![0; buckets + 1];
        for (key, _) in keyed.clone() {
            offsets[key] += 1;
        }
        let mut total = 0;
        for offset in &mut offsets {
            (*offset, total) = (total, total + *offset);
        }
        let mut items = vec![T::default(); total];
        let mut fill = offsets.clone();
        for (key, item) in keyed {
            items[fill[key]] = item;
            fill[key] += 1;
        }
        Runs { offsets, items }
    }
}

impl<T> Runs<T> {
    /// The number of buckets.
    pub(crate) fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    /// Bucket `k`'s items.
    pub(crate) fn get(&self, k: usize) -> &[T] {
        &self.items[self.offsets[k]..self.offsets[k + 1]]
    }

    /// Bucket `k`'s items, mutably.
    pub(crate) fn get_mut(&mut self, k: usize) -> &mut [T] {
        &mut self.items[self.offsets[k]..self.offsets[k + 1]]
    }
}

impl<T: Ord> Runs<T> {
    /// Sorts the items within each bucket.
    pub(crate) fn sort_each(&mut self) {
        for k in 0..self.len() {
            self.get_mut(k).sort_unstable();
        }
    }
}
