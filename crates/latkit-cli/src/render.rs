//! Rendering and validating a job. Rendering creates a view of each scene over the datasets, then
//! takes a still picture, or draws a video into a sink. Validating reads, loads, and checks every
//! input a render does, including frames, without a GPU. Both read what plays with [`playback`] and
//! apply frames with [`apply`].

use std::path::{Path, PathBuf};
use std::time::Duration;

use latkit::host::Native;
use latkit::{Camera, Data, Error, Fit, Gpu, Mp4, Name, Patch, Scene, Sink, Tiles, View};

use crate::args::{Format, Job, Source};
use crate::inputs::{self, Each, Frame, Frames, Next, blame};
use crate::report::Report;
use crate::sinks::{Commit, Images, Output, Raw, Y4m};
use crate::{Failure, block};

/// A job's inputs, read before drawing, and the host that read them.
struct Inputs {
    scenes: Vec<(PathBuf, Scene)>,
    data: Vec<Data>,
    /// Tiles every view fetches as it draws.
    tiles: Vec<Tiles>,
    cameras: Vec<Camera>,
    fit: Fit,
    host: Native,
}

impl Inputs {
    fn read(job: &Job) -> Result<Inputs, Failure> {
        let fonts = job.font.iter().map(|p| inputs::read(p)).collect::<Result<Vec<_>, _>>()?;
        let host = if fonts.is_empty() { Native::new() } else { Native::from_fonts(fonts)? };
        let scenes =
            job.scenes.iter().map(|p| inputs::scene(p).map(|s| (p.clone(), s))).collect::<Result<Vec<_>, _>>()?;
        let data = job.data.iter().map(|s| inputs::dataset(s, &host, job.deadline)).collect::<Result<Vec<_>, _>>()?;
        let tiles: Vec<Tiles> = job
            .tiles
            .iter()
            .map(|Source { name, path }| {
                Tiles::new(name.as_deref().unwrap_or_default(), path.to_string_lossy().as_ref())
            })
            .collect();
        let cameras: Vec<Camera> = job.camera.iter().map(|c| inputs::json(c, "--camera")).collect::<Result<_, _>>()?;
        if let Some(i) = cameras.iter().zip(&scenes).position(|(camera, (_, scene))| !camera.fits(scene.space())) {
            return Err(Error::invalid("the camera does not match the space of its scene").at(i).at("--camera").into());
        }
        let inputs = Inputs { scenes, data, tiles, cameras, fit: inputs::fit(&job.fit)?, host };
        for (path, scene) in &inputs.scenes {
            scene.validate(&inputs.sources()).map_err(|e| Failure::at(e, path))?;
        }
        Ok(inputs)
    }

    /// The sources every view draws: each dataset, and the tiles.
    fn sources(&self) -> Vec<latkit::Source> {
        self.data.iter().map(latkit::Source::from).chain(self.tiles.iter().map(latkit::Source::from)).collect()
    }

    /// The datasets' span: from the first axis coordinate any of them holds to the last.
    fn span(&self) -> Option<[f64; 2]> {
        self.data.iter().filter_map(|d| d.snapshot().describe().span).reduce(|a, b| [a[0].min(b[0]), a[1].max(b[1])])
    }

    /// Creates a view of each scene over every dataset and the tiles, with the job's insets, axis
    /// coordinate, and camera or fit.
    fn views(&self, gpu: &Gpu, job: &Job) -> Result<Vec<View>, Failure> {
        let mut views = Vec::with_capacity(self.scenes.len());
        for (i, (path, scene)) in self.scenes.iter().enumerate() {
            let mut view = View::new(gpu, scene.clone()).map_err(|e| Failure::at(e, path))?;
            view.set_sources(self.sources()).map_err(|e| Failure::at(e, path))?;
            if let Some(insets) = job.insets {
                view.set_insets(insets);
            }
            if let Some(at) = job.at {
                view.set_at(at);
            }
            match self.cameras.get(i) {
                Some(camera) => view.set_camera(*camera),
                None => view.fit(self.fit.clone()),
            }
            views.push(view);
        }
        Ok(views)
    }
}

