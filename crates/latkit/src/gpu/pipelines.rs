//! Pipelines, cached by [`Variant`].
//!
//! Every pipeline compiles through one queue per GPU ([`Pipelines::ask`]), most urgent first: draw
//! pipelines, then text pipelines, then the pipelines that changes, lit rows, and input need. Last
//! come pipelines warmed for future views, once the queue would otherwise sit idle.
//!
//! In a browser, compiles run in the background and in parallel. Draw pipelines start at once,
//! text pipelines as the browser's compile workers free up, and the rest a few at a time. Anything
//! that uses a pipeline waits until its compile finishes. So no frame waits on a compile, and
//! creating the pipeline afterwards finds it compiled. Natively, a pipeline is created in process
//! when first used, which is just as cheap. Every pipeline shares the view and mark group layouts.
//! Each shader's pass group layout comes from its WGSL.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::task::{Context, Poll, Waker};

use super::Shared;
use super::shaders::{Binding, MARK_GROUP, PATH_ENDS, Shader, VIEW_GROUP};
use super::work::{Count, Counters};
use crate::Error;
use crate::view::DEPTH;

/// How soon a requested pipeline is needed. Sooner compiles first. `Draw`: pipelines that frames
/// draw with. `Text`: pipelines for the frames' text. `Answer`: pipelines that changes, lit rows,
/// and input need. `Warm`: pipelines warmed for future views.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(crate) enum Urgency {
    Draw,
    Text,
    Answer,
    Warm,
}

/// How many pipelines a browser compiles in parallel. Text pipelines start only while fewer than
/// this are compiling, or while no draw pipeline is, since starting them sooner would delay the
/// draw pipelines. The rest compile at most half as many at once, so frames drawn meanwhile keep
/// the CPU. Each finished compile starts the next.
const WORKERS: u64 = 8;

/// A pending check of a custom marker's shader, resolving to its error if any. It is `Send`
/// natively, and stays on the page's single thread in browsers.
#[cfg(not(target_arch = "wasm32"))]
type Check = Pin<Box<dyn Future<Output = Option<wgpu::Error>> + Send>>;
#[cfg(target_arch = "wasm32")]
type Check = Pin<Box<dyn Future<Output = Option<wgpu::Error>>>>;

/// A custom marker's pipeline, compiled from its source the first time a view draws it.
struct Custom {
    pipeline: wgpu::RenderPipeline,
    check: Option<Check>,
    failed: bool,
}

/// One pipeline: a shader's entry point specialized for one primitive's geometry (`PRIMITIVE`),
/// one kind of path (`PATH`), and what channels read (`JOINED`, `TIMED`, and `VIEWED`). A render
/// variant also has the format and multisample count it draws into. It sets a primitive and a path
/// only when its shader reads them, so no two variants compile to the same pipeline.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Variant {
    shader: Shader,
    entry: &'static str,
    primitive: u32,
    path: u32,
    reads: Reads,
    target: Option<(wgpu::TextureFormat, u32)>,
}

/// What a mark's channels read besides its own table's static fields: other tables' fields by row
/// id (`joined`), fields sampled over an axis (`timed`), and the view's selection, hover, pointer,
/// and zoom (`viewed`). Every pipeline except the channels pipeline reads all of them.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Reads {
    pub(crate) joined: bool,
    pub(crate) timed: bool,
    pub(crate) viewed: bool,
}

impl Reads {
    pub(crate) const ALL: Reads = Reads { joined: true, timed: true, viewed: true };
    pub(crate) const NONE: Reads = Reads { joined: false, timed: false, viewed: false };
}

impl Variant {
    /// `shader` drawing into `format` with `samples` samples per pixel.
    pub(crate) const fn draw(shader: Shader, format: wgpu::TextureFormat, samples: u32) -> Variant {
        Variant {
            shader,
            entry: "vertex",
            primitive: 0,
            path: PATH_ENDS,
            reads: Reads::ALL,
            target: Some((format, samples)),
        }
    }

