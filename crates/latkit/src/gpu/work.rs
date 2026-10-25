//! What a `Gpu` did, counted exactly. Unlike time, it repeats from run to run and machine to machine
//! wherever the budget, the device's limits, and the frames drawn do, so the benchmark gates it and
//! tests assert it. Every write to the GPU goes through [`Queue`], which counts it; clippy refuses the
//! raw queue's writes anywhere else. Whatever else counts holds the counters itself: the pipelines,
//! the readback pool, the atlas, and each frame's jobs and evaluations through the `Gpu`.

use std::ops::{Deref, Sub};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// [`Work`], the [`Count`] naming each of its fields, and the [`Counters`] keeping them, from one list.
macro_rules! work {
    ($($(#[$doc:meta])* $field:ident: $count:ident,)*) => {
        /// What a [`Gpu`](crate::Gpu) did since it was made; subtract two for what happened between.
        #[derive(Clone, Copy, Default, PartialEq, Eq, Debug, serde::Serialize, schemars::JsonSchema)]
        pub struct Work {
            $($(#[$doc])* pub $field: u64,)*
        }

        /// A kind of work a `Gpu` counts.
        #[derive(Clone, Copy)]
        pub(crate) enum Count {
            $($count,)*
        }

        /// The counts, shared by every view of a `Gpu`, from any thread.
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
    /// Data pages, or pieces of them, uploaded: what a change uploads counts its pages here, and its
    /// bytes in `uploaded`.
    uploads: Uploads,
    /// Bytes written besides pages: uniforms, programs, label runs, the selection, textures.
    written: Written,
    /// Rows whose channels the GPU evaluated.
    evaluated: Evaluated,
    /// Rows of edges and faces whose ends the GPU found where their vertices are held: rows that
    /// changed, and every row of a page of them naming a vertex now held elsewhere.
    resolved: Resolved,
    /// Bytes of pages of words per row the GPU cleared: those read before anything writes them, and
    /// the normals faces sum afresh.
    cleared: Cleared,
    /// Rows packed into pages of the order a table drawn in part draws in: each page once, the first
    /// time a view draws it, and again only where a write changed its rows.
    packed: Packed,
    /// Reads back from the GPU: probes, queries, fits, label placements, segment counts, pictures;
    /// not the frame timer's, which only some devices have.
    readbacks: Readbacks,
    /// Jobs handed out: layouts, routes, lanes, triangulations, pyramids, tiles; to the host's
    /// workers, or done at once without a host.
    jobs: Jobs,
    /// Label texts the host was asked to set.
    texts: Texts,
    /// Pipelines compiled: in a browser, each as a view or a shot asks for it ahead, off the GPU's
    /// thread; natively, where it is first made.
    pipelines: Pipelines,
    /// Pipelines made without being asked for ahead, each compiled where it is first used: in a
    /// browser on the GPU's thread, holding frames back. None, unless a scene uses what it did not
    /// ask for.
    late: Late,
}

/// The device's queue, counting what is written through it; everything else it does as the queue.
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

    /// Writes in command order, so a reused scratch buffer keeps earlier passes' inputs intact, and
    /// what a copy recorded before puts in place is written over after it.
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

    /// Writes the words of `pages` data pages, or pieces of them, side by side into `buffer` at
    /// `offset`, counted as uploaded.
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
