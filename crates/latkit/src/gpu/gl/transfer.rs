//! Texture transfers share one layout; CPU writes need no temporary GPU buffer.
use super::{command::Image, resource::Buffer};
use web_sys::WebGl2RenderingContext as Gl;

#[derive(Clone, Copy)]
pub(super) enum Source<'a> {
    Buffer(&'a Buffer),
    Bytes(&'a [u8]),
}

pub(super) fn upload(
    gl: &Gl,
    source: Source<'_>,
    layout: wgpu::TexelCopyBufferLayout,
    to: &Image,
    size: wgpu::Extent3d,
) {
    let texture = &to.texture.0;
    let format = texture.format;
    gl.bind_texture(texture.target, texture.raw.as_ref());
    gl.pixel_storei(Gl::UNPACK_ALIGNMENT, 1);
    gl.pixel_storei(Gl::UNPACK_ROW_LENGTH, layout.bytes_per_row.map_or(0, |b| b / format.bytes) as i32);
    gl.pixel_storei(Gl::UNPACK_IMAGE_HEIGHT, layout.rows_per_image.unwrap_or(0) as i32);
    let result = match source {
        Source::Buffer(buffer) => {
            gl.bind_buffer(Gl::PIXEL_UNPACK_BUFFER, Some(&buffer.0.raw));
            if texture.target == Gl::TEXTURE_2D_ARRAY {
                gl.tex_sub_image_3d_with_i32(
                    texture.target,
                    to.level as i32,
                    to.origin.x as i32,
                    to.origin.y as i32,
                    to.origin.z as i32,
                    size.width as i32,
                    size.height as i32,
                    size.depth_or_array_layers as i32,
                    format.external,
                    format.ty,
                    layout.offset as i32,
                )
            } else {
                gl.tex_sub_image_2d_with_i32_and_i32_and_u32_and_type_and_i32(
                    texture.target,
                    to.level as i32,
                    to.origin.x as i32,
                    to.origin.y as i32,
                    size.width as i32,
                    size.height as i32,
                    format.external,
                    format.ty,
                    layout.offset as i32,
                )
            }
        }
        Source::Bytes(bytes) => {
            gl.bind_buffer(Gl::PIXEL_UNPACK_BUFFER, None);
            let bytes = &bytes[layout.offset as usize..];
            // No Rust allocation or callback can grow WASM memory while this view is live.
            // WebGL consumes the bytes synchronously; it never retains this view.
            let view = unsafe { js_sys::Uint8Array::view(bytes) };
            let data: js_sys::Object = match format.ty {
                Gl::UNSIGNED_BYTE => view.into(),
                Gl::UNSIGNED_INT | Gl::FLOAT => {
                    // A caller's byte slice need not have a typed array's alignment.
                    let aligned =
                        if view.byte_offset().is_multiple_of(4) { view } else { js_sys::Uint8Array::new(&view) };
                    let buffer = aligned.buffer();
                    let offset = aligned.byte_offset();
                    let length = aligned.length() / 4;
                    if format.ty == Gl::FLOAT {
                        js_sys::Float32Array::new_with_byte_offset_and_length(&buffer, offset, length).into()
                    } else {
                        js_sys::Uint32Array::new_with_byte_offset_and_length(&buffer, offset, length).into()
                    }
                }
                _ => unreachable!("texture format has a typed upload representation"),
            };
            if texture.target == Gl::TEXTURE_2D_ARRAY {
                gl.tex_sub_image_3d_with_opt_array_buffer_view(
                    texture.target,
                    to.level as i32,
                    to.origin.x as i32,
                    to.origin.y as i32,
                    to.origin.z as i32,
                    size.width as i32,
                    size.height as i32,
                    size.depth_or_array_layers as i32,
                    format.external,
                    format.ty,
                    Some(&data),
                )
            } else {
                gl.tex_sub_image_2d_with_i32_and_i32_and_u32_and_type_and_opt_array_buffer_view(
                    texture.target,
                    to.level as i32,
                    to.origin.x as i32,
                    to.origin.y as i32,
                    size.width as i32,
                    size.height as i32,
                    format.external,
                    format.ty,
                    Some(&data),
                )
            }
        }
    };
    gl.pixel_storei(Gl::UNPACK_ROW_LENGTH, 0);
    gl.pixel_storei(Gl::UNPACK_IMAGE_HEIGHT, 0);
    gl.bind_buffer(Gl::PIXEL_UNPACK_BUFFER, None);
    result.expect("valid texture upload");
}
