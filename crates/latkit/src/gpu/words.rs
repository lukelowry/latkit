//! Exact 32-bit words stored in unfiltered integer texture pages.
//!
//! Four consecutive words share a texel. Physical layers hold many logical arena chunks;
//! small stores allocate only the rows they need. Addressing never changes
//! when a store grows, so page tables and cached program addresses remain valid.

use super::retired::Retired;
use super::work::{Count, Queue};

pub(crate) const WIDTH: u32 = super::shaders::WORD_WIDTH;
pub(crate) const HEIGHT: u32 = super::shaders::WORD_HEIGHT;
pub(crate) const ROW_WORDS: u32 = WIDTH * 4;
pub(crate) const LAYER_WORDS: u32 = ROW_WORDS * HEIGHT;

/// A growable array of words. Writes and copies cover whole texels; callers own their padding.
pub(crate) struct Words {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    label: &'static str,
    retired: Retired,
    /// Relocation scratch, allocated only by stores that move ranges in place.
    scratch: Option<wgpu::Texture>,
}

fn capacity(texture: &wgpu::Texture) -> u64 {
    let size = texture.size();
    let layers = if size.height < HEIGHT { 1 } else { size.depth_or_array_layers };
    u64::from(size.width) * u64::from(size.height) * u64::from(layers) * 4
}

fn extent(words: u64, layers: u32) -> wgpu::Extent3d {
    let rows = words.max(1).div_ceil(u64::from(ROW_WORDS)).next_power_of_two();
    let depth = rows.div_ceil(u64::from(HEIGHT));
    assert!(depth <= u64::from(layers), "word store exceeds the texture layer limit");
    // Native GLES infers the texture target from its allocation; two layers keep its array
    // target. The browser driver chooses the target explicitly and needs no spare layer.
    let minimum_layers = if cfg!(target_arch = "wasm32") { 1 } else { 2 };
    // Before the first logical row is full, only its occupied prefix needs storage. Its texel
    // coordinates already match the final width, so growth never relocates a word.
    wgpu::Extent3d {
        width: words.max(1).div_ceil(4).next_power_of_two().min(u64::from(WIDTH)) as u32,
        height: rows.min(u64::from(HEIGHT)) as u32,
        depth_or_array_layers: (depth as u32).max(minimum_layers),
    }
}

pub(crate) fn origin(word: u32) -> wgpu::Origin3d {
    wgpu::Origin3d { x: word / 4 % WIDTH, y: word / ROW_WORDS % HEIGHT, z: word / LAYER_WORDS }
}

fn make(device: &wgpu::Device, label: &str, words: u64) -> wgpu::Texture {
    let desc = wgpu::TextureDescriptor {
        label: Some(label),
        size: extent(words, device.limits().max_texture_array_layers),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Uint,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST
            | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    };
    #[cfg(target_arch = "wasm32")]
    return super::gl::array_texture(device, &desc);
    #[cfg(not(target_arch = "wasm32"))]
    device.create_texture(&desc)
}

fn view(texture: &wgpu::Texture) -> wgpu::TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    })
}

impl Words {
    pub(crate) fn allocated(device: &wgpu::Device, retired: &Retired, label: &'static str, words: u64) -> Words {
        let texture = make(device, label, words);
        let view = view(&texture);
        Words { texture, view, label, retired: retired.clone(), scratch: None }
    }

    pub(crate) fn new(device: &wgpu::Device, retired: &Retired, label: &'static str) -> Words {
        Self::allocated(device, retired, label, 1)
    }

