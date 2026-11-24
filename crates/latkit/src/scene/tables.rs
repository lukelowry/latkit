//! Scene-local tables are resolved once, then drawn as an ordinary immutable snapshot.
use std::fmt;
use std::sync::{Arc, OnceLock};

use serde::de::{self, Deserializer, MapAccess, Visitor};
use serde_json::{Map, Value};

use crate::{Name, Result, Scene, Snapshot, Source, Table};

pub(super) fn schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let mut table = generator.subschema_for::<crate::data::LocalTable>();
    table.insert("description".into(), "The rows and fields of this table.".into());
    schemars::json_schema!({ "type": "object", "additionalProperties": table })
}

pub(super) const LOCAL: &str = "$scene";

#[derive(Clone, Default, Debug)]
pub(crate) struct Tables(Option<Arc<Entries>>);

#[derive(Clone, Default, Debug)]
struct Entries {
    tables: Vec<Table>,
    snapshot: OnceLock<Result<Snapshot>>,
}

impl Entries {
    fn snapshot(&self) -> Result<&Snapshot> {
        self.snapshot.get_or_init(|| Snapshot::from_tables(LOCAL, self.tables.clone())).as_ref().map_err(Clone::clone)
    }
}

impl PartialEq for Tables {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (None, None) => true,
            (Some(a), Some(b)) => {
                Arc::ptr_eq(a, b)
                    || (a.tables.len() == b.tables.len()
                        && matches!((a.snapshot(), b.snapshot()), (Ok(a), Ok(b))
                    if a.tables().zip(b.tables()).all(|(a, b)| a.same_columns(b))))
            }
            _ => false,
        }
    }
}

impl Tables {
    pub(super) fn push(&mut self, table: Table) {
        let entries = Arc::make_mut(self.0.get_or_insert_with(Arc::default));
        entries.snapshot.take();
        entries.tables.push(table);
    }

    pub(super) fn declare(&mut self) {
        self.0.get_or_insert_with(Arc::default);
    }

    fn snapshot(&self) -> Result<Option<&Snapshot>> {
        self.0.as_ref().map(|entries| entries.snapshot()).transpose()
    }
}

impl Scene {
    #[cfg(all(feature = "web", target_arch = "wasm32"))]
    pub(crate) fn with_columns(mut self, columns: Vec<Table>) -> Result<Scene> {
        for table in columns {
            self.tables.push(table);
        }
        self.tables.snapshot().map_err(|e| e.at("tables"))?;
        Ok(self)
    }

    /// Reuse the drawn snapshot when a newly authored scene repeats its columns.
    pub(crate) fn reuse_tables(&mut self, previous: &Scene) {
        if self.tables.0.is_some() && self.tables == previous.tables {
            self.tables.clone_from(&previous.tables);
            self.local.clone_from(&previous.local);
        }
    }

    /// Selects a dataset name disjoint from external references and sources, including sources
    /// whose names happen to start with "$scene". Every other renderer key stays as authored.
    pub(crate) fn bind_tables(&mut self, sources: &[Source], incoming: &[Source]) -> Result<()> {
        if self.tables.0.is_none() {
            return Ok(());
        }
        let result = self.tables.snapshot();
        let empty;
        let snapshot = if let Ok(Some(snapshot)) = &result {
            *snapshot
        } else {
            empty = Snapshot::new(LOCAL);
            &empty
        };
        let available = |name: &Name| {
            !sources.iter().chain(incoming).any(|s| s.name() == name)
                && !self.marks.iter().any(|m| {
                    if !m.style().local && m.style().data == *name {
                        return true;
                    }
                    let mut used = false;
                    m.for_each_expr(&mut |e| {
                        e.for_each_field(&mut |f| {
                            used |= f.from.as_ref().is_some_and(|(data, _)| data == name);
                        });
                    });
                    used
                })
        };
        let mut name = self.local.as_ref().unwrap_or(snapshot).name().clone();
        let mut suffix = 0;
        while !available(&name) {
            suffix += 1;
            name = format!("{LOCAL}{suffix}").into();
        }
        if self.local.as_ref().is_none_or(|s| *s.name() != name) {
            self.local = Some(if *snapshot.name() == name { snapshot.clone() } else { snapshot.renamed(&name) });
        }
        for mark in &mut self.marks {
            if mark.style().local {
                mark.style_mut().data = name.clone();
            }
        }
        result.map(|_| ()).map_err(|e| e.at("tables"))
    }
}

/// Keep bulk columns out of the small JSON object retried by the lenient style parser.
pub(super) fn read<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(Value, Tables), D::Error> {
    struct Document;
    impl<'de> Visitor<'de> for Document {
        type Value = (Value, Tables);
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a scene object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut options = Map::new();
            let mut tables = None;
            while let Some(key) = map.next_key::<String>()? {
                if key == "tables" {
                    if tables.is_some() {
                        return Err(de::Error::duplicate_field("tables"));
                    }
                    tables = Some(map.next_value::<Tables>()?);
                } else {
                    options.insert(key, map.next_value()?);
                }
            }
            Ok((Value::Object(options), tables.unwrap_or_default()))
        }
    }
    deserializer.deserialize_map(Document)
}

impl<'de> serde::Deserialize<'de> for Tables {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Declarations;
        impl<'de> Visitor<'de> for Declarations {
            type Value = Tables;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("tables by name")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Tables, A::Error> {
                let mut tables = Tables::default();
                while let Some(name) = map.next_key::<Name>()? {
                    let form = map.next_value::<crate::data::LocalTable>()?;
                    let table = form.build(name.clone()).map_err(|e| de::Error::custom(e.at(name)))?;
                    tables.push(table);
                }
                tables.snapshot().map_err(de::Error::custom)?;
                Ok(tables)
            }
        }
        deserializer.deserialize_map(Declarations)
    }
}
