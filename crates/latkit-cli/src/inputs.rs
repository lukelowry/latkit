//! What a job reads: scenes, datasets, cameras, fits, and frames. Datasets and frames' patches are
//! the library's JSON documents, loaded through the host, which reads the files they name.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use latkit::host::Native;
use latkit::{Camera, Data, Error, Fit, Patch, Scene};
use serde::Deserialize;
use serde::de::{IgnoredAny, MapAccess, Visitor};
use serde_json::value::RawValue;

use crate::args::{Source, is_stdio};
use crate::{Failure, block};

/// Frames read and loaded ahead of the one drawing.
const AHEAD: usize = 2;

/// The bytes at `path`, or stdin's for `-`.
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

/// What paths in the document at `path` are relative to: the document, or nothing for stdin.
fn base(path: &Path) -> String {
    if is_stdio(path) { String::new() } else { path.to_string_lossy().into_owned() }
}

/// A scene from its JSON.
pub(crate) fn scene(path: &Path) -> Result<Scene, Failure> {
    serde_json::from_slice(&read(path)?).map_err(|e| Failure::at(Error::invalid(e.to_string()), path))
}

/// A camera from its JSON.
pub(crate) fn camera(path: &Path) -> Result<Camera, Failure> {
    serde_json::from_slice(&read(path)?).map_err(|e| Failure::at(Error::invalid(e.to_string()), path))
}

/// A fit: `all`, or one as JSON.
pub(crate) fn fit(text: &str) -> Result<Fit, Failure> {
    let json = if text.trim_start().starts_with(['{', '"', '[']) { text.to_owned() } else { format!("\"{text}\"") };
    serde_json::from_str(&json).map_err(|e| Failure::from(Error::invalid(format!("--fit: {e}"))))
}

/// The dataset `source` names: a JSON document loaded through `host`, latkit bytes, or GeoJSON,
/// named as it says.
pub(crate) fn dataset(source: &Source, host: &Native, deadline: Duration) -> Result<Data, Failure> {
    let path = &source.path;
    let bytes = read(path)?;
    let at = |error: Error| Failure::at(error, path);
    let data = if bytes.starts_with(b"LATK") {
        Data::from_bytes(&bytes).map_err(at)?
    } else if bytes.starts_with(&[0x1f, 0x8b]) || geojson(&bytes) {
        let name = source.name.as_deref().ok_or_else(|| at(Error::invalid("GeoJSON names its dataset: NAME=FILE")))?;
        return latkit::geo::geojson(name, &bytes).map_err(at);
    } else {
        let text = std::str::from_utf8(&bytes).map_err(|_| at(Error::invalid("a dataset is JSON or latkit bytes")))?;
        block(deadline, Data::load(text, &base(path), host)).map_err(at)?
    };
    match &source.name {
        Some(name) if name != data.name().as_str() => {
            let mut renamed = Data::new(name.as_str());
            renamed.apply(data.to_patch()).map_err(at)?;
            Ok(renamed)
        }
        _ => Ok(data),
    }
}

/// Whether JSON `bytes` are GeoJSON: an object with a `type`.
fn geojson(bytes: &[u8]) -> bool {
    #[derive(Deserialize)]
    struct Probe {
        #[serde(rename = "type")]
        kind: Option<IgnoredAny>,
    }
    serde_json::from_slice::<Probe>(bytes).is_ok_and(|p| p.kind.is_some())
}

/// One output frame's changes, as a line of the frames file says.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Frame {
    /// The axis coordinate every view shows.
    pub(crate) at: Option<f64>,
    /// Patches by dataset name, in the order written, as the library reads them.
    #[serde(default)]
    patch: Patches,
    /// Where views look at once: one camera for every view it fits, or one per view.
    pub(crate) camera: Option<Each<Camera>>,
    /// Where views ease to.
    pub(crate) fly: Option<Each<Camera>>,
    /// What views frame.
    pub(crate) fit: Option<Each<Fit>>,
    /// CSS pixels every view keeps clear: top, right, bottom, left.
    pub(crate) insets: Option<[f32; 4]>,
    /// Degrees a second every map or plane turns.
    pub(crate) orbit: Option<f64>,
}

