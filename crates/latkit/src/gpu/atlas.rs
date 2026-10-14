//! Text on the GPU: runs set once by the host at `TEXT_BASE`, turned into distance fields reaching
//! `TEXT_SPREAD` texels past the text's edge, and packed on shelves of one texture. A distance field
//! draws crisp at any size and gives halos for free, so a run is set once whatever size it shows at.
//! When no shelf has room, the shelf used least recently is cleared for the new run; only when none
//! fits does the packing start over. A run counts as used when it is set and whenever labels in view
//! show it, so what the view shows stays. Views follow evictions to drop what they pointed at.

use std::collections::HashMap;
use std::sync::Arc;

use crate::gpu::shaders::{TEXT_BASE, TEXT_SPREAD};
use crate::host::{Host, TextRun};

/// Texels across the atlas: room for about 1,400 labels of ten characters at the base size.
const SIZE: u32 = 4096;
/// Texels between runs, so filtering never reads a neighbor.
const GAP: u32 = 1;
/// Texels of field around a run's coverage.
const PAD: u32 = TEXT_SPREAD as u32;

/// Where a run lies in the atlas.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Glyphs {
    /// Left, top, right, and bottom, texels, reaching `TEXT_SPREAD` past the text on every side.
    pub(crate) rect: [u32; 4],
    /// Texels from the top of the rectangle to the baseline.
    pub(crate) baseline: f32,
}

impl Glyphs {
    /// The rectangle as the two corner words shaders read: 16 bits of x, then 16 of y.
    pub(crate) fn corners(&self) -> [u32; 2] {
        let [l, t, r, b] = self.rect;
        [l | t << 16, r | b << 16]
    }
}

/// A run table entry for `run` before it is set: the estimate flag, then the corner a rectangle of
/// its size by a rough measure would reach from the atlas's own corner, so its label can be placed
/// while only labels that show have their texts set.
pub(crate) fn estimate(run: &TextRun) -> [u32; 2] {
    let size = run.size_px as f32;
    let width = run.text.chars().count() as f32 * 0.58 * size;
    let (width, lines) = match run.max_width.map(|w| w as f32) {
        Some(wrap) if width > wrap => (wrap, (width / wrap).ceil()),
        _ => (width, 1.0),
    };
    // The host pads each run a little, and the field reaches past it.
    let pad = 2.0 * (2.0 + PAD as f32);
    let w = ((width + pad).ceil() as u32).min(0xffff);
    let h = ((lines * 1.25 * size + pad).ceil() as u32).min(0xffff);
    [crate::gpu::shaders::TEXT_ESTIMATE, w | h << 16]
}

