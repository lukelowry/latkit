use super::{
    device::State,
    pipeline::Pipeline,
    resource::{Binding, Buffer, Group, Texture, View},
    unsupported::{Unsupported, report},
};
use std::{
    cell::RefCell,
    ops::Range,
    rc::{Rc, Weak},
};
use web_sys::WebGl2RenderingContext as Gl;
use wgpu::custom::{
    CommandBufferInterface, CommandEncoderInterface, DispatchBindGroup, DispatchBuffer, DispatchCommandBuffer,
    DispatchComputePass, DispatchQuerySet, DispatchRenderBundle, DispatchRenderPass, DispatchRenderPipeline,
    DispatchTexture, RenderPassInterface,
};

#[derive(Debug, Clone)]
pub(super) struct Image {
    pub(super) texture: Texture,
    pub(super) level: u32,
    pub(super) origin: wgpu::Origin3d,
}
impl Image {
    pub(super) fn new(info: wgpu::TexelCopyTextureInfo<'_>) -> Self {
        Self {
            texture: info.texture.as_custom::<Texture>().unwrap().clone(),
            level: info.mip_level,
            origin: info.origin,
        }
    }
}
#[derive(Debug)]
pub(super) enum Command {
    BufferCopy(Buffer, u64, Buffer, u64, u64),
    TextureCopy(Image, Image, wgpu::Extent3d),
    Read(Image, Buffer, wgpu::TexelCopyBufferLayout, wgpu::Extent3d),
    Upload(Buffer, wgpu::TexelCopyBufferLayout, Image, wgpu::Extent3d),
    Clear(Buffer, u64, u64),
    Render(Render),
    /// Starts timing the GPU work that follows (see [`Elapsed`](super::Elapsed)).
    Begin(Rc<super::elapsed::Query>),
    /// Stops timing.
    End(Rc<super::elapsed::Query>),
}
/// Commands recorded for one submission, and the device they report errors to.
#[derive(Debug)]
pub(super) struct Encoder {
    pub(super) commands: Rc<RefCell<Vec<Command>>>,
    state: Weak<State>,
}
impl Encoder {
    pub(super) fn new(state: &Rc<State>) -> Self {
        Self { commands: Rc::default(), state: Rc::downgrade(state) }
    }
}
#[derive(Debug)]
pub(super) struct Commands(pub(super) RefCell<Vec<Command>>);
impl CommandBufferInterface for Commands {}
#[derive(Debug)]
pub(super) struct Color {
    view: View,
    resolve: Option<View>,
    ops: wgpu::Operations<wgpu::Color>,
}
#[derive(Debug)]
pub(super) struct Depth {
    view: View,
    ops: Option<wgpu::Operations<f32>>,
}
#[derive(Debug)]
pub(super) struct Render {
    colors: Vec<Option<Color>>,
    depth: Option<Depth>,
    draws: Vec<Draw>,
}
#[derive(Clone, Debug)]
pub(super) enum Draw {
    Reset,
    Pipeline(Pipeline),
    Group(u32, Option<Group>, Vec<u32>),
    Viewport(f32, f32, f32, f32, f32, f32),
    Scissor(u32, u32, u32, u32),
    Blend(wgpu::Color),
    Vertex(u32, Option<super::vertex::Slice>),
    Index(super::vertex::Slice, wgpu::IndexFormat),
    Vertices(Range<u32>, Range<u32>),
    Indexed(Range<u32>, Range<u32>),
}
#[derive(Debug)]
pub(super) struct Pass {
    encoder: Option<Rc<RefCell<Vec<Command>>>>,
    render: Option<Render>,
    state: Weak<State>,
}
impl Pass {
    fn new(encoder: &Encoder, desc: &wgpu::RenderPassDescriptor<'_>) -> Self {
        let colors = desc
            .color_attachments
            .iter()
            .map(|c| {
                c.as_ref().map(|c| Color {
                    view: c.view.as_custom::<View>().unwrap().clone(),
                    resolve: c.resolve_target.map(|t| t.as_custom::<View>().unwrap().clone()),
                    ops: c.ops,
                })
            })
            .collect();
        let depth = desc
            .depth_stencil_attachment
            .as_ref()
            .map(|d| Depth { view: d.view.as_custom::<View>().unwrap().clone(), ops: d.depth_ops });
        Self {
            encoder: Some(encoder.commands.clone()),
            render: Some(Render { colors, depth, draws: Vec::new() }),
            state: encoder.state.clone(),
        }
    }
    pub(super) fn bundle(state: &Rc<State>) -> Self {
        Self {
            encoder: None,
            render: Some(Render { colors: Vec::new(), depth: None, draws: Vec::new() }),
            state: Rc::downgrade(state),
        }
    }
    fn push(&mut self, draw: Draw) {
        self.render.as_mut().unwrap().draws.push(draw);
    }
}
impl Drop for Pass {
    fn drop(&mut self) {
        if let Some(encoder) = &self.encoder {
            encoder.borrow_mut().push(Command::Render(self.render.take().expect("active render pass")));
        }
    }
}

