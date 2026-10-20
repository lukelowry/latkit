//! Datasets and patches as JSON: the format is documented on [`Patch::load`], its forms in
//! `forms.rs`; slices of binary files are fetched through a host.

use serde::Deserialize;

use super::dataset::Data;
use super::forms::{Column, DataForm, OpForm, patch};
use super::name::Name;
use super::ordered::Ordered;
use super::patch::Patch;
use crate::host::{Host, Request};
use crate::{Error, Result};

impl Patch {
    /// A patch from its JSON: what any language writes without latkit. The patch is a list of the
    /// changes [`Patch`]'s methods make, each named by its method with its parameters by name.
    ///
    /// ```json
    /// [
    ///   {"replace": {"table": "Bus", "ids": [101, 205], "fields": {"x": [0, 10], "name": ["North", "South"]}}},
    ///   {"replace": {"table": "Branch", "ids": {"count": 1}, "fields": {"from": {"reference": "Bus", "ids": [101]}}}},
    ///   {"axis": {"name": "time", "unit": "s"}},
    ///   {"append": {"at": [0, 0.5], "table": "Bus", "fields": {"vm": {"file": "vm.f32", "dtype": "f32le", "count": 4}}}}
    /// ]
    /// ```
    ///
    /// - `put` and `set` take `{table, ids, fields}`, `remove` `{table, ids}`, `append` `{at, table,
    ///   fields}`, `forget` `{before}`, and `axis` `{name, unit}`.
    /// - `ids` is a count naming rows `0..n`, or numbers or texts; `null` leaves a reference unwired.
    /// - A field is an array of one kind of value, as [`Values`](crate::Values) takes them; `{"reference": table,
    ///   "ids": ids}`; or a slice of a binary file, `{"file", "dtype", "offset", "count"}`: `count`
    ///   values from byte `offset` (0 unless given) of dtype `f32le`, `f64le`, `i32le`, `u32le`,
    ///   `u64le`, or `u8` (booleans, nonzero true).
    /// - `append`'s `at` is one axis coordinate or several, as [`Patch::append`] takes them.
    ///
    /// Slices are fetched through `host`, all at once: a file's path or URL relative to `base`, the
    /// document's own, or as it is when `base` is empty or the file's is absolute.
    ///
    /// ```no_run
    /// # async fn example(host: &dyn latkit::host::Host) -> latkit::Result<()> {
    /// let json = r#"[{"append": {"at": 0.5, "table": "Bus", "fields": {"vm": {"file": "vm.f32", "dtype": "f32le", "count": 3}}}}]"#;
    /// let patch = latkit::Patch::load(json, "data/grid.json", host).await?; // reads data/vm.f32
    /// # Ok(()) }
    /// ```
    pub async fn load(json: &str, base: &str, host: &dyn Host) -> Result<Patch> {
        let ops: Vec<OpForm> = serde_json::from_str(json).map_err(|e| Error::invalid(e.to_string()))?;
        build(ops, base, host).await
    }
}

impl Data {
    /// A dataset from its JSON, `{"name": ..., "patch": [...]}`: its name and the patch that builds it,
    /// as its bytes are. The patch loads as [`Patch::load`] loads one.
    pub async fn load(json: &str, base: &str, host: &dyn Host) -> Result<Data> {
        let form: DataForm = serde_json::from_str(json).map_err(|e| Error::invalid(e.to_string()))?;
        if form.name.is_empty() {
            return Err(Error::invalid("a dataset is named").at("name"));
        }
        let patch = build(form.patch, base, host).await.map_err(|e| e.at("patch"))?;
        let mut data = Data::new(form.name);
        data.apply(patch)?;
        Ok(data)
    }
}

/// Patches by dataset name, in the order written: what one step of a stream of changes carries, as
/// JSON `{"grid": [...], "weather": [...]}`, each patch in [`Patch::load`]'s form.
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
    /// Each dataset's patch, in order, their slices fetched through `host` relative to `base`.
    pub async fn load(self, base: &str, host: &dyn Host) -> Result<Vec<(Name, Patch)>> {
        let mut patches = Vec::with_capacity(self.0.0.len());
        for (name, ops) in self.0.0 {
            let patch = build(ops, base, host).await.map_err(|e| e.at(name.as_str()))?;
            patches.push((name, patch));
        }
        Ok(patches)
    }
}

/// The patch `ops` make: their slices of files fetched through `host` at once, relative to `base`,
/// then each change built in order.
async fn build(mut ops: Vec<OpForm>, base: &str, host: &dyn Host) -> Result<Patch> {
    let mut slices: Vec<&mut Column> = ops
        .iter_mut()
        .flat_map(|op| op.columns().iter_mut().map(|(_, column)| column))
        .filter(|column| matches!(column, Column::Slice(_)))
        .collect();
    let fetching = slices
        .iter()
        .map(|column| {
            let Column::Slice(slice) = &**column else { unreachable!("slices only") };
            Ok(host.fetch(&Request::range(resolve(base, &slice.file), slice.offset..slice.end()?)))
        })
        .collect::<Result<Vec<_>>>()?;
    for (column, bytes) in slices.iter_mut().zip(fetching) {
        let Column::Slice(slice) = &**column else { unreachable!("slices only") };
        let values = slice.read(&bytes.await?)?;
        **column = Column::Values(values);
    }
    drop(slices);
    patch(ops)
}

