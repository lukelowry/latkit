//! Bytes read back from the GPU: copied in a frame's encoder and mapped when the caller submits it,
//! so reading never stalls a frame and never submits on its own.

use std::sync::{Arc, Mutex, PoisonError};

use crate::{Error, Result};

pub(crate) struct Readback {
    buffer: wgpu::Buffer,
    /// `None` while mapping; then whether it succeeded.
    mapped: Arc<Mutex<Option<bool>>>,
}

impl Readback {
    /// Copies `size` bytes of `source` from `offset`, to read once `encoder` is submitted.
    pub(crate) fn new(
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::Buffer,
        offset: u64,
        size: u64,
    ) -> Readback {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("latkit readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        encoder.copy_buffer_to_buffer(source, offset, &buffer, 0, size);
        let mapped = Arc::new(Mutex::new(None));
        let done = mapped.clone();
        encoder.map_buffer_on_submit(&buffer, wgpu::MapMode::Read, .., move |result| {
            *done.lock().unwrap_or_else(PoisonError::into_inner) = Some(result.is_ok());
        });
        Readback { buffer, mapped }
    }

    /// The bytes once mapped, or `None` while the GPU has not finished.
    pub(crate) fn take(&self) -> Option<Result<Vec<u8>>> {
        let mapped = (*self.mapped.lock().unwrap_or_else(PoisonError::into_inner))?;
        if !mapped {
            return Some(Err(Error::DeviceLost));
        }
        let bytes = match self.buffer.get_mapped_range(..) {
            Ok(view) => view.to_vec(),
            Err(_) => return Some(Err(Error::DeviceLost)),
        };
        self.buffer.unmap();
        Some(Ok(bytes))
    }
}