impl Command {
    pub(super) fn run(&self, gl: &Gl) {
        match self {
            Self::BufferCopy(from, start, to, end, size) => {
                gl.bind_buffer(Gl::COPY_READ_BUFFER, Some(&from.0.raw));
                gl.bind_buffer(Gl::COPY_WRITE_BUFFER, Some(&to.0.raw));
                gl.copy_buffer_sub_data_with_f64_and_f64_and_f64(
                    Gl::COPY_READ_BUFFER,
                    Gl::COPY_WRITE_BUFFER,
                    *start as f64,
                    *end as f64,
                    *size as f64,
                );
            }
            Self::Clear(buffer, offset, size) => buffer.write(*offset, &vec![0; *size as usize]),
            Self::TextureCopy(from, to, size) => {
                let read = gl.create_framebuffer().unwrap();
                gl.bind_framebuffer(Gl::READ_FRAMEBUFFER, Some(&read));
                gl.read_buffer(if from.texture.0.format.depth { Gl::NONE } else { Gl::COLOR_ATTACHMENT0 });
                gl.bind_texture(to.texture.0.target, to.texture.0.raw.as_ref());
                for layer in 0..size.depth_or_array_layers {
                    from.texture.attach(
                        Gl::READ_FRAMEBUFFER,
                        if from.texture.0.format.depth { Gl::DEPTH_ATTACHMENT } else { Gl::COLOR_ATTACHMENT0 },
                        from.level,
                        from.origin.z + layer,
                    );
                    if to.texture.0.target == Gl::TEXTURE_2D_ARRAY {
                        gl.copy_tex_sub_image_3d(
                            to.texture.0.target,
                            to.level as i32,
                            to.origin.x as i32,
                            to.origin.y as i32,
                            (to.origin.z + layer) as i32,
                            from.origin.x as i32,
                            from.origin.y as i32,
                            size.width as i32,
                            size.height as i32,
                        );
                    } else {
                        gl.copy_tex_sub_image_2d(
                            to.texture.0.target,
                            to.level as i32,
                            to.origin.x as i32,
                            to.origin.y as i32,
                            from.origin.x as i32,
                            from.origin.y as i32,
                            size.width as i32,
                            size.height as i32,
                        );
                    }
                }
                gl.delete_framebuffer(Some(&read));
            }
            Self::Read(from, to, layout, size) => {
                let fbo = gl.create_framebuffer().unwrap();
                gl.bind_framebuffer(Gl::READ_FRAMEBUFFER, Some(&fbo));
                gl.read_buffer(Gl::COLOR_ATTACHMENT0);
                gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, Some(&to.0.raw));
                let format = from.texture.0.format;
                gl.pixel_storei(Gl::PACK_ALIGNMENT, 1);
                gl.pixel_storei(Gl::PACK_ROW_LENGTH, layout.bytes_per_row.map_or(0, |b| b / format.bytes) as i32);
                let stride = u64::from(layout.bytes_per_row.unwrap_or(size.width * format.bytes))
                    * u64::from(layout.rows_per_image.unwrap_or(size.height));
                for layer in 0..size.depth_or_array_layers {
                    from.texture.attach(Gl::READ_FRAMEBUFFER, Gl::COLOR_ATTACHMENT0, from.level, from.origin.z + layer);
                    gl.read_pixels_with_i32(
                        from.origin.x as i32,
                        from.origin.y as i32,
                        size.width as i32,
                        size.height as i32,
                        format.external,
                        format.ty,
                        (layout.offset + u64::from(layer) * stride) as i32,
                    )
                    .unwrap();
                }
                gl.pixel_storei(Gl::PACK_ROW_LENGTH, 0);
                gl.bind_buffer(Gl::PIXEL_PACK_BUFFER, None);
                gl.delete_framebuffer(Some(&fbo));
            }
            Self::Upload(from, layout, to, size) => {
                super::transfer::upload(gl, super::transfer::Source::Buffer(from), *layout, to, *size);
            }
            Self::Render(render) => render.run(gl),
            Self::Begin(query) => gl.begin_query(super::elapsed::TIME_ELAPSED, &query.raw),
            Self::End(query) => {
                gl.end_query(super::elapsed::TIME_ELAPSED);
                query.ended.set(true);
            }
        }
    }
}

