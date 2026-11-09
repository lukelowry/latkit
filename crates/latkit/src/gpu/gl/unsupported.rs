//! What WebGL2 cannot do. Each such call reports a validation error to the device, as WebGPU reports
//! a feature a device lacks, and returns an object that does nothing.

use super::device::{Device, State};
use std::rc::{Rc, Weak};
use wgpu::custom::{
    BlasCompactCallback, BlasInterface, ComputePassInterface, ComputePipelineInterface, DispatchBindGroup,
    DispatchBindGroupLayout, DispatchBuffer, DispatchComputePipeline, DispatchQuerySet, DispatchTextureView,
    ExternalTextureInterface, PipelineCacheInterface, QuerySetInterface, TlasInterface,
};

/// Reports that WebGL2 cannot do `what`, to the error scope or handler that catches validation
/// errors. Nothing is reported once the device is gone.
pub(super) fn report(state: &Weak<State>, what: &str) {
    if let Some(state) = state.upgrade() {
        report_to(&state, what);
    }
}

/// [`report`], for a device that is alive.
pub(super) fn report_to(state: &Rc<State>, what: &str) {
    Device(state.clone()).error(super::device::validation(format!("WebGL2 cannot {what}")));
}

/// An object WebGL2 cannot make, which does nothing.
#[derive(Debug)]
pub(super) struct Unsupported;

// A compute pass must implement `Drop`.
impl Drop for Unsupported {
    fn drop(&mut self) {}
}

impl ExternalTextureInterface for Unsupported {
    fn destroy(&self) {}
}

impl BlasInterface for Unsupported {
    fn prepare_compact_async(&self, callback: BlasCompactCallback) {
        callback(Err(wgpu::BlasAsyncError));
    }
    fn ready_for_compaction(&self) -> bool {
        false
    }
}

impl TlasInterface for Unsupported {}

impl QuerySetInterface for Unsupported {
    fn destroy(&self) {}
}

impl ComputePipelineInterface for Unsupported {
    fn get_bind_group_layout(&self, _index: u32) -> DispatchBindGroupLayout {
        DispatchBindGroupLayout::custom(super::resource::Layout(Vec::new()))
    }
}

impl PipelineCacheInterface for Unsupported {
    fn get_data(&self) -> Option<Vec<u8>> {
        None
    }
}

impl ComputePassInterface for Unsupported {
    fn set_pipeline(&mut self, _pipeline: &DispatchComputePipeline) {}
    fn set_bind_group(&mut self, _index: u32, _bind_group: Option<&DispatchBindGroup>, _offsets: &[u32]) {}
    fn set_immediates(&mut self, _offset: u32, _data: &[u8]) {}
    fn insert_debug_marker(&mut self, _label: &str) {}
    fn push_debug_group(&mut self, _group_label: &str) {}
    fn pop_debug_group(&mut self) {}
    fn write_timestamp(&mut self, _query_set: &DispatchQuerySet, _query_index: u32) {}
    fn begin_pipeline_statistics_query(&mut self, _query_set: &DispatchQuerySet, _query_index: u32) {}
    fn end_pipeline_statistics_query(&mut self) {}
    fn dispatch_workgroups(&mut self, _x: u32, _y: u32, _z: u32) {}
    fn dispatch_workgroups_indirect(&mut self, _indirect_buffer: &DispatchBuffer, _indirect_offset: u64) {}
    fn transition_resources<'a>(
        &mut self,
        _buffer_transitions: &mut dyn Iterator<Item = wgpu_types::BufferTransition<&'a DispatchBuffer>>,
        _texture_transitions: &mut dyn Iterator<Item = wgpu_types::TextureTransition<&'a DispatchTextureView>>,
    ) {
    }
}