/// A frame's patches by dataset name, in the order written.
#[derive(Default)]
struct Patches(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for Patches {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Patches, D::Error> {
        struct Map;
        impl<'de> Visitor<'de> for Map {
            type Value = Patches;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("patches by dataset name")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Patches, A::Error> {
                let mut patches: Vec<(String, Box<RawValue>)> = Vec::new();
                while let Some(name) = map.next_key::<String>()? {
                    if patches.iter().any(|(n, _)| *n == name) {
                        return Err(serde::de::Error::custom(format!("dataset {name} is patched twice")));
                    }
                    patches.push((name, map.next_value()?));
                }
                Ok(Patches(patches))
            }
        }
        deserializer.deserialize_map(Map)
    }
}

/// One value for every view, or one for each in order, `null` leaving a view as it is.
#[derive(Deserialize)]
#[serde(untagged)]
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

/// A frame's index, what it changes, and its patches by dataset, loaded.
pub(crate) type Next = (usize, Frame, Vec<(String, Patch)>);

/// The lines of a frames file, each a frame, its patches loaded through the host.
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

    /// The next frame, its patches loaded; `None` at the end. Blank lines are skipped.
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
            let mut frame: Frame = serde_json::from_str(&line).map_err(|e| at(Error::invalid(e.to_string())))?;
            if frame.at.is_some_and(|a| !a.is_finite()) {
                return Err(at(Error::invalid("at is finite").at("at")));
            }
            let base = base(&self.path);
            let mut patches = Vec::with_capacity(frame.patch.0.len());
            for (name, json) in std::mem::take(&mut frame.patch.0) {
                let patch = block(self.deadline, Patch::load(json.get(), &base, &self.host))
                    .map_err(|e| at(e.at(name.as_str()).at("patch")))?;
                patches.push((name, patch));
            }
            return Ok(Some((index, frame, patches)));
        }
    }

    /// The frames read and loaded on a thread of their own, a few ahead of the one taken, so their
    /// files are read while frames draw.
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
        let doc = r#"{"name": "grid", "patch": [{"put": {"table": "Bus", "ids": ["b", "a"], "fields": {
            "x": {"file": "x.f32", "dtype": "f32le", "offset": 4, "count": 2}}}}]}"#;
        std::fs::write(dir.path().join("grid.json"), doc).unwrap();
        let host = Native::new();
        let load = |text: &str| dataset(&text.parse().unwrap(), &host, deadline());
        let path = dir.path().join("grid.json").to_string_lossy().into_owned();
        let data = load(&path).unwrap();
        assert_eq!(data.table("Bus").unwrap().get("a", "x"), Some(latkit::Value::Number(-2.5)));
        assert_eq!(load(&format!("other={path}")).unwrap().name().as_str(), "other");
        std::fs::write(dir.path().join("grid.bin"), data.to_bytes()).unwrap();
        assert_eq!(load(&dir.path().join("grid.bin").to_string_lossy()).unwrap().table("Bus").unwrap().len(), 2);
        let geo = r#"{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [1, 2]}}"#;
        std::fs::write(dir.path().join("p.geojson"), geo).unwrap();
        let geo_path = dir.path().join("p.geojson").to_string_lossy().into_owned();
        assert!(load(&geo_path).is_err(), "GeoJSON names its dataset");
        assert_eq!(load(&format!("places={geo_path}")).unwrap().table("points").unwrap().len(), 1);
    }

    #[test]
    fn frames_keep_their_patches_order_and_apply_to_every_view_or_each() {
        let frame: Frame = serde_json::from_str(r#"{"patch": {"b": [], "a": []}}"#).unwrap();
        let names: Vec<&str> = frame.patch.0.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["b", "a"]);
        assert!(serde_json::from_str::<Frame>(r#"{"patch": {"a": [], "a": []}}"#).is_err());
        let one: Each<f64> = serde_json::from_str("2").unwrap();
        let each: Each<f64> = serde_json::from_str("[null, 3]").unwrap();
        assert_eq!((one.of(0), one.of(5)), (Some(2.0), Some(2.0)));
        assert_eq!((each.of(0), each.of(1), each.of(2)), (None, Some(3.0), None));
        assert!(fit("all").is_ok() && fit(r#"{"bounds": {"min": [0, 0, 0], "max": [1, 1, 0]}}"#).is_ok());
    }
}
