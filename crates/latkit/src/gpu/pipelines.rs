//! Pipelines, kept by [`Variant`]: what a scene uses is made on the first frame drawing it, the rest
//! when first used. Every pipeline shares the view and mark group layouts; each shader's pass group
//! comes from its WGSL.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use super::shaders::{Binding, MARK_GROUP, PATH_ENDS, Shader, VIEW_GROUP};
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

    /// A probe's entry point `entry`, made for marks of `primitive` (a `POINTS`, `STROKES`, or
    /// `TRIANGLES` code).
    pub(crate) fn probe(shader: Shader, entry: &'static str, primitive: u32) -> Variant {
        Variant { shader, entry, primitive, path: PATH_ENDS, target: None }
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

pub(crate) struct Pipelines {
    pub(crate) view_layout: wgpu::BindGroupLayout,
    pub(crate) mark_layout: wgpu::BindGroupLayout,
    pass_layouts: HashMap<Vec<wgpu::BindGroupLayoutEntry>, wgpu::BindGroupLayout>,
    modules: HashMap<Shader, wgpu::ShaderModule>,
    render: HashMap<Variant, wgpu::RenderPipeline>,
    compute: HashMap<Variant, wgpu::ComputePipeline>,
    custom: HashMap<(String, Shader, wgpu::TextureFormat, u32), Custom>,
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
    pub(crate) fn new(device: &wgpu::Device) -> Pipelines {
        Pipelines {
            view_layout: layout(device, "latkit view", VIEW_GROUP),
            mark_layout: layout(device, "latkit mark", MARK_GROUP),
            pass_layouts: HashMap::new(),
            modules: HashMap::new(),
            render: HashMap::new(),
            compute: HashMap::new(),
            custom: HashMap::new(),
        }
    }

    /// Makes each of `variants` not yet made.
    pub(crate) fn make(&mut self, device: &wgpu::Device, variants: impl IntoIterator<Item = Variant>) {
        for variant in variants {
            if variant.target.is_some() {
                self.render_pipeline(device, variant);
            } else {
                self.compute_pipeline(device, variant);
            }
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
                    source: wgpu::ShaderSource::Wgsl(source.wgsl.into()),
                })
            })
            .clone()
    }

    fn pipeline_layout(&mut self, device: &wgpu::Device, shader: Shader) -> wgpu::PipelineLayout {
        let pass = (!shader.source().pass.is_empty()).then(|| self.pass_layout(device, shader));
        let mut groups = vec![Some(&self.view_layout), Some(&self.mark_layout)];
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
        let key = (source.to_owned(), shader, format, samples);
        if let Some(custom) = self.custom.get(&key) {
            return (!custom.failed).then(|| custom.pipeline.clone());
        }
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("latkit custom marker"),
            source: wgpu::ShaderSource::Wgsl(format!("{}\n{source}", shader.source().wgsl).into()),
        });
        let pipeline = self.pipeline(device, Variant::draw(shader, format, samples), &module);
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
        let module = self.module(device, variant.shader);
        let layout = self.pipeline_layout(device, variant.shader);
        let constants = variant.constants();
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(variant.entry),
            layout: Some(&layout),
            module: &module,
            entry_point: Some(variant.entry),
            compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
            cache: None,
        });
        self.compute.insert(variant, pipeline.clone());
        pipeline
    }
}
