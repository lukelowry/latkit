//! Native text, a small, lazily started worker pool, local files, and the platform's H.264 encoder.
//! No window or async runtime is needed.

#[cfg(windows)]
#[allow(unsafe_code, reason = "Media Foundation is COM: the FFI stays in this module, behind Encoder")]
mod media_foundation;

use std::io::{Read, Seek, SeekFrom};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

use cosmic_text::{Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, SwashCache, Wrap, fontdb};

use super::{Host, Job, Raster, Request, TextRun};
use crate::video::{Encoder, Encoding};
use crate::{Error, Pending, Resolver, Result};

/// Native platform services: shaped text, background jobs, local files, and video. System fonts are
/// discovered only on the first text request; [`from_fonts`](Self::from_fonts) uses only the supplied
/// font bytes. A pool of at most four workers starts on the first job. A fetch reads a file path (or a
/// `file://` URL) at once. Video encodes with Media Foundation on Windows, hardware where the machine
/// has it; elsewhere this host encodes none.
#[derive(Default)]
pub struct Native {
    text: Mutex<Option<Text>>,
    workers: OnceLock<Result<Workers>>,
}

impl Native {
    /// A host that discovers system fonts lazily. Constructing it does no I/O and starts no threads.
    pub fn new() -> Self {
        Self::default()
    }

    /// A host using only these TTF/OTF/TTC bytes, in order; the first family is the generic fallback.
    /// No system fonts are discovered. Each item must contain at least one usable face.
    pub fn from_fonts(fonts: impl IntoIterator<Item = Vec<u8>>) -> Result<Self> {
        let mut db = fontdb::Database::new();
        for (i, font) in fonts.into_iter().enumerate() {
            let before = db.faces().count();
            db.load_font_data(font);
            if db.faces().count() == before {
                return Err(Error::invalid("no usable font faces").at(i).at("fonts"));
            }
        }
        let family = db
            .faces()
            .next()
            .and_then(|face| face.families.first())
            .map(|(name, _)| name.clone())
            .ok_or_else(|| Error::invalid("supply at least one font").at("fonts"))?;
        db.set_sans_serif_family(family.clone());
        db.set_serif_family(family.clone());
        db.set_monospace_family(family);
        let fonts = FontSystem::new_with_locale_and_db("en-US".into(), db);
        Ok(Self { text: Mutex::new(Some(Text { fonts, cache: SwashCache::new() })), workers: OnceLock::new() })
    }

    fn with_text<T>(&self, f: impl FnOnce(&mut Text) -> Result<T>) -> Result<T> {
        let mut text = self.text.lock().map_err(|_| Error::Load("native text service failed".into()))?;
        let text = text.get_or_insert_with(Text::system);
        if text.fonts.db().faces().next().is_none() {
            return Err(Error::Unsupported("no fonts available; supply font bytes with Native::from_fonts".into()));
        }
        f(text)
    }
}

impl Host for Native {
    fn rasterize(&self, run: &TextRun) -> Result<Raster> {
        self.with_text(|text| {
            let (mut buffer, bounds, baseline) = text.layout(run)?;
            let size = [(bounds[2] - bounds[0]) as u32, (bounds[3] - bounds[1]) as u32];
            let mut coverage = vec![0; size[0] as usize * size[1] as usize];
            buffer.draw(&mut text.fonts, &mut text.cache, Color::rgb(255, 255, 255), |x, y, w, h, color| {
                for row in y..y + h as i32 {
                    for col in x..x + w as i32 {
                        let at = (row - bounds[1]) as usize * size[0] as usize + (col - bounds[0]) as usize;
                        let alpha = u32::from(color.a());
                        let old = u32::from(coverage[at]);
                        coverage[at] = (alpha + (old * (255 - alpha) + 127) / 255) as u8;
                    }
                }
            });
            Ok(Raster { size, coverage, baseline: baseline - bounds[1] as f32 })
        })
    }

    fn measure(&self, run: &TextRun) -> Result<[f32; 2]> {
        self.with_text(|text| {
            let (_, bounds, _) = text.layout(run)?;
            Ok([(bounds[2] - bounds[0]) as f32, (bounds[3] - bounds[1]) as f32])
        })
    }

