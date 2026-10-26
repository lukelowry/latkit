//! Reading inputs from JSON. Errors name the path to the part that could not be read, such as
//! `marks[2].vertices.color`.

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

/// Deserializes `T` from `deserializer`. Errors name the path to the part that could not be read.
pub(crate) fn read<'de, T: Deserialize<'de>, D: Deserializer<'de>>(deserializer: D) -> Result<T>
where
    D::Error: Display,
{
    serde_path_to_error::deserialize(deserializer).map_err(|error| {
        let steps = error.path().iter().filter_map(|segment| match segment {
            Segment::Seq { index } => Some(Step::Index(*index)),
            Segment::Map { key } => Some(Step::Name(key.as_str().into())),
            Segment::Enum { variant } => Some(Step::Name(variant.as_str().into())),
            Segment::Unknown => None,
        });
        Error::Invalid { path: Path(steps.collect()), reason: error.into_inner().to_string().into() }
    })
}

#[cfg(all(test, feature = "gpu"))]
mod tests {
    use crate::{Scene, from_json};

    #[test]
    fn errors_name_the_path_through_presets_and_marks() {
        let at = |json: &str| from_json::<Scene>(json).unwrap_err().to_string();
        let grid = at(r#"{"space": {"plane": {"grid": "bogus"}}, "marks": []}"#);
        assert!(grid.starts_with("space.plane.grid:"), "{grid}");
        let mark = at(r#"{"space": "plane", "marks": [{"vertices": {"of": ["d", "t"], "colour": "x"}}]}"#);
        assert!(mark.starts_with("marks[0].vertices"), "{mark}");
        assert!(from_json::<Scene>(r#"{"space": "plane", "marks": []} trailing"#).is_err());
    }
}
