//! Browser regression checks through the public Rust GPU API. Natively the crate is empty.
#![cfg(target_arch = "wasm32")]
#![allow(clippy::disallowed_methods, reason = "the tests drive the WebGL2 device through wgpu itself")]
use std::{cell::RefCell, rc::Rc};
use wasm_bindgen::prelude::*;

use wgpu::util::DeviceExt;

/// Hands over the shaders latkit's build translated, which a `Gpu` needs.
#[wasm_bindgen]
pub fn shaders(bytes: Vec<u8>) -> Result<(), JsValue> {
    latkit::host::Browser::set_shaders(bytes).map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub async fn validation() -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|error| JsValue::from_str(&error.to_string()))?;
    let device = gpu.device();
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    // Parsing succeeds, but a vertex position must be vec4f. The error must be
    // available before anyone asks for a pipeline, including compilation info.
    let invalid = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl("@vertex fn vertex() -> @builtin(position) f32 { return 0.0; }".into()),
    });
    if !invalid
        .get_compilation_info()
        .await
        .messages
        .iter()
        .any(|message| message.message_type == wgpu::CompilationMessageType::Error)
    {
        return Err(JsValue::from_str("shader validation was missing from compilation info"));
    }
    if scope.pop().await.is_none() {
        return Err(JsValue::from_str("shader validation was delayed until pipeline creation"));
    }
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(
            r#"
@vertex fn first() -> @builtin(position) vec4f { return vec4f(0,0,0,1); }
@vertex fn second() -> @builtin(position) vec4f { return vec4f(1,0,0,1); }
@fragment fn fragment() -> @location(0) vec4f { return vec4f(1); }
"#
            .into(),
        ),
    });
    for (entry, fails) in [(None, true), (Some("missing"), true), (Some("first"), false)] {
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let _pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: None,
            layout: None,
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: entry,
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview_mask: None,
            cache: None,
        });
        if scope.pop().await.is_some() != fails {
            return Err(JsValue::from_str(&format!("incorrect entry point validation for {entry:?}")));
        }
    }
    Ok(JsValue::from_str("shader validation and explicit entry selection are correct"))
}

#[wasm_bindgen]
pub async fn loss() -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
    let device = gpu.device();
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 16,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let lost = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let told = lost.clone();
    device.set_device_lost_callback(move |reason, _| told.lock().unwrap().push(reason));
    let mapped = Rc::new(RefCell::new(None));
    let complete = mapped.clone();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| *complete.borrow_mut() = Some(result));
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let completed = done.clone();
    gpu.queue().on_submitted_work_done(move || completed.store(true, std::sync::atomic::Ordering::Release));
    device.destroy();
    device.destroy();
    while mapped.borrow().is_none() || !done.load(std::sync::atomic::Ordering::Acquire) {
        turn().await;
    }
    if mapped.borrow_mut().take().unwrap().is_ok() {
        return Err(JsValue::from_str("mapping succeeded after device destruction"));
    }
    if lost.lock().unwrap().as_slice() != [wgpu::DeviceLostReason::Destroyed] {
        return Err(JsValue::from_str("device loss must be reported exactly once"));
    }
    Ok(JsValue::from_str("loss cancels mapping and completes queue callbacks"))
}

#[wasm_bindgen]
pub async fn scopes() -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
    let device = gpu.device();
    let outer = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let inner = device.push_error_scope(wgpu::ErrorFilter::Validation);
    // Each entry is valid on its own. Their incompatible varyings fail when the browser
    // links the stages, after the synchronous pipeline-creation call has returned.
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("incompatible stage interfaces"),
        source: wgpu::ShaderSource::Wgsl(
            r#"
struct Out { @builtin(position) position: vec4f, @location(0) value: vec2f }
@vertex fn vertex() -> Out { return Out(vec4f(0,0,0,1),vec2f(1)); }
@fragment fn fragment(@location(0) value: vec3f) -> @location(0) vec4f { return vec4f(value,1); }
"#
            .into(),
        ),
    });
    let _pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vertex"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fragment"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    if inner.pop().await.is_none() {
        return Err(JsValue::from_str("link failure escaped its inner scope"));
    }
    if let Some(error) = outer.pop().await {
        return Err(JsValue::from_str(&format!("link failure leaked to the parent: {error}")));
    }
    Ok(JsValue::from_str("link failures belong to the nearest scope"))
}

