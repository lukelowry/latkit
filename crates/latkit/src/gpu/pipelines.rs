//! Pipelines, cached by [`Variant`].
//!
//! Every pipeline compiles through one queue per GPU ([`Pipelines::ask`]), most urgent first: draw
//! pipelines, then text pipelines, then the pipelines that changes, lit rows, layers, and input
//! need. A GPU compiles only what its views ask for.
//!
//! Browser compilation is queued by urgency and yields between pipelines. A requested pipeline
//! becomes ready after creation and validation. Every entry shares view and mark layouts;
//! reflection supplies its pass layout. Native hosts create the same raster pipelines on demand.
//!
//! A pipeline's module is its shader with the values it is specialized for written in as `const`s,
//! so no pipeline passes pipeline constants, which browsers handle differently. A pipeline the
//! browser refuses to build is never created: each view that needs it reports why.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};
use std::task::{Context, Poll, Waker};

use super::Shared;
use super::shaders::{Binding, MARK_GROUP, PATH_ENDS, Shader, VIEW_GROUP};
use super::work::{Count, Counters};
use crate::view::DEPTH;
use crate::{Error, Space};

/// How soon a requested pipeline is needed. Sooner compiles first. `Draw`: pipelines that frames
/// draw with. `Text`: pipelines for the frames' text. `Answer`: pipelines that changes, lit rows,
/// layers, and input need.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub(crate) enum Urgency {
    Draw,
    Text,
    Answer,
}

/// How long less urgent compiles wait, once more urgent ones finish, before they wait for the GPU:
/// longer than a display frame, so the frames drawn with the finished pipelines are on the GPU.
/// A browser builds each pipeline's shaders for its real targets when a frame first draws with it,
/// and until it finishes, every synchronous query a starting compile makes blocks the page.
#[cfg(all(feature = "web", target_arch = "wasm32"))]
const SETTLE: std::time::Duration = std::time::Duration::from_millis(20);

/// Draw passes can share a shader module while retaining their own fixed depth state.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Draw {
    Rows,
    Lit,
    Opaque,
}

/// Fixed geometry projection; shared expression kernels can still read any view.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Projection {
    Planar,
    Mercator,
    Globe,
    Dynamic,
}

impl Projection {
    pub(crate) fn of(space: &Space) -> Self {
        match space {
            Space::Earth(earth) => match earth.projection {
                crate::Projection::Mercator => Self::Mercator,
                crate::Projection::Globe => Self::Globe,
            },
            _ => Self::Planar,
        }
    }

    fn code(self) -> u32 {
        use super::shaders::{PROJECTION_DYNAMIC, PROJECTION_GLOBE, PROJECTION_MERCATOR, PROJECTION_PLANAR};
        match self {
            Self::Planar => PROJECTION_PLANAR,
            Self::Mercator => PROJECTION_MERCATOR,
            Self::Globe => PROJECTION_GLOBE,
            Self::Dynamic => PROJECTION_DYNAMIC,
        }
    }
}

/// A pending answer from an error scope, resolving to its error if any. It is `Send` natively, and
/// stays on the page's single thread in browsers.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) type Check = Pin<Box<dyn Future<Output = Option<wgpu::Error>> + Send>>;
#[cfg(target_arch = "wasm32")]
pub(crate) type Check = Pin<Box<dyn Future<Output = Option<wgpu::Error>>>>;

/// A custom marker's pipeline, compiled from its source the first time a view draws it, with the
/// check of its WGSL until it answers, and why it failed to compile, if it did.
struct Custom {
    pipeline: Option<wgpu::RenderPipeline>,
    check: Option<Check>,
    failed: Option<Error>,
}

