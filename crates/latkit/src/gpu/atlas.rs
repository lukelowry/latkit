//! The text atlas. The host rasterizes each text run once at `TEXT_BASE`. The GPU turns the raster
//! into a distance field that extends `TEXT_SPREAD` texels past the text's edge, and packs it on a
//! shelf of one texture. A distance field draws crisp at any size and also gives halos, so each run
//! is rasterized once whatever size it shows at. Before a frame draws, the GPU builds the fields of
//! every run rasterized in that frame in one batch (`compute/fields.wesl`).
//!
//! When no shelf has space, the least recently used shelf that is tall enough is cleared for the
//! new run. A run counts as used when it is rasterized and whenever labels in view show it. A shelf
//! used this frame is never cleared, so visible text is not evicted. When every shelf is in use,
//! the atlas is full for the rest of the frame and takes no more runs. It starts over only when
//! nothing in it was used this frame. Views track evictions to drop stale references.

use std::collections::HashMap;
use std::sync::Arc;

use crate::gpu::grown::Grown;
use crate::gpu::pipelines::{Pipelines, Variant};
use crate::gpu::shaders::{FIELD_AT, FIELD_COLUMNS, FIELD_COVERAGE, FIELD_HEIGHT, FIELD_ROW, FIELD_WIDTH, FIELD_WORDS};
use crate::gpu::shaders::{Shader, TEXT_BASE, TEXT_SPREAD};
use crate::gpu::work::{Count, Counters, Queue};
use crate::host::{Host, Raster, TextRun};

/// The passes building distance fields: along columns, then along rows.
pub(crate) const FIELDS: [Variant; 2] =
    [Variant::compute(Shader::Fields, "columns"), Variant::compute(Shader::Fields, "rows")];

/// Texels across the atlas: room for about 1,400 labels of ten characters at the base size.
const SIZE: u32 = 4096;
/// Texels between runs, so filtering never reads a neighbor.
const GAP: u32 = 1;
/// Texels of field around a run's coverage.
const PAD: u32 = TEXT_SPREAD as u32;
/// The most runs one dispatch builds fields for, one workgroup layer each.
const RUNS: usize = 65_535;

/// Where `Atlas::hold` put a raster: at its glyphs on a shelf, nowhere because it has nothing to
/// draw or is malformed, or nowhere yet because the atlas is full this frame.
enum Held {
    Placed(Glyphs, usize),
    Nothing,
    Full,
}

/// A run's location in the atlas.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Glyphs {
    /// Left, top, right, and bottom in texels, extending `TEXT_SPREAD` past the text on every side.
    pub(crate) rect: [u32; 4],
    /// Texels from the top of the rectangle to the baseline.
    pub(crate) baseline: f32,
}

impl Glyphs {
    /// The rectangle as the two corner words shaders read: x in the low 16 bits, y in the high 16.
    pub(crate) fn corners(&self) -> [u32; 2] {
        let [l, t, r, b] = self.rect;
        [l | t << 16, r | b << 16]
    }
}

/// The run the atlas rasterizes for `text` shown at `size`, wrapping at `max_width`, both in length
/// units. The run is set at the base size, with `max_width` scaled to match. A sheet measures the
/// same run it draws.
pub(crate) fn run(text: Arc<str>, font: Arc<str>, size: f32, max_width: Option<f32>) -> TextRun {
    let wrap = max_width.map(|w| (w * TEXT_BASE / size.max(1e-3)).round().max(1.0) as u32);
    TextRun { text, font, size_px: TEXT_BASE as u32, max_width: wrap }
}

struct Shelf {
    top: u32,
    height: u32,
    used: u32,
    /// The clock tick when a run on it was last used.
    tick: u64,
}

