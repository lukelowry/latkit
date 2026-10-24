//! Pictures and videos of views: a shot crosses as JSON,
//! `{ size, scale, panels, transparent, deadline, elapsed }` with times in seconds, and draws the views
//! given, whose canvases hold their last frames meanwhile. An image's pixels cross once and its files
//! are written in workers; a video hands back the bytes each frame made, for the page to write.

use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;

use futures_util::future::{AbortHandle, Abortable};
use latkit::host::Host as _;
use wasm_bindgen::prelude::*;

use crate::Error;
use crate::canvas::{Handle, views_of};

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

    /// A promise of the image written in a worker as a `png`, `jpeg` at `quality` from 1 to 100, or
    /// `webp` file.
    pub fn encode(&self, format: &str, quality: Option<f64>) -> Result<js_sys::Promise, Error> {
        let quality = match quality {
            None => 90,
            Some(q) if (1.0..=100.0).contains(&q) => q.round() as u8,
            Some(_) => return Err(latkit::Error::invalid("a quality runs from 1 to 100").at("quality").into()),
        };
        let format = match format {
            "png" => latkit::ImageFormat::Png,
            "jpeg" => latkit::ImageFormat::Jpeg { quality },
            "webp" => latkit::ImageFormat::WebP,
            other => return Err(latkit::Error::invalid(format!("no image format {other:?}")).at("format").into()),
        };
        let job = latkit::host::Job::encode(&self.0, format);
        Ok(crate::promise(async move {
            let file = latkit::host::Browser.spawn(job).await?;
            if file.is_empty() {
                return Err(latkit::Error::invalid(format!("the image could not be written as {format}")));
            }
            Ok(js_sys::Uint8Array::from(&file[..]))
        }))
    }
}

/// The picture `shot` (JSON) takes of the views of `views`, one per panel, once they are complete
/// and still.
#[wasm_bindgen]
pub fn image(shot: &str, views: Vec<Handle>) -> Result<js_sys::Promise, Error> {
    let shot: latkit::Shot = crate::json("shot", shot)?;
    let views = views_of(views);
    Ok(wasm_bindgen_futures::future_to_promise(async move {
        let image = latkit::web::image(&shot, &views).await.map_err(|e| JsValue::from(Error::from(e)))?;
        Ok(Image(image).into())
    }))
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

/// A video of a shot's pictures, encoded by WebCodecs as frames are drawn.
#[wasm_bindgen]
pub struct Video {
    /// The video, or nothing while a frame draws it, and once it is finished.
    inner: Rc<RefCell<Option<latkit::Video<latkit::Mp4<Written>>>>>,
    written: Written,
    fps: f64,
    frames: Rc<RefCell<u64>>,
    active: Rc<RefCell<Option<AbortHandle>>>,
}

#[wasm_bindgen]
impl Video {
    /// Seconds into the video the next frame shows at.
    #[wasm_bindgen(getter)]
    pub fn time(&self) -> f64 {
        *self.frames.borrow() as f64 / self.fps
    }

    /// Frames drawn or held so far.
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> f64 {
        *self.frames.borrow() as f64
    }

    /// Draws the next frame of the views of `views`, one per panel; resolves to the bytes of the file
    /// ready to write, once there is room for another frame.
    pub fn frame(&self, views: Vec<Handle>) -> js_sys::Promise {
        let (inner, written, frames) = (self.inner.clone(), self.written.clone(), self.frames.clone());
        let views = views_of(views);
        self.cancellable(async move {
            let taken = inner.borrow_mut().take();
            let error = || latkit::Error::invalid("a video draws one frame at a time, until it is finished");
            let mut video = taken.ok_or_else(|| JsValue::from(Error::from(error())))?;
            let drawn = latkit::web::frame(&mut video, &views).await;
            *frames.borrow_mut() = video.frames();
            *inner.borrow_mut() = Some(video);
            drawn.map_err(|e| JsValue::from(Error::from(e)))?;
            Ok(js_sys::Uint8Array::from(&std::mem::take(&mut *written.0.borrow_mut())[..]).into())
        })
    }

    /// Cancels an in-flight operation, releasing its views and encoder when the future is dropped.
    pub fn cancel(&self) {
        if let Some(active) = self.active.borrow_mut().take() {
            active.abort();
        }
        self.inner.borrow_mut().take();
    }

    /// Encodes every frame under way and ends the video; resolves to the file's last bytes.
    pub fn finish(&self) -> js_sys::Promise {
        let (inner, written) = (self.inner.clone(), self.written.clone());
        self.cancellable(async move {
            let taken = inner.borrow_mut().take();
            let video = taken.ok_or_else(|| JsValue::from(Error::from(latkit::Error::Cancelled)))?;
            video.finish().await.map_err(|e| JsValue::from(Error::from(e)))?;
            Ok(js_sys::Uint8Array::from(&std::mem::take(&mut *written.0.borrow_mut())[..]).into())
        })
    }
}

impl Video {
    fn cancellable(
        &self,
        future: impl std::future::Future<Output = Result<JsValue, JsValue>> + 'static,
    ) -> js_sys::Promise {
        let mut active = self.active.borrow_mut();
        if active.is_some() {
            return js_sys::Promise::reject(&JsValue::from(Error::from(latkit::Error::invalid(
                "a video runs one operation at a time",
            ))));
        }
        let (abort, registration) = AbortHandle::new_pair();
        *active = Some(abort);
        let active = self.active.clone();
        wasm_bindgen_futures::future_to_promise(async move {
            let result = Abortable::new(future, registration).await;
            active.borrow_mut().take();
            result.unwrap_or_else(|_| Err(JsValue::from(Error::from(latkit::Error::Cancelled))))
        })
    }
}

impl Drop for Video {
    fn drop(&mut self) {
        self.cancel();
    }
}

/// A video of `shot`'s (JSON) pictures at `fps` frames a second, as MP4 at `bitrate` bits a second
/// or about 0.15 bits a pixel a frame.
pub(crate) fn video(gpu: &latkit::Gpu, shot: &str, fps: f64, bitrate: Option<f64>) -> Result<Video, Error> {
    let shot: latkit::Shot = crate::json("shot", shot)?;
    let written = Written::default();
    let mut mp4 = latkit::Mp4::new(written.clone());
    if let Some(bitrate) = bitrate {
        mp4 = mp4.bitrate(bitrate as u32);
    }
    let video = shot.video(gpu, fps, mp4)?;
    Ok(Video { inner: Rc::new(RefCell::new(Some(video))), written, fps, frames: Rc::default(), active: Rc::default() })
}

/// Has videos encoded by what `create` makes of `(width, height, fps, bitrate)`: the npm package's
/// WebCodecs encoder.
#[wasm_bindgen(js_name = setEncoder)]
pub fn set_encoder(create: js_sys::Function) {
    latkit::host::Browser::set_encoder(create);
}
