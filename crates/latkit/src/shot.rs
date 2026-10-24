//! Shots: pictures of views at a size of their own. A shot draws each view into its panel of the
//! picture through frames of its own, on a clock of its own, until every view is complete; then one
//! compute pass composes the parts into exactly the bytes its consumer takes, RGBA rows for an image
//! or NV12 planes for a video's encoder, and a plain buffer copy reads them back. No pixel is touched
//! on the CPU.
//!
//! A view draws at one size at a time: while a shot draws it, nothing else does. Natively the shot
//! borrows it; in a browser its canvas holds its last frame. A picture draws each view's data as it
//! was when the picture began; a video's frames follow its data.

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

/// Seconds a picture steps its views' clocks while they ease toward where they go.
pub(crate) const TICK: f64 = 1.0 / 60.0;
/// The longest a picture waits for work to land before drawing again.
const FRAME: Duration = Duration::from_millis(16);

/// A picture of views, each drawn into its panel of `size` pixels at `scale` pixels per CSS pixel,
/// once they are complete as its capture says: plain data, like a scene.
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
    /// Pixels per CSS pixel: views lay out `size / scale` CSS pixels; 1 unless set.
    #[serde(default = "one")]
    scale: f32,
    /// Each view's panel of the picture, `[x, y, width, height]` as fractions; the whole by default.
    #[serde(default)]
    panels: Panels,
    /// Whether alpha is kept where the themes' backgrounds would be.
    #[serde(default)]
    transparent: bool,
    /// When the picture is taken: once its views are complete and still, or as they are now.
    #[serde(default)]
    capture: Capture,
    /// The longest a picture, or a video frame, may take: 30 seconds unless set, or as long as its
    /// caller waits.
    #[serde(skip, default = "thirty")]
    deadline: Option<Duration>,
    /// A still's effect time in seconds, where elapsed time and flowing comets read it.
    #[serde(default, deserialize_with = "some_seconds")]
    #[schemars(with = "Option<f64>")]
    elapsed: Option<Duration>,
}

fn one() -> f32 {
    1.0
}

#[expect(clippy::unnecessary_wraps, reason = "what a shot made from JSON waits, which its caller may lift")]
fn thirty() -> Option<Duration> {
    Some(Duration::from_secs(30))
}

/// When a picture is taken.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Capture {
    /// Once every view is complete and still: transitions, flights, and label fades run on, a
    /// sixtieth of a second a step, until they land.
    #[default]
    Still,
    /// Once every view is complete, as it stands now: what moves holds where it is.
    Now,
}

fn some_seconds<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<Duration>, D::Error> {
    crate::scene::seconds(deserializer).map(Some)
}

impl Shot {
    /// A picture of `size` pixels, one view filling it at a pixel per CSS pixel.
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

    /// Draws `scale` pixels per CSS pixel: a view lays out `size / scale` CSS pixels, so 2 draws what
    /// it shows twice as sharp.
    #[must_use]
    pub fn scale(mut self, scale: f32) -> Shot {
        self.scale = scale;
        self
    }

    /// Where each view draws in the picture, one panel per view in order; by default one view fills it.
    #[must_use]
    pub fn panels(mut self, panels: impl Into<Panels>) -> Shot {
        self.panels = panels.into();
        self
    }

    /// Keeps the picture's alpha: views clear to transparent where their themes' backgrounds are.
    #[must_use]
    pub fn transparent(mut self) -> Shot {
        self.transparent = true;
        self
    }

    /// Takes the picture as `capture` says: once its views are complete and still, by default, or as
    /// they are now.
    #[must_use]
    pub fn capture(mut self, capture: Capture) -> Shot {
        self.capture = capture;
        self
    }

    /// The longest, in real time, a picture or a video frame may take, including GPU readback: 30
    /// seconds unless set; `None` waits for as long as its caller does, who drops the future to stop.
    /// An incomplete picture returns [`Error::Timeout`].
    #[must_use]
    pub fn deadline(mut self, deadline: Option<Duration>) -> Shot {
        self.deadline = deadline;
        self
    }

