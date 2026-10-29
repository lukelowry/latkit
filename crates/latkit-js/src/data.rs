//! Datasets: a `Data` changed in place, a `Snapshot` of one version, and the sources views draw.
//! `Data` and `Snapshot` share the same read methods: description, values, queries, envelopes, and
//! bytes.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

use latkit::host::Host as _;
use wasm_bindgen::prelude::*;

use crate::pending::{Task, task};
use crate::{Error, convert, json, to_json};

/// A dataset changed in place. Clones share it.
#[wasm_bindgen]
pub struct Data(pub(crate) latkit::Data);

#[wasm_bindgen]
impl Data {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> Data {
        Data(latkit::Data::new(name))
    }

    /// Reads the dataset in `bytes`, named `name` if given. `bytes` hold latkit bytes, GeoJSON
    /// (parsed in a worker, and only with a `name`), or a JSON document whose file slices are
    /// fetched relative to `base`.
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

    /// Applies the patch in `bytes`: every change, or none if any is invalid.
    pub fn apply(&self, bytes: &[u8]) -> Result<(), Error> {
        Ok(self.0.apply(latkit::Patch::from_bytes(bytes)?)?)
    }

    /// The current version, taken in O(1) and sharing every page.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        Snapshot(self.0.snapshot())
    }

    /// Makes `snapshot`, a version of this dataset, the current version.
    pub fn restore(&self, snapshot: &Snapshot) -> Result<(), Error> {
        Ok(self.0.restore(&snapshot.0)?)
    }

    /// A source for views that follows the dataset's changes.
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

    /// A source for views that draws this version unchanged.
    pub fn source(&self) -> Source {
        Source(latkit::Source::from(&self.0))
    }
}

impl Snapshot {
    fn version(&self) -> latkit::Snapshot {
        self.0.clone()
    }
}

/// Adds the read methods to each class that holds a dataset version.
macro_rules! reads {
    ($class:ident) => {
        #[wasm_bindgen]
        impl $class {
            /// The dataset's description, as JSON.
            pub fn describe(&self) -> String {
                to_json(&self.version().describe())
            }

            /// The value of `field` for the row `id` in `table`, at axis coordinate `at` if given,
            /// as JSON. `null` if missing.
            pub fn get(&self, table: &str, id: &JsValue, field: &str, at: Option<f64>) -> Result<String, Error> {
                Ok(to_json(&self.version().get(table, convert::id(id)?, field, at)))
            }

            /// The rows `query` (JSON) selects, as `{ table, ids, fields, total }`. Fields are in
            /// the forms a patch writes, and `total` counts the selected rows before paging.
            pub fn query(&self, query: &str) -> Result<JsValue, Error> {
                Ok(convert::query_result(&self.version().query(&json("query", query)?)?))
            }

            /// Each row's least and greatest value of a sampled field over equal spans of the axis,
            /// per `request` (JSON), as `{ at, least, greatest }`.
            pub fn envelope(&self, request: &str) -> Result<JsValue, Error> {
                let envelope = self.version().envelope(&json("request", request)?)?;
                Ok(convert::object(&[
                    ("at", js_sys::Float64Array::from(&envelope.at[..]).into()),
                    ("least", js_sys::Float32Array::from(&envelope.least[..]).into()),
                    ("greatest", js_sys::Float32Array::from(&envelope.greatest[..]).into()),
                ]))
            }

            /// The dataset as latkit bytes: the patch that recreates it.
            #[wasm_bindgen(js_name = toBytes)]
            pub fn to_bytes(&self) -> Vec<u8> {
                self.version().to_bytes()
            }
        }
    };
}

reads!(Data);
reads!(Snapshot);

/// A source a view draws a dataset from.
#[wasm_bindgen]
pub struct Source(pub(crate) latkit::Source);

#[wasm_bindgen]
impl Source {
    /// Tiles at `url`, drawn as dataset `name`. If given, `fetch(url, range)` fetches their files in
    /// place of the browser: `range` is `[start, end]` or undefined, and it returns a promise of a
    /// `Uint8Array`.
    pub fn tiles(name: &str, url: &str, fetch: Option<js_sys::Function>) -> Source {
        let tiles = latkit::Tiles::new(name, url);
        Source(latkit::Source::from(match fetch {
            Some(fetch) => tiles.fetch(fetcher(fetch)),
            None => tiles,
        }))
    }

    /// The same source, sharing what views fetched for it.
    #[must_use]
    pub fn copy(&self) -> Source {
        Source(self.0.clone())
    }

    /// Fetches the tiles' index again and redraws what changed.
    pub fn refresh(&self) {
        if let latkit::Source::Tiles(tiles) = &self.0 {
            tiles.refresh();
        }
    }
}

thread_local! {
    /// The page's tile fetch functions, by id. A tile fetch must be `Send`, so it holds only the id.
    static FETCHES: RefCell<HashMap<u32, js_sys::Function>> = RefCell::new(HashMap::new());
}

/// The id of a function in [`FETCHES`], removed when the tiles holding it are dropped.
struct Registered(u32);

impl Drop for Registered {
    fn drop(&mut self) {
        FETCHES.with(|all| all.borrow_mut().remove(&self.0));
    }
}

/// A tile fetch that calls the page's `fetch`.
fn fetcher(fetch: js_sys::Function) -> impl Fn(&latkit::host::Request) -> latkit::Pending<Vec<u8>> + Send + Sync {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    FETCHES.with(|all| all.borrow_mut().insert(id, fetch));
    let registered = Registered(id);
    move |request| {
        let range = request.range.as_ref().map_or(JsValue::UNDEFINED, |r| {
            js_sys::Array::of2(&(r.start as f64).into(), &(r.end as f64).into()).into()
        });
        let url = request.url.clone();
        let called = FETCHES.with(|all| all.borrow()[&registered.0].call2(&JsValue::NULL, &(*url).into(), &range));
        let failed = move |error: JsValue| {
            let message = js_sys::Reflect::get(&error, &"message".into()).ok().and_then(|m| m.as_string());
            latkit::Error::Io(format!("{url} could not be fetched: {}", message.unwrap_or_default()).into())
        };
        let (pending, resolver) = latkit::Pending::new();
        match called {
            Ok(promise) => wasm_bindgen_futures::spawn_local(async move {
                let bytes = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::from(promise)).await;
                resolver.resolve(bytes.map(|b| js_sys::Uint8Array::new(&b).to_vec()).map_err(failed));
            }),
            Err(error) => resolver.resolve(Err(failed(error))),
        }
        pending
    }
}

/// Reads the patch in `bytes`, as latkit bytes or JSON, and returns it as latkit bytes. File slices
/// are fetched relative to `base`.
#[wasm_bindgen(js_name = readPatch)]
pub fn read_patch(bytes: Vec<u8>, base: String) -> Task {
    task(async move {
        let reading = latkit::Reading { base: &base, host: Some(&latkit::host::Browser), name: None };
        let patch = latkit::Patch::read(&bytes, reading).await?;
        Ok(js_sys::Uint8Array::from(&patch.to_bytes()[..]))
    })
}