/// WebGL2 has no query sets or compute passes. Asking for them reports a validation error to the
/// scope that catches it, and the device goes on working.
#[wasm_bindgen]
pub async fn unsupported() -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
    let device = gpu.device();
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let set =
        device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 2 });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    encoder.write_timestamp(&set, 0);
    drop(encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default()));
    gpu.queue().submit([encoder.finish()]);
    match scope.pop().await {
        Some(error) if error.to_string().contains("WebGL2 cannot") => {}
        Some(error) => return Err(JsValue::from_str(&format!("unexpected error: {error}"))),
        None => return Err(JsValue::from_str("unsupported calls reported no error")),
    }
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 4,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    gpu.queue().write_buffer(&buffer, 0, &[1, 2, 3, 4]);
    let mapped = Rc::new(RefCell::new(None));
    let complete = mapped.clone();
    buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| *complete.borrow_mut() = Some(result));
    while mapped.borrow().is_none() {
        turn().await;
    }
    let read = mapped.borrow_mut().take().unwrap().is_ok()
        && buffer.slice(..).get_mapped_range().is_ok_and(|bytes| *bytes == [1, 2, 3, 4]);
    if !read {
        return Err(JsValue::from_str("the device stopped working after an unsupported call"));
    }
    Ok(JsValue::from_str("unsupported calls report validation errors, and the device goes on"))
}

#[wasm_bindgen]
pub async fn transfers() -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
    let device = gpu.device();
    let queue = gpu.queue();
    let make = || {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("padded array upload"),
            size: wgpu::Extent3d { width: 4, height: 4, depth_or_array_layers: 3 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba32Uint,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    };
    let cpu = make();
    let staged = make();
    let value = |x, y, z, channel| 1u32 + x + 10 * y + 100 * z + 1000 * channel;
    let fill = |bytes: &mut [u8], pitch: usize| {
        for z in 0..2 {
            for y in 0..2 {
                for x in 0..2 {
                    for c in 0..4 {
                        let at = (z * 3 + y) * pitch + x * 16 + c * 4;
                        bytes[at..at + 4].copy_from_slice(&value(x as u32, y as u32, z as u32, c as u32).to_le_bytes());
                    }
                }
            }
        }
    };
    // The Rust byte slice is deliberately unaligned. CPU rows need not use the 256-byte
    // buffer-copy alignment, and the third row of each layer is padding.
    let mut bytes = vec![0; 1 + 6 * 48];
    fill(&mut bytes[1..], 48);
    let region = wgpu::Extent3d { width: 2, height: 2, depth_or_array_layers: 2 };
    let origin = wgpu::Origin3d { x: 1, y: 1, z: 1 };
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &cpu, mip_level: 0, origin, aspect: wgpu::TextureAspect::All },
        &bytes[1..],
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(48), rows_per_image: Some(3) },
        region,
    );
    let mut bytes = vec![0; 7 * 256];
    fill(&mut bytes[256..], 256);
    let upload = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &bytes,
        usage: wgpu::BufferUsages::COPY_SRC,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_texture(
        wgpu::TexelCopyBufferInfo {
            buffer: &upload,
            layout: wgpu::TexelCopyBufferLayout { offset: 256, bytes_per_row: Some(256), rows_per_image: Some(3) },
        },
        wgpu::TexelCopyTextureInfo { texture: &staged, mip_level: 0, origin, aspect: wgpu::TextureAspect::All },
        region,
    );
    let outputs: Vec<_> = [&cpu, &staged]
        .into_iter()
        .map(|texture| {
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size: 3 * 4 * 256,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            encoder.copy_texture_to_buffer(
                texture.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(256),
                        rows_per_image: Some(4),
                    },
                },
                texture.size(),
            );
            buffer
        })
        .collect();
    queue.submit([encoder.finish()]);
    for buffer in outputs {
        let mapped = Rc::new(RefCell::new(None));
        let complete = mapped.clone();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| *complete.borrow_mut() = Some(result));
        while mapped.borrow().is_none() {
            turn().await;
        }
        mapped.borrow_mut().take().unwrap().map_err(|e| JsValue::from_str(&e.to_string()))?;
        let data = buffer.slice(..).get_mapped_range().map_err(|e| JsValue::from_str(&e.to_string()))?;
        for z in 0..3 {
            for y in 0..4 {
                for x in 0..4 {
                    for c in 0..4 {
                        let at = (z * 4 + y) * 256 + x * 16 + c * 4;
                        let actual = u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
                        let expected = if z > 0 && (1..3).contains(&x) && (1..3).contains(&y) {
                            value((x - 1) as u32, (y - 1) as u32, (z - 1) as u32, c as u32)
                        } else {
                            0
                        };
                        if actual != expected {
                            return Err(JsValue::from_str(&format!(
                                "upload ({x},{y},{z}) channel {c}: {actual} != {expected}"
                            )));
                        }
                    }
                }
            }
        }
    }
    Ok(JsValue::from_str("CPU and buffer uploads match exactly"))
}

