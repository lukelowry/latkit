//! Pipelines, kept per shader, target format, and sample count, and made ahead of use by
//! [`Gpu::prepare`](crate::Gpu::prepare). Every pipeline shares the view and mark group layouts; each
//! shader's pass group comes from its WGSL.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};

use super::shaders::{Binding, MARK_GROUP, Shader, VIEW_GROUP};
use crate::Error;
use crate::view::{DEPTH, SHADE};

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

pub(crate) struct Pipelines {
    pub(crate) view_layout: wgpu::BindGroupLayout,
    pub(crate) mark_layout: wgpu::BindGroupLayout,
    pass_layouts: HashMap<Vec<wgpu::BindGroupLayoutEntry>, wgpu::BindGroupLayout>,
    modules: HashMap<Shader, wgpu::ShaderModule>,
    render: HashMap<(Shader, wgpu::TextureFormat, u32), wgpu::RenderPipeline>,
    compute: HashMap<(Shader, &'static str, u32), wgpu::ComputePipeline>,
    custom: HashMap<(String, Shader, wgpu::TextureFormat, u32), Custom>,
}

/// Every render shader that draws into a frame's targets.
const FRAME_SHADERS: [Shader; 6] =
    [Shader::Backdrop, Shader::Points, Shader::Strokes, Shader::Triangles, Shader::Glyphs, Shader::Overlay];
/// Every shader that draws into the shadow map.
const MAP_SHADERS: [Shader; 4] = [Shader::PointsCast, Shader::StrokesCast, Shader::TrianglesCast, Shader::Shade];
/// Shaders that draw into the shadow map, custom markers' included.
const CASTERS: [Shader; 5] =
    [Shader::PointsCast, Shader::StrokesCast, Shader::TrianglesCast, Shader::Shade, Shader::PointsCustomCast];
/// The probe a frame of `samples` per pixel reads its depth with.
pub(crate) fn probe(samples: u32) -> Shader {
    if samples > 1 { Shader::ProbeMultisampled } else { Shader::Probe }
}

/// Every compute entry point but the probe's, which are made for each primitive as marks of it are
/// first probed.
const COMPUTE: &[(Shader, &str)] = &[
    (Shader::Evaluate, "evaluate"),
    (Shader::Evaluate, "reduce"),
    (Shader::Freeze, "gather"),
    (Shader::Normals, "accumulate"),
    (Shader::Bounds, "points"),
    (Shader::Bounds, "strokes"),
    (Shader::Lists, "scan_blocks"),
    (Shader::Lists, "scan_sums"),
    (Shader::Lists, "add_sums"),
    (Shader::Stress, "seed"),
    (Shader::Stress, "forward"),
    (Shader::Stress, "backward"),
    (Shader::Stress, "settle"),
    (Shader::Groups, "clear"),
    (Shader::Groups, "bound"),
    (Shader::Lists, "count_segments"),
    (Shader::Lists, "write_segments"),
    (Shader::ListsQuery, "scan_blocks"),
    (Shader::ListsQuery, "scan_sums"),
    (Shader::ListsQuery, "add_sums"),
    (Shader::Labels, "candidates"),
    (Shader::Labels, "clear_cells"),
    (Shader::Labels, "reset_cells"),
    (Shader::Labels, "claim"),
    (Shader::Labels, "decide"),
    (Shader::Labels, "occupy"),
    (Shader::Labels, "fade"),
];

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

/// How a render shader meets depth, which is reversed: triangles write it, the backdrop and overlay
/// ignore it, and every other mark draws where nothing nearer was drawn.
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
        depth_write_enabled: Some(shader == Shader::Triangles),
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

    /// Makes every pipeline a frame into `format` with `samples` per pixel, and the shadow map, use.
    pub(crate) fn prepare(&mut self, device: &wgpu::Device, format: wgpu::TextureFormat, samples: u32) {
        for shader in FRAME_SHADERS {
            self.render(device, shader, format, samples);
        }
        for shader in MAP_SHADERS {
            self.render(device, shader, SHADE, 1);
        }
        for &(shader, entry) in COMPUTE {
            self.compute(device, shader, entry);
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
        let pipeline = self.pipeline(device, shader, &module, format, samples);
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
        if let Some(pipeline) = self.render.get(&(shader, format, samples)) {
            return pipeline.clone();
        }
        let module = self.module(device, shader);
        let pipeline = self.pipeline(device, shader, &module, format, samples);
        self.render.insert((shader, format, samples), pipeline.clone());
        pipeline
    }

    fn pipeline(
        &mut self,
        device: &wgpu::Device,
        shader: Shader,
        module: &wgpu::ShaderModule,
        format: wgpu::TextureFormat,
        samples: u32,
    ) -> wgpu::RenderPipeline {
        let layout = self.pipeline_layout(device, shader);
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(shader.source().label),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vertex"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState { topology: topology(shader), ..Default::default() },
            depth_stencil: depth(shader),
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fragment"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
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
        self.probing(device, shader, entry, 0)
    }

    /// A probe entry made for marks of `primitive` (a `POINTS`, `STROKES`, or `TRIANGLES` code).
    pub(crate) fn probing(
        &mut self,
        device: &wgpu::Device,
        shader: Shader,
        entry: &'static str,
        primitive: u32,
    ) -> wgpu::ComputePipeline {
        if let Some(pipeline) = self.compute.get(&(shader, entry, primitive)) {
            return pipeline.clone();
        }
        let module = self.module(device, shader);
        let layout = self.pipeline_layout(device, shader);
        let probed = [("PROBED", f64::from(primitive))];
        let probes = matches!(shader, Shader::Probe | Shader::ProbeMultisampled);
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: Some(&layout),
            module: &module,
            entry_point: Some(entry),
            compilation_options: wgpu::PipelineCompilationOptions {
                constants: if probes { &probed } else { &[] },
                ..Default::default()
            },
            cache: None,
        });
        self.compute.insert((shader, entry, primitive), pipeline.clone());
        pipeline
    }
}
