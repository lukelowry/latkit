//! Buffers that grow. A buffer that runs out of space is replaced by one 1.5 times the size needed,
//! so a buffer that keeps growing is replaced only a few times.

/// A buffer that is replaced by one 1.5 times the size needed when it runs out of space.
pub(crate) struct Grown {
    pub(crate) buffer: wgpu::Buffer,
    label: &'static str,
    usage: wgpu::BufferUsages,
}

impl Grown {
    pub(crate) fn new(device: &wgpu::Device, label: &'static str, usage: wgpu::BufferUsages) -> Grown {
        Grown { buffer: buffer(device, label, usage, 256), label, usage }
    }

    /// Makes room for `bytes`. Returns true when it replaced the buffer, losing its contents.
    pub(crate) fn ensure(&mut self, device: &wgpu::Device, bytes: u64) -> bool {
        if bytes <= self.buffer.size() {
            return false;
        }
        self.buffer = buffer(device, self.label, self.usage, (bytes + bytes / 2).next_multiple_of(256));
        true
    }
}

/// Creates a buffer for `usage` that writes can copy into. Its size is `bytes`, rounded up to at
/// least 256 and to whole words.
pub(crate) fn buffer(device: &wgpu::Device, label: &str, usage: wgpu::BufferUsages, bytes: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: bytes.max(256).next_multiple_of(4),
        usage: usage | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}
