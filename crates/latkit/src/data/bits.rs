use std::ops::Range;

use super::buffer::Buffer;

/// A shared, immutable bit vector, used for booleans and validity.
#[derive(Clone, Default)]
pub(crate) struct Bits {
    words: Buffer<u64>,
    offset: usize,
    len: usize,
}

impl Bits {
    pub(crate) fn len(&self) -> usize {
        self.len
    }

    pub(crate) fn get(&self, i: usize) -> bool {
        debug_assert!(i < self.len);
        let bit = self.offset + i;
        self.words[bit >> 6] >> (bit & 63) & 1 == 1
    }

    pub(crate) fn slice(&self, range: Range<usize>) -> Bits {
        assert!(range.start <= range.end && range.end <= self.len, "slice out of range");
        let bit = self.offset + range.start;
        let first = bit >> 6;
        let last = (self.offset + range.end).div_ceil(64);
        Bits { words: self.words.slice(first..last.max(first)), offset: bit & 63, len: range.end - range.start }
    }

    pub(crate) fn all(&self) -> bool {
        (0..self.len).all(|i| self.get(i))
    }

    /// The bits as little-endian words starting at bit 0, for byte encoding.
    pub(crate) fn to_words(&self) -> Vec<u64> {
        if self.offset == 0 {
            let mut words = self.words[..self.len.div_ceil(64)].to_vec();
            if !self.len.is_multiple_of(64)
                && let Some(last) = words.last_mut()
            {
                *last &= (1 << (self.len % 64)) - 1;
            }
            return words;
        }
        let mut builder = BitsBuilder::with_capacity(self.len);
        for i in 0..self.len {
            builder.push(self.get(i));
        }
        builder.finish().words[..].to_vec()
    }

    pub(crate) fn from_words(words: Vec<u64>, len: usize) -> Bits {
        assert!(words.len() * 64 >= len, "too few words");
        Bits { words: words.into(), offset: 0, len }
    }
}

impl FromIterator<bool> for Bits {
    fn from_iter<I: IntoIterator<Item = bool>>(iter: I) -> Bits {
        let iter = iter.into_iter();
        let mut builder = BitsBuilder::with_capacity(iter.size_hint().0);
        for bit in iter {
            builder.push(bit);
        }
        builder.finish()
    }
}

impl std::fmt::Debug for Bits {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries((0..self.len).map(|i| self.get(i))).finish()
    }
}

/// Builds [`Bits`] one bit at a time.
pub(crate) struct BitsBuilder {
    words: Vec<u64>,
    len: usize,
}

impl BitsBuilder {
    pub(crate) fn with_capacity(bits: usize) -> BitsBuilder {
        BitsBuilder { words: Vec::with_capacity(bits.div_ceil(64)), len: 0 }
    }

    pub(crate) fn push(&mut self, bit: bool) {
        if self.len.is_multiple_of(64) {
            self.words.push(0);
        }
        if bit {
            *self.words.last_mut().expect("pushed") |= 1 << (self.len & 63);
        }
        self.len += 1;
    }

    pub(crate) fn finish(self) -> Bits {
        Bits { words: self.words.into(), offset: 0, len: self.len }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slices_keep_bit_positions() {
        let bits: Bits = (0..200).map(|i| i % 3 == 0).collect();
        let slice = bits.slice(70..150);
        assert_eq!(slice.len(), 80);
        for i in 0..80 {
            assert_eq!(slice.get(i), (i + 70) % 3 == 0);
        }
        let words = slice.to_words();
        for i in 0..80 {
            assert_eq!(words[i >> 6] >> (i & 63) & 1 == 1, (i + 70) % 3 == 0);
        }
    }
}
