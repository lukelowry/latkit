//! GPU time per frame, where the device can measure it. Natively, an empty pass writes a timestamp
//! at the start of a frame and another at its end, each pair resolved and read back. In a browser,
//! a `TIME_ELAPSED_EXT` query times the frame's commands, since WebGL2 writes no timestamps on
//! Direct3D. Either way a few measurements are in flight at once, none stalls the frame, and the
//! reported time is the median of the last frames measured, so it stays steady when an occasional
//! frame does more work.

/// The most measurements in flight.
const SLOTS: usize = 4;
/// Frames the reported median covers.
const KEPT: usize = 15;

pub(crate) struct Timer {
    slots: Vec<Slot>,
    /// The slot measuring this frame.
    current: Option<usize>,
    /// Milliseconds of the last frames measured, oldest first.
    measured: Vec<f32>,
    #[cfg(not(target_arch = "wasm32"))]
    clock: Clock,
}

impl Timer {
    /// A timer, or `None` where the device cannot time its work.
    pub(crate) fn new(device: &wgpu::Device, queue: &crate::gpu::work::Queue) -> Option<Timer> {
        #[cfg(target_arch = "wasm32")]
        let slots = {
            let _ = queue;
            (0..SLOTS).map(|_| crate::gpu::gl::Elapsed::new(device)).collect::<Option<Vec<_>>>()?
        };
        #[cfg(not(target_arch = "wasm32"))]
        let (slots, clock) = Clock::new(device, queue)?;
        Some(Timer {
            slots,
            current: None,
            measured: Vec::with_capacity(KEPT),
            #[cfg(not(target_arch = "wasm32"))]
            clock,
        })
    }

    /// Starts measuring the frame `encoder` records, if a slot is free.
    pub(crate) fn begin(&mut self, encoder: &mut wgpu::CommandEncoder) {
        self.current = self.slots.iter().position(Slot::free);
        if let Some(i) = self.current {
            self.slots[i].begin(encoder);
        }
    }

    /// Ends this frame's measurement, which completes after submission.
    pub(crate) fn end(&mut self, encoder: &mut wgpu::CommandEncoder, device: &wgpu::Device) {
        let Some(i) = self.current.take() else { return };
        #[cfg(target_arch = "wasm32")]
        {
            let _ = device;
            self.slots[i].end(encoder);
        }
        #[cfg(not(target_arch = "wasm32"))]
        self.slots[i].end(encoder, device, &self.clock.pool);
    }

    /// The median milliseconds of the last frames measured, if a measurement arrived since the last
    /// call.
    pub(crate) fn landed(&mut self, device: &wgpu::Device) -> Option<f32> {
        #[cfg(target_arch = "wasm32")]
        let disjoint = self.slots.iter().any(|slot| !slot.free()) && crate::gpu::gl::disjoint(device);
        #[cfg(not(target_arch = "wasm32"))]
        let _ = device;
        let mut landed = false;
        for slot in &mut self.slots {
            #[cfg(target_arch = "wasm32")]
            let taken = slot.take(disjoint);
            #[cfg(not(target_arch = "wasm32"))]
            let taken = slot.take(self.clock.period);
            let Some(ms) = taken else { continue };
            if self.measured.len() == KEPT {
                self.measured.remove(0);
            }
            self.measured.push(ms);
            landed = true;
        }
        landed.then(|| {
            let mut sorted = self.measured.clone();
            crate::order::by_key(&mut sorted, |&x| crate::order::number(f64::from(x)));
            sorted[sorted.len() / 2]
        })
    }
}

#[cfg(target_arch = "wasm32")]
use crate::gpu::gl::Elapsed as Slot;

#[cfg(not(target_arch = "wasm32"))]
use native::{Clock, Slot};

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use crate::gpu::readback::{Readback, Readbacks};

    /// What every slot of a native timer shares: the length of a timestamp tick, and the readback
    /// buffers.
    pub(crate) struct Clock {
        /// Nanoseconds a timestamp tick lasts.
        pub(crate) period: f64,
        /// Its own readback buffers, left out of the work counts, since only some devices have a
        /// timer.
        pub(crate) pool: Readbacks,
    }

    impl Clock {
        /// The slots of a timer, and their clock, or `None` where the device lacks timestamp
        /// queries.
        pub(crate) fn new(device: &wgpu::Device, queue: &crate::gpu::work::Queue) -> Option<(Vec<Slot>, Clock)> {
            if !device
                .features()
                .contains(wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS)
            {
                return None;
            }
            let slot = |_| Slot {
                set: device.create_query_set(&wgpu::QuerySetDescriptor {
                    label: Some("latkit timer"),
                    ty: wgpu::QueryType::Timestamp,
                    count: 2,
                }),
                resolved: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("latkit timer"),
                    size: 16,
                    usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                }),
                pending: None,
            };
            let clock =
                Clock { period: f64::from(queue.get_timestamp_period()), pool: Readbacks::uncounted(queue.retired()) };
            Some(((0..super::SLOTS).map(slot).collect(), clock))
        }
    }

    /// A query set measuring one frame, and its readback while in flight.
    pub(crate) struct Slot {
        set: wgpu::QuerySet,
        resolved: wgpu::Buffer,
        pending: Option<Readback>,
    }

    impl Slot {
        pub(crate) fn free(&self) -> bool {
            self.pending.is_none()
        }

        pub(crate) fn begin(&mut self, encoder: &mut wgpu::CommandEncoder) {
            encoder.write_timestamp(&self.set, 0);
        }

        pub(crate) fn end(&mut self, encoder: &mut wgpu::CommandEncoder, device: &wgpu::Device, pool: &Readbacks) {
            encoder.write_timestamp(&self.set, 1);
            encoder.resolve_query_set(&self.set, 0..2, &self.resolved, 0);
            let waker = std::task::Waker::noop();
            self.pending = Some(Readback::new(pool, device, encoder, &self.resolved, 0, 16, waker));
        }

        /// The milliseconds between its timestamps, ticks `period` nanoseconds long, once read
        /// back. It is freed then, and also once the readback fails.
        pub(crate) fn take(&mut self, period: f64) -> Option<f32> {
            let bytes = self.pending.as_ref().and_then(Readback::take)?;
            self.pending = None;
            elapsed_ms(&bytes.ok()?, period)
        }
    }

    /// Milliseconds between the two timestamps of `bytes`, ticks `period` nanoseconds long.
    fn elapsed_ms(bytes: &[u8], period: f64) -> Option<f32> {
        let mut ticks = crate::wire::In::new(bytes);
        let (start, end) = (ticks.u64()?, ticks.u64()?);
        Some((end.checked_sub(start)? as f64 * period / 1e6) as f32)
    }
}
