use super::{device::State, waits::Waits};
use std::{
    cell::{Cell, RefCell},
    ops::Range,
    rc::{Rc, Weak},
};
use web_sys::{WebGl2RenderingContext as Gl, WebGlBuffer, WebGlRenderbuffer, WebGlSampler, WebGlTexture};
use wgpu::custom::{
    BindGroupInterface, BindGroupLayoutInterface, BufferInterface, BufferMapCallback, BufferMappedRangeInterface,
    DispatchBufferMappedRange, DispatchTextureView, PipelineLayoutInterface, SamplerInterface, TextureInterface,
    TextureViewInterface,
};

#[derive(Debug, Clone)]
pub(super) struct Buffer(pub(super) Rc<BufferData>);
type Mapping = (Range<u64>, wgpu::MapMode, Rc<Vec<u8>>);
#[derive(Debug)]
pub(super) struct BufferData {
    pub(super) gl: Gl,
    state: Weak<State>,
    pub(super) raw: WebGlBuffer,
    pub(super) size: u64,
    mapped: RefCell<Option<Mapping>>,
    generation: Cell<u64>,
    destroyed: Cell<bool>,
}
impl Buffer {
    pub(super) fn new(state: &Rc<State>, desc: &wgpu::BufferDescriptor<'_>) -> Self {
        let gl = &state.gl;
        let raw = gl.create_buffer().expect("WebGL buffer allocation");
        // WebGL permanently classifies a buffer at its first binding. Index buffers must
        // enter the element class before COPY_WRITE_BUFFER is used to allocate or fill them.
        if desc.usage.contains(wgpu::BufferUsages::INDEX) {
            gl.bind_buffer(Gl::ELEMENT_ARRAY_BUFFER, Some(&raw));
            gl.bind_buffer(Gl::ELEMENT_ARRAY_BUFFER, None);
        }
        gl.bind_buffer(Gl::COPY_WRITE_BUFFER, Some(&raw));
        // Firefox stalls reading back a buffer not made for reading.
        let hint = if desc.usage.contains(wgpu::BufferUsages::MAP_READ) { Gl::STREAM_READ } else { Gl::DYNAMIC_COPY };
        gl.buffer_data_with_f64(Gl::COPY_WRITE_BUFFER, desc.size as f64, hint);
        let mapped =
            desc.mapped_at_creation.then(|| (0..desc.size, wgpu::MapMode::Write, Rc::new(vec![0; desc.size as usize])));
        Self(Rc::new(BufferData {
            gl: gl.clone(),
            state: Rc::downgrade(state),
            raw,
            size: desc.size,
            mapped: RefCell::new(mapped),
            generation: Cell::new(0),
            destroyed: Cell::new(false),
        }))
    }
    pub(super) fn write(&self, offset: u64, bytes: &[u8]) {
        assert!(!self.0.destroyed.get() && offset + bytes.len() as u64 <= self.0.size);
        self.0.gl.bind_buffer(Gl::COPY_WRITE_BUFFER, Some(&self.0.raw));
        self.0.gl.buffer_sub_data_with_f64_and_u8_array(Gl::COPY_WRITE_BUFFER, offset as f64, bytes);
    }

