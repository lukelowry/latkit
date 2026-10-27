//! Colormaps on the GPU: one 256-texel layer per colormap a program uses, in one texture array.

use super::layers::Layers;
use crate::Result;
use crate::expr::{Colormap, ColormapKey};
use crate::gpu::work::Queue;

pub(crate) type Colormaps = Layers<ColormapKey>;

impl Colormaps {
    pub(crate) fn colormaps(device: &wgpu::Device) -> Colormaps {
        Layers::new(device, "colormaps", [256, 1], 16)
    }

    /// The layer holding `colormap`, uploading it the first time.
    pub(crate) fn colormap(&mut self, device: &wgpu::Device, queue: &Queue, colormap: &Colormap) -> Result<u32> {
        self.layer(device, queue, colormap.key(), || bytemuck::cast_slice(colormap.texels()).to_vec())
    }
}
