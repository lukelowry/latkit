//! Text on the GPU: runs set once by the host at `TEXT_BASE`, turned into distance fields reaching
//! `TEXT_SPREAD` texels past the text's edge, and packed on shelves of one texture. Until a run is
//! set, its size is measured from its font's characters, each measured by the host once, so its label
//! is placed where it will show. A distance field
//! draws crisp at any size and gives halos for free, so a run is set once whatever size it shows at.
//! The host sets coverage; the GPU makes the fields of every run set in a frame at once, before the
//! frame draws (`compute/fields.wesl`). When no shelf has room, the shelf used least recently is
//! cleared for the new run; only when none fits does the packing start over. A run counts as used
//! when it is set and whenever labels in view show it, so what the view shows stays. Views follow
//! evictions to drop what they pointed at.

use std::collections::HashMap;
use std::sync::Arc;

use rustc_hash::FxHashMap;

use crate::gpu::pipelines::Pipelines;
use crate::gpu::shaders::{FIELD_AT, FIELD_COLUMNS, FIELD_COVERAGE, FIELD_HEIGHT, FIELD_ROW, FIELD_WIDTH, FIELD_WORDS};
use crate::gpu::shaders::{Shader, TEXT_BASE, TEXT_SPREAD};
use crate::gpu::work::{Count, Counters, Queue};
use crate::host::{Host, Raster, TextRun};

/// Texels across the atlas: room for about 1,400 labels of ten characters at the base size.
const SIZE: u32 = 4096;
/// Texels between runs, so filtering never reads a neighbor.
const GAP: u32 = 1;
/// Texels of field around a run's coverage.
const PAD: u32 = TEXT_SPREAD as u32;
/// Runs whose fields one dispatch makes at most: one workgroup layer each.
const RUNS: usize = 65_535;

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

/// What a font's text takes at the base size, as the host sets it: what a run of no characters
/// takes, what each line past the first adds, and each character's advance, measured once each.
struct Metrics {
    empty: [f32; 2],
    line: f32,
    advances: FxHashMap<char, f32>,
}

impl Metrics {
    /// `font`'s, as `host` measures it.
    fn of(host: &dyn Host, font: &Arc<str>) -> Metrics {
        let measure = |text: &str, max_width: Option<u32>| {
            host.measure(&TextRun { text: text.into(), font: font.clone(), size_px: TEXT_BASE as u32, max_width })
                .unwrap_or([0.0, 1.25 * TEXT_BASE])
        };
        let empty = measure("", None);
        let line = measure("M M", Some(1))[1] - measure("M", None)[1];
        Metrics { empty, line, advances: FxHashMap::default() }
    }

    /// What `c` advances a line by, measured by `host` the first time.
    fn advance(&mut self, host: &dyn Host, font: &Arc<str>, c: char) -> f32 {
        let empty = self.empty[0];
        *self.advances.entry(c).or_insert_with(|| {
            let run =
                TextRun { text: c.to_string().into(), font: font.clone(), size_px: TEXT_BASE as u32, max_width: None };
            host.measure(&run).map_or(0.58 * TEXT_BASE, |[w, _]| w - empty)
        })
    }
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

/// A run set whose field waits to be made: its coverage, and the shelf and corner its field fills.
struct Waiting {
    raster: Raster,
    shelf: usize,
    corner: [u32; 2],
}

pub(crate) struct Atlas {
    pub(crate) errors: Vec<crate::Error>,
    texture: wgpu::Texture,
    pub(crate) view: wgpu::TextureView,
    shelves: Vec<Shelf>,
    /// Every run asked for, and its shelf; `None` when the host could not set it.
    runs: HashMap<TextRun, Option<(Glyphs, usize)>>,
    /// Runs set whose fields the next frame makes.
    waiting: Vec<Waiting>,
    /// What making fields works in, and its bind group.
    work: Option<(wgpu::Buffer, wgpu::BindGroup)>,
    /// Counts the frames runs are asked for in.
    clock: u64,
    /// Changes whenever runs are evicted, so what pointed at them looks again.
    pub(crate) evictions: u64,
    /// What counts the texts the host is asked to set.
    counters: Arc<Counters>,
    /// What each font's text takes, by font.
    metrics: HashMap<Arc<str>, Metrics>,
}

impl Atlas {
    pub(crate) fn new(device: &wgpu::Device, counters: Arc<Counters>) -> Atlas {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("latkit text"),
            size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Atlas {
            errors: Vec::new(),
            texture,
            view,
            shelves: Vec::new(),
            runs: HashMap::new(),
            waiting: Vec::new(),
            work: None,
            clock: 0,
            evictions: 0,
            counters,
            metrics: HashMap::new(),
        }
    }

