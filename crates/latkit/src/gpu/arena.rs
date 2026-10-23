//! Data pages on the GPU: one pool of 64 Ki-word chunks in one storage buffer, which doubles as it
//! fills, up to the budget. A chunk is carved into blocks of one power-of-two size, and no page is
//! larger than a chunk: a geometry's points split into pieces of a chunk each. So the room any page
//! leaves serves any other: a chunk whose blocks all come back is carved again for another size.
//!
//! A page is identified by its id, the words of it a program reads, and its piece. Page tables pin
//! the pages they reference, so a page in use is never evicted; unpinned pages stay cached, the least
//! recently used going first when a page needs their room. Uploads stream within a per-frame byte
//! budget. A page that finds no room waits aside until pins let room go, while the pages after it go
//! on: views plan what they draw to fit the pool, so none waits long.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use rustc_hash::FxBuildHasher;

use crate::data::{AxisPage, FramePage, PageId, Value, Values};
use crate::expr::compile::Words;
use crate::gpu::shaders::{MISSING, NONE, POINT_BITS};
use crate::gpu::work::Queue;

/// Words in a chunk: the largest block, and the largest page.
pub(crate) const CHUNK_WORDS: u32 = 1 << 16;
/// Bytes in a chunk.
pub(crate) const CHUNK_BYTES: u64 = CHUNK_WORDS as u64 * 4;
const MIN_CLASS_BITS: u32 = 6;
const CLASSES: usize = (16 - MIN_CLASS_BITS + 1) as usize;
const INITIAL_CHUNKS: u32 = 16;
/// Points in a piece of a geometry's points: a chunk of x and y words.
pub(crate) const PIECE_POINTS: usize = 1 << POINT_BITS;

/// A page as a program reads it.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct PageKey {
    pub(crate) page: PageId,
    pub(crate) words: Words,
    /// The part `f32` drops of an `f64`, rather than the value.
    pub(crate) low: bool,
    /// Which piece of the page: a geometry's first points, then its points a chunk at a time; 0
    /// for every other page, which is one piece.
    pub(crate) piece: u32,
}

impl PageKey {
    /// The one piece of a page that is not a geometry's.
    pub(crate) fn of(page: PageId, words: Words, low: bool) -> PageKey {
        PageKey { page, words, low, piece: 0 }
    }
}

/// What to upload for a page.
pub(crate) enum Content {
    /// Static values, converted to words for `words`.
    Values { values: Values, words: Words, low: bool },
    /// A page of samples; one an append opened grows, and only its new tail uploads.
    Frames(FramePage),
    /// A page of where a level's entries draw along the axis; it grows like a page of samples.
    Axis(AxisPage),
    /// Words computed on the CPU: text codes, join rows, a geometry's pieces.
    Computed(Vec<u32>),
}

impl Content {
    /// Words in the page.
    fn len(&self) -> u32 {
        let len = match self {
            Content::Values { values, .. } => values.len(),
            Content::Frames(page) => page.read(<[f32]>::len),
            Content::Axis(page) => page.words_len(),
            Content::Computed(words) => words.len(),
        };
        debug_assert!(len <= CHUNK_WORDS as usize, "no page is larger than a chunk");
        len as u32
    }

    /// The page's words from word `from` on: a growing page uploads only its new tail.
    fn words(&self, from: usize) -> Vec<u32> {
        match self {
            Content::Values { values, words, low } => page_words(values, *words, *low).split_off(from),
            Content::Frames(page) => {
                page.read(|values| values[from.min(values.len())..].iter().map(|v| v.to_bits()).collect())
            }
            Content::Axis(page) => page.words(from),
            Content::Computed(words) => words[from.min(words.len())..].to_vec(),
        }
    }

    /// The class of the block it takes: a growing page takes a whole chunk to grow into.
    fn class(&self, words: u32) -> usize {
        match self {
            Content::Frames(page) if page.grows() => CLASSES - 1,
            Content::Axis(page) if page.grows() => CLASSES - 1,
            _ => class_of(words),
        }
    }
}

/// The class of a block holding `words`: the power of two at least that large.
fn class_of(words: u32) -> usize {
    let bits = words.max(1).next_power_of_two().trailing_zeros().max(MIN_CLASS_BITS);
    (bits - MIN_CLASS_BITS) as usize
}

fn class_words(class: usize) -> u32 {
    1 << (class as u32 + MIN_CLASS_BITS)
}

/// Blocks of `class` in a chunk.
fn slots(class: usize) -> u32 {
    CHUNK_WORDS / class_words(class)
}