    fn spawn(&self, job: Job) -> Pending<Vec<u8>> {
        let workers = match self.workers.get_or_init(Workers::new) {
            Ok(workers) => workers,
            Err(error) => return Pending::ready(Err(error.clone())),
        };
        let (pending, resolver) = Pending::new();
        if let Err(error) = workers.0.send((job, resolver)) {
            error.0.1.resolve(Err(Error::Load("native workers stopped".into())));
        }
        pending
    }

    fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
        Pending::ready(read(request))
    }

    fn encoder(&self, encoding: &Encoding) -> Result<Box<dyn Encoder>> {
        #[cfg(windows)]
        return media_foundation::encoder(encoding);
        #[cfg(not(windows))]
        {
            let _ = encoding;
            Err(Error::Unsupported(
                "native H.264 encoding is Windows' (Media Foundation); this platform has none".into(),
            ))
        }
    }
}

/// The bytes `request` names of a local file: none where there is no file.
fn read(request: &Request) -> Result<Vec<u8>> {
    let url = &*request.url;
    let path = url.strip_prefix("file://").unwrap_or(url);
    if path.contains("://") {
        return Err(Error::Unsupported(format!("the native host reads files, not {url}").into()));
    }
    let failed = |e: std::io::Error| Error::Load(format!("{path}: {e}").into());
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(failed(e)),
    };
    let mut bytes = Vec::new();
    match &request.range {
        None => {
            file.read_to_end(&mut bytes).map_err(failed)?;
        }
        Some(range) => {
            file.seek(SeekFrom::Start(range.start)).map_err(failed)?;
            file.take(range.end.saturating_sub(range.start)).read_to_end(&mut bytes).map_err(failed)?;
        }
    }
    Ok(bytes)
}

struct Text {
    fonts: FontSystem,
    cache: SwashCache,
}

impl Text {
    fn system() -> Self {
        // Keep fontdb's platform/fontconfig generic families. FontSystem::new replaces them with
        // fixed Linux family names, which may be absent on Windows and macOS.
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        Self { fonts: FontSystem::new_with_locale_and_db("en-US".into(), db), cache: SwashCache::new() }
    }

    fn layout(&mut self, run: &TextRun) -> Result<(Buffer, [i32; 4], f32)> {
        if run.size_px == 0 || run.size_px > 4096 || run.max_width == Some(0) {
            return Err(Error::invalid("text size must be 1..=4096 pixels and wrap width must be positive"));
        }
        // Resolve the CSS family list in order, including generic families. Cosmic supplies glyph
        // fallback within the chosen database, including shaping for complex scripts.
        let family = run
            .font
            .split(',')
            .map(|name| name.trim().trim_matches(['\'', '"']))
            .map(|name| match name {
                "serif" => Family::Serif,
                "monospace" => Family::Monospace,
                "sans-serif" | "system-ui" => Family::SansSerif,
                _ => Family::Name(name),
            })
            .find(|family| {
                self.fonts.db().query(&fontdb::Query { families: &[*family], ..Default::default() }).is_some()
            })
            .unwrap_or(Family::SansSerif);
        let size = run.size_px as f32;
        let mut buffer = Buffer::new(&mut self.fonts, Metrics::new(size, size * 1.25));
        buffer.set_size(run.max_width.map(|width| width as f32), None);
        buffer.set_wrap(if run.max_width.is_some() { Wrap::Word } else { Wrap::None });
        buffer.set_text(&run.text, &Attrs::new().family(family), Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.fonts, false);
        let baseline = buffer.layout_runs().next().map_or(size, |line| line.line_y);
        let mut bounds = [0, 0, 1, (size * 1.25).ceil() as i32];
        for line in buffer.layout_runs() {
            bounds[2] = bounds[2].max(line.line_w.ceil() as i32);
            bounds[3] = bounds[3].max((line.line_top + line.line_height).ceil() as i32);
            if line.glyphs.iter().any(|glyph| glyph.glyph_id == 0) {
                return Err(Error::Unsupported(
                    "available fonts do not cover this text; supply a fallback font".into(),
                ));
            }
        }
        buffer.draw(&mut self.fonts, &mut self.cache, Color::rgb(255, 255, 255), |x, y, w, h, _| {
            bounds[0] = bounds[0].min(x);
            bounds[1] = bounds[1].min(y);
            bounds[2] = bounds[2].max(x + w as i32);
            bounds[3] = bounds[3].max(y + h as i32);
        });
        bounds[0] -= 2;
        bounds[1] -= 2;
        bounds[2] += 2;
        bounds[3] += 2;
        if bounds[2] - bounds[0] > 4096 || bounds[3] - bounds[1] > 4096 {
            return Err(Error::Limit("text raster exceeds 4096 pixels on one axis".into()));
        }
        Ok((buffer, bounds, baseline))
    }
}

