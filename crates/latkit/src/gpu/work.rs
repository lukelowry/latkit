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
        #[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
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
    /// Bytes written besides pages: uniforms, programs, label runs, the selection, textures.
    written: Written,
    /// Rows whose channels the GPU evaluated.
    evaluated: Evaluated,
    /// Reads back from the GPU: probes, queries, fits, label placements, segment counts, pictures;
    /// not the frame timer's, which only some devices have.
    readbacks: Readbacks,
    /// Jobs handed out: layouts, routes, lanes, triangulations, pyramids, tiles; to the host's
    /// workers, or done at once without a host.
    jobs: Jobs,
    /// Label texts the host was asked to set.
    texts: Texts,
    /// Pipelines made.
    pipelines: Pipelines,
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

    /// Writes a data page's words into `buffer` at `offset`, counted as uploaded.
    #[expect(clippy::disallowed_methods, reason = "the counted upload")]
    pub(crate) fn upload(&self, buffer: &wgpu::Buffer, offset: u64, bytes: &[u8]) {
        self.counters.add(Count::Uploaded, bytes.len() as u64);
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
