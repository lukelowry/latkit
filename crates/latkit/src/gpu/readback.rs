//! Bytes read back from the GPU: copied in a frame's encoder and mapped when the caller submits it,
//! so reading never stalls a frame and never submits on its own. Map buffers come from a pool and
//! go back to it once read, so hovering allocates nothing.

use std::sync::{Arc, Mutex, PoisonError};

use crate::{Error, Result};

/// Map buffers no readback holds, by size.
#[derive(Clone, Default)]
pub(crate) struct Readbacks(Arc<Mutex<Vec<wgpu::Buffer>>>);

impl Readbacks {
    fn take(&self, device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        let class = size.max(256).next_power_of_two();
        let mut free = self.0.lock().unwrap_or_else(PoisonError::into_inner);
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
    /// Copies `size` bytes of `source` from `offset`, to read once `encoder` is submitted.
    pub(crate) fn new(
        pool: &Readbacks,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Buffer,
        offset: u64,
        size: u64,
    ) -> Readback {
        let buffer = pool.take(device, size);
        encoder.copy_buffer_to_buffer(source, offset, &buffer, 0, size);
        let mapping = Arc::new(Mutex::new(Mapping::Waiting));
        let done = mapping.clone();
        encoder.map_buffer_on_submit(&buffer, wgpu::MapMode::Read, ..size, move |result| {
            *done.lock().unwrap_or_else(PoisonError::into_inner) =
                if result.is_ok() { Mapping::Ready } else { Mapping::Failed };
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
            self.pool.0.lock().unwrap_or_else(PoisonError::into_inner).push(buffer);
        }
    }
}
