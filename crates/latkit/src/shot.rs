//! Shots: pictures of views at their own size.
//!
//! A shot draws each view into its panel of the picture, with its own frames and clock, until every
//! view is complete. One compute pass then composes the panels into the exact bytes the consumer
//! needs: RGBA rows for an image, or NV12 planes for a video encoder. A buffer copy reads them
//! back, so no pixel is processed on the CPU.
//!
//! A view draws at one size at a time, so nothing else draws it during a shot. Natively the shot
//! borrows the view. In a browser, the view's canvas keeps its last frame. A picture draws each
//! view's data as of when the picture began. A video's frames follow data changes.

use std::sync::Arc;
use std::task::Waker;
use std::time::Duration;

use web_time::Instant;

use crate::gpu::pipelines::{Asked, Variant};
use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::{FORMAT, Gpu};
use crate::panels::Rect;
use crate::time::Notify;
use crate::view::Signal;
use crate::{Error, Frame, Image, Panels, Pixels, Result, View};

/// Seconds a picture advances its views' clocks per step while they ease to their targets.
pub(crate) const TICK: f64 = 1.0 / 60.0;
/// The longest a picture waits for work to arrive before drawing again.
const FRAME: Duration = Duration::from_millis(16);

/// A picture of views, taken when they are complete, as its [`Capture`] says. Each view draws into
/// its panel of a `size`-pixel picture, at `scale` pixels per CSS pixel. A shot is plain data, like
/// a scene.
///
/// ```no_run
/// # async fn example(view: &mut latkit::View) -> latkit::Result<()> {
/// use latkit::Shot;
/// let image = Shot::new([3840, 2160]).scale(2.0).image(&mut [view]).await?;
/// std::fs::write("view.png", image.encode(latkit::ImageFormat::Png)?).expect("written");
/// # Ok(()) }
/// ```
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Shot {
    /// Width and height in pixels.
    size: [u32; 2],
    /// Pixels per CSS pixel. Views lay out `size / scale` CSS pixels. Defaults to 1.
    #[serde(default = "one")]
    scale: f32,
    /// Each view's panel, `[x, y, width, height]` as fractions of the picture. Defaults to one view
    /// filling it.
    #[serde(default)]
    panels: Panels,
    /// Whether the picture keeps alpha where the themes' backgrounds would be.
    #[serde(default)]
    transparent: bool,
    /// When the picture is taken: once its views are complete and still, or as they are now.
    #[serde(default)]
    capture: Capture,
    /// The longest a picture or video frame may take. Defaults to 30 seconds. `None` waits as long
    /// as the caller does.
    #[serde(skip, default = "thirty")]
    deadline: Option<Duration>,
    /// Fixed effect time in seconds for elapsed-time expressions and flowing comets. `None` follows
    /// the view's clock.
    #[serde(default, deserialize_with = "some_seconds")]
    #[schemars(with = "Option<f64>")]
    elapsed: Option<Duration>,
}

fn one() -> f32 {
    1.0
}

#[expect(clippy::unnecessary_wraps, reason = "serde default for an optional deadline that callers may remove")]
fn thirty() -> Option<Duration> {
    Some(Duration::from_secs(30))
}

/// When a picture is taken.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Capture {
    /// Once every view is complete and still. Transitions, camera flights, and tile fades advance
    /// 1/60 s per step until they finish.
    #[default]
    Still,
    /// Once every view is complete, as it is now. Anything in motion is captured where it is.
    Now,
}

fn some_seconds<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<Duration>, D::Error> {
    crate::scene::seconds(deserializer).map(Some)
}

impl Shot {
    /// A picture of `size` pixels, with one view filling it at one pixel per CSS pixel.
    pub fn new(size: [u32; 2]) -> Shot {
        Shot {
            size,
            scale: 1.0,
            panels: Panels::default(),
            transparent: false,
            capture: Capture::Still,
            deadline: thirty(),
            elapsed: None,
        }
    }

    /// Sets pixels per CSS pixel. A view lays out `size / scale` CSS pixels, so 2 draws the same
    /// content twice as sharp.
    #[must_use]
    pub fn scale(mut self, scale: f32) -> Shot {
        self.scale = scale;
        self
    }

    /// Sets each view's panel in the picture, one per view, in order. Defaults to one view filling
    /// the picture.
    #[must_use]
    pub fn panels(mut self, panels: impl Into<Panels>) -> Shot {
        self.panels = panels.into();
        self
    }