/// The failure of a custom marker whose WGSL does not compile, for `message`.
fn failure(message: &str) -> Error {
    Error::invalid(format!("the custom marker does not compile: {message}")).at("marker")
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
    projection: Projection,
    painted: bool,
    marker: u32,
    reads: Reads,
    target: Option<(wgpu::TextureFormat, u32)>,
    draw: Draw,
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
    pub(crate) fn shader(self) -> Shader {
        self.shader
    }
    pub(crate) fn entry(mut self, entry: &'static str) -> Self {
        self.entry = entry;
        // A finishing or packing entry does not acquire geometry variants merely because
        // another entry in its source module projects a primitive.
        if !self.reads_constant("PRIMITIVE") {
            self.primitive = 0;
        }
        if !self.reads_constant("PATH") {
            self.path = PATH_ENDS;
        }
        if !self.reads_constant("PROJECTION") {
            self.projection = Projection::Planar;
        }
        if !self.reads_constant("PAINTED") {
            self.painted = true;
        }
        if !self.reads_constant("MARKER") {
            self.marker = 0;
        }
        self
    }
    /// An integer raster operation. Its vertex entry covers the target; `entry` computes one
    /// output texel. It has no depth, blending, storage bindings, or compute dispatch.
    pub(crate) const fn raster(shader: Shader, entry: &'static str) -> Variant {
        Self::pass(shader, entry, wgpu::TextureFormat::Rgba32Uint)
    }

    /// A raster algorithm writing `format`, without geometry depth or alpha blending.
    pub(crate) const fn pass(shader: Shader, entry: &'static str, format: wgpu::TextureFormat) -> Variant {
        Variant {
            shader,
            entry,
            primitive: 0,
            path: PATH_ENDS,
            projection: if matches!(shader, Shader::State | Shader::StateNarrow) {
                Projection::Dynamic
            } else {
                Projection::Planar
            },
            painted: true,
            marker: 0,
            reads: Reads::ALL,
            target: Some((format, 1)),
            draw: Draw::Rows,
        }
    }

    /// `shader` drawing into `format` with `samples` samples per pixel.
    pub(crate) const fn draw(shader: Shader, format: wgpu::TextureFormat, samples: u32) -> Variant {
        Variant {
            shader,
            entry: "vertex",
            primitive: 0,
            path: PATH_ENDS,
            projection: Projection::Planar,
            painted: true,
            marker: 0,
            reads: Reads::ALL,
            target: Some((format, samples)),
            draw: Draw::Rows,
        }
    }

    /// The probe program for marks of `primitive`. It answers every query in steps, and each
    /// dispatch's uniform selects the step.
    pub(crate) fn probe(shader: Shader, primitive: u32) -> Variant {
        Variant::raster(shader, "probe").primitive(primitive)
    }

    pub(crate) fn state(shader: Shader, entry: &'static str, reads: Reads) -> Variant {
        Variant { reads, ..Variant::raster(shader, entry) }
    }

    pub(crate) fn state_kind(mut self, shader: Shader) -> Variant {
        self.shader = shader;
        self
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

    /// Compiles only the scene projection used by this geometry.
    #[must_use]
    pub(crate) fn projection(mut self, projection: Projection) -> Self {
        if self.reads_constant("PROJECTION") {
            self.projection = projection;
        }
        self
    }

    /// Omits dash and comet payloads when the scene's stroke expressions cannot produce them.
    #[must_use]
    pub(crate) fn painted(mut self, enabled: bool) -> Self {
        if self.reads_constant("PAINTED") {
            self.painted = enabled;
        }
        self
    }

    /// Compile only the marker family the scene draws. Blocks use the shape program.
    pub(crate) fn marker(mut self, marker: u32) -> Self {
        if self.reads_constant("MARKER") {
            self.marker = if marker == super::shaders::MARKER_BLOCK { super::shaders::MARKER_SHAPE } else { marker };
        }
        self
    }

    /// Normal and opaque marks share vertex geometry and select their own fragment entry.
    pub(crate) fn mode(mut self, draw: Draw) -> Self {
        if matches!(self.shader, Shader::Points | Shader::PointsCustom | Shader::Strokes) {
            self.draw = draw;
        }
        self
    }

    fn reads_constant(&self, name: &str) -> bool {
        self.shader.source().reads(self.entry, name)
    }

    fn fragment(&self) -> &'static str {
        if self.entry != "vertex" {
            self.entry
        } else if opaque(self.shader, self.draw) {
            "opaque"
        } else {
            "fragment"
        }
    }

    /// What its shader module is specialized for.
    fn specialized(&self) -> Specialized {
        Specialized {
            shader: self.shader,
            primitive: self.primitive,
            path: self.path,
            projection: self.projection,
            painted: self.painted,
            marker: self.marker,
            reads: self.reads,
        }
    }

    /// A label naming exactly this pipeline. Browsers show it in their errors, and it finds the
    /// pipeline compiled ahead for it.
    fn label(&self) -> String {
        let Reads { joined, timed, viewed } = self.reads;
        let target = self.target.map(|(format, samples)| format!(" {format:?}x{samples}")).unwrap_or_default();
        format!(
            "latkit {:?} {} PRIMITIVE={} PATH={} JOINED={} TIMED={} VIEWED={} PROJECTION={:?} PAINTED={} MARKER={} DRAW={:?}{target}",
            self.shader,
            self.entry,
            self.primitive,
            self.path,
            u8::from(joined),
            u8::from(timed),
            u8::from(viewed),
            self.projection,
            u8::from(self.painted),
            self.marker,
            self.draw,
        )
    }
}

