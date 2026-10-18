//! Rendering a job, and validating one: views of the scenes with the datasets, then a still picture,
//! or a video of the frames handed to a sink. Validating reads, loads, and checks everything a render
//! does, frames included, without a GPU; both change frames with [`apply`].

use std::path::{Path, PathBuf};

use latkit::geo::Tiles;
use latkit::host::Native;
use latkit::{Camera, Data, Error, Fit, Gpu, Mp4, Patch, Scene, Shot, Sink, View};

use crate::args::{Format, Job, Source};
use crate::inputs::{self, Ahead, Each, Frame, Frames};
use crate::report::Report;
use crate::sinks::{Commit, Output, Png, Pngs, Raw, Y4m};
use crate::{Failure, block};

/// What a job reads before it draws, and the host that read it.
struct Inputs {
    scenes: Vec<(PathBuf, Scene)>,
    data: Vec<Data>,
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
        for (path, scene) in &scenes {
            scene.validate(&data).map_err(|e| Failure::at(e, path))?;
        }
        let cameras = job.camera.iter().map(|p| inputs::camera(p)).collect::<Result<Vec<_>, _>>()?;
        for (i, camera) in cameras.iter().enumerate() {
            if !camera.fits(scenes[i].1.space()) {
                return Err(Failure::at(
                    Error::invalid("the camera does not look at its scene's space"),
                    &job.camera[i],
                ));
            }
        }
        Ok(Inputs { scenes, data, cameras, fit: inputs::fit(&job.fit)?, host })
    }

    /// A view of each scene, given every dataset and the tiles, looking where the job says.
    fn views(&self, gpu: &Gpu, job: &Job) -> Result<Vec<View>, Failure> {
        let mut views = Vec::with_capacity(self.scenes.len());
        for (i, (path, scene)) in self.scenes.iter().enumerate() {
            let mut view = View::new(gpu, scene.clone()).map_err(|e| Failure::at(e, path))?;
            for data in &self.data {
                view.set_data(data.clone());
            }
            for Source { name, path } in &job.tiles {
                view.set_tiles(Tiles::vector(name.as_deref().unwrap_or_default(), path.to_string_lossy().as_ref()));
            }
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

/// The picture the job takes: its size, scale, panels, alpha, and deadline.
fn shot(job: &Job) -> Shot {
    let mut shot = Shot::new(job.size).scale(job.scale).deadline(job.deadline);
    for &part in &job.panel {
        shot = shot.panel(part);
    }
    if job.transparent {
        shot = shot.transparent();
    }
    shot
}

pub(crate) fn render(job: &Job, report: &mut Report) -> Result<(), Failure> {
    let mut inputs = Inputs::read(job)?;
    let gpu = block(job.deadline, Gpu::new())?;
    gpu.set_host(inputs.host.clone());
    let mut views = inputs.views(&gpu, job)?;
    let output = job.output.as_deref().expect("render takes an output");
    let Some(path) = &job.frames else {
        let mut shot = shot(job);
        if let Some(elapsed) = job.elapsed {
            shot = shot.elapsed(elapsed);
        }
        let image = block(job.deadline, shot.image(&mut views.iter_mut().collect::<Vec<_>>()))?;
        let mut out = Output::create(output)?;
        match job.format() {
            Format::Rgba => std::io::Write::write_all(&mut out, &image.rgba).map_err(|e| Failure::io(&e, output))?,
            _ => image.write_png(&mut out).map_err(|e| Failure::at(e, output))?,
        }
        out.commit()?;
        report.done(1, &views, &gpu);
        return Ok(());
    };
    let frames = Frames::open(path, inputs.host.clone(), job.deadline)?.ahead();
    let host = inputs.host.clone();
    let mut sequence = Sequence { job, path, gpu: &gpu, views: &mut views, inputs: &mut inputs, report };
    match job.format() {
        Format::Png if job.sequence() => sequence.run(frames, Pngs::new(output.to_path_buf(), host)),
        Format::Png => sequence.run(frames, Png::new(Output::create(output)?)),
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

/// A video of the frames file at `path`, drawn as each line says.
struct Sequence<'a> {
    job: &'a Job,
    path: &'a Path,
    gpu: &'a Gpu,
    views: &'a mut Vec<View>,
    inputs: &'a mut Inputs,
    report: &'a mut Report,
}

impl Sequence<'_> {
    fn run<S: Sink + Commit>(&mut self, frames: Ahead, sink: S) -> Result<(), Failure> {
        let (job, path) = (self.job, self.path);
        let output = job.output.as_deref().unwrap_or(path);
        let mut video = shot(job).video(self.gpu, job.fps, sink).map_err(|e| Failure::at(e, output))?;
        let mut any = false;
        for next in frames {
            let (index, frame, patches) = next?;
            any = true;
            let at = |error: Error| Failure::at(error.at(index).at("frames"), path);
            let changed = apply(&mut self.inputs.data, &self.inputs.scenes, &frame, patches).map_err(at)?;
            for i in changed {
                for view in self.views.iter_mut() {
                    view.set_data(self.inputs.data[i].clone());
                }
            }
            steer(self.views, &frame);
            block(job.deadline, video.frame(&mut self.views.iter_mut().collect::<Vec<_>>())).map_err(at)?;
            self.report.progress(video.frames(), video.time());
        }
        if !any {
            return Err(Failure::at(Error::invalid("the frames are empty"), path));
        }
        let frames = video.frames();
        block(job.deadline, video.finish()).map_err(|e| Failure::at(e, output))?.commit()?;
        self.report.done(frames, self.views, self.gpu);
        Ok(())
    }
}

/// Applies `frame`'s patches to the datasets they name, in order, and checks the cameras it gives
/// each view against that view's scene: the datasets it changed, by index.
fn apply(
    data: &mut [Data],
    scenes: &[(PathBuf, Scene)],
    frame: &Frame,
    patches: Vec<(String, Patch)>,
) -> latkit::Result<Vec<usize>> {
    // One camera for every view looks through those it fits; one per view must fit its own.
    for (option, each) in [("camera", &frame.camera), ("fly", &frame.fly)] {
        let Some(Each::Each(cameras)) = each else { continue };
        for (i, camera) in cameras.iter().enumerate() {
            let fits = match (camera, scenes.get(i)) {
                (None, _) => true,
                (Some(camera), Some((_, scene))) => camera.fits(scene.space()),
                (Some(_), None) => false,
            };
            if !fits {
                return Err(Error::invalid("the camera does not look at its view's space").at(i).at(option));
            }
        }
    }
    let mut changed = Vec::new();
    for (name, patch) in patches {
        let i = data
            .iter()
            .position(|d| d.name().as_str() == name)
            .ok_or_else(|| Error::invalid(format!("no dataset is named {name}")).at(name.as_str()).at("patch"))?;
        data[i].apply(patch).map_err(|e| e.at(name.as_str()).at("patch"))?;
        if !changed.contains(&i) {
            changed.push(i);
        }
    }
    Ok(changed)
}

/// Points every view where `frame` says.
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

/// Reads, loads, and checks everything `render` would, without a GPU: scenes against the datasets,
/// cameras, fonts, and every frame applied in turn.
pub(crate) fn validate(job: &Job) -> Result<(), Failure> {
    let mut inputs = Inputs::read(job)?;
    let Some(path) = &job.frames else { return Ok(()) };
    let mut frames = Frames::open(path, inputs.host.clone(), job.deadline)?;
    let mut any = false;
    while let Some((index, frame, patches)) = frames.next()? {
        any = true;
        let at = |error: Error| Failure::at(error.at(index).at("frames"), path);
        if !apply(&mut inputs.data, &inputs.scenes, &frame, patches).map_err(at)?.is_empty() {
            for (_, scene) in &inputs.scenes {
                scene.validate(&inputs.data).map_err(at)?;
            }
        }
    }
    if any { Ok(()) } else { Err(Failure::at(Error::invalid("the frames are empty"), path)) }
}
