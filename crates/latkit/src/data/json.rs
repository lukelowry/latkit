//! Reading datasets and patches from latkit's binary format, GeoJSON, or JSON, detected from the
//! first bytes. The JSON format is documented on [`Patch::read`]; its serde forms are in
//! `forms.rs`. Slices of binary files are fetched through a host.

use serde::Deserialize;

use super::forms::{Column, DataForm, OpForm, patch};
use super::name::Name;
use super::ordered::Ordered;
use super::patch::Patch;
use super::snapshot::Snapshot;
use super::source::Data;
use crate::resource::{Fetch, Request};
use crate::{Error, Result};

/// Options for [`Data::read`] and [`Patch::read`]: the dataset's name, and the document's location
/// and the host that fetches the file slices it references.
#[derive(Clone, Copy, Default)]
pub struct Reading<'a> {
    /// The dataset's name. Required for GeoJSON. latkit's bytes and JSON documents carry their own
    /// name, which this overrides when set.
    pub name: Option<&'a str>,
    /// The document's own path or URL. Slice file paths resolve in its directory, unless it is
    /// empty or the file path is absolute.
    pub base: &'a str,
    /// Fetches the file slices a document references. Required when it references any.
    pub host: Option<&'a dyn Fetch>,
}

impl Patch {
    /// Reads a patch from `bytes`: either latkit's binary format, one frame as
    /// [`Patch::to_bytes`] writes it, or JSON, which any language can write without latkit. The
    /// JSON is a list of changes, each an object keyed by the [`Patch`] method that makes it, with
    /// that method's parameters by name.
    ///
    /// ```json
    /// [
    ///   {"replace": {"table": "Bus", "ids": [101, 205], "fields": {"x": [0, 10], "name": ["North", "South"]}}},
    ///   {"replace": {"table": "Branch", "ids": {"count": 1}, "fields": {"from": {"reference": "Bus", "ids": [101]}}}},
    ///   {"axis": {"name": "time", "unit": "s"}},
    ///   {"append": {"table": "Bus", "at": [0, 0.5], "fields": {"vm": {"file": "vm.f32", "dtype": "f32le", "count": 4}}}}
    /// ]
    /// ```
    ///
    /// - `replace` and `set` take `{table, ids, fields}`; `remove` takes `{table, ids}`; `append`
    ///   takes `{table, at, fields, ids?}`; `forget` takes `{before}`; `axis` takes
    ///   `{name, unit}`; and `frames` takes `{table, field, level?, first, at, values}`, as
    ///   [`Patch::frames`] does.
    /// - `ids` is `{"count": n}` for rows `0..n`, or a list of numbers or texts; `null` leaves a
    ///   reference unwired.
    /// - A field is an array of one kind of value, as [`Values`](crate::Values) accepts;
    ///   `{"reference": table, "ids": ids}`; or a slice of a binary file,
    ///   `{"file", "dtype", "offset", "count"}`: `count` values starting at byte `offset`
    ///   (default 0), with dtype `f32le`, `f64le`, `i32le`, `u32le`, `u64le`, `u8` (all read as
    ///   numbers), or `bool` (one byte each, nonzero meaning true).
    /// - `append`'s `at` is one axis coordinate or a list, as [`Patch::append`] takes.
    /// - Errors name the path to the part that could not be read, such as `[2].set.fields.x`.
    ///
    /// Slices are fetched through `reading.host`, all requests issued together, with paths
    /// relative to `reading.base`. Slices with no host are an
    /// [`Error::Unsupported`](crate::Error::Unsupported).
    ///
    /// ```no_run
    /// # async fn example(host: &impl latkit::resource::Fetch) -> latkit::Result<()> {
    /// use latkit::{Patch, Reading};
    /// let json = br#"[{"append": {"table": "Bus", "at": 0.5, "fields": {"vm": {"file": "vm.f32", "dtype": "f32le", "count": 3}}}}]"#;
    /// let patch = Patch::read(json, Reading { base: "data/grid.json", host: Some(host), ..Reading::default() }).await?; // reads data/vm.f32
    /// # Ok(()) }
    /// ```
    pub async fn read(bytes: &[u8], reading: Reading<'_>) -> Result<Patch> {
        if bytes.starts_with(b"LATK") {
            return Patch::from_bytes(bytes);
        }
        let ops: Vec<OpForm> = crate::from_json(text(bytes, "a patch must be latkit's bytes or JSON")?)?;
        build(ops, reading).await
    }
}