    /// The run table entry for `run` while it is not set: the flag saying so, then the corner a
    /// rectangle of its size reaches from the atlas's own corner. Its lines break at spaces as the
    /// host breaks them, each as wide as its characters' advances, so its label is placed where it
    /// will show while only labels that show have their texts set. Nothing without a host.
    pub(crate) fn unset(&mut self, host: Option<&dyn Host>, run: &TextRun) -> [u32; 2] {
        let Some(host) = host else { return [0, 0] };
        let font = &run.font;
        let metrics = self.metrics.entry(font.clone()).or_insert_with(|| Metrics::of(host, font));
        let mut width = |text: &str| text.chars().map(|c| metrics.advance(host, font, c)).sum::<f32>();
        let (widest, lines) = match run.max_width.map(|w| w as f32) {
            None => (width(&run.text), 1),
            Some(max) => {
                let space = width(" ");
                let mut lines: Vec<f32> = Vec::new();
                for word in run.text.split(' ') {
                    let w = width(word);
                    match lines.last_mut() {
                        Some(line) if *line + space + w <= max => *line += space + w,
                        _ => lines.push(w),
                    }
                }
                (lines.iter().copied().fold(0.0, f32::max), lines.len())
            }
        };
        let [pad, height] = metrics.empty;
        let w = ((widest + pad).ceil() as u32 + 2 * PAD).min(0xffff);
        let h = ((height + (lines - 1) as f32 * metrics.line).ceil() as u32 + 2 * PAD).min(0xffff);
        [crate::gpu::shaders::TEXT_UNSET, w | h << 16]
    }

    /// Starts a frame: runs asked for from now on count as used in it.
    pub(crate) fn tick(&mut self) {
        self.clock += 1;
    }

    /// Where `run` lies, set by `host` the first time it is asked for; its field is made before the
    /// frame draws.
    pub(crate) fn text(&mut self, host: Option<&dyn Host>, run: &TextRun) -> Option<Glyphs> {
        if let Some(found) = self.runs.get(run) {
            let (glyphs, shelf) = (*found)?;
            self.shelves[shelf].tick = self.clock;
            return Some(glyphs);
        }
        let host = host?;
        self.counters.add(Count::Texts, 1);
        let raster = match host.rasterize(run) {
            Ok(raster) => raster,
            Err(error) => {
                self.errors.push(error);
                return None;
            }
        };
        let placed = self.hold(raster);
        if placed.is_some() {
            self.runs.insert(run.clone(), placed);
        }
        placed.map(|(glyphs, _)| glyphs)
    }