    /// Keeps the picture's alpha. Views clear to transparent instead of their themes' backgrounds.
    #[must_use]
    pub fn transparent(mut self) -> Shot {
        self.transparent = true;
        self
    }

    /// Sets when the picture is taken: once its views are complete and still, or as they are now.
    /// Defaults to [`Capture::Still`].
    #[must_use]
    pub fn capture(mut self, capture: Capture) -> Shot {
        self.capture = capture;
        self
    }

    /// Sets the longest real time a picture or video frame may take, including GPU readback.
    /// Defaults to 30 seconds. `None` waits until the caller drops the future. A picture still
    /// incomplete at the deadline fails with [`Error::Timeout`].
    #[must_use]
    pub fn deadline(mut self, deadline: Option<Duration>) -> Shot {
        self.deadline = deadline;
        self
    }

    /// Fixes elapsed-time expressions and animated drawing effects at `elapsed`, while finite
    /// transitions still settle. Defaults to following the view's clock.
    #[must_use]
    pub fn elapsed(mut self, elapsed: Duration) -> Shot {
        self.elapsed = Some(elapsed);
        self
    }

    /// The picture's width and height in pixels.
    pub fn size(&self) -> [u32; 2] {
        self.size
    }

    /// Checks without a GPU that the shot's pictures can compose into `pixels`. Requires a positive
    /// scale, a size of at least one whole block of `pixels` (4×2 for NV12), and panels that cover
    /// pixels. NV12 also requires no transparency.
    pub fn check(&self, pixels: Pixels) -> Result<()> {
        if !(self.scale.is_finite() && self.scale > 0.0) {
            return Err(Error::invalid("a shot's scale must be positive").at("scale"));
        }
        let size = self.rounded(pixels).size;
        if size.contains(&0) {
            let [width, height] = align(pixels);
            return Err(Error::invalid(format!("must be at least {width}×{height} pixels")).at("size"));
        }
        self.panels.rects(size, align(pixels))?;
        if pixels == Pixels::Nv12 && self.transparent {
            return Err(Error::invalid("a video has no alpha channel, so it cannot be transparent").at("transparent"));
        }
        Ok(())
    }

    /// This shot with its size rounded down to whole blocks of `pixels`: for NV12, a width that is
    /// a multiple of 4 and an even height.
    pub(crate) fn rounded(&self, pixels: Pixels) -> Shot {
        let block = align(pixels);
        Shot { size: [0, 1].map(|i| self.size[i] - self.size[i] % block[i]), ..self.clone() }
    }

    /// Takes the picture of `views`, one per panel, once every view is complete as the [`Capture`]
    /// says. Each view draws its data as of when the picture began.
    ///
    /// Fails on a render error, including errors still queued in [`View::events`], or at the
    /// deadline. Events stay available to the caller, and the views are given back even if the
    /// future is dropped.
    pub async fn image(&self, views: &mut [&mut View]) -> Result<Image> {
        self.image_of(&mut Borrowed(views)).await
    }

    /// Takes the picture of the views `views` lends.
    pub(crate) async fn image_of(&self, views: &mut impl Views) -> Result<Image> {
        let mut drawing = Drawing::later(self.clone(), Pixels::Rgba, true);
        views.lend(|views| drawing.begin(views))?;
        let still = self.capture == Capture::Still;
        let mut time = 0.0;
        loop {
            match views.lend(|views| drawing.step(views, time, still))? {
                Step::Done(readback) => {
                    let bytes = drawing.read(&readback).await?;
                    views.lend(|views| {
                        for view in views {
                            if let Some(error) = view.shot_error() {
                                return Err(error);
                            }
                        }
                        Ok(())
                    })?;
                    return Image::new(self.size, bytes);
                }
                Step::Easing => time += TICK,
                Step::Waiting => drawing.wait().await,
            }
        }
    }
}

/// Lends a drawing its views for one step at a time. Natively these are borrowed views. In a
/// browser they are canvases' views, which the page may use between steps.
pub(crate) trait Views {
    /// Calls `f` with the views, one per panel.
    fn lend<R>(&mut self, f: impl FnOnce(&mut [&mut View]) -> R) -> R;
}

/// Views borrowed for the whole drawing.
pub(crate) struct Borrowed<'a, 'b>(pub(crate) &'a mut [&'b mut View]);

impl Views for Borrowed<'_, '_> {
    fn lend<R>(&mut self, f: impl FnOnce(&mut [&mut View]) -> R) -> R {
        f(self.0)
    }
}

