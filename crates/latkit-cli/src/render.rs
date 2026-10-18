//! Rendering a job, and validating one: views of the scenes with the datasets, then a still picture,
//! or a video of the frames handed to a sink. Validating reads and checks everything a render does,
//! frames included, without a GPU.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use latkit::geo::Tiles;
use latkit::host::Native;
use latkit::{Camera, Data, Error, Fit, Gpu, Mp4, Patch, Scene, Shot, Sink, View};

use crate::args::{Format, Job, Source};
use crate::inputs::{self, Frame, Frames};
use crate::report::Report;
use crate::sinks::{Commit, Output, Overlaid, Overlays, Png, Pngs, Raw, Y4m};
use crate::{Failure, block};

/// What a job reads before it draws.
struct Inputs {
    scenes: Vec<(PathBuf, Scene)>,
    data: Vec<Data>,
    cameras: Vec<Camera>,
    fit: Fit,
    fonts: Vec<Vec<u8>>,
}

impl Inputs {
    fn read(job: &Job) -> Result<Inputs, Failure> {
        let scenes =
            job.scenes.iter().map(|p| inputs::scene(p).map(|s| (p.clone(), s))).collect::<Result<Vec<_>, _>>()?;
        let data = job.data.iter().map(inputs::dataset).collect::<Result<Vec<_>, _>>()?;
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
        let fonts = job.font.iter().map(|p| inputs::read(p)).collect::<Result<Vec<_>, _>>()?;
        Ok(Inputs { scenes, data, cameras, fit: inputs::fit(&job.fit)?, fonts })
    }

    /// The platform's services: the fonts given, or the system's.
    fn host(&self) -> Result<Native, Failure> {
        if self.fonts.is_empty() { Ok(Native::new()) } else { Ok(Native::from_fonts(self.fonts.clone())?) }
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
    let inputs = Inputs::read(job)?;
    let host = inputs.host()?;
    let gpu = block(job.deadline, Gpu::new())?;
    gpu.set_host(host);
    let mut views = inputs.views(&gpu, job)?;
    let output = job.output.as_deref().expect("render takes an output");
    let Some(frames) = &job.frames else {
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
    let overlays = Rc::new(RefCell::new(Overlays::new(job.size)));
    let mut video = Sequence { job, gpu: &gpu, views: &mut views, data: inputs.data, overlays, report };
    match job.format() {
        Format::Png if job.sequence() => video.run(frames, Pngs::new(output.to_path_buf())),
        Format::Png => video.run(frames, Png::new(Output::create(output)?)),
        Format::Rgba => video.run(frames, Raw::new(Output::create(output)?)),
        Format::Y4m => video.run(frames, Y4m::new(Output::create(output)?)),
        Format::Mp4 => {
            let mut mp4 = Mp4::new(Output::create(output)?);
            if let Some(bitrate) = job.bitrate {
                mp4 = mp4.bitrate(bitrate);
            }
            video.run(frames, mp4)
        }
    }
}

/// A video of the job's frames, drawn as each line of the frames file says.
struct Sequence<'a> {
    job: &'a Job,
    gpu: &'a Gpu,
    views: &'a mut Vec<View>,
    data: Vec<Data>,
    overlays: Rc<RefCell<Overlays>>,
    report: &'a mut Report,
}

impl Sequence<'_> {
    fn run<S: Sink + Commit>(&mut self, path: &Path, sink: S) -> Result<(), Failure> {
        let job = self.job;
        let sink = Overlaid::new(sink, self.overlays.clone());
        let mut video = shot(job)
            .video(self.gpu, job.fps, sink)
            .map_err(|e| Failure::at(e, job.output.as_deref().unwrap_or(path)))?;
        let mut frames = Frames::open(path)?;
        let mut any = false;
        while let Some((index, frame, patches)) = frames.next()? {
            any = true;
            let at = |error: Error| Failure::at(error.at(index).at("frames"), path);
            change(&mut self.data, self.views, &frame, patches).map_err(at)?;
            if let Some(overlay) = &frame.overlay {
                self.overlays.borrow_mut().ask(index as u64, frames.root().join(overlay));
            }
            block(job.deadline, video.frame(&mut self.views.iter_mut().collect::<Vec<_>>())).map_err(at)?;
            self.report.progress(video.frames(), video.time());
        }
        if !any {
            return Err(Failure::at(Error::invalid("the frames are empty"), path));
        }
        let frames = video.frames();
        let sink =
            block(job.deadline, video.finish()).map_err(|e| Failure::at(e, job.output.as_deref().unwrap_or(path)))?;
        sink.into_inner().commit()?;
        self.report.done(frames, self.views, self.gpu);
        Ok(())
    }
}