    /// `shader`'s compute entry point `entry`.
    pub(crate) const fn compute(shader: Shader, entry: &'static str) -> Variant {
        Variant { shader, entry, primitive: 0, path: PATH_ENDS, reads: Reads::ALL, target: None }
    }

    /// The probe program for marks of `primitive`. It answers every query in steps, and each
    /// dispatch's uniform selects the step.
    pub(crate) fn probe(shader: Shader, primitive: u32) -> Variant {
        Variant::compute(shader, "answer").primitive(primitive)
    }

    /// The channels pipeline for marks whose channels read `reads`.
    pub(crate) fn channels(reads: Reads) -> Variant {
        Variant { reads, ..Variant::compute(Shader::Evaluate, "evaluate") }
    }

    /// This variant specialized for marks of `primitive` (a `POINTS`, `STROKES`, or `TRIANGLES`
    /// code), if its shader reads `PRIMITIVE`.
    #[must_use]
    pub(crate) fn primitive(mut self, primitive: u32) -> Variant {
        if self.reads_constant("PRIMITIVE") {
            self.primitive = primitive;
        }
        self
    }

    /// This variant with strokes reading `path` (a `PATH_` code), if its shader reads `PATH`.
    #[must_use]
    pub(crate) fn path(mut self, path: u32) -> Variant {
        if self.reads_constant("PATH") {
            self.path = path;
        }
        self
    }

    fn reads_constant(&self, name: &str) -> bool {
        self.shader.source().overrides.contains(&name)
    }

    /// Values for the pipeline constants its shader declares.
    fn constants(&self) -> Vec<(&'static str, f64)> {
        let value = |name: &str| match name {
            "PRIMITIVE" => f64::from(self.primitive),
            "PATH" => f64::from(self.path),
            "JOINED" => f64::from(u8::from(self.reads.joined)),
            "TIMED" => f64::from(u8::from(self.reads.timed)),
            "VIEWED" => f64::from(u8::from(self.reads.viewed)),
            other => unreachable!("no value for the pipeline constant {other}"),
        };
        self.shader.source().overrides.iter().map(|&name| (name, value(name))).collect()
    }
}

/// A pipeline requested ahead of use: a variant of a latkit shader, or of a custom marker. A custom
/// marker's WGSL is appended to its shader's WGSL.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Asked {
    Shader(Variant),
    Custom(Arc<str>, Variant),
}

impl Asked {
    /// Bytes of WGSL it compiles from. More bytes take longer to compile.
    pub(crate) fn size(&self) -> usize {
        match self {
            Asked::Shader(variant) => variant.shader.source().size(),
            Asked::Custom(source, variant) => variant.shader.source().size() + source.len(),
        }
    }
}

/// The compile state of a pipeline requested ahead: whether it compiled in the background, whether
/// that compile finished (`landed`), and the wakers waiting for it.
#[derive(Default)]
struct Ahead {
    compiled: AtomicBool,
    landed: AtomicBool,
    waiting: Mutex<Vec<Waker>>,
}

impl Ahead {
    fn landed(&self) -> bool {
        self.landed.load(Ordering::Acquire)
    }

    /// Registers `waker` to wake when the compile finishes.
    fn wait(&self, waker: &Waker) {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner).push(waker.clone());
    }

    /// Marks the compile finished, increments `landed`, and wakes the waiters.
    fn land(&self, landed: &AtomicU64) {
        self.landed.store(true, Ordering::Release);
        landed.fetch_add(1, Ordering::AcqRel);
        for waker in self.waiting.lock().unwrap_or_else(PoisonError::into_inner).drain(..) {
            waker.wake();
        }
    }
}