/// One view's panel of a picture: its target texture, its size, and its compose bind group.
struct Panel {
    target: wgpu::TextureView,
    size: [u32; 2],
    group: wgpu::BindGroup,
}

/// The outcome of one drawing step.
pub(crate) enum Step {
    /// Every view was complete. Holds the readback of the picture's bytes.
    Done(Readback),
    /// Views are still easing. Draw again one step later.
    Easing,
    /// Views wait for pending work. Draw again when it arrives, which wakes the drawing.
    Waiting,
}

/// A shot's pictures in progress, composed into `pixels`. The views come with the first picture.
pub(crate) struct Drawing {
    shot: Shot,
    pixels: Pixels,
    /// The textures and buffer the pictures draw into, created once the views are known.
    picture: Option<Picture>,
    notify: Arc<Notify>,
    waker: Waker,
    /// The views' previous wakers, given back when the drawing is dropped.
    lent: Vec<(Arc<Signal>, Option<Waker>)>,
    /// Whether views draw their data as of when the drawing began, as pictures do. A video's views
    /// follow their data from frame to frame.
    holding: bool,
    /// When the current picture began, for its deadline.
    started: Option<Instant>,
}

/// The GPU resources a drawing's pictures draw into: one texture per view, and the buffer they
/// compose into.
struct Picture {
    gpu: Gpu,
    panels: Vec<Panel>,
    /// The composed picture's bytes, and their count.
    buffer: wgpu::Buffer,
    len: u64,
    /// Fills the background where no panel draws. Present when the panels may leave gaps.
    fill: Option<wgpu::BindGroup>,
}

impl Drawing {
    /// A drawing of `shot`'s pictures, composed into `pixels`. The first picture is given the
    /// views. With `holding`, views draw their data as of when they were given.
    pub(crate) fn later(shot: Shot, pixels: Pixels, holding: bool) -> Drawing {
        let notify = Arc::new(Notify::default());
        let waker = Waker::from(notify.clone());
        Drawing { shot, pixels, picture: None, notify, waker, lent: Vec::new(), holding, started: None }
    }

    /// Begins a picture of `views`, one per panel. The first call takes the views: until the
    /// drawing is dropped, their wakers wake the drawing and nothing else draws them. Fails if
    /// the view count differs from the panel count, a view is already lent, or the views use
    /// different GPUs.
    pub(crate) fn begin(&mut self, views: &[&mut View]) -> Result<()> {
        self.started = Some(Instant::now());
        let expected = self.shot.panels.len();
        if views.len() != expected {
            return Err(Error::invalid(format!("a shot of {expected} panels was given {} views", views.len())));
        }
        if self.picture.is_none() {
            for (i, view) in views.iter().enumerate() {
                if view.lent() || views[..i].iter().any(|other| Arc::ptr_eq(other.signal(), view.signal())) {
                    return Err(Error::invalid("a view is listed twice or already in use by a shot or video"));
                }
                if !Arc::ptr_eq(&views[0].gpu().0, &view.gpu().0) {
                    return Err(Error::invalid("all views must use the same GPU"));
                }
            }
            self.picture = Some(Picture::new(&self.shot, views, self.pixels)?);
            self.lent = views
                .iter()
                .map(|view| {
                    let signal = view.signal().clone();
                    let before = signal.lend(
                        self.waker.clone(),
                        self.shot.elapsed.map(|elapsed| elapsed.as_secs_f64()),
                        self.shot.transparent,
                        self.holding,
                    );
                    (signal, before)
                })
                .collect();
        }
        Ok(())
    }
}