pub(super) fn comparison(c: wgpu::CompareFunction) -> u32 {
    match c {
        wgpu::CompareFunction::Never => Gl::NEVER,
        wgpu::CompareFunction::Less => Gl::LESS,
        wgpu::CompareFunction::Equal => Gl::EQUAL,
        wgpu::CompareFunction::LessEqual => Gl::LEQUAL,
        wgpu::CompareFunction::Greater => Gl::GREATER,
        wgpu::CompareFunction::NotEqual => Gl::NOTEQUAL,
        wgpu::CompareFunction::GreaterEqual => Gl::GEQUAL,
        wgpu::CompareFunction::Always => Gl::ALWAYS,
    }
}
fn blend_factor(f: wgpu::BlendFactor) -> u32 {
    match f {
        wgpu::BlendFactor::Zero => Gl::ZERO,
        wgpu::BlendFactor::One => Gl::ONE,
        wgpu::BlendFactor::Src => Gl::SRC_COLOR,
        wgpu::BlendFactor::OneMinusSrc => Gl::ONE_MINUS_SRC_COLOR,
        wgpu::BlendFactor::SrcAlpha => Gl::SRC_ALPHA,
        wgpu::BlendFactor::OneMinusSrcAlpha => Gl::ONE_MINUS_SRC_ALPHA,
        wgpu::BlendFactor::Dst => Gl::DST_COLOR,
        wgpu::BlendFactor::OneMinusDst => Gl::ONE_MINUS_DST_COLOR,
        wgpu::BlendFactor::DstAlpha => Gl::DST_ALPHA,
        wgpu::BlendFactor::OneMinusDstAlpha => Gl::ONE_MINUS_DST_ALPHA,
        wgpu::BlendFactor::SrcAlphaSaturated => Gl::SRC_ALPHA_SATURATE,
        wgpu::BlendFactor::Constant => Gl::CONSTANT_COLOR,
        wgpu::BlendFactor::OneMinusConstant => Gl::ONE_MINUS_CONSTANT_COLOR,
        _ => panic!("unsupported blend factor"),
    }
}
fn blend_op(o: wgpu::BlendOperation) -> u32 {
    match o {
        wgpu::BlendOperation::Add => Gl::FUNC_ADD,
        wgpu::BlendOperation::Subtract => Gl::FUNC_SUBTRACT,
        wgpu::BlendOperation::ReverseSubtract => Gl::FUNC_REVERSE_SUBTRACT,
        wgpu::BlendOperation::Min => Gl::MIN,
        wgpu::BlendOperation::Max => Gl::MAX,
    }
}
impl Pipeline {
    fn bind(&self, gl: &Gl) {
        let program = self.program.as_ref().expect("valid pipeline");
        program.finish().expect("pipeline linking failed");
        gl.use_program(Some(&program.raw));
        if let Some(depth) = &self.depth {
            gl.enable(Gl::DEPTH_TEST);
            gl.depth_func(comparison(depth.depth_compare.unwrap_or(wgpu::CompareFunction::Always)));
            gl.depth_mask(depth.depth_write_enabled.unwrap_or(false));
            if depth.bias.constant != 0 || depth.bias.slope_scale != 0.0 {
                gl.enable(Gl::POLYGON_OFFSET_FILL);
                gl.polygon_offset(depth.bias.slope_scale, depth.bias.constant as f32);
            } else {
                gl.disable(Gl::POLYGON_OFFSET_FILL);
            }
        } else {
            gl.disable(Gl::DEPTH_TEST);
            gl.depth_mask(false);
            gl.disable(Gl::POLYGON_OFFSET_FILL);
        }
        gl.disable(Gl::STENCIL_TEST);
        // Naga negates clip-space Y, reversing front winding.
        gl.front_face(if self.primitive.front_face == wgpu::FrontFace::Ccw { Gl::CW } else { Gl::CCW });
        if let Some(face) = self.primitive.cull_mode {
            gl.enable(Gl::CULL_FACE);
            gl.cull_face(if face == wgpu::Face::Front { Gl::FRONT } else { Gl::BACK });
        } else {
            gl.disable(Gl::CULL_FACE);
        }
        if let Some(target) = self.targets.first().and_then(Option::as_ref) {
            if let Some(blend) = target.blend {
                gl.enable(Gl::BLEND);
                gl.blend_func_separate(
                    blend_factor(blend.color.src_factor),
                    blend_factor(blend.color.dst_factor),
                    blend_factor(blend.alpha.src_factor),
                    blend_factor(blend.alpha.dst_factor),
                );
                gl.blend_equation_separate(blend_op(blend.color.operation), blend_op(blend.alpha.operation));
            } else {
                gl.disable(Gl::BLEND);
            }
            let m = target.write_mask;
            gl.color_mask(
                m.contains(wgpu::ColorWrites::RED),
                m.contains(wgpu::ColorWrites::GREEN),
                m.contains(wgpu::ColorWrites::BLUE),
                m.contains(wgpu::ColorWrites::ALPHA),
            );
        }
    }
}
type BoundGroups<'a> = [Option<(&'a Group, &'a [u32])>; 4];
impl super::pipeline::Program {
    fn bind_groups(&self, gl: &Gl, groups: &BoundGroups<'_>, first_instance: u32) {
        let find = |slot: super::pipeline::Slot| -> (&Binding, u32) {
            let (group, offsets) = groups[slot.0 as usize].expect("bound group");
            let mut dynamic = offsets.iter();
            for (binding, resource) in group.0.iter() {
                let offset = if matches!(resource, Binding::Buffer(_, _, _, true)) {
                    *dynamic.next().expect("dynamic offset")
                } else {
                    0
                };
                if *binding == slot.1 {
                    return (resource, offset);
                }
            }
            panic!("missing binding {slot:?}")
        };
        for (slot, unit) in self.uniforms.borrow().iter() {
            let (Binding::Buffer(buffer, offset, size, _), dynamic) = find(*slot) else { panic!("uniform buffer") };
            gl.bind_buffer_range_with_f64_and_f64(
                Gl::UNIFORM_BUFFER,
                *unit,
                Some(&buffer.0.raw),
                (*offset + u64::from(dynamic)) as f64,
                *size as f64,
            );
        }
        for (slot, sampler, unit) in self.textures.borrow().iter() {
            let (Binding::Texture(view), _) = find(*slot) else { panic!("texture binding") };
            gl.active_texture(Gl::TEXTURE0 + *unit);
            gl.bind_texture(view.texture.0.target, view.texture.0.raw.as_ref());
            let sampler = sampler.map(|s| {
                let (Binding::Sampler(s), _) = find(s) else { panic!("sampler binding") };
                &s.0.raw
            });
            gl.bind_sampler(*unit, sampler);
        }
        gl.uniform1ui(self.first_instance.borrow().as_ref(), first_instance);
    }
}
impl Render {
    fn attach(&self, gl: &Gl) -> (web_sys::WebGlFramebuffer, i32, i32) {
        let fbo = gl.create_framebuffer().unwrap();
        gl.bind_framebuffer(Gl::DRAW_FRAMEBUFFER, Some(&fbo));
        let attachments = js_sys::Array::new();
        for (index, color) in self.colors.iter().enumerate() {
            attachments.push(&wasm_bindgen::JsValue::from(if color.is_some() {
                Gl::COLOR_ATTACHMENT0 + index as u32
            } else {
                Gl::NONE
            }));
            if let Some(color) = color {
                color.view.texture.attach(
                    Gl::DRAW_FRAMEBUFFER,
                    Gl::COLOR_ATTACHMENT0 + index as u32,
                    color.view.level,
                    color.view.layer,
                );
            }
        }
        gl.draw_buffers(&attachments);
        if let Some(depth) = &self.depth {
            depth.view.texture.attach(Gl::DRAW_FRAMEBUFFER, Gl::DEPTH_ATTACHMENT, depth.view.level, depth.view.layer);
        }
        let view = self
            .colors
            .iter()
            .flatten()
            .next()
            .map(|c| &c.view)
            .or_else(|| self.depth.as_ref().map(|d| &d.view))
            .expect("render attachment");
        let width = (view.texture.0.size.width >> view.level) as i32;
        let height = (view.texture.0.size.height >> view.level) as i32;
        gl.disable(Gl::SCISSOR_TEST);
        gl.color_mask(true, true, true, true);
        gl.depth_mask(true);
        for (index, color) in self.colors.iter().enumerate() {
            if let Some(color) = color
                && let wgpu::LoadOp::Clear(value) = color.ops.load
            {
                if color.view.texture.0.format.integer {
                    gl.clear_bufferuiv_with_u32_array(
                        Gl::COLOR,
                        index as i32,
                        &[value.r as u32, value.g as u32, value.b as u32, value.a as u32],
                    );
                } else {
                    gl.clear_bufferfv_with_f32_array(
                        Gl::COLOR,
                        index as i32,
                        &[value.r as f32, value.g as f32, value.b as f32, value.a as f32],
                    );
                }
            }
        }
        if let Some(wgpu::Operations { load: wgpu::LoadOp::Clear(value), .. }) = self.depth.as_ref().and_then(|d| d.ops)
        {
            gl.clear_bufferfv_with_f32_array(Gl::DEPTH, 0, &[value]);
        }
        gl.viewport(0, 0, width, height);
        gl.depth_range(0.0, 1.0);
        gl.enable(Gl::SCISSOR_TEST);
        gl.scissor(0, 0, width, height);

        (fbo, width, height)
    }

