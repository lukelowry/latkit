//! Reusable two-dimensional render targets. Scratch grows to its high-water size and is retained
//! between frames. Replaced textures are retired, including when a second view records work
//! before the first view's commands have been submitted.

use super::retired::Retired;

pub(crate) struct Texture {
    pub(crate) raw: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    label: &'static str,
    format: wgpu::TextureFormat,
    retired: Retired,
}

impl Texture {
    pub(crate) fn new(
        device: &wgpu::Device,
        retired: &Retired,
        label: &'static str,
        format: wgpu::TextureFormat,
    ) -> Texture {
        let raw = make(device, label, format, [1; 2]);
        let view = raw.create_view(&wgpu::TextureViewDescriptor::default());
        Texture { raw, view, label, format, retired: retired.clone() }
    }

    pub(crate) fn ensure(&mut self, device: &wgpu::Device, size: [u32; 2]) -> bool {
        let before = [self.raw.width(), self.raw.height()];
        if size.iter().zip(before).all(|(&need, have)| need <= have) {
            return false;
        }
        let limit = device.limits().max_texture_dimension_2d;
        assert!(size.iter().all(|&n| n <= limit), "scratch texture exceeds device dimensions");
        let next = [size[0].max(before[0]), size[1].max(before[1])].map(|n| n.next_power_of_two().min(limit));
        let raw = make(device, self.label, self.format, next);
        self.view = raw.create_view(&wgpu::TextureViewDescriptor::default());
        self.retired.retire(std::mem::replace(&mut self.raw, raw));
        true
    }
}

impl Drop for Texture {
    fn drop(&mut self) {
        self.retired.retire(self.raw.clone());
    }
}

fn make(device: &wgpu::Device, label: &str, format: wgpu::TextureFormat, size: [u32; 2]) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    })
}
