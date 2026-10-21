//! Colormaps on the GPU: one 256-texel layer per colormap a program uses, in one texture array.

use std::collections::HashMap;

use crate::expr::{Colormap, ColormapKey};
use crate::gpu::work::Queue;
use crate::{Error, Result};

const INITIAL_LAYERS: u32 = 16;

pub(crate) struct Colormaps {
    texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    layers: HashMap<ColormapKey, u32>,
    capacity: u32,
    /// Changes whenever the texture is replaced, so views rebind it.
    pub(crate) generation: u64,
}

fn create(device: &wgpu::Device, layers: u32) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("latkit colormaps"),
        size: wgpu::Extent3d { width: 256, height: 1, depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    });
    (texture, view)
}

impl Colormaps {
    pub(crate) fn new(device: &wgpu::Device) -> Colormaps {
        let (texture, view) = create(device, INITIAL_LAYERS);
        Colormaps { texture, view, layers: HashMap::new(), capacity: INITIAL_LAYERS, generation: 0 }
    }

    /// The layer holding `colormap`, uploading it the first time.
    pub(crate) fn layer(&mut self, device: &wgpu::Device, queue: &Queue, colormap: &Colormap) -> Result<u32> {
        let key = colormap.key();
        if let Some(&layer) = self.layers.get(&key) {
            return Ok(layer);
        }
        let layer = self.layers.len() as u32;
        if layer >= self.capacity {
            let capacity = (self.capacity * 2).min(device.limits().max_texture_array_layers);
            if layer >= capacity {
                return Err(Error::Limit(format!("more than {capacity} distinct colormaps").into()));
            }
            let (texture, view) = create(device, capacity);
            let mut encoder =
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit colormaps") });
            encoder.copy_texture_to_texture(
                self.texture.as_image_copy(),
                texture.as_image_copy(),
                wgpu::Extent3d { width: 256, height: 1, depth_or_array_layers: self.capacity },
            );
            queue.submit([encoder.finish()]);
            self.texture = texture;
            self.view = view;
            self.capacity = capacity;
            self.generation += 1;
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x: 0, y: 0, z: layer },
                aspect: wgpu::TextureAspect::All,
            },
            bytemuck::cast_slice(colormap.texels()),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256 * 4), rows_per_image: Some(1) },
            wgpu::Extent3d { width: 256, height: 1, depth_or_array_layers: 1 },
        );
        self.layers.insert(key, layer);
        Ok(layer)
    }
}
