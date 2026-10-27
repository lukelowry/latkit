use std::ops::Range;
use std::sync::Arc;

use super::buffer::Buffer;

/// Shared, immutable texts: offsets into one UTF-8 string.
#[derive(Clone)]
pub(crate) struct Text {
    offsets: Buffer<u32>,
    bytes: Arc<str>,
}

impl Text {
    pub(crate) fn len(&self) -> usize {
        self.offsets.len().saturating_sub(1)
    }

    pub(crate) fn get(&self, i: usize) -> &str {
        &self.bytes[self.offsets[i] as usize..self.offsets[i + 1] as usize]
    }

    pub(crate) fn slice(&self, range: Range<usize>) -> Text {
        Text { offsets: self.offsets.slice(range.start..range.end + 1), bytes: self.bytes.clone() }
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &str> + '_ {
        (0..self.len()).map(|i| self.get(i))
    }

    /// The offsets rebased to start at 0, and the UTF-8 text they index, for encoding a slice.
    pub(crate) fn compact(&self) -> (Vec<u32>, &str) {
        let base = self.offsets.first().copied().unwrap_or(0);
        let end = self.offsets.last().copied().unwrap_or(0);
        (self.offsets.iter().map(|o| o - base).collect(), &self.bytes[base as usize..end as usize])
    }

    pub(crate) fn from_parts(offsets: Vec<u32>, bytes: String) -> Option<Text> {
        let valid = offsets.first() == Some(&0)
            && offsets.windows(2).all(|w| w[0] <= w[1])
            && offsets.last().is_some_and(|&end| end as usize == bytes.len())
            && offsets.iter().all(|&o| bytes.is_char_boundary(o as usize));
        valid.then(|| Text { offsets: offsets.into(), bytes: bytes.into() })
    }
}

impl Default for Text {
    fn default() -> Text {
        Text { offsets: vec![0].into(), bytes: "".into() }
    }
}

impl<'a> FromIterator<&'a str> for Text {
    fn from_iter<I: IntoIterator<Item = &'a str>>(iter: I) -> Text {
        let mut builder = TextBuilder::default();
        for text in iter {
            builder.push(text);
        }
        builder.finish()
    }
}

impl std::fmt::Debug for Text {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.iter()).finish()
    }
}

/// Builds [`Text`] one string at a time.
pub(crate) struct TextBuilder {
    offsets: Vec<u32>,
    bytes: String,
}

impl Default for TextBuilder {
    fn default() -> TextBuilder {
        TextBuilder { offsets: vec![0], bytes: String::new() }
    }
}

impl TextBuilder {
    pub(crate) fn with_capacity(texts: usize) -> TextBuilder {
        let mut offsets = Vec::with_capacity(texts + 1);
        offsets.push(0);
        TextBuilder { offsets, bytes: String::new() }
    }

    pub(crate) fn push(&mut self, text: &str) {
        self.bytes.push_str(text);
        self.offsets.push(u32::try_from(self.bytes.len()).expect("a text page holds at most 4 GiB"));
    }

    pub(crate) fn finish(self) -> Text {
        Text { offsets: self.offsets.into(), bytes: self.bytes.into() }
    }
}