    /// A browser mapping already owns CPU bytes. An exclusive internal readback can move
    /// them to its consumer instead of copying an entire image a second time.
    pub(super) fn take_read(&self, size: u64) -> Option<Vec<u8>> {
        let mut mapped = self.0.mapped.borrow_mut();
        let (range, mode, bytes) = mapped.as_ref()?;
        if *mode != wgpu::MapMode::Read || *range != (0..size) || Rc::strong_count(bytes) != 1 {
            return None;
        }
        let (_, _, bytes) = mapped.take().expect("checked mapping");
        Some(Rc::try_unwrap(bytes).expect("exclusive read mapping"))
    }
}
impl Drop for BufferData {
    fn drop(&mut self) {
        self.gl.delete_buffer(Some(&self.raw));
    }
}
impl BufferInterface for Buffer {
    fn map_async(&self, mode: wgpu::MapMode, range: Range<u64>, callback: BufferMapCallback) {
        assert!(range.end <= self.0.size);
        let this = self.clone();
        let generation = self.0.generation.get();
        let Some(state) = self.0.state.upgrade() else {
            callback(Err(wgpu::BufferAsyncError));
            return;
        };
        Waits::fence(&state, move |state, signaled| {
            if !signaled || this.0.destroyed.get() || this.0.generation.get() != generation {
                callback(Err(wgpu::BufferAsyncError));
                return;
            }
            let mut bytes = vec![0; (range.end - range.start) as usize];
            if mode == wgpu::MapMode::Read {
                state.gl.bind_buffer(Gl::COPY_READ_BUFFER, Some(&this.0.raw));
                state.gl.get_buffer_sub_data_with_f64_and_u8_array(
                    Gl::COPY_READ_BUFFER,
                    range.start as f64,
                    &mut bytes,
                );
            }
            *this.0.mapped.borrow_mut() = Some((range, mode, Rc::new(bytes)));
            callback(Ok(()));
        });
    }
    fn get_mapped_range(&self, sub_range: Range<u64>) -> Result<DispatchBufferMappedRange, wgpu::MapRangeError> {
        let mapped = self.0.mapped.borrow();
        let (range, mode, bytes) = mapped.as_ref().expect("buffer must be mapped");
        assert!(sub_range.start >= range.start && sub_range.end <= range.end);
        let range = (sub_range.start - range.start) as usize..(sub_range.end - range.start) as usize;
        let data = if *mode == wgpu::MapMode::Write {
            MappedData::Write(bytes[range].to_vec())
        } else {
            MappedData::Read(bytes.clone(), range)
        };
        Ok(DispatchBufferMappedRange::custom(Mapped { buffer: self.clone(), offset: sub_range.start, data }))
    }
    fn unmap(&self) {
        self.0.generation.set(self.0.generation.get() + 1);
        if let Some((range, wgpu::MapMode::Write, bytes)) = self.0.mapped.borrow_mut().take() {
            self.write(range.start, &bytes);
        }
    }
    fn destroy(&self) {
        self.unmap();
        self.0.destroyed.set(true);
        self.0.gl.delete_buffer(Some(&self.0.raw));
    }
}
#[derive(Debug)]
enum MappedData {
    Read(Rc<Vec<u8>>, Range<usize>),
    Write(Vec<u8>),
}
#[derive(Debug)]
struct Mapped {
    buffer: Buffer,
    offset: u64,
    data: MappedData,
}
impl BufferMappedRangeInterface for Mapped {
    fn len(&self) -> usize {
        match &self.data {
            MappedData::Read(_, range) => range.len(),
            MappedData::Write(bytes) => bytes.len(),
        }
    }
    unsafe fn read_slice(&self) -> &[u8] {
        match &self.data {
            MappedData::Read(bytes, range) => &bytes[range.clone()],
            MappedData::Write(_) => panic!("read of a write mapping"),
        }
    }
    unsafe fn write_slice(&mut self) -> wgpu::WriteOnly<'_, [u8]> {
        match &mut self.data {
            MappedData::Write(bytes) => wgpu::WriteOnly::from(&mut bytes[..]),
            MappedData::Read(..) => panic!("write of a read mapping"),
        }
    }
}
impl Drop for Mapped {
    fn drop(&mut self) {
        if let MappedData::Write(written) = &self.data {
            let mut mapped = self.buffer.0.mapped.borrow_mut();
            let (range, _, bytes) = mapped.as_mut().expect("mapped range outlives mapping");
            let start = (self.offset - range.start) as usize;
            Rc::get_mut(bytes).expect("write mapping has exclusive data")[start..start + written.len()]
                .copy_from_slice(written);
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct Format {
    pub(super) internal: u32,
    pub(super) external: u32,
    pub(super) ty: u32,
    pub(super) bytes: u32,
    pub(super) integer: bool,
    pub(super) depth: bool,
}
impl Format {
    pub(super) fn new(format: wgpu::TextureFormat) -> Self {
        let (internal, external, ty, bytes, integer, depth) = match format {
            wgpu::TextureFormat::Rgba8Unorm => (Gl::RGBA8, Gl::RGBA, Gl::UNSIGNED_BYTE, 4, false, false),
            wgpu::TextureFormat::R8Unorm => (Gl::R8, Gl::RED, Gl::UNSIGNED_BYTE, 1, false, false),
            wgpu::TextureFormat::R32Uint => (Gl::R32UI, Gl::RED_INTEGER, Gl::UNSIGNED_INT, 4, true, false),
            wgpu::TextureFormat::Rgba32Uint => (Gl::RGBA32UI, Gl::RGBA_INTEGER, Gl::UNSIGNED_INT, 16, true, false),
            wgpu::TextureFormat::Depth32Float => {
                (Gl::DEPTH_COMPONENT32F, Gl::DEPTH_COMPONENT, Gl::FLOAT, 4, false, true)
            }
            _ => panic!("unsupported texture format {format:?}"),
        };
        Self { internal, external, ty, bytes, integer, depth }
    }
}
#[derive(Debug, Clone)]
pub(super) struct Texture(pub(super) Rc<TextureData>);
#[derive(Debug)]
pub(super) struct TextureData {
    pub(super) gl: Gl,
    pub(super) raw: Option<WebGlTexture>,
    pub(super) renderbuffer: Option<WebGlRenderbuffer>,
    pub(super) target: u32,
    pub(super) size: wgpu::Extent3d,
    pub(super) format: Format,
    pub(super) samples: u32,
}
impl Texture {
    pub(super) fn new(gl: &Gl, desc: &wgpu::TextureDescriptor<'_>) -> Self {
        let target = if desc.size.depth_or_array_layers > 1 { Gl::TEXTURE_2D_ARRAY } else { Gl::TEXTURE_2D };
        Self::with_target(gl, desc, target)
    }

    pub(super) fn with_target(gl: &Gl, desc: &wgpu::TextureDescriptor<'_>, target: u32) -> Self {
        assert_eq!(desc.dimension, wgpu::TextureDimension::D2);
        let format = Format::new(desc.format);
        let (raw, renderbuffer) = if desc.sample_count > 1 {
            assert_eq!(desc.size.depth_or_array_layers, 1);
            assert_eq!(target, Gl::TEXTURE_2D);
            let rb = gl.create_renderbuffer().expect("renderbuffer allocation");
            gl.bind_renderbuffer(Gl::RENDERBUFFER, Some(&rb));
            gl.renderbuffer_storage_multisample(
                Gl::RENDERBUFFER,
                desc.sample_count as i32,
                format.internal,
                desc.size.width as i32,
                desc.size.height as i32,
            );
            (None, Some(rb))
        } else {
            let raw = gl.create_texture().expect("texture allocation");
            gl.bind_texture(target, Some(&raw));
            if target == Gl::TEXTURE_2D_ARRAY {
                gl.tex_storage_3d(
                    target,
                    desc.mip_level_count as i32,
                    format.internal,
                    desc.size.width as i32,
                    desc.size.height as i32,
                    desc.size.depth_or_array_layers as i32,
                );
            } else {
                gl.tex_storage_2d(
                    target,
                    desc.mip_level_count as i32,
                    format.internal,
                    desc.size.width as i32,
                    desc.size.height as i32,
                );
            }
            gl.tex_parameteri(target, Gl::TEXTURE_MIN_FILTER, Gl::NEAREST as i32);
            gl.tex_parameteri(target, Gl::TEXTURE_MAG_FILTER, Gl::NEAREST as i32);
            gl.tex_parameteri(target, Gl::TEXTURE_WRAP_S, Gl::CLAMP_TO_EDGE as i32);
            gl.tex_parameteri(target, Gl::TEXTURE_WRAP_T, Gl::CLAMP_TO_EDGE as i32);
            (Some(raw), None)
        };
        Self(Rc::new(TextureData {
            gl: gl.clone(),
            raw,
            renderbuffer,
            target,
            size: desc.size,
            format,
            samples: desc.sample_count,
        }))
    }
    pub(super) fn attach(&self, target: u32, attachment: u32, level: u32, layer: u32) {
        let gl = &self.0.gl;
        if let Some(rb) = &self.0.renderbuffer {
            gl.framebuffer_renderbuffer(target, attachment, Gl::RENDERBUFFER, Some(rb));
        } else if self.0.target == Gl::TEXTURE_2D_ARRAY {
            gl.framebuffer_texture_layer(target, attachment, self.0.raw.as_ref(), level as i32, layer as i32);
        } else {
            gl.framebuffer_texture_2d(target, attachment, Gl::TEXTURE_2D, self.0.raw.as_ref(), level as i32);
        }
    }
}
impl Drop for TextureData {
    fn drop(&mut self) {
        self.gl.delete_texture(self.raw.as_ref());
        self.gl.delete_renderbuffer(self.renderbuffer.as_ref());
    }
}
impl TextureInterface for Texture {
    fn create_view(&self, desc: &wgpu::TextureViewDescriptor<'_>) -> DispatchTextureView {
        DispatchTextureView::custom(View {
            texture: self.clone(),
            level: desc.base_mip_level,
            layer: desc.base_array_layer,
        })
    }
    fn destroy(&self) {
        self.0.gl.delete_texture(self.0.raw.as_ref());
        self.0.gl.delete_renderbuffer(self.0.renderbuffer.as_ref());
    }
}
#[derive(Debug, Clone)]
pub(super) struct View {
    pub(super) texture: Texture,
    pub(super) level: u32,
    pub(super) layer: u32,
}
impl TextureViewInterface for View {}

#[derive(Debug, Clone)]
pub(super) struct Sampler(pub(super) Rc<SamplerData>);
#[derive(Debug)]
pub(super) struct SamplerData {
    pub(super) gl: Gl,
    pub(super) raw: WebGlSampler,
}
impl Sampler {
    pub(super) fn new(gl: &Gl, desc: &wgpu::SamplerDescriptor<'_>) -> Self {
        let raw = gl.create_sampler().expect("sampler allocation");
        let filter = |f| if f == wgpu::FilterMode::Linear { Gl::LINEAR } else { Gl::NEAREST };
        let wrap = |a| match a {
            wgpu::AddressMode::Repeat => Gl::REPEAT,
            wgpu::AddressMode::MirrorRepeat => Gl::MIRRORED_REPEAT,
            _ => Gl::CLAMP_TO_EDGE,
        };
        for (p, v) in [
            (
                Gl::TEXTURE_MIN_FILTER,
                match (desc.min_filter, desc.mipmap_filter) {
                    (wgpu::FilterMode::Nearest, wgpu::MipmapFilterMode::Nearest) => Gl::NEAREST_MIPMAP_NEAREST,
                    (wgpu::FilterMode::Nearest, wgpu::MipmapFilterMode::Linear) => Gl::NEAREST_MIPMAP_LINEAR,
                    (wgpu::FilterMode::Linear, wgpu::MipmapFilterMode::Nearest) => Gl::LINEAR_MIPMAP_NEAREST,
                    (wgpu::FilterMode::Linear, wgpu::MipmapFilterMode::Linear) => Gl::LINEAR_MIPMAP_LINEAR,
                },
            ),
            (Gl::TEXTURE_MAG_FILTER, filter(desc.mag_filter)),
            (Gl::TEXTURE_WRAP_S, wrap(desc.address_mode_u)),
            (Gl::TEXTURE_WRAP_T, wrap(desc.address_mode_v)),
            (Gl::TEXTURE_WRAP_R, wrap(desc.address_mode_w)),
        ] {
            gl.sampler_parameteri(&raw, p, v as i32);
        }
        gl.sampler_parameterf(&raw, Gl::TEXTURE_MIN_LOD, desc.lod_min_clamp);
        gl.sampler_parameterf(&raw, Gl::TEXTURE_MAX_LOD, desc.lod_max_clamp);
        if let Some(compare) = desc.compare {
            gl.sampler_parameteri(&raw, Gl::TEXTURE_COMPARE_MODE, Gl::COMPARE_REF_TO_TEXTURE as i32);
            gl.sampler_parameteri(&raw, Gl::TEXTURE_COMPARE_FUNC, super::command::comparison(compare) as i32);
        }
        Self(Rc::new(SamplerData { gl: gl.clone(), raw }))
    }
}
impl SamplerInterface for Sampler {}
impl Drop for SamplerData {
    fn drop(&mut self) {
        self.gl.delete_sampler(Some(&self.raw));
    }
}

#[derive(Debug, Clone)]
pub(super) struct Layout(pub(super) Vec<wgpu::BindGroupLayoutEntry>);
impl BindGroupLayoutInterface for Layout {}
#[derive(Debug, Clone)]
pub(super) struct PipelineLayout(pub(super) Vec<Layout>);
impl PipelineLayoutInterface for PipelineLayout {}
#[derive(Debug, Clone)]
pub(super) enum Binding {
    Buffer(Buffer, u64, u64, bool),
    Texture(View),
    Sampler(Sampler),
}
#[derive(Debug, Clone)]
pub(super) struct Group(pub(super) Rc<Vec<(u32, Binding)>>);
impl BindGroupInterface for Group {}
impl Group {
    pub(super) fn new(desc: &wgpu::BindGroupDescriptor<'_>) -> Self {
        let layout = desc.layout.as_custom::<Layout>().unwrap();
        let mut bindings: Vec<_> = desc
            .entries
            .iter()
            .map(|e| {
                (
                    e.binding,
                    match e.resource {
                        wgpu::BindingResource::Buffer(ref b) => {
                            let raw = b.buffer.as_custom::<Buffer>().unwrap();
                            let dynamic = layout.0.iter().any(|l| {
                                l.binding == e.binding
                                    && matches!(l.ty, wgpu::BindingType::Buffer { has_dynamic_offset: true, .. })
                            });
                            Binding::Buffer(
                                raw.clone(),
                                b.offset,
                                b.size.map_or(raw.0.size - b.offset, std::num::NonZeroU64::get),
                                dynamic,
                            )
                        }
                        wgpu::BindingResource::TextureView(v) => {
                            Binding::Texture(v.as_custom::<View>().unwrap().clone())
                        }
                        wgpu::BindingResource::Sampler(s) => {
                            Binding::Sampler(s.as_custom::<Sampler>().unwrap().clone())
                        }
                        _ => panic!("unsupported binding resource"),
                    },
                )
            })
            .collect();
        bindings.sort_unstable_by_key(|(binding, _)| *binding);
        Self(Rc::new(bindings))
    }
}