    pub(crate) fn binding(&self) -> wgpu::BindingResource<'_> {
        wgpu::BindingResource::TextureView(&self.view)
    }

    pub(crate) fn texture(&self) -> &wgpu::Texture {
        &self.texture
    }

    /// One renderable layer. The sampled view covers every layer, so a raster pass must write
    /// another store, even if it would read and write different layers of this one.
    pub(crate) fn attachment(&self, layer: u32) -> wgpu::TextureView {
        self.texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2),
            base_array_layer: layer,
            array_layer_count: Some(1),
            ..Default::default()
        })
    }

    pub(crate) fn copy_to(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        from: u32,
        destination: &Words,
        to: u32,
        words: u32,
    ) {
        self.check(from, words as usize);
        destination.check(to, words as usize);
        assert_ne!(self.texture, destination.texture, "word copies must not alias");
        copy(encoder, &self.texture, from, &destination.texture, to, words);
    }

    pub(crate) fn capacity(&self) -> u64 {
        capacity(&self.texture)
    }

    /// Grows without preserving contents. Returns whether bindings must be rebuilt.
    pub(crate) fn ensure(&mut self, device: &wgpu::Device, words: u64) -> bool {
        if words <= self.capacity() {
            return false;
        }
        let texture = make(device, self.label, words);
        self.view = view(&texture);
        self.retired.retire(std::mem::replace(&mut self.texture, texture));
        true
    }

    /// Grows and preserves the existing allocation, entirely on the GPU.
    pub(crate) fn grow(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, words: u64) -> bool {
        let old = self.texture.clone();
        if !self.ensure(device, words) {
            return false;
        }
        encoder.copy_texture_to_texture(old.as_image_copy(), self.texture.as_image_copy(), old.size());
        true
    }

    /// Writes aligned words before the next submission. Empty writes are free.
    pub(crate) fn write(&self, queue: &Queue, at: u32, words: &[u32]) {
        self.write_counted(queue, at, words, Count::Written);
    }

    fn write_counted(&self, queue: &Queue, at: u32, words: &[u32], count: Count) {
        self.check(at, words.len());
        for part in spans(at, words.len() as u32) {
            let bytes = bytemuck::cast_slice(&words[part.offset as usize..(part.offset + part.words) as usize]);
            queue.texture(
                wgpu::TexelCopyTextureInfo { origin: origin(part.at), ..self.texture.as_image_copy() },
                bytes,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(ROW_WORDS * 4), rows_per_image: None },
                part.size(),
                count,
            );
        }
    }

    /// Writes CPU-owned words, zero-padding the final texel. The caller owns that padding, so a
    /// partial replacement cannot overwrite a neighboring allocation. No temporary Vec is needed.
    pub(crate) fn write_padded(&self, queue: &Queue, at: u32, words: &[u32]) {
        self.padded(queue, at, words, Count::Written);
    }

    /// Uploads CPU data pages, accounting for the complete texels transferred.
    pub(crate) fn upload(&self, queue: &Queue, at: u32, words: &[u32], pages: u64) {
        self.padded(queue, at, words, Count::Uploaded);
        queue.pages(pages);
    }

    fn padded(&self, queue: &Queue, at: u32, words: &[u32], count: Count) {
        let whole = words.len() / 4 * 4;
        self.write_counted(queue, at, &words[..whole], count);
        if whole != words.len() {
            let mut tail = [0_u32; 4];
            tail[..words.len() - whole].copy_from_slice(&words[whole..]);
            self.write_counted(queue, at + whole as u32, &tail, count);
        }
    }

    /// Writes after earlier commands in the same encoder, including a growth or relocation.
    pub(crate) fn write_in(
        &self,
        device: &wgpu::Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        at: u32,
        words: &[u32],
    ) {
        self.check(at, words.len());
        if words.is_empty() {
            return;
        }
        let upload = queue.stage(device, bytemuck::cast_slice(words));
        for part in spans(at, words.len() as u32) {
            encoder.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo {
                    buffer: &upload,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: u64::from(part.offset) * 4,
                        bytes_per_row: Some(ROW_WORDS * 4),
                        rows_per_image: None,
                    },
                },
                wgpu::TexelCopyTextureInfo { origin: origin(part.at), ..self.texture.as_image_copy() },
                part.size(),
            );
        }
        self.retired.retire(upload);
    }

    /// Relocates aligned words through retained scratch. Both copies are recorded together,
    /// so later moves can reuse it without overwriting data a previous move still needs.
    pub(crate) fn move_words(
        &mut self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        from: u32,
        to: u32,
        words: u32,
    ) {
        self.check(from, words as usize);
        self.check(to, words as usize);
        if words == 0 || from == to {
            return;
        }
        if self.scratch.as_ref().is_none_or(|texture| capacity(texture) < u64::from(words)) {
            let next = make(device, "latkit word move", u64::from(words));
            if let Some(before) = self.scratch.replace(next) {
                self.retired.retire(before);
            }
        }
        let temporary = self.scratch.as_ref().expect("sized relocation scratch");
        copy(encoder, &self.texture, from, temporary, 0, words);
        copy(encoder, temporary, 0, &self.texture, to, words);
    }

    fn check(&self, at: u32, words: usize) {
        assert!(at.is_multiple_of(4) && words.is_multiple_of(4), "word writes must cover complete texels");
        assert!(u64::from(at) + words as u64 <= self.capacity(), "word write exceeds its allocation");
    }
}

