//! Pictures and videos of views: a shot crosses as `{ size, scale, panels, transparent, deadline, elapsed }`
//! and draws the views of the canvases given, which hold their last frames meanwhile. An image's
//! pixels cross once; a video hands back the bytes each frame made, for the page to write.

use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;

use js_sys::{Array, Reflect};
use latkit::web::Canvas;
use wasm_bindgen::prelude::*;

use crate::Error;

/// A view's canvas, lent to a shot: what `view.handle()` gives.
#[wasm_bindgen]
pub struct Handle(pub(crate) Canvas);

/// A shot as the npm `Shot` holds it.
fn shot(config: &JsValue) -> Result<latkit::Shot, Error> {
    let get = |name: &str| Reflect::get(config, &name.into()).unwrap_or(JsValue::UNDEFINED);
    let pair = |value: JsValue| {
        let array: Array = value.dyn_into().ok()?;
        Some([array.get(0).as_f64()?, array.get(1).as_f64()?])
    };
    let size =
        pair(get("size")).ok_or_else(|| latkit::Error::invalid("a shot's size is [width, height]").at("size"))?;
    let mut shot = latkit::Shot::new(size.map(|v| v as u32));
    if let Some(scale) = get("scale").as_f64() {
        shot = shot.scale(scale as f32);
    }
    if let Ok(panels) = get("panels").dyn_into::<Array>() {
        for panel in panels.iter() {
            let panel: Array =
                panel.dyn_into().map_err(|_| latkit::Error::invalid("a panel is [x, y, width, height]"))?;
            let part = [0, 1, 2, 3].map(|i| panel.get(i).as_f64().unwrap_or(0.0) as f32);
            shot = shot.panel(part);
        }
    }
    if get("transparent").is_truthy() {
        shot = shot.transparent();
    }
    if let Some(ms) = get("deadline").as_f64() {
        let duration = std::time::Duration::try_from_secs_f64(ms / 1000.0)
            .map_err(|_| latkit::Error::invalid("deadline is nonnegative milliseconds within range").at("deadline"))?;
        shot = shot.deadline(duration);
    }
    if let Some(seconds) = get("elapsed").as_f64() {
        let duration = std::time::Duration::try_from_secs_f64(seconds)
            .map_err(|_| latkit::Error::invalid("elapsed is nonnegative seconds within range").at("elapsed"))?;
        shot = shot.elapsed(duration);
    }
    Ok(shot)
}

fn canvases(views: Vec<Handle>) -> Vec<Canvas> {
    views.into_iter().map(|h| h.0).collect()
}

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

    /// The job writing the image as PNG, for a worker to do.
    #[wasm_bindgen(js_name = pngJob)]
    pub fn png_job(&self) -> Vec<u8> {
        latkit::host::Job::png(&self.0).into_bytes()
    }
}

/// The picture `shot` takes of the views of `views`, one per panel, once they are complete and still.
#[wasm_bindgen]
pub fn image(shot_config: &JsValue, views: Vec<Handle>) -> Result<js_sys::Promise, Error> {
    let shot = shot(shot_config)?;
    let canvases = canvases(views);
    Ok(wasm_bindgen_futures::future_to_promise(async move {
        let image = latkit::web::image(&shot, &canvases).await.map_err(|e| JsValue::from(Error::from(e)))?;
        Ok(Image(image).into())
    }))
}

/// Bytes a video wrote and the page has not yet taken.
#[derive(Clone, Default)]
struct Sink(Rc<RefCell<Vec<u8>>>);

impl Write for Sink {
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
    inner: Rc<RefCell<Option<latkit::Video<Sink>>>>,
    sink: Sink,
    fps: f64,
    frames: Rc<RefCell<u64>>,
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
        let (inner, sink, frames) = (self.inner.clone(), self.sink.clone(), self.frames.clone());
        let canvases = canvases(views);
        wasm_bindgen_futures::future_to_promise(async move {
            let taken = inner.borrow_mut().take();
            let error = || latkit::Error::invalid("a video draws one frame at a time, until it is finished");
            let mut video = taken.ok_or_else(|| JsValue::from(Error::from(error())))?;
            let drawn = latkit::web::frame(&mut video, &canvases).await;
            *frames.borrow_mut() = video.frames();
            *inner.borrow_mut() = Some(video);
            drawn.map_err(|e| JsValue::from(Error::from(e)))?;
            Ok(js_sys::Uint8Array::from(&std::mem::take(&mut *sink.0.borrow_mut())[..]).into())
        })
    }

    /// Encodes every frame under way and ends the video; resolves to the file's last bytes.
    pub fn finish(&self) -> js_sys::Promise {
        let (inner, sink) = (self.inner.clone(), self.sink.clone());
        wasm_bindgen_futures::future_to_promise(async move {
            let taken = inner.borrow_mut().take();
            let video = taken.ok_or_else(|| JsValue::from(Error::from(latkit::Error::Cancelled)))?;
            video.finish().await.map_err(|e| JsValue::from(Error::from(e)))?;
            Ok(js_sys::Uint8Array::from(&std::mem::take(&mut *sink.0.borrow_mut())[..]).into())
        })
    }
}

/// A video of `shot_config`'s pictures at `fps` frames a second, at `bitrate` bits a second or about
/// 0.15 bits a pixel a frame.
pub(crate) fn video(gpu: &latkit::Gpu, shot_config: &JsValue, fps: f64, bitrate: Option<f64>) -> Result<Video, Error> {
    let shot = shot(shot_config)?;
    let mut encoding = latkit::Encoding::new(shot.size(), fps);
    if let Some(bitrate) = bitrate {
        encoding.bitrate = bitrate as u32;
    }
    let sink = Sink::default();
    let video = shot.video_at(gpu, encoding, sink.clone())?;
    Ok(Video { inner: Rc::new(RefCell::new(Some(video))), sink, fps, frames: Rc::default() })
}

/// Has videos encoded by what `create` makes of `(width, height, fps, bitrate)`: the npm package's
/// WebCodecs encoder.
#[wasm_bindgen(js_name = setEncoder)]
pub fn set_encoder(create: js_sys::Function) {
    latkit::host::Browser::set_encoder(create);
}
