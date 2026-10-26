//! Rendering and validating a job. Rendering creates a view of each scene over the datasets, then
//! takes a still picture, or draws a video of the frames into a sink. Validating reads, loads, and
//! checks every input a render does, including frames, without a GPU. Both apply frames with
//! [`apply`].

use std::path::{Path, PathBuf};

use latkit::host::Native;
use latkit::{Camera, Data, Error, Fit, Gpu, Mp4, Name, Patch, Scene, Sink, Tiles, View};

use crate::args::{Format, Job, Source};
use crate::inputs::{self, Ahead, Each, Frame, Frames};
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
        let cameras = job.camera.iter().map(|p| inputs::camera(p)).collect::<Result<Vec<_>, _>>()?;
        for (i, camera) in cameras.iter().enumerate() {
            if !camera.fits(scenes[i].1.space()) {
                return Err(Failure::at(
                    Error::invalid("the camera does not match the space of its scene"),
                    &job.camera[i],
                ));
            }
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
    let Some(path) = &job.frames else {
        let mut shot = job.shot();
        if let Some(elapsed) = job.elapsed {
            shot = shot.elapsed(elapsed);
        }
        let image = block(job.deadline, shot.image(&mut views.iter_mut().collect::<Vec<_>>()))?;
        let mut out = Output::create(output)?;
        match job.format().image(job.quality) {
            Some(format) => image.write(format, &mut out).map_err(|e| Failure::at(e, output))?,
            None => std::io::Write::write_all(&mut out, &image.rgba).map_err(|e| Failure::io(&e, output))?,
        }
        out.commit()?;
        report.done(1, &views, &gpu);
        return Ok(());
    };
    let frames = Frames::open(path, inputs.host.clone(), job.deadline)?.ahead();
    let host = inputs.host.clone();
    let mut sequence = Sequence { job, path, gpu: &gpu, views: &mut views, inputs: &inputs, report };
    let format = job.format();
    if let Some(image) = format.image(job.quality) {
        let images = if job.sequence() {
            Images::numbered(output.to_path_buf(), image, host)
        } else {
            Images::one(Output::create(output)?, image, host)
        };
        return sequence.run(frames, images);
    }
    match format {
        Format::Png | Format::Jpeg | Format::Webp => unreachable!("image formats are handled above"),
        Format::Rgba => sequence.run(frames, Raw::new(Output::create(output)?)),
        Format::Y4m => sequence.run(frames, Y4m::new(Output::create(output)?)),
        Format::Mp4 => {
            let mut mp4 = Mp4::new(Output::create(output)?);
            if let Some(bitrate) = job.bitrate {
                mp4 = mp4.bitrate(bitrate);
            }
            sequence.run(frames, mp4)
        }
    }
}

/// A video of the frames file at `path`, one output frame per line.
struct Sequence<'a> {
    job: &'a Job,
    path: &'a Path,
    gpu: &'a Gpu,
    views: &'a mut Vec<View>,
    inputs: &'a Inputs,
    report: &'a mut Report,
}

impl Sequence<'_> {
    fn run<S: Sink + Commit>(&mut self, frames: Ahead, sink: S) -> Result<(), Failure> {
        let (job, path) = (self.job, self.path);
        let output = job.output.as_deref().unwrap_or(path);
        let mut video = job.shot().video(self.gpu, job.fps, sink).map_err(|e| Failure::at(e, output))?;
        let mut any = false;
        for next in frames {
            let (index, frame, patches) = next?;
            any = true;
            let at = |error: Error| Failure::at(error.at(index).at("frames"), path);
            apply(&self.inputs.data, &self.inputs.scenes, &frame, patches).map_err(at)?;
            steer(self.views, &frame);
            block(job.deadline, video.frame(&mut self.views.iter_mut().collect::<Vec<_>>())).map_err(at)?;
            self.report.progress(video.frames(), video.time());
        }
        if !any {
            return Err(Failure::at(Error::invalid("the frames file has no frames"), path));
        }
        let frames = video.frames();
        block(job.deadline, video.finish()).map_err(|e| Failure::at(e, output))?.commit()?;
        self.report.done(frames, self.views, self.gpu);
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
            view.fly(camera);
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
    let Some(path) = &job.frames else { return Ok(()) };
    let mut frames = Frames::open(path, inputs.host.clone(), job.deadline)?;
    let mut any = false;
    while let Some((index, frame, patches)) = frames.next()? {
        any = true;
        let at = |error: Error| Failure::at(error.at(index).at("frames"), path);
        if apply(&inputs.data, &inputs.scenes, &frame, patches).map_err(at)? {
            for (_, scene) in &inputs.scenes {
                scene.validate(&inputs.sources()).map_err(at)?;
            }
        }
    }
    if any { Ok(()) } else { Err(Failure::at(Error::invalid("the frames file has no frames"), path)) }
}
