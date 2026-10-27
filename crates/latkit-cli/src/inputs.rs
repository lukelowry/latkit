//! Reading a job's inputs: scenes, datasets, cameras, fits, and frames. Datasets and frame patches
//! load through the library and its host, which reads the files their documents reference.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use latkit::host::Native;
use latkit::{Camera, Data, Error, Fit, Name, Patch, Patches, Reading, Scene};
use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::args::{Source, is_stdio};
use crate::{Failure, block};

/// Number of frames read and loaded ahead of the one being drawn.
const AHEAD: usize = 2;

/// Reads the bytes at `path`, or stdin for `-`.
pub(crate) fn read(path: &Path) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    let result = if is_stdio(path) {
        io::stdin().lock().read_to_end(&mut bytes).map(drop)
    } else {
        File::open(path).and_then(|mut f| f.read_to_end(&mut bytes)).map(drop)
    };
    result.map_err(|e| Failure::io(&e, path))?;
    Ok(bytes)
}

/// The base for relative paths in the document at `path`: the document's path, or empty for stdin.
fn base(path: &Path) -> String {
    if is_stdio(path) { String::new() } else { path.to_string_lossy().into_owned() }
}

/// Reads the JSON document at `path` as a `T`.
pub(crate) fn document<T: DeserializeOwned>(path: &Path) -> Result<T, Failure> {
    let bytes = read(path)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| Failure::at(Error::invalid("not UTF-8 text"), path))?;
    latkit::from_json(text).map_err(|e| Failure::at(e, path))
}

/// Reads argument `arg` of the option or argument `name` as a `T`: JSON when it starts with `{`,
/// else the document in the file it names.
pub(crate) fn json<T: DeserializeOwned>(arg: &str, name: &str) -> Result<T, Failure> {
    if arg.trim_start().starts_with('{') {
        latkit::from_json(arg).map_err(|e| Failure::from(e.at(name)))
    } else {
        document(Path::new(arg))
    }
}

/// Reads a scene from its JSON file.
pub(crate) fn scene(path: &Path) -> Result<Scene, Failure> {
    document(path)
}

/// Parses a fit: a bare name such as `all`, or JSON.
pub(crate) fn fit(text: &str) -> Result<Fit, Failure> {
    let json = if text.trim_start().starts_with(['{', '"', '[']) { text.to_owned() } else { format!("\"{text}\"") };
    latkit::from_json(&json).map_err(|e| Failure::from(e.at("--fit")))
}

/// Loads the dataset `source` names: latkit bytes, GeoJSON, or a JSON document whose referenced
/// files `host` reads. The name `source` gives, if any, names the dataset.
pub(crate) fn dataset(source: &Source, host: &Native, deadline: Duration) -> Result<Data, Failure> {
    let path = &source.path;
    let bytes = read(path)?;
    let base = base(path);
    let reading = Reading { name: source.name.as_deref(), base: &base, host: Some(host) };
    block(deadline, Data::read(&bytes, reading)).map_err(|e| Failure::at(e, path))
}

/// One output frame's changes, from one line of a frames file.
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Frame {
    /// The axis coordinate every view shows.
    pub(crate) at: Option<f64>,
    /// Patches by dataset name, applied in the order written.
    #[serde(default)]
    patch: Patches,
    /// Cameras views switch to at once: one for every view whose space it fits, or one per view.
    pub(crate) camera: Option<Each<Camera>>,
    /// Cameras views ease to, given like `camera`.
    pub(crate) fly: Option<Each<Camera>>,
    /// What views fit: one fit for every view, or one per view.
    pub(crate) fit: Option<Each<Fit>>,
    /// CSS pixels every view keeps clear: top, right, bottom, left.
    pub(crate) insets: Option<[f32; 4]>,
    /// Degrees per second every map or plane turns.
    pub(crate) orbit: Option<f64>,
}

/// One value for every view, or one per view in order. `null` leaves a view unchanged.
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
#[schemars(inline)]
pub(crate) enum Each<T> {
    Each(Vec<Option<T>>),
    All(T),
}

impl<T: Clone> Each<T> {
    /// The value for view `i`.
    pub(crate) fn of(&self, i: usize) -> Option<T> {
        match self {
            Each::All(value) => Some(value.clone()),
            Each::Each(values) => values.get(i).cloned().flatten(),
        }
    }
}

/// A frame's index, its changes, and its loaded patches by dataset name.
pub(crate) type Next = (usize, Frame, Vec<(Name, Patch)>);

/// Reads a frames file, one frame per line, loading each frame's patches through the host.
pub(crate) struct Frames {
    path: PathBuf,
    lines: io::Lines<Box<dyn BufRead + Send>>,
    index: usize,
    host: Native,
    deadline: Duration,
}

impl Frames {
    pub(crate) fn open(path: &Path, host: Native, deadline: Duration) -> Result<Frames, Failure> {
        let input: Box<dyn BufRead + Send> = if is_stdio(path) {
            Box::new(BufReader::new(io::stdin()))
        } else {
            Box::new(BufReader::new(File::open(path).map_err(|e| Failure::io(&e, path))?))
        };
        Ok(Frames { path: path.to_path_buf(), lines: input.lines(), index: 0, host, deadline })
    }

