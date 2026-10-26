//! Icons on the GPU: each image an icon marker shows is a layer of one texture array, scaled to fit
//! a common size. Markers reference their images, and markers showing the same image share its
//! layer.

use std::collections::HashMap;
use std::sync::Arc;

use crate::gpu::work::Queue;

/// Texels across an icon layer.
const SIZE: u32 = 64;

pub(crate) struct Icons {
    texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    /// Each image's layer, keyed by the address of its pixels, which are kept alive so the address
    /// is not reused.
    layers: HashMap<usize, (Arc<[u8]>, u32)>,
    capacity: u32,
    /// Changes whenever the texture is replaced, so views rebind it.
    pub(crate) generation: u64,
}

fn create(device: &wgpu::Device, layers: u32) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("latkit icons"),
        size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: layers },
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

impl Icons {
    pub(crate) fn new(device: &wgpu::Device) -> Icons {
        let (texture, view) = create(device, 1);
        Icons { texture, view, layers: HashMap::new(), capacity: 1, generation: 0 }
    }

    /// The layer of each of `images`, uploading the ones not yet on the GPU.
    pub(crate) fn layers(&mut self, device: &wgpu::Device, queue: &Queue, images: &[crate::Image]) -> Vec<u32> {
        let needed = self.layers.len() as u32 + images.len() as u32;
        if needed > self.capacity {
            let capacity = needed.next_power_of_two().min(device.limits().max_texture_array_layers);
            let (texture, view) = create(device, capacity);
            let mut encoder =
                device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit icons") });
            encoder.copy_texture_to_texture(
                self.texture.as_image_copy(),
                texture.as_image_copy(),
                wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: self.capacity },
            );
            queue.submit([encoder.finish()]);
            self.texture = texture;
            self.view = view;
            self.capacity = capacity;
            self.generation += 1;
        }
        images
            .iter()
            .map(|image| {
                let key = image.rgba.as_ptr() as usize;
                if let Some((_, layer)) = self.layers.get(&key) {
                    return *layer;
                }
                let layer = (self.layers.len() as u32).min(self.capacity - 1);
                let texels = fit(image);
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d { x: 0, y: 0, z: layer },
                        aspect: wgpu::TextureAspect::All,
                    },
                    &texels,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(SIZE * 4),
                        rows_per_image: Some(SIZE),
                    },
                    wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
                );
                self.layers.insert(key, (image.rgba.clone(), layer));
                layer
            })
            .collect()
    }
}

/// Scales `image` into a `SIZE` square by nearest texel, centered with its aspect ratio kept.
fn fit(image: &crate::Image) -> Vec<u8> {
    let [w, h] = image.size.map(|v| v.max(1));
    let scale = f64::from(w.max(h)) / f64::from(SIZE);
    let (fw, fh) = (f64::from(w) / scale, f64::from(h) / scale);
    let (x0, y0) = ((f64::from(SIZE) - fw) / 2.0, (f64::from(SIZE) - fh) / 2.0);
    let mut out = vec![0_u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let u = (f64::from(x) + 0.5 - x0) * scale;
            let v = (f64::from(y) + 0.5 - y0) * scale;
            if u < 0.0 || v < 0.0 || u >= f64::from(w) || v >= f64::from(h) {
                continue;
            }
            let from = ((v as u32 * w + u as u32) * 4) as usize;
            let to = ((y * SIZE + x) * 4) as usize;
            if let Some(texel) = image.rgba.get(from..from + 4) {
                out[to..to + 4].copy_from_slice(texel);
            }
        }
    }
    out
}
