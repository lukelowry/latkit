//! Text on the GPU: runs set by the host, packed on shelves of one coverage texture. When the texture
//! is full it starts over, and the frame after draws from the new packing.

use std::collections::HashMap;

use crate::host::{Host, TextRun};

const SIZE: u32 = 1024;
/// Texels between runs, so filtering never reads a neighbor.
const GAP: u32 = 1;

/// Where a run lies in the atlas.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Glyphs {
    /// Left, top, right, and bottom, texels.
    pub(crate) rect: [u32; 4],
    /// Texels from the top to the baseline.
    pub(crate) baseline: f32,
}

struct Shelf {
    top: u32,
    height: u32,
    used: u32,
}

pub(crate) struct Atlas {
    texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    shelves: Vec<Shelf>,
    /// Every run asked for; `None` when the host could not set it.
    runs: HashMap<TextRun, Option<Glyphs>>,
    /// Changes when the packing starts over, so overlays built from the old one are rebuilt.
    pub(crate) generation: u64,
}

impl Atlas {
    pub(crate) fn new(device: &wgpu::Device) -> Atlas {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("latkit text"),
            size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Atlas { texture, view, shelves: Vec::new(), runs: HashMap::new(), generation: 0 }
    }

    /// Where `run` lies, set by `host` the first time it is asked for.
    pub(crate) fn text(&mut self, queue: &wgpu::Queue, host: Option<&dyn Host>, run: &TextRun) -> Option<Glyphs> {
        if let Some(glyphs) = self.runs.get(run) {
            return *glyphs;
        }
        let raster = host?.rasterize(run);
        let glyphs = raster.and_then(|raster| {
            let [width, height] = raster.size;
            if width == 0 || height == 0 || width > SIZE || height > SIZE {
                return None;
            }
            let [left, top] = self.place(width, height).or_else(|| {
                self.runs.clear();
                self.shelves.clear();
                self.generation += 1;
                self.place(width, height)
            })?;
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: left, y: top, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                &raster.coverage,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width), rows_per_image: Some(height) },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
            Some(Glyphs { rect: [left, top, left + width, top + height], baseline: raster.baseline })
        });
        self.runs.insert(run.clone(), glyphs);
        glyphs
    }

    /// The top left of room for `width` by `height` texels.
    fn place(&mut self, width: u32, height: u32) -> Option<[u32; 2]> {
        let fits = |s: &Shelf| s.height >= height && s.height <= height + height / 2 + 4 && s.used + width <= SIZE;
        if let Some(shelf) = self.shelves.iter_mut().find(|s| fits(s)) {
            let at = [shelf.used, shelf.top];
            shelf.used += width + GAP;
            return Some(at);
        }
        let top = self.shelves.last().map_or(0, |s| s.top + s.height + GAP);
        if top + height > SIZE {
            return None;
        }
        self.shelves.push(Shelf { top, height, used: width + GAP });
        Some([0, top])
    }
}
