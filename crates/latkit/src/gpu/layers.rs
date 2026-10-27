//! Texture arrays holding one layer per distinct image, such as each colormap or icon a program
//! uses. An array grows by copying itself into one twice as deep, up to the device's layer limit.

use std::collections::HashMap;
use std::hash::Hash;

use crate::gpu::work::Queue;
use crate::{Error, Result};

pub(crate) struct Layers<K> {
    /// What the layers hold, for labels and errors, such as "colormaps".
    what: &'static str,
    /// Texels across and down each layer.
    size: [u32; 2],
    texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    /// The layer holding each key.
    held: HashMap<K, u32>,
    capacity: u32,
    /// Changes whenever the texture is replaced, so views rebind it.
    pub(crate) generation: u64,
}

impl<K: Hash + Eq> Layers<K> {
    /// An array of `capacity` layers of `size` texels, holding `what`.
    pub(crate) fn new(device: &wgpu::Device, what: &'static str, size: [u32; 2], capacity: u32) -> Layers<K> {
        let (texture, view) = create(device, what, size, capacity);
        Layers { what, size, texture, view, held: HashMap::new(), capacity, generation: 0 }
    }

    /// The layer holding `key`, uploading `texels()` (RGBA, row after row) the first time. Errors
    /// once the array reaches the device's limit on layers.
    pub(crate) fn layer(
        &mut self,
        device: &wgpu::Device,
        queue: &Queue,
        key: K,
        texels: impl FnOnce() -> Vec<u8>,
    ) -> Result<u32> {
        if let Some(&layer) = self.held.get(&key) {
            return Ok(layer);
        }
        let layer = self.held.len() as u32;
        if layer >= self.capacity {
            self.grow(device, queue)?;
        }
        let [width, height] = self.size;
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x: 0, y: 0, z: layer },
                aspect: wgpu::TextureAspect::All,
            },
            &texels(),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(height) },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.held.insert(key, layer);
        Ok(layer)
    }

    /// Doubles the array's layers, within the device's limit, copying the layers it holds.
    fn grow(&mut self, device: &wgpu::Device, queue: &Queue) -> Result<()> {
        let capacity = (self.capacity * 2).min(device.limits().max_texture_array_layers);
        if capacity <= self.capacity {
            return Err(Error::Limit(format!("more than {capacity} distinct {}", self.what).into()));
        }
        let (texture, view) = create(device, self.what, self.size, capacity);
        let label = format!("latkit {}", self.what);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some(&label) });
        let [width, height] = self.size;
        encoder.copy_texture_to_texture(
            self.texture.as_image_copy(),
            texture.as_image_copy(),
            wgpu::Extent3d { width, height, depth_or_array_layers: self.capacity },
        );
        queue.submit([encoder.finish()]);
        (self.texture, self.view, self.capacity) = (texture, view, capacity);
        self.generation += 1;
        Ok(())
    }
}

fn create(
    device: &wgpu::Device,
    what: &str,
    [width, height]: [u32; 2],
    layers: u32,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(&format!("latkit {what}")),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: layers },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layers_grow_for_new_keys_and_stop_at_the_device_limit() {
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let texel = || vec![255; 4];
        let mut layers = Layers::<u32>::new(device, "tests", [1, 1], 1);
        let first: Vec<u32> = (0..5).map(|key| layers.layer(device, queue, key, texel).expect("room")).collect();
        assert_eq!(first, [0, 1, 2, 3, 4], "each key gets its own layer");
        assert_eq!(layers.generation, 3, "grown from 1 to 2, 4, then 8 layers");
        assert_eq!(layers.layer(device, queue, 2, texel).expect("held"), 2, "a key keeps its layer");
        assert_eq!(layers.generation, 3, "and nothing grows for it");
        let max = device.limits().max_texture_array_layers;
        let mut full = Layers::<u32>::new(device, "tests", [1, 1], max);
        for key in 0..max {
            full.layer(device, queue, key, texel).expect("within the limit");
        }
        let over = full.layer(device, queue, max, texel);
        assert!(matches!(over, Err(Error::Limit(_))), "past the limit, an error, not a reused layer");
    }
}
