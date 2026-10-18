//! Shots: pictures of views at a size of their own. A shot draws each view into its part of the
//! picture through frames of its own, on a clock of its own, until every view is complete; then one
//! compute pass composes the parts into exactly the bytes its consumer takes, RGBA rows for an image
//! or NV12 planes for a video's encoder, and a plain buffer copy reads them back. No pixel is touched
//! on the CPU.
//!
//! A view draws at one size at a time: while a shot draws it, nothing else does. Natively the shot
//! borrows it; in a browser its canvas holds its last frame.

use std::sync::Arc;
use std::task::Waker;
use std::time::Duration;

use web_time::Instant;

use crate::gpu::readback::Readback;
use crate::gpu::shaders::{self as wgsl, Shader};
use crate::gpu::{FORMAT, Gpu};
use crate::time::Notify;
use crate::view::Signal;
use crate::{Error, Frame, Image, Pixels, Result, View};

/// Seconds a picture steps its views' clocks while they ease toward where they go.
pub(crate) const TICK: f64 = 1.0 / 60.0;
/// The longest a picture waits for work to land before drawing again.
const FRAME: Duration = Duration::from_millis(16);

/// A picture of views, each drawn into its part of `size` pixels at `scale` pixels per CSS pixel:
/// plain data, like a scene.
///
/// ```no_run
/// # async fn example(view: &mut latkit::View) -> latkit::Result<()> {
/// use latkit::Shot;
/// let image = Shot::new([3840, 2160]).scale(2.0).image(&mut [view]).await?;
/// std::fs::write("view.png", image.png()).expect("written");
/// # Ok(()) }
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Shot {
    size: [u32; 2],
    scale: f32,
    panels: Vec<[f32; 4]>,
    transparent: bool,
    deadline: Duration,
    elapsed: Option<Duration>,
}

