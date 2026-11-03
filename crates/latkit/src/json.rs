//! Reading inputs from JSON. Errors name the path to the part that could not be read, such as
//! `marks[2].color`.

use std::fmt::Display;

use serde::de::{Deserialize, DeserializeOwned, Deserializer};
use serde_path_to_error::Segment;

use crate::{Error, Path, Result, Step};

/// Deserializes JSON `text` as `T`, such as a scene, camera, fit, query, rows, budget, or shot.
/// Fails with [`Error::Invalid`], whose path names the part that could not be read.
///
/// ```
/// # #[cfg(feature = "gpu")] {
/// let scene: latkit::Scene = latkit::from_json(r#"{"space": "plane", "marks": []}"#)?;
/// let error = latkit::from_json::<latkit::Scene>(r#"{"space": "plane", "marks": [{"vertices": 3}]}"#);
/// assert!(error.unwrap_err().to_string().starts_with("marks[0]"));
/// # }
/// # Ok::<(), latkit::Error>(())
/// ```
pub fn from_json<T: DeserializeOwned>(text: &str) -> Result<T> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let value = read(&mut deserializer)?;
    deserializer.end().map_err(|e| Error::invalid(e.to_string()))?;
    Ok(value)
}

/// Deserializes JSON `bytes` as `T`, like [`from_json`]. Bytes that are not UTF-8 are invalid.
pub(crate) fn from_bytes<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    from_json(std::str::from_utf8(bytes).map_err(|e| Error::invalid(format!("not UTF-8: {e}")))?)
}

/// Deserializes `T` from `deserializer`. Errors name the path to the part that could not be read.
pub(crate) fn read<'de, T: Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<T>
where
    D::Error: Display,
{
    // A failed `nested` read leaves the path within its value. Clear one left by a read that did not
    // pass through here, such as a test's `serde_json::from_str`.
    WITHIN.take();
    let read = serde_path_to_error::deserialize(deserializer);
    let within = WITHIN.take();
    read.map_err(|error| {
        let steps = error.path().iter().filter_map(|segment| match segment {
            Segment::Seq { index } => Some(Step::Index(*index)),
            Segment::Map { key } => Some(Step::Name(key.as_str().into())),
            Segment::Enum { variant } => Some(Step::Name(variant.as_str().into())),
            Segment::Unknown => None,
        });
        let path = steps.chain(within.into_iter().flat_map(|path| path.0)).collect();
        Error::Invalid { path: Path(path), reason: unplaced(error.into_inner().to_string()).into() }
    })
}

/// `reason` without the position that `serde_json` appends, such as ` at line 1 column 42`. The path
/// already says where the error is.
fn unplaced(reason: String) -> String {
    let number = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
    match reason.rsplit_once(" at line ") {
        Some((before, place)) if place.split_once(" column ").is_some_and(|(l, c)| number(l) && number(c)) => {
            before.to_owned()
        }
        _ => reason,
    }
}

thread_local! {
    /// The path within a buffered value at which [`nested`] failed, for [`read`] to append to the
    /// path of the value itself.
    static WITHIN: std::cell::Cell<Option<Path>> = const { std::cell::Cell::new(None) };
}

/// Deserializes `T` from `value`, a buffered part of the input [`read`] is reading. Marks are
/// buffered, since the key naming a mark's kind may come after its options. An error's path
/// continues from the value's own path.
pub(crate) fn nested<T: DeserializeOwned, E: serde::de::Error>(value: serde_json::Value) -> std::result::Result<T, E> {
    read(value).map_err(|error| match error {
        Error::Invalid { path, reason } => {
            WITHIN.set(Some(path));
            E::custom(reason)
        }
        error => E::custom(error),
    })
}

/// Deserializes `T` from `value`, a buffered part of the input [`read`] is reading, leaving out each
/// part that can't be read. Returns the value and an error for each part left out, at its path.
/// `option` names the part to leave out for an error at a path, or `None` when the value can't be
/// read without it, which fails the whole value as [`nested`] does.
pub(crate) fn lenient<T: DeserializeOwned, E: serde::de::Error>(
    mut value: serde_json::Value,
    option: impl Fn(&Path) -> Option<Path>,
) -> std::result::Result<(T, Vec<Error>), E> {
    let mut unread = Vec::new();
    loop {
        match read::<T, _>(&value) {
            Ok(read) => return Ok((read, unread)),
            Err(Error::Invalid { path, reason }) => {
                if option(&path).is_none_or(|option| !take(&mut value, &option)) {
                    WITHIN.set(Some(path));
                    return Err(E::custom(reason));
                }
                unread.push(Error::Invalid { path, reason });
            }
            Err(error) => return Err(E::custom(error)),
        }
    }
}

/// Removes the part of `value` at `path`. Returns whether there was one.
fn take(value: &mut serde_json::Value, path: &Path) -> bool {
    use serde_json::Value;
    let Some((last, parents)) = path.0.split_last() else { return false };
    let mut at = value;
    for step in parents {
        let next = match (step, at) {
            (Step::Name(name), Value::Object(map)) => map.get_mut(name.as_str()),
            (Step::Index(i), Value::Array(items)) => items.get_mut(*i),
            _ => None,
        };
        let Some(next) = next else { return false };
        at = next;
    }
    match (last, at) {
        (Step::Name(name), Value::Object(map)) => map.shift_remove(name.as_str()).is_some(),
        (Step::Index(i), Value::Array(items)) if *i < items.len() => {
            items.remove(*i);
            true
        }
        _ => false,
    }
}

#[cfg(all(test, feature = "gpu"))]
mod tests {
    use crate::{Scene, from_json};

    #[test]
    fn errors_name_the_path_through_presets_and_marks() {
        // An option that can't be read is left out of the scene, and why is kept at its path.
        let unread = |json: &str| {
            let scene = from_json::<Scene>(json).expect("a scene");
            scene.unread.first().map(ToString::to_string).unwrap_or_default()
        };
        let grid = unread(r#"{"space": {"plane": {"grid": "bogus"}}, "marks": []}"#);
        assert!(grid.starts_with("space.plane.grid:"), "{grid}");
        let mark = unread(r#"{"space": "plane", "marks": [{"vertices": ["d", "t"], "colour": "x"}]}"#);
        assert!(mark.starts_with("marks[0].colour:") && !mark.contains(" at line "), "{mark}");
        // An option before the key naming the mark's kind still names its own path.
        let radius =
            unread(r#"{"space": "plane", "marks": [{"edges": ["d", "e"]}, {"radius": [1], "vertices": ["d", "t"]}]}"#);
        assert!(radius.starts_with("marks[1].radius"), "{radius}");
        // A mark that names no kind can't be read, so neither can the scene.
        let at = |json: &str| from_json::<Scene>(json).unwrap_err().to_string();
        let none = at(r#"{"space": "plane", "marks": [{"of": ["d", "t"]}]}"#);
        assert!(none.starts_with("marks[0]:") && none.contains("vertices"), "{none}");
        assert!(from_json::<Scene>(r#"{"space": "plane", "marks": []} trailing"#).is_err());
    }
}