/// What a shader module is specialized for: its shader, and the values of the constants it reads.
/// Its WGSL declares them as `const`s, so its pipelines pass no constants. Variants that differ
/// only in entry point or target share a module.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct Specialized {
    shader: Shader,
    primitive: u32,
    path: u32,
    projection: Projection,
    painted: bool,
    marker: u32,
    reads: Reads,
}

impl Specialized {
    /// The value of the constant `name`.
    fn value(&self, name: &str) -> u32 {
        match name {
            "PRIMITIVE" => self.primitive,
            "PATH" => self.path,
            "JOINED" => self.reads.joined.into(),
            "TIMED" => self.reads.timed.into(),
            "VIEWED" => self.reads.viewed.into(),
            "PROJECTION" => self.projection.code(),
            "PAINTED" => self.painted.into(),
            "MARKER" => self.marker,
            other => unreachable!("no value for the constant {other}"),
        }
    }

    /// The module's WGSL, with `appended` after the shader's own.
    fn wgsl(&self, appended: &str) -> String {
        let mut wgsl = self.shader.source().wgsl(|name| self.value(name));
        if matches!(self.shader, Shader::State | Shader::StateNarrow) {
            let kernel = if appended.is_empty() { super::kernel::EMPTY } else { appended };
            return super::specialize::portable(&super::specialize::evaluator(&wgsl, kernel));
        }
        if !appended.is_empty() {
            wgsl.push('\n');
            wgsl.push_str(appended);
        }
        super::specialize::portable(&wgsl)
    }
}

/// A pipeline requested ahead of use: a variant of a latkit shader, or of a custom marker. A custom
/// marker's WGSL is appended to its shader's WGSL.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Asked {
    Shader(Variant),
    Custom(Arc<str>, Variant),
    Kernel(Arc<str>, Variant),
}

impl Asked {
    /// Bytes of WGSL it compiles from. More bytes take longer to compile.
    pub(crate) fn size(&self) -> usize {
        match self {
            Asked::Shader(variant) => variant.shader.source().size(),
            Asked::Custom(source, variant) | Asked::Kernel(source, variant) => {
                variant.shader.source().size() + source.len()
            }
        }
    }

    /// A label naming exactly this pipeline: its variant's, and for a custom marker, a stamp of its
    /// WGSL.
    pub(crate) fn label(&self) -> String {
        match self {
            Asked::Shader(variant) => variant.label(),
            Asked::Custom(source, variant) => {
                format!("{} custom {:016x}", variant.label(), crate::derive::stamp_of(source))
            }
            Asked::Kernel(source, variant) => {
                format!("{} kernel {:016x}", variant.label(), crate::derive::stamp_of(source))
            }
        }
    }
}

/// The compile state of a pipeline requested ahead: whether it compiled in the background, whether
/// that compile finished (`landed`), why the browser refused to build it if it did, and the wakers
/// waiting for it.
#[derive(Default)]
struct Ahead {
    compiled: AtomicBool,
    landed: AtomicBool,
    refused: OnceLock<String>,
    waiting: Mutex<Vec<Waker>>,
}

impl Ahead {
    fn landed(&self) -> bool {
        self.landed.load(Ordering::Acquire)
    }

    /// Why the browser refused to build the pipeline, once it did.
    fn refused(&self) -> Option<&str> {
        self.refused.get().map(String::as_str)
    }