    fn run(&self, gl: &Gl) {
        let (fbo, width, height) = self.attach(gl);
        let mut pipeline: Option<&Pipeline> = None;
        let mut inputs = super::vertex::Inputs::new(gl);
        let mut groups: [Option<(&Group, &[u32])>; 4] = [None; 4];
        for draw in &self.draws {
            match draw {
                Draw::Reset => {
                    pipeline = None;
                    groups = [None; 4];
                    inputs.vertices.fill(None);
                    inputs.index = None;
                }
                Draw::Pipeline(next) => {
                    next.bind(gl);
                    pipeline = Some(next);
                }
                Draw::Group(index, group, offsets) => {
                    groups[*index as usize] = group.as_ref().map(|g| (g, offsets.as_slice()));
                }
                Draw::Viewport(x, y, w, h, min, max) => {
                    gl.viewport(*x as i32, *y as i32, *w as i32, *h as i32);
                    gl.depth_range(*min, *max);
                }
                Draw::Scissor(x, y, w, h) => gl.scissor(*x as i32, *y as i32, *w as i32, *h as i32),
                Draw::Blend(c) => gl.blend_color(c.r as f32, c.g as f32, c.b as f32, c.a as f32),
                Draw::Vertex(slot, buffer) => inputs.vertices[*slot as usize].clone_from(buffer),
                Draw::Index(buffer, format) => inputs.index = Some((buffer.clone(), *format)),
                Draw::Vertices(vertices, instances) | Draw::Indexed(vertices, instances) => {
                    if vertices.is_empty() || instances.is_empty() {
                        continue;
                    }
                    let pipeline = pipeline.expect("draw pipeline");
                    inputs.bind(&pipeline.vertices, instances.start);
                    let program = pipeline.program.as_ref().unwrap();
                    program.bind_groups(gl, &groups, instances.start);
                    let topology = match pipeline.primitive.topology {
                        wgpu::PrimitiveTopology::PointList => Gl::POINTS,
                        wgpu::PrimitiveTopology::LineList => Gl::LINES,
                        wgpu::PrimitiveTopology::LineStrip => Gl::LINE_STRIP,
                        wgpu::PrimitiveTopology::TriangleList => Gl::TRIANGLES,
                        wgpu::PrimitiveTopology::TriangleStrip => Gl::TRIANGLE_STRIP,
                    };
                    if matches!(draw, Draw::Indexed(..)) {
                        let (index, format) = inputs.index.as_ref().expect("index buffer is bound");
                        let (ty, bytes) = match format {
                            wgpu::IndexFormat::Uint16 => (Gl::UNSIGNED_SHORT, 2),
                            wgpu::IndexFormat::Uint32 => (Gl::UNSIGNED_INT, 4),
                        };
                        assert!(u64::from(vertices.end) * bytes <= index.size, "index range out of bounds");
                        gl.draw_elements_instanced_with_f64(
                            topology,
                            vertices.len() as i32,
                            ty,
                            (index.offset + u64::from(vertices.start) * bytes) as f64,
                            instances.len() as i32,
                        );
                    } else {
                        gl.draw_arrays_instanced(
                            topology,
                            vertices.start as i32,
                            vertices.len() as i32,
                            instances.len() as i32,
                        );
                    }
                }
            }
        }
        gl.disable(Gl::SCISSOR_TEST);
        for (index, color) in self.colors.iter().enumerate() {
            if let Some(Color { resolve: Some(to), .. }) = color {
                assert!(
                    color.as_ref().unwrap().view.texture.0.samples > 1 && to.texture.0.samples == 1,
                    "invalid multisample resolve"
                );
                let dest = gl.create_framebuffer().unwrap();
                gl.bind_framebuffer(Gl::READ_FRAMEBUFFER, Some(&fbo));
                gl.read_buffer(Gl::COLOR_ATTACHMENT0 + index as u32);
                gl.bind_framebuffer(Gl::DRAW_FRAMEBUFFER, Some(&dest));
                to.texture.attach(Gl::DRAW_FRAMEBUFFER, Gl::COLOR_ATTACHMENT0, to.level, to.layer);
                gl.blit_framebuffer(0, 0, width, height, 0, 0, width, height, Gl::COLOR_BUFFER_BIT, Gl::NEAREST);
                gl.delete_framebuffer(Some(&dest));
            }
        }
        // Resolve before discarding its source. Transient multisample color and unqueried
        // depth need not be stored, particularly on GPUs that keep render tiles on chip.
        let discarded = js_sys::Array::new();
        for (index, color) in self.colors.iter().enumerate() {
            if color.as_ref().is_some_and(|color| color.ops.store == wgpu::StoreOp::Discard) {
                discarded.push(&(Gl::COLOR_ATTACHMENT0 + index as u32).into());
            }
        }
        if self.depth.as_ref().and_then(|depth| depth.ops).is_some_and(|ops| ops.store == wgpu::StoreOp::Discard) {
            discarded.push(&Gl::DEPTH_ATTACHMENT.into());
        }
        if discarded.length() != 0 {
            gl.bind_framebuffer(Gl::DRAW_FRAMEBUFFER, Some(&fbo));
            gl.invalidate_framebuffer(Gl::DRAW_FRAMEBUFFER, &discarded).expect("render pass attachments");
        }
        gl.delete_framebuffer(Some(&fbo));
    }
}

