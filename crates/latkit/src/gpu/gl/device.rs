use super::pipeline::{self, Pipeline, Program, Programs, Shader};
use super::unsupported::{Unsupported, report_to};
use super::waits::Waits;
use std::{
    cell::{Cell, RefCell},
    pin::Pin,
    rc::Rc,
    sync::Arc,
};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use web_sys::WebGl2RenderingContext as Gl;
use wgpu::custom::{
    BoxDeviceLostCallback, DeviceInterface, DispatchBindGroup, DispatchBindGroupLayout, DispatchBlas, DispatchBuffer,
    DispatchCommandEncoder, DispatchComputePipeline, DispatchExternalTexture, DispatchPipelineCache,
    DispatchPipelineLayout, DispatchQuerySet, DispatchRenderBundleEncoder, DispatchRenderPipeline, DispatchSampler,
    DispatchShaderModule, DispatchTexture, DispatchTlas, PopErrorScopeFuture,
};

#[derive(Debug)]
pub(super) struct Scope {
    filter: wgpu::ErrorFilter,
    programs: Vec<(Rc<Program>, bool)>,
    errors: Vec<wgpu::Error>,
}

type LossListener = (web_sys::EventTarget, Closure<dyn FnMut(web_sys::Event)>);

pub(super) struct State {
    pub(super) gl: Gl,
    pub(super) parallel: bool,
    pub(super) waits: Waits,
    limits: wgpu::Limits,
    pub(super) programs: RefCell<Programs>,
    stages: RefCell<pipeline::Stages>,
    scopes: RefCell<Vec<Option<Scope>>>,
    lost: RefCell<Option<BoxDeviceLostCallback>>,
    handler: RefCell<Option<Arc<dyn wgpu::UncapturedErrorHandler>>>,
    pending_errors: Cell<bool>,
    checking_errors: Cell<bool>,
    listener: RefCell<Option<LossListener>>,
    lost_reason: Cell<Option<wgpu::DeviceLostReason>>,
}
impl std::fmt::Debug for State {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebGL2").field("parallel", &self.parallel).finish_non_exhaustive()
    }
}
impl Drop for State {
    fn drop(&mut self) {
        if let Some((target, listener)) = self.listener.get_mut().take() {
            let _ = target.remove_event_listener_with_callback("webglcontextlost", listener.as_ref().unchecked_ref());
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct Device(pub(super) Rc<State>);

/// `FIRST_VERTEX_CONVENTION_WEBGL` of `WEBGL_provoking_vertex`.
const FIRST_VERTEX: u32 = 0x8E4D;

impl Device {
    pub(super) fn new(gl: Gl) -> Result<Self, JsValue> {
        let parallel = gl.get_extension("KHR_parallel_shader_compile")?.is_some();
        // WGSL takes a flat varying from the first vertex of each primitive, and GL from the last.
        // ANGLE on D3D11 gets the last by running every draw with flat varyings through a geometry
        // shader. Taking the first vertex matches WGSL and skips that shader.
        if let Some(provoking) = gl.get_extension("WEBGL_provoking_vertex")? {
            let set: js_sys::Function = js_sys::Reflect::get(&provoking, &"provokingVertexWEBGL".into())?.dyn_into()?;
            set.call1(&provoking, &FIRST_VERTEX.into())?;
        }
        let get = |parameter| gl.get_parameter(parameter).ok().and_then(|v| v.as_f64()).map(|n| n as u32);
        let limits = wgpu::Limits {
            max_texture_dimension_2d: get(Gl::MAX_TEXTURE_SIZE).unwrap_or(2048),
            max_texture_array_layers: get(Gl::MAX_ARRAY_TEXTURE_LAYERS).unwrap_or(256),
            max_color_attachment_bytes_per_sample: 64,
            ..wgpu::Limits::downlevel_webgl2_defaults()
        };
        let state = Rc::new(State {
            gl,
            parallel,
            waits: Waits::default(),
            limits,
            programs: RefCell::default(),
            stages: RefCell::default(),
            scopes: RefCell::default(),
            lost: RefCell::default(),
            handler: RefCell::default(),
            pending_errors: Cell::new(false),
            checking_errors: Cell::new(false),
            listener: RefCell::default(),
            lost_reason: Cell::new(None),
        });
        let weak = Rc::downgrade(&state);
        let listener = Closure::new(move |event: web_sys::Event| {
            event.prevent_default();
            if let Some(state) = weak.upgrade() {
                Self(state).lost(wgpu::DeviceLostReason::Unknown);
            }
        });
        let target: web_sys::EventTarget =
            state.gl.canvas().ok_or_else(|| JsValue::from_str("WebGL2 has no canvas"))?.dyn_into()?;
        target.add_event_listener_with_callback("webglcontextlost", listener.as_ref().unchecked_ref())?;
        *state.listener.borrow_mut() = Some((target, listener));
        Ok(Self(state))
    }

    /// Reports the loss once: to the lost callback, which wakes the views.
    pub(super) fn lost(&self, reason: wgpu::DeviceLostReason) {
        if self.0.lost_reason.get().is_some() {
            return;
        }
        self.0.lost_reason.set(Some(reason));
        self.0.programs.borrow_mut().clear();
        self.0.stages.borrow_mut().clear();
        let callback = self.0.lost.borrow_mut().take();
        if let Some(callback) = callback {
            callback(reason, "WebGL2 device lost".into());
        }
    }

    /// Loses the context with `WEBGL_lose_context`, as a GPU reset does.
    pub(super) fn lose_context(&self) {
        if let Ok(Some(extension)) = self.0.gl.get_extension("WEBGL_lose_context")
            && let Ok(method) = js_sys::Reflect::get(&extension, &"loseContext".into())
            && let Some(method) = method.dyn_ref::<js_sys::Function>()
        {
            let _ = method.call0(&extension);
        }
    }

    /// Reports `error` to the innermost scope catching its kind, or else to the error handler.
    pub(super) fn error(&self, error: wgpu::Error) {
        let filter = match &error {
            wgpu::Error::Validation { .. } => wgpu::ErrorFilter::Validation,
            wgpu::Error::OutOfMemory { .. } => wgpu::ErrorFilter::OutOfMemory,
            wgpu::Error::Internal { .. } => wgpu::ErrorFilter::Internal,
        };
        let mut scopes = self.0.scopes.borrow_mut();
        if let Some(scope) = scopes.iter_mut().rev().flatten().find(|scope| scope.filter == filter) {
            scope.errors.push(error);
            return;
        }
        drop(scopes);
        let handler = self.0.handler.borrow().clone();
        if let Some(handler) = handler {
            handler(error);
        } else {
            panic!("uncaptured WebGL2 error: {error}");
        }
    }

    fn check_errors(&self) {
        if !self.0.pending_errors.replace(false) {
            return;
        }
        loop {
            match self.0.gl.get_error() {
                Gl::NO_ERROR | Gl::CONTEXT_LOST_WEBGL => break,
                Gl::OUT_OF_MEMORY => self.error(wgpu::Error::OutOfMemory {
                    source: Box::new(std::io::Error::other("WebGL2 allocation failed")),
                }),
                code => self.error(validation(format!("WebGL2 operation failed ({code:#x})"))),
            }
        }
    }

    // Error queries synchronously cross the browser's GPU process. Coalesce unscoped work
    // and wait for its fence before querying; scope boundaries still capture errors exactly.
    // The fence follows the next task's submission, so the query never waits behind the frame
    // that made these resources: its draws run only when it submits.
    pub(super) fn changed(&self) {
        self.0.pending_errors.set(true);
        if self.0.checking_errors.replace(true) {
            return;
        }
        let weak = Rc::downgrade(&self.0);
        wasm_bindgen_futures::spawn_local(async move {
            super::turn().await;
            let Some(state) = weak.upgrade() else { return };
            Waits::fence(&state, |state, _| {
                Self(state.clone()).check_errors();
                state.checking_errors.set(false);
            });
        });
    }

    fn pipeline(&self, desc: &wgpu::RenderPipelineDescriptor<'_>) -> Result<Rc<Program>, String> {
        let passed = |module: &wgpu::ShaderModule| matches!(module.as_custom::<Shader>(), Some(Shader::Glsl { .. }));
        if desc.layout.is_none()
            && (passed(desc.vertex.module) || desc.fragment.as_ref().is_some_and(|f| passed(f.module)))
        {
            return Err("a pipeline of GLSL shader modules needs an explicit layout".into());
        }
        let sources = vec![
            pipeline::glsl(
                desc.vertex.module,
                desc.vertex.entry_point,
                pipeline::Stage::Vertex,
                desc.vertex.compilation_options.constants,
            )?,
            match &desc.fragment {
                Some(fragment) => pipeline::glsl(
                    fragment.module,
                    fragment.entry_point,
                    pipeline::Stage::Fragment,
                    fragment.compilation_options.constants,
                )?,
                None => pipeline::Source {
                    text: "#version 300 es\nprecision highp float;\nvoid main() {}\n".into(),
                    bindings: Vec::new(),
                    layout: Vec::new(),
                },
            },
        ];
        let mut programs = self.0.programs.borrow_mut();
        let key: Vec<_> = sources.iter().map(|source| source.text.clone()).collect();
        if let Some(program) = programs.get(&key) {
            return Ok(program.clone());
        }
        let program = Rc::new(Program::new(&self.0.gl, &sources, &mut self.0.stages.borrow_mut())?);
        programs.insert(key, program.clone());
        Ok(program)
    }
}

pub(super) fn validation(message: String) -> wgpu::Error {
    wgpu::Error::Validation { source: Box::new(std::io::Error::other(message.clone())), description: message }
}

impl DeviceInterface for Device {
    fn features(&self) -> wgpu::Features {
        wgpu::Features::empty()
    }
    fn limits(&self) -> wgpu::Limits {
        self.0.limits.clone()
    }
    fn adapter_info(&self) -> wgpu::AdapterInfo {
        wgpu::AdapterInfo {
            name: "WebGL2".into(),
            ..wgpu::AdapterInfo::new(wgpu::DeviceType::Other, wgpu::Backend::Gl)
        }
    }
    /// A WGSL module, with the `wgsl` feature. latkit's own shaders are GLSL, passed through.
    fn create_shader_module(
        &self,
        desc: wgpu::ShaderModuleDescriptor<'_>,
        _shader_bound_checks: wgpu::ShaderRuntimeChecks,
    ) -> DispatchShaderModule {
        #[cfg(feature = "wgsl")]
        let shader = Shader::wgsl(match desc.source {
            wgpu::ShaderSource::Wgsl(source) => {
                naga::front::wgsl::parse_str(&source).map_err(|e| e.emit_to_string(&source))
            }
            _ => Err("unsupported shader source".into()),
        });
        #[cfg(not(feature = "wgsl"))]
        let shader = {
            let _ = desc;
            let message = "this build of latkit's WebGL2 device takes GLSL only: WGSL needs the `wgsl` feature";
            self.error(validation(message.to_owned()));
            Shader::glsl(String::new(), "")
        };
        if let Some(message) = shader.error() {
            self.error(validation(message.to_owned()));
        }
        DispatchShaderModule::custom(shader)
    }
    /// GLSL ES 3.00 for one entry point, starting with the header of its bindings that
    /// `src/gpu/glsl.rs` writes. The device compiles it as is when a pipeline links it.
    unsafe fn create_shader_module_passthrough(
        &self,
        desc: &wgpu::ShaderModuleDescriptorPassthrough<'_>,
    ) -> DispatchShaderModule {
        let entry = desc.entry_points.first().map(|entry| entry.name.to_string()).unwrap_or_default();
        if desc.glsl.is_none() {
            self.error(validation("the WebGL2 device passes through GLSL only".to_owned()));
        }
        DispatchShaderModule::custom(Shader::glsl(entry, desc.glsl.as_deref().unwrap_or_default()))
    }
    fn create_bind_group_layout(&self, desc: &wgpu::BindGroupLayoutDescriptor<'_>) -> DispatchBindGroupLayout {
        DispatchBindGroupLayout::custom(super::resource::Layout(desc.entries.to_vec()))
    }
    fn create_bind_group(&self, desc: &wgpu::BindGroupDescriptor<'_>) -> DispatchBindGroup {
        DispatchBindGroup::custom(super::resource::Group::new(desc))
    }
    fn create_pipeline_layout(&self, desc: &wgpu::PipelineLayoutDescriptor<'_>) -> DispatchPipelineLayout {
        DispatchPipelineLayout::custom(super::resource::PipelineLayout(
            desc.bind_group_layouts
                .iter()
                .map(|l| {
                    l.map_or_else(
                        || super::resource::Layout(Vec::new()),
                        |l| l.as_custom::<super::resource::Layout>().unwrap().clone(),
                    )
                })
                .collect(),
        ))
    }
    fn create_render_pipeline(&self, desc: &wgpu::RenderPipelineDescriptor<'_>) -> DispatchRenderPipeline {
        let program = self.pipeline(desc);
        let layouts = desc.layout.map_or_else(
            || program.as_ref().map_or_else(|_| Vec::new(), |p| p.layouts.clone()),
            |l| l.as_custom::<super::resource::PipelineLayout>().unwrap().0.clone(),
        );
        match &program {
            Ok(program) => {
                program.watch(&self.0);
                // Every enclosing scope waits for readiness, but only the nearest matching
                // scope owns the error. A custom marker's failure cannot poison its parent.
                let mut captured = false;
                for scope in self
                    .0
                    .scopes
                    .borrow_mut()
                    .iter_mut()
                    .rev()
                    .flatten()
                    .filter(|s| s.filter == wgpu::ErrorFilter::Validation)
                {
                    scope.programs.push((program.clone(), !captured));
                    captured = true;
                }
                if !captured {
                    let weak = Rc::downgrade(&self.0);
                    let program = program.clone();
                    wasm_bindgen_futures::spawn_local(async move {
                        if let Err(error) = program.result().await
                            && let Some(state) = weak.upgrade()
                        {
                            Self(state).error(validation(error));
                        }
                    });
                }
            }
            Err(error) => self.error(validation(error.clone())),
        }
        DispatchRenderPipeline::custom(Pipeline {
            program,
            vertices: Rc::new(desc.vertex.buffers.iter().map(|l| super::vertex::Layout::new(l.as_ref())).collect()),
            primitive: desc.primitive,
            depth: desc.depth_stencil.clone(),
            targets: desc.fragment.as_ref().map_or_else(Vec::new, |f| f.targets.to_vec()),
            layouts,
        })
    }
    fn create_mesh_pipeline(&self, desc: &wgpu::MeshPipelineDescriptor<'_>) -> DispatchRenderPipeline {
        let message = "WebGL2 has no mesh shaders".to_owned();
        self.error(validation(message.clone()));
        DispatchRenderPipeline::custom(Pipeline {
            program: Err(message),
            vertices: Rc::default(),
            primitive: desc.primitive,
            depth: desc.depth_stencil.clone(),
            targets: desc.fragment.as_ref().map_or_else(Vec::new, |f| f.targets.to_vec()),
            layouts: Vec::new(),
        })
    }
    fn create_compute_pipeline(&self, _desc: &wgpu::ComputePipelineDescriptor<'_>) -> DispatchComputePipeline {
        report_to(&self.0, "run compute shaders");
        DispatchComputePipeline::custom(Unsupported)
    }
    unsafe fn create_pipeline_cache(&self, _desc: &wgpu::PipelineCacheDescriptor<'_>) -> DispatchPipelineCache {
        report_to(&self.0, "cache pipelines");
        DispatchPipelineCache::custom(Unsupported)
    }
    fn create_buffer(&self, desc: &wgpu::BufferDescriptor<'_>) -> DispatchBuffer {
        let buffer = super::resource::Buffer::new(&self.0, desc);
        self.changed();
        DispatchBuffer::custom(buffer)
    }
    fn create_texture(&self, desc: &wgpu::TextureDescriptor<'_>) -> DispatchTexture {
        let texture = super::resource::Texture::new(&self.0.gl, desc);
        self.changed();
        DispatchTexture::custom(texture)
    }
    fn create_external_texture(
        &self,
        _desc: &wgpu::ExternalTextureDescriptor<'_>,
        _planes: &[&wgpu::TextureView],
    ) -> DispatchExternalTexture {
        report_to(&self.0, "sample external textures");
        DispatchExternalTexture::custom(Unsupported)
    }
    fn create_blas(
        &self,
        _desc: &wgpu::CreateBlasDescriptor<'_>,
        _sizes: wgpu::BlasGeometrySizeDescriptors,
    ) -> (Option<u64>, DispatchBlas) {
        report_to(&self.0, "build acceleration structures");
        (None, DispatchBlas::custom(Unsupported))
    }
    fn create_tlas(&self, _desc: &wgpu::CreateTlasDescriptor<'_>) -> DispatchTlas {
        report_to(&self.0, "build acceleration structures");
        DispatchTlas::custom(Unsupported)
    }
    fn create_sampler(&self, desc: &wgpu::SamplerDescriptor<'_>) -> DispatchSampler {
        DispatchSampler::custom(super::resource::Sampler::new(&self.0.gl, desc))
    }
    /// WebGL2 has no query sets: it counts no timestamps on Direct3D, and only whether any sample
    /// passed. latkit times frames with [`Elapsed`](super::Elapsed) instead.
    fn create_query_set(&self, _desc: &wgpu::QuerySetDescriptor<'_>) -> DispatchQuerySet {
        report_to(&self.0, "make query sets");
        DispatchQuerySet::custom(Unsupported)
    }
    fn create_command_encoder(&self, _desc: &wgpu::CommandEncoderDescriptor<'_>) -> DispatchCommandEncoder {
        DispatchCommandEncoder::custom(super::command::Encoder::new(&self.0))
    }
    fn create_render_bundle_encoder(
        &self,
        _desc: &wgpu::RenderBundleEncoderDescriptor<'_>,
    ) -> DispatchRenderBundleEncoder {
        DispatchRenderBundleEncoder::custom(super::command::Pass::bundle(&self.0))
    }
    fn set_device_lost_callback(&self, device_lost_callback: BoxDeviceLostCallback) {
        if let Some(reason) = self.0.lost_reason.get() {
            device_lost_callback(reason, "WebGL2 device lost".into());
        } else {
            *self.0.lost.borrow_mut() = Some(device_lost_callback);
        }
    }
    fn on_uncaptured_error(&self, handler: Arc<dyn wgpu::UncapturedErrorHandler>) {
        *self.0.handler.borrow_mut() = Some(handler);
    }
    fn push_error_scope(&self, filter: wgpu::ErrorFilter) -> u32 {
        // Only an out-of-memory scope asks the context for its errors, which waits for the browser's
        // GPU process, busy for up to a second while it compiles. A validation scope learns of its
        // errors from shader translation and linking, which report to it directly.
        if filter == wgpu::ErrorFilter::OutOfMemory {
            self.check_errors();
        }
        let mut scopes = self.0.scopes.borrow_mut();
        let index = scopes.len() as u32;
        scopes.push(Some(Scope { filter, programs: Vec::new(), errors: Vec::new() }));
        index
    }
    fn pop_error_scope(&self, index: u32) -> Pin<Box<dyn PopErrorScopeFuture>> {
        let filter = self.0.scopes.borrow()[index as usize].as_ref().map(|scope| scope.filter);
        if filter == Some(wgpu::ErrorFilter::OutOfMemory) {
            self.check_errors();
        }
        let mut scopes = self.0.scopes.borrow_mut();
        let scope = scopes[index as usize].take().expect("scope is active");
        while scopes.last().is_some_and(Option::is_none) {
            scopes.pop();
        }
        Box::pin(async move {
            let mut first = scope.errors.into_iter().next();
            // A scope is also the asynchronous readiness boundary for all of its programs.
            // An earlier validation or link error must not leave later programs unchecked.
            for (program, captures) in scope.programs {
                if let Err(error) = program.result().await
                    && captures
                    && first.is_none()
                {
                    first = Some(validation(error));
                }
            }
            first
        })
    }
    unsafe fn start_graphics_debugger_capture(&self) {}
    unsafe fn stop_graphics_debugger_capture(&self) {}
    fn poll(&self, _poll_type: wgpu_types::PollType<u64>) -> Result<wgpu::PollStatus, wgpu::PollError> {
        Ok(wgpu::PollStatus::QueueEmpty)
    }
    fn get_internal_counters(&self) -> wgpu::InternalCounters {
        wgpu::InternalCounters::default()
    }
    fn generate_allocator_report(&self) -> Option<wgpu::AllocatorReport> {
        None
    }
    fn destroy(&self) {
        if self.0.lost_reason.get().is_some() {
            return;
        }
        self.lost(wgpu::DeviceLostReason::Destroyed);
        // Each device owns its context. Explicit destruction releases all GPU allocations,
        // including resources still held by callers, and cancels outstanding fence waits.
        self.lose_context();
    }
}