    /// Registers `waker` to wake when the compile finishes.
    fn wait(&self, waker: &Waker) {
        let mut waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        if !waiting.iter().any(|stored| stored.will_wake(waker)) {
            waiting.push(waker.clone());
        }
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
    modules: HashMap<Specialized, Modules>,
    application_modules: HashMap<(Arc<str>, Specialized), Modules>,
    kernels: HashMap<(Arc<str>, Variant), wgpu::RenderPipeline>,
    render: HashMap<Variant, wgpu::RenderPipeline>,
    custom: HashMap<(Arc<str>, Variant), Custom>,
    /// Pipelines requested ahead by views, shots, and the GPU, each with its compile state.
    asked: HashMap<Asked, Arc<Ahead>>,
    /// Requested pipelines waiting to start compiling: most urgent first, and largest first within
    /// an urgency, since a browser compiles in request order.
    queue: Vec<(Urgency, Asked)>,
    /// Compiles started and not finished, by urgency. A browser compiles them on the same threads,
    /// so less urgent ones wait until these finish.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    started: Vec<(Urgency, Arc<Ahead>)>,
    /// The least urgent compiles that may start without first waiting for the GPU to settle.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    opened: Urgency,
    /// Compiles at this urgency wait for the GPU to settle before they start.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    settling: Option<Urgency>,
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    scheduled: bool,
    /// How many requested compiles have finished. In a browser, `compiling` counts those in
    /// progress.
    landed: Arc<AtomicU64>,
    /// How many compiles the browser refused.
    refusals: Arc<AtomicU64>,
    /// Counts the pipelines compiled.
    counters: Arc<Counters>,
    /// The GPU these belong to, so a finished compile can start the next.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "web")),
        expect(dead_code, reason = "only a browser compiles ahead")
    )]
    gpu: Weak<Shared>,
}

/// The primitive topology of a render shader.
fn topology(shader: Shader) -> wgpu::PrimitiveTopology {
    // Custom markers draw like points, as triangle strips.
    match shader {
        Shader::Backdrop => wgpu::PrimitiveTopology::TriangleList,
        _ => wgpu::PrimitiveTopology::TriangleStrip,
    }
}

/// Whether `shader` draws the opaque pixels of points or strokes, which where depth varies draw
/// before any pixel blends.
fn opaque(shader: Shader, draw: Draw) -> bool {
    matches!(shader, Shader::Points | Shader::PointsCustom | Shader::Strokes) && draw == Draw::Opaque
}