pub(crate) fn render(job: &Job, report: &mut Report) -> Result<(), Failure> {
    let inputs = Inputs::read(job)?;
    let gpu = block(job.deadline, Gpu::new())?;
    gpu.set_host(inputs.host.clone());
    let mut views = inputs.views(&gpu, job)?;
    let output = job.output.as_deref().expect("render requires --output");
    let Some(playback) = playback(job, &inputs)? else {
        let mut shot = job.shot();
        if let Some(elapsed) = job.elapsed {
            shot = shot.elapsed(elapsed);
        }
        let image = block(job.deadline, shot.image(&mut views.iter_mut().collect::<Vec<_>>()))?;
        let mut out = Output::create(output)?;
        match job.format().image(job.quality) {
            Some(format) => image.write(format, &mut out)?,
            None => out.put(&image.rgba)?,
        }
        out.commit()?;
        report.done(1, &views, &gpu);
        return Ok(());
    };
    let host = inputs.host.clone();
    let sequence = Sequence { job, playback, gpu: &gpu, views: &mut views, inputs: &inputs, report };
    let format = job.format();
    if let Some(image) = format.image(job.quality) {
        let images = if job.sequence() {
            Images::numbered(output.to_path_buf(), image, host)
        } else {
            Images::one(Output::create(output)?, image, host)
        };
        return sequence.run(images);
    }
    match format {
        Format::Png | Format::Jpeg | Format::Webp => unreachable!("image formats are handled above"),
        Format::Rgba => sequence.run(Raw::new(Output::create(output)?)),
        Format::Y4m => sequence.run(Y4m::new(Output::create(output)?)),
        Format::Mp4 => {
            let mut mp4 = Mp4::new(Output::create(output)?);
            if let Some(bitrate) = job.bitrate {
                mp4 = mp4.bitrate(bitrate);
            }
            sequence.run(mp4)
        }
    }
}

/// What a render plays: the frames file's lines, in order, and with a span, how its output frames
/// step through the axis.
struct Playback {
    lines: Box<dyn Iterator<Item = Result<Next, Failure>>>,
    span: Option<Span>,
    /// What errors in the lines name: the frames file, or `--span` without one.
    file: PathBuf,
}

/// An axis interval played at `rate` units per second, and the flights between its lines.
struct Span {
    from: f64,
    to: f64,
    rate: f64,
    flights: Flights,
}

/// What `job` plays, or `None` for a still.
fn playback(job: &Job, inputs: &Inputs) -> Result<Option<Playback>, Failure> {
    let file = job.frames.clone().unwrap_or_else(|| PathBuf::from("--span"));
    let frames = job.frames.as_deref().map(|path| Frames::open(path, inputs.host.clone(), job.deadline)).transpose()?;
    if !job.plays() {
        let Some(frames) = frames else { return Ok(None) };
        let mut lines = frames.ahead().peekable();
        if lines.peek().is_none() {
            return Err(Failure::at(Error::invalid("the frames file has no frames"), &file));
        }
        return Ok(Some(Playback { lines: Box::new(lines), span: None, file }));
    }
    let lines = frames.map(Frames::ordered).transpose()?.unwrap_or_default();
    let [from, to] = job.span.or_else(|| inputs.span()).ok_or_else(|| {
        Failure::from(Error::invalid("nothing to play: the datasets record no axis span, so give --span or --frames"))
    })?;
    let rate = job.rate.unwrap_or(1.0);
    let flights = Flights::plan(&lines, inputs.scenes.len(), rate);
    let span = Span { from, to, rate, flights };
    Ok(Some(Playback { lines: Box::new(lines.into_iter().map(Ok)), span: Some(span), file }))
}