impl CommandEncoderInterface for Encoder {
    fn copy_buffer_to_buffer(
        &self,
        source: &DispatchBuffer,
        source_offset: wgpu::BufferAddress,
        destination: &DispatchBuffer,
        destination_offset: wgpu::BufferAddress,
        copy_size: Option<wgpu::BufferAddress>,
    ) {
        self.commands.borrow_mut().push(Command::BufferCopy(
            source.as_custom::<Buffer>().unwrap().clone(),
            source_offset,
            destination.as_custom::<Buffer>().unwrap().clone(),
            destination_offset,
            copy_size.unwrap_or(source.as_custom::<Buffer>().unwrap().0.size - source_offset),
        ));
    }
    fn copy_buffer_to_texture(
        &self,
        source: wgpu::TexelCopyBufferInfo<'_>,
        destination: wgpu::TexelCopyTextureInfo<'_>,
        copy_size: wgpu::Extent3d,
    ) {
        self.commands.borrow_mut().push(Command::Upload(
            source.buffer.as_custom::<Buffer>().unwrap().clone(),
            source.layout,
            Image::new(destination),
            copy_size,
        ));
    }
    fn copy_texture_to_buffer(
        &self,
        source: wgpu::TexelCopyTextureInfo<'_>,
        destination: wgpu::TexelCopyBufferInfo<'_>,
        copy_size: wgpu::Extent3d,
    ) {
        self.commands.borrow_mut().push(Command::Read(
            Image::new(source),
            destination.buffer.as_custom::<Buffer>().unwrap().clone(),
            destination.layout,
            copy_size,
        ));
    }
    fn copy_texture_to_texture(
        &self,
        source: wgpu::TexelCopyTextureInfo<'_>,
        destination: wgpu::TexelCopyTextureInfo<'_>,
        copy_size: wgpu::Extent3d,
    ) {
        self.commands.borrow_mut().push(Command::TextureCopy(Image::new(source), Image::new(destination), copy_size));
    }
    fn begin_compute_pass(&self, _desc: &wgpu::ComputePassDescriptor<'_>) -> DispatchComputePass {
        report(&self.state, "run compute passes");
        DispatchComputePass::custom(Unsupported)
    }
    fn begin_render_pass(&self, desc: &wgpu::RenderPassDescriptor<'_>) -> DispatchRenderPass {
        DispatchRenderPass::custom(Pass::new(self, desc))
    }
    fn finish(&mut self) -> DispatchCommandBuffer {
        DispatchCommandBuffer::custom(Commands(RefCell::new(std::mem::take(&mut *self.commands.borrow_mut()))))
    }
    fn clear_texture(&self, _texture: &DispatchTexture, _subresource_range: &wgpu::ImageSubresourceRange) {
        report(&self.state, "clear a texture outside a render pass");
    }
    fn clear_buffer(&self, buffer: &DispatchBuffer, offset: wgpu::BufferAddress, size: Option<wgpu::BufferAddress>) {
        self.commands.borrow_mut().push(Command::Clear(
            buffer.as_custom::<Buffer>().unwrap().clone(),
            offset,
            size.unwrap_or(buffer.as_custom::<Buffer>().unwrap().0.size - offset),
        ));
    }
    fn insert_debug_marker(&self, _label: &str) {}
    fn push_debug_group(&self, _label: &str) {}
    fn pop_debug_group(&self) {}
    fn write_timestamp(&self, _query_set: &DispatchQuerySet, _query_index: u32) {
        report(&self.state, "write timestamps");
    }
    fn resolve_query_set(
        &self,
        _query_set: &DispatchQuerySet,
        _first_query: u32,
        _query_count: u32,
        _destination: &DispatchBuffer,
        _destination_offset: wgpu::BufferAddress,
    ) {
        report(&self.state, "resolve query sets");
    }
    fn mark_acceleration_structures_built<'a>(
        &self,
        _blas: &mut dyn Iterator<Item = &'a wgpu::Blas>,
        _tlas: &mut dyn Iterator<Item = &'a wgpu::Tlas>,
    ) {
        report(&self.state, "build acceleration structures");
    }
    fn build_acceleration_structures<'a>(
        &self,
        _blas: &mut dyn Iterator<Item = &'a wgpu::BlasBuildEntry<'a>>,
        _tlas: &mut dyn Iterator<Item = &'a wgpu::Tlas>,
    ) {
        report(&self.state, "build acceleration structures");
    }
    fn transition_resources<'a>(
        &mut self,
        buffer_transitions: &mut dyn Iterator<Item = wgpu_types::BufferTransition<&'a DispatchBuffer>>,
        texture_transitions: &mut dyn Iterator<Item = wgpu_types::TextureTransition<&'a DispatchTexture>>,
    ) {
        for _ in buffer_transitions {}
        for _ in texture_transitions {}
    }
}
impl RenderPassInterface for Pass {
    fn set_pipeline(&mut self, pipeline: &DispatchRenderPipeline) {
        self.push(Draw::Pipeline(pipeline.as_custom::<Pipeline>().unwrap().clone()));
    }
    fn set_bind_group(&mut self, index: u32, bind_group: Option<&DispatchBindGroup>, offsets: &[wgpu::DynamicOffset]) {
        self.push(Draw::Group(index, bind_group.map(|g| g.as_custom::<Group>().unwrap().clone()), offsets.to_vec()));
    }
    fn set_index_buffer(
        &mut self,
        buffer: &DispatchBuffer,
        index_format: wgpu::IndexFormat,
        offset: wgpu::BufferAddress,
        size: Option<wgpu::BufferSize>,
    ) {
        self.push(Draw::Index(super::vertex::Slice::new(buffer, offset, size), index_format));
    }
    fn set_vertex_buffer(
        &mut self,
        slot: u32,
        buffer: Option<&DispatchBuffer>,
        offset: wgpu::BufferAddress,
        size: Option<wgpu::BufferSize>,
    ) {
        self.push(Draw::Vertex(slot, buffer.map(|buffer| super::vertex::Slice::new(buffer, offset, size))));
    }
    fn set_immediates(&mut self, _offset: u32, _data: &[u8]) {
        report(&self.state, "set immediates");
    }
    fn set_blend_constant(&mut self, color: wgpu::Color) {
        self.push(Draw::Blend(color));
    }
    fn set_scissor_rect(&mut self, x: u32, y: u32, width: u32, height: u32) {
        self.push(Draw::Scissor(x, y, width, height));
    }
    fn set_viewport(&mut self, x: f32, y: f32, width: f32, height: f32, min_depth: f32, max_depth: f32) {
        self.push(Draw::Viewport(x, y, width, height, min_depth, max_depth));
    }
    fn set_stencil_reference(&mut self, _reference: u32) {
        report(&self.state, "test stencils");
    }
    fn draw(&mut self, vertices: Range<u32>, instances: Range<u32>) {
        self.push(Draw::Vertices(vertices, instances));
    }
    fn draw_indexed(&mut self, indices: Range<u32>, base_vertex: i32, instances: Range<u32>) {
        if base_vertex != 0 {
            report(&self.state, "offset indexed draws by a base vertex");
            return;
        }
        self.push(Draw::Indexed(indices, instances));
    }
    fn draw_mesh_tasks(&mut self, _group_count_x: u32, _group_count_y: u32, _group_count_z: u32) {
        report(&self.state, "draw mesh tasks");
    }
    fn draw_indirect(&mut self, _indirect_buffer: &DispatchBuffer, _indirect_offset: wgpu::BufferAddress) {
        report(&self.state, "draw indirectly");
    }
    fn draw_indexed_indirect(&mut self, _indirect_buffer: &DispatchBuffer, _indirect_offset: wgpu::BufferAddress) {
        report(&self.state, "draw indirectly");
    }
    fn draw_mesh_tasks_indirect(&mut self, _indirect_buffer: &DispatchBuffer, _indirect_offset: wgpu::BufferAddress) {
        report(&self.state, "draw mesh tasks");
    }
    fn multi_draw_indirect(
        &mut self,
        _indirect_buffer: &DispatchBuffer,
        _indirect_offset: wgpu::BufferAddress,
        _count: u32,
    ) {
        report(&self.state, "draw indirectly");
    }
    fn multi_draw_indexed_indirect(
        &mut self,
        _indirect_buffer: &DispatchBuffer,
        _indirect_offset: wgpu::BufferAddress,
        _count: u32,
    ) {
        report(&self.state, "draw indirectly");
    }
    fn multi_draw_indirect_count(
        &mut self,
        _indirect_buffer: &DispatchBuffer,
        _indirect_offset: wgpu::BufferAddress,
        _count_buffer: &DispatchBuffer,
        _count_buffer_offset: wgpu::BufferAddress,
        _max_count: u32,
    ) {
        report(&self.state, "draw indirectly");
    }
    fn multi_draw_mesh_tasks_indirect(
        &mut self,
        _indirect_buffer: &DispatchBuffer,
        _indirect_offset: wgpu::BufferAddress,
        _count: u32,
    ) {
        report(&self.state, "draw mesh tasks");
    }
    fn multi_draw_indexed_indirect_count(
        &mut self,
        _indirect_buffer: &DispatchBuffer,
        _indirect_offset: wgpu::BufferAddress,
        _count_buffer: &DispatchBuffer,
        _count_buffer_offset: wgpu::BufferAddress,
        _max_count: u32,
    ) {
        report(&self.state, "draw indirectly");
    }
    fn multi_draw_mesh_tasks_indirect_count(
        &mut self,
        _indirect_buffer: &DispatchBuffer,
        _indirect_offset: wgpu::BufferAddress,
        _count_buffer: &DispatchBuffer,
        _count_buffer_offset: wgpu::BufferAddress,
        _max_count: u32,
    ) {
        report(&self.state, "draw mesh tasks");
    }
    fn insert_debug_marker(&mut self, _label: &str) {}
    fn push_debug_group(&mut self, _group_label: &str) {}
    fn pop_debug_group(&mut self) {}
    fn write_timestamp(&mut self, _query_set: &DispatchQuerySet, _query_index: u32) {
        report(&self.state, "write timestamps");
    }
    fn begin_occlusion_query(&mut self, _query_index: u32) {
        report(&self.state, "count occluded samples");
    }
    fn end_occlusion_query(&mut self) {
        report(&self.state, "count occluded samples");
    }
    fn begin_pipeline_statistics_query(&mut self, _query_set: &DispatchQuerySet, _query_index: u32) {
        report(&self.state, "count pipeline statistics");
    }
    fn end_pipeline_statistics_query(&mut self) {
        report(&self.state, "count pipeline statistics");
    }
    fn execute_bundles(&mut self, render_bundles: &mut dyn Iterator<Item = &DispatchRenderBundle>) {
        let draws = &mut self.render.as_mut().expect("active render pass").draws;
        for bundle in render_bundles {
            draws.push(Draw::Reset);
            draws.extend(bundle.as_custom::<Bundle>().expect("WebGL2 render bundle").0.iter().cloned());
        }
        draws.push(Draw::Reset);
    }
}

