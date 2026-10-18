//! What a job reads: scenes, datasets, cameras, fits, fonts, and frames. Datasets and patches are
//! the library's JSON documents; slices of binary files they name are read here, relative to the
//! document that names them.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::{Path, PathBuf};

use latkit::{Camera, Data, Error, Fit, Patch, Scene};
use serde::Deserialize;
use serde::de::IgnoredAny;
use serde_json::value::RawValue;

use crate::Failure;
use crate::args::{Source, is_stdio};

/// Files a dataset's or a frame's slices keep open at once.
const OPEN: usize = 16;

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

/// The directory paths in the document at `path` are relative to: its own, or the current one for
/// stdin.
pub(crate) fn root(path: &Path) -> PathBuf {
    match path.parent() {
        Some(parent) if !is_stdio(path) && !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    }
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

/// The dataset `source` names: a JSON document, latkit bytes, or GeoJSON, named as it says.
pub(crate) fn dataset(source: &Source) -> Result<Data, Failure> {
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
        let mut files = Files::new(root(path));
        Data::from_json(text, |file, range| files.read(file, range)).map_err(at)?
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
    /// Patches by dataset name, as the library reads them.
    #[serde(default)]
    pub(crate) patch: HashMap<String, Box<RawValue>>,
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
    /// A transparent PNG of the picture's size drawn over this frame.
    pub(crate) overlay: Option<PathBuf>,
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

/// A frame's index, what it changes, and its patches by dataset.
pub(crate) type Next = (usize, Frame, Vec<(String, Patch)>);

/// The lines of a frames file, each a frame, with what reads their slices.
pub(crate) struct Frames {
    path: PathBuf,
    lines: io::Lines<Box<dyn BufRead>>,
    index: usize,
    files: Files,
}

impl Frames {
    pub(crate) fn open(path: &Path) -> Result<Frames, Failure> {
        let input: Box<dyn BufRead> = if is_stdio(path) {
            Box::new(BufReader::new(io::stdin()))
        } else {
            Box::new(BufReader::new(File::open(path).map_err(|e| Failure::io(&e, path))?))
        };
        Ok(Frames { path: path.to_path_buf(), lines: input.lines(), index: 0, files: Files::new(root(path)) })
    }

    /// The next frame, and its patches read; `None` at the end. Blank lines are skipped.
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
            let frame: Frame = serde_json::from_str(&line).map_err(|e| at(Error::invalid(e.to_string())))?;
            if frame.at.is_some_and(|a| !a.is_finite()) {
                return Err(at(Error::invalid("at is finite").at("at")));
            }
            let mut patches = Vec::with_capacity(frame.patch.len());
            for (name, json) in &frame.patch {
                let patch = Patch::from_json(json.get(), |file, range| self.files.read(file, range))
                    .map_err(|e| at(e.at(name.as_str()).at("patch")))?;
                patches.push((name.clone(), patch));
            }
            return Ok(Some((index, frame, patches)));
        }
    }

    /// Where the frames file's paths are relative to.
    pub(crate) fn root(&self) -> &Path {
        &self.files.root
    }
}

/// Slices of binary files, read relative to `root`, a few files kept open.
pub(crate) struct Files {
    root: PathBuf,
    open: Vec<(PathBuf, File)>,
}

impl Files {
    pub(crate) fn new(root: PathBuf) -> Files {
        Files { root, open: Vec::new() }
    }

    /// Bytes `range` of `file`, every one of them.
    pub(crate) fn read(&mut self, file: &str, range: Range<u64>) -> latkit::Result<Vec<u8>> {
        let path = self.root.join(file);
        let failed = |e: io::Error| Error::Load(format!("{}: {e}", path.display()).into());
        let at = if let Some(at) = self.open.iter().position(|(p, _)| *p == path) {
            at
        } else {
            if self.open.len() == OPEN {
                self.open.remove(0);
            }
            self.open.push((path.clone(), File::open(&path).map_err(failed)?));
            self.open.len() - 1
        };
        let open = &mut self.open[at].1;
        let length = open.metadata().map_err(failed)?.len();
        if range.end > length {
            return Err(Error::invalid(format!(
                "{}: the slice ends at byte {}, past its {length}",
                path.display(),
                range.end
            )));
        }
        let mut bytes =
            vec![0; usize::try_from(range.end - range.start).map_err(|_| Error::invalid("the slice is too long"))?];
        open.seek(SeekFrom::Start(range.start)).map_err(failed)?;
        open.read_exact(&mut bytes).map_err(failed)?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datasets_read_json_slices_bytes_and_geojson_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let floats: Vec<u8> = [9_f32, 1.25, -2.5].into_iter().flat_map(f32::to_le_bytes).collect();
        std::fs::write(dir.path().join("x.f32"), floats).unwrap();
        let doc = r#"{"name": "grid", "patch": [{"put": {"table": "Bus", "ids": ["b", "a"], "fields": {
            "x": {"file": "x.f32", "dtype": "f32le", "offset": 4, "count": 2}}}}]}"#;
        std::fs::write(dir.path().join("grid.json"), doc).unwrap();
        let source = |text: &str| -> Source { text.parse().unwrap() };
        let path = dir.path().join("grid.json").to_string_lossy().into_owned();
        let data = dataset(&source(&path)).unwrap();
        assert_eq!(data.table("Bus").unwrap().get("a", "x"), Some(latkit::Value::Number(-2.5)));
        let renamed = dataset(&source(&format!("other={path}"))).unwrap();
        assert_eq!(renamed.name().as_str(), "other");
        std::fs::write(dir.path().join("grid.bin"), data.to_bytes()).unwrap();
        let bytes = dataset(&source(&dir.path().join("grid.bin").to_string_lossy())).unwrap();
        assert_eq!(bytes.table("Bus").unwrap().len(), 2);
        let geo = r#"{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [1, 2]}}"#;
        std::fs::write(dir.path().join("p.geojson"), geo).unwrap();
        let geo_path = dir.path().join("p.geojson").to_string_lossy().into_owned();
        assert!(dataset(&source(&geo_path)).is_err(), "GeoJSON names its dataset");
        assert_eq!(dataset(&source(&format!("places={geo_path}"))).unwrap().table("points").unwrap().len(), 1);
        let mut files = Files::new(dir.path().into());
        assert!(files.read("x.f32", 8..16).is_err(), "past the end");
    }

    #[test]
    fn frames_apply_to_every_view_or_each() {
        let one: Each<f64> = serde_json::from_str("2").unwrap();
        let each: Each<f64> = serde_json::from_str("[null, 3]").unwrap();
        assert_eq!((one.of(0), one.of(5)), (Some(2.0), Some(2.0)));
        assert_eq!((each.of(0), each.of(1), each.of(2)), (None, Some(3.0), None));
        assert!(fit("all").is_ok() && fit(r#"{"bounds": {"min": [0, 0, 0], "max": [1, 1, 0]}}"#).is_ok());
    }
}
