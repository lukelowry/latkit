use super::{
    command::{Commands, Image},
    device::State,
    resource::Buffer,
    transfer::{Source, upload},
    unsupported::{Unsupported, report_to},
    waits::Waits,
};
use std::{cell::Cell, rc::Rc};
use wgpu::custom::{
    BoxSubmittedWorkDoneCallback, DispatchBlas, DispatchBuffer, DispatchCommandBuffer, DispatchQueueWriteBuffer,
    DispatchSurfaceOutputDetail, QueueInterface, QueueWriteBufferInterface,
};

#[derive(Debug)]
pub(super) struct Queue {
    pub(super) state: Rc<State>,
    pub(super) submitted: Cell<u64>,
}
/// Each call that gives the GPU work notes it in [`Waits::issued`], so the next wait makes a fence
/// of its own rather than joining an older one.
impl QueueInterface for Queue {
    fn write_buffer(&self, buffer: &DispatchBuffer, offset: u64, data: &[u8]) {
        Waits::issued(&self.state);
        buffer.as_custom::<Buffer>().unwrap().write(offset, data);
    }
    fn create_staging_buffer(&self, size: wgpu::BufferSize) -> Option<DispatchQueueWriteBuffer> {
        Some(DispatchQueueWriteBuffer::custom(Staging(vec![0; size.get() as usize])))
    }
    fn validate_write_buffer(&self, buffer: &DispatchBuffer, offset: u64, size: wgpu::BufferSize) -> Option<()> {
        (offset + size.get() <= buffer.as_custom::<Buffer>()?.0.size).then_some(())
    }
    fn write_staging_buffer(&self, buffer: &DispatchBuffer, offset: u64, staging: &DispatchQueueWriteBuffer) {
        self.write_buffer(buffer, offset, &staging.as_custom::<Staging>().unwrap().0);
    }
    fn write_texture(
        &self,
        texture: wgpu::TexelCopyTextureInfo<'_>,
        data: &[u8],
        layout: wgpu::TexelCopyBufferLayout,
        size: wgpu::Extent3d,
    ) {
        Waits::issued(&self.state);
        upload(&self.state.gl, Source::Bytes(data), layout, &Image::new(texture), size);
    }
    fn copy_external_image_to_texture(
        &self,
        _source: &wgpu::CopyExternalImageSourceInfo,
        _dest: wgpu::CopyExternalImageDestInfo<&wgpu::Texture>,
        _size: wgpu::Extent3d,
    ) {
        report_to(&self.state, "copy external images");
    }
    fn submit(&self, command_buffers: &mut dyn Iterator<Item = DispatchCommandBuffer>) -> u64 {
        Waits::issued(&self.state);
        for buffer in command_buffers {
            for command in buffer.as_custom::<Commands>().unwrap().0.borrow_mut().drain(..) {
                command.run(&self.state.gl);
            }
        }
        let serial = self.submitted.get() + 1;
        self.submitted.set(serial);
        serial
    }
    /// WebGL2 writes no timestamps on Direct3D, so the device has no `TIMESTAMP_QUERY`.
    fn get_timestamp_period(&self) -> f32 {
        0.0
    }
    fn on_submitted_work_done(&self, callback: BoxSubmittedWorkDoneCallback) {
        Waits::fence(&self.state, move |_, _| callback());
    }
    fn compact_blas(&self, _: &DispatchBlas) -> (Option<u64>, DispatchBlas) {
        report_to(&self.state, "build acceleration structures");
        (None, DispatchBlas::custom(Unsupported))
    }
    fn present(&self, detail: &DispatchSurfaceOutputDetail) {
        detail.as_custom::<super::host::Output>().unwrap().present();
    }
}
#[derive(Debug)]
struct Staging(Vec<u8>);
impl QueueWriteBufferInterface for Staging {
    fn len(&self) -> usize {
        self.0.len()
    }
    unsafe fn write_slice(&mut self) -> wgpu::WriteOnly<'_, [u8]> {
        wgpu::WriteOnly::from(&mut self.0[..])
    }
}