/// For each line of a span, the camera each view it sets flies on to, and the axis coordinate of
/// the next line that sets that view's camera. A line that also flies or fits the view starts none.
#[derive(Default)]
struct Flights {
    onward: Vec<Vec<Option<(f64, Camera)>>>,
    rate: f64,
}

impl Flights {
    fn plan(lines: &[Next], views: usize, rate: f64) -> Flights {
        // From the end back: the next camera each view is set to.
        let mut later: Vec<Option<(f64, Camera)>> = vec![None; views];
        let mut onward = vec![Vec::new(); lines.len()];
        for (j, (_, frame, _)) in lines.iter().enumerate().rev() {
            let set = |i: usize| frame.camera.as_ref().and_then(|c| c.of(i));
            let steered = |i: usize| {
                frame.fly.as_ref().and_then(|c| c.of(i)).is_some() || frame.fit.as_ref().and_then(|f| f.of(i)).is_some()
            };
            onward[j] = (0..views).map(|i| later[i].filter(|_| set(i).is_some() && !steered(i))).collect();
            for (i, later) in later.iter_mut().enumerate() {
                if let (Some(camera), Some(at)) = (set(i), frame.at) {
                    *later = Some((at, camera));
                }
            }
        }
        Flights { onward, rate }
    }

    /// Flies each view that line `j` set on to its next camera, from axis coordinate `at`.
    fn start(&self, views: &mut [View], j: usize, at: f64) {
        let Some(onward) = self.onward.get(j) else { return };
        for (view, onward) in views.iter_mut().zip(onward) {
            if let Some((arrive, camera)) = *onward {
                view.fly(camera, Some(Duration::from_secs_f64(((arrive - at) / self.rate).max(0.0))));
            }
        }
    }
}

/// One output frame: the lines it applies, in order, and in a span, the axis coordinate it shows.
struct Shown {
    lines: Vec<Next>,
    at: Option<f64>,
}

/// The output frames of `lines`: one per line, or with `span`, one per step through it, each
/// applying the lines it reached.
fn shown<'a>(
    lines: Box<dyn Iterator<Item = Result<Next, Failure>>>,
    span: Option<&'a Span>,
    fps: f64,
) -> Box<dyn Iterator<Item = Result<Shown, Failure>> + 'a> {
    let Some(span) = span else {
        return Box::new(lines.map(|line| line.map(|line| Shown { lines: vec![line], at: None })));
    };
    // A little slack keeps the last frame when the span divides evenly into frames.
    let count = ((span.to - span.from) * fps / span.rate + 1e-9).floor() as usize + 1;
    let mut lines = lines.peekable();
    Box::new((0..count).map(move |n| {
        let at = span.from + n as f64 * span.rate / fps;
        let mut due = Vec::new();
        while let Some(line) =
            lines.next_if(|line| line.as_ref().is_ok_and(|(_, f, _)| f.at.is_some_and(|key| key <= at)))
        {
            due.push(line?);
        }
        Ok(Shown { lines: due, at: Some(at) })
    }))
}

/// A video of what plays, drawn into a sink.
struct Sequence<'a> {
    job: &'a Job,
    playback: Playback,
    gpu: &'a Gpu,
    views: &'a mut Vec<View>,
    inputs: &'a Inputs,
    report: &'a mut Report,
}