#[wasm_bindgen]
pub async fn render(integer: bool, samples: u32, automatic: bool) -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
    let device = gpu.device();
    let queue = gpu.queue();
    let source = format!(
        r#"
struct Params {{ value: vec4u }}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var image: texture_2d_array<u32>;
struct Out {{ @builtin(position) pos: vec4f, @location(0) @interpolate(flat) instance: u32 }}
@vertex fn vertex(@builtin(vertex_index) i: u32, @builtin(instance_index) instance: u32) -> Out {{
    let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
    return Out(vec4f(p * 2.0 - 1.0, 0, 1), instance);
}}
@fragment fn fragment(input: Out) -> @location(0) {} {{
    let value = textureLoad(image, vec2i(0), 1, 0) + params.value + vec4u(input.instance);
    return {};
}}
"#,
        if integer { "vec4u" } else { "vec4f" },
        if integer { "value" } else { "vec4f(value) / 255.0" }
    );
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: None,
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: true,
                    min_binding_size: None,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Uint,
                    view_dimension: wgpu::TextureViewDimension::D2Array,
                    multisampled: false,
                },
                count: None,
            },
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: None,
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let format = if integer { wgpu::TextureFormat::Rgba32Uint } else { wgpu::TextureFormat::Rgba8Unorm };
    let targets = [Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: if automatic { None } else { Some(&pipeline_layout) },
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vertex"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fragment"),
            compilation_options: Default::default(),
            targets: &targets,
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState { count: samples, ..Default::default() },
        multiview_mask: None,
        cache: None,
    });
    if let Some(error) = scope.pop().await {
        return Err(JsValue::from_str(&error.to_string()));
    }
    let mut uniforms = vec![0; 272];
    for (i, value) in [10u32, 20, 30, 200].into_iter().enumerate() {
        uniforms[256 + i * 4..260 + i * 4].copy_from_slice(&value.to_le_bytes());
    }
    let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &uniforms,
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let input = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 2 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Uint,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let bytes: Vec<_> = [1u32, 2, 3, 4].into_iter().flat_map(u32::to_le_bytes).collect();
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &input,
            mip_level: 0,
            origin: wgpu::Origin3d { x: 0, y: 0, z: 1 },
            aspect: wgpu::TextureAspect::All,
        },
        &bytes,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: None, rows_per_image: None },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
    );
    let input_view = input.create_view(&Default::default());
    let layout = if automatic { pipeline.get_bind_group_layout(0) } else { layout };
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &buffer,
                    offset: if automatic { 256 } else { 0 },
                    size: wgpu::BufferSize::new(16),
                }),
            },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&input_view) },
        ],
    });
    let make = |samples| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: 8, height: 8, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        })
    };
    let target = make(samples);
    let target_view = target.create_view(&Default::default());
    let resolved = (samples > 1).then(|| make(1));
    let resolved_view = resolved.as_ref().map(|t| t.create_view(&Default::default()));
    let read = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 2048,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &target_view,
                depth_slice: None,
                resolve_target: resolved_view.as_ref(),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: if resolved.is_some() { wgpu::StoreOp::Discard } else { wgpu::StoreOp::Store },
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, if automatic { &[] } else { &[256] });
        pass.draw(0..3, 7..8);
    }
    encoder.copy_texture_to_buffer(
        resolved.as_ref().unwrap_or(&target).as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &read,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: None },
        },
        target.size(),
    );
    queue.submit([encoder.finish()]);

    let mapped = Rc::new(RefCell::new(None));
    let complete = mapped.clone();
    read.slice(..).map_async(wgpu::MapMode::Read, move |result| *complete.borrow_mut() = Some(result));
    while mapped.borrow().is_none() {
        crate::turn().await;
    }
    mapped.borrow_mut().take().unwrap().map_err(|e| JsValue::from_str(&e.to_string()))?;
    let range = read.slice(..).get_mapped_range().map_err(|e| JsValue::from_str(&e.to_string()))?;
    let expected = [18u32, 29, 40, 211];
    for y in 0..8 {
        for x in 0..8 {
            for (i, expected) in expected.iter().enumerate() {
                let at = y * 256 + x * if integer { 16 } else { 4 } + i * if integer { 4 } else { 1 };
                let actual = if integer {
                    u32::from_le_bytes(range[at..at + 4].try_into().unwrap())
                } else {
                    u32::from(range[at])
                };
                if actual != *expected {
                    return Err(JsValue::from_str(&format!(
                        "pixel ({x},{y}) component {i}: {actual}, expected {expected}"
                    )));
                }
            }
        }
    }
    Ok(JsValue::from_str("pixels correct"))
}