/// A render shader's depth state, with reversed depth. The backdrop writes the globe's depth,
/// and the opaque variants write that of the opaque pixels of points and strokes. The rows of
/// points, strokes, and areas draw only in front of what is drawn, so where depth varies they skip
/// the pixels the opaque variants drew, their own included. Lit rows draw where nothing nearer was
/// drawn, and the overlay and glyphs ignore depth.
fn depth(shader: Shader, draw: Draw) -> wgpu::DepthStencilState {
    let compare = match shader {
        Shader::Backdrop | Shader::Overlay | Shader::Glyphs => wgpu::CompareFunction::Always,
        Shader::Points | Shader::PointsCustom | Shader::Strokes if draw != Draw::Rows => {
            wgpu::CompareFunction::GreaterEqual
        }
        Shader::Points | Shader::PointsCustom | Shader::Strokes | Shader::Areas => wgpu::CompareFunction::Greater,
        _ => wgpu::CompareFunction::GreaterEqual,
    };
    wgpu::DepthStencilState {
        format: DEPTH,
        depth_write_enabled: Some(matches!(shader, Shader::Backdrop) || opaque(shader, draw)),
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
            application_modules: HashMap::new(),
            kernels: HashMap::new(),
            render: HashMap::new(),
            custom: HashMap::new(),
            asked: HashMap::new(),
            queue: Vec::new(),
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            started: Vec::new(),
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            opened: Urgency::Draw,
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            settling: None,
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            scheduled: false,
            landed: Arc::default(),
            refusals: Arc::default(),
            counters,
            gpu,
        }
    }

    /// Requests each pipeline at its urgency, registers the caller's waker, and advances the
    /// queue. All requests of one view are queued together before any starts compiling.
    pub(crate) fn ask(&mut self, device: &wgpu::Device, needs: &[Asked], urgency: Urgency, waker: &Waker) {
        self.queue(needs, urgency, waker);
        let _ = device;
        #[cfg(not(all(feature = "web", target_arch = "wasm32")))]
        self.pump(device);
    }

    /// Queues each of `needs` at `urgency` like [`ask`](Pipelines::ask), without starting any. The
    /// next request, finished compile, or [`pump`](Pipelines::pump) starts them.
    pub(crate) fn queue(&mut self, needs: &[Asked], urgency: Urgency, waker: &Waker) {
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
            self.queue.push((urgency, need.clone()));
        }
        // Largest first, so the last one finishes soonest.
        crate::order::by_key(&mut self.queue, |(urgency, need)| {
            crate::order::pair(*urgency as u32, !(need.size().min(u32::MAX as usize) as u32))
        });
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        self.schedule();
    }

    /// A single task advances the queue independently of animation frames and explicit stepping.
    /// It holds only a weak device reference between tasks and stops as soon as the queue empties.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    fn schedule(&mut self) {
        if self.scheduled || self.queue.is_empty() {
            return;
        }
        self.scheduled = true;
        let weak = self.gpu.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let (mut held, mut settling) = (false, None);
            loop {
                if let Some(urgency) = settling {
                    // The frames drawn with the pipelines that just finished reach the GPU, and the
                    // GPU finishes them, before less urgent compiles start.
                    crate::time::sleep(SETTLE).await;
                    let Some(shared) = weak.upgrade() else { return };
                    let (finished, done) = crate::Pending::new();
                    crate::Gpu(shared).queue().on_submitted_work_done(move || done.resolve(Ok(())));
                    let _ = finished.await;
                    let Some(shared) = weak.upgrade() else { return };
                    crate::Gpu(shared).0.lock().pipelines.opened = urgency;
                } else if held {
                    // More urgent compiles take milliseconds, not a task.
                    crate::time::sleep(std::time::Duration::from_millis(4)).await;
                } else {
                    crate::time::next_task().await;
                }
                let Some(shared) = weak.upgrade() else {
                    return;
                };
                let gpu = crate::Gpu(shared);
                let mut inner = gpu.0.lock();
                if !gpu.lost() {
                    held = inner.pipelines.pump(gpu.device());
                    settling = inner.pipelines.settling.take();
                }
                if gpu.lost() || inner.pipelines.queue.is_empty() {
                    inner.pipelines.scheduled = false;
                    return;
                }
            }
        });
    }

    /// Compile requested pipelines in priority order. Browser work yields between pipelines;
    /// each pipeline is cached once and becomes ready only after creation succeeds. In a browser, a
    /// pipeline waits while more urgent ones still compile, so they have the browser's compile
    /// threads to themselves. Once those finish, the GPU first finishes the frames drawn with them
    /// (see [`SETTLE`]). Returns whether a pipeline waits.
    fn pump(&mut self, device: &wgpu::Device) -> bool {
        let started = web_time::Instant::now();
        #[cfg(all(feature = "web", target_arch = "wasm32"))]
        self.started.retain(|(_, ahead)| !ahead.landed());
        while let Some(&(urgency, _)) = self.queue.first() {
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            {
                if self.started.iter().any(|&(before, _)| before < urgency) {
                    return true;
                }
                if urgency > self.opened {
                    self.settling = Some(urgency);
                    return true;
                }
            }
            let (_, need) = self.queue.remove(0);
            let ahead = self.asked[&need].clone();
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            {
                self.started.push((urgency, ahead.clone()));
                let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
                self.create(device, &need);
                let checked = scope.pop();
                let landed = self.landed.clone();
                let refusals = self.refusals.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    if let Some(error) = checked.await {
                        if ahead.refused.set(error.to_string()).is_ok() {
                            refusals.fetch_add(1, Ordering::AcqRel);
                        }
                    } else {
                        ahead.compiled.store(true, Ordering::Release);
                    }
                    ahead.land(&landed);
                });
            }
            #[cfg(not(all(feature = "web", target_arch = "wasm32")))]
            {
                let _ = urgency;
                ahead.land(&self.landed);
            }
            if cfg!(target_arch = "wasm32") && started.elapsed().as_millis() >= 4 {
                break;
            }
        }
        let _ = device;
        false
    }

    /// Whether every one of `needs` was requested and has finished compiling, so pipelines using
    /// them can be created without a compile.
    pub(crate) fn ready(&self, needs: &[Asked]) -> bool {
        needs.iter().all(|need| self.asked.get(need).is_some_and(|ahead| ahead.landed()))
    }

    /// Holds `need` back as if still compiling, until [`release`](Pipelines::release). Natively
    /// every pipeline lands when asked for, so tests hold one to see what waits for it.
    #[cfg(test)]
    pub(crate) fn hold(&self, need: &Asked) {
        self.asked[need].landed.store(false, Ordering::Release);
    }

    /// Lands `need`, held back by [`hold`](Pipelines::hold).
    #[cfg(test)]
    pub(crate) fn release(&self, need: &Asked) {
        self.asked[need].land(&self.landed);
    }

    /// Refuses `need` with `message`, as a browser does with a pipeline it can't build.
    #[cfg(test)]
    pub(crate) fn refuse(&self, need: &Asked, message: &str) {
        if self.asked[need].refused.set(message.to_owned()).is_ok() {
            self.refusals.fetch_add(1, Ordering::AcqRel);
        }
    }

    /// Whether the browser refused to build any pipeline requested so far.
    pub(crate) fn refusing(&self) -> bool {
        self.refusals.load(Ordering::Acquire) > 0
    }

    /// The error of the first of latkit's own `needs` the browser refused to build, whenever it
    /// refused, if it refused any. A custom marker it refused is its mark's failure instead.
    pub(crate) fn refused(&self, needs: &[Asked]) -> Option<Error> {
        needs.iter().filter(|need| matches!(need, Asked::Shader(_) | Asked::Kernel(..))).find_map(|need| {
            let message = self.asked.get(need)?.refused()?;
            Some(Error::Unsupported(format!("the browser can't build the pipeline {}: {message}", need.label()).into()))
        })
    }

    /// How many requested compiles have finished so far. Anything waiting on a compile sees this
    /// change.
    pub(crate) fn landed(&self) -> u64 {
        self.landed.load(Ordering::Acquire)
    }

    /// Requested compiles still in progress or queued.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn compiling(&self) -> u64 {
        self.asked.values().filter(|ahead| !ahead.landed()).count() as u64
    }

    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    fn create(&mut self, device: &wgpu::Device, need: &Asked) {
        match need {
            Asked::Shader(variant) => {
                self.render(device, *variant);
            }
            Asked::Custom(source, variant) => {
                self.custom(device, source, *variant);
            }
            Asked::Kernel(source, variant) => {
                self.kernel(device, source, *variant);
            }
        }
    }

    /// Counts a pipeline created for `need`: as compiled now unless it compiled ahead, and as late
    /// if it was never requested. One created before its compile ahead finished compiles now, so
    /// what that compile makes is dropped when it finishes, rather than kept.
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

    /// Parse each specialization once, then share its individual stages across pipeline targets
    /// and depth modes. Application markers and expression kernels follow the same path.
    fn program(&mut self, device: &wgpu::Device, variant: Variant, appended: Option<&Arc<str>>) -> Program {
        let specialized = variant.specialized();
        let modules = match appended {
            Some(source) => self
                .application_modules
                .entry((source.clone(), specialized))
                .or_insert_with(|| Modules::new(specialized.wgsl(source))),
            None => self.modules.entry(specialized).or_insert_with(|| Modules::new(specialized.wgsl(""))),
        };
        let label = specialized.shader.source().label;
        Program {
            vertex: modules.entry(device, label, "vertex"),
            fragment: modules.entry(device, label, variant.fragment()),
        }
    }

    /// A program-specific raster pipeline. Values remain in resources, so only a change to
    /// expression structure creates another kernel. Entry points share the parsed source.
    pub(crate) fn kernel(
        &mut self,
        device: &wgpu::Device,
        source: &Arc<str>,
        variant: Variant,
    ) -> wgpu::RenderPipeline {
        let key = (source.clone(), variant);
        if let Some(pipeline) = self.kernels.get(&key) {
            return pipeline.clone();
        }
        let need = Asked::Kernel(source.clone(), variant);
        self.count(&need);
        let module = self.program(device, variant, Some(source));
        let pipeline = self.pipeline(device, variant, &module, &need.label());
        self.kernels.insert(key, pipeline.clone());
        pipeline
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
    /// its shader. `None` once that WGSL failed to compile, which
    /// [`custom_failure`](Pipelines::custom_failure) then tells. Natively the device answers at
    /// once, and in a browser the compile ahead of use does, so a broken marker never draws.
    pub(crate) fn custom(
        &mut self,
        device: &wgpu::Device,
        source: &Arc<str>,
        variant: Variant,
    ) -> Option<wgpu::RenderPipeline> {
        let key = (source.clone(), variant);
        if let Some(custom) = self.custom.get(&key) {
            return custom.pipeline.clone().filter(|_| custom.failed.is_none());
        }
        let need = Asked::Custom(key.0.clone(), key.1);
        let label = need.label();
        if let Some(message) = self.asked.get(&need).and_then(|ahead| ahead.refused()) {
            let failed = Some(failure(message));
            self.custom.insert(key, Custom { pipeline: None, check: None, failed });
            return None;
        }
        self.count(&need);
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = self.program(device, variant, Some(source));
        let pipeline = self.pipeline(device, variant, &module, &label);
        let mut check: Check = Box::pin(scope.pop());
        let mut custom = Custom { pipeline: Some(pipeline), check: None, failed: None };
        match check.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(error) => custom.failed = error.map(|error| failure(&error.to_string())),
            Poll::Pending => custom.check = Some(check),
        }
        let drawn = custom.pipeline.clone().filter(|_| custom.failed.is_none());
        self.custom.insert(key, custom);
        drawn
    }

    /// Hears the checks of custom markers' WGSL still waiting for the device's answer.
    pub(crate) fn check_custom(&mut self) {
        let mut context = Context::from_waker(Waker::noop());
        for custom in self.custom.values_mut() {
            let Some(check) = &mut custom.check else { continue };
            if let Poll::Ready(error) = check.as_mut().poll(&mut context) {
                custom.check = None;
                custom.failed = error.map(|error| failure(&error.to_string()));
            }
        }
    }

    /// Why the custom marker of `source` does not compile, if it does not.
    pub(crate) fn custom_failure(&self, source: &Arc<str>) -> Option<&Error> {
        self.custom.iter().filter(|((of, _), _)| of == source).find_map(|(_, custom)| custom.failed.as_ref())
    }

    /// The render pipeline `variant` names.
    pub(crate) fn render(&mut self, device: &wgpu::Device, variant: Variant) -> wgpu::RenderPipeline {
        if let Some(pipeline) = self.render.get(&variant) {
            return pipeline.clone();
        }
        let need = Asked::Shader(variant);
        self.count(&need);
        let module = self.program(device, variant, None);
        let pipeline = self.pipeline(device, variant, &module, &need.label());
        self.render.insert(variant, pipeline.clone());
        pipeline
    }

    fn pipeline(
        &mut self,
        device: &wgpu::Device,
        variant: Variant,
        module: &Program,
        label: &str,
    ) -> wgpu::RenderPipeline {
        let shader = variant.shader;
        let (format, samples) = variant.target.expect("a render variant");
        let raster = variant.entry != "vertex";
        let layout = self.pipeline_layout(device, shader);
        let targets: Vec<_> = (0..shader.source().targets)
            .map(|_| {
                Some(wgpu::ColorTargetState {
                    format,
                    blend: (!raster).then_some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })
            })
            .collect();
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module.vertex,
                entry_point: Some("vertex"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState {
                topology: if matches!(shader, Shader::OrderScatter | Shader::Requests | Shader::Boxed) {
                    wgpu::PrimitiveTopology::PointList
                } else if raster {
                    wgpu::PrimitiveTopology::TriangleList
                } else {
                    topology(shader)
                },
                ..Default::default()
            },
            depth_stencil: (!raster).then(|| depth(shader, variant.draw)),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module.fragment,
                entry_point: Some(variant.fragment()),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        })
    }
}