impl Drop for Words {
    fn drop(&mut self) {
        self.retired.retire(self.texture.clone());
        if let Some(scratch) = self.scratch.take() {
            self.retired.retire(scratch);
        }
    }
}

/// One contiguous upload: a partial row, or complete rows within one layer.
#[derive(Debug, PartialEq)]
pub(crate) struct Span {
    pub(crate) at: u32,
    pub(crate) offset: u32,
    pub(crate) words: u32,
}

impl Span {
    pub(crate) fn size(&self) -> wgpu::Extent3d {
        wgpu::Extent3d {
            width: (self.words / 4).min(WIDTH),
            height: self.words.div_ceil(ROW_WORDS),
            depth_or_array_layers: 1,
        }
    }
}

pub(crate) fn spans(at: u32, words: u32) -> impl Iterator<Item = Span> {
    let mut offset = 0;
    std::iter::from_fn(move || {
        if offset == words {
            return None;
        }
        let at = at + offset;
        let left = words - offset;
        let count = if at.is_multiple_of(ROW_WORDS) && left >= ROW_WORDS {
            (left / ROW_WORDS * ROW_WORDS).min(LAYER_WORDS - at % LAYER_WORDS)
        } else {
            left.min(ROW_WORDS - at % ROW_WORDS)
        };
        let span = Span { at, offset, words: count };
        offset += count;
        Some(span)
    })
}

fn copy(
    encoder: &mut wgpu::CommandEncoder,
    source: &wgpu::Texture,
    from: u32,
    destination: &wgpu::Texture,
    to: u32,
    words: u32,
) {
    for region in copies(from, to, words) {
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { origin: origin(region.from), ..source.as_image_copy() },
            wgpu::TexelCopyTextureInfo { origin: origin(region.to), ..destination.as_image_copy() },
            wgpu::Extent3d { width: region.width / 4, height: region.rows, depth_or_array_layers: 1 },
        );
    }
}

/// A rectangular copy, with width in words. Consecutive rows are `ROW_WORDS` apart in both stores.
struct Copy {
    from: u32,
    to: u32,
    width: u32,
    rows: u32,
}

/// Copies a linear range with at most two rectangles per layer, plus partial boundary rows.
/// Differently aligned ranges split into two vertical strips; copying each row separately would
/// turn a large packed-list update into thousands of browser/driver calls.
fn copies(mut from: u32, mut to: u32, mut words: u32) -> Vec<Copy> {
    let mut regions = Vec::new();
    while words != 0 {
        let count = if from.is_multiple_of(ROW_WORDS) && words >= ROW_WORDS {
            let rows = words / ROW_WORDS;
            let first = ROW_WORDS - to % ROW_WORDS;
            rectangles(&mut regions, from, to, first, rows);
            if first < ROW_WORDS {
                rectangles(&mut regions, from + first, to + first, ROW_WORDS - first, rows);
            }
            rows * ROW_WORDS
        } else {
            let width = words.min(ROW_WORDS - from % ROW_WORDS).min(ROW_WORDS - to % ROW_WORDS);
            regions.push(Copy { from, to, width, rows: 1 });
            width
        };
        from += count;
        to += count;
        words -= count;
    }
    regions
}

