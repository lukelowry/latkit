use std::ops::{Deref, Range};
use std::sync::Arc;

/// A shared, immutable slice: making one from a vector, cloning it, and slicing it never copy.
pub(crate) struct Buffer<T> {
    data: Arc<Vec<T>>,
    start: usize,
    end: usize,
}

impl<T> Clone for Buffer<T> {
    fn clone(&self) -> Buffer<T> {
        Buffer { data: self.data.clone(), start: self.start, end: self.end }
    }
}

impl<T> Buffer<T> {
    pub(crate) fn slice(&self, range: Range<usize>) -> Buffer<T> {
        assert!(range.start <= range.end && self.start + range.end <= self.end, "slice out of range");
        Buffer { data: self.data.clone(), start: self.start + range.start, end: self.start + range.end }
    }
}

impl<T> Default for Buffer<T> {
    fn default() -> Buffer<T> {
        Buffer::from(Vec::new())
    }
}

impl<T> Deref for Buffer<T> {
    type Target = [T];

    fn deref(&self) -> &[T] {
        &self.data[self.start..self.end]
    }
}

impl<T> From<Vec<T>> for Buffer<T> {
    fn from(values: Vec<T>) -> Buffer<T> {
        let end = values.len();
        Buffer { data: Arc::new(values), start: 0, end }
    }
}

impl<T: Clone> From<&[T]> for Buffer<T> {
    fn from(values: &[T]) -> Buffer<T> {
        Buffer::from(values.to_vec())
    }
}

impl<T> FromIterator<T> for Buffer<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Buffer<T> {
        iter.into_iter().collect::<Vec<T>>().into()
    }
}

impl<T: std::fmt::Debug> std::fmt::Debug for Buffer<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.iter()).finish()
    }
}
