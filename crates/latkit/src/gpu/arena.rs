//! Pages on the GPU: one pool of 128 Ki-word chunks in one storage buffer, which doubles as it fills,
//! up to the budget. It holds the data's pages, which upload, and the pages of words each view's marks
//! keep per row, which the GPU writes. A chunk is carved into blocks of one power-of-two size, and no
//! page is larger than a chunk: a geometry's points split into pieces of a chunk each. So the room any
//! page leaves serves any other: a chunk whose blocks all come back is carved again for another size.
//! Few sizes in few chunks leave little room unused in chunks partly used, which a small budget feels.
//!
//! A data page is identified by its id, the words of it a program reads, and its piece. What a view
//! draws next reserves every page it reads at once, or none: those in the pool are pinned, and those
//! it lacks take blocks then, evicting the least recently used unpinned pages, so nothing is partly
//! pinned and no page waits for room. Page tables pin the pages they reference, so a page in use is
//! never evicted; unpinned pages stay cached. Uploads stream within a per-frame byte budget into the
//! blocks reserved. Views plan what they draw to fit the pool, so a reservation finding no room is
//! rare: it waits for the next frame, which grows the pool by what it lacked.
//!
//! A page of words per row is a block of its own: cleared as it is handed out, before anything writes
//! it, and freed only once the frame that let it go is done with it. The pool grows only before a
//! frame records writes to the pages, since growing copies what they hold: a block a frame finds no
//! room for then waits for the next.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use rustc_hash::FxBuildHasher;

use crate::data::{AxisPage, FRAME_PAGE_WORDS, FramePage, PageId, Value, Values};
use crate::expr::compile::Words;
use crate::gpu::shaders::{MISSING, NONE, POINT_BITS};
use crate::gpu::work::Queue;

/// Words in a chunk, as a shift: the largest block, and the largest page.
const CHUNK_BITS: u32 = 17;
pub(crate) const CHUNK_WORDS: u32 = 1 << CHUNK_BITS;
/// Bytes in a chunk.
pub(crate) const CHUNK_BYTES: u64 = CHUNK_WORDS as u64 * 4;
const MIN_CLASS_BITS: u32 = 6;
const CLASSES: usize = (CHUNK_BITS - MIN_CLASS_BITS + 1) as usize;
/// Words of a chunk's free bits: a bit for each block of the least class.
const FREE_WORDS: usize = 1 << (CHUNK_BITS - MIN_CLASS_BITS - 6);
const INITIAL_CHUNKS: u32 = 8;
/// Points in a piece of a geometry's points: a chunk of x and y words.
pub(crate) const PIECE_POINTS: usize = 1 << POINT_BITS;
const _: () = assert!(2 * PIECE_POINTS == CHUNK_WORDS as usize, "a piece of points fills a chunk");

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

/// A page a reservation asks for: what it is, the words it must hold, and, where the pool does not
/// hold them, what it uploads.
pub(crate) struct Ask {
    pub(crate) key: PageKey,
    pub(crate) need: u32,
    pub(crate) content: Option<Content>,
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

    /// The class of the block it takes: a growing page takes a block of the most words a page of its
    /// kind holds, to grow into.
    fn class(&self, words: u32) -> usize {
        match self {
            Content::Frames(page) if page.grows() => class_of(FRAME_PAGE_WORDS as u32),
            Content::Axis(page) if page.grows() => class_of(FRAME_PAGE_WORDS as u32),
            _ => class_of(words),
        }
    }
}

/// Words of the block that holds `words`.
pub(crate) fn rounded(words: u32) -> u32 {
    class_words(class_of(words))
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
    /// Offset in words.
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
    free: [u64; FREE_WORDS],
}

