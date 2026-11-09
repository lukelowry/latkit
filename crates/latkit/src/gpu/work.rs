//! Exact counts of the work a `Gpu` does. Unlike timings, the counts repeat across runs and
//! machines for the same budget, device limits, and frames drawn. The benchmark gates on them and
//! tests assert them.
//!
//! Every write to the GPU goes through [`Queue`], which counts it. Clippy forbids the raw queue's
//! writes anywhere else. The pipelines, the readback pool, and the atlas hold the counters
//! themselves, and views count each frame's jobs and evaluations through the `Gpu`.

use std::collections::HashMap;
use std::ops::{Deref, Sub};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex, PoisonError};

use super::retired::Retired;

/// Defines [`Work`], a [`Count`] variant for each of its fields, and the [`Counters`] that hold
/// them, from one list.
macro_rules! work {
    ($($(#[$doc:meta])* $field:ident: $count:ident,)*) => {
        /// Counts of the work a [`Gpu`](crate::Gpu) has done since it was created. Subtract two
        /// snapshots to get the work between them.
        #[derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Serialize, schemars::JsonSchema)]
        pub struct Work {
            $($(#[$doc])* pub $field: u64,)*
        }

        /// A kind of work a `Gpu` counts.
        #[derive(Clone, Copy)]
        pub(crate) enum Count {
            $($count,)*
        }

        /// The counters, shared by every view of a `Gpu` and updated from any thread.
        #[derive(Default)]
        pub(crate) struct Counters {
            $($field: AtomicU64,)*
        }

        impl Counters {
            pub(crate) fn add(&self, count: Count, n: u64) {
                let counter = match count {
                    $(Count::$count => &self.$field,)*
                };
                counter.fetch_add(n, Relaxed);
            }

            pub(crate) fn work(&self) -> Work {
                Work { $($field: self.$field.load(Relaxed),)* }
            }
        }

        impl Sub for Work {
            type Output = Work;

            fn sub(self, before: Work) -> Work {
                Work { $($field: self.$field.saturating_sub(before.$field),)* }
            }
        }
    };
}

work! {
    /// Bytes of data pages uploaded.
    uploaded: Uploaded,
    /// Data pages, or pieces of pages, uploaded. A change's uploads count pages here and bytes in
    /// `uploaded`.
    uploads: Uploads,
    /// Bytes written other than pages: uniforms, programs, label runs, the selection, and textures.
    written: Written,
    /// Rows whose channels the GPU evaluated.
    evaluated: Evaluated,
    /// Edge rows whose endpoints the GPU resolved to resident vertex rows. These are rows
    /// that changed, plus every row of a page that references a vertex now resident elsewhere.
    resolved: Resolved,
    /// Bytes of per-row word pages the GPU cleared before reading their initial state.
    cleared: Cleared,
    /// Rows packed into pages of a paged table's draw order. Each page is packed once, the first
    /// time a view draws it, and again only when a write changes its rows.
    packed: Packed,
    /// Readbacks from the GPU: probes, queries, fits, label texts, segment counts, and pictures.
    /// Frame timer readbacks, which only some devices support, are not counted.
    readbacks: Readbacks,
    /// Jobs started: layouts, routes, lanes, triangulations, pyramids, and tiles. They run on the
    /// host's workers, or immediately without a host.
    jobs: Jobs,
    /// Label texts the host was asked to rasterize.
    texts: Texts,
    /// Pipelines compiled. In a browser, a view or shot queues each ahead of use; driver
    /// compilation can still block the browser thread. Natively, each compiles when first created.
    pipelines: Pipelines,
    /// Pipelines not requested ahead of use, compiled when first used and delaying that frame.
    /// Zero unless a scene uses a pipeline it did not request.
    late: Late,
    /// Bytes of GPU memory freed: buffers and textures replaced, or no longer used, once the GPU is
    /// done with them. In a browser they are freed then, not when JavaScript collects them.
    destroyed: Destroyed,
}

/// The device's queue, which counts what is written through it and holds what latkit retired until
/// the GPU is done with it. Everything else passes through to the queue.
pub(crate) struct Queue {
    raw: wgpu::Queue,
    counters: Arc<Counters>,
    retired: Retired,
    uniforms: Mutex<Uniforms>,
}

/// Immutable pass parameters recur across marks and frames. Two generations retain at most
/// 256 small buffers (64 KiB), without keeping a view or any of its data alive. Hits promote
/// old entries; rotation retires buffers through the same submission boundary as other data.
#[derive(Default)]
struct Uniforms {
    current: HashMap<Vec<u8>, wgpu::Buffer>,
    previous: HashMap<Vec<u8>, wgpu::Buffer>,
}

impl Uniforms {
    const GENERATION: usize = 128;
    const MAX_BYTES: usize = 256;

    fn find(&mut self, bytes: &[u8]) -> Option<wgpu::Buffer> {
        if let Some(buffer) = self.current.get(bytes) {
            return Some(buffer.clone());
        }
        let buffer = self.previous.remove(bytes)?;
        self.current.insert(bytes.to_vec(), buffer.clone());
        Some(buffer)
    }

    fn rotate(&mut self, retired: &Retired) {
        if self.current.len() >= Self::GENERATION {
            for (_, buffer) in self.previous.drain() {
                retired.retire(buffer);
            }
            std::mem::swap(&mut self.current, &mut self.previous);
        }
    }
}

impl Queue {
    pub(crate) fn cleared(&self, bytes: u64) {
        self.counters.add(Count::Cleared, bytes);
    }
    pub(crate) fn pages(&self, pages: u64) {
        self.counters.add(Count::Uploads, pages);
    }
    pub(crate) fn new(raw: wgpu::Queue, counters: Arc<Counters>) -> Queue {
        let retired = Retired::new(counters.clone());
        Queue { raw, counters, retired, uniforms: Mutex::default() }
    }

    /// The buffers and textures latkit retired, destroyed once no command being recorded uses them.
    pub(crate) fn retired(&self) -> &Retired {
        &self.retired
    }

    /// Writes `bytes` into `buffer` at `offset`, counted as written.
    #[expect(clippy::disallowed_methods, reason = "the counted write")]
    pub(crate) fn write_buffer(&self, buffer: &wgpu::Buffer, offset: u64, bytes: &[u8]) {
        self.counters.add(Count::Written, bytes.len() as u64);
        self.raw.write_buffer(buffer, offset, bytes);
    }

    /// A counted upload for copies recorded in command order. Its caller retires it after recording.
    pub(crate) fn stage(&self, device: &wgpu::Device, bytes: &[u8]) -> wgpu::Buffer {
        use wgpu::util::DeviceExt;
        self.counters.add(Count::Written, bytes.len() as u64);
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("latkit ordered upload"),
            contents: bytes,
            usage: wgpu::BufferUsages::COPY_SRC,
        })
    }

    /// Immutable pass parameters. Equal values share a buffer, so recurring raster operations
    /// need no allocation or upload. Different values never overwrite a recorded pass's data.
    pub(crate) fn uniform(&self, device: &wgpu::Device, bytes: &[u8]) -> wgpu::Buffer {
        use wgpu::util::DeviceExt;
        let mut uniforms = self.uniforms.lock().unwrap_or_else(PoisonError::into_inner);
        let retained = bytes.len() <= Uniforms::MAX_BYTES;
        if retained {
            uniforms.rotate(&self.retired);
            if let Some(buffer) = uniforms.find(bytes) {
                return buffer;
            }
        }
        self.counters.add(Count::Written, bytes.len() as u64);
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("latkit raster parameters"),
            contents: bytes,
            usage: wgpu::BufferUsages::UNIFORM,
        });
        if retained {
            uniforms.current.insert(bytes.to_vec(), buffer.clone());
        } else {
            self.retired.retire(buffer.clone());
        }
        buffer
    }

    /// Writes texels, counted as written.
    pub(crate) fn write_texture(
        &self,
        texture: wgpu::TexelCopyTextureInfo<'_>,
        bytes: &[u8],
        layout: wgpu::TexelCopyBufferLayout,
        size: wgpu::Extent3d,
    ) {
        self.texture(texture, bytes, layout, size, Count::Written);
    }

    /// The single counted texture transfer, distinguishing data pages from other writes.
    #[expect(clippy::disallowed_methods, reason = "the counted texture transfer")]
    pub(crate) fn texture(
        &self,
        texture: wgpu::TexelCopyTextureInfo<'_>,
        bytes: &[u8],
        layout: wgpu::TexelCopyBufferLayout,
        size: wgpu::Extent3d,
        count: Count,
    ) {
        self.counters.add(count, bytes.len() as u64);
        self.raw.write_texture(texture, bytes, layout, size);
    }
}

impl Deref for Queue {
    type Target = wgpu::Queue;

    fn deref(&self) -> &wgpu::Queue {
        &self.raw
    }
}