impl Shot {
    /// A picture of `size` pixels, one view filling it at a pixel per CSS pixel.
    pub fn new(size: [u32; 2]) -> Shot {
        Shot {
            size,
            scale: 1.0,
            panels: Vec::new(),
            transparent: false,
            deadline: Duration::from_secs(30),
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

    /// Adds a view's part of the picture: x, y, width, and height as fractions of it. Views fill
    /// their parts in order; with none given, one view fills the picture.
    #[must_use]
    pub fn panel(mut self, part: [f32; 4]) -> Shot {
        self.panels.push(part);
        self
    }

    /// Keeps the picture's alpha: views clear to transparent where their themes' backgrounds are.
    #[must_use]
    pub fn transparent(mut self) -> Shot {
        self.transparent = true;
        self
    }

    /// The longest, in real time, a picture may take, including GPU readback: 30 seconds unless set.
    /// An incomplete picture returns [`Error::Timeout`].
    #[must_use]
    pub fn deadline(mut self, deadline: Duration) -> Shot {
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

    /// The picture of `views`, one per panel, once every one is complete and still: transitions,
    /// flights, and label fades run on, a sixtieth of a second a step, until they land.
    /// Fails on a render error (including errors still queued in [`View::events`]) or deadline;
    /// events remain available to the caller and views are returned even on cancellation.
    pub async fn image(&self, views: &mut [&mut View]) -> Result<Image> {
        self.image_of(&mut Borrowed(views)).await
    }

    /// The picture of the views `views` lends.
    pub(crate) async fn image_of(&self, views: &mut impl Views) -> Result<Image> {
        let mut drawing = Drawing::later(self.clone(), Pixels::Rgba);
        views.lend(|views| drawing.begin(views))?;
        let mut time = 0.0;
        loop {
            match views.lend(|views| drawing.step(views, time, true))? {
                Step::Done(readback) => {
                    let bytes = drawing.read(&readback).await?;
                    views.lend(|views| {
                        for view in views {
                            if let Some(error) = view.capture_error() {
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

    /// The parts of the picture its views fill, in pixels: origin and size, edges on multiples of
    /// `align`. With none given, one view fills it.
    fn parts(&self, align: [u32; 2]) -> Result<Vec<([u32; 2], [u32; 2])>> {
        let whole = [[0.0, 0.0, 1.0, 1.0]];
        let parts = if self.panels.is_empty() { &whole[..] } else { &self.panels[..] };
        let edge = |f: f32, length: u32, align: u32| {
            let units = (f64::from(f.clamp(0.0, 1.0)) * f64::from(length) / f64::from(align)).round() as u32;
            (units * align).min(length)
        };
        parts
            .iter()
            .map(|p| {
                let x = [edge(p[0], self.size[0], align[0]), edge(p[0] + p[2], self.size[0], align[0])];
                let y = [edge(p[1], self.size[1], align[1]), edge(p[1] + p[3], self.size[1], align[1])];
                if x[1] <= x[0] || y[1] <= y[0] {
                    return Err(Error::invalid(format!("panel {p:?} covers no pixels of the picture")).at("panels"));
                }
                Ok(([x[0], y[0]], [x[1] - x[0], y[1] - y[0]]))
            })
            .collect()
    }
}

/// A shot as JSON: `{ "size": [w, h], "scale", "panels": [[x, y, w, h]], "transparent", "deadline",
/// "elapsed" }`, times in seconds. Only `size` is required.
impl<'de> serde::Deserialize<'de> for Shot {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Shot, D::Error> {
        use serde::de::Error as _;
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Form {
            size: [u32; 2],
            scale: Option<f32>,
            #[serde(default)]
            panels: Vec<[f32; 4]>,
            #[serde(default)]
            transparent: bool,
            deadline: Option<f64>,
            elapsed: Option<f64>,
        }
        let form = Form::deserialize(deserializer)?;
        let seconds = |value: f64, name: &str| {
            Duration::try_from_secs_f64(value)
                .map_err(|_| D::Error::custom(format!("{name} is nonnegative seconds within range")))
        };
        let mut shot = Shot::new(form.size);
        if let Some(scale) = form.scale {
            shot = shot.scale(scale);
        }
        for part in form.panels {
            shot = shot.panel(part);
        }
        if form.transparent {
            shot = shot.transparent();
        }
        if let Some(deadline) = form.deadline {
            shot = shot.deadline(seconds(deadline, "deadline")?);
        }
        if let Some(elapsed) = form.elapsed {
            shot = shot.elapsed(seconds(elapsed, "elapsed")?);
        }
        Ok(shot)
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

/// One view's part of a picture: the texture it draws into, its size, and the bind group
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
    /// Pictures of `shot` composed into `pixels`, drawn from the views the first picture is given.
    pub(crate) fn later(shot: Shot, pixels: Pixels) -> Drawing {
        let notify = Arc::new(Notify::default());
        let waker = Waker::from(notify.clone());
        Drawing { shot, pixels, picture: None, notify, waker, lent: Vec::new(), started: None }
    }

    /// Begins a picture of `views`, one per panel. The first takes the views: their wakers wake the
    /// drawing until it is done, and nothing else draws them.
    pub(crate) fn begin(&mut self, views: &[&mut View]) -> Result<()> {
        self.started = Some(Instant::now());
        let expected = self.shot.panels.len().max(1);
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
        let align = match pixels {
            Pixels::Rgba => [1, 1],
            Pixels::Nv12 => [4, 2],
        };
        let parts = shot.parts(align)?;
        if !(shot.scale.is_finite() && shot.scale > 0.0) {
            return Err(Error::invalid("a shot's scale is positive").at("scale"));
        }
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
        let panels: Vec<Panel> = parts
            .iter()
            .map(|&(origin, size)| {
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
        let covered: u64 = parts.iter().map(|(_, s)| u64::from(s[0]) * u64::from(s[1])).sum();
        let overlap = parts.iter().enumerate().any(|(i, a)| parts[i + 1..].iter().any(|b| overlaps(*a, *b)));
        let fill = (covered < area || overlap).then(|| group(&panels[0].target, &uniform([0, 0], shot.size)));
        Ok(Picture { gpu: gpu.clone(), panels, buffer, len, fill })
    }
}

impl Drawing {
    /// Draws every view into its panel at `time` once. When every one is complete, and with `still`
    /// none eases, composes them and starts reading the picture back.
    pub(crate) fn step(&mut self, views: &mut [&mut View], time: f64, still: bool) -> Result<Step> {
        let picture = self.picture.as_ref().ok_or_else(|| Error::invalid("a picture begins before it draws"))?;
        if picture.gpu.lost() {
            return Err(Error::DeviceLost);
        }
        self.check_deadline()?;
        let device = picture.gpu.device();
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("latkit shot") });
        let scale = self.shot.scale;
        for (view, panel) in views.iter_mut().zip(&picture.panels) {
            let frame = Frame { target: &panel.target, format: FORMAT, size: panel.size, pixel_ratio: scale, time };
            view.render(&mut encoder, &frame);
        }
        let complete = views.iter().all(|v| v.complete());
        let easing = still && views.iter().any(|v| v.easing());
        if let Some(error) = views.iter_mut().find_map(|view| view.capture_error()) {
            picture.gpu.queue().submit([encoder.finish()]);
            return Err(error);
        }
        self.check_deadline()?;
        let step = if complete && !easing {
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
        if self.started.is_some_and(|started| started.elapsed() >= self.shot.deadline) {
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
            let remaining =
                self.started.map_or(self.shot.deadline, |started| self.shot.deadline.saturating_sub(started.elapsed()));
            let wait = wgpu::PollType::Wait { submission_index: None, timeout: Some(FRAME.min(remaining)) };
            let _ = picture.gpu.device().poll(wait);
        }
    }
}

impl Picture {
    /// Records the passes composing every panel into the picture's `pixels`, the background first
    /// where panels leave gaps.
    fn compose(&self, encoder: &mut wgpu::CommandEncoder, pixels: Pixels, size: [u32; 2]) {
        let device = self.gpu.device();
        let mut inner = self.gpu.0.lock();
        let (fill, each, block) = match pixels {
            Pixels::Rgba => ("fill_rgba", "rgba", [1, 1]),
            Pixels::Nv12 => ("fill_nv12", "nv12", [4, 2]),
        };
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

/// Whether two parts of a picture share a pixel.
fn overlaps(a: ([u32; 2], [u32; 2]), b: ([u32; 2], [u32; 2])) -> bool {
    (0..2).all(|i| a.0[i] < b.0[i] + b.1[i] && b.0[i] < a.0[i] + a.1[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panels_split_the_picture_on_whole_blocks() {
        let shot = Shot::new([1920, 1080]).panel([0.0, 0.0, 1.0, 0.7]).panel([0.0, 0.7, 1.0, 0.3]);
        let parts = shot.parts([4, 2]).expect("valid");
        assert_eq!(parts, vec![([0, 0], [1920, 756]), ([0, 756], [1920, 324])]);
        assert!(!overlaps(parts[0], parts[1]));
        assert_eq!(Shot::new([10, 10]).parts([1, 1]).expect("valid"), vec![([0, 0], [10, 10])]);
        assert!(Shot::new([10, 10]).panel([0.5, 0.5, 0.0, 0.5]).parts([1, 1]).is_err());
    }
}