/// The run the atlas sets for `text` shown at `size`, wrapping at `max_width`, both length units: set
/// at the base size, wrapping where `max_width` falls at it. A sheet measures the same run it draws.
pub(crate) fn run(text: Arc<str>, font: Arc<str>, size: f32, max_width: Option<f32>) -> TextRun {
    let wrap = max_width.map(|w| (w * TEXT_BASE / size.max(1e-3)).round().max(1.0) as u32);
    TextRun { text, font, size_px: TEXT_BASE as u32, max_width: wrap }
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
            let [w, h] = raster.size;
            let (width, height) = (w + 2 * PAD, h + 2 * PAD);
            if w == 0 || h == 0 || width > SIZE || height > SIZE {
                return None;
            }
            let field = distance_field(&raster.coverage, w as usize, h as usize);
            let (shelf, [left, top]) = self.place(width, height);
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: left, y: top, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                &field,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width), rows_per_image: Some(height) },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
            let glyphs =
                Glyphs { rect: [left, top, left + width, top + height], baseline: raster.baseline + PAD as f32 };
            Some((glyphs, shelf))
        });
        self.runs.insert(run.clone(), placed);
        placed.map(|(glyphs, _)| glyphs)
    }

    /// Counts `run` as used now: labels in view show it.
    pub(crate) fn touch(&mut self, run: &TextRun) {
        if let Some(Some((_, shelf))) = self.runs.get(run) {
            self.shelves[*shelf].tick = self.clock;
        }
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

/// Far more than any distance in a field.
const FAR: f64 = 1e20;

/// The distance field of `width` by `height` coverage bytes, `PAD` texels wider on every side: each
/// texel's signed distance to the text's edge, inside positive, as `0.5 + distance / (2 TEXT_SPREAD)`.
/// Partial coverage places the edge within its texel, so antialiasing becomes subtexel distance.
fn distance_field(coverage: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pad = PAD as usize;
    let (w, h) = (width + 2 * pad, height + 2 * pad);
    // Squared distances to the nearest texel inside, and to the nearest outside.
    let mut outer = vec![FAR; w * h];
    let mut inner = vec![0.0; w * h];
    for y in 0..height {
        for x in 0..width {
            let a = f64::from(coverage[y * width + x]) / 255.0;
            let i = (y + pad) * w + x + pad;
            if a >= 1.0 {
                (outer[i], inner[i]) = (0.0, FAR);
            } else if a > 0.0 {
                let d = 0.5 - a;
                (outer[i], inner[i]) = (if d > 0.0 { d * d } else { 0.0 }, if d < 0.0 { d * d } else { 0.0 });
            }
        }
    }
    let mut scratch = Scratch::new(w.max(h));
    transform(&mut outer, w, h, &mut scratch);
    transform(&mut inner, w, h, &mut scratch);
    let spread = f64::from(TEXT_SPREAD);
    outer
        .iter()
        .zip(&inner)
        .map(|(&o, &i)| {
            let d = i.sqrt() - o.sqrt();
            ((0.5 + d / (2.0 * spread)).clamp(0.0, 1.0) * 255.0).round() as u8
        })
        .collect()
}

/// Buffers one line of a distance transform uses.
struct Scratch {
    f: Vec<f64>,
    v: Vec<usize>,
    z: Vec<f64>,
}

impl Scratch {
    fn new(n: usize) -> Scratch {
        Scratch { f: vec![0.0; n], v: vec![0; n], z: vec![0.0; n + 1] }
    }
}

/// Squared Euclidean distances to the nearest zero of `grid`, in place: every column, then every row.
fn transform(grid: &mut [f64], w: usize, h: usize, s: &mut Scratch) {
    for x in 0..w {
        line(grid, x, w, h, s);
    }
    for y in 0..h {
        line(grid, y * w, 1, w, s);
    }
}

/// One line of the transform, Felzenszwalb and Huttenlocher's lower envelope of parabolas.
fn line(grid: &mut [f64], offset: usize, stride: usize, n: usize, s: &mut Scratch) {
    s.v[0] = 0;
    s.z[0] = -FAR;
    s.z[1] = FAR;
    s.f[0] = grid[offset];
    let mut k = 0_usize;
    for q in 1..n {
        s.f[q] = grid[offset + q * stride];
        let q2 = (q * q) as f64;
        loop {
            let r = s.v[k];
            let edge = (s.f[q] - s.f[r] + q2 - (r * r) as f64) / (2.0 * (q - r) as f64);
            if edge <= s.z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if edge <= s.z[k] {
                // The first parabola is beaten everywhere: this one starts the envelope.
                s.v[0] = q;
                s.z[0] = -FAR;
                s.z[1] = FAR;
                break;
            }
            k += 1;
            s.v[k] = q;
            s.z[k] = edge;
            s.z[k + 1] = FAR;
            break;
        }
    }
    let mut k = 0;
    for q in 0..n {
        while s.z[k + 1] < q as f64 {
            k += 1;
        }
        let r = s.v[k];
        let d = q as f64 - r as f64;
        grid[offset + q * stride] = s.f[r] + d * d;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_half_at_the_edge_and_rise_inside() {
        // A 6 by 6 square of full coverage.
        let (w, h) = (6, 6);
        let field = distance_field(&vec![255; w * h], w, h);
        let width = w + 2 * PAD as usize;
        let at = |x: usize, y: usize| field[y * width + x];
        let middle = at(width / 2, width / 2);
        let edge = at(PAD as usize, width / 2);
        let outside = at(0, width / 2);
        assert!(middle > edge && edge > outside, "{middle} {edge} {outside}");
        assert!((i32::from(edge) - 128).abs() < 24, "the edge texel sits near half: {edge}");
        assert_eq!(outside, 0, "a spread away reads nothing");
    }
}