struct Program {
    vertex: wgpu::ShaderModule,
    fragment: wgpu::ShaderModule,
}

enum Source {
    Parsed(Box<naga::Module>),
    Invalid(String),
}

/// Every stage follows one validated path. Keep source parsing shared, but remove functions and
/// resources reachable only from other stages before driver translation. Invalid application
/// WGSL still goes through wgpu's ordinary error-scope diagnostics.
struct Modules {
    source: Source,
    entries: HashMap<&'static str, wgpu::ShaderModule>,
}

impl Modules {
    fn new(source: String) -> Self {
        let source = match naga::front::wgsl::parse_str(&source) {
            Ok(module) => Source::Parsed(Box::new(module)),
            Err(_) => Source::Invalid(source),
        };
        Self { source, entries: HashMap::new() }
    }

    fn entry(&mut self, device: &wgpu::Device, label: &str, entry: &'static str) -> wgpu::ShaderModule {
        self.entries
            .entry(entry)
            .or_insert_with(|| {
                let source = match &self.source {
                    Source::Parsed(module) => wgpu::ShaderSource::Naga(std::borrow::Cow::Owned(super::prune::entry(
                        (**module).clone(),
                        entry,
                    ))),
                    Source::Invalid(source) => wgpu::ShaderSource::Wgsl(source.as_str().into()),
                };
                device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source })
            })
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::gpu::shaders::{PATH_GEOMETRY, STROKES};

    #[test]
    fn labels_name_each_pipeline_exactly() {
        let format = wgpu::TextureFormat::Bgra8Unorm;
        let variants = [
            Variant::draw(Shader::Areas, format, 1),
            Variant::draw(Shader::Areas, format, 4),
            Variant::draw(Shader::Areas, wgpu::TextureFormat::Rgba8Unorm, 1),
            Variant::draw(Shader::Backdrop, format, 1),
            Variant::raster(Shader::Probe, "nearest"),
            Variant::raster(Shader::Probe, "describe"),
            Variant::state(Shader::StateNarrow, "evaluate", Reads::ALL),
            Variant::state(Shader::StateNarrow, "evaluate", Reads::NONE),
        ];
        let labels: HashSet<String> = variants.iter().map(|&variant| Asked::Shader(variant).label()).collect();
        assert_eq!(labels.len(), variants.len(), "variants that differ have labels that differ: {labels:?}");
        let custom = |source: &str| Asked::Custom(Arc::from(source), variants[0]).label();
        assert_ne!(custom("a"), custom("b"), "custom markers differ by their WGSL");
        assert!(!labels.contains(&custom("a")), "and from the shader they extend");
    }

    #[test]
    fn modules_declare_their_values_and_pipelines_pass_no_constants() {
        let wgsl = |variant: Variant| variant.specialized().wgsl("");
        let evaluate =
            wgsl(Variant::state(Shader::StateNarrow, "evaluate", Reads { joined: true, timed: false, viewed: true }));
        for declared in ["const JOINED: bool = true;", "const TIMED: bool = false;", "const VIEWED: bool = true;"] {
            assert!(evaluate.contains(declared), "{declared}");
        }
        let probe = wgsl(Variant::probe(Shader::Probe, STROKES));
        assert!(probe.contains(&format!("const PRIMITIVE: u32 = {STROKES}u;")), "{probe}");
        let strokes = Variant::draw(Shader::Strokes, wgpu::TextureFormat::Rgba8Unorm, 1);
        for text in [&evaluate, &probe, &wgsl(strokes.path(PATH_GEOMETRY))] {
            assert!(!text.contains("override "), "a module declares no pipeline constants");
        }
        // Pipelines of one shader and values share a module, whatever their entry points or targets.
        let samples = Variant::draw(Shader::Strokes, wgpu::TextureFormat::Rgba8Unorm, 4);
        assert_eq!(strokes.specialized(), samples.specialized());
        assert_ne!(strokes.specialized(), strokes.path(PATH_GEOMETRY).specialized());
    }

    #[test]
    fn geometry_free_entries_share_one_pipeline_across_mark_kinds_and_projections() {
        let finish = Variant::probe(Shader::Probe, super::super::shaders::POINTS).entry("finish");
        let edge = Variant::probe(Shader::Probe, STROKES).path(PATH_GEOMETRY).projection(Projection::Globe);
        assert_eq!(finish, edge.entry("finish"));
        assert_eq!(finish, finish.primitive(STROKES).path(PATH_GEOMETRY).projection(Projection::Mercator));
        assert_ne!(edge, edge.projection(Projection::Planar), "geometry entries retain their actual projection");
    }
}
