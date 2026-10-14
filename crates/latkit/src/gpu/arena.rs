//! Data pages on the GPU: power-of-two blocks carved from 64 Ki-word chunks of one storage buffer;
//! a page larger than a chunk, such as a geometry's points, takes whole chunks side by side.
//!
//! A page is identified by its id and the part of it a program reads. Page tables pin the pages they
//! reference, so a page in use is never evicted; unpinned pages stay cached in least-recently-used
//! order until the budget needs their room. Uploads stream within a per-frame byte budget.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap, VecDeque};

use rustc_hash::FxBuildHasher;

use crate::data::{AxisPage, FramePage, Geometry, PageId, Value, Values};
use crate::expr::compile::Part;
use crate::gpu::shaders::{MISSING, NONE};
use crate::{Error, Result};

/// Words in a chunk: the largest block.
pub(crate) const CHUNK_WORDS: u32 = 1 << 16;
const MIN_CLASS_BITS: u32 = 6;
const CLASSES: usize = (16 - MIN_CLASS_BITS + 1) as usize;
const INITIAL_CHUNKS: u32 = 16;

/// A page as a program reads it.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct PageKey {
    pub(crate) page: PageId,
    pub(crate) part: Part,
    /// The part `f32` drops of an `f64`, rather than the value.
    pub(crate) low: bool,
}

/// What to upload for a page.
pub(crate) enum Content {
    /// Static values, converted to words for `part`.
    Values { values: Values, part: Part, low: bool },
    /// A page of samples; it may grow, and only its new tail uploads.
    Frames(FramePage),
    /// A page of axis coordinates; it grows like a page of samples.
    Axis(AxisPage),
    /// Words computed on the CPU: text codes, join rows.
    Words(Vec<u32>),
}

impl Content {
    /// Words in the page.
    fn len(&self) -> u32 {
        match self {
            Content::Values { values, .. } => values.len() as u32,
            Content::Frames(page) => page.read(<[f32]>::len) as u32,
            Content::Axis(page) => page.read(<[u32]>::len) as u32,
            Content::Words(words) => words.len() as u32,
        }
    }

    /// The page's words from word `from` on: a growing page uploads only its new tail.
    fn words(&self, from: usize) -> Vec<u32> {
        match self {
            Content::Values { values, part, low } => page_words(values, *part, *low).split_off(from),
            Content::Frames(page) => {
                page.read(|values| values[from.min(values.len())..].iter().map(|v| v.to_bits()).collect())
            }
            Content::Axis(page) => page.read(|words| words[from.min(words.len())..].to_vec()),
            Content::Words(words) => words[from.min(words.len())..].to_vec(),
        }
    }

    fn class(&self, words: u32) -> usize {
        match self {
            Content::Frames(_) | Content::Axis(_) => CLASSES - 1,
            _ => class_of(words),
        }
    }
}

/// The class of a block holding `words`: a power of two up to a chunk, then whole chunks.
fn class_of(words: u32) -> usize {
    if words > CHUNK_WORDS {
        return CLASSES - 2 + words.div_ceil(CHUNK_WORDS) as usize;
    }
    let bits = words.max(1).next_power_of_two().trailing_zeros().max(MIN_CLASS_BITS);
    (bits - MIN_CLASS_BITS) as usize
}

/// Chunks a block of `class` takes side by side, past the largest carved class.
fn chunks_of(class: usize) -> u32 {
    (class + 2 - CLASSES) as u32
}

fn class_words(class: usize) -> u32 {
    if class >= CLASSES {
        return CHUNK_WORDS * chunks_of(class);
    }
    1 << (class as u32 + MIN_CLASS_BITS)
}

