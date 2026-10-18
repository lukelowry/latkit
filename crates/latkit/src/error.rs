use std::borrow::Cow;
use std::fmt;

use crate::Name;

/// Everything that can go wrong in latkit.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// An input does not fit what it describes; `path` names the part, such as `marks[2].color`.
    #[error("{path}: {reason}")]
    Invalid {
        /// Where in the input the problem is.
        path: Path,
        /// What is wrong there.
        reason: Cow<'static, str>,
    },
    /// The platform or device cannot do what was asked.
    #[error("unsupported: {0}")]
    Unsupported(Cow<'static, str>),
    /// A budget or device limit would be exceeded.
    #[error("over limit: {0}")]
    Limit(Cow<'static, str>),
    /// Fetching or decoding external bytes failed.
    #[error("load: {0}")]
    Load(Cow<'static, str>),
    /// The operation did not complete before its deadline.
    #[error("operation timed out")]
    Timeout,
    /// The GPU device was lost; create a new `Gpu`.
    #[error("GPU device lost")]
    DeviceLost,
    /// The owner of pending work was destroyed before it could answer.
    #[error("operation cancelled")]
    Cancelled,
}

/// A `Result` whose error is [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// An [`Error::Invalid`] at the root of the input.
    pub fn invalid(reason: impl Into<Cow<'static, str>>) -> Error {
        Error::Invalid { path: Path::default(), reason: reason.into() }
    }

    /// A short, stable name for the kind of error: `invalid`, `unsupported`, `limit`, `load`, or
    /// `device-lost`, `cancelled`, or `timeout`.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Invalid { .. } => "invalid",
            Error::Unsupported(_) => "unsupported",
            Error::Limit(_) => "limit",
            Error::Load(_) => "load",
            Error::DeviceLost => "device-lost",
            Error::Cancelled => "cancelled",
            Error::Timeout => "timeout",
        }
    }

    /// Prefixes the path of an [`Error::Invalid`] with `step`; other errors pass through.
    #[must_use]
    pub fn at(self, step: impl Into<Step>) -> Error {
        match self {
            Error::Invalid { mut path, reason } => {
                path.0.insert(0, step.into());
                Error::Invalid { path, reason }
            }
            other => other,
        }
    }
}

/// The error as `{ code, message, path? }`: the shape the npm package's `LatkitError` takes.
#[cfg(feature = "serde")]
impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        if let Error::Invalid { path, .. } = self {
            map.serialize_entry("path", &path.to_string())?;
        }
        map.end()
    }
}

/// Where in an input an [`Error::Invalid`] occurred.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Path(pub Vec<Step>);

/// One step of a [`Path`]: a named part or an index.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// A named part, such as a table, field, or option.
    Name(Name),
    /// An index into a list.
    Index(usize),
}

impl From<&str> for Step {
    fn from(name: &str) -> Step {
        Step::Name(name.into())
    }
}

impl From<&Name> for Step {
    fn from(name: &Name) -> Step {
        Step::Name(name.clone())
    }
}

impl From<Name> for Step {
    fn from(name: Name) -> Step {
        Step::Name(name)
    }
}

impl From<usize> for Step {
    fn from(index: usize) -> Step {
        Step::Index(index)
    }
}

impl fmt::Display for Path {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            return f.write_str("input");
        }
        for (i, step) in self.0.iter().enumerate() {
            match step {
                Step::Name(name) if i == 0 => write!(f, "{name}")?,
                Step::Name(name) => write!(f, ".{name}")?,
                Step::Index(index) => write!(f, "[{index}]")?,
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_read_like_access_expressions() {
        let error = Error::invalid("not a number").at("color").at(2).at("marks");
        assert_eq!(error.to_string(), "marks[2].color: not a number");
    }

    #[test]
    fn only_invalid_errors_take_steps() {
        assert_eq!(Error::DeviceLost.at("marks"), Error::DeviceLost);
    }
}
