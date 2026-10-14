use std::ops::Range;

use super::buffer::Buffer;
use super::values::Value;

/// Shared, immutable geometries of one depth: nested offsets over `[x, y]` coordinates.
///
/// Depth 0 is a point per row, 1 a path, 2 parts (rings of a polygon, or the paths of a multi-path),
/// and 3 polygons. `levels[0]` is indexed by row; each level's offsets index the next level, and the
/// last level indexes `coords`. Offsets are absolute, so slicing rows slices only `levels[0]`.
#[derive(Clone)]
pub(crate) struct Geometry {
    depth: u8,
    levels: Vec<Buffer<u32>>,
    coords: Buffer<[f64; 2]>,
}

/// The deepest geometry: polygons of rings of coordinates.
pub(crate) const MAX_DEPTH: u8 = 3;

impl Geometry {
    pub(crate) fn depth(&self) -> u8 {
        self.depth
    }

    pub(crate) fn len(&self) -> usize {
        match self.levels.first() {
            Some(rows) => rows.len().saturating_sub(1),
            None => self.coords.len(),
        }
    }

    pub(crate) fn slice(&self, range: Range<usize>) -> Geometry {
        let mut levels = self.levels.clone();
        let coords = match levels.first_mut() {
            Some(rows) => {
                *rows = rows.slice(range.start..range.end + 1);
                self.coords.clone()
            }
            None => self.coords.slice(range),
        };
        Geometry { depth: self.depth, levels, coords }
    }

    /// The span `item` of `level` covers in the next level, or in `coords` from the last level.
    pub(crate) fn span(&self, level: usize, item: usize) -> Range<usize> {
        let offsets = &self.levels[level];
        offsets[item] as usize..offsets[item + 1] as usize
    }

    pub(crate) fn coords(&self) -> &[[f64; 2]] {
        &self.coords
    }

    /// Row `row`'s coordinates, every part's in order.
    pub(crate) fn row_coords(&self, row: usize) -> &[[f64; 2]] {
        if self.depth == 0 {
            return &self.coords[row..=row];
        }
        let mut span = row..row + 1;
        for offsets in &self.levels {
            span = offsets[span.start] as usize..offsets[span.end] as usize;
        }
        &self.coords[span]
    }

    /// A digest of row `row`: its coordinates and how they break into parts.
    pub(crate) fn row_hash(&self, row: usize) -> u64 {
        use std::hash::Hasher;
        let mut hasher = rustc_hash::FxHasher::default();
        let mut span = row..row + 1;
        for offsets in &self.levels {
            let first = offsets[span.start];
            for &offset in &offsets[span.clone()] {
                hasher.write_u32(offset - first);
            }
            span = first as usize..offsets[span.end] as usize;
        }
        hasher.write_usize(span.len());
        for point in self.row_coords(row) {
            hasher.write_u64(point[0].to_bits());
            hasher.write_u64(point[1].to_bits());
        }
        hasher.finish()
    }

    /// At most how many points the rows' paths take as shaders read them: every coordinate, and a
    /// break before each part or ring.
    pub(crate) fn points(&self) -> usize {
        let Some(last) = self.levels.len().checked_sub(1) else { return self.len() };
        // The items of each level the rows span, down to the parts or rings, then their coordinates.
        let mut span = 0..self.len();
        let mut parts = 0;
        for (level, offsets) in self.levels.iter().enumerate() {
            if level == last {
                parts = span.len();
            }
            span = offsets[span.start] as usize..offsets[span.end] as usize;
        }
        span.len() + parts
    }

    pub(crate) fn get(&self, row: usize) -> Value {
        match self.depth {
            0 => Value::Point(self.coords[row]),
            1 => Value::Path(self.coords[self.span(0, row)].to_vec()),
            2 => Value::Parts(self.span(0, row).map(|p| self.coords[self.span(1, p)].to_vec()).collect()),
            _ => Value::Polygons(
                self.span(0, row)
                    .map(|polygon| self.span(1, polygon).map(|ring| self.coords[self.span(2, ring)].to_vec()).collect())
                    .collect(),
            ),
        }
    }

    /// Offsets relative to each level's first entry and the coordinates the rows span.
    pub(crate) fn compact(&self) -> (Vec<Vec<u32>>, Vec<[f64; 2]>) {
        let mut builder = GeometryBuilder::new(self.depth);
        for row in 0..self.len() {
            builder.push_from(self, row);
        }
        let Geometry { levels, coords, .. } = builder.finish();
        (levels.iter().map(|l| l.to_vec()).collect(), coords.to_vec())
    }

