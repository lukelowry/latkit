//! Bytes read back from the GPU: copied in a frame's encoder and mapped when the caller submits it,
//! so reading never stalls a frame and never submits on its own; once mapped, it wakes what waits on
//! it. Map buffers come from a pool and go back to it once read, so hovering allocates nothing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::Waker;

use super::work::{Count, Counters};
use crate::{Error, Result};

/// Map buffers no readback holds, by size, what counts the readbacks made from them, and how many
/// are still mapping. Every pool says whether it counts, so none stops counting by default.
#[derive(Clone)]
pub(crate) struct Readbacks {
    free: Arc<Mutex<Vec<wgpu::Buffer>>>,
    counters: Option<Arc<Counters>>,
    mapping: Arc<AtomicU64>,
}

impl Readbacks {
    /// A pool whose readbacks `counters` counts: the `Gpu`'s.
    pub(crate) fn counted(counters: Arc<Counters>) -> Readbacks {
        Readbacks { free: Arc::default(), counters: Some(counters), mapping: Arc::default() }
    }

    /// A pool whose readbacks count as no work: the frame timer's, which only some devices have.
    pub(crate) fn uncounted() -> Readbacks {
        Readbacks { free: Arc::default(), counters: None, mapping: Arc::default() }
    }

    /// Readbacks of this pool the GPU has yet to map.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn mapping(&self) -> u64 {
        self.mapping.load(Ordering::Acquire)
    }

    fn take(&self, device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        if let Some(counters) = &self.counters {
            counters.add(Count::Readbacks, 1);
        }
        let class = size.max(256).next_power_of_two();
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

/// Where a readback's map stands.
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
    pool: Readbacks,
    mapping: Arc<Mutex<Mapping>>,
}

impl Readback {
    /// Copies `size` bytes of `source` from `offset`, to read once `encoder` is submitted; `waker`
    /// wakes once they can be read.
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
        Readback { buffer: Some(buffer), size, pool: pool.clone(), mapping }
    }

    /// The bytes once mapped, or `None` while the GPU has not finished or they were taken.
    pub(crate) fn take(&self) -> Option<Result<Vec<u8>>> {
        let mut mapping = self.mapping.lock().unwrap_or_else(PoisonError::into_inner);
        let buffer = self.buffer.as_ref()?;
        match *mapping {
            Mapping::Waiting | Mapping::Read => None,
            Mapping::Failed => Some(Err(Error::DeviceLost)),
            Mapping::Ready => {
                let bytes = match buffer.get_mapped_range(..self.size) {
                    Ok(view) => view.to_vec(),
                    Err(_) => return Some(Err(Error::DeviceLost)),
                };
                buffer.unmap();
                *mapping = Mapping::Read;
                Some(Ok(bytes))
            }
        }
    }
}

impl Drop for Readback {
    fn drop(&mut self) {
        let Some(buffer) = self.buffer.take() else { return };
        // A buffer still mapping cannot go back yet; it is dropped instead.
        let mapping = *self.mapping.lock().unwrap_or_else(PoisonError::into_inner);
        if mapping == Mapping::Ready {
            buffer.unmap();
        }
        if matches!(mapping, Mapping::Ready | Mapping::Read) {
            self.pool.free.lock().unwrap_or_else(PoisonError::into_inner).push(buffer);
        }
    }
}