#[wasm_bindgen]
pub async fn vertices(bundled: bool) -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
    let device = gpu.device();
    let queue = gpu.queue();
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(r#"
override SHIFT: u32 = 999u;
struct Out { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) value: vec2u }
@vertex fn vertex(@location(0) position: vec2f, @location(1) value: u32, @location(2) constant: u32, @builtin(instance_index) instance: u32) -> Out {
 return Out(vec4f(position,0,1), vec2u(value + instance + SHIFT, constant));
}
@fragment fn fragment(v: Out) -> @location(0) vec4f { return vec4f(vec2f(v.value),40,211)/255.0; }
"#.into()) });
    let mut descriptor = wgpu::RenderPipelineDescriptor {
        label: None,
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vertex"),
            compilation_options: Default::default(),
            buffers: &[
                Some(wgpu::VertexBufferLayout {
                    array_stride: 8,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Float32x2,
                        offset: 0,
                        shader_location: 0,
                    }],
                }),
                Some(wgpu::VertexBufferLayout {
                    array_stride: 4,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Uint32,
                        offset: 0,
                        shader_location: 1,
                    }],
                }),
                Some(wgpu::VertexBufferLayout {
                    array_stride: 0,
                    step_mode: if bundled { wgpu::VertexStepMode::Instance } else { wgpu::VertexStepMode::Vertex },
                    attributes: &[wgpu::VertexAttribute {
                        format: wgpu::VertexFormat::Uint32,
                        offset: 0,
                        shader_location: 2,
                    }],
                }),
            ],
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fragment"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    };
    descriptor.vertex.compilation_options.constants = &[("SHIFT", 17.0)];
    let _alternate = device.create_render_pipeline(&descriptor);
    descriptor.vertex.compilation_options.constants = &[("SHIFT", 0.0)];
    let pipeline = device.create_render_pipeline(&descriptor);
    if let Some(error) = scope.pop().await {
        return Err(JsValue::from_str(&error.to_string()));
    }
    let vertex_bytes: Vec<_> = [-1f32, -1., 3., -1., -1., 3.].into_iter().flat_map(f32::to_le_bytes).collect();
    let vertices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &vertex_bytes,
        usage: wgpu::BufferUsages::VERTEX,
    });
    let values = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &[0, 0, 0, 0, 0, 0, 0, 0, 18, 0, 0, 0, 18, 0, 0, 0, 18, 0, 0, 0],
        usage: wgpu::BufferUsages::VERTEX,
    });
    let constant = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &[29, 0, 0, 0],
        usage: wgpu::BufferUsages::VERTEX,
    });
    let indices = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: &[0, 0, 1, 0, 2, 0],
        usage: wgpu::BufferUsages::INDEX,
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: 8, height: 8, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let read = device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: 2048,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let bundle = if bundled {
        let mut b = device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
            label: None,
            color_formats: &[Some(wgpu::TextureFormat::Rgba8Unorm)],
            depth_stencil: None,
            sample_count: 1,
            multiview: None,
        });
        b.set_pipeline(&pipeline);
        b.set_vertex_buffer(0, vertices.slice(..));
        b.set_vertex_buffer(1, values.slice(..));
        b.set_vertex_buffer(2, constant.slice(..));
        b.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint16);
        b.draw_indexed(0..3, 0, 2..5);
        Some(b.finish(&Default::default()))
    } else {
        None
    };
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        if let Some(bundle) = &bundle {
            pass.execute_bundles([bundle]);
        } else {
            pass.set_pipeline(&pipeline);
            pass.set_vertex_buffer(0, vertices.slice(..));
            pass.set_vertex_buffer(1, values.slice(..));
            pass.set_vertex_buffer(2, constant.slice(..));
            pass.set_index_buffer(indices.slice(..), wgpu::IndexFormat::Uint16);
            pass.draw_indexed(0..3, 0, 2..5);
        }
    }
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &read,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: None },
        },
        target.size(),
    );
    queue.submit([encoder.finish()]);
    let mapped = Rc::new(RefCell::new(None));
    let complete = mapped.clone();
    read.slice(..).map_async(wgpu::MapMode::Read, move |result| *complete.borrow_mut() = Some(result));
    while mapped.borrow().is_none() {
        crate::turn().await;
    }
    mapped.borrow_mut().take().unwrap().map_err(|e| JsValue::from_str(&e.to_string()))?;
    let range = read.slice(..).get_mapped_range().map_err(|e| JsValue::from_str(&e.to_string()))?;
    for y in 0..8 {
        for x in 0..8 {
            let actual = &range[y * 256 + x * 4..y * 256 + x * 4 + 4];
            if actual != [22, 29, 40, 211] {
                return Err(JsValue::from_str(&format!("indexed pixel {x},{y}: {actual:?}")));
            }
        }
    }
    Ok(JsValue::from_str("indexed instance pixels correct"))
}