    /// Places `raster`'s field, which waits to be made: where it lies, and its shelf.
    fn hold(&mut self, raster: Raster) -> Option<(Glyphs, usize)> {
        let [w, h] = raster.size;
        let (width, height) = (w.saturating_add(2 * PAD), h.saturating_add(2 * PAD));
        if w == 0 || h == 0 || width > SIZE || height > SIZE {
            self.errors.push(crate::Error::Limit("text raster does not fit the atlas".into()));
            return None;
        }
        if raster.coverage.len() != w as usize * h as usize {
            self.errors.push(crate::Error::invalid("text raster coverage does not match its size"));
            return None;
        }
        let (shelf, [left, top]) = self.place(width, height);
        let glyphs = Glyphs { rect: [left, top, left + width, top + height], baseline: raster.baseline + PAD as f32 };
        self.waiting.push(Waiting { raster, shelf, corner: [left, top] });
        Some((glyphs, shelf))
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

    /// Makes the fields of the runs set since last time, recorded into `encoder` before what draws
    /// them: their coverage goes up, each column and then each row takes its least squared distances
    /// within the spread, and each field copies into its place.
    pub(crate) fn lay(
        &mut self,
        device: &wgpu::Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        pipelines: &mut Pipelines,
    ) {
        if self.waiting.is_empty() {
            return;
        }
        let rest = self.waiting.split_off(self.waiting.len().min(RUNS));
        let laid = std::mem::replace(&mut self.waiting, rest);
        let size = |w: &Waiting| w.raster.size.map(|n| n + 2 * PAD);
        // The runs and their coverage go up; their columns and fields follow. A field starts where a
        // copy out of it may, and its rows are as far apart as copies need.
        let mut runs = vec![[0_u32; FIELD_WORDS as usize]; laid.len()];
        let mut coverage = Vec::new();
        let mut at = laid.len() as u32 * FIELD_WORDS;
        for (w, run) in laid.iter().zip(&mut runs) {
            run[FIELD_COVERAGE as usize] = at + (coverage.len() / 4) as u32;
            [run[FIELD_WIDTH as usize], run[FIELD_HEIGHT as usize]] = w.raster.size;
            coverage.extend_from_slice(&w.raster.coverage);
            coverage.resize(coverage.len().next_multiple_of(4), 0);
        }
        at += (coverage.len() / 4) as u32;
        for (w, run) in laid.iter().zip(&mut runs) {
            let [width, height] = size(w);
            run[FIELD_COLUMNS as usize] = at;
            at += width * height;
        }
        for (w, run) in laid.iter().zip(&mut runs) {
            let [width, height] = size(w);
            at = at.next_multiple_of(COPY_ALIGN / 4);
            run[FIELD_AT as usize] = at;
            run[FIELD_ROW as usize] = width.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) / 4;
            at += run[FIELD_ROW as usize] * height;
        }
        let (buffer, group) = self.fit_work(device, pipelines, u64::from(at) * 4);
        let mut upload: Vec<u8> = bytemuck::cast_slice(&runs).to_vec();
        upload.extend_from_slice(&coverage);
        queue.write_buffer_in(device, encoder, &buffer, 0, &upload);
        let most = laid.iter().map(size).fold([0, 0], |m, s| [m[0].max(s[0]), m[1].max(s[1])]);
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("latkit fields"),
                timestamp_writes: None,
            });
            pass.set_bind_group(0, &pipelines.empty, &[]);
            pass.set_bind_group(1, &pipelines.empty, &[]);
            pass.set_bind_group(2, &group, &[]);
            pass.set_pipeline(&pipelines.compute(device, Shader::Fields, "columns"));
            pass.dispatch_workgroups(most[0].div_ceil(16), most[1].div_ceil(16), laid.len() as u32);
            pass.set_pipeline(&pipelines.compute(device, Shader::Fields, "rows"));
            pass.dispatch_workgroups(most[0].div_ceil(4).div_ceil(16), most[1].div_ceil(16), laid.len() as u32);
        }
        for (w, run) in laid.iter().zip(&runs) {
            let [width, height] = size(w);
            encoder.copy_buffer_to_texture(
                wgpu::TexelCopyBufferInfo {
                    buffer: &buffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: u64::from(run[FIELD_AT as usize]) * 4,
                        bytes_per_row: Some(run[FIELD_ROW as usize] * 4),
                        rows_per_image: Some(height),
                    },
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: w.corner[0], y: w.corner[1], z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
        }
    }

    /// The buffer making fields works in, holding at least `bytes`, and its bind group.
    fn fit_work(
        &mut self,
        device: &wgpu::Device,
        pipelines: &mut Pipelines,
        bytes: u64,
    ) -> (wgpu::Buffer, wgpu::BindGroup) {
        if let Some((buffer, group)) = self.work.as_ref().filter(|(buffer, _)| buffer.size() >= bytes) {
            return (buffer.clone(), group.clone());
        }
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("latkit fields"),
            size: (bytes + bytes / 2).next_multiple_of(256),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("latkit fields"),
            layout: &pipelines.pass_layout(device, Shader::Fields),
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() }],
        });
        self.work = Some((buffer.clone(), group.clone()));
        (buffer, group)
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
            self.waiting.retain(|w| w.shelf != oldest);
            self.shelves[oldest].used = 0;
            self.evictions += 1;
            Some(oldest)
        });
        let at = at.unwrap_or_else(|| {
            // Nothing fits: start over.
            self.runs.clear();
            self.waiting.clear();
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

/// Bytes a copy out of a buffer into a texture may start at a multiple of, on every backend.
const COPY_ALIGN: u32 = 512;

#[cfg(test)]
mod tests {
    use super::*;

    /// The field of `width` by `height` coverage bytes as it is defined, texel by texel: the least
    /// squared distance to a texel inside and outside over every texel within reach.
    fn exact(coverage: &[u8], width: usize, height: usize) -> Vec<u8> {
        let pad = i64::from(PAD);
        let (w, h) = (width as i64 + 2 * pad, height as i64 + 2 * pad);
        let own = |x: i64, y: i64| {
            let (cx, cy) = (x - pad, y - pad);
            let a = if (0..width as i64).contains(&cx) && (0..height as i64).contains(&cy) {
                f64::from(coverage[(cy * width as i64 + cx) as usize]) / 255.0
            } else {
                0.0
            };
            let d = 0.5 - a;
            if a >= 1.0 {
                (0.0, f64::INFINITY)
            } else if a <= 0.0 {
                (f64::INFINITY, 0.0)
            } else {
                (if d > 0.0 { d * d } else { 0.0 }, if d < 0.0 { d * d } else { 0.0 })
            }
        };
        let mut field = Vec::new();
        for y in 0..h {
            for x in 0..w {
                let (mut inside, mut outside) = (f64::INFINITY, f64::INFINITY);
                for qy in (y - pad).max(0)..=(y + pad).min(h - 1) {
                    for qx in (x - pad).max(0)..=(x + pad).min(w - 1) {
                        let (i, o) = own(qx, qy);
                        let r = ((qx - x).pow(2) + (qy - y).pow(2)) as f64;
                        (inside, outside) = (inside.min(i + r), outside.min(o + r));
                    }
                }
                let d = outside.sqrt() - inside.sqrt();
                field.push(((0.5 + d / (2.0 * f64::from(TEXT_SPREAD))).clamp(0.0, 1.0) * 255.0).round() as u8);
            }
        }
        field
    }

    #[test]
    fn fields_made_on_the_gpu_are_the_exact_field() {
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        // A soft disc, a hairline of half coverage, a faint speck, and an odd width.
        let (width, height) = (41, 26);
        let mut coverage = vec![0_u8; width * height];
        for y in 0..height {
            for x in 0..width {
                let edge = ((x as f64 - 12.0).hypot(y as f64 - 13.0) - 8.0).clamp(-1.0, 1.0);
                coverage[y * width + x] = ((0.5 - edge / 2.0) * 255.0).round() as u8;
            }
        }
        for y in 3..23 {
            coverage[y * width + 30] = 128;
        }
        coverage[5 * width + 37] = 40;
        let mut inner = gpu.0.lock();
        let raster = Raster { size: [width as u32, height as u32], coverage: coverage.clone(), baseline: 20.0 };
        let (glyphs, _) = inner.atlas.hold(raster).expect("placed");
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let crate::gpu::Inner { atlas, pipelines, .. } = &mut *inner;
        atlas.lay(device, queue, &mut encoder, pipelines);
        // Another view can lay a smaller batch into the same scratch buffer before submission.
        // Its upload must not replace the first batch's inputs before that batch has executed.
        atlas.hold(Raster { size: [9, 7], coverage: vec![255; 63], baseline: 5.0 }).expect("second batch");
        atlas.lay(device, queue, &mut encoder, pipelines);
        let [l, t, r, b] = glyphs.rect;
        let (w, h) = (r - l, b - t);
        let row = w.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: u64::from(row * h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &atlas.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x: l, y: t, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) },
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        queue.submit([encoder.finish()]);
        let slice = readback.slice(..);
        slice.map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
        let wait = wgpu::PollType::Wait { submission_index: None, timeout: Some(std::time::Duration::from_secs(10)) };
        device.poll(wait).expect("the GPU finishes");
        let texels = slice.get_mapped_range().expect("mapped");
        let made: Vec<u8> = texels.chunks(row as usize).flat_map(|line| &line[..w as usize]).copied().collect();
        let want = exact(&coverage, width, height);
        let off = made.iter().zip(&want).filter(|(a, b)| a.abs_diff(**b) > 1).count();
        assert_eq!(off, 0, "every texel within a step of the exact field");
        let deepest = made.iter().max().copied().unwrap_or(0);
        assert!(made.contains(&0) && deepest > 224, "the field runs from nothing outside to deep inside: {deepest}");
    }
}