    /// The next frame, with its patches loaded. `None` at the end. Skips blank lines.
    pub(crate) fn next(&mut self) -> Result<Option<Next>, Failure> {
        loop {
            let Some(line) = self.lines.next() else { return Ok(None) };
            let line = line.map_err(|e| Failure::io(&e, &self.path))?;
            if line.trim().is_empty() {
                continue;
            }
            let index = self.index;
            self.index += 1;
            let at = |error: Error| Failure::at(error.at(index).at("frames"), &self.path);
            let mut frame: Frame = latkit::from_json(&line).map_err(at)?;
            if frame.at.is_some_and(|a| !a.is_finite()) {
                return Err(at(Error::invalid("expected a finite number").at("at")));
            }
            let base = base(&self.path);
            let reading = Reading { base: &base, host: Some(&self.host), name: None };
            let patches = std::mem::take(&mut frame.patch).read(reading);
            let patches = block(self.deadline, patches).map_err(|e| at(e.at("patch")))?;
            return Ok(Some((index, frame, patches)));
        }
    }

    /// Reads and loads frames on a separate thread, a few ahead of the one taken, so their files
    /// load while frames draw.
    pub(crate) fn ahead(mut self) -> Ahead {
        let (send, frames) = mpsc::sync_channel(AHEAD);
        std::thread::spawn(move || {
            while let Some(next) = self.next().transpose() {
                let failed = next.is_err();
                if send.send(next).is_err() || failed {
                    break;
                }
            }
        });
        Ahead(frames)
    }
}

/// Frames loaded ahead of drawing.
pub(crate) struct Ahead(Receiver<Result<Next, Failure>>);

impl Iterator for Ahead {
    type Item = Result<Next, Failure>;

    fn next(&mut self) -> Option<Self::Item> {
        self.0.recv().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deadline() -> Duration {
        Duration::from_secs(10)
    }

    #[test]
    fn datasets_load_json_slices_bytes_and_geojson_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let floats: Vec<u8> = [9_f32, 1.25, -2.5].into_iter().flat_map(f32::to_le_bytes).collect();
        std::fs::write(dir.path().join("x.f32"), floats).unwrap();
        let doc = r#"{"name": "grid", "patch": [{"replace": {"table": "Bus", "ids": ["b", "a"], "fields": {
            "x": {"file": "x.f32", "dtype": "f32le", "offset": 4, "count": 2}}}}]}"#;
        std::fs::write(dir.path().join("grid.json"), doc).unwrap();
        let host = Native::new();
        let load = |text: &str| dataset(&text.parse().unwrap(), &host, deadline());
        let path = dir.path().join("grid.json").to_string_lossy().into_owned();
        let data = load(&path).unwrap().snapshot();
        assert_eq!(data.get("Bus", "a", "x", None), Some(latkit::Value::Number(-2.5)));
        assert_eq!(load(&format!("other={path}")).unwrap().name().as_str(), "other");
        std::fs::write(dir.path().join("grid.bin"), data.to_bytes()).unwrap();
        let rows = |data: &Data, table: &str| {
            data.snapshot().describe().tables.into_iter().find(|t| t.name == table).map(|t| t.rows)
        };
        let bin = load(&dir.path().join("grid.bin").to_string_lossy()).unwrap();
        assert_eq!(rows(&bin, "Bus"), Some(2));
        let geo = r#"{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [1, 2]}}"#;
        std::fs::write(dir.path().join("p.geojson"), geo).unwrap();
        let geo_path = dir.path().join("p.geojson").to_string_lossy().into_owned();
        assert!(load(&geo_path).is_err(), "GeoJSON needs a name");
        let places = load(&format!("places={geo_path}")).unwrap();
        assert_eq!(rows(&places, "points"), Some(1));
    }

    #[test]
    fn frames_keep_patch_order_and_take_one_value_or_one_per_view() {
        let frame: Frame = latkit::from_json(r#"{"patch": {"b": [], "a": []}}"#).unwrap();
        let host = Native::new();
        let patches = block(deadline(), frame.patch.read(Reading { host: Some(&host), ..Reading::default() })).unwrap();
        let names: Vec<&str> = patches.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["b", "a"]);
        assert!(latkit::from_json::<Frame>(r#"{"patch": {"a": [], "a": []}}"#).is_err(), "a dataset named twice fails");
        let error = latkit::from_json::<Frame>(r#"{"patch": {"a": [[]]}}"#).map(drop).unwrap_err();
        assert!(error.to_string().starts_with("patch.a[0]"), "{error}");
        let one: Each<f64> = latkit::from_json("2").unwrap();
        let each: Each<f64> = latkit::from_json("[null, 3]").unwrap();
        assert_eq!((one.of(0), one.of(5)), (Some(2.0), Some(2.0)));
        assert_eq!((each.of(0), each.of(1), each.of(2)), (None, Some(3.0), None));
        assert!(fit("all").is_ok() && fit(r#"{"bounds": {"min": [0, 0, 0], "max": [1, 1, 0]}}"#).is_ok());
    }
}
