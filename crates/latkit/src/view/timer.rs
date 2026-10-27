//! GPU time per frame, on devices that support timestamp queries. An empty pass writes a timestamp
//! at the start of a frame and another at its end. Each measurement is resolved and read back
//! without stalling, a few at a time. The reported time is the median of the last frames measured,
//! so it stays steady when an occasional frame does more work.

use crate::gpu::readback::{Readback, Readbacks};

/// The most measurements in flight.
const SLOTS: usize = 4;
/// Frames the reported median covers.
const KEPT: usize = 15;

/// A query set measuring one frame, and its readback while in flight.
struct Slot {
    set: wgpu::QuerySet,
    resolved: wgpu::Buffer,
    pending: Option<Readback>,
}

pub(crate) struct Timer {
    slots: Vec<Slot>,
    /// The slot measuring this frame.
    current: Option<usize>,
    /// Nanoseconds a timestamp tick lasts.
    period: f64,
    /// Milliseconds of the last frames measured, oldest first.
    measured: Vec<f32>,
    /// Its own readback buffers, left out of the work counts, since only some devices have a timer.
    pool: Readbacks,
}

impl Timer {
    /// A timer, or `None` where the device lacks timestamp queries.
    pub(crate) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Timer> {
        if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
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
        Some(Timer {
            slots: (0..SLOTS).map(slot).collect(),
            current: None,
            period: f64::from(queue.get_timestamp_period()),
            measured: Vec::with_capacity(KEPT),
            pool: Readbacks::uncounted(),
        })
    }

    /// Starts measuring the frame `encoder` records, if a slot is free.
    pub(crate) fn begin(&mut self, encoder: &mut wgpu::CommandEncoder) {
        self.current = self.slots.iter().position(|s| s.pending.is_none());
        if let Some(i) = self.current {
            mark(&self.slots[i].set, encoder, Some(0), None);
        }
    }

    /// Ends this frame's measurement and records its readback, which completes after submission.
    pub(crate) fn end(&mut self, encoder: &mut wgpu::CommandEncoder, device: &wgpu::Device) {
        let Some(i) = self.current.take() else { return };
        let slot = &mut self.slots[i];
        mark(&slot.set, encoder, None, Some(1));
        encoder.resolve_query_set(&slot.set, 0..2, &slot.resolved, 0);
        let waker = std::task::Waker::noop();
        slot.pending = Some(Readback::new(&self.pool, device, encoder, &slot.resolved, 0, 16, waker));
    }

    /// The median milliseconds of the last frames measured, if a measurement arrived since the last
    /// call.
    pub(crate) fn landed(&mut self) -> Option<f32> {
        let mut landed = false;
        for slot in &mut self.slots {
            let Some(bytes) = slot.pending.as_ref().and_then(Readback::take) else { continue };
            slot.pending = None;
            let Some(ms) = bytes.ok().and_then(|bytes| elapsed_ms(&bytes, self.period)) else { continue };
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

/// Milliseconds between the two timestamps of `bytes`, ticks `period` nanoseconds long.
fn elapsed_ms(bytes: &[u8], period: f64) -> Option<f32> {
    let mut ticks = crate::wire::In::new(bytes);
    let (start, end) = (ticks.u64()?, ticks.u64()?);
    Some((end.checked_sub(start)? as f64 * period / 1e6) as f32)
}

/// Records an empty pass that writes timestamp `beginning` at its start, or `end` at its end.
fn mark(set: &wgpu::QuerySet, encoder: &mut wgpu::CommandEncoder, beginning: Option<u32>, end: Option<u32>) {
    encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
        label: Some("latkit timer"),
        timestamp_writes: Some(wgpu::ComputePassTimestampWrites {
            query_set: set,
            beginning_of_pass_write_index: beginning,
            end_of_pass_write_index: end,
        }),
    });
}
