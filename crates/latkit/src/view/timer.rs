//! The GPU's time on frames, where the device writes timestamps: an empty pass begins a frame and
//! another ends it, and what lies between is the frame's. Each measure is resolved and read back
//! without stalling, a few at a time, and the time told is the median of the last frames measured, so
//! it holds steady while a frame now and then does more.

use crate::gpu::readback::{Readback, Readbacks};

/// Measures under way at most, and frames the time told is the median of.
const SLOTS: usize = 4;
const KEPT: usize = 15;

/// A query set measuring one frame, and its readback while under way.
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
}

impl Timer {
    /// A timer, where the device writes timestamps.
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
        })
    }

    /// Begins measuring the frame `encoder` records, while a slot is free.
    pub(crate) fn begin(&mut self, encoder: &mut wgpu::CommandEncoder) {
        self.current = self.slots.iter().position(|s| s.pending.is_none());
        if let Some(i) = self.current {
            mark(&self.slots[i].set, encoder, Some(0), None);
        }
    }

    /// Ends the measure this frame began, reading it back once submitted.
    pub(crate) fn end(&mut self, encoder: &mut wgpu::CommandEncoder, pool: &Readbacks, device: &wgpu::Device) {
        let Some(i) = self.current.take() else { return };
        let slot = &mut self.slots[i];
        mark(&slot.set, encoder, None, Some(1));
        encoder.resolve_query_set(&slot.set, 0..2, &slot.resolved, 0);
        slot.pending = Some(Readback::new(pool, device, encoder, &slot.resolved, 0, 16, std::task::Waker::noop()));
    }

    /// The median milliseconds of the last frames measured, once a measure landed since last asked.
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
            sorted.sort_by(f32::total_cmp);
            sorted[sorted.len() / 2]
        })
    }
}

/// Milliseconds between the two timestamps of `bytes`, ticks `period` nanoseconds long.
fn elapsed_ms(bytes: &[u8], period: f64) -> Option<f32> {
    let tick = |i: usize| Some(u64::from_le_bytes(bytes.get(i * 8..i * 8 + 8)?.try_into().ok()?));
    let ticks = tick(1)?.checked_sub(tick(0)?)?;
    Some((ticks as f64 * period / 1e6) as f32)
}

/// An empty pass writing timestamp `beginning` as it begins or `end` as it ends.
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