impl Picture {
    /// Creates the textures and buffer for pictures of `shot` from `views`, one per panel, composed
    /// into `pixels`. Fails if the picture exceeds the GPU's limits.
    fn new(shot: &Shot, views: &[&mut View], pixels: Pixels) -> Result<Picture> {
        shot.check(pixels)?;
        let rects = shot.panels.rects(shot.size, align(pixels))?;
        let [width, height] = shot.size;
        let gpu = views[0].gpu().clone();
        let device = gpu.device();
        let limits = device.limits();
        if width == 0 || height == 0 || width.max(height) > limits.max_texture_dimension_2d {
            return Err(Error::Limit(
                format!(
                    "a picture of {width}×{height} pixels exceeds this GPU's limit of {0}×{0}",
                    limits.max_texture_dimension_2d
                )
                .into(),
            ));
        }
        let area = u64::from(width) * u64::from(height);
        let len = match pixels {
            Pixels::Rgba => area * 4,
            Pixels::Nv12 => area * 3 / 2,
        };
        if len > limits.max_storage_buffer_binding_size.min(limits.max_buffer_size) {
            return Err(Error::Limit(
                format!("a picture of {width}×{height} pixels exceeds this GPU's buffer size limit").into(),
            ));
        }
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("latkit shot"),
            size: len,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        // Gaps get the first view's background, or stay clear in a transparent picture.
        let background = if shot.transparent { [0.0; 4] } else { views[0].scene().theme.background.to_array() };
        let layout = gpu.0.lock().pipelines.pass_layout(device, Shader::Compose);
        let uniform = |origin: [u32; 2], size: [u32; 2]| {
            let compose = wgsl::Compose {
                origin,
                size,
                picture: shot.size,
                chroma: (area / 4) as u32,
                alpha: u32::from(shot.transparent),
                background,
            };
            let uniform = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("latkit compose"),
                size: size_of::<wgsl::Compose>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            gpu.0.queue.write_buffer(&uniform, 0, bytemuck::bytes_of(&compose));
            uniform
        };
        let group = |target: &wgpu::TextureView, uniform: &wgpu::Buffer| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("latkit compose"),
                layout: &layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(target) },
                    wgpu::BindGroupEntry { binding: 1, resource: buffer.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() },
                ],
            })
        };
        let panels: Vec<Panel> = rects
            .iter()
            .map(|&Rect { origin, size }| {
                let texture = device.create_texture(&wgpu::TextureDescriptor {
                    label: Some("latkit panel"),
                    size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: FORMAT,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                });
                let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
                let group = group(&target, &uniform(origin, size));
                Panel { target, size, group }
            })
            .collect();
        let covered: u64 = rects.iter().map(|r| u64::from(r.size[0]) * u64::from(r.size[1])).sum();
        let overlap = rects.iter().enumerate().any(|(i, a)| rects[i + 1..].iter().any(|b| a.overlaps(*b)));
        let fill = (covered < area || overlap).then(|| group(&panels[0].target, &uniform([0, 0], shot.size)));
        Ok(Picture { gpu: gpu.clone(), panels, buffer, len, fill })
    }
}

impl Drawing {
    /// Draws every view into its panel once, at `time`. When every view is complete, and none is
    /// easing if `still`, composes the panels and starts the readback. Until the views' pipelines
    /// have compiled, draws nothing and returns [`Step::Waiting`], even while views are easing.
    pub(crate) fn step(&mut self, views: &mut [&mut View], time: f64, still: bool) -> Result<Step> {
        let picture = self.picture.as_ref().ok_or_else(|| Error::invalid("a picture must begin before it draws"))?;
        if picture.gpu.lost() {
            return Err(Error::DeviceLost);
        }
        self.check_deadline()?;
        let scale = self.shot.scale;
        let mut ready = true;
        for view in views.iter_mut() {
            ready &= view.ready_for(FORMAT, scale, false);
        }
        if !ready {
            return Ok(Step::Waiting);
        }
        let device = picture.gpu.device();
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit shot") });
        for (view, panel) in views.iter_mut().zip(&picture.panels) {
            let frame = Frame { target: &panel.target, format: FORMAT, size: panel.size, pixel_ratio: scale, time };
            view.render_picture(&mut encoder, &frame);
        }
        let complete = views.iter().all(|v| v.complete());
        let easing = still && views.iter().any(|v| v.easing());
        if let Some(error) = views.iter_mut().find_map(|view| view.shot_error()) {
            picture.gpu.queue().submit([encoder.finish()]);
            return Err(error);
        }
        self.check_deadline()?;
        let composes = picture.composes(self.pixels, &self.waker);
        let step = if complete && !easing && composes {
            picture.compose(&mut encoder, self.pixels, self.shot.size);
            let inner = picture.gpu.0.lock();
            let (buffer, len) = (&picture.buffer, picture.len);
            let readback = Readback::new(&inner.readbacks, device, &mut encoder, buffer, 0, len, &self.waker);
            drop(inner);
            Step::Done(readback)
        } else if easing {
            Step::Easing
        } else {
            Step::Waiting
        };
        picture.gpu.queue().submit([encoder.finish()]);
        Ok(step)
    }

