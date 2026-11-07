//! Vertex inputs, including integer attributes and instance offsets.
use super::resource::Buffer;
use web_sys::{WebGl2RenderingContext as Gl, WebGlVertexArrayObject};

#[derive(Clone, Default, Debug)]
pub(super) struct Layout {
    stride: u64,
    step: wgpu::VertexStepMode,
    attributes: Vec<wgpu::VertexAttribute>,
}

impl Layout {
    pub(super) fn new(layout: Option<&wgpu::VertexBufferLayout<'_>>) -> Self {
        let Some(layout) = layout else {
            return Self::default();
        };
        Self { stride: layout.array_stride, step: layout.step_mode, attributes: layout.attributes.to_vec() }
    }
}

#[derive(Clone, Debug)]
pub(super) struct Slice {
    pub(super) buffer: Buffer,
    pub(super) offset: u64,
    pub(super) size: u64,
}
impl Slice {
    pub(super) fn new(buffer: &wgpu::custom::DispatchBuffer, offset: u64, size: Option<wgpu::BufferSize>) -> Self {
        let buffer = buffer.as_custom::<Buffer>().expect("WebGL2 buffer").clone();
        let size = size.map_or(buffer.0.size - offset, std::num::NonZeroU64::get);
        assert!(offset.checked_add(size).is_some_and(|end| end <= buffer.0.size), "buffer slice out of bounds");
        Self { buffer, offset, size }
    }
}

/// The VAO is needed only by pipelines with attributes or an index buffer. Ordinary latkit
/// draws use vertex/instance indices, so they allocate no additional objects.
pub(super) struct Inputs<'a> {
    gl: &'a Gl,
    vao: Option<WebGlVertexArrayObject>,
    enabled: u32,
    pub(super) vertices: [Option<Slice>; 16],
    pub(super) index: Option<(Slice, wgpu::IndexFormat)>,
}
impl<'a> Inputs<'a> {
    pub(super) fn new(gl: &'a Gl) -> Self {
        Self { gl, vao: None, enabled: 0, vertices: std::array::from_fn(|_| None), index: None }
    }

    pub(super) fn bind(&mut self, layouts: &[Layout], first_instance: u32) {
        if self.vao.is_none() && (!layouts.is_empty() || self.index.is_some()) {
            self.vao = Some(self.gl.create_vertex_array().expect("WebGL2 vertex array allocation"));
            self.gl.bind_vertex_array(self.vao.as_ref());
        }
        let mut enabled = 0;
        for (slot, layout) in layouts.iter().enumerate() {
            if layout.attributes.is_empty() {
                continue;
            }
            let input = self.vertices[slot].as_ref().expect("vertex buffer is bound");
            self.gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&input.buffer.0.raw));
            let instanced = layout.step == wgpu::VertexStepMode::Instance;
            let first = if instanced { u64::from(first_instance) * layout.stride } else { 0 };
            for attribute in &layout.attributes {
                let location = attribute.shader_location;
                let (components, ty, integer, normalized) = format(attribute.format);
                let offset = input.offset + first + attribute.offset;
                assert!(first + attribute.offset + attribute.format.size() <= input.size, "vertex input out of bounds");
                self.gl.enable_vertex_attrib_array(location);
                // wgpu's zero stride repeats one record; GL's zero stride means tightly
                // packed records. A divisor larger than every legal draw keeps index zero.
                self.gl
                    .vertex_attrib_divisor(location, if layout.stride == 0 { u32::MAX } else { u32::from(instanced) });
                if integer {
                    self.gl.vertex_attrib_i_pointer_with_f64(
                        location,
                        components,
                        ty,
                        layout.stride as i32,
                        offset as f64,
                    );
                } else {
                    self.gl.vertex_attrib_pointer_with_f64(
                        location,
                        components,
                        ty,
                        normalized,
                        layout.stride as i32,
                        offset as f64,
                    );
                }
                enabled |= 1 << location;
            }
        }
        let mut disabled = self.enabled & !enabled;
        while disabled != 0 {
            let location = disabled.trailing_zeros();
            self.gl.disable_vertex_attrib_array(location);
            disabled &= !(1 << location);
        }
        self.enabled = enabled;
        if let Some((index, _)) = &self.index {
            self.gl.bind_buffer(Gl::ELEMENT_ARRAY_BUFFER, Some(&index.buffer.0.raw));
        }
    }
}
impl Drop for Inputs<'_> {
    fn drop(&mut self) {
        if self.vao.is_some() {
            self.gl.bind_vertex_array(None);
            self.gl.bind_buffer(Gl::ARRAY_BUFFER, None);
            self.gl.delete_vertex_array(self.vao.as_ref());
        }
    }
}

fn format(format: wgpu::VertexFormat) -> (i32, u32, bool, bool) {
    use wgpu::VertexFormat as F;
    let (bytes, ty, integer, normalized) = match format {
        F::Uint8 | F::Uint8x2 | F::Uint8x4 => (1, Gl::UNSIGNED_BYTE, true, false),
        F::Sint8 | F::Sint8x2 | F::Sint8x4 => (1, Gl::BYTE, true, false),
        F::Unorm8 | F::Unorm8x2 | F::Unorm8x4 => (1, Gl::UNSIGNED_BYTE, false, true),
        F::Snorm8 | F::Snorm8x2 | F::Snorm8x4 => (1, Gl::BYTE, false, true),
        F::Uint16 | F::Uint16x2 | F::Uint16x4 => (2, Gl::UNSIGNED_SHORT, true, false),
        F::Sint16 | F::Sint16x2 | F::Sint16x4 => (2, Gl::SHORT, true, false),
        F::Unorm16 | F::Unorm16x2 | F::Unorm16x4 => (2, Gl::UNSIGNED_SHORT, false, true),
        F::Snorm16 | F::Snorm16x2 | F::Snorm16x4 => (2, Gl::SHORT, false, true),
        F::Float16 | F::Float16x2 | F::Float16x4 => (2, Gl::HALF_FLOAT, false, false),
        F::Float32 | F::Float32x2 | F::Float32x3 | F::Float32x4 => (4, Gl::FLOAT, false, false),
        F::Uint32 | F::Uint32x2 | F::Uint32x3 | F::Uint32x4 => (4, Gl::UNSIGNED_INT, true, false),
        F::Sint32 | F::Sint32x2 | F::Sint32x3 | F::Sint32x4 => (4, Gl::INT, true, false),
        F::Unorm10_10_10_2 => return (4, Gl::UNSIGNED_INT_2_10_10_10_REV, false, true),
        _ => panic!("vertex format {format:?} is unavailable in WebGL2"),
    };
    ((format.size() / bytes) as i32, ty, integer, normalized)
}
