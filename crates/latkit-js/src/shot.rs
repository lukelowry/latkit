//! Pictures and videos of views. A shot crosses as JSON, `{ size, scale, transparent, capture,
//! elapsed }` with times in seconds, and its layout as a canvas's does: views, and four fractions
//! per view. Canvases showing those views keep their last frames meanwhile. The page decides how
//! long to wait. An image's pixels cross once, and its files are encoded in workers. A video returns
//! the bytes each frame produced, for the page to write.

use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;

use latkit::host::Host as _;
use latkit::web::PageView;
use wasm_bindgen::prelude::*;

use crate::Error;
use crate::canvas::{Handle, layout};
use crate::pending::{Task, task};

/// RGBA pixels, straight alpha, rows top to bottom.
#[wasm_bindgen]
pub struct Image(latkit::Image);

#[wasm_bindgen]
impl Image {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.0.size[0]
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.0.size[1]
    }

    /// The pixels, copied.
    #[wasm_bindgen(getter)]
    pub fn rgba(&self) -> Vec<u8> {
        self.0.rgba.to_vec()
    }

    /// Encodes the image in a worker as a `png`, `jpeg` (at `quality` 1 to 100, default 90), or
    /// `webp` file.
    pub fn encode(&self, format: &str, quality: Option<f64>) -> Result<Task, Error> {
        let quality = match quality {
            None => 90,
            Some(q) if (1.0..=100.0).contains(&q) => q.round() as u8,
            Some(_) => return Err(latkit::Error::invalid("expected 1 to 100").at("quality").into()),
        };
        let format = match format {
            "png" => latkit::ImageFormat::Png,
            "jpeg" => latkit::ImageFormat::Jpeg { quality },
            "webp" => latkit::ImageFormat::WebP,
            other => return Err(latkit::Error::invalid(format!("unknown image format {other:?}")).at("format").into()),
        };
        let job = latkit::host::Job::encode(&self.0, format);
        Ok(task(async move {
            let file = latkit::host::Browser.spawn(job).await?;
            if file.is_empty() {
                return Err(latkit::Error::invalid(format!("the image could not be encoded as {format}")));
            }
            Ok(js_sys::Uint8Array::from(&file[..]))
        }))
    }
}

/// Takes `shot`'s (JSON) picture of `views`, each at its four fractions of `at`, once they are
/// complete as its capture says.
#[wasm_bindgen]
pub fn image(shot: &str, views: Vec<Handle>, at: &[f32]) -> Result<Task, Error> {
    let (shot, views) = shot_of(shot, views, at)?;
    Ok(task(async move { Ok(Image(latkit::web::image(&shot, &views).await?)) }))
}

/// The shot `json` describes, with its panels from `views` and `at`, and no deadline, since the
/// page decides how long to wait; and its views.
fn shot_of(json: &str, views: Vec<Handle>, at: &[f32]) -> Result<(latkit::Shot, Vec<PageView>), Error> {
    let panels = layout(views, at)?;
    let shot = crate::json::<latkit::Shot>("shot", json)?.deadline(None);
    let shot = shot.panels(panels.iter().map(|panel| panel.at).collect::<Vec<_>>());
    Ok((shot, panels.into_iter().map(|panel| panel.view).collect()))
}

/// Bytes a video wrote and the page has not yet taken.
#[derive(Clone, Default)]
struct Written(Rc<RefCell<Vec<u8>>>);

impl Write for Written {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.borrow_mut().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A video of a shot's pictures of its views, encoded with WebCodecs as frames are drawn. One
/// operation runs at a time; cancelling its task drops the video with it.
#[wasm_bindgen]
pub struct Video {
    /// The video. `None` while a frame is drawing it, and after it is finished or cancelled.
    inner: Rc<RefCell<Option<latkit::Video<latkit::Mp4<Written>>>>>,
    views: Vec<PageView>,
    written: Written,
    frames: Rc<RefCell<u64>>,
}

#[wasm_bindgen]
impl Video {
    /// Frames drawn or held so far.
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> f64 {
        *self.frames.borrow() as f64
    }

    /// Draws the next frame of its views. Resolves to the file bytes ready to write, once there is
    /// room for another frame.
    pub fn frame(&self) -> Task {
        let (inner, written, frames) = (self.inner.clone(), self.written.clone(), self.frames.clone());
        let views = self.views.clone();
        task(async move {
            let taken = inner.borrow_mut().take();
            let mut video = taken.ok_or_else(|| latkit::Error::invalid("the video is finished or cancelled"))?;
            let drawn = latkit::web::frame(&mut video, &views).await;
            *frames.borrow_mut() = video.frames();
            *inner.borrow_mut() = Some(video);
            drawn?;
            Ok(written.take())
        })
    }

    /// Ends the video and releases its views and encoder. A task in progress is cancelled by the
    /// page.
    pub fn cancel(&self) {
        self.inner.borrow_mut().take();
    }

    /// Encodes the remaining frames and ends the video. Resolves to the file's last bytes.
    pub fn finish(&self) -> Task {
        let (inner, written) = (self.inner.clone(), self.written.clone());
        task(async move {
            let video = inner.borrow_mut().take().ok_or(latkit::Error::Cancelled)?;
            video.finish().await?;
            Ok(written.take())
        })
    }
}

impl Written {
    /// The bytes written since the last call.
    fn take(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(&std::mem::take(&mut *self.0.borrow_mut())[..])
    }
}

/// A video of `shot`'s (JSON) pictures of `views`, each at its four fractions of `at`, at `fps`
/// frames per second. It encodes MP4 at `bitrate` bits per second, by default about 0.15 bits per
/// pixel per frame.
#[wasm_bindgen]
pub fn video(shot: &str, views: Vec<Handle>, at: &[f32], fps: f64, bitrate: Option<f64>) -> Result<Video, Error> {
    let (shot, views) = shot_of(shot, views, at)?;
    let gpu = views.first().ok_or_else(|| latkit::Error::invalid("expected at least one view").at("layout"))?.gpu();
    let written = Written::default();
    let mut mp4 = latkit::Mp4::new(written.clone());
    if let Some(bitrate) = bitrate {
        mp4 = mp4.bitrate(bitrate as u32);
    }
    let video = shot.video(&gpu, fps, mp4)?;
    Ok(Video { inner: Rc::new(RefCell::new(Some(video))), views, written, frames: Rc::default() })
}

/// Sets the factory for video encoders: `create(width, height, fps, bitrate)` returns one. The npm
/// package passes its WebCodecs encoder.
#[wasm_bindgen(js_name = setEncoder)]
pub fn set_encoder(create: js_sys::Function) {
    latkit::host::Browser::set_encoder(create);
}