    /// Fixes elapsed-time expressions and animated drawing effects at this time while finite
    /// transitions still settle. By default they follow the view's clock.
    #[must_use]
    pub fn elapsed(mut self, elapsed: Duration) -> Shot {
        self.elapsed = Some(elapsed);
        self
    }

    /// The picture's width and height in pixels.
    pub fn size(&self) -> [u32; 2] {
        self.size
    }

    /// Checks, without a GPU, that its pictures compose into `pixels`: a positive scale, panels that
    /// cover pixels, and for NV12 a width a multiple of 4, a height of 2, and no alpha.
    pub fn check(&self, pixels: Pixels) -> Result<()> {
        if !(self.scale.is_finite() && self.scale > 0.0) {
            return Err(Error::invalid("a shot's scale is positive").at("scale"));
        }
        self.panels.rects(self.size, align(pixels))?;
        let [width, height] = self.size;
        if pixels == Pixels::Nv12 && (width % 4 != 0 || height % 2 != 0) {
            let reason = format!("an NV12 video's width is a multiple of 4 and its height of 2, not {width}×{height}");
            return Err(Error::invalid(reason).at("size"));
        }
        if pixels == Pixels::Nv12 && self.transparent {
            return Err(Error::invalid("a video keeps no alpha; take it without transparent").at("transparent"));
        }
        Ok(())
    }

    /// The picture of `views`, one per panel, once every one is complete as its [`Capture`] says,
    /// each drawing its data as it was when the picture began. Fails on a render error (including
    /// errors still queued in [`View::events`]) or its deadline; events remain available to the
    /// caller and views are returned even on cancellation.
    pub async fn image(&self, views: &mut [&mut View]) -> Result<Image> {
        self.image_of(&mut Borrowed(views)).await
    }

    /// The picture of the views `views` lends.
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

/// What lends a drawing its views for a step at a time: borrowed views natively; in a browser the
/// views of canvases, which the page may read between steps.
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

/// One view's panel of a picture: the texture it draws into, its size, and the bind group
/// composing it.
struct Panel {
    target: wgpu::TextureView,
    size: [u32; 2],
    group: wgpu::BindGroup,
}

/// What a step of drawing came to.
pub(crate) enum Step {
    /// Every view was complete: the picture's bytes, once read back.
    Done(Readback),
    /// Views still ease toward where they go: draw again a step later.
    Easing,
    /// Views wait for work under way: draw again once it lands, which wakes the drawing.
    Waiting,
}

/// Pictures under way: a shot's, composed into `pixels`, from views it draws once it has them.
pub(crate) struct Drawing {
    shot: Shot,
    pixels: Pixels,
    /// What the pictures draw into, once the views are known.
    picture: Option<Picture>,
    notify: Arc<Notify>,
    waker: Waker,
    /// The wakers the views had, given back once the drawing is done.
    lent: Vec<(Arc<Signal>, Option<Waker>)>,
    /// Whether its views draw their data as it was when the drawing began, as a picture's do; a
    /// video's follow it from frame to frame.
    holding: bool,
    /// When the picture under way began, for its deadline.
    started: Option<Instant>,
}

/// What a drawing's pictures draw into: one texture per view, and the buffer they compose into.
struct Picture {
    gpu: Gpu,
    panels: Vec<Panel>,
    /// The picture's bytes, and how many there are.
    buffer: wgpu::Buffer,
    len: u64,
    /// The background where no panel draws, when the panels leave gaps.
    fill: Option<wgpu::BindGroup>,
}

impl Drawing {
    /// Pictures of `shot` composed into `pixels`, drawn from the views the first picture is given,
    /// `holding` the data the views draw as it was when they were given.
    pub(crate) fn later(shot: Shot, pixels: Pixels, holding: bool) -> Drawing {
        let notify = Arc::new(Notify::default());
        let waker = Waker::from(notify.clone());
        Drawing { shot, pixels, picture: None, notify, waker, lent: Vec::new(), holding, started: None }
    }