pub(crate) struct Pipelines {
    pub(crate) view_layout: wgpu::BindGroupLayout,
    pub(crate) mark_layout: wgpu::BindGroupLayout,
    /// The bind group bound in place of the shared groups for a shader that reads neither.
    pub(crate) empty: wgpu::BindGroup,
    empty_layout: wgpu::BindGroupLayout,
    pass_layouts: HashMap<Vec<wgpu::BindGroupLayoutEntry>, wgpu::BindGroupLayout>,
    modules: HashMap<Shader, wgpu::ShaderModule>,
    render: HashMap<Variant, wgpu::RenderPipeline>,
    compute: HashMap<Variant, wgpu::ComputePipeline>,
    custom: HashMap<(Arc<str>, Variant), Custom>,
    /// Pipelines requested ahead by views, shots, and the GPU, each with its compile state.
    asked: HashMap<Asked, Arc<Ahead>>,
    /// Requested pipelines waiting to start compiling: most urgent first, and largest first within
    /// an urgency, since a browser compiles in request order.
    queue: Vec<(Urgency, Asked)>,
    /// How many requested compiles have finished. In a browser, `compiling` counts those in
    /// progress.
    landed: Arc<AtomicU64>,
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    compiling: Arc<AtomicU64>,
    /// Of the compiles in progress, how many are draw pipelines.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    drawing: Arc<AtomicU64>,
    /// Whether any draw pipeline has started compiling, and whether warm pipelines may start.
    drew: bool,
    warming: bool,
    /// Whether the pipelines for future views were queued.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    warmed: bool,
    /// Counts the pipelines compiled.
    counters: Arc<Counters>,
    /// The GPU these belong to, so a finished compile can start the next.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "web")),
        expect(dead_code, reason = "only a browser compiles ahead")
    )]
    gpu: Weak<Shared>,
}

/// The probe shader that reads depth in frames of `samples` samples per pixel.
pub(crate) fn probe(samples: u32) -> Shader {
    if samples > 1 { Shader::ProbeMultisampled } else { Shader::Probe }
}

/// The primitive topology of a render shader.
fn topology(shader: Shader) -> wgpu::PrimitiveTopology {
    // Custom markers draw like points, as triangle strips.
    match shader {
        Shader::Backdrop | Shader::Triangles => wgpu::PrimitiveTopology::TriangleList,
        _ => wgpu::PrimitiveTopology::TriangleStrip,
    }
}

/// A render shader's depth state, with reversed depth. The backdrop writes the globe's depth and
/// triangles write theirs. The overlay and glyphs ignore depth, and every other mark draws only
/// where nothing nearer was drawn.
fn depth(shader: Shader) -> wgpu::DepthStencilState {
    let compare = match shader {
        Shader::Backdrop | Shader::Overlay | Shader::Glyphs => wgpu::CompareFunction::Always,
        _ => wgpu::CompareFunction::GreaterEqual,
    };
    wgpu::DepthStencilState {
        format: DEPTH,
        depth_write_enabled: Some(matches!(shader, Shader::Triangles | Shader::Backdrop)),
        depth_compare: Some(compare),
        stencil: wgpu::StencilState::default(),
        bias: wgpu::DepthBiasState::default(),
    }
}

fn layout(device: &wgpu::Device, label: &str, bindings: &[Binding]) -> wgpu::BindGroupLayout {
    let entries: Vec<_> = bindings.iter().map(Binding::layout_entry).collect();
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries: &entries })
}