/// `file` relative to `base`, a document's path or URL: in its directory unless absolute.
fn resolve(base: &str, file: &str) -> String {
    let absolute = file.contains("://") || file.starts_with(['/', '\\']) || file.as_bytes().get(1) == Some(&b':');
    match base.rfind(['/', '\\']) {
        Some(at) if !absolute => format!("{}{file}", &base[..=at]),
        _ => file.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::host::{Raster, TextRun};
    use crate::{Kind, Pending, Row, Value};

    /// A host fetching from files in memory, and counting what it fetched.
    #[derive(Default)]
    struct Files(HashMap<String, Vec<u8>>, std::sync::Mutex<Vec<Request>>);

    impl Host for Files {
        fn rasterize(&self, _: &TextRun) -> Result<Raster> {
            Err(Error::Unsupported("no text".into()))
        }

        fn fetch(&self, request: &Request) -> Pending<Vec<u8>> {
            self.1.lock().unwrap().push(request.clone());
            let bytes = self.0.get(&*request.url).map_or_else(Vec::new, |bytes| {
                let range = request.range.clone().unwrap_or(0..bytes.len() as u64);
                bytes[range.start as usize..(range.end as usize).min(bytes.len())].to_vec()
            });
            Pending::ready(Ok(bytes))
        }
    }

    fn load_data(json: &str, host: &Files) -> Result<Data> {
        pollster::block_on(Data::load(json, "docs/grid.json", host))
    }

    #[test]
    fn a_dataset_reads_its_tables_references_and_geometry() {
        let json = r#"{"name": "grid", "patch": [
            {"replace": {"table": "Bus", "ids": ["b", "a"], "fields": {
                "x": [1.5, null], "on": [true, false], "name": ["B", null],
                "at": [[0, 1], [2, 3, 9]], "path": [[[0, 0], [1, 1]], []]}}},
            {"replace": {"table": "Branch", "ids": {"count": 1}, "fields": {"from": {"reference": "Bus", "ids": ["a"]}}}}
        ]}"#;
        let data = load_data(json, &Files::default()).unwrap();
        let bus = data.table("Bus").unwrap();
        assert_eq!(bus.get("b", "x"), Some(Value::Number(1.5)));
        assert_eq!(bus.get("a", "x"), None);
        assert_eq!(bus.get("a", "on"), Some(Value::Bool(false)));
        assert_eq!(bus.get("b", "name"), Some(Value::Text("B".into())));
        assert_eq!(bus.get("a", "at"), Some(Value::Point([2.0, 3.0])));
        assert_eq!(bus.kind("path"), Some(Kind::Path));
        assert_eq!(bus.get("b", "path"), Some(Value::Path(vec![[0.0, 0.0], [1.0, 1.0]])));
        let row = Row { data: "grid".into(), table: "Branch".into(), id: 0_u64.into() };
        let target = Row { data: "grid".into(), table: "Bus".into(), id: "a".into() };
        assert_eq!(data.get(&row, "from"), Some(Value::Row(target)));
    }

    #[test]
    fn slices_fetch_at_once_relative_to_the_document_and_append_frames() {
        let floats: Vec<u8> = [9_f32, 1.0, 2.0, 3.0, 4.0].into_iter().flat_map(f32::to_le_bytes).collect();
        let host = Files([("docs/v.f32".to_owned(), floats)].into(), std::sync::Mutex::default());
        let json = r#"{"name": "grid", "patch": [
            {"replace": {"table": "Bus", "ids": {"count": 2}, "fields": {"kv": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 2}}}},
            {"axis": {"name": "time", "unit": "s"}},
            {"append": {"at": [0, 1], "table": "Bus", "fields": {"vm": {"file": "v.f32", "dtype": "f32le", "offset": 4, "count": 4}}}},
            {"forget": {"before": -1}}
        ]}"#;
        let data = load_data(json, &host).unwrap();
        let asked: Vec<Request> = host.1.lock().unwrap().clone();
        assert_eq!(asked, [Request::range("docs/v.f32", 4..12), Request::range("docs/v.f32", 4..20)]);
        assert_eq!(data.span(), Some([0.0, 1.0]));
        let row = |id: u64| Row { data: "grid".into(), table: "Bus".into(), id: id.into() };
        assert_eq!(data.get(&row(1), "kv"), Some(Value::Number(2.0)));
        assert_eq!(data.get_at(&row(1), "vm", 1.0), Some(Value::Number(4.0)));
        assert_eq!(resolve("https://x/data/grid.json", "v.f32"), "https://x/data/v.f32");
        assert_eq!(resolve("C:\\data\\grid.json", "D:\\v.f32"), "D:\\v.f32");
        assert_eq!(resolve("", "v.f32"), "v.f32");
    }

    #[test]
    fn errors_name_the_change_table_and_field() {
        let error = |json: &str| {
            pollster::block_on(Patch::load(json, "", &Files::default())).map(|_| ()).unwrap_err().to_string()
        };
        assert!(
            error(r#"[{"replace": {"table": "Bus", "ids": {"count": 2}, "fields": {"x": [1, "a"]}}}]"#)
                .contains("field x")
        );
        assert!(error(r#"[{"bend": {}}]"#).contains("unknown variant"));
        assert!(
            error(
                r#"[{"replace": {"table": "Bus", "ids": {"count": 1}, "fields": {"x": {"file": "f", "count": 1}}}}]"#
            )
            .contains("dtype")
        );
        let missing = r#"[{"replace": {"table": "Bus", "ids": {"count": 1}, "fields": {"x": {"file": "f.bin", "dtype": "f64le", "count": 1}}}}]"#;
        assert_eq!(error(missing), "io: f.bin: 0 bytes of the slice's 8");
        let invalid = load_data(
            r#"{"name": "grid", "patch": [{"replace": {"table": "Bus", "ids": [1, 1]}}]}"#,
            &Files::default(),
        );
        assert!(matches!(invalid, Err(Error::Invalid { path, .. }) if path.to_string().starts_with("patch[0]")));
    }
}
