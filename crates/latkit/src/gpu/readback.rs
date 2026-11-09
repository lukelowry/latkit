//! Readbacks from the GPU. Bytes are copied in a frame's encoder and mapped when the caller submits
//! it, so reading never stalls a frame or submits on its own. Once mapped, a readback wakes its
//! waker. Map buffers come from a pool and return to it once read, so hovering allocates nothing.
//! The pool keeps at most `POOLED` bytes. A larger readback, such as a picture's, is retired once
//! read, as is one dropped while still mapping.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::Waker;

use super::retired::Retired;
use super::work::{Count, Counters};
use crate::{Error, Result};

/// Bytes of free map buffers a pool keeps: room for two 4K pictures' buffers, so a video reuses
/// its buffers frame after frame.
const POOLED: u64 = 64 << 20;

/// A pool of free map buffers. It also holds the counters for its readbacks and the number still
/// mapping. Each pool is created as counted or uncounted, so no pool skips counting by default.
#[derive(Clone)]
pub(crate) struct Readbacks {
    free: Arc<Mutex<Vec<wgpu::Buffer>>>,
    counters: Option<Arc<Counters>>,
    mapping: Arc<AtomicU64>,
    retired: Retired,
}

impl Readbacks {
    /// A pool whose readbacks are counted in `counters`, like the `Gpu`'s pool.
    pub(crate) fn counted(counters: Arc<Counters>, retired: &Retired) -> Readbacks {
        Readbacks { free: Arc::default(), counters: Some(counters), mapping: Arc::default(), retired: retired.clone() }
    }

    /// A pool whose readbacks are not counted: the native frame timer's, which only some devices
    /// support.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn uncounted(retired: &Retired) -> Readbacks {
        Readbacks { free: Arc::default(), counters: None, mapping: Arc::default(), retired: retired.clone() }
    }

    /// Returns `buffer` to the pool, or retires it when the pool holds `POOLED` bytes without it.
    fn give(&self, buffer: wgpu::Buffer) {
        let mut free = self.free.lock().unwrap_or_else(PoisonError::into_inner);
        if free.iter().map(wgpu::Buffer::size).sum::<u64>() + buffer.size() <= POOLED {
            free.push(buffer);
        } else {
            self.retired.retire(buffer);
        }
    }

    /// Readbacks from this pool the GPU has not mapped yet.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn mapping(&self) -> u64 {
        self.mapping.load(Ordering::Acquire)
    }

    fn take(&self, device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        if let Some(counters) = &self.counters {
            counters.add(Count::Readbacks, 1);
        }
        // WebGL maps a buffer by copying its entire allocation. Round only to the copy
        // alignment, so an NV12 frame does not transfer a power-of-two buffer's unused tail.
        let class = size.max(256).next_multiple_of(u64::from(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT));
        let mut free = self.free.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(i) = free.iter().position(|b| b.size() == class) {
            return free.swap_remove(i);
        }
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("latkit readback"),
            size: class,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }
}

/// The state of a readback's mapping.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mapping {
    Waiting,
    Ready,
    Failed,
    Read,
}

pub(crate) struct Readback {
    buffer: Option<wgpu::Buffer>,
    size: u64,
    range: std::ops::Range<usize>,
    rows: Vec<(usize, usize, usize, usize)>,
    pool: Readbacks,
    mapping: Arc<Mutex<Mapping>>,
}

/// One plane of packed 32-bit pixels, assembled by copies into its final rows. Regions must
/// cover the plane; each texture starts at its destination's pixel origin.
pub(crate) struct ImagePlane<'a> {
    pub(crate) size: [u32; 2],
    pub(crate) regions: Vec<([u32; 2], &'a wgpu::Texture)>,
}

impl Readback {
    /// Copies packed 32-bit texels from one image or several planes. Aligned rows copy in one
    /// command; row padding is stripped when producing the owned bytes.
    pub(crate) fn images(
        pool: &Readbacks,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        sources: &[ImagePlane<'_>],
        waker: &Waker,
    ) -> Readback {
        // One aligned copy per plane. Copying each unaligned row separately makes WebGL
        // fence and stage a buffer hundreds of times per frame. Strip only row padding
        // while producing the final owned bytes; pixel conversion remains on the GPU.
        let mut size = 0;
        let mut rows = Vec::with_capacity(sources.len());
        for plane in sources {
            let bytes = plane.size[0] * 4;
            let stride = bytes.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
            rows.push((size as usize, stride as usize, bytes as usize, plane.size[1] as usize));
            size += u64::from(stride) * u64::from(plane.size[1]);
        }
        let buffer = pool.take(device, size);
        for (plane, &(offset, stride, _, _)) in sources.iter().zip(&rows) {
            for &(origin, texture) in &plane.regions {
                assert!(origin[0] + texture.width() <= plane.size[0]);
                assert!(origin[1] + texture.height() <= plane.size[1]);
                encoder.copy_texture_to_buffer(
                    texture.as_image_copy(),
                    wgpu::TexelCopyBufferInfo {
                        buffer: &buffer,
                        layout: wgpu::TexelCopyBufferLayout {
                            offset: offset as u64 + u64::from(origin[1]) * stride as u64 + u64::from(origin[0]) * 4,
                            bytes_per_row: Some(stride as u32),
                            rows_per_image: None,
                        },
                    },
                    texture.size(),
                );
            }
        }
        let mut readback = Self::map(pool, encoder, buffer, size, 0..size as usize, waker);
        readback.rows = rows;
        readback
    }

    /// Copies `size` bytes of `source` from `offset`, to read once `encoder` is submitted. `waker`
    /// wakes when they can be read. Only the native frame timer reads a buffer.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn new(
        pool: &Readbacks,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Buffer,
        offset: u64,
        size: u64,
        waker: &Waker,
    ) -> Readback {
        let buffer = pool.take(device, size);
        encoder.copy_buffer_to_buffer(source, offset, &buffer, 0, size);
        Self::map(pool, encoder, buffer, size, 0..size as usize, waker)
    }

