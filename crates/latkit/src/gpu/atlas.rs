//! Text on the GPU: runs set by the host, packed on shelves of one coverage texture. When no shelf has
//! room, the shelf used least recently is cleared for the new run; only when none fits does the
//! packing start over. Views follow evictions to drop what they pointed at.

use std::collections::HashMap;

use crate::host::{Host, TextRun};

const SIZE: u32 = 2048;
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
    /// When a run on it was last asked for.
    tick: u64,
}

pub(crate) struct Atlas {
    texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    shelves: Vec<Shelf>,
    /// Every run asked for, and its shelf; `None` when the host could not set it.
    runs: HashMap<TextRun, Option<(Glyphs, usize)>>,
    /// Counts the frames runs are asked for in.
    clock: u64,
    /// Changes whenever runs are evicted, so what pointed at them looks again.
    pub(crate) evictions: u64,
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
        Atlas { texture, view, shelves: Vec::new(), runs: HashMap::new(), clock: 0, evictions: 0 }
    }

    /// Starts a frame: runs asked for from now on count as used in it.
    pub(crate) fn tick(&mut self) {
        self.clock += 1;
    }

    /// Where `run` lies, set by `host` the first time it is asked for.
    pub(crate) fn text(&mut self, queue: &wgpu::Queue, host: Option<&dyn Host>, run: &TextRun) -> Option<Glyphs> {
        if let Some(found) = self.runs.get(run) {
            let (glyphs, shelf) = (*found)?;
            self.shelves[shelf].tick = self.clock;
            return Some(glyphs);
        }
        let raster = host?.rasterize(run);
        let placed = raster.and_then(|raster| {
            let [width, height] = raster.size;
            if width == 0 || height == 0 || width > SIZE || height > SIZE {
                return None;
            }
            let (shelf, [left, top]) = self.place(width, height);
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
            Some((Glyphs { rect: [left, top, left + width, top + height], baseline: raster.baseline }, shelf))
        });
        self.runs.insert(run.clone(), placed);
        placed.map(|(glyphs, _)| glyphs)
    }

    /// Whether `glyphs` still lie where they were for `run`.
    pub(crate) fn holds(&self, run: &TextRun, glyphs: Glyphs) -> bool {
        matches!(self.runs.get(run), Some(Some((g, _))) if *g == glyphs)
    }

    /// The shelf and top left of room for `width` by `height` texels.
    fn place(&mut self, width: u32, height: u32) -> (usize, [u32; 2]) {
        let fits = |s: &Shelf| s.height >= height && s.height <= height + height / 2 + 4;
        let at = self.shelves.iter().position(|s| fits(s) && s.used + width <= SIZE);
        let at = at.or_else(|| {
            let top = self.shelves.last().map_or(0, |s| s.top + s.height + GAP);
            (top + height <= SIZE).then(|| {
                self.shelves.push(Shelf { top, height, used: 0, tick: self.clock });
                self.shelves.len() - 1
            })
        });
        let at = at.or_else(|| {
            // Clear the shelf of this height used least recently, if not in this frame.
            let clock = self.clock;
            let oldest = (0..self.shelves.len())
                .filter(|&i| fits(&self.shelves[i]) && self.shelves[i].tick < clock)
                .min_by_key(|&i| self.shelves[i].tick)?;
            self.runs.retain(|_, placed| !matches!(placed, Some((_, shelf)) if *shelf == oldest));
            self.shelves[oldest].used = 0;
            self.evictions += 1;
            Some(oldest)
        });
        let at = at.unwrap_or_else(|| {
            // Nothing fits: start over.
            self.runs.clear();
            self.shelves.clear();
            self.evictions += 1;
            self.shelves.push(Shelf { top: 0, height, used: 0, tick: self.clock });
            0
        });
        let shelf = &mut self.shelves[at];
        let corner = [shelf.used, shelf.top];
        shelf.used += width + GAP;
        shelf.tick = self.clock;
        (at, corner)
    }
}