/// A rasterized run whose field is not built yet: its coverage, and the shelf and corner its field
/// goes to.
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
    /// Every run rasterized: its location and shelf, or `None` when it has nothing to draw or its
    /// raster failed. Either way the host is not asked for it again.
    runs: HashMap<TextRun, Option<(Glyphs, usize)>>,
    /// Rasterized runs whose fields the next frame builds.
    waiting: Vec<Waiting>,
    /// Scratch buffer for building fields, and its bind group once built.
    work: Grown,
    work_group: Option<wgpu::BindGroup>,
    /// Frame counter for shelf use.
    clock: u64,
    /// Whether a run found no room this frame, so no more are placed until the next.
    full: bool,
    /// Changes whenever runs are evicted, so anything referencing them looks them up again.
    pub(crate) evictions: u64,
    /// Counts the texts the host is asked to rasterize.
    counters: Arc<Counters>,
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
            work: Grown::new(device, "latkit fields", wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC),
            work_group: None,
            clock: 0,
            full: false,
            evictions: 0,
            counters,
        }
    }

    /// Starts a frame. Runs requested from now on count as used in it.
    pub(crate) fn tick(&mut self) {
        self.clock += 1;
        self.full = false;
    }

    /// Whether a run found no room this frame, so the atlas takes no more until the next.
    pub(crate) fn full(&self) -> bool {
        self.full
    }

    /// The location of `run` in the atlas, rasterized by `host` on first request. Its field is
    /// built before the frame draws. `None` without a host, when the run has nothing to draw or its
    /// raster failed (a failure is reported once), or while the atlas is full this frame.
    pub(crate) fn text(&mut self, host: Option<&dyn Host>, run: &TextRun) -> Option<Glyphs> {
        if let Some(found) = self.runs.get(run) {
            let (glyphs, shelf) = (*found)?;
            self.shelves[shelf].tick = self.clock;
            return Some(glyphs);
        }
        let host = host.filter(|_| !self.full)?;
        self.counters.add(Count::Texts, 1);
        let placed = match host.rasterize(run).map(|raster| self.hold(raster)) {
            Ok(Held::Placed(glyphs, shelf)) => Some((glyphs, shelf)),
            Ok(Held::Nothing) => None,
            // No room this frame: the run is asked for again later.
            Ok(Held::Full) => return None,
            Err(error) => {
                self.errors.push(error);
                None
            }
        };
        self.runs.insert(run.clone(), placed);
        placed.map(|(glyphs, _)| glyphs)
    }

    /// Forgets the runs and failures the host made. A new host rasterizes texts again in its own
    /// fonts.
    pub(crate) fn rehost(&mut self) {
        self.runs.clear();
        self.waiting.clear();
        self.shelves.clear();
        self.evictions += 1;
    }

    /// Places `raster`'s field and queues it to be built. Returns where it was placed.
    fn hold(&mut self, raster: Raster) -> Held {
        let [w, h] = raster.size;
        if w == 0 || h == 0 {
            return Held::Nothing;
        }
        let (width, height) = (w.saturating_add(2 * PAD), h.saturating_add(2 * PAD));
        if width > SIZE || height > SIZE {
            self.errors.push(crate::Error::Limit("text raster does not fit the atlas".into()));
            return Held::Nothing;
        }
        if raster.coverage.len() != w as usize * h as usize {
            self.errors.push(crate::Error::invalid("text raster coverage does not match its size"));
            return Held::Nothing;
        }
        let Some((shelf, [left, top])) = self.place(width, height) else {
            self.full = true;
            return Held::Full;
        };
        let glyphs = Glyphs { rect: [left, top, left + width, top + height], baseline: raster.baseline + PAD as f32 };
        self.waiting.push(Waiting { raster, shelf, corner: [left, top] });
        Held::Placed(glyphs, shelf)
    }

    /// Marks `run` as used now, because labels in view show it.
    pub(crate) fn touch(&mut self, run: &TextRun) {
        if let Some(Some((_, shelf))) = self.runs.get(run) {
            self.shelves[*shelf].tick = self.clock;
        }
    }

    /// Whether `run` is still at `glyphs`.
    pub(crate) fn holds(&self, run: &TextRun, glyphs: Glyphs) -> bool {
        matches!(self.runs.get(run), Some(Some((g, _))) if *g == glyphs)
    }

    /// Builds the fields of runs rasterized since the last call, recorded into `encoder` before the
    /// draws that use them. Uploads their coverage, computes each column's and then each row's
    /// least squared distances within the spread, and copies each field into its place.
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
        // Scratch layout: run entries, coverage, column distances, then fields. Each field starts
        // at a valid copy offset, and its rows use the copy row pitch.
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
            let [columns, rows] = FIELDS;
            pass.set_pipeline(&pipelines.compute(device, columns));
            pass.dispatch_workgroups(most[0].div_ceil(16), most[1].div_ceil(16), laid.len() as u32);
            pass.set_pipeline(&pipelines.compute(device, rows));
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

    /// The scratch buffer for building fields, at least `bytes` long, and its bind group.
    fn fit_work(
        &mut self,
        device: &wgpu::Device,
        pipelines: &mut Pipelines,
        bytes: u64,
    ) -> (wgpu::Buffer, wgpu::BindGroup) {
        if self.work.ensure(device, bytes) || self.work_group.is_none() {
            self.work_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("latkit fields"),
                layout: &pipelines.pass_layout(device, Shader::Fields),
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: self.work.buffer.as_entire_binding() }],
            }));
        }
        (self.work.buffer.clone(), self.work_group.clone().expect("built above"))
    }

    /// Finds space for `width` by `height` texels and returns the shelf and top-left corner.
    /// Returns `None` when every shelf that could hold it was used this frame.
    fn place(&mut self, width: u32, height: u32) -> Option<(usize, [u32; 2])> {
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
            // Clear the least recently used shelf that is tall enough, preferring a fitting height.
            // Shelves used this frame are skipped.
            let clock = self.clock;
            let oldest = (0..self.shelves.len())
                .filter(|&i| self.shelves[i].height >= height && self.shelves[i].tick < clock)
                .min_by_key(|&i| (!fits(&self.shelves[i]), self.shelves[i].tick))?;
            self.runs.retain(|_, placed| !matches!(placed, Some((_, shelf)) if *shelf == oldest));
            self.waiting.retain(|w| w.shelf != oldest);
            self.shelves[oldest].used = 0;
            self.evictions += 1;
            Some(oldest)
        });
        let at = at.or_else(|| {
            // No shelf is tall enough. Start over, unless text in view uses the atlas this frame.
            if self.shelves.iter().any(|s| s.tick == self.clock) {
                return None;
            }
            self.runs.clear();
            self.waiting.clear();
            self.shelves.clear();
            self.evictions += 1;
            self.shelves.push(Shelf { top: 0, height, used: 0, tick: self.clock });
            Some(0)
        })?;
        let shelf = &mut self.shelves[at];
        let corner = [shelf.used, shelf.top];
        shelf.used += width + GAP;
        shelf.tick = self.clock;
        Some((at, corner))
    }
}