    /// Copies exact words from a texture, including unaligned starts and ends. Texture copies
    /// cover whole texels; the readback exposes only the requested bytes. Full rows batch in one
    /// copy, and boundary rows use no pitch, so there is no per-row CPU repacking.
    pub(crate) fn words(
        pool: &Readbacks,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &super::words::Words,
        at: u32,
        count: u32,
        waker: &Waker,
    ) -> Readback {
        use super::words::{ROW_WORDS, origin, spans};
        let from = at / 4 * 4;
        let words = (at - from + count).next_multiple_of(4).max(4);
        assert!(u64::from(from) + u64::from(words) <= source.capacity());
        let size = u64::from(words) * 4;
        let buffer = pool.take(device, size);
        for part in spans(from, words) {
            let extent = part.size();
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo { origin: origin(part.at), ..source.texture().as_image_copy() },
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: u64::from(part.offset) * 4,
                        bytes_per_row: (extent.height > 1).then_some(ROW_WORDS * 4),
                        rows_per_image: None,
                    },
                },
                extent,
            );
        }
        let start = (at - from) as usize * 4;
        Self::map(pool, encoder, buffer, size, start..start + count as usize * 4, waker)
    }

    fn map(
        pool: &Readbacks,
        encoder: &mut wgpu::CommandEncoder,
        buffer: wgpu::Buffer,
        size: u64,
        range: std::ops::Range<usize>,
        waker: &Waker,
    ) -> Readback {
        let mapping = Arc::new(Mutex::new(Mapping::Waiting));
        let done = mapping.clone();
        let waker = waker.clone();
        let pending = pool.mapping.clone();
        pending.fetch_add(1, Ordering::AcqRel);
        encoder.map_buffer_on_submit(&buffer, wgpu::MapMode::Read, ..size, move |result| {
            *done.lock().unwrap_or_else(PoisonError::into_inner) =
                if result.is_ok() { Mapping::Ready } else { Mapping::Failed };
            pending.fetch_sub(1, Ordering::AcqRel);
            waker.wake();
        });
        Readback { buffer: Some(buffer), size, range, rows: Vec::new(), pool: pool.clone(), mapping }
    }

    /// The bytes once mapped, or `None` while the GPU has not finished or after they were taken.
    /// Errors with `DeviceLost` if mapping failed.
    pub(crate) fn take(&self) -> Option<Result<Vec<u8>>> {
        self.take_into()
    }

    /// Move an owned browser mapping, or copy a native mapping directly into its consumer.
    pub(crate) fn take_into<T: for<'a> From<&'a [u8]> + From<Vec<u8>>>(&self) -> Option<Result<T>> {
        let mut mapping = self.mapping.lock().unwrap_or_else(PoisonError::into_inner);
        let buffer = self.buffer.as_ref()?;
        match *mapping {
            Mapping::Waiting | Mapping::Read => None,
            Mapping::Failed => Some(Err(Error::DeviceLost)),
            Mapping::Ready => {
                #[cfg(target_arch = "wasm32")]
                if let Some(mut bytes) = super::gl::take_read(buffer, self.size) {
                    self.compact(&mut bytes);
                    buffer.unmap();
                    *mapping = Mapping::Read;
                    return Some(Ok(T::from(bytes)));
                }
                let bytes = match buffer.get_mapped_range(..self.size) {
                    Ok(view) => {
                        if self.rows.iter().all(|&(_, stride, width, _)| stride == width) {
                            T::from(&view[self.range.clone()])
                        } else {
                            let mut bytes =
                                Vec::with_capacity(self.rows.iter().map(|&(_, _, bytes, rows)| bytes * rows).sum());
                            for &(offset, stride, width, count) in &self.rows {
                                if stride == width {
                                    bytes.extend_from_slice(&view[offset..offset + width * count]);
                                } else {
                                    for row in 0..count {
                                        let at = offset + row * stride;
                                        bytes.extend_from_slice(&view[at..at + width]);
                                    }
                                }
                            }
                            T::from(bytes)
                        }
                    }
                    Err(_) => return Some(Err(Error::DeviceLost)),
                };
                buffer.unmap();
                *mapping = Mapping::Read;
                Some(Ok(bytes))
            }
        }
    }

    /// Strip padding inside an owned mapping. Every destination precedes its source, so
    /// overlapping rows and multiple planes need neither scratch memory nor a second image.
    #[cfg(target_arch = "wasm32")]
    fn compact(&self, bytes: &mut Vec<u8>) {
        if self.rows.iter().all(|&(_, stride, width, _)| stride == width) {
            if self.range.start != 0 {
                bytes.copy_within(self.range.clone(), 0);
            }
            bytes.truncate(self.range.len());
            return;
        }
        let mut end = 0;
        for &(offset, stride, width, count) in &self.rows {
            for row in 0..count {
                let at = offset + row * stride;
                if at != end {
                    bytes.copy_within(at..at + width, end);
                }
                end += width;
            }
        }
        bytes.truncate(end);
    }
}

impl Drop for Readback {
    fn drop(&mut self) {
        let Some(buffer) = self.buffer.take() else { return };
        // A buffer still mapping cannot return to the pool, so it is retired instead.
        let mapping = *self.mapping.lock().unwrap_or_else(PoisonError::into_inner);
        if mapping == Mapping::Ready {
            buffer.unmap();
        }
        if matches!(mapping, Mapping::Ready | Mapping::Read) {
            self.pool.give(buffer);
        } else {
            self.pool.retired.retire(buffer);
        }
    }
}
