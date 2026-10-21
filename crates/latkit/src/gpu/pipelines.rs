//! Pipelines, kept by [`Variant`]. A view asks for every pipeline its scene can use the first time
//! it draws into a target, and a shot for what it composes with, all at once ([`Pipelines::ask`]):
//! in a browser each then compiles off the GPU's thread, side by side with the rest, and what uses it
//! waits until it landed, so no frame waits on a compile. Making it afterwards finds it compiled.
//! Natively a pipeline is made in process where first used, which costs as little. Every pipeline
//! shares the view and mark group layouts; each shader's pass group comes from its WGSL.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Waker};

use super::shaders::{Binding, MARK_GROUP, PATH_ENDS, Shader, VIEW_GROUP};
use super::work::{Count, Counters};
use crate::Error;
use crate::view::DEPTH;

/// A check of a custom marker's shader, resolving to its error if it has one: sent between threads
/// natively, kept on the page's one thread in browsers.
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

/// One pipeline: a shader's entry point made for one primitive's geometry (its `PROBED`) and one
/// kind of path (its `PATH`), and for a render shader, the format and samples per pixel it draws into.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Variant {
    shader: Shader,
    entry: &'static str,
    primitive: u32,
    path: u32,
    target: Option<(wgpu::TextureFormat, u32)>,
}

impl Variant {
    /// `shader` drawing into `format` with `samples` per pixel.
    pub(crate) fn draw(shader: Shader, format: wgpu::TextureFormat, samples: u32) -> Variant {
        Variant { shader, entry: "vertex", primitive: 0, path: PATH_ENDS, target: Some((format, samples)) }
    }

    /// `shader`'s compute entry point `entry`.
    pub(crate) fn compute(shader: Shader, entry: &'static str) -> Variant {
        Variant { shader, entry, primitive: 0, path: PATH_ENDS, target: None }
    }

    /// The probe program made for marks of `primitive` (a `POINTS`, `STROKES`, or `TRIANGLES` code),
    /// which answers every question a step at a time.
    pub(crate) fn probe(shader: Shader, primitive: u32) -> Variant {
        Variant { shader, entry: "answer", primitive, path: PATH_ENDS, target: None }
    }

    /// The variant whose strokes read `path`, one of the `PATH_` codes.
    #[must_use]
    pub(crate) fn path(mut self, path: u32) -> Variant {
        self.path = path;
        self
    }

    /// The pipeline constants its shader declares, set.
    fn constants(&self) -> Vec<(&'static str, f64)> {
        let value = |name: &str| match name {
            "PROBED" => self.primitive,
            "PATH" => self.path,
            other => unreachable!("no value for the pipeline constant {other}"),
        };
        self.shader.source().overrides.iter().map(|&name| (name, f64::from(value(name)))).collect()
    }
}

/// A pipeline asked for ahead: a variant of one of latkit's shaders, or of a custom marker's, whose
/// WGSL follows its shader's.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Asked {
    Shader(Variant),
    Custom(Arc<str>, Variant),
}

impl Asked {
    /// Bytes of WGSL it compiles from: the more, the longer it takes.
    pub(crate) fn size(&self) -> usize {
        match self {
            Asked::Shader(variant) => variant.shader.source().size(),
            Asked::Custom(source, variant) => variant.shader.source().size() + source.len(),
        }
    }
}