/// Alignment in bytes of a buffer-to-texture copy's start offset, valid on every backend.
const COPY_ALIGN: u32 = 512;

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact field of `width` by `height` coverage bytes, computed texel by texel: the least
    /// squared distance to inside and to outside over every texel within `PAD` texels.
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
    fn gpu_distance_fields_match_the_exact_field() {
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
        let Held::Placed(glyphs, _) = inner.atlas.hold(raster) else { panic!("placed") };
        let (device, queue) = (&gpu.0.device, &gpu.0.queue);
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let crate::gpu::Inner { atlas, pipelines, .. } = &mut *inner;
        atlas.lay(device, queue, &mut encoder, pipelines);
        // Another view can lay a smaller batch into the same scratch buffer before submission.
        // Its upload must not replace the first batch's inputs before that batch has executed.
        let held = atlas.hold(Raster { size: [9, 7], coverage: vec![255; 63], baseline: 5.0 });
        assert!(matches!(held, Held::Placed(..)), "a second batch");
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
        assert!(made.contains(&0) && deepest > 224, "the field runs from 0 outside to over 224 inside: {deepest}");
    }

    #[test]
    fn each_run_is_rasterized_once_however_it_turns_out() {
        /// A host that counts its rasters: none for "", a failure for "bad", else a square.
        struct Counting(std::sync::atomic::AtomicU32);
        impl Host for Counting {
            fn rasterize(&self, run: &TextRun) -> crate::Result<Raster> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                match &*run.text {
                    "" => Ok(Raster { size: [0, 0], coverage: Vec::new(), baseline: 0.0 }),
                    "bad" => Err(crate::Error::Unsupported("no font".into())),
                    _ => Ok(Raster { size: [4, 4], coverage: vec![255; 16], baseline: 3.0 }),
                }
            }
        }
        let gpu = match pollster::block_on(crate::Gpu::new()) {
            Ok(gpu) => gpu,
            Err(error) if std::env::var_os("LATKIT_REQUIRE_GPU").is_some() => panic!("GPU required: {error}"),
            Err(_) => return,
        };
        let counting = Counting(std::sync::atomic::AtomicU32::new(0));
        let rasters = || counting.0.load(std::sync::atomic::Ordering::Relaxed);
        let host: Option<&dyn Host> = Some(&counting);
        let text = |text: &str| run(text.into(), "sans-serif".into(), 12.0, None);
        let mut inner = gpu.0.lock();
        let atlas = &mut inner.atlas;
        for _ in 0..2 {
            assert!(atlas.text(host, &text("")).is_none(), "an empty raster draws nothing");
            assert!(atlas.text(host, &text("bad")).is_none(), "a failed raster draws nothing");
            assert!(atlas.text(host, &text("ok")).is_some(), "a raster is placed");
        }
        assert_eq!(rasters(), 3, "each run is rasterized once");
        assert_eq!(atlas.errors.len(), 1, "only the failure is reported, once: {:?}", atlas.errors);
        atlas.rehost();
        assert!(atlas.text(host, &text("ok")).is_some());
        assert_eq!(rasters(), 4, "a new host rasterizes the run again");
    }
}