impl Pipelines {
    pub(crate) fn new(device: &wgpu::Device, counters: Arc<Counters>, gpu: Weak<Shared>) -> Pipelines {
        let empty_layout = layout(device, "latkit empty", &[]);
        let empty = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("latkit empty"),
            layout: &empty_layout,
            entries: &[],
        });
        Pipelines {
            view_layout: layout(device, "latkit view", VIEW_GROUP),
            mark_layout: layout(device, "latkit mark", MARK_GROUP),
            empty,
            empty_layout,
            pass_layouts: HashMap::new(),
            modules: HashMap::new(),
            render: HashMap::new(),
            compute: HashMap::new(),
            custom: HashMap::new(),
            asked: HashMap::new(),
            queue: Vec::new(),
            landed: Arc::default(),
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            compiling: Arc::default(),
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            drawing: Arc::default(),
            drew: false,
            warming: false,
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            warmed: false,
            counters,
            gpu,
        }
    }

    /// Requests each of `needs` at `urgency`, waking `waker` as each compile finishes. Draw
    /// pipelines start at once, text pipelines as workers free up, and the rest in turn, at most
    /// half of `WORKERS` at a time. Requesting a queued pipeline again at a higher urgency moves it
    /// up. Each shader module is created now, because a browser parses a module's WGSL on its GPU
    /// thread at creation. This way, modules that compile later are parsed before anything draws.
    pub(crate) fn ask(&mut self, device: &wgpu::Device, needs: &[Asked], urgency: Urgency, waker: &Waker) {
        self.queue(device, needs, urgency, waker);
        self.pump(device);
    }

    /// Queues each of `needs` at `urgency` like [`ask`](Pipelines::ask), without starting any. The
    /// next request, finished compile, or [`pump`](Pipelines::pump) starts them.
    pub(crate) fn queue(&mut self, device: &wgpu::Device, needs: &[Asked], urgency: Urgency, waker: &Waker) {
        for need in needs {
            if let Some(ahead) = self.asked.get(need) {
                if !ahead.landed() {
                    ahead.wait(waker);
                }
                if let Some(queued) = self.queue.iter_mut().find(|(_, queued)| queued == need) {
                    queued.0 = queued.0.min(urgency);
                }
                continue;
            }
            let ahead = Arc::new(Ahead::default());
            ahead.wait(waker);
            self.asked.insert(need.clone(), ahead);
            if let Asked::Shader(variant) = need {
                self.module(device, variant.shader);
            }
            self.queue.push((urgency, need.clone()));
        }
        // Largest first, so the last one finishes soonest. Warm pipelines keep their listed order.
        crate::order::by_key(&mut self.queue, |(urgency, need)| {
            let size = if *urgency == Urgency::Warm { 0 } else { !(need.size().min(u32::MAX as usize) as u32) };
            crate::order::pair(*urgency as u32, size)
        });
    }

    /// Queues `needs`, the pipelines future views will draw with, once per GPU. They compile after
    /// the first scene's draw pipelines finish, so they never delay them. `waker` wakes as each
    /// finishes, so anything waiting on the GPU's compiles sees it.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn warm(&mut self, device: &wgpu::Device, waker: &Waker, needs: impl FnOnce() -> Vec<Asked>) {
        if !std::mem::replace(&mut self.warmed, true) {
            self.queue(device, &needs(), Urgency::Warm, waker);
        }
    }

    /// Starts queued compiles in order. Draw pipelines always start. Text pipelines start while
    /// fewer than `WORKERS` are compiling or no draw pipeline is. The rest start while fewer than
    /// half of `WORKERS` are compiling.
    pub(crate) fn pump(&mut self, device: &wgpu::Device) {
        // Warm pipelines wait until the first scene's draw pipelines have finished.
        self.warming |= self.drew && self.drawing() == 0;
        while let Some(&(urgency, _)) = self.queue.first()
            && match urgency {
                Urgency::Draw => true,
                Urgency::Text => self.drawing() == 0 || self.in_flight() < WORKERS,
                Urgency::Answer => self.in_flight() < WORKERS / 2,
                Urgency::Warm => self.warming && self.in_flight() < WORKERS / 2,
            }
        {
            let (urgency, need) = self.queue.remove(0);
            self.drew |= urgency == Urgency::Draw;
            let ahead = self.asked[&need].clone();
            if !self.compile_ahead(device, &need, &ahead, urgency == Urgency::Draw) {
                ahead.land(&self.landed);
            }
        }
    }

    /// Compiles in progress in the background.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "web")),
        expect(clippy::unused_self, reason = "only a browser's device compiles ahead")
    )]
    fn in_flight(&self) -> u64 {
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        return self.compiling.load(Ordering::Acquire);
        #[cfg(not(all(feature = "web", target_arch = "wasm32")))]
        0
    }

    /// Draw pipeline compiles in progress.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "web")),
        expect(clippy::unused_self, reason = "only a browser's device compiles ahead")
    )]
    fn drawing(&self) -> u64 {
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        return self.drawing.load(Ordering::Acquire);
        #[cfg(not(all(feature = "web", target_arch = "wasm32")))]
        0
    }

    /// Whether every one of `needs` was requested and has finished compiling, so pipelines using
    /// them can be created without a compile.
    pub(crate) fn ready(&self, needs: &[Asked]) -> bool {
        needs.iter().all(|need| self.asked.get(need).is_some_and(|ahead| ahead.landed()))
    }

    /// How many requested compiles have finished so far. Anything waiting on a compile sees this
    /// change.
    pub(crate) fn landed(&self) -> u64 {
        self.landed.load(Ordering::Acquire)
    }

    /// Requested compiles still in progress or queued.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn compiling(&self) -> u64 {
        self.in_flight() + self.queue.len() as u64
    }

    /// Starts compiling `need` in the background where a browser supports it, counted as a draw
    /// pipeline when `draws`. Returns whether it started. When it finishes, it starts the next
    /// queued compile.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "web")),
        expect(clippy::unused_self, reason = "only a browser's device compiles ahead")
    )]
    fn compile_ahead(&mut self, device: &wgpu::Device, need: &Asked, ahead: &Arc<Ahead>, draws: bool) -> bool {
        #[cfg(all(target_arch = "wasm32", feature = "web"))]
        {
            let Some(promise) = compiled::capture(device, || self.create(device, need)) else { return false };
            self.counters.add(Count::Pipelines, 1);
            ahead.compiled.store(true, Ordering::Release);
            let (ahead, landed, compiling) = (ahead.clone(), self.landed.clone(), self.compiling.clone());
            let drawing = draws.then(|| self.drawing.clone());
            let gpu = self.gpu.clone();
            compiling.fetch_add(1, Ordering::AcqRel);
            if let Some(drawing) = &drawing {
                drawing.fetch_add(1, Ordering::AcqRel);
            }
            wasm_bindgen_futures::spawn_local(async move {
                // A descriptor the browser rejects also finishes. Creating the pipeline later
                // reports why, as it would without compiling ahead.
                let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
                compiling.fetch_sub(1, Ordering::AcqRel);
                if let Some(drawing) = drawing {
                    drawing.fetch_sub(1, Ordering::AcqRel);
                }
                // Start the next compile before waking the waiters, so they find it in progress.
                if let Some(gpu) = gpu.upgrade()
                    && let Some(mut inner) = gpu.try_lock()
                {
                    inner.pipelines.pump(&gpu.device);
                }
                ahead.land(&landed);
            });
            true
        }
        #[cfg(not(all(target_arch = "wasm32", feature = "web")))]
        {
            let _ = (device, need, ahead, draws);
            false
        }
    }

    /// Creates `need` through wgpu without caching or counting it, for compiling ahead to capture.
    /// A custom marker's WGSL errors are caught in a scope of their own here, so only creating it
    /// for real reports why it fails.
    #[cfg(all(target_arch = "wasm32", feature = "web"))]
    fn create(&mut self, device: &wgpu::Device, need: &Asked) {
        match need {
            Asked::Shader(variant) if variant.target.is_some() => {
                let module = self.module(device, variant.shader);
                drop(self.pipeline(device, *variant, &module));
            }
            Asked::Shader(variant) => drop(self.compute_made(device, *variant)),
            Asked::Custom(source, variant) => {
                let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
                let module = custom_module(device, source, variant.shader);
                drop(self.pipeline(device, *variant, &module));
                drop(scope.pop());
            }
        }
    }

    /// Counts a pipeline created for `need`: as compiled now unless it compiled ahead, and as late
    /// if it was never requested.
    fn count(&self, need: &Asked) {
        let ahead = self.asked.get(need);
        if !ahead.is_some_and(|ahead| ahead.compiled.load(Ordering::Acquire)) {
            self.counters.add(Count::Pipelines, 1);
        }
        if ahead.is_none() {
            self.counters.add(Count::Late, 1);
        }
    }

    /// The layout of `shader`'s pass group. Shaders with the same bindings share one.
    pub(crate) fn pass_layout(&mut self, device: &wgpu::Device, shader: Shader) -> wgpu::BindGroupLayout {
        let entries: Vec<_> = shader.source().pass.iter().map(Binding::layout_entry).collect();
        self.pass_layouts
            .entry(entries)
            .or_insert_with_key(|entries| {
                device
                    .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("latkit pass"), entries })
            })
            .clone()
    }

    fn module(&mut self, device: &wgpu::Device, shader: Shader) -> wgpu::ShaderModule {
        self.modules
            .entry(shader)
            .or_insert_with(|| {
                let source = shader.source();
                device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(source.label),
                    source: wgpu::ShaderSource::Wgsl(source.wgsl().into()),
                })
            })
            .clone()
    }

    /// The layout of `shader`'s pipelines: the view and mark groups (empty if it reads neither),
    /// then its pass group.
    fn pipeline_layout(&mut self, device: &wgpu::Device, shader: Shader) -> wgpu::PipelineLayout {
        let pass = (!shader.source().pass.is_empty()).then(|| self.pass_layout(device, shader));
        let mut groups = if shader.source().shared {
            vec![Some(&self.view_layout), Some(&self.mark_layout)]
        } else {
            vec![Some(&self.empty_layout), Some(&self.empty_layout)]
        };
        if let Some(pass) = &pass {
            groups.push(Some(pass));
        }
        device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(shader.source().label),
            bind_group_layouts: &groups,
            immediate_size: 0,
        })
    }

    /// The pipeline that draws a custom marker of `source`: `variant`, with `source` appended to
    /// its shader. `None` once that WGSL failed to compile.
    pub(crate) fn custom(
        &mut self,
        device: &wgpu::Device,
        source: &Arc<str>,
        variant: Variant,
    ) -> Option<wgpu::RenderPipeline> {
        let key = (source.clone(), variant);
        if let Some(custom) = self.custom.get(&key) {
            return (!custom.failed).then(|| custom.pipeline.clone());
        }
        self.count(&Asked::Custom(key.0.clone(), key.1));
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = custom_module(device, source, variant.shader);
        let pipeline = self.pipeline(device, variant, &module);
        let check: Check = Box::pin(scope.pop());
        let custom = Custom { pipeline: pipeline.clone(), check: Some(check), failed: false };
        self.custom.insert(key, custom);
        Some(pipeline)
    }

    /// Errors found in custom markers' shaders since the last call.
    pub(crate) fn custom_errors(&mut self) -> Vec<Error> {
        let mut context = Context::from_waker(Waker::noop());
        let mut errors = Vec::new();
        for custom in self.custom.values_mut() {
            let Some(check) = &mut custom.check else { continue };
            if let Poll::Ready(error) = check.as_mut().poll(&mut context) {
                custom.check = None;
                if let Some(error) = error {
                    custom.failed = true;
                    errors.push(Error::invalid(format!("the custom marker does not compile: {error}")).at("marker"));
                }
            }
        }
        errors
    }

    /// The render pipeline `variant` names.
    pub(crate) fn render(&mut self, device: &wgpu::Device, variant: Variant) -> wgpu::RenderPipeline {
        if let Some(pipeline) = self.render.get(&variant) {
            return pipeline.clone();
        }
        self.count(&Asked::Shader(variant));
        let module = self.module(device, variant.shader);
        let pipeline = self.pipeline(device, variant, &module);
        self.render.insert(variant, pipeline.clone());
        pipeline
    }

    fn pipeline(
        &mut self,
        device: &wgpu::Device,
        variant: Variant,
        module: &wgpu::ShaderModule,
    ) -> wgpu::RenderPipeline {
        let shader = variant.shader;
        let (format, samples) = variant.target.expect("a render variant");
        let layout = self.pipeline_layout(device, shader);
        let constants = variant.constants();
        let options = || wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() };
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(shader.source().label),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vertex"),
                compilation_options: options(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState { topology: topology(shader), ..Default::default() },
            depth_stencil: Some(depth(shader)),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fragment"),
                compilation_options: options(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    // Blend premultiplied colors over what is already drawn.
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// The compute pipeline `variant` names.
    pub(crate) fn compute(&mut self, device: &wgpu::Device, variant: Variant) -> wgpu::ComputePipeline {
        if let Some(pipeline) = self.compute.get(&variant) {
            return pipeline.clone();
        }
        self.count(&Asked::Shader(variant));
        let pipeline = self.compute_made(device, variant);
        self.compute.insert(variant, pipeline.clone());
        pipeline
    }

    fn compute_made(&mut self, device: &wgpu::Device, variant: Variant) -> wgpu::ComputePipeline {
        let module = self.module(device, variant.shader);
        let layout = self.pipeline_layout(device, variant.shader);
        let constants = variant.constants();
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(variant.entry),
            layout: Some(&layout),
            module: &module,
            entry_point: Some(variant.entry),
            compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
            cache: None,
        })
    }
}