    pub(crate) fn from_parts(depth: u8, levels: Vec<Vec<u32>>, coords: Vec<[f64; 2]>) -> Option<Geometry> {
        if depth > MAX_DEPTH || levels.len() != depth as usize {
            return None;
        }
        let mut next = coords.len();
        for offsets in levels.iter().rev() {
            let ok = offsets.first() == Some(&0)
                && offsets.windows(2).all(|w| w[0] <= w[1])
                && offsets.last().is_some_and(|&end| end as usize == next);
            if !ok {
                return None;
            }
            next = offsets.len() - 1;
        }
        Some(Geometry { depth, levels: levels.into_iter().map(Buffer::from).collect(), coords: coords.into() })
    }
}

impl std::fmt::Debug for Geometry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries((0..self.len()).map(|row| self.get(row))).finish()
    }
}

/// Builds [`Geometry`] one row at a time.
pub(crate) struct GeometryBuilder {
    depth: u8,
    levels: Vec<Vec<u32>>,
    coords: Vec<[f64; 2]>,
}

impl GeometryBuilder {
    pub(crate) fn new(depth: u8) -> GeometryBuilder {
        GeometryBuilder { depth, levels: (0..depth).map(|_| vec![0]).collect(), coords: Vec::new() }
    }

    pub(crate) fn push_from(&mut self, source: &Geometry, row: usize) {
        debug_assert_eq!(source.depth, self.depth);
        if self.depth == 0 {
            self.coords.push(source.coords[row]);
        } else {
            self.copy(source, 0, row);
        }
    }

    fn copy(&mut self, source: &Geometry, level: usize, item: usize) {
        let span = source.span(level, item);
        if level + 1 == source.levels.len() {
            self.coords.extend_from_slice(&source.coords[span]);
        } else {
            for child in span {
                self.copy(source, level + 1, child);
            }
        }
        self.close(level);
    }

    /// An empty row: no coordinates, or a missing point.
    pub(crate) fn push_empty(&mut self) {
        if self.depth == 0 {
            self.coords.push([f64::NAN; 2]);
        } else {
            self.close(0);
        }
    }

    pub(crate) fn push_path(&mut self, path: &[[f64; 2]]) {
        self.coords.extend_from_slice(path);
    }

    /// Ends the current item of `level`: its children are everything pushed since the last close.
    pub(crate) fn close(&mut self, level: usize) {
        let next = match self.levels.get(level + 1) {
            Some(offsets) => offsets.len() - 1,
            None => self.coords.len(),
        };
        self.levels[level].push(u32::try_from(next).expect("a geometry page holds at most 2^32 items"));
    }

    pub(crate) fn push_value(&mut self, value: &Value) -> bool {
        match (self.depth, value) {
            (0, Value::Point(p)) => self.coords.push(*p),
            (1, Value::Path(path)) => {
                self.push_path(path);
                self.close(0);
            }
            (2, Value::Parts(parts)) => {
                for part in parts {
                    self.push_path(part);
                    self.close(1);
                }
                self.close(0);
            }
            (3, Value::Polygons(polygons)) => {
                for polygon in polygons {
                    for ring in polygon {
                        self.push_path(ring);
                        self.close(2);
                    }
                    self.close(1);
                }
                self.close(0);
            }
            _ => return false,
        }
        true
    }

    pub(crate) fn finish(self) -> Geometry {
        Geometry {
            depth: self.depth,
            levels: self.levels.into_iter().map(Buffer::from).collect(),
            coords: self.coords.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn polygons() -> Geometry {
        let mut builder = GeometryBuilder::new(3);
        let square = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 0.0]];
        builder.push_value(&Value::Polygons(vec![vec![square.clone()], vec![square.clone(), square.clone()]]));
        builder.push_empty();
        builder.push_value(&Value::Polygons(vec![vec![square]]));
        builder.finish()
    }

    #[test]
    fn rows_round_trip_through_slices() {
        let geometry = polygons();
        assert_eq!(geometry.len(), 3);
        let tail = geometry.slice(1..3);
        assert_eq!(tail.len(), 2);
        assert_eq!(tail.get(0), Value::Polygons(Vec::new()));
        assert_eq!(tail.get(1), geometry.get(2));
    }

    #[test]
    fn compact_parts_validate() {
        let geometry = polygons().slice(1..3);
        let (levels, coords) = geometry.compact();
        let rebuilt = Geometry::from_parts(3, levels, coords).expect("valid");
        assert_eq!(rebuilt.get(1), geometry.get(1));
    }
}
