//! Reading datasets and patches: latkit's bytes, GeoJSON, and JSON, as their first bytes say. The
//! JSON format is documented on [`Patch::read`], its forms in `forms.rs`; slices of binary files are
//! fetched through a host.

use serde::Deserialize;

use super::forms::{Column, DataForm, OpForm, patch};
use super::name::Name;
use super::ordered::Ordered;
use super::patch::Patch;
use super::snapshot::Snapshot;
use super::source::Data;
use crate::resource::{Fetch, Request};
use crate::{Error, Result};

/// How [`Data::read`] and [`Patch::read`] read what they are given: the name a dataset takes, and
/// where a JSON document lies, so its slices of files are fetched through `host` relative to it.
#[derive(Clone, Copy, Default)]
pub struct Reading<'a> {
    /// The name the dataset takes: GeoJSON needs one; latkit's bytes and documents name their own
    /// unless given one.
    pub name: Option<&'a str>,
    /// The document's own path or URL: a slice's file is relative to it, or as it is where it is
    /// empty or the file's is absolute.
    pub base: &'a str,
    /// What fetches a document's slices of files.
    pub host: Option<&'a dyn Fetch>,
}

impl Patch {
    /// The patch `bytes` hold: latkit's, one frame as [`Patch::to_bytes`] writes it, or its JSON,
    /// what any language writes without latkit. The JSON is a list of the changes [`Patch`]'s methods
    /// make, each named by its method with its parameters by name.
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
    /// - `replace` and `set` take `{table, ids, fields}`, `remove` `{table, ids}`, `append` `{table,
    ///   at, fields, ids?}`, `forget` `{before}`, `axis` `{name, unit}`, and `frames` `{table, field,
    ///   level?, first, at, values}`, as [`Patch::frames`] takes them.
    /// - `ids` is a count naming rows `0..n`, or numbers or texts; `null` leaves a reference unwired.
    /// - A field is an array of one kind of value, as [`Values`](crate::Values) takes them; `{"reference": table,
    ///   "ids": ids}`; or a slice of a binary file, `{"file", "dtype", "offset", "count"}`: `count`
    ///   values from byte `offset` (0 unless given) of dtype `f32le`, `f64le`, `i32le`, `u32le`,
    ///   `u64le`, `u8` (numbers), or `bool` (a byte each, nonzero true).
    /// - `append`'s `at` is one axis coordinate or several, as [`Patch::append`] takes them.
    /// - An error names the path to what could not be read, such as `[2].set.fields.x`.
    ///
    /// Slices are fetched through the reading's host, all at once, relative to its base.
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
        let ops: Vec<OpForm> = crate::from_json(text(bytes, "a patch is latkit's bytes or JSON")?)?;
        build(ops, reading).await
    }
}

impl Data {
    /// The dataset `bytes` hold, as their first bytes say:
    ///
    /// - latkit's own, as [`Snapshot::to_bytes`] writes them;
    /// - GeoJSON, gzip-compressed or not: its features become rows of tables `points`, `lines`, and
    ///   `polygons` by their geometry, each with its geometry as field `geometry` and its properties
    ///   as fields;
    /// - or its JSON document, `{"name": ..., "patch": [...]}`: its name and the patch that builds it,
    ///   read as [`Patch::read`] reads one.
    ///
    /// The reading's name names the dataset, as GeoJSON needs; latkit's bytes and documents name their
    /// own unless given one.
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
            let name = reading.name.ok_or_else(|| Error::invalid("GeoJSON names its dataset").at("name"))?;
            return crate::geo::geojson(name, bytes).map(Data::from);
        } else {
            let form: DataForm =
                crate::from_json(text(bytes, "a dataset is latkit's bytes, GeoJSON, or its JSON document")?)?;
            if form.name.is_empty() {
                return Err(Error::invalid("a dataset is named").at("name"));
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

/// Whether `bytes` hold GeoJSON rather than latkit's bytes or a dataset's document: gzip-compressed,
/// or a JSON object whose first member is not one of a document's, `name` or `patch`.
pub(crate) fn geojson(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0x1f, 0x8b]) {
        return true;
    }
    let Some(object) = bytes.trim_ascii_start().strip_prefix(b"{") else { return false };
    let Some(key) = object.trim_ascii_start().strip_prefix(b"\"") else { return false };
    let key = key.split(|&b| b == b'"').next().unwrap_or_default();
    key != b"name" && key != b"patch"
}

