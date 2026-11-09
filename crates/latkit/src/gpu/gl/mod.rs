//! Browser driver for the shared raster renderer, through wgpu's supported custom interface.
//! Shader linking is asynchronous; resource and command ownership stay in Rust.
#![allow(
    unsafe_code,
    reason = "wgpu's custom traits include unsafe signatures and a guaranteed-live browser canvas handle"
)]
mod bindings;
mod command;
mod device;
mod elapsed;
mod host;
mod pipeline;
mod queue;
mod resource;
mod transfer;
mod unsupported;
mod vertex;
mod waits;

pub(crate) use elapsed::{Elapsed, disjoint};

pub(crate) fn instance(gl: web_sys::WebGl2RenderingContext) -> crate::Result<wgpu::Instance> {
    let device = device::Device::new(gl)
        .map_err(|e| crate::Error::Unsupported(format!("WebGL2 initialization failed: {e:?}").into()))?;
    Ok(wgpu::Instance::from_custom(host::Instance(device)))
}

/// Whether `device` is latkit's WebGL2 device, which takes the GLSL the build translated.
pub(crate) fn owns(device: &wgpu::Device) -> bool {
    device.as_custom::<device::Device>().is_some()
}

/// Yields to the next browser task, where WebGL fences and queries advance.
async fn turn() {
    crate::time::next_task().await;
}

pub(crate) fn take_read(buffer: &wgpu::Buffer, size: u64) -> Option<Vec<u8>> {
    buffer.as_custom::<resource::Buffer>()?.take_read(size)
}

/// Word stores remain array textures even when only their first layer is allocated.
/// The public descriptor has no array target, so choose it before allocating storage.
pub(crate) fn array_texture(device: &wgpu::Device, desc: &wgpu::TextureDescriptor<'_>) -> wgpu::Texture {
    let Some(device) = device.as_custom::<device::Device>() else {
        // An application-owned wgpu device may infer the array target from its layer count.
        let mut desc = desc.clone();
        desc.size.depth_or_array_layers = desc.size.depth_or_array_layers.max(2);
        return device.create_texture(&desc);
    };
    let texture = resource::Texture::with_target(&device.0.gl, desc, web_sys::WebGl2RenderingContext::TEXTURE_2D_ARRAY);
    device.changed();
    wgpu::Texture::from_custom(texture, desc)
}

/// Presents `source` in `sink` through `canvas`, the context's own canvas, as `show` does.
pub(crate) fn present(
    queue: &wgpu::Queue,
    source: &wgpu::Texture,
    canvas: &super::browser::Canvas,
    sink: &super::browser::Sink,
) -> crate::Result<()> {
    let other = || crate::Error::Unsupported("presentation texture belongs to another GPU".into());
    let texture = source.as_custom::<resource::Texture>().ok_or_else(other)?;
    let queue = queue.as_custom::<queue::Queue>().ok_or_else(other)?;
    show(&queue.state, texture, canvas, sink)
}

/// Blits `texture` to `canvas`, fences the frame, then copies it into `sink`. The fence comes
/// before the copy so a wait after the frame can join it (see [`waits`]).
fn show(
    state: &device::State,
    texture: &resource::Texture,
    canvas: &super::browser::Canvas,
    sink: &super::browser::Sink,
) -> crate::Result<()> {
    blit(texture, canvas)?;
    waits::Waits::presented(state);
    let size = texture.0.size;
    sink.copy(canvas, [size.width, size.height])
}

fn blit(texture: &resource::Texture, canvas: &super::browser::Canvas) -> crate::Result<()> {
    use web_sys::WebGl2RenderingContext as Gl;
    let gl = &texture.0.gl;
    if gl.is_context_lost() {
        return Err(crate::Error::Unsupported("WebGL2 context is lost".into()));
    }
    let size = texture.0.size;
    // The caller reserved room for the texture, so the canvas never resizes while presenting.
    let extent = canvas.size();
    if size.width > extent[0] || size.height > extent[1] {
        return Err(crate::Error::Unsupported("the presentation texture is larger than the WebGL2 canvas".into()));
    }
    let read = gl
        .create_framebuffer()
        .ok_or_else(|| crate::Error::Unsupported("cannot allocate a presentation framebuffer".into()))?;
    gl.bind_framebuffer(Gl::READ_FRAMEBUFFER, Some(&read));
    texture.attach(Gl::READ_FRAMEBUFFER, Gl::COLOR_ATTACHMENT0, 0, 0);
    gl.read_buffer(Gl::COLOR_ATTACHMENT0);
    gl.bind_framebuffer(Gl::DRAW_FRAMEBUFFER, None);
    gl.disable(Gl::SCISSOR_TEST);
    let width = size.width as i32;
    let height = size.height as i32;
    let top = extent[1] as i32;
    gl.blit_framebuffer(0, 0, width, height, 0, top, width, top - height, Gl::COLOR_BUFFER_BIT, Gl::NEAREST);
    gl.delete_framebuffer(Some(&read));
    Ok(())
}
