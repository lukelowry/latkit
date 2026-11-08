//! The browser build's shaders: each built entry point's GLSL, and the custom marker shaders' WGSL,
//! by key, as `build/shaders.rs` stores them. The store is a file of its own, `shaders.bin` in the
//! build's output, which the page loads beside the WebAssembly and hands over with
//! [`Browser::set_shaders`](crate::host::Browser::set_shaders). Each block of text inflates the first
//! time a shader needs it, and stays.

use std::io::Read as _;
use std::sync::OnceLock;

static STORE: OnceLock<Store> = OnceLock::new();

/// Keeps the store's `bytes`. Later calls change nothing: a page has one build's shaders.
pub(crate) fn set(bytes: Vec<u8>) -> crate::Result<()> {
    if STORE.get().is_none() {
        let store = Store::read(bytes).ok_or_else(|| crate::Error::invalid("not latkit's shader store"))?;
        let _ = STORE.set(store);
    }
    Ok(())
}

/// Whether the page handed over the store.
pub(crate) fn loaded() -> bool {
    STORE.get().is_some()
}

/// The text stored at `key`, such as the GLSL of `"Points vertex [0, 1, 1, 1, 0, 1, 0]"`.
pub(crate) fn text(key: &str) -> Option<String> {
    STORE.get()?.text(key)
}

struct Store {
    bytes: Vec<u8>,
    /// Each chunk's block, start, and length in bytes.
    chunks: Vec<[u32; 3]>,
    /// Each text's chunks, by key.
    texts: hashbrown::HashMap<Box<str>, Box<[u32]>>,
    /// Each block's compressed bytes in `bytes`, its inflated size, and its text once inflated.
    blocks: Vec<(std::ops::Range<usize>, usize, OnceLock<Box<str>>)>,
}

/// The little-endian word at `at`, advancing it.
fn word(bytes: &[u8], at: &mut usize) -> Option<u32> {
    let value = u32::from_le_bytes(bytes.get(*at..*at + 4)?.try_into().ok()?);
    *at += 4;
    Some(value)
}

fn inflate(bytes: &[u8], size: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(size);
    flate2::read::DeflateDecoder::new(bytes).read_to_end(&mut out).ok()?;
    Some(out)
}

impl Store {
    fn read(bytes: Vec<u8>) -> Option<Store> {
        let mut at = 0;
        let packed = word(&bytes, &mut at)? as usize;
        let size = word(&bytes, &mut at)? as usize;
        let index = inflate(bytes.get(at..at + packed)?, size)?;
        at += packed;
        let mut blocks = Vec::new();
        for _ in 0..word(&bytes, &mut at)? {
            let packed = word(&bytes, &mut at)? as usize;
            let size = word(&bytes, &mut at)? as usize;
            bytes.get(at..at + packed)?;
            blocks.push((at..at + packed, size, OnceLock::new()));
            at += packed;
        }
        let mut at = 0;
        let mut chunks = Vec::new();
        for _ in 0..word(&index, &mut at)? {
            chunks.push([word(&index, &mut at)?, word(&index, &mut at)?, word(&index, &mut at)?]);
        }
        let count = word(&index, &mut at)? as usize;
        let mut texts = hashbrown::HashMap::with_capacity(count);
        for _ in 0..count {
            let length = u16::from_le_bytes([*index.get(at)?, *index.get(at + 1)?]) as usize;
            let key = std::str::from_utf8(index.get(at + 2..at + 2 + length)?).ok()?;
            at += 2 + length;
            let ids: Option<Box<[u32]>> = (0..word(&index, &mut at)?).map(|_| word(&index, &mut at)).collect();
            texts.insert(key.into(), ids?);
        }
        Some(Store { bytes, chunks, texts, blocks })
    }

    fn text(&self, key: &str) -> Option<String> {
        let ids = self.texts.get(key)?;
        let mut text = String::new();
        for &id in ids {
            let [block, start, length] = *self.chunks.get(id as usize)?;
            let (range, size, inflated) = self.blocks.get(block as usize)?;
            let block = inflated.get_or_init(|| {
                let bytes = inflate(&self.bytes[range.clone()], *size).unwrap_or_default();
                String::from_utf8(bytes).unwrap_or_default().into_boxed_str()
            });
            text.push_str(block.get(start as usize..(start + length) as usize)?);
        }
        Some(text)
    }
}
