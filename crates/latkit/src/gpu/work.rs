//! Exact counts of the work a `Gpu` does. Unlike timings, the counts repeat across runs and
//! machines for the same budget, device limits, and frames drawn, so the benchmark gates on them
//! and tests assert them.
//!
//! Every write to the GPU goes through [`Queue`], which counts it; clippy forbids the raw queue's
//! writes anywhere else. Other counted parts hold the counters themselves: the pipelines, the
//! readback pool, the atlas, and each frame's jobs and evaluations through the `Gpu`.

use std::ops::{Deref, Sub};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

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
    /// Edge and face rows whose endpoints the GPU resolved to their vertices' resident rows: rows
    /// that changed, plus every row of a page that references a vertex now resident elsewhere.
    resolved: Resolved,
    /// Bytes of per-row word pages the GPU cleared: pages read before anything writes them, and the
    /// normals that faces sum from scratch.
    cleared: Cleared,
    /// Rows packed into pages of a paged table's draw order. Each page is packed once, the first
    /// time a view draws it, and again only when a write changes its rows.
    packed: Packed,
    /// Readbacks from the GPU: probes, queries, fits, label placements, segment counts, and
    /// pictures. Frame timer readbacks, which only some devices support, are not counted.
    readbacks: Readbacks,
    /// Jobs started: layouts, routes, lanes, triangulations, pyramids, and tiles. They run on the
    /// host's workers, or immediately without a host.
    jobs: Jobs,
    /// Label texts the host was asked to rasterize.
    texts: Texts,
    /// Pipelines compiled. In a browser, each compiles in the background when a view or shot
    /// requests it ahead of use. Natively, each compiles when first created.
    pipelines: Pipelines,
    /// Pipelines not requested ahead of use, compiled when first used. In a browser they compile
    /// on the GPU's thread and delay frames. Zero unless a scene uses a pipeline it did not
    /// request.
    late: Late,
}

/// The device's queue, which counts what is written through it. Everything else passes through to
/// the queue.
pub(crate) struct Queue {
    raw: wgpu::Queue,
    counters: Arc<Counters>,
}

impl Queue {
    pub(crate) fn new(raw: wgpu::Queue, counters: Arc<Counters>) -> Queue {
        Queue { raw, counters }
    }

    /// Writes `bytes` into `buffer` at `offset`, counted as written.
    #[expect(clippy::disallowed_methods, reason = "the counted write")]
    pub(crate) fn write_buffer(&self, buffer: &wgpu::Buffer, offset: u64, bytes: &[u8]) {
        self.counters.add(Count::Written, bytes.len() as u64);
        self.raw.write_buffer(buffer, offset, bytes);
    }

    /// Writes `bytes` into `buffer` at `offset` in command order, through a copy recorded in
    /// `encoder`, counted as written. So a reused scratch buffer keeps earlier passes' inputs
    /// intact, and the write takes effect after any copy recorded before it.
    pub(crate) fn write_buffer_in(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        buffer: &wgpu::Buffer,
        offset: u64,
        bytes: &[u8],
    ) {
        use wgpu::util::DeviceExt;
        self.counters.add(Count::Written, bytes.len() as u64);
        let upload = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("latkit ordered upload"),
            contents: bytes,
            usage: wgpu::BufferUsages::COPY_SRC,
        });
        encoder.copy_buffer_to_buffer(&upload, 0, buffer, offset, bytes.len() as u64);
    }

    /// Clears `size` bytes of `buffer` from `offset` in `encoder`, counted as cleared.
    pub(crate) fn clear_buffer(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        buffer: &wgpu::Buffer,
        offset: u64,
        size: u64,
    ) {
        self.counters.add(Count::Cleared, size);
        encoder.clear_buffer(buffer, offset, Some(size));
    }

    /// Writes `bytes`, the words of `pages` adjacent data pages or pieces of pages, into `buffer`
    /// at `offset`, counted as uploaded.
    #[expect(clippy::disallowed_methods, reason = "the counted upload")]
    pub(crate) fn upload(&self, buffer: &wgpu::Buffer, offset: u64, bytes: &[u8], pages: u64) {
        self.counters.add(Count::Uploaded, bytes.len() as u64);
        self.counters.add(Count::Uploads, pages);
        self.raw.write_buffer(buffer, offset, bytes);
    }

    /// Writes texels, counted as written.
    #[expect(clippy::disallowed_methods, reason = "the counted write")]
    pub(crate) fn write_texture(
        &self,
        texture: wgpu::TexelCopyTextureInfo<'_>,
        bytes: &[u8],
        layout: wgpu::TexelCopyBufferLayout,
        size: wgpu::Extent3d,
    ) {
        self.counters.add(Count::Written, bytes.len() as u64);
        self.raw.write_texture(texture, bytes, layout, size);
    }
}

impl Deref for Queue {
    type Target = wgpu::Queue;

    fn deref(&self) -> &wgpu::Queue {
        &self.raw
    }
}