#[wasm_bindgen]
pub async fn surfaces(canvas: JsValue, external: JsValue) -> Result<JsValue, JsValue> {
    use latkit::web::{Canvas, PageView, Panel};
    use latkit::{Color, Grid, Plane, Scene, Theme, View};
    use wasm_bindgen::JsCast;
    let error = |e: latkit::Error| JsValue::from_str(&e.to_string());
    let gpu = latkit::Gpu::new().await.map_err(error)?;
    let scene = |color| Scene::new(Plane { grid: Grid::Off }).theme(Theme { background: color, ..Theme::dark() });
    let view = PageView::new(View::new(&gpu, scene(Color::rgb(0.0, 0.0, 1.0))));
    let canvas = canvas.dyn_into().map_err(|_| JsValue::from_str("expected an offscreen canvas"))?;
    let _painted = Canvas::offscreen(&gpu, &canvas, vec![Panel { view: view.clone(), at: [0.0, 0.0, 1.0, 1.0] }], 1.0)
        .map_err(error)?;
    latkit::web::done(&gpu).await;
    let surface = gpu
        .instance()
        .unwrap()
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(external.unchecked_into()))
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    for size in [[640, 480], [8, 8]] {
        let config = surface.get_default_config(gpu.adapter().unwrap(), size[0], size[1]).unwrap();
        surface.configure(gpu.device(), &config);
        let output = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(output) => output,
            other => return Err(JsValue::from_str(&format!("surface acquisition: {other:?}"))),
        };
        let target = output.texture.create_view(&Default::default());
        let mut encoder = gpu.device().create_command_encoder(&Default::default());
        {
            let _pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::RED), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
        }
        gpu.queue().submit([encoder.finish()]);
        gpu.queue().present(output);
        view.with(|view| view.set_scene(scene(Color::rgb(0.0, 1.0, 0.0))));
        latkit::web::done(&gpu).await;
    }
    Ok(JsValue::from_str("public surfaces and latkit views share presentation"))
}