/// The words a page uploads for `part`: numbers as `f32`, the low part of `f64`s, point components,
/// reference rows as `u32`, or a geometry's points. Missing values are `MISSING`, or `NONE` for rows.
pub(crate) fn page_words(values: &Values, part: Part, low: bool) -> Vec<u32> {
    let n = values.len();
    let word = |x: f64| {
        let hi = x as f32;
        if low { (x - f64::from(hi)) as f32 } else { hi }.to_bits()
    };
    match part {
        Part::Path => path_words(values),
        Part::Values => values.map_numbers(|x| x.map_or(MISSING, word)),
        Part::Bits => values.map_numbers(|x| x.map_or(NONE, |x| x as u32)),
        Part::X | Part::Y => {
            let component = usize::from(part == Part::Y);
            let coords = values.geometry().map(Geometry::coords);
            (0..n)
                .map(|i| match coords {
                    Some(coords) if values.is_valid(i) && coords[i][component].is_finite() => {
                        word(coords[i][component])
                    }
                    _ => MISSING,
                })
                .collect()
        }
        Part::Codes => unreachable!("text codes upload as words"),
    }
}

/// A geometry page's points, as `lib/read.wesl` reads them: the row count, each row's first point
/// and the end, then every point's x and y. A row's parts, or its polygons' rings, are broken by a
/// missing point.
fn path_words(values: &Values) -> Vec<u32> {
    let n = values.len();
    let mut starts = Vec::with_capacity(n + 1);
    let mut points: Vec<u32> = Vec::new();
    let push = |part: &[[f64; 2]], points: &mut Vec<u32>, first: bool| {
        if !first {
            points.extend([MISSING, MISSING]);
        }
        points.extend(part.iter().flat_map(|p| p.map(|v| (v as f32).to_bits())));
    };
    for row in 0..n {
        starts.push((points.len() / 2) as u32);
        match values.get(row) {
            Some(Value::Point(p)) => push(&[p], &mut points, true),
            Some(Value::Path(path)) => push(&path, &mut points, true),
            Some(Value::Parts(parts)) => {
                for (k, part) in parts.iter().enumerate() {
                    push(part, &mut points, k == 0);
                }
            }
            Some(Value::Polygons(polygons)) => {
                for (k, ring) in polygons.iter().flatten().enumerate() {
                    push(ring, &mut points, k == 0);
                }
            }
            _ => {}
        }
    }
    starts.push((points.len() / 2) as u32);
    let mut words = Vec::with_capacity(1 + starts.len() + points.len());
    words.push(n as u32);
    words.extend(starts);
    words.extend(points);
    words
}

struct Block {
    /// Offset in words, or `NONE` until allocated.
    offset: u32,
    class: usize,
    /// Words uploaded so far.
    written: u32,
    pins: u32,
    /// When it was last unpinned, its place in the LRU.
    tick: u64,
}

pub(crate) struct Arena {
    buffer: wgpu::Buffer,
    /// Chunks the buffer holds, and chunks carved into blocks so far.
    chunks: u32,
    carved: u32,
    /// Changes whenever the buffer is replaced, so views rebind it.
    pub(crate) generation: u64,
    free: [Vec<u32>; CLASSES],
    blocks: HashMap<PageKey, Block, FxBuildHasher>,
    /// Unpinned, allocated blocks by when they were unpinned.
    unpinned: BTreeMap<u64, PageKey>,
    tick: u64,
    uploads: VecDeque<PageKey>,
    contents: HashMap<PageKey, Content, FxBuildHasher>,
    /// Bytes of allocated blocks.
    resident: u64,
}

impl Arena {
    pub(crate) fn new(device: &wgpu::Device) -> Arena {
        Arena {
            buffer: create(device, INITIAL_CHUNKS),
            chunks: INITIAL_CHUNKS,
            carved: 0,
            generation: 0,
            free: Default::default(),
            blocks: HashMap::default(),
            unpinned: BTreeMap::new(),
            tick: 0,
            uploads: VecDeque::new(),
            contents: HashMap::default(),
            resident: 0,
        }
    }