/// `bytes` as UTF-8 text, or an error saying what they should be.
fn text<'a>(bytes: &'a [u8], expected: &'static str) -> Result<&'a str> {
    std::str::from_utf8(bytes).map_err(|_| Error::invalid(expected))
}

/// Patches by dataset name, in the order written: what one step of a stream of changes carries, as
/// JSON `{"grid": [...], "weather": [...]}`, each patch in [`Patch::read`]'s form.
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
    /// Each dataset's patch, in order, their slices fetched through the reading's host relative to its
    /// base.
    pub async fn read(self, reading: Reading<'_>) -> Result<Vec<(Name, Patch)>> {
        let mut patches = Vec::with_capacity(self.0.0.len());
        for (name, ops) in self.0.0 {
            let patch = build(ops, reading).await.map_err(|e| e.at(name.as_str()))?;
            patches.push((name, patch));
        }
        Ok(patches)
    }
}

/// The patch `ops` make: their slices of files fetched through the reading's host at once, relative
/// to its base, then each change built in order.
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
        None => return Err(Error::Unsupported("a document's slices of files are fetched through a host".into())),
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

    /// A host fetching from files in memory, and counting what it fetched.
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
    fn slices_fetch_at_once_relative_to_the_document_and_append_frames() {
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
    fn what_bytes_hold_says_how_they_read() {
        let bytes = br#"{"type": "Feature", "properties": {}, "geometry": {"type": "Point", "coordinates": [1, 2]}}"#;
        assert!(geojson(bytes) && geojson(b" {\"features\": []}") && geojson(&[0x1f, 0x8b, 8]));
        assert!(!geojson(br#"{"name": "grid", "patch": []}"#) && !geojson(b"[]") && !geojson(b"LATK"));
        let named = |name| Reading { name, ..Reading::default() };
        let error = pollster::block_on(Data::read(bytes, named(None))).unwrap_err();
        assert_eq!(error.to_string(), "name: GeoJSON names its dataset");
        let read = pollster::block_on(Data::read(bytes, named(Some("city")))).unwrap();
        assert_eq!(read.name().as_str(), "city");
        let renamed = pollster::block_on(Data::read(&read.snapshot().to_bytes(), named(Some("town")))).unwrap();
        assert_eq!(renamed.snapshot().table("points").map(crate::Table::len), Some(1), "its tables, renamed");
        assert_eq!(renamed.name().as_str(), "town");
    }

    #[test]
    fn errors_name_the_change_table_and_field() {
        let host = Files::default();
        let error = |json: &str| {
            let reading = Reading { host: Some(&host), ..Reading::default() };
            pollster::block_on(Patch::read(json.as_bytes(), reading)).map(|_| ()).unwrap_err().to_string()
        };
        assert!(
            error(r#"[{"replace": {"table": "Bus", "ids": {"count": 2}, "fields": {"x": [1, "a"]}}}]"#)
                .contains("field x")
        );
        assert!(error(r#"[{"bend": {}}]"#).contains("unknown variant"));
        let named = error(r#"[{"axis": {"name": "t", "unit": "s"}}, {"remove": {"table": 3, "ids": []}}]"#);
        assert!(named.starts_with("[1].remove.table"), "{named}");
        assert!(
            error(
                r#"[{"replace": {"table": "Bus", "ids": {"count": 1}, "fields": {"x": {"file": "f", "count": 1}}}}]"#
            )
            .contains("dtype")
        );
        let missing = r#"[{"replace": {"table": "Bus", "ids": {"count": 1}, "fields": {"x": {"file": "f.bin", "dtype": "f64le", "count": 1}}}}]"#;
        assert_eq!(error(missing), "io: f.bin: 0 bytes of the slice's 8");
        let hostless = pollster::block_on(Patch::read(missing.as_bytes(), Reading::default()));
        assert!(matches!(hostless, Err(Error::Unsupported(_))), "a slice needs a host to fetch it");
        let invalid = read_data(
            r#"{"name": "grid", "patch": [{"replace": {"table": "Bus", "ids": [1, 1]}}]}"#,
            &Files::default(),
        );
        assert!(matches!(invalid, Err(Error::Invalid { path, .. }) if path.to_string().starts_with("patch[0]")));
    }
}