/// What a page uploads as `words` reads it: numbers as `f32`, the low part of `f64`s, point
/// components, or reference rows as `u32`. Missing values are `MISSING`, or `NONE` for rows.
pub(crate) fn page_words(values: &Values, words: Words, low: bool) -> Vec<u32> {
    let n = values.len();
    let word = |x: f64| {
        let hi = x as f32;
        if low { (x - f64::from(hi)) as f32 } else { hi }.to_bits()
    };
    match words {
        Words::Values => values.map_numbers(|x| x.map_or(MISSING, word)),
        Words::Bits => values.map_numbers(|x| x.map_or(NONE, |x| x as u32)),
        Words::X | Words::Y => {
            let component = usize::from(words == Words::Y);
            let coords = values.geometry().map(crate::data::Geometry::coords);
            (0..n)
                .map(|i| match coords {
                    Some(coords) if values.is_valid(i) && coords[i][component].is_finite() => {
                        word(coords[i][component])
                    }
                    _ => MISSING,
                })
                .collect()
        }
        Words::Path => unreachable!("a geometry uploads in pieces"),
        Words::Codes => unreachable!("text codes upload as words"),
    }
}

/// Points a geometry page's rows take as shaders read them: every coordinate, and a break between a
/// row's parts or rings.
pub(crate) fn path_points(values: &Values) -> usize {
    let Some(geometry) = values.geometry() else { return 0 };
    (0..values.len()).filter(|&row| values.is_valid(row)).map(|row| geometry.row_points(row)).sum()
}