    /// Begins a picture of `views`, one per panel. The first takes the views: their wakers wake the
    /// drawing until it is done, and nothing else draws them.
    pub(crate) fn begin(&mut self, views: &[&mut View]) -> Result<()> {
        self.started = Some(Instant::now());
        let expected = self.shot.panels.len();
        if views.len() != expected {
            return Err(Error::invalid(format!("a shot of {expected} panels draws {} views", views.len())));
        }
        if self.picture.is_none() {
            for (i, view) in views.iter().enumerate() {
                if view.lent() || views[..i].iter().any(|other| Arc::ptr_eq(other.signal(), view.signal())) {
                    return Err(Error::invalid("a view is already lent to a picture"));
                }
                if !Arc::ptr_eq(&views[0].gpu().0, &view.gpu().0) {
                    return Err(Error::invalid("all panels must use the same GPU"));
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
    /// What pictures of `shot` from `views`, one per panel, draw into, composed into `pixels`.
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
                    "a picture of {width}×{height} pixels; this GPU draws up to {0}×{0}",
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
                format!("a picture of {width}×{height} pixels is larger than this GPU binds").into(),
            ));
        }
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("latkit shot"),
            size: len,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        // Gaps take the first view's background, or none in a transparent picture.
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
    /// Draws every view into its panel at `time` once. When every one is complete, and with `still`
    /// none eases, composes them and starts reading the picture back. Until what the views draw with
    /// compiled, it draws nothing and waits for that to land, eased or not.
    pub(crate) fn step(&mut self, views: &mut [&mut View], time: f64, still: bool) -> Result<Step> {
        let picture = self.picture.as_ref().ok_or_else(|| Error::invalid("a picture begins before it draws"))?;
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

    /// The bytes `readback` holds, once the GPU has them.
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

    /// Waits until work a view waits on lands, or a frame's time passes.
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

    /// Natively, polls what was submitted, so readbacks map and wake the drawing; a browser maps
    /// them itself.
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

/// The compose passes of a picture of `pixels`: the background's, each panel's, and the blocks each
/// thread writes.
fn composing(pixels: Pixels) -> (&'static str, &'static str, [u32; 2]) {
    match pixels {
        Pixels::Rgba => ("fill_rgba", "rgba", [1, 1]),
        Pixels::Nv12 => ("fill_nv12", "nv12", [4, 2]),
    }
}

impl Picture {
    /// Whether what composes it into `pixels` compiled: asked for as its first picture composes, all
    /// at once, `waker` waking as it lands.
    fn composes(&self, pixels: Pixels, waker: &Waker) -> bool {
        let (fill, each, _) = composing(pixels);
        let needs: Vec<Asked> = self
            .fill
            .as_ref()
            .map(|_| fill)
            .into_iter()
            .chain([each])
            .map(|entry| Asked::Shader(Variant::compute(Shader::Compose, entry)))
            .collect();
        let mut inner = self.gpu.0.lock();
        inner.pipelines.ask(self.gpu.device(), &needs, crate::gpu::pipelines::Urgency::Draw, waker);
        inner.pipelines.ready(&needs)
    }

    /// Records the passes composing every panel into the picture's `pixels`, the background first
    /// where panels leave gaps.
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
            pass.set_pipeline(&inner.pipelines.compute(device, Shader::Compose, fill));
            pass.set_bind_group(2, group, &[]);
            let [x, y] = groups(size);
            pass.dispatch_workgroups(x, y, 1);
        }
        let pipeline = inner.pipelines.compute(device, Shader::Compose, each);
        pass.set_pipeline(&pipeline);
        for panel in &self.panels {
            pass.set_bind_group(2, &panel.group, &[]);
            let [x, y] = groups(panel.size);
            pass.dispatch_workgroups(x, y, 1);
        }
    }
}

impl Drop for Drawing {
    /// Gives each view back the waker it had, so whatever drew it draws it again.
    fn drop(&mut self) {
        for (signal, before) in self.lent.drain(..) {
            signal.give_back(before);
        }
    }
}

/// The blocks a picture composed into `pixels` is made of: a pixel, or NV12's 4×2 of luma and
/// shared chroma.
fn align(pixels: Pixels) -> [u32; 2] {
    match pixels {
        Pixels::Rgba => [1, 1],
        Pixels::Nv12 => [4, 2],
    }
}
