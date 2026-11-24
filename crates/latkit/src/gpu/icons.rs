//! Marker pictures on the GPU: each image an icon marker shows, scaled to a common size, and each
//! path a symbol marker shows, set as a distance field. Each is one layer of a texture array, and
//! markers showing the same picture share its layer.

use std::hash::{Hash, Hasher};
use std::sync::Arc;

use super::layers::Layers;
use super::shaders::{ICON_SIZE, SYMBOL_MARGIN, SYMBOL_SPREAD};
use crate::gpu::work::Queue;
use crate::{Error, Result};

/// Texels across a layer.
const SIZE: u32 = ICON_SIZE as u32;

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

/// What a layer holds: an image's pixels, or a path's distance field, stroked or filled.
#[derive(PartialEq, Eq, Hash)]
pub(crate) enum Picture {
    Pixels(Pixels),
    Path(Arc<str>, bool),
}

pub(crate) type Icons = Layers<Picture>;

impl Icons {
    pub(crate) fn icons(device: &wgpu::Device) -> Icons {
        Layers::new(device, "icons", [SIZE, SIZE], 1)
    }

    /// The layer of each of `images`, uploading the ones not yet on the GPU.
    pub(crate) fn of(&mut self, device: &wgpu::Device, queue: &Queue, images: &[crate::Image]) -> Result<Vec<u32>> {
        let layer = |image: &crate::Image| {
            self.layer(device, queue, Picture::Pixels(Pixels(image.rgba.clone())), || fit(image))
        };
        images.iter().map(layer).collect()
    }

    /// The layer of each of `paths`, SVG path data, setting the fields not yet on the GPU: a
    /// path's distance from its curve when `stroked`, else its signed distance from its outline.
    pub(crate) fn symbols(
        &mut self,
        device: &wgpu::Device,
        queue: &Queue,
        paths: &[Arc<str>],
        stroked: bool,
    ) -> Result<Vec<u32>> {
        paths
            .iter()
            .map(|path| {
                let outlines = crate::scene::path::outlines(path).map_err(Error::invalid)?;
                self.layer(device, queue, Picture::Path(path.clone(), stroked), || field(&outlines, stroked))
            })
            .collect()
    }
}

/// The distance field of `outlines` over a layer, which reaches `SYMBOL_MARGIN` past their box of
/// -1 to 1. Each texel holds its distance from the nearest segment, negative inside a filled path
/// by the even-odd rule, with the outline at one half and `SYMBOL_SPREAD` texels to 0 and to 1.
fn field(outlines: &[Vec<[f32; 2]>], stroked: bool) -> Vec<u8> {
    let reach = 1.0 + SYMBOL_MARGIN;
    let at = |i: u32| ((i as f32 + 0.5) / SIZE as f32 * 2.0 - 1.0) * reach;
    let mut out = vec![0_u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let p = [at(x), at(y)];
            let (mut nearest, mut inside) = (f32::INFINITY, false);
            for pair in outlines.iter().flat_map(|outline| outline.windows(2)) {
                let (a, b) = (pair[0], pair[1]);
                let (ab, ap) = ([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]);
                let along =
                    ((ap[0] * ab[0] + ap[1] * ab[1]) / (ab[0] * ab[0] + ab[1] * ab[1]).max(1e-12)).clamp(0.0, 1.0);
                nearest = nearest.min((ap[0] - ab[0] * along).hypot(ap[1] - ab[1] * along));
                // A ray to the right of the texel crosses this segment.
                if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) / (b[1] - a[1]) * ab[0] {
                    inside = !inside;
                }
            }
            let signed = if inside && !stroked { -nearest } else { nearest };
            let texels = signed * SIZE as f32 / (2.0 * reach);
            let value = ((0.5 + texels / (2.0 * SYMBOL_SPREAD)).clamp(0.0, 1.0) * 255.0).round() as u8;
            let texel = ((y * SIZE + x) * 4) as usize;
            out[texel..texel + 4].fill(value);
        }
    }
    out
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
