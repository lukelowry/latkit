//! Datasets: a `Data` changing in place, a `Snapshot` of one version, and the sources views draw.
//! Both read alike: what they hold described, values, queries, envelopes, and their bytes.

use latkit::host::Host as _;
use wasm_bindgen::prelude::*;

use crate::pending::{Task, task};
use crate::{Error, convert, json, to_json};

/// A dataset changing in place; clones share it.
#[wasm_bindgen]
pub struct Data(pub(crate) latkit::Data);

#[wasm_bindgen]
impl Data {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> Data {
        Data(latkit::Data::new(name))
    }

    /// The dataset `bytes` hold, named `name` when given: latkit's bytes; GeoJSON, read in a worker;
    /// or a document, its slices of files fetched relative to `base`.
    pub fn read(bytes: Vec<u8>, name: Option<String>, base: String) -> Task {
        task(async move {
            if let Some(name) = &name
                && let Some(job) = latkit::host::Job::geojson(name, &bytes)
            {
                let read = latkit::host::Browser.spawn(job).await?;
                if read.is_empty() {
                    return Err(latkit::Error::invalid(format!("{name}: the GeoJSON could not be read")));
                }
                let reading = latkit::Reading { name: Some(name), ..latkit::Reading::default() };
                return Ok(Data(latkit::Data::read(&read, reading).await?));
            }
            let reading = latkit::Reading { name: name.as_deref(), base: &base, host: Some(&latkit::host::Browser) };
            Ok(Data(latkit::Data::read(&bytes, reading).await?))
        })
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.0.name().to_string()
    }

    /// Applies the patch `bytes` hold: every change, or none when one is invalid.
    pub fn apply(&self, bytes: &[u8]) -> Result<(), Error> {
        Ok(self.0.apply(latkit::Patch::from_bytes(bytes)?)?)
    }

    /// The version it holds now: O(1), sharing every page.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        Snapshot(self.0.snapshot())
    }

    /// Makes `snapshot`, a version of this dataset, the one it holds.
    pub fn restore(&self, snapshot: &Snapshot) -> Result<(), Error> {
        Ok(self.0.restore(&snapshot.0)?)
    }

    /// The dataset as a source views draw as it changes.
    pub fn source(&self) -> Source {
        Source(latkit::Source::from(&self.0))
    }
}

impl Data {
    fn version(&self) -> latkit::Snapshot {
        self.0.snapshot()
    }
}

/// One version of a dataset.
#[wasm_bindgen]
pub struct Snapshot(pub(crate) latkit::Snapshot);

#[wasm_bindgen]
impl Snapshot {
    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.0.name().to_string()
    }

    /// The version as a source views draw as it is.
    pub fn source(&self) -> Source {
        Source(latkit::Source::from(&self.0))
    }
}

impl Snapshot {
    fn version(&self) -> latkit::Snapshot {
        self.0.clone()
    }
}

/// What reads a version of a dataset, on each class holding one.
macro_rules! reads {
    ($class:ident) => {
        #[wasm_bindgen]
        impl $class {
            /// What the dataset holds, as JSON.
            pub fn describe(&self) -> String {
                to_json(&self.version().describe())
            }

            /// The value of `field` for the row with `id` in `table`, at axis coordinate `at` when
            /// given, as JSON; `null` when missing.
            pub fn get(&self, table: &str, id: &JsValue, field: &str, at: Option<f64>) -> Result<String, Error> {
                Ok(to_json(&self.version().get(table, convert::id(id)?, field, at)))
            }

            /// The rows `query` (JSON) keeps, as `{ table, ids, fields, total }`: fields in the forms
            /// a patch writes, `total` the rows kept before paging.
            pub fn query(&self, query: &str) -> Result<JsValue, Error> {
                Ok(convert::query_result(&self.version().query(&json("query", query)?)?))
            }

            /// Each row's least and greatest value of a sampled field over equal spans of the axis, as
            /// `request` (JSON) asks, as `{ at, least, greatest }`.
            pub fn envelope(&self, request: &str) -> Result<JsValue, Error> {
                let envelope = self.version().envelope(&json("request", request)?)?;
                Ok(convert::object(&[
                    ("at", js_sys::Float64Array::from(&envelope.at[..]).into()),
                    ("least", js_sys::Float32Array::from(&envelope.least[..]).into()),
                    ("greatest", js_sys::Float32Array::from(&envelope.greatest[..]).into()),
                ]))
            }

            /// The dataset as latkit's bytes: the patch that builds it.
            #[wasm_bindgen(js_name = toBytes)]
            pub fn to_bytes(&self) -> Vec<u8> {
                self.version().to_bytes()
            }
        }
    };
}

reads!(Data);
reads!(Snapshot);

/// What a view draws a dataset from.
#[wasm_bindgen]
pub struct Source(pub(crate) latkit::Source);

#[wasm_bindgen]
impl Source {
    /// Tiles at `url`, drawn as dataset `name`.
    pub fn tiles(name: &str, url: &str) -> Source {
        Source(latkit::Source::from(latkit::Tiles::new(name, url)))
    }
}

/// The bytes of the patch `bytes` hold, latkit's or JSON, its slices of files fetched relative to
/// `base`.
#[wasm_bindgen(js_name = readPatch)]
pub fn read_patch(bytes: Vec<u8>, base: String) -> Task {
    task(async move {
        let reading = latkit::Reading { base: &base, host: Some(&latkit::host::Browser), name: None };
        let patch = latkit::Patch::read(&bytes, reading).await?;
        Ok(js_sys::Uint8Array::from(&patch.to_bytes()[..]))
    })
}
