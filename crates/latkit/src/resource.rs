//! Fetching bytes for CPU data loading, independent of graphics and window systems.
use crate::Pending;
use std::ops::Range;
use std::sync::Arc;

/// A source of bytes for JSON data documents and their binary slices.
pub trait Fetch: Send + Sync {
    /// Resolves to the requested bytes, or an error. A missing resource returns empty bytes.
    fn fetch(&self, request: &Request) -> Pending<Vec<u8>>;
}

#[cfg(feature = "gpu")]
impl<T: crate::host::Host + ?Sized> Fetch for T {
    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        crate::host::Host::fetch(self, request)
    }
}

/// Bytes to fetch: a URL and an optional byte range.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Request {
    /// The URL.
    pub url: Arc<str>,
    /// Bytes `start..end`. `None` fetches every byte.
    pub range: Option<Range<u64>>,
}

impl Request {
    /// A request for every byte at `url`.
    pub fn new(url: impl Into<Arc<str>>) -> Request {
        Request { url: url.into(), range: None }
    }

    /// A request for bytes `range` at `url`.
    pub fn range(url: impl Into<Arc<str>>, range: Range<u64>) -> Request {
        Request { url: url.into(), range: Some(range) }
    }
}