impl Data {
    /// Reads a dataset from `bytes`, detecting the format from the first bytes:
    ///
    /// - latkit's binary format, as [`Snapshot::to_bytes`] writes it;
    /// - GeoJSON, gzip-compressed or not: features become rows of tables `points`, `lines`, and
    ///   `polygons` by geometry type, with the geometry in field `geometry` and each property as a
    ///   field;
    /// - a JSON document `{"name": ..., "patch": [...]}`: the dataset's name and the patch that
    ///   builds it, read as [`Patch::read`] reads one.
    ///
    /// `reading.name` names the dataset and is required for GeoJSON. The other formats carry their
    /// own name, which `reading.name` overrides when set.
    ///
    /// ```
    /// # use latkit::{Data, Reading};
    /// let city = pollster::block_on(Data::read(
    ///     br#"{"type": "Feature", "properties": {"name": "Hall"}, "geometry": {"type": "Point", "coordinates": [-97.74, 30.27]}}"#,
    ///     Reading { name: Some("city"), ..Reading::default() },
    /// ))?;
    /// let points = city.snapshot().describe().tables.into_iter().find(|t| t.name == "points");
    /// assert_eq!(points.map(|t| t.rows), Some(1));
    /// # Ok::<(), latkit::Error>(())
    /// ```
    pub async fn read(bytes: &[u8], reading: Reading<'_>) -> Result<Data> {
        let read = if bytes.starts_with(b"LATK") {
            Snapshot::from_bytes(bytes)?
        } else if geojson(bytes) {
            let name = reading.name.ok_or_else(|| Error::invalid("GeoJSON needs a dataset name").at("name"))?;
            return crate::geo::geojson(name, bytes).map(Data::from);
        } else {
            let form: DataForm =
                crate::from_json(text(bytes, "a dataset must be latkit's bytes, GeoJSON, or a JSON document")?)?;
            if form.name.is_empty() {
                return Err(Error::invalid("a dataset needs a name").at("name"));
            }
            let patch = build(form.patch, reading).await.map_err(|e| e.at("patch"))?;
            Snapshot::new(form.name).applied(patch)?
        };
        Ok(Data::from(match reading.name {
            Some(name) if name != read.name().as_str() => read.renamed(name),
            _ => read,
        }))
    }
}

/// Whether `bytes` look like GeoJSON rather than latkit's binary format or a dataset document:
/// gzip-compressed, or a JSON object whose first key is neither `name` nor `patch`.
pub(crate) fn geojson(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return true;
    }
    let Some(object) = bytes.trim_ascii_start().strip_prefix(b"{") else { return false };
    let Some(key) = object.trim_ascii_start().strip_prefix(b"\"") else { return false };
    let key = key.split(|&b| b == b'"').next().unwrap_or_default();
    key != b"name" && key != b"patch"
}

/// `bytes` as JSON text: UTF-8 that opens an object or an array. Anything else, such as an HTML
/// page served in place of a missing file, is an error stating the `expected` format.
fn text<'a>(bytes: &'a [u8], expected: &'static str) -> Result<&'a str> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error::invalid(expected))?;
    match text.trim_start().as_bytes().first() {
        Some(b'{' | b'[') => Ok(text),
        _ => Err(Error::invalid(expected)),
    }
}

/// Patches keyed by dataset name, in the order written, such as one message of a stream of
/// changes: JSON `{"grid": [...], "weather": [...]}`, each patch in [`Patch::read`]'s JSON form.
#[derive(Default, Deserialize)]
pub struct Patches(Ordered<Vec<OpForm>>);

impl schemars::JsonSchema for Patches {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Patches".into()
    }

    fn json_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
        let mut schema = <Ordered<Vec<OpForm>>>::json_schema(generator);
        schema.insert("description".into(), "Patches by dataset name, in the order written.".into());
        schema
    }
}

impl Patches {
    /// Builds each dataset's patch, in order, fetching file slices through `reading.host` relative
    /// to `reading.base`.
    pub async fn read(self, reading: Reading<'_>) -> Result<Vec<(Name, Patch)>> {
        let mut patches = Vec::with_capacity(self.0.0.len());
        for (name, ops) in self.0.0 {
            let patch = build(ops, reading).await.map_err(|e| e.at(name.as_str()))?;
            patches.push((name, patch));
        }
        Ok(patches)
    }
}

