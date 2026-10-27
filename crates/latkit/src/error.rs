use std::borrow::Cow;
use std::fmt;

use crate::Name;

/// Everything that can go wrong in latkit.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// An input is invalid. `path` names the invalid part, such as `marks[2].vertices.color`.
    #[error("{path}: {reason}")]
    Invalid {
        /// Location of the problem in the input.
        path: Path,
        /// Why that part is invalid.
        reason: Cow<'static, str>,
    },
    /// The platform or device does not support the request.
    #[error("unsupported: {0}")]
    Unsupported(Cow<'static, str>),
    /// A budget or device limit would be exceeded.
    #[error("over limit: {0}")]
    Limit(Cow<'static, str>),
    /// Reading or writing external bytes failed, such as a fetch, file, worker, or encoder.
    #[error("io: {0}")]
    Io(Cow<'static, str>),
    /// The operation did not complete before its deadline.
    #[error("operation timed out")]
    Timeout,
    /// The GPU device was lost. Create a new `Gpu`.
    #[error("GPU device lost")]
    DeviceLost,
    /// The owner of pending work was dropped before the work finished.
    #[error("operation cancelled")]
    Cancelled,
}

/// A `Result` whose error is [`Error`].
pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    /// Every kind's [`code`](Error::code).
    const CODES: [&'static str; 7] = ["invalid", "unsupported", "limit", "io", "device-lost", "cancelled", "timeout"];

    /// An [`Error::Invalid`] at the root of the input.
    pub fn invalid(reason: impl Into<Cow<'static, str>>) -> Error {
        Error::Invalid { path: Path::default(), reason: reason.into() }
    }

    /// A short, stable name for the kind of error: `invalid`, `unsupported`, `limit`, `io`,
    /// `device-lost`, `cancelled`, or `timeout`.
    pub fn code(&self) -> &'static str {
        match self {
            Error::Invalid { .. } => "invalid",
            Error::Unsupported(_) => "unsupported",
            Error::Limit(_) => "limit",
            Error::Io(_) => "io",
            Error::DeviceLost => "device-lost",
            Error::Cancelled => "cancelled",
            Error::Timeout => "timeout",
        }
    }

    /// Prefixes the path of an [`Error::Invalid`] with `step`. Returns other errors unchanged.
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

    /// This error, of the same kind, naming `source` as where it happened: the first step of an
    /// invalid input's path, or the start of another error's message.
    #[cfg(feature = "gpu")]
    #[must_use]
    pub(crate) fn within(self, source: &str) -> Error {
        let named = |message: Cow<'static, str>| Cow::Owned(format!("{source}: {message}"));
        match self {
            Error::Invalid { .. } => self.at(source),
            Error::Unsupported(message) => Error::Unsupported(named(message)),
            Error::Limit(message) => Error::Limit(named(message)),
            Error::Io(message) => Error::Io(named(message)),
            other => other,
        }
    }
}

/// Serializes as `{ code, message, path? }`, the shape of the npm package's `LatkitError`.
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

/// Schema of the serialized error, named `Failure`.
impl schemars::JsonSchema for Error {
    fn schema_name() -> Cow<'static, str> {
        "Failure".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "What failed, as JSON: the form of the npm package's `LatkitError`.",
            "type": "object",
            "properties": {
                "code": {
                    "description": "The kind of failure, as `LatkitError.code` describes it.",
                    "enum": Error::CODES,
                },
                "message": { "description": "What failed, in words.", "type": "string" },
                "path": {
                    "description": "The invalid part of the input, such as `marks[2].vertices.color`, on `invalid` failures.",
                    "type": "string",
                },
            },
            "required": ["code", "message"],
        })
    }
}

/// Where in an input an [`Error::Invalid`] occurred.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Path(pub Vec<Step>);

/// One step of a [`Path`]: a named part or a list index.
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

    #[test]
    fn the_schema_lists_every_code() {
        let every = [
            Error::invalid(""),
            Error::Unsupported("".into()),
            Error::Limit("".into()),
            Error::Io("".into()),
            Error::DeviceLost,
            Error::Cancelled,
            Error::Timeout,
        ];
        assert_eq!(every.map(|e| e.code()), Error::CODES);
    }
}