    pub(crate) fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }

    /// The block holding at least `need` words of `key`, or `None` while it uploads.
    pub(crate) fn get(&mut self, key: PageKey, need: u32, content: impl FnOnce() -> Content) -> Option<u32> {
        if let Some(block) = self.blocks.get(&key)
            && block.offset != NONE
            && block.written >= need
        {
            return Some(block.offset);
        }
        if let Entry::Vacant(entry) = self.contents.entry(key) {
            entry.insert(content());
            self.uploads.push_back(key);
        }
        None
    }

    /// Keeps `key` resident while pinned; pins nest.
    pub(crate) fn pin(&mut self, key: PageKey) {
        let block = self.blocks.entry(key).or_insert(Block { offset: NONE, class: 0, written: 0, pins: 0, tick: 0 });
        if block.pins == 0 && block.offset != NONE {
            self.unpinned.remove(&block.tick);
        }
        block.pins += 1;
    }

    pub(crate) fn unpin(&mut self, key: PageKey) {
        let Some(block) = self.blocks.get_mut(&key) else { return };
        block.pins -= 1;
        if block.pins > 0 {
            return;
        }
        if block.offset == NONE {
            self.blocks.remove(&key);
            self.contents.remove(&key);
            return;
        }
        self.tick += 1;
        block.tick = self.tick;
        self.unpinned.insert(self.tick, key);
    }

    /// Whether uploads are waiting.
    pub(crate) fn uploading(&self) -> bool {
        !self.uploads.is_empty()
    }

    /// Bytes waiting to upload.
    pub(crate) fn pending(&self) -> u64 {
        self.contents.values().map(|c| u64::from(c.len()) * 4).sum()
    }

    /// Bytes of resident blocks.
    pub(crate) fn resident(&self) -> u64 {
        self.resident
    }

    /// Uploads queued pages, at least one and at most `budget` bytes; returns the bytes uploaded.
    ///
    /// A page that finds no room stays queued at the front, and the error says why; later pages wait
    /// behind it, so the pages of one table upload in order.
    pub(crate) fn pump(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, budget: u64, keep: u64) -> Result<u64> {
        let mut bytes = 0;
        while (bytes == 0 || bytes < budget)
            && let Some(key) = self.uploads.pop_front()
        {
            let Some(content) = self.contents.remove(&key) else { continue };
            let resident = self.blocks.get(&key).filter(|b| b.offset != NONE).map(|b| (b.offset, b.class, b.written));
            let len = content.len();
            let (offset, written) = match resident {
                Some((offset, class, written)) if class_words(class) >= len => (offset, written),
                _ => match self.place(device, queue, key, content.class(len)) {
                    Ok(offset) => (offset, 0),
                    Err(error) => {
                        self.contents.insert(key, content);
                        self.uploads.push_front(key);
                        self.trim(keep);
                        return Err(error);
                    }
                },
            };
            let tail = content.words(written as usize);
            if !tail.is_empty() {
                queue.write_buffer(&self.buffer, u64::from(offset + written) * 4, bytemuck::cast_slice(&tail));
                bytes += tail.len() as u64 * 4;
            }
            self.blocks.get_mut(&key).expect("placed").written = written + tail.len() as u32;
        }
        self.trim(keep);
        Ok(bytes)
    }

    /// Allocates a block of `class` for `key`, releasing a smaller one it had.
    fn place(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, key: PageKey, class: usize) -> Result<u32> {
        let offset = self.allocate(device, queue, class)?;
        if let Some(old) = self.blocks.get(&key).filter(|b| b.offset != NONE) {
            let (old_offset, old_class) = (old.offset, old.class);
            self.release(old_offset, old_class);
        }
        let block = self.blocks.entry(key).or_insert(Block { offset: NONE, class, written: 0, pins: 0, tick: 0 });
        let pinned = block.pins > 0;
        block.offset = offset;
        block.class = class;
        block.written = 0;
        self.resident += u64::from(class_words(class)) * 4;
        if !pinned {
            self.tick += 1;
            block.tick = self.tick;
            self.unpinned.insert(self.tick, key);
        }
        Ok(offset)
    }

    /// Evicts unpinned blocks, oldest first, until at most `keep` bytes are resident.
    fn trim(&mut self, keep: u64) {
        while self.resident > keep
            && let Some((_, key)) = self.unpinned.pop_first()
        {
            if let Some(block) = self.blocks.remove(&key) {
                self.release(block.offset, block.class);
            }
        }
    }

    fn release(&mut self, offset: u32, class: usize) {
        if class >= CLASSES {
            // A large block's chunks return one by one.
            for k in 0..chunks_of(class) {
                self.free[CLASSES - 1].push(offset + k * CHUNK_WORDS);
            }
        } else {
            self.free[class].push(offset);
        }
        self.resident -= u64::from(class_words(class)) * 4;
    }

    fn allocate(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, class: usize) -> Result<u32> {
        if class >= CLASSES {
            // Whole chunks side by side, from the uncarved end of the buffer.
            let count = chunks_of(class);
            loop {
                if self.carved + count <= self.chunks {
                    let offset = self.carved * CHUNK_WORDS;
                    self.carved += count;
                    return Ok(offset);
                }
                if !self.grow(device, queue) {
                    return Err(Error::Limit("a geometry page exceeds the GPU's largest storage buffer".into()));
                }
            }
        }
        loop {
            if let Some(offset) = self.free[class].pop() {
                return Ok(offset);
            }
            if self.carved < self.chunks {
                let chunk = self.carved * CHUNK_WORDS;
                self.carved += 1;
                let size = class_words(class);
                self.free[class].extend((0..CHUNK_WORDS / size).rev().map(|i| chunk + i * size));
                continue;
            }
            if self.grow(device, queue) {
                continue;
            }
            // At the device's limit: evict the oldest unpinned block of this class.
            let victim =
                self.unpinned.iter().find(|(_, key)| self.blocks[key].class == class).map(|(&tick, &key)| (tick, key));
            let Some((tick, key)) = victim else {
                return Err(Error::Limit("the data drawn exceeds the GPU's largest storage buffer".into()));
            };
            self.unpinned.remove(&tick);
            let block = self.blocks.remove(&key).expect("listed");
            self.release(block.offset, block.class);
        }
    }

    /// Doubles the buffer up to the device's limit, copying what it holds.
    fn grow(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) -> bool {
        let limits = device.limits();
        let max_bytes = limits.max_storage_buffer_binding_size.min(limits.max_buffer_size);
        let max_chunks = (max_bytes / (u64::from(CHUNK_WORDS) * 4)).min(u64::from(u32::MAX / CHUNK_WORDS)) as u32;
        let chunks = (self.chunks * 2).min(max_chunks);
        if chunks <= self.chunks {
            return false;
        }
        let buffer = create(device, chunks);
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit arena") });
        encoder.copy_buffer_to_buffer(&self.buffer, 0, &buffer, 0, self.buffer.size());
        queue.submit([encoder.finish()]);
        self.buffer = buffer;
        self.chunks = chunks;
        self.generation += 1;
        true
    }
}

fn create(device: &wgpu::Device, chunks: u32) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("latkit pages"),
        size: u64::from(chunks) * u64::from(CHUNK_WORDS) * 4,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_round_up_to_powers_of_two_then_chunks() {
        assert_eq!(class_of(1), 0);
        assert_eq!(class_words(class_of(64)), 64);
        assert_eq!(class_words(class_of(65)), 128);
        assert_eq!(class_words(class_of(65536)), 65536);
        assert_eq!(class_words(class_of(65537)), 2 * 65536);
        assert_eq!(class_words(class_of(5 * 65536)), 5 * 65536);
        assert_eq!(CLASSES, 11);
    }

    #[test]
    fn page_words_split_doubles() {
        let values = Values::from(vec![Some(1.0_f64 + 1e-9), None]);
        let hi = page_words(&values, Part::Values, false);
        let lo = page_words(&values, Part::Values, true);
        assert_eq!(hi[1], MISSING);
        let back = f64::from(f32::from_bits(hi[0])) + f64::from(f32::from_bits(lo[0]));
        assert!((back - (1.0 + 1e-9)).abs() < 1e-15);
    }
}