/// Splits a vertical strip only where either texture crosses a layer boundary.
fn rectangles(regions: &mut Vec<Copy>, mut from: u32, mut to: u32, width: u32, mut rows: u32) {
    while rows != 0 {
        let count = rows.min(HEIGHT - from / ROW_WORDS % HEIGHT).min(HEIGHT - to / ROW_WORDS % HEIGHT);
        regions.push(Copy { from, to, width, rows: count });
        from += count * ROW_WORDS;
        to += count * ROW_WORDS;
        rows -= count;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_allocations_grow_rows_before_layers() {
        assert_eq!(extent(1, 256), wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 2 });
        assert_eq!(extent(17, 256), wgpu::Extent3d { width: 8, height: 1, depth_or_array_layers: 2 });
        assert_eq!(extent(u64::from(ROW_WORDS) + 1, 256).height, 2);
        assert_eq!(
            extent(u64::from(LAYER_WORDS) + 1, 256),
            wgpu::Extent3d { width: WIDTH, height: HEIGHT, depth_or_array_layers: 2 }
        );
    }

    #[test]
    fn uploads_split_at_row_and_layer_boundaries_without_gaps() {
        let start = ROW_WORDS - 12;
        let len = LAYER_WORDS + 28;
        let parts: Vec<_> = spans(start, len).collect();
        assert_eq!(parts.len(), 4);
        let mut next = start;
        for part in parts {
            assert_eq!(part.at, next);
            assert_eq!(part.offset, next - start);
            assert_eq!(part.words % 4, 0);
            let size = part.size();
            assert_eq!(size.width * size.height * 4, part.words);
            let where_ = origin(part.at);
            assert!(where_.x + size.width <= WIDTH);
            assert!(where_.y + size.height <= HEIGHT);
            next += part.words;
        }
        assert_eq!(next, start + len);
    }

    #[test]
    fn shifted_copies_cover_only_the_range_in_a_few_rectangles() {
        for from in [0, 4, ROW_WORDS - 12, LAYER_WORDS - 8] {
            for to in [0, 12, ROW_WORDS - 4, LAYER_WORDS - 16] {
                for words in [0, 4, 28, ROW_WORDS, LAYER_WORDS + 28] {
                    let regions = copies(from, to, words);
                    assert!(regions.len() <= 10, "a shifted layer takes a few rectangles");
                    let mut covered = vec![false; words as usize];
                    for c in regions {
                        let a = origin(c.from);
                        let b = origin(c.to);
                        assert!(a.x + c.width / 4 <= WIDTH && b.x + c.width / 4 <= WIDTH);
                        assert!(a.y + c.rows <= HEIGHT && b.y + c.rows <= HEIGHT);
                        for row in 0..c.rows {
                            let offset = c.from + row * ROW_WORDS - from;
                            assert_eq!(c.to + row * ROW_WORDS - to, offset);
                            for word in &mut covered[offset as usize..(offset + c.width) as usize] {
                                assert!(!*word, "each destination word is copied once");
                                *word = true;
                            }
                        }
                    }
                    assert!(covered.iter().all(|&word| word), "every requested word is copied");
                }
            }
        }
    }

    #[test]
    fn gpu_growth_relocation_and_ordered_writes_preserve_every_bit() {
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let mut store = Words::new(device, queue.retired(), "word test");
        let mut expected = vec![0_u32; LAYER_WORDS as usize * 4];
        let count = LAYER_WORDS + ROW_WORDS;
        for (i, word) in expected[..count as usize].iter_mut().enumerate() {
            // Include high bits and NaN-like payloads; a float conversion would lose them.
            *word = (i as u32).wrapping_mul(0x9e37_79b9) ^ 0xff80_0001;
        }
        assert_eq!(store.capacity(), 4, "a small store allocates only one texel per physical layer");
        store.write(queue, 0, &expected[..4]);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        assert!(store.grow(device, &mut encoder, u64::from(count)));
        store.write_in(device, queue, &mut encoder, 4, &expected[4..count as usize]);
        assert!(store.grow(device, &mut encoder, expected.len() as u64));
        // A large shifted range uses vertical strips, across different source/destination layers.
        let (from, to, count) = (4, LAYER_WORDS - 12, LAYER_WORDS + 28);
        store.move_words(device, &mut encoder, from, to, count);
        expected.copy_within(from as usize..(from + count) as usize, to as usize);
        // Both source and destination straddle a row, and the destination also straddles a layer.
        let (from, to, count) = (ROW_WORDS - 12, LAYER_WORDS - 8, 28);
        store.move_words(device, &mut encoder, from, to, count);
        expected.copy_within(from as usize..(from + count) as usize, to as usize);
        let after = [u32::MAX, 0x8000_0000, 0x7fc0_0001, 0];
        store.write_in(device, queue, &mut encoder, to + 4, &after);
        expected[(to + 4) as usize..(to + 8) as usize].copy_from_slice(&after);
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("word test readback"),
            size: store.capacity() * 4,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            store.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(ROW_WORDS * 4),
                    rows_per_image: Some(HEIGHT),
                },
            },
            store.texture.size(),
        );
        queue.submit([encoder.finish()]);
        let (sent, received) = std::sync::mpsc::channel();
        readback.slice(..).map_async(wgpu::MapMode::Read, move |answer| sent.send(answer).unwrap());
        device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(10)) })
            .unwrap();
        received.recv().unwrap().unwrap();
        assert_eq!(bytemuck::cast_slice::<u8, u32>(&readback.slice(..).get_mapped_range().unwrap()), expected);
    }
}
