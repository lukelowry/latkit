//! Errors as JavaScript throws them: an `Error` with latkit's message, its `code` (`invalid`,
//! `unsupported`, `limit`, `io`, `device-lost`, `cancelled`, or `timeout`), and for invalid input the
//! `path` to the part.

use js_sys::Reflect;
use wasm_bindgen::JsValue;

/// A latkit error, thrown as a JavaScript `Error`.
pub struct Error(JsValue);

impl From<latkit::Error> for Error {
    fn from(error: latkit::Error) -> Error {
        let thrown = js_sys::Error::new(&error.to_string());
        let _ = Reflect::set(&thrown, &"code".into(), &error.code().into());
        if let latkit::Error::Invalid { path, .. } = &error {
            let _ = Reflect::set(&thrown, &"path".into(), &path.to_string().into());
        }
        Error(thrown.into())
    }
}

impl From<Error> for JsValue {
    fn from(error: Error) -> JsValue {
        error.0
    }
}