    /// Returns `readback`'s bytes once the GPU has written them. Fails at the deadline or when the
    /// device is lost.
    pub(crate) async fn read(&self, readback: &Readback) -> Result<Vec<u8>> {
        loop {
            self.check_deadline()?;
            self.finish();
            self.check_deadline()?;
            if let Some(bytes) = readback.take() {
                return bytes;
            }
            if self.picture.as_ref().is_some_and(|p| p.gpu.lost()) {
                return Err(Error::DeviceLost);
            }
            self.notify.wait(FRAME).await;
        }
    }

    /// Waits until work a view depends on arrives, or one frame's time passes.
    pub(crate) async fn wait(&self) {
        self.finish();
        self.notify.wait(FRAME).await;
    }

    fn check_deadline(&self) -> Result<()> {
        if let (Some(started), Some(deadline)) = (self.started, self.shot.deadline)
            && started.elapsed() >= deadline
        {
            return Err(Error::Timeout);
        }
        Ok(())
    }

    /// Natively, polls the device so readbacks map and wake the drawing. A browser maps them
    /// itself.
    #[cfg_attr(target_arch = "wasm32", expect(clippy::unused_self, reason = "a browser maps readbacks itself"))]
    fn finish(&self) {
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(picture) = &self.picture {
            let remaining = match (self.started, self.shot.deadline) {
                (Some(started), Some(deadline)) => deadline.saturating_sub(started.elapsed()),
                _ => FRAME,
            };
            let wait = wgpu::PollType::Wait { submission_index: None, timeout: Some(FRAME.min(remaining)) };
            let _ = picture.gpu.device().poll(wait);
        }
    }
}

/// The compose passes for `pixels`: the background fill and the per-panel pass, plus the pixel
/// block each thread writes.
fn composing(pixels: Pixels) -> (Variant, Variant, [u32; 2]) {
    let pass = |entry| Variant::compute(Shader::Compose, entry);
    match pixels {
        Pixels::Rgba => (pass("fill_rgba"), pass("rgba"), [1, 1]),
        Pixels::Nv12 => (pass("fill_nv12"), pass("nv12"), [4, 2]),
    }
}

impl Picture {
    /// Whether the compose pipelines for `pixels` have compiled. The first call requests them all
    /// together, and `waker` wakes when they finish.
    fn composes(&self, pixels: Pixels, waker: &Waker) -> bool {
        let (fill, each, _) = composing(pixels);
        let needs: Vec<Asked> = self.fill.as_ref().map(|_| fill).into_iter().chain([each]).map(Asked::Shader).collect();
        let mut inner = self.gpu.0.lock();
        inner.pipelines.ask(self.gpu.device(), &needs, crate::gpu::pipelines::Urgency::Draw, waker);
        inner.pipelines.ready(&needs)
    }

    /// Records the passes that compose every panel into the picture's `pixels`. Fills the
    /// background first where panels may leave gaps.
    fn compose(&self, encoder: &mut wgpu::CommandEncoder, pixels: Pixels, size: [u32; 2]) {
        let device = self.gpu.device();
        let mut inner = self.gpu.0.lock();
        let (fill, each, block) = composing(pixels);
        let groups = |size: [u32; 2]| [0, 1].map(|i| size[i].div_ceil(block[i]).div_ceil(16));
        let mut pass = encoder
            .begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("latkit compose"), timestamp_writes: None });
        pass.set_bind_group(0, &inner.pipelines.empty, &[]);
        pass.set_bind_group(1, &inner.pipelines.empty, &[]);
        if let Some(group) = &self.fill {
            pass.set_pipeline(&inner.pipelines.compute(device, fill));
            pass.set_bind_group(2, group, &[]);
            let [x, y] = groups(size);
            pass.dispatch_workgroups(x, y, 1);
        }
        let pipeline = inner.pipelines.compute(device, each);
        pass.set_pipeline(&pipeline);
        for panel in &self.panels {
            pass.set_bind_group(2, &panel.group, &[]);
            let [x, y] = groups(panel.size);
            pass.dispatch_workgroups(x, y, 1);
        }
    }
}

impl Drop for Drawing {
    /// Gives each view back its previous waker, so its previous owner draws it again.
    fn drop(&mut self) {
        for (signal, before) in self.lent.drain(..) {
            signal.give_back(before);
        }
    }
}

/// The pixel block a picture in `pixels` is made of: one pixel, or NV12's 4×2 block of luma with
/// shared chroma.
fn align(pixels: Pixels) -> [u32; 2] {
    match pixels {
        Pixels::Rgba => [1, 1],
        Pixels::Nv12 => [4, 2],
    }
}