/// The shader module for a custom marker: `shader`'s WGSL followed by the marker's `source`.
fn custom_module(device: &wgpu::Device, source: &str, shader: Shader) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("latkit custom marker"),
        source: wgpu::ShaderSource::Wgsl(format!("{}\n{source}", shader.source().wgsl()).into()),
    })
}

/// Compiling ahead in a browser. A browser compiles a pipeline created with `createRenderPipeline`
/// on the GPU's thread, delaying every frame and readback behind it. One created with the async
/// variant compiles on worker threads, in parallel with others. Chrome caches compiled pipelines by
/// descriptor, so creating the same descriptor later finds it compiled.
#[cfg(all(target_arch = "wasm32", feature = "web"))]
mod compiled {
    use std::cell::RefCell;
    use std::rc::Rc;

    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::{JsCast, JsValue};

    /// The device's pipeline creation methods, each with its async variant.
    const MAKERS: [(&str, &str); 2] = [
        ("createRenderPipeline", "createRenderPipelineAsync"),
        ("createComputePipeline", "createComputePipelineAsync"),
    ];

    /// Has the browser compile, in the background, the pipeline that `make` creates through wgpu.
    /// While `make` runs, the device's creation methods are swapped for their async variants. These
    /// receive the exact descriptor wgpu builds, so what compiles is exactly what wgpu creates
    /// later. Returns `None` if the device is not a browser's or `make` created nothing.
    pub(super) fn capture(device: &wgpu::Device, make: impl FnOnce()) -> Option<js_sys::Promise> {
        let raw: &JsValue = device.as_webgpu()?.as_ref();
        let twins: Vec<js_sys::Function> = MAKERS
            .iter()
            .map(|(_, twin)| js_sys::Reflect::get(raw, &JsValue::from_str(twin)).ok()?.dyn_into().ok())
            .collect::<Option<_>>()?;
        let caught: Rc<RefCell<Option<js_sys::Promise>>> = Rc::default();
        let shims: Vec<Closure<dyn FnMut(JsValue) -> JsValue>> = twins
            .into_iter()
            .map(|twin| {
                let (device, caught) = (raw.clone(), caught.clone());
                Closure::new(move |descriptor: JsValue| {
                    let promise = twin.call1(&device, &descriptor).unwrap_or(JsValue::UNDEFINED);
                    *caught.borrow_mut() = promise.clone().dyn_into().ok();
                    promise
                })
            })
            .collect();
        let swapped = MAKERS
            .iter()
            .zip(&shims)
            .all(|((maker, _), shim)| js_sys::Reflect::set(raw, &JsValue::from_str(maker), shim.as_ref()).is_ok());
        if swapped {
            make();
        }
        for (maker, _) in MAKERS {
            let _ = js_sys::Reflect::delete_property(raw.unchecked_ref::<js_sys::Object>(), &JsValue::from_str(maker));
        }
        drop(shims);
        caught.take()
    }
}
