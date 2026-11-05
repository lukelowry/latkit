//! Pipelines, cached by [`Variant`].
//!
//! Every pipeline compiles through one queue per GPU ([`Pipelines::ask`]), most urgent first: draw
//! pipelines, then text pipelines, then the pipelines that changes, lit rows, and input need. Last
//! come pipelines warmed for future views, once the queue would otherwise sit idle.
//!
//! In a browser, compiles run in the background and in parallel. Draw pipelines start at once,
//! text pipelines as the browser's compile workers free up, and the rest a few at a time. Anything
//! that uses a pipeline waits until its compile finishes. So no frame waits on a compile, and
//! creating the pipeline afterwards takes the one compiled. Natively, a pipeline is created in
//! process when first used, which is just as cheap. Every pipeline shares the view and mark group
//! layouts. Each shader's pass group layout comes from its WGSL. Every pipeline's label names it
//! exactly.
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
        self.shader.source().reads(name)
    }

    /// What its shader module is specialized for.
    fn specialized(&self) -> Specialized {
        Specialized { shader: self.shader, primitive: self.primitive, path: self.path, reads: self.reads }
    }

    /// A label naming exactly this pipeline. Browsers show it in their errors, and it finds the
    /// pipeline compiled ahead for it.
    fn label(&self) -> String {
        let Reads { joined, timed, viewed } = self.reads;
        let target = self.target.map(|(format, samples)| format!(" {format:?}x{samples}")).unwrap_or_default();
        format!(
            "latkit {:?} {} PRIMITIVE={} PATH={} JOINED={} TIMED={} VIEWED={}{target}",
            self.shader,
            self.entry,
            self.primitive,
            self.path,
            u8::from(joined),
            u8::from(timed),
            u8::from(viewed),
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
            other => unreachable!("no value for the constant {other}"),
        }
    }

    /// The module's WGSL, with `appended` after the shader's own.
    fn wgsl(&self, appended: &str) -> String {
        let mut wgsl = self.shader.source().wgsl(|name| self.value(name));
        if !appended.is_empty() {
            wgsl.push('\n');
            wgsl.push_str(appended);
        }
        wgsl
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

    /// A label naming exactly this pipeline: its variant's, and for a custom marker, a stamp of its
    /// WGSL.
    pub(crate) fn label(&self) -> String {
        match self {
            Asked::Shader(variant) => variant.label(),
            Asked::Custom(source, variant) => {
                format!("{} custom {:016x}", variant.label(), crate::derive::stamp_of(source))
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
    modules: HashMap<Specialized, wgpu::ShaderModule>,
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
    /// How many compiles the browser refused.
    refusals: Arc<AtomicU64>,
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
    /// The device's pipeline creation methods, replaced to compile in the background and keep what
    /// compiled. `None` for a device that is not a browser's.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    compiled: Option<compiled::Compiled>,
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

/// Whether `shader` draws the opaque pixels of points or strokes, which where depth varies draw
/// before any pixel blends.
fn opaque(shader: Shader) -> bool {
    matches!(shader, Shader::PointsOpaque | Shader::PointsCustomOpaque | Shader::StrokesOpaque)
}

/// A render shader's depth state, with reversed depth. The backdrop writes the globe's depth, faces
/// theirs, and the opaque variants that of the opaque pixels of points and strokes. The rows of
/// points, strokes, and areas draw only in front of what is drawn, so where depth varies they skip
/// the pixels the opaque variants drew, their own included. Lit rows draw where nothing nearer was
/// drawn, and the overlay and glyphs ignore depth.
fn depth(shader: Shader) -> wgpu::DepthStencilState {
    let compare = match shader {
        Shader::Backdrop | Shader::Overlay | Shader::Glyphs => wgpu::CompareFunction::Always,
        Shader::Points | Shader::PointsCustom | Shader::Strokes | Shader::Areas => wgpu::CompareFunction::Greater,
        _ => wgpu::CompareFunction::GreaterEqual,
    };
    wgpu::DepthStencilState {
        format: DEPTH,
        depth_write_enabled: Some(matches!(shader, Shader::Triangles | Shader::Backdrop) || opaque(shader)),
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
            refusals: Arc::default(),
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            compiling: Arc::default(),
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            drawing: Arc::default(),
            drew: false,
            warming: false,
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            warmed: false,
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            compiled: compiled::Compiled::install(device),
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
                self.module(device, variant.specialized());
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
        needs.iter().filter(|need| matches!(need, Asked::Shader(_))).find_map(|need| {
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
            let Some(compiled) = self.compiled.take() else { return false };
            let started = compiled.start(|| self.create(device, need));
            let (kept, created) = (compiled.kept.clone(), compiled.created.clone());
            self.compiled = Some(compiled);
            let Some(promise) = started else { return false };
            let label = need.label();
            self.counters.add(Count::Pipelines, 1);
            ahead.compiled.store(true, Ordering::Release);
            let (ahead, landed, compiling) = (ahead.clone(), self.landed.clone(), self.compiling.clone());
            let refusals = self.refusals.clone();
            let drawing = draws.then(|| self.drawing.clone());
            let gpu = self.gpu.clone();
            compiling.fetch_add(1, Ordering::AcqRel);
            if let Some(drawing) = &drawing {
                drawing.fetch_add(1, Ordering::AcqRel);
            }
            wasm_bindgen_futures::spawn_local(async move {
                // The compiled pipeline is kept, so creating it later takes it. Why the browser
                // refused to build one is kept instead, so nothing creates it: a view that needs
                // one of latkit's own reports the error, and a custom marker is its mark's failure.
                let compiled = wasm_bindgen_futures::JsFuture::from(promise).await;
                // A pipeline created meanwhile compiled then, so nothing is left to take this one.
                let taken = created.borrow_mut().remove(&label);
                match compiled {
                    Ok(pipeline) if !taken => drop(kept.borrow_mut().insert(label, pipeline)),
                    Err(error) => {
                        if ahead.refused.set(compiled::message(&error)).is_ok() {
                            refusals.fetch_add(1, Ordering::AcqRel);
                        }
                    }
                    Ok(_) => {}
                }
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

    /// Creates `need` through wgpu without caching or counting it, for compiling ahead to start. A
    /// custom marker's WGSL errors are caught in a scope of their own here, so only the compile, or
    /// creating it for real, reports why it fails.
    #[cfg(all(target_arch = "wasm32", feature = "web"))]
    fn create(&mut self, device: &wgpu::Device, need: &Asked) {
        let label = need.label();
        match need {
            Asked::Shader(variant) if variant.target.is_some() => {
                let module = self.module(device, variant.specialized());
                drop(self.pipeline(device, *variant, &module, &label));
            }
            Asked::Shader(variant) => drop(self.compute_made(device, *variant, &label)),
            Asked::Custom(source, variant) => {
                let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
                let module = custom_module(device, source, *variant);
                drop(self.pipeline(device, *variant, &module, &label));
                drop(scope.pop());
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
        #[cfg(all(target_arch = "wasm32", feature = "web"))]
        if let Some(compiled) = &self.compiled
            && ahead.is_some_and(|ahead| ahead.compiled.load(Ordering::Acquire) && !ahead.landed())
        {
            compiled.created.borrow_mut().insert(need.label());
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

    fn module(&mut self, device: &wgpu::Device, specialized: Specialized) -> wgpu::ShaderModule {
        self.modules
            .entry(specialized)
            .or_insert_with(|| {
                device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some(specialized.shader.source().label),
                    source: wgpu::ShaderSource::Wgsl(specialized.wgsl("").into()),
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
        let module = custom_module(device, source, variant);
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
        let module = self.module(device, variant.specialized());
        let pipeline = self.pipeline(device, variant, &module, &need.label());
        self.render.insert(variant, pipeline.clone());
        pipeline
    }

    fn pipeline(
        &mut self,
        device: &wgpu::Device,
        variant: Variant,
        module: &wgpu::ShaderModule,
        label: &str,
    ) -> wgpu::RenderPipeline {
        let shader = variant.shader;
        let (format, samples) = variant.target.expect("a render variant");
        let layout = self.pipeline_layout(device, shader);
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vertex"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState { topology: topology(shader), ..Default::default() },
            depth_stencil: Some(depth(shader)),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fragment"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
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
        let need = Asked::Shader(variant);
        self.count(&need);
        let pipeline = self.compute_made(device, variant, &need.label());
        self.compute.insert(variant, pipeline.clone());
        pipeline
    }

    fn compute_made(&mut self, device: &wgpu::Device, variant: Variant, label: &str) -> wgpu::ComputePipeline {
        let module = self.module(device, variant.specialized());
        let layout = self.pipeline_layout(device, variant.shader);
        device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(label),
            layout: Some(&layout),
            module: &module,
            entry_point: Some(variant.entry),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        })
    }
}

/// The shader module for a custom marker: `variant`'s WGSL followed by the marker's `source`.
fn custom_module(device: &wgpu::Device, source: &str, variant: Variant) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("latkit custom marker"),
        source: wgpu::ShaderSource::Wgsl(variant.specialized().wgsl(source).into()),
    })
}

/// Compiling ahead in a browser. A pipeline created with `createRenderPipeline` compiles on the
/// GPU's thread, delaying every frame and readback behind it. One created with the async variant
/// compiles on worker threads, in parallel with others. wgpu calls only the first, so the device's
/// two creation methods are replaced once with ones that pass each call through, except in two
/// cases. While compiling ahead, they start the async variant, which receives the exact descriptor
/// wgpu builds. And a call for a pipeline compiled ahead returns that pipeline instead of compiling
/// again, matched by its label, which names it exactly. So the pipeline drawn with is the one
/// compiled ahead, in every browser.
#[cfg(all(target_arch = "wasm32", feature = "web"))]
mod compiled {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::rc::Rc;

    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::{JsCast, JsValue};

    /// The device's pipeline creation methods, each with its async variant.
    const MAKERS: [(&str, &str); 2] = [
        ("createRenderPipeline", "createRenderPipelineAsync"),
        ("createComputePipeline", "createComputePipelineAsync"),
    ];

    pub(super) struct Compiled {
        device: JsValue,
        /// Whether a pipeline created now compiles ahead, in the background.
        ahead: Rc<Cell<bool>>,
        /// The compile that the last pipeline created ahead started.
        started: Rc<RefCell<Option<js_sys::Promise>>>,
        /// Pipelines compiled ahead and not created yet, by label.
        pub(super) kept: Rc<RefCell<HashMap<String, JsValue>>>,
        /// Labels of pipelines created before their compile ahead finished.
        pub(super) created: Rc<RefCell<std::collections::HashSet<String>>>,
        shims: Vec<Closure<dyn FnMut(JsValue) -> JsValue>>,
    }

    impl Compiled {
        /// Replaces `device`'s pipeline creation methods. `None` if it is not a browser's device.
        pub(super) fn install(device: &wgpu::Device) -> Option<Compiled> {
            let raw: &JsValue = device.as_webgpu()?.as_ref();
            let raw = raw.clone();
            let method = |name: &str| -> Option<js_sys::Function> {
                js_sys::Reflect::get(&raw, &JsValue::from_str(name)).ok()?.dyn_into().ok()
            };
            let methods: Vec<(js_sys::Function, js_sys::Function)> =
                MAKERS.iter().map(|(made, twin)| Some((method(made)?, method(twin)?))).collect::<Option<_>>()?;
            let (ahead, started) = (Rc::<Cell<bool>>::default(), Rc::<RefCell<Option<js_sys::Promise>>>::default());
            let kept = Rc::<RefCell<HashMap<String, JsValue>>>::default();
            let shims = methods
                .into_iter()
                .map(|(made, twin)| {
                    let (device, ahead, started, kept) = (raw.clone(), ahead.clone(), started.clone(), kept.clone());
                    Closure::<dyn FnMut(JsValue) -> JsValue>::new(move |descriptor: JsValue| {
                        if ahead.get() {
                            let promise =
                                twin.call1(&device, &descriptor).unwrap_or_else(|e| wasm_bindgen::throw_val(e));
                            *started.borrow_mut() = promise.clone().dyn_into().ok();
                            return promise;
                        }
                        let label = js_sys::Reflect::get(&descriptor, &JsValue::from_str("label")).ok();
                        if let Some(pipeline) =
                            label.and_then(|l| l.as_string()).and_then(|l| kept.borrow_mut().remove(&l))
                        {
                            return pipeline;
                        }
                        made.call1(&device, &descriptor).unwrap_or_else(|e| wasm_bindgen::throw_val(e))
                    })
                })
                .collect();
            let compiled = Compiled { device: raw, ahead, started, kept, created: Rc::default(), shims };
            // Dropping `compiled` puts back any method already replaced.
            for ((made, _), shim) in MAKERS.iter().zip(&compiled.shims) {
                js_sys::Reflect::set(&compiled.device, &JsValue::from_str(made), shim.as_ref()).ok()?;
            }
            Some(compiled)
        }

        /// Starts compiling, in the background, the pipeline that `make` creates through wgpu.
        /// `None` if `make` created nothing.
        pub(super) fn start(&self, make: impl FnOnce()) -> Option<js_sys::Promise> {
            self.ahead.set(true);
            make();
            self.ahead.set(false);
            self.started.take()
        }
    }

    impl Drop for Compiled {
        fn drop(&mut self) {
            // The methods of the device's prototype show through again.
            let device: &js_sys::Object = self.device.unchecked_ref();
            for (made, _) in MAKERS {
                let _ = js_sys::Reflect::delete_property(device, &JsValue::from_str(made));
            }
        }
    }

    /// The message of a compile the browser refused.
    pub(super) fn message(error: &JsValue) -> String {
        js_sys::Reflect::get(error, &JsValue::from_str("message"))
            .ok()
            .and_then(|message| message.as_string())
            .unwrap_or_else(|| format!("{error:?}"))
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
            Variant::draw(Shader::Triangles, format, 1),
            Variant::draw(Shader::Triangles, format, 4),
            Variant::draw(Shader::Triangles, wgpu::TextureFormat::Rgba8Unorm, 1),
            Variant::draw(Shader::Backdrop, format, 1),
            Variant::compute(Shader::Probe, "answer"),
            Variant::compute(Shader::ProbeMultisampled, "answer"),
            Variant::channels(Reads::ALL),
            Variant::channels(Reads::NONE),
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
        let evaluate = wgsl(Variant::channels(Reads { joined: true, timed: false, viewed: true }));
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
}