impl Chunk {
    const FREE: Chunk = Chunk { live: 0, free: [0; FREE_WORDS] };

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
    contents: HashMap<PageKey, Content, FxBuildHasher>,
    /// Bytes of allocated blocks.
    resident: u64,
    /// Blocks of their own handed out and not yet cleared; and those let go, freed once the frame is
    /// done with them.
    cleared: Vec<(u32, usize)>,
    freed: Vec<(u32, usize)>,
    /// Whether this frame recorded writes to the pages, after which the pool keeps its buffer; and the
    /// words of blocks it found no room for, which the next frame grows the pool by.
    writing: bool,
    short: u64,
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
            contents: HashMap::default(),
            resident: 0,
            cleared: Vec::new(),
            freed: Vec::new(),
            writing: false,
            short: 0,
        }
    }

    /// Begins a frame of every view drawing from the pool: frees the blocks the last one let go, and
    /// grows the pool by what it found no room for, before anything this frame writes the pages.
    pub(crate) fn begin_frame(&mut self, device: &wgpu::Device, queue: &Queue) {
        for (offset, class) in std::mem::take(&mut self.freed) {
            self.release(offset, class);
        }
        self.writing = false;
        let short = std::mem::take(&mut self.short).div_ceil(u64::from(CHUNK_WORDS));
        if short > 0 {
            let chunks = self.chunks.len() as u64;
            self.grow(device, queue, (chunks + short).max(2 * chunks).min(u64::from(u32::MAX)) as u32);
        }
    }

    /// Reserves every page `asks` names, or none: pins those the pool holds, and gives those it lacks
    /// blocks of their size, evicting the least recently used unpinned pages but never these, queuing
    /// what they upload, as for one the pool holds fewer words of than asked. `false` where a page
    /// finds no room, or lacks what it uploads: nothing is pinned, and the next frame grows the pool by
    /// what it lacked.
    pub(crate) fn reserve(&mut self, device: &wgpu::Device, queue: &Queue, asks: &mut [Ask]) -> bool {
        // Pages held are pinned first, so placing the rest evicts none of them.
        let held: Vec<bool> = asks.iter().map(|ask| self.blocks.contains_key(&ask.key)).collect();
        for ask in asks.iter().zip(&held).filter(|&(_, &held)| held).map(|(ask, _)| ask) {
            self.pin(ask.key);
        }
        let mut placed: HashMap<PageKey, (u32, usize), FxBuildHasher> = HashMap::default();
        let mut room = true;
        for (ask, _) in asks.iter().zip(&held).filter(|&(_, &held)| !held) {
            if placed.contains_key(&ask.key) {
                continue;
            }
            let class = ask.content.as_ref().map(|content| content.class(content.len().max(ask.need)));
            let Some(offset) = class.and_then(|class| self.allocate(device, queue, class)) else {
                room = false;
                break;
            };
            placed.insert(ask.key, (offset, class.expect("placed")));
        }
        if !room {
            for (offset, class) in placed.into_values() {
                self.release(offset, class);
            }
            for ask in asks.iter().zip(&held).filter(|&(_, &held)| held).map(|(ask, _)| ask) {
                self.unpin(ask.key);
            }
            return false;
        }
        for (key, (offset, class)) in placed {
            self.blocks.insert(key, Block { offset, class, written: 0, pins: 0, tick: 0 });
        }
        for (ask, held) in asks.iter_mut().zip(held) {
            if !held {
                self.pin(ask.key);
            }
            if self.blocks[&ask.key].written < ask.need
                && !self.contents.contains_key(&ask.key)
                && let Some(content) = ask.content.take()
            {
                self.contents.insert(ask.key, content);
                self.uploads.push_back(ask.key);
            }
        }
        true
    }

    /// A block of its own holding `words`, for a page of words per row, cleared by the next
    /// [`clear`](Arena::clear); `None` where the pool has no room now, which the next frame grows
    /// it by.
    pub(crate) fn block(&mut self, device: &wgpu::Device, queue: &Queue, words: u32) -> Option<u32> {
        let class = class_of(words);
        let offset = self.allocate(device, queue, class)?;
        self.cleared.push((offset, class));
        Some(offset)
    }

    /// Lets go of block `offset` of `words`, which [`block`](Arena::block) handed out: freed once
    /// this frame is done with it.
    pub(crate) fn free(&mut self, offset: u32, words: u32) {
        self.freed.push((offset, class_of(words)));
    }

    /// Clears the blocks handed out since the last clearing, at once: before anything this frame
    /// records or writes into them.
    pub(crate) fn clear(&mut self, device: &wgpu::Device, queue: &Queue) {
        if self.cleared.is_empty() {
            return;
        }
        let mut encoder =
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit clear") });
        for (offset, class) in self.cleared.drain(..) {
            encoder.clear_buffer(&self.buffer, u64::from(offset) * 4, Some(u64::from(class_words(class)) * 4));
        }
        queue.submit([encoder.finish()]);
    }

    /// Notes that this frame records writes to the pages: from now on it keeps the pool's buffer, which
    /// growing would copy before they run.
    pub(crate) fn written(&mut self) {
        self.writing = true;
    }

    pub(crate) fn buffer(&self) -> &wgpu::Buffer {
        &self.buffer
    }

    /// Whether the pool has grown as far as the budget lets it.
    pub(crate) fn full(&self) -> bool {
        self.chunks.len() as u32 >= self.limit
    }

    /// Lets the pool grow to at most `bytes` from now on; it never shrinks.
    pub(crate) fn set_limit(&mut self, device: &wgpu::Device, bytes: u64) {
        self.limit = limit_of(device, bytes).max(self.chunks.len() as u32);
    }

    /// The block holding at least `need` words of `key`, if one does.
    pub(crate) fn offset(&self, key: PageKey, need: u32) -> Option<u32> {
        self.blocks.get(&key).filter(|b| b.written >= need).map(|b| b.offset)
    }

    /// Bytes of the block `key` takes, or none.
    pub(crate) fn bytes_of(&self, key: PageKey) -> u64 {
        self.blocks.get(&key).map_or(0, |b| u64::from(class_words(b.class)) * 4)
    }

    /// Whether the pool holds, or is uploading, at least `need` words of `key`: a reservation asks
    /// for what it uploads only where not.
    pub(crate) fn holds(&self, key: PageKey, need: u32) -> bool {
        self.offset(key, need).is_some() || (self.blocks.contains_key(&key) && self.contents.contains_key(&key))
    }

    /// Keeps `key`, which the pool holds, while pinned; pins nest.
    fn pin(&mut self, key: PageKey) {
        let block = self.blocks.get_mut(&key).expect("a page reserved");
        if block.pins == 0 {
            self.unpinned.remove(&block.tick);
        }
        block.pins += 1;
    }

    /// Lets go of a pin a reservation took. A page no longer pinned stays cached, but one still
    /// uploading, which nothing waits for now: it goes, and its upload with it.
    pub(crate) fn unpin(&mut self, key: PageKey) {
        let Some(block) = self.blocks.get_mut(&key) else { return };
        block.pins -= 1;
        if block.pins > 0 {
            return;
        }
        if self.contents.remove(&key).is_some() {
            let block = self.blocks.remove(&key).expect("held");
            self.release(block.offset, block.class);
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

    /// Uploads queued pages into the blocks reserved for them, at least one and at most `budget` bytes;
    /// returns the bytes uploaded.
    pub(crate) fn pump(&mut self, queue: &Queue, budget: u64) -> u64 {
        let mut bytes = 0;
        // Views drawn earlier in the frame spent it.
        if budget == 0 {
            return 0;
        }
        let mut writes: Vec<(u32, Vec<u32>)> = Vec::new();
        while (bytes == 0 || bytes < budget)
            && let Some(key) = self.uploads.pop_front()
        {
            let Some(content) = self.contents.remove(&key) else { continue };
            let Some(block) = self.blocks.get_mut(&key) else { continue };
            let (offset, written) = (block.offset, block.written);
            let tail = content.words(written as usize);
            block.written = written + tail.len() as u32;
            if !tail.is_empty() {
                bytes += tail.len() as u64 * 4;
                writes.push((offset + written, tail));
            }
        }
        // Pages placed side by side, as a column's pages are, upload in one write.
        writes.sort_unstable_by_key(|&(at, _)| at);
        let mut run: Option<(u32, Vec<u32>)> = None;
        for (at, words) in writes {
            match &mut run {
                Some((start, joined)) if *start + joined.len() as u32 == at => joined.extend_from_slice(&words),
                _ => {
                    if let Some((start, joined)) = run.replace((at, words)) {
                        queue.upload(&self.buffer, u64::from(start) * 4, bytemuck::cast_slice(&joined));
                    }
                }
            }
        }
        if let Some((start, joined)) = run {
            queue.upload(&self.buffer, u64::from(start) * 4, bytemuck::cast_slice(&joined));
        }
        bytes
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

    /// A block of `class`: a free one of its size, a free chunk carved, the pool grown while this
    /// frame has not written the pages, or room the least recently used unpinned blocks leave,
    /// whatever their size; `None` when every block left is pinned or a block of its own, and the
    /// next frame grows the pool by it.
    fn allocate(&mut self, device: &wgpu::Device, queue: &Queue, class: usize) -> Option<u32> {
        loop {
            if let Some(&k) = self.partial[class].first() {
                let chunk = &mut self.chunks[k as usize];
                let slot = chunk.take();
                if chunk.live == slots(class) {
                    self.partial[class].remove(&k);
                }
                self.resident += u64::from(class_words(class)) * 4;
                return Some(k * CHUNK_WORDS + slot * class_words(class));
            }
            if let Some(k) = self.free.pop_first() {
                let slots = slots(class);
                let mut free = [0_u64; FREE_WORDS];
                for (w, word) in free.iter_mut().enumerate() {
                    let bits = slots.saturating_sub(w as u32 * 64).min(64);
                    *word = if bits == 64 { u64::MAX } else { (1 << bits) - 1 };
                }
                self.chunks[k as usize] = Chunk { live: 0, free };
                self.partial[class].insert(k);
                continue;
            }
            if !self.writing && self.grow(device, queue, 2 * self.chunks.len() as u32) {
                continue;
            }
            let Some((&tick, &key)) = self.unpinned.iter().next() else {
                self.short += u64::from(class_words(class));
                return None;
            };
            self.unpinned.remove(&tick);
            let block = self.blocks.remove(&key).expect("listed");
            self.release(block.offset, block.class);
        }
    }

    /// Grows the buffer to `chunks`, at most the limit, copying what it holds.
    fn grow(&mut self, device: &wgpu::Device, queue: &Queue, chunks: u32) -> bool {
        let before = self.chunks.len() as u32;
        let chunks = chunks.min(self.limit);
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
        assert_eq!(class_words(class_of(CHUNK_WORDS)), CHUNK_WORDS);
        assert_eq!(CLASSES, 12);
        assert_eq!(slots(0), 2048);
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