/// A geometry page's pieces, as `lib/read.wesl` reads them: each row's first point, then its points
/// a chunk at a time, every point an x and a y word. A row's parts, or its polygons' rings, are
/// broken by a missing point.
pub(crate) fn path_pieces(values: &Values) -> Vec<Vec<u32>> {
    let mut firsts = Vec::with_capacity(values.len());
    let mut pieces: Vec<Vec<u32>> = vec![Vec::new()];
    let mut points = 0_u32;
    let push = |point: [u32; 2], pieces: &mut Vec<Vec<u32>>, points: &mut u32| {
        if pieces.last().is_some_and(|p| p.len() == 2 * PIECE_POINTS) {
            pieces.push(Vec::with_capacity(2 * PIECE_POINTS));
        }
        pieces.last_mut().expect("a piece").extend(point);
        *points += 1;
    };
    let bits = |p: &[f64; 2]| p.map(|v| (v as f32).to_bits());
    for row in 0..values.len() {
        firsts.push(points);
        let parts: Vec<Vec<[f64; 2]>> = match values.get(row) {
            Some(Value::Point(p)) => vec![vec![p]],
            Some(Value::Path(path)) => vec![path],
            Some(Value::Parts(parts)) => parts,
            Some(Value::Polygons(polygons)) => polygons.into_iter().flatten().collect(),
            _ => Vec::new(),
        };
        for (k, part) in parts.iter().enumerate() {
            if k > 0 {
                push([MISSING, MISSING], &mut pieces, &mut points);
            }
            for p in part {
                push(bits(p), &mut pieces, &mut points);
            }
        }
    }
    if pieces.last().is_some_and(Vec::is_empty) {
        pieces.pop();
    }
    std::iter::once(firsts).chain(pieces).collect()
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

/// A chunk of the pool: free, or carved into blocks of one class with a bit for each that is free;
/// the class is the one whose chunks list it.
#[derive(Clone, Copy)]
struct Chunk {
    live: u32,
    free: [u64; 16],
}

impl Chunk {
    const FREE: Chunk = Chunk { live: 0, free: [0; 16] };

    /// Takes a free block, returning its slot.
    fn take(&mut self) -> u32 {
        let word = self.free.iter().position(|&w| w != 0).expect("a chunk listed with room has a free block");
        let bit = self.free[word].trailing_zeros();
        self.free[word] &= !(1 << bit);
        self.live += 1;
        word as u32 * 64 + bit
    }
}

pub(crate) struct Arena {
    buffer: wgpu::Buffer,
    chunks: Vec<Chunk>,
    /// The most chunks the pool grows to.
    limit: u32,
    /// Changes whenever the buffer is replaced, so views rebind it.
    pub(crate) generation: u64,
    /// Free chunks, and each class's chunks with a free block, lowest first so blocks gather low.
    free: BTreeSet<u32>,
    partial: [BTreeSet<u32>; CLASSES],
    blocks: HashMap<PageKey, Block, FxBuildHasher>,
    /// Unpinned, allocated blocks by when they were unpinned.
    unpinned: BTreeMap<u64, PageKey>,
    tick: u64,
    uploads: VecDeque<PageKey>,
    /// Pages that found no room, waiting for a pin to let some go.
    stuck: Vec<PageKey>,
    contents: HashMap<PageKey, Content, FxBuildHasher>,
    /// Bytes of allocated blocks.
    resident: u64,
}

impl Arena {
    /// A pool that grows to at most `bytes`, within what the device binds.
    pub(crate) fn new(device: &wgpu::Device, bytes: u64) -> Arena {
        let limit = limit_of(device, bytes);
        let chunks = INITIAL_CHUNKS.min(limit);
        Arena {
            buffer: create(device, chunks),
            chunks: vec![Chunk::FREE; chunks as usize],
            limit,
            generation: 0,
            free: (0..chunks).collect(),
            partial: Default::default(),
            blocks: HashMap::default(),
            unpinned: BTreeMap::new(),
            tick: 0,
            uploads: VecDeque::new(),
            stuck: Vec::new(),
            contents: HashMap::default(),
            resident: 0,
        }
    }

    pub(crate) fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }

    /// Lets the pool grow to at most `bytes` from now on; it never shrinks.
    pub(crate) fn set_limit(&mut self, device: &wgpu::Device, bytes: u64) {
        self.limit = limit_of(device, bytes).max(self.chunks.len() as u32);
    }

    /// The block holding at least `need` words of `key`, or `None` while it uploads.
    pub(crate) fn get(&mut self, key: PageKey, need: u32, content: impl FnOnce() -> Content) -> Option<u32> {
        if let Some(offset) = self.offset(key, need) {
            return Some(offset);
        }
        if let Entry::Vacant(entry) = self.contents.entry(key) {
            entry.insert(content());
            self.uploads.push_back(key);
        }
        None
    }

    /// The block holding at least `need` words of `key`, if one does.
    pub(crate) fn offset(&self, key: PageKey, need: u32) -> Option<u32> {
        self.blocks.get(&key).filter(|b| b.offset != NONE && b.written >= need).map(|b| b.offset)
    }

    /// Whether `key` waits to upload.
    pub(crate) fn queued(&self, key: PageKey) -> bool {
        self.contents.contains_key(&key)
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
        // Room let go may be what a page without room needs: it tries again first.
        for key in self.stuck.drain(..).rev() {
            self.uploads.push_front(key);
        }
    }

    /// Whether uploads are waiting that can make progress.
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
    /// A page that finds no room waits aside, and the pages after it go on; it tries again once a
    /// pin lets room go.
    pub(crate) fn pump(&mut self, device: &wgpu::Device, queue: &Queue, budget: u64) -> u64 {
        let mut bytes = 0;
        // Views drawn earlier in the frame spent it.
        if budget == 0 {
            return 0;
        }
        while (bytes == 0 || bytes < budget)
            && let Some(key) = self.uploads.pop_front()
        {
            let Some(content) = self.contents.remove(&key) else { continue };
            let resident = self.blocks.get(&key).filter(|b| b.offset != NONE).map(|b| (b.offset, b.class, b.written));
            let len = content.len();
            let (offset, written) = match resident {
                Some((offset, class, written)) if class_words(class) >= len => (offset, written),
                _ => {
                    let Some(offset) = self.place(device, queue, key, content.class(len)) else {
                        self.contents.insert(key, content);
                        self.stuck.push(key);
                        continue;
                    };
                    (offset, 0)
                }
            };
            let tail = content.words(written as usize);
            if !tail.is_empty() {
                queue.upload(&self.buffer, u64::from(offset + written) * 4, bytemuck::cast_slice(&tail));
                bytes += tail.len() as u64 * 4;
            }
            self.blocks.get_mut(&key).expect("placed").written = written + tail.len() as u32;
        }
        bytes
    }

    /// Allocates a block of `class` for `key`, releasing a smaller one it had.
    fn place(&mut self, device: &wgpu::Device, queue: &Queue, key: PageKey, class: usize) -> Option<u32> {
        let offset = self.allocate(device, queue, class, key)?;
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
        Some(offset)
    }

    fn release(&mut self, offset: u32, class: usize) {
        let k = offset / CHUNK_WORDS;
        let slot = (offset % CHUNK_WORDS) / class_words(class);
        let chunk = &mut self.chunks[k as usize];
        chunk.free[slot as usize / 64] |= 1 << (slot % 64);
        chunk.live -= 1;
        if chunk.live == 0 {
            *chunk = Chunk::FREE;
            self.partial[class].remove(&k);
            self.free.insert(k);
        } else {
            self.partial[class].insert(k);
        }
        self.resident -= u64::from(class_words(class)) * 4;
    }

    /// A block of `class`: a free one of its size, a free chunk carved, the pool grown, or room the
    /// least recently used unpinned blocks leave, whatever their size; `None` when every block left
    /// is pinned. `keep` is the page it is for, which is never evicted for itself.
    fn allocate(&mut self, device: &wgpu::Device, queue: &Queue, class: usize, keep: PageKey) -> Option<u32> {
        loop {
            if let Some(&k) = self.partial[class].first() {
                let chunk = &mut self.chunks[k as usize];
                let slot = chunk.take();
                if chunk.live == slots(class) {
                    self.partial[class].remove(&k);
                }
                return Some(k * CHUNK_WORDS + slot * class_words(class));
            }
            if let Some(k) = self.free.pop_first() {
                let slots = slots(class);
                let mut free = [0_u64; 16];
                for (w, word) in free.iter_mut().enumerate() {
                    let bits = slots.saturating_sub(w as u32 * 64).min(64);
                    *word = if bits == 64 { u64::MAX } else { (1 << bits) - 1 };
                }
                self.chunks[k as usize] = Chunk { live: 0, free };
                self.partial[class].insert(k);
                continue;
            }
            if self.grow(device, queue) {
                continue;
            }
            let (&tick, &key) = self.unpinned.iter().find(|&(_, k)| *k != keep)?;
            self.unpinned.remove(&tick);
            let block = self.blocks.remove(&key).expect("listed");
            self.release(block.offset, block.class);
        }
    }

    /// Doubles the buffer up to the limit, copying what it holds.
    fn grow(&mut self, device: &wgpu::Device, queue: &Queue) -> bool {
        let before = self.chunks.len() as u32;
        let chunks = (before * 2).min(self.limit);
        if chunks <= before {
            return false;
        }
        let buffer = create(device, chunks);
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit arena") });
        encoder.copy_buffer_to_buffer(&self.buffer, 0, &buffer, 0, self.buffer.size());
        queue.submit([encoder.finish()]);
        self.buffer = buffer;
        self.chunks.resize(chunks as usize, Chunk::FREE);
        self.free.extend(before..chunks);
        self.generation += 1;
        true
    }
}