#[wasm_bindgen]
pub async fn exports() -> Result<JsValue, JsValue> {
    use latkit::{Color, Grid, Pixels, Plane, Scene, Shot, Sink, Theme, View};
    #[derive(Default)]
    struct Frames(Vec<Option<Vec<u8>>>);
    impl Sink for Frames {
        const PIXELS: Pixels = Pixels::Nv12;
        async fn frame(&mut self, index: u64, pixels: Option<Vec<u8>>) -> latkit::Result<()> {
            assert_eq!(index as usize, self.0.len());
            self.0.push(pixels);
            Ok(())
        }
        async fn finish(&mut self, end: u64) -> latkit::Result<()> {
            assert_eq!(end as usize, self.0.len());
            Ok(())
        }
    }
    let error = |e: latkit::Error| JsValue::from_str(&e.to_string());
    let gpu = latkit::Gpu::new().await.map_err(error)?;
    let scene = |color| Scene::new(Plane { grid: Grid::Off }).theme(Theme { background: color, ..Theme::dark() });
    let mut view = View::new(&gpu, scene(Color::rgb(1.0, 0.0, 0.0)));
    // Both NV12 planes have 260 live bytes in each 512-byte mapped row. Reuse the
    // pooled mapping across a changed frame and then a held frame.
    let mut video = Shot::new([260, 130]).video(&gpu, 30.0, Frames::default()).map_err(error)?;
    video.frame(&mut [&mut view]).await.map_err(error)?;
    view.set_scene(scene(Color::rgb(0.0, 0.0, 1.0)));
    video.frame(&mut [&mut view]).await.map_err(error)?;
    video.frame(&mut [&mut view]).await.map_err(error)?;
    let frames = video.finish().await.map_err(error)?.0;
    if frames.len() != 3 || frames[2].is_some() {
        return Err(JsValue::from_str("unchanged video frame was not held"));
    }
    for (frame, expected) in frames[..2].iter().zip([[63u8, 102, 240], [32, 240, 118]]) {
        let frame = frame.as_ref().ok_or_else(|| JsValue::from_str("changed frame was held"))?;
        if frame.len() != 260 * 130 * 3 / 2 {
            return Err(JsValue::from_str("NV12 row padding leaked into output"));
        }
        for (i, &value) in frame.iter().enumerate() {
            let expected = if i < 260 * 130 { expected[0] } else { expected[1 + i % 2] };
            if value.abs_diff(expected) > 1 {
                return Err(JsValue::from_str(&format!("NV12 byte {i}: {value}, expected {expected}")));
            }
        }
    }
    let clear = Shot::new([257, 131]).transparent().image(&mut [&mut view]).await.map_err(error)?;
    if clear.rgba.len() != 257 * 131 * 4 || clear.rgba.iter().any(|&byte| byte != 0) {
        return Err(JsValue::from_str("transparent RGBA export was not preserved"));
    }
    Ok(JsValue::from_str("padded NV12 planes, held frames, and transparent RGBA are correct"))
}

#[wasm_bindgen]
pub async fn compile(source: &str) -> Result<JsValue, JsValue> {
    let gpu = latkit::Gpu::new().await.map_err(|e| JsValue::from_str(&e.to_string()))?;
    let device = gpu.device();
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("browser verification"),
        source: wgpu::ShaderSource::Wgsl(source.into()),
    });
    let targets = [Some(wgpu::ColorTargetState {
        format: wgpu::TextureFormat::Rgba8Unorm,
        blend: None,
        write_mask: wgpu::ColorWrites::ALL,
    })];
    let _pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("prototype"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vertex"),
            buffers: &[],
            compilation_options: Default::default(),
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fragment"),
            targets: &targets,
            compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    if let Some(error) = scope.pop().await {
        return Err(JsValue::from_str(&error.to_string()));
    }
    Ok(JsValue::from_str("shader linked"))
}

async fn turn() {
    let promise = js_sys::Promise::new(&mut |resolve, _| {
        let global = js_sys::global();
        let timeout = js_sys::Reflect::get(&global, &"setTimeout".into()).unwrap().unchecked_into::<js_sys::Function>();
        timeout.call2(&global, &resolve, &0.into()).unwrap();
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}
