//! Pipelines, created on first use and kept per shader, target format, and sample count. Every
//! pipeline shares the view and mark group layouts; each shader's pass group comes from its WGSL.

use std::collections::HashMap;

use super::shaders::{Binding, MARK_GROUP, Shader, VIEW_GROUP};

pub(crate) struct Pipelines {
    pub(crate) view_layout: wgpu::BindGroupLayout,
    pub(crate) mark_layout: wgpu::BindGroupLayout,
    pass_layouts: HashMap<Vec<wgpu::BindGroupLayoutEntry>, wgpu::BindGroupLayout>,
    modules: HashMap<Shader, wgpu::ShaderModule>,
    render: HashMap<(Shader, wgpu::TextureFormat, u32), wgpu::RenderPipeline>,
    compute: HashMap<(Shader, &'static str), wgpu::ComputePipeline>,
}

/// How a render shader's vertices assemble.
fn topology(shader: Shader) -> wgpu::PrimitiveTopology {
    match shader {
        Shader::Backdrop => wgpu::PrimitiveTopology::TriangleList,
        _ => wgpu::PrimitiveTopology::TriangleStrip,
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

    /// The pipeline drawing `shader` into `format` with `samples` per pixel, blending premultiplied.
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
        let layout = self.pipeline_layout(device, shader);
        let blend = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
        };
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(shader.source().label),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vertex"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState { topology: topology(shader), ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fragment"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(blend),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        self.render.insert((shader, format, samples), pipeline.clone());
        pipeline
    }

    /// The compute pipeline of `shader`'s entry point `entry`.
    pub(crate) fn compute(
        &mut self,
        device: &wgpu::Device,
        shader: Shader,
        entry: &'static str,
    ) -> wgpu::ComputePipeline {
        if let Some(pipeline) = self.compute.get(&(shader, entry)) {
            return pipeline.clone();
        }
        let module = self.module(device, shader);
        let layout = self.pipeline_layout(device, shader);
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: Some(&layout),
            module: &module,
            entry_point: Some(entry),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });
        self.compute.insert((shader, entry), pipeline.clone());
        pipeline
    }
}