/// Applies `frame`'s changes: patches to the datasets they name, given to every view, then where
/// each view looks.
fn change(data: &mut [Data], views: &mut [View], frame: &Frame, patches: Vec<(String, Patch)>) -> latkit::Result<()> {
    for (name, patch) in patches {
        let dataset = data
            .iter_mut()
            .find(|d| d.name().as_str() == name)
            .ok_or_else(|| Error::invalid(format!("no dataset is named {name}")).at(name.as_str()).at("patch"))?;
        dataset.apply(patch).map_err(|e| e.at(name.as_str()).at("patch"))?;
        for view in views.iter_mut() {
            view.set_data(dataset.clone());
        }
    }
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
    Ok(())
}

/// Reads and checks everything `render` would: scenes against the datasets, cameras, fonts, the
/// frames with their patches applied, and their overlays' sizes.
pub(crate) fn validate(job: &Job) -> Result<(), Failure> {
    let mut inputs = Inputs::read(job)?;
    inputs.host()?;
    let Some(path) = &job.frames else { return Ok(()) };
    let mut frames = Frames::open(path)?;
    let mut any = false;
    while let Some((index, frame, patches)) = frames.next()? {
        any = true;
        let at = |error: Error| Failure::at(error.at(index).at("frames"), path);
        let changed = !patches.is_empty();
        for (name, patch) in patches {
            let dataset = inputs.data.iter_mut().find(|d| d.name().as_str() == name);
            let dataset = dataset.ok_or_else(|| {
                at(Error::invalid(format!("no dataset is named {name}")).at(name.as_str()).at("patch"))
            })?;
            dataset.apply(patch).map_err(|e| at(e.at(name.as_str()).at("patch")))?;
        }
        if changed {
            for (_, scene) in &inputs.scenes {
                scene.validate(&inputs.data).map_err(at)?;
            }
        }
        // One camera for every view looks through those it fits; one per view must fit its own.
        for (option, each) in [("camera", &frame.camera), ("fly", &frame.fly)] {
            let Some(inputs::Each::Each(cameras)) = each else { continue };
            for (i, camera) in cameras.iter().enumerate() {
                let scene = inputs.scenes.get(i).map(|(_, scene)| scene);
                if let (Some(camera), Some(scene)) = (camera, scene)
                    && !camera.fits(scene.space())
                {
                    return Err(at(Error::invalid("the camera does not look at its view's space").at(i).at(option)));
                }
            }
        }
        if let Some(overlay) = &frame.overlay {
            let file = frames.root().join(overlay);
            let size = png_size(&file).map_err(|e| at(e.at("overlay")))?;
            if size != job.size {
                return Err(at(Error::invalid(format!(
                    "an overlay is the picture's size, not {}×{}",
                    size[0], size[1]
                ))
                .at("overlay")));
            }
        }
    }
    if any { Ok(()) } else { Err(Failure::at(Error::invalid("the frames are empty"), path)) }
}

/// A PNG's width and height, from its header.
fn png_size(path: &Path) -> latkit::Result<[u32; 2]> {
    let mut header = [0; 24];
    let read = std::fs::File::open(path).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut header));
    read.map_err(|e| Error::Load(format!("{}: {e}", path.display()).into()))?;
    if &header[..8] != b"\x89PNG\r\n\x1a\n" || &header[12..16] != b"IHDR" {
        return Err(Error::invalid(format!("{}: not a PNG", path.display())));
    }
    let side = |at: usize| u32::from_be_bytes(header[at..at + 4].try_into().expect("four bytes"));
    Ok([side(16), side(20)])
}
