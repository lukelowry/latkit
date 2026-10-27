//! Little-endian bytes: the encoding of latkit's byte format, of the jobs it hands its host, and of
//! the binary formats it reads. [`Out`] writes values; [`In`] reads them back, returning `None`
//! past the end.

#[cfg(target_endian = "big")]
compile_error!("latkit's byte formats require a little-endian target");

/// Bytes being written.
#[derive(Default)]
pub(crate) struct Out(pub(crate) Vec<u8>);

impl Out {
    pub(crate) fn u8(&mut self, v: u8) {
        self.0.push(v);
    }

    pub(crate) fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    /// A count or a length, as a `u32`.
    pub(crate) fn len(&mut self, n: usize) {
        self.u32(u32::try_from(n).expect("counts fit in u32"));
    }

    pub(crate) fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    pub(crate) fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    /// A text: its byte length, then its UTF-8.
    pub(crate) fn str(&mut self, text: &str) {
        self.len(text.len());
        self.0.extend_from_slice(text.as_bytes());
    }

    /// Plain values, as their bytes.
    pub(crate) fn pod<T: bytemuck::Pod>(&mut self, values: &[T]) {
        self.0.extend_from_slice(bytemuck::cast_slice(values));
    }

    /// Bytes as they are.
    pub(crate) fn bytes(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
}

/// Gives a fieldless enum the `u32` code it is written as, `code`, and its reverse, `from_code`,
/// from one list of its variants and their codes.
#[cfg(feature = "gpu")]
macro_rules! codes {
    ($type:ty { $($variant:ident = $code:literal),+ $(,)? }) => {
        impl $type {
            /// The code this is written as.
            pub(crate) fn code(self) -> u32 {
                match self {
                    $(Self::$variant => $code,)+
                }
            }

            /// The value written as `code`; `None` for a code no value has.
            pub(crate) fn from_code(code: u32) -> Option<Self> {
                match code {
                    $($code => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

#[cfg(feature = "gpu")]
pub(crate) use codes;

/// Bytes being read, front to back.
pub(crate) struct In<'a>(&'a [u8]);

impl<'a> In<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> In<'a> {
        In(bytes)
    }

    /// The bytes not read yet.
    pub(crate) fn rest(&self) -> &'a [u8] {
        self.0
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Whether at least `n` bytes are left.
    pub(crate) fn has(&self, n: usize) -> bool {
        n <= self.0.len()
    }

    pub(crate) fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }

    pub(crate) fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.0.split_first_chunk::<N>()?;
        self.0 = rest;
        Some(*head)
    }

    pub(crate) fn u8(&mut self) -> Option<u8> {
        self.take().map(u8::from_le_bytes)
    }

    pub(crate) fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }

    pub(crate) fn u64(&mut self) -> Option<u64> {
        self.take().map(u64::from_le_bytes)
    }

    pub(crate) fn f64(&mut self) -> Option<f64> {
        self.take().map(f64::from_le_bytes)
    }

    /// A text written by [`Out::str`]; `None` unless it is UTF-8.
    pub(crate) fn str(&mut self) -> Option<&'a str> {
        let n = self.u32()? as usize;
        std::str::from_utf8(self.bytes(n)?).ok()
    }

    /// `n` plain values, copied out of their bytes.
    pub(crate) fn pod<T: bytemuck::Pod>(&mut self, n: usize) -> Option<Vec<T>> {
        let bytes = self.bytes(n.checked_mul(size_of::<T>())?)?;
        let mut values = vec![T::zeroed(); n];
        bytemuck::cast_slice_mut::<T, u8>(&mut values).copy_from_slice(bytes);
        Some(values)
    }

    /// A varint: seven bits a byte, lowest first, as protocol buffers and PMTiles write them.
    pub(crate) fn varint(&mut self) -> Option<u64> {
        let mut value = 0_u64;
        for shift in (0..64).step_by(7) {
            let byte = self.u8()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Some(value);
            }
        }
        None
    }
}

/// The words of `bytes`, ignoring a trailing partial word.
pub(crate) fn words(bytes: &[u8]) -> Vec<u32> {
    bytes.as_chunks::<4>().0.iter().map(|&word| u32::from_le_bytes(word)).collect()
}