/// Builds the patch for `ops`. Issues every file slice request through `reading.host` before
/// awaiting any, relative to `reading.base`, then builds each change in order.
async fn build(mut ops: Vec<OpForm>, reading: Reading<'_>) -> Result<Patch> {
    let mut slices: Vec<&mut Column> = ops
        .iter_mut()
        .flat_map(|op| op.columns().iter_mut().map(|(_, column)| column))
        .filter(|column| matches!(column, Column::Slice(_)))
        .collect();
    let fetching = match reading.host {
        Some(host) => slices
            .iter()
            .map(|column| {
                let Column::Slice(slice) = &**column else { unreachable!("slices only") };
                let range = slice.offset..slice.end()?;
                Ok(host.fetch(&Request::range(crate::url::resolve(reading.base, &slice.file), range)))
            })
            .collect::<Result<Vec<_>>>()?,
        None if slices.is_empty() => Vec::new(),
        None => return Err(Error::Unsupported("fetching a document's file slices needs a host".into())),
    };
    for (column, bytes) in slices.iter_mut().zip(fetching) {
        let Column::Slice(slice) = &**column else { unreachable!("slices only") };
        let values = slice.read(&bytes.await?)?;
        **column = Column::Values(values);
    }
    drop(slices);
    patch(ops)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::{Kind, Pending, Row, Value};

    /// A host serving files from memory and recording each request.
    #[derive(Default)]
    struct Files(HashMap<String, Vec<u8>>, std::sync::Mutex<Vec<Request>>);

    impl Fetch for Files {
        fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
            self.1.lock().unwrap().push(request.clone());
            let bytes = self.0.get(&*request.url).map_or_else(Vec::new, |bytes| {
                let range = request.range.clone().unwrap_or(0..bytes.len() as u64);
                bytes[range.start as usize..(range.end as usize).min(bytes.len())].to_vec()
            });
            Pending::ready(Ok(bytes))
        }
    }

    fn read_data(json: &str, host: &Files) -> Result<Data> {
        pollster::block_on(Data::read(
            json.as_bytes(),
            Reading { base: "docs/grid.json", host: Some(host), name: None },
        ))
    }

    #[test]
    fn a_dataset_reads_its_tables_references_and_geometry() {
        let json = r#"{"name": "grid", "patch": [
            {"replace": {"table": "Bus", "ids": ["b", "a"], "fields": {
                "x": [1.5, null], "on": [true, false], "name": ["B", null],
                "at": [[0, 1], [2, 3, 9]], "path": [[[0, 0], [1, 1]], []]}}},
            {"replace": {"table": "Branch", "ids": {"count": 1}, "fields": {"from": {"reference": "Bus", "ids": ["a"]}}}}
        ]}"#;
        let data = read_data(json, &Files::default()).unwrap().snapshot();
        let bus = |id: &str, field: &str| data.get("Bus", id, field, None);
        assert_eq!(bus("b", "x"), Some(Value::Number(1.5)));
        assert_eq!(bus("a", "x"), None);
        assert_eq!(bus("a", "on"), Some(Value::Bool(false)));
        assert_eq!(bus("b", "name"), Some(Value::Text("B".into())));
        assert_eq!(bus("a", "at"), Some(Value::Point([2.0, 3.0])));
        assert_eq!(bus("b", "path"), Some(Value::Path(vec![[0.0, 0.0], [1.0, 1.0]])));
        let kinds = data.describe().tables.into_iter().flat_map(|t| t.fields).find(|f| f.name == "path");
        assert_eq!(kinds.map(|f| f.kind), Some(Kind::Path));
        let target = Row { data: "grid".into(), table: "Bus".into(), id: "a".into() };
        assert_eq!(data.get("Branch", 0_u64, "from", None), Some(Value::Row(target)));
    }

    #[test]
    fn slices_fetch_together_relative_to_the_document_and_append_frames() {
        let floats: Vec<u8> = [9_f32, 1.0, 2.0, 3.0, 4.0].into_iter().flat_map(f32::to_le_bytes).collect();
        let host = Files([("docs/v.f32".to_owned(), floats)].into(), std::sync::Mutex::default());
        let json = r#"{"name": "grid", "patch": [
            {"replace": {"table": "Bus", "ids": {"count": 2}, "fields": {"kv": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 2}}}},
            {"axis": {"name": "time", "unit": "s"}},
            {"append": {"table": "Bus", "at": [0, 1], "fields": {"vm": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 4}}}},
            {"forget": {"before": -1}}
        ]}"#;
        let data = read_data(json, &host).unwrap().snapshot();
        let asked: Vec<Request> = host.1.lock().unwrap().clone();
        assert_eq!(asked, [Request::range("docs/v.f32", 4..12), Request::range("docs/v.f32", 4..20)]);
        assert_eq!(data.describe().span, Some([0.0, 1.0]));
        assert_eq!(data.get("Bus", 1_u64, "kv", None), Some(Value::Number(2.0)));
        assert_eq!(data.get("Bus", 1_u64, "vm", 1.0), Some(Value::Number(4.0)));
    }

    #[test]
    fn the_format_is_detected_from_the_first_bytes() {
        let bytes = br#"{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [1, 2]}}"#;
        assert!(geojson(bytes) && geojson(b" {\"features\": []}") && geojson(&[0x1f, 0x8b, 8]));
        assert!(!geojson(br#"{"name": "grid", "patch": []}"#) && !geojson(b"[]") && !geojson(b"LATK"));
        let named = |name| Reading { name, ..Reading::default() };
        let error = pollster::block_on(Data::read(bytes, named(None))).unwrap_err();
        assert_eq!(error.to_string(), "name: GeoJSON needs a dataset name");
        let read = pollster::block_on(Data::read(bytes, named(Some("city")))).unwrap();
        assert_eq!(read.name().as_str(), "city");
        let renamed = pollster::block_on(Data::read(&read.snapshot().to_bytes(), named(Some("town")))).unwrap();
        assert_eq!(renamed.snapshot().table("points").map(crate::Table::len), Some(1), "renaming keeps the tables");
        assert_eq!(renamed.name().as_str(), "town");
        // A page served in place of a missing file is none of them, and the error says what is read.
        let page = b"<!doctype html><html></html>";
        let error = pollster::block_on(Data::read(page, named(None))).unwrap_err().to_string();
        assert_eq!(error, "input: a dataset must be latkit's bytes, GeoJSON, or a JSON document");
        let error = pollster::block_on(Patch::read(page, Reading::default())).map(|_| ()).unwrap_err().to_string();
        assert_eq!(error, "input: a patch must be latkit's bytes or JSON");
    }

    #[test]
    fn errors_name_the_change_table_and_field() {
        let host = Files::default();
        let error = |json: &str| {
            let reading = Reading { host: Some(&host), ..Reading::default() };
            pollster::block_on(Patch::read(json.as_bytes(), reading)).map(|_| ()).unwrap_err().to_string()
        };
        let mixed = error(r#"[{"replace": {"table": "Bus", "ids": {"count": 2}, "fields": {"x": [1, "a"]}}}]"#);
        assert!(mixed.starts_with("[0].replace.fields.x: "), "{mixed}");
        assert!(error(r#"[{"bend": {}}]"#).contains("unknown variant"));
        let named = error(r#"[{"axis": {"name": "t", "unit": "s"}}, {"remove": {"table": 3, "ids": []}}]"#);
        assert!(named.starts_with("[1].remove.table"), "{named}");
        // Errors found after reading name the part the same way.
        let reference =
            error(r#"[{"append": {"table": "Bus", "at": 0, "fields": {"x": {"reference": "Other", "ids": [1]}}}}]"#);
        assert!(reference.starts_with("[0].append.fields.x: append records values"), "{reference}");
        assert!(
            error(
                r#"[{"replace": {"table": "Bus", "ids": {"count": 1}, "fields": {"x": {"file": "f", "count": 1}}}}]"#
            )
            .contains("dtype")
        );
        let missing = r#"[{"replace": {"table": "Bus", "ids": {"count": 1}, "fields": {"x": {"file": "f.bin", "dtype": "f64le", "count": 1}}}}]"#;
        assert_eq!(error(missing), "io: f.bin: read 0 of the slice's 8 bytes");
        let hostless = pollster::block_on(Patch::read(missing.as_bytes(), Reading::default()));
        assert!(matches!(hostless, Err(Error::Unsupported(_))), "a slice needs a host to fetch it");
        let invalid = read_data(
            r#"{"name": "grid", "patch": [{"replace": {"table": "Bus", "ids": [1, 1]}}]}"#,
            &Files::default(),
        );
        assert!(matches!(invalid, Err(Error::Invalid { path, .. }) if path.to_string().starts_with("patch[0]")));
    }
}