type Task = (Job, Resolver<Vec<u8>>);
struct Workers(mpsc::Sender<Task>);

impl Workers {
    fn new() -> Result<Self> {
        let (sender, receiver) = mpsc::channel::<Task>();
        let receiver = Arc::new(Mutex::new(receiver));
        let count = std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).clamp(1, 4));
        for i in 0..count {
            let receiver = receiver.clone();
            std::thread::Builder::new()
                .name(format!("latkit-{i}"))
                .spawn(move || {
                    loop {
                        let task = receiver.lock().expect("worker queue").recv();
                        let Ok((job, resolver)) = task else { break };
                        if resolver.is_cancelled() {
                            continue;
                        }
                        let result = catch_unwind(AssertUnwindSafe(|| job.run()))
                            .map_err(|_| Error::Load("native job panicked".into()));
                        resolver.resolve(result);
                    }
                })
                .map_err(|error| Error::Load(format!("cannot start native worker: {error}").into()))?;
        }
        Ok(Self(sender))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font_bytes() -> Vec<u8> {
        let fonts = Text::system().fonts;
        let id = fonts
            .db()
            .query(&fontdb::Query { families: &[Family::SansSerif], ..Default::default() })
            .expect("native text tests require a system sans-serif font");
        fonts.db().with_face_data(id, |bytes, _| bytes.to_vec()).expect("font bytes")
    }

    #[test]
    fn services_are_lazy_and_explicit_fonts_are_validated() {
        let native = Native::new();
        assert!(native.text.lock().unwrap().is_none());
        assert!(native.workers.get().is_none());
        assert!(Native::from_fonts([]).is_err());
        assert!(Native::from_fonts([b"not a font".to_vec()]).is_err());
    }

    #[test]
    fn shaped_text_measures_wraps_and_reuses_the_glyph_cache() {
        let host = Native::from_fonts([font_bytes()]).unwrap();
        let mut run = TextRun {
            text: "Hello world office".into(),
            font: "Missing Font, sans-serif".into(),
            size_px: 32,
            max_width: None,
        };
        let raster = host.rasterize(&run).unwrap();
        assert!(raster.coverage.iter().any(|&alpha| alpha > 0));
        assert!(raster.coverage.contains(&0));
        assert_eq!(host.measure(&run).unwrap(), raster.size.map(|n| n as f32));
        assert_eq!(host.rasterize(&run).unwrap(), raster);
        assert!(raster.baseline > 0.0 && raster.baseline < raster.size[1] as f32);
        run.max_width = Some(130);
        let wrapped = host.rasterize(&run).unwrap();
        assert!(wrapped.size[1] > raster.size[1]);
        assert!(wrapped.size[0] < raster.size[0]);
    }

    #[test]
    fn fetches_read_local_files_and_their_ranges() {
        let dir = std::env::temp_dir().join(format!("latkit-fetch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bytes.bin");
        std::fs::write(&path, b"0123456789").unwrap();
        let host = Native::new();
        let fetch = |request: Request| pollster::block_on(host.fetch(&request));
        let url = path.to_string_lossy().into_owned();
        assert_eq!(fetch(Request::new(url.as_str())).unwrap(), b"0123456789");
        assert_eq!(fetch(Request::range(format!("file://{url}"), 3..6)).unwrap(), b"345");
        assert_eq!(fetch(Request::range(url.as_str(), 8..20)).unwrap(), b"89", "a range past the end");
        assert_eq!(fetch(Request::new(dir.join("none").to_string_lossy().into_owned())).unwrap(), b"");
        assert!(fetch(Request::new("https://example.com/tiles")).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn background_jobs_complete_without_a_runtime_or_font_discovery() {
        let host = Native::new();
        let image = crate::Image::new([1, 1], vec![255, 0, 0, 128]).unwrap();
        let jobs: Vec<_> = (0..12).map(|_| host.spawn(Job::png(&image))).collect();
        for job in jobs {
            assert_eq!(crate::Image::from_png(&pollster::block_on(job).unwrap()).unwrap(), image);
        }
        assert!(host.text.lock().unwrap().is_none());
    }
}
