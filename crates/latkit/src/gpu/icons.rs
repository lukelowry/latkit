//! Icons on the GPU. Each image an icon marker shows is scaled to a common size and stored as one
//! layer of a texture array. Markers showing the same image share its layer.

use std::hash::{Hash, Hasher};
use std::sync::Arc;

use super::layers::Layers;
use crate::Result;
use crate::gpu::work::Queue;

/// Texels across an icon layer.
const SIZE: u32 = 64;

/// An image's pixels, compared by address so that markers showing one image share its layer.
/// Holding the pixels keeps the address from being reused.
pub(crate) struct Pixels(Arc<[u8]>);

impl PartialEq for Pixels {
    fn eq(&self, other: &Pixels) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for Pixels {}

impl Hash for Pixels {
    fn hash<H: Hasher>(&self, hasher: &mut H) {
        Arc::as_ptr(&self.0).cast::<u8>().hash(hasher);
    }
}

pub(crate) type Icons = Layers<Pixels>;

impl Icons {
    pub(crate) fn icons(device: &wgpu::Device) -> Icons {
        Layers::new(device, "icons", [SIZE, SIZE], 1)
    }

    /// The layer of each of `images`, uploading the ones not yet on the GPU.
    pub(crate) fn of(&mut self, device: &wgpu::Device, queue: &Queue, images: &[crate::Image]) -> Result<Vec<u32>> {
        images.iter().map(|image| self.layer(device, queue, Pixels(image.rgba.clone()), || fit(image))).collect()
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