/// A pipeline asked for ahead: whether it compiled then, off the GPU's thread, whether that landed,
/// and what waits for it to.
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

    /// Waits for it: `waker` wakes as it lands.
    fn wait(&self, waker: &Waker) {
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner).push(waker.clone());
    }

    /// Lands it, counted by `landed`, and wakes what waits.
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
    /// What a shader reading neither shared group binds in their place.
    pub(crate) empty: wgpu::BindGroup,
    empty_layout: wgpu::BindGroupLayout,
    pass_layouts: HashMap<Vec<wgpu::BindGroupLayoutEntry>, wgpu::BindGroupLayout>,
    modules: HashMap<Shader, wgpu::ShaderModule>,
    render: HashMap<Variant, wgpu::RenderPipeline>,
    compute: HashMap<Variant, wgpu::ComputePipeline>,
    custom: HashMap<(Arc<str>, Variant), Custom>,
    /// What views and shots asked for ahead, each with its compile.
    asked: HashMap<Asked, Arc<Ahead>>,
    /// How many compiles asked for ahead landed, and in a browser how many are under way.
    landed: Arc<AtomicU64>,
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    compiling: Arc<AtomicU64>,
    /// What counts the pipelines compiled.
    counters: Arc<Counters>,
}

/// Shaders that draw into the shadow map, custom markers' included.
const CASTERS: [Shader; 5] =
    [Shader::PointsCast, Shader::StrokesCast, Shader::TrianglesCast, Shader::Shade, Shader::PointsCustomCast];
/// The probe a frame of `samples` per pixel reads its depth with.
pub(crate) fn probe(samples: u32) -> Shader {
    if samples > 1 { Shader::ProbeMultisampled } else { Shader::Probe }
}

/// How a render shader's vertices assemble.
fn topology(shader: Shader) -> wgpu::PrimitiveTopology {
    // Custom markers draw as points do.
    match shader {
        Shader::Backdrop | Shader::Triangles | Shader::TrianglesCast | Shader::Shade => {
            wgpu::PrimitiveTopology::TriangleList
        }
        _ => wgpu::PrimitiveTopology::TriangleStrip,
    }
}

/// Whether a shader draws into the shadow map, which has no depth.
fn casts(shader: Shader) -> bool {
    CASTERS.contains(&shader)
}

/// How a render shader meets depth, which is reversed: the backdrop writes the globe's, triangles
/// write theirs, the overlay and labels ignore it, and every other mark draws where nothing nearer
/// was drawn.
fn depth(shader: Shader) -> Option<wgpu::DepthStencilState> {
    if casts(shader) {
        return None;
    }
    let compare = match shader {
        Shader::Backdrop | Shader::Overlay | Shader::Glyphs => wgpu::CompareFunction::Always,
        _ => wgpu::CompareFunction::GreaterEqual,
    };
    Some(wgpu::DepthStencilState {
        format: DEPTH,
        depth_write_enabled: Some(matches!(shader, Shader::Triangles | Shader::Backdrop)),
        depth_compare: Some(compare),
        stencil: wgpu::StencilState::default(),
        bias: wgpu::DepthBiasState::default(),
    })
}

/// How a shader's fragments blend: premultiplied over what is drawn; casters keep the least of each
/// channel; map levels replace.
fn blend(shader: Shader) -> Option<wgpu::BlendState> {
    let component = |src, dst, operation| wgpu::BlendComponent { src_factor: src, dst_factor: dst, operation };
    match shader {
        Shader::Shade => None,
        Shader::PointsCast | Shader::StrokesCast | Shader::TrianglesCast | Shader::PointsCustomCast => {
            let least = component(wgpu::BlendFactor::One, wgpu::BlendFactor::One, wgpu::BlendOperation::Min);
            Some(wgpu::BlendState { color: least, alpha: least })
        }
        _ => {
            let over =
                component(wgpu::BlendFactor::One, wgpu::BlendFactor::OneMinusSrcAlpha, wgpu::BlendOperation::Add);
            Some(wgpu::BlendState { color: over, alpha: over })
        }
    }
}

fn layout(device: &wgpu::Device, label: &str, bindings: &[Binding]) -> wgpu::BindGroupLayout {
    let entries: Vec<_> = bindings.iter().map(Binding::layout_entry).collect();
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries: &entries })
}