impl Sequence<'_> {
    fn run<S: Sink + Commit>(self, sink: S) -> Result<(), Failure> {
        let Sequence { job, playback: Playback { lines, span, file }, gpu, views, inputs, report } = self;
        // An output frame's own errors name the frames file, or `--span` in a span.
        let source = if span.is_some() { Path::new("--span") } else { file.as_path() };
        let mut video = job.shot().video(gpu, job.fps, sink)?;
        for next in shown(lines, span.as_ref(), job.fps) {
            let Shown { lines, at } = next?;
            for (index, mut frame, patches) in lines {
                apply(&inputs.data, &inputs.scenes, &frame, patches).map_err(|e| blame(&file, index, e))?;
                // A span shows its own axis coordinate, and flies on from each line that sets a camera.
                if at.is_some() {
                    frame.at = None;
                }
                steer(views, &frame);
                if let (Some(at), Some(span)) = (at, &span) {
                    span.flights.start(views, index, at);
                }
            }
            if let Some(at) = at {
                steer(views, &Frame::showing(at));
            }
            // Only invalid input is the frame's fault. An output that fails names itself.
            let index = usize::try_from(video.frames()).unwrap_or(usize::MAX);
            let drawn = block(job.deadline, video.frame(&mut views.iter_mut().collect::<Vec<_>>()));
            drawn.map_err(|e| if let Error::Invalid { .. } = e { blame(source, index, e) } else { e.into() })?;
            report.progress(video.frames(), video.time());
        }
        let frames = video.frames();
        block(job.deadline, video.finish())?.commit()?;
        report.done(frames, views, gpu);
        Ok(())
    }
}

/// Applies `frame`'s patches, in order, to the datasets they name. Every view draws the changes
/// from its next frame. Also checks each per-view camera against its view's scene. Returns whether
/// any dataset changed.
fn apply(
    data: &[Data],
    scenes: &[(PathBuf, Scene)],
    frame: &Frame,
    patches: Vec<(Name, Patch)>,
) -> latkit::Result<bool> {
    // A single camera applies to the views it fits. A per-view camera must fit its own view.
    for (option, each) in [("camera", &frame.camera), ("fly", &frame.fly)] {
        let Some(Each::Each(cameras)) = each else { continue };
        for (i, camera) in cameras.iter().enumerate() {
            let fits = match (camera, scenes.get(i)) {
                (None, _) => true,
                (Some(camera), Some((_, scene))) => camera.fits(scene.space()),
                (Some(_), None) => false,
            };
            if !fits {
                return Err(Error::invalid("the camera does not match the space of its view").at(i).at(option));
            }
        }
    }
    let changed = !patches.is_empty();
    for (name, patch) in patches {
        let dataset = data
            .iter()
            .find(|d| *d.name() == name)
            .ok_or_else(|| Error::invalid(format!("no dataset is named {name}")).at(name.as_str()).at("patch"))?;
        dataset.apply(patch).map_err(|e| e.at(name.as_str()).at("patch"))?;
    }
    Ok(changed)
}

/// Applies `frame`'s axis coordinate, insets, orbit, cameras, and fits to every view.
fn steer(views: &mut [View], frame: &Frame) {
    for (i, view) in views.iter_mut().enumerate() {
        if let Some(at) = frame.at {
            view.set_at(at);
        }
        if let Some(insets) = frame.insets {
            view.set_insets(insets);
        }
        if let Some(orbit) = frame.orbit {
            view.set_orbit(orbit);
        }
        if let Some(camera) = frame.camera.as_ref().and_then(|c| c.of(i)) {
            view.set_camera(camera);
        }
        if let Some(camera) = frame.fly.as_ref().and_then(|c| c.of(i)) {
            view.fly(camera, None);
        }
        if let Some(fit) = frame.fit.as_ref().and_then(|f| f.of(i)) {
            view.fit(fit);
        }
    }
}

/// Reads, loads, and checks every input `render` would, without a GPU: scenes against the
/// datasets, cameras, fonts, and every frame applied in turn.
pub(crate) fn validate(job: &Job) -> Result<(), Failure> {
    let inputs = Inputs::read(job)?;
    let Some(Playback { lines, file, .. }) = playback(job, &inputs)? else { return Ok(()) };
    for next in lines {
        let (index, frame, patches) = next?;
        let at = |error: Error| blame(&file, index, error);
        if apply(&inputs.data, &inputs.scenes, &frame, patches).map_err(at)? {
            for (_, scene) in &inputs.scenes {
                scene.validate(&inputs.sources()).map_err(at)?;
            }
        }
    }
    Ok(())
}