/// Chunks a pool of at most `bytes` holds, within what the device binds: at least the first ones.
fn limit_of(device: &wgpu::Device, bytes: u64) -> u32 {
    let limits = device.limits();
    let bytes = bytes.min(limits.max_storage_buffer_binding_size).min(limits.max_buffer_size);
    ((bytes / CHUNK_BYTES).min(u64::from(u32::MAX / CHUNK_WORDS)) as u32).max(INITIAL_CHUNKS)
}

fn create(device: &wgpu::Device, chunks: u32) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("latkit pages"),
        size: u64::from(chunks) * CHUNK_BYTES,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_round_up_to_powers_of_two() {
        assert_eq!(class_of(1), 0);
        assert_eq!(class_words(class_of(64)), 64);
        assert_eq!(class_words(class_of(65)), 128);
        assert_eq!(class_words(class_of(65536)), 65536);
        assert_eq!(CLASSES, 11);
        assert_eq!(slots(0), 1024);
        assert_eq!(slots(CLASSES - 1), 1);
    }

    #[test]
    fn page_words_split_doubles() {
        let values = Values::from(vec![Some(1.0_f64 + 1e-9), None]);
        let hi = page_words(&values, Words::Values, false);
        let lo = page_words(&values, Words::Values, true);
        assert_eq!(hi[1], MISSING);
        let back = f64::from(f32::from_bits(hi[0])) + f64::from(f32::from_bits(lo[0]));
        assert!((back - (1.0 + 1e-9)).abs() < 1e-15);
    }

    #[test]
    fn geometry_pieces_hold_a_chunk_of_points_each() {
        let long: Vec<[f64; 2]> = (0..PIECE_POINTS + 10).map(|i| [i as f64, 0.0]).collect();
        let parts = vec![vec![[0.0, 0.0], [1.0, 1.0]], vec![[2.0, 2.0]]];
        let values = Values::from(vec![vec![long.clone()], Vec::new(), parts]);
        let pieces = path_pieces(&values);
        assert_eq!(pieces[0], vec![0, (PIECE_POINTS + 10) as u32, (PIECE_POINTS + 10) as u32], "first points");
        assert_eq!(pieces.len(), 3, "the first points, then two pieces of points");
        assert_eq!(pieces[1].len(), 2 * PIECE_POINTS);
        // The last row's two parts are broken by a missing point.
        assert_eq!(pieces[2].len(), 2 * (10 + 2 + 1 + 1));
        assert_eq!(path_points(&values), PIECE_POINTS + 10 + 4);
        assert!(pieces.iter().all(|p| p.len() <= CHUNK_WORDS as usize));
    }
}