impl Pipelines {
    pub(crate) fn new(device: &wgpu::Device, counters: Arc<Counters>) -> Pipelines {
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
            landed: Arc::default(),
            #[cfg(all(feature = "web", target_arch = "wasm32"))]
            compiling: Arc::default(),
            counters,
        }
    }

    /// Asks for each of `needs` not yet asked for: in a browser it compiles now, off the GPU's thread
    /// and side by side with the rest, and `waker` wakes as each lands. A view asks for everything its
    /// scene can use at once, so nothing it does later compiles where it is used.
    pub(crate) fn ask(&mut self, device: &wgpu::Device, needs: &[Asked], waker: &Waker) {
        for need in needs {
            if let Some(ahead) = self.asked.get(need) {
                if !ahead.landed() {
                    ahead.wait(waker);
                }
                continue;
            }
            let ahead = Arc::new(Ahead::default());
            self.asked.insert(need.clone(), ahead.clone());
            if !self.compile_ahead(device, need, &ahead, waker) {
                ahead.land(&self.landed);
            }
        }
    }

    /// Makes the shader modules `needs` compile from, ahead of asking for them: a browser reads a
    /// module's WGSL on its GPU thread as it is made, so what a view asks for later is read before
    /// it draws anything.
    pub(crate) fn read(&mut self, device: &wgpu::Device, needs: &[Asked]) {
        for need in needs {
            if let Asked::Shader(variant) = need {
                self.module(device, variant.shader);
            }
        }
    }

    /// Whether every one of `needs`, asked for, has landed: what uses them can be made without a
    /// compile.
    pub(crate) fn ready(&self, needs: &[Asked]) -> bool {
        needs.iter().all(|need| self.asked.get(need).is_some_and(|ahead| ahead.landed()))
    }

    /// How many compiles asked for ahead have landed so far: what waits on one sees it change.
    pub(crate) fn landed(&self) -> u64 {
        self.landed.load(Ordering::Acquire)
    }

    /// Compiles asked for ahead still under way.
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn compiling(&self) -> u64 {
        self.compiling.load(Ordering::Acquire)
    }

    /// Starts compiling `need` off the GPU's thread, where a browser can, with `waker` waiting for it:
    /// whether it did.
    #[cfg_attr(
        not(all(target_arch = "wasm32", feature = "web")),
        expect(clippy::unused_self, reason = "only a browser's device compiles ahead")
    )]
    fn compile_ahead(&mut self, device: &wgpu::Device, need: &Asked, ahead: &Arc<Ahead>, waker: &Waker) -> bool {
        #[cfg(all(target_arch = "wasm32", feature = "web"))]
        {
            let Some(promise) = compiled::capture(device, || self.create(device, need)) else { return false };
            self.counters.add(Count::Pipelines, 1);
            ahead.compiled.store(true, Ordering::Release);
            ahead.wait(waker);
            let (ahead, landed, compiling) = (ahead.clone(), self.landed.clone(), self.compiling.clone());
            compiling.fetch_add(1, Ordering::AcqRel);
            wasm_bindgen_futures::spawn_local(async move {
                // A descriptor the browser refuses lands too: making it then tells why, as it did.
                let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
                compiling.fetch_sub(1, Ordering::AcqRel);
                ahead.land(&landed);
            });
            true
        }
        #[cfg(not(all(target_arch = "wasm32", feature = "web")))]
        {
            let _ = (device, need, ahead, waker);
            false
        }
    }

    /// Makes `need` through wgpu, neither kept nor counted: what compiling it ahead captures. A
    /// custom marker's WGSL fails in its own scope, so only making it for real tells why.
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

    /// Counts a pipeline made for `need`: compiled now unless it compiled when asked for, and late
    /// unless it was asked for at all.
    fn count(&self, need: &Asked) {
        let ahead = self.asked.get(need);
        if !ahead.is_some_and(|ahead| ahead.compiled.load(Ordering::Acquire)) {
            self.counters.add(Count::Pipelines, 1);
        }
        if ahead.is_none() {
            self.counters.add(Count::Late, 1);
        }
    }

    /// The layout of `shader`'s pass group; shaders with the same bindings share one.
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

    /// The layout of `shader`'s pipelines: the view and mark groups, empty where it reads neither, then
    /// its pass group.
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

    /// The pipeline drawing a custom marker of `source` with `shader` (one of the custom variants),
    /// or `None` once its WGSL failed to compile.
    pub(crate) fn custom(
        &mut self,
        device: &wgpu::Device,
        source: &str,
        shader: Shader,
        format: wgpu::TextureFormat,
        samples: u32,
    ) -> Option<wgpu::RenderPipeline> {
        let key = (Arc::<str>::from(source), Variant::draw(shader, format, samples));
        if let Some(custom) = self.custom.get(&key) {
            return (!custom.failed).then(|| custom.pipeline.clone());
        }
        self.count(&Asked::Custom(key.0.clone(), key.1));
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = custom_module(device, source, shader);
        let pipeline = self.pipeline(device, key.1, &module);
        let check: Check = Box::pin(scope.pop());
        let custom = Custom { pipeline: pipeline.clone(), check: Some(check), failed: false };
        self.custom.insert(key, custom);
        Some(pipeline)
    }

    /// Errors custom markers' shaders turned out to have since last asked.
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

    /// The pipeline drawing `shader` into `format` with `samples` per pixel.
    pub(crate) fn render(
        &mut self,
        device: &wgpu::Device,
        shader: Shader,
        format: wgpu::TextureFormat,
        samples: u32,
    ) -> wgpu::RenderPipeline {
        self.render_pipeline(device, Variant::draw(shader, format, samples))
    }

    /// The render pipeline `variant` names.
    pub(crate) fn render_pipeline(&mut self, device: &wgpu::Device, variant: Variant) -> wgpu::RenderPipeline {
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
            depth_stencil: depth(shader),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fragment"),
                compilation_options: options(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: blend(shader),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// The compute pipeline of `shader`'s entry point `entry`.
    pub(crate) fn compute(
        &mut self,
        device: &wgpu::Device,
        shader: Shader,
        entry: &'static str,
    ) -> wgpu::ComputePipeline {
        self.compute_pipeline(device, Variant::compute(shader, entry))
    }

    /// The compute pipeline `variant` names.
    pub(crate) fn compute_pipeline(&mut self, device: &wgpu::Device, variant: Variant) -> wgpu::ComputePipeline {
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

/// The module of a custom marker of `source` drawn with `shader`: its shader's WGSL, then the marker's.
fn custom_module(device: &wgpu::Device, source: &str, shader: Shader) -> wgpu::ShaderModule {
    device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("latkit custom marker"),
        source: wgpu::ShaderSource::Wgsl(format!("{}\n{source}", shader.source().wgsl()).into()),
    })
}

/// Compiling ahead in a browser. A browser compiles a pipeline made through `createRenderPipeline`
/// on the GPU's thread, holding back every frame and readback behind it, but one made through its
/// async twin on worker threads, side by side with others; Chrome keeps what it compiled by
/// descriptor, so making the same descriptor later finds it compiled.
#[cfg(all(target_arch = "wasm32", feature = "web"))]
mod compiled {
    use std::cell::RefCell;
    use std::rc::Rc;

    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::{JsCast, JsValue};

    /// The device's pipeline makers, each with its async twin.
    const MAKERS: [(&str, &str); 2] = [
        ("createRenderPipeline", "createRenderPipelineAsync"),
        ("createComputePipeline", "createComputePipelineAsync"),
    ];

    /// The browser compiling, off its GPU's thread, the pipeline `make` makes through wgpu: while it
    /// runs, the device's makers are their async twins, handed the very descriptor wgpu builds, so
    /// what compiles is what wgpu makes later, by construction. `None` where the device is no
    /// browser's, or `make` made nothing.
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