#[derive(Debug)]
struct Bundle(Vec<Draw>);
impl wgpu::custom::RenderBundleInterface for Bundle {}

// A bundle records precisely the same draw commands as a render pass.
impl wgpu::custom::RenderBundleEncoderInterface for Pass {
    fn set_pipeline(&mut self, pipeline: &DispatchRenderPipeline) {
        RenderPassInterface::set_pipeline(self, pipeline);
    }
    fn set_bind_group(&mut self, index: u32, group: Option<&DispatchBindGroup>, offsets: &[u32]) {
        RenderPassInterface::set_bind_group(self, index, group, offsets);
    }
    fn set_index_buffer(
        &mut self,
        buffer: &DispatchBuffer,
        format: wgpu::IndexFormat,
        offset: u64,
        size: Option<wgpu::BufferSize>,
    ) {
        RenderPassInterface::set_index_buffer(self, buffer, format, offset, size);
    }
    fn set_vertex_buffer(
        &mut self,
        slot: u32,
        buffer: Option<&DispatchBuffer>,
        offset: u64,
        size: Option<wgpu::BufferSize>,
    ) {
        RenderPassInterface::set_vertex_buffer(self, slot, buffer, offset, size);
    }
    fn set_immediates(&mut self, offset: u32, data: &[u8]) {
        RenderPassInterface::set_immediates(self, offset, data);
    }
    fn draw(&mut self, vertices: Range<u32>, instances: Range<u32>) {
        RenderPassInterface::draw(self, vertices, instances);
    }
    fn draw_indexed(&mut self, indices: Range<u32>, base_vertex: i32, instances: Range<u32>) {
        RenderPassInterface::draw_indexed(self, indices, base_vertex, instances);
    }
    fn draw_indirect(&mut self, buffer: &DispatchBuffer, offset: u64) {
        RenderPassInterface::draw_indirect(self, buffer, offset);
    }
    fn draw_indexed_indirect(&mut self, buffer: &DispatchBuffer, offset: u64) {
        RenderPassInterface::draw_indexed_indirect(self, buffer, offset);
    }
    fn finish(mut self, _: &wgpu::RenderBundleDescriptor<'_>) -> DispatchRenderBundle {
        DispatchRenderBundle::custom(Bundle(self.render.take().expect("active render bundle").draws))
    }
    fn finish_boxed(self: Box<Self>, desc: &wgpu::RenderBundleDescriptor<'_>) -> DispatchRenderBundle {
        wgpu::custom::RenderBundleEncoderInterface::finish(*self, desc)
    }
}
