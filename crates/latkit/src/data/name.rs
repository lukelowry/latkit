use std::borrow::Borrow;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// The name of a dataset, table, or field: cheap to clone, compared and ordered by its text.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Name(Arc<str>);

/// A name is a text.
impl schemars::JsonSchema for Name {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Name".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "string" })
    }
}

impl Name {
    /// The name's text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Deref for Name {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl Borrow<str> for Name {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for Name {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<&str> for Name {
    fn from(name: &str) -> Name {
        Name(name.into())
    }
}

impl From<String> for Name {
    fn from(name: String) -> Name {
        Name(name.into())
    }
}

impl From<&String> for Name {
    fn from(name: &String) -> Name {
        Name(name.as_str().into())
    }
}

impl From<&Name> for Name {
    fn from(name: &Name) -> Name {
        name.clone()
    }
}

impl From<Arc<str>> for Name {
    fn from(name: Arc<str>) -> Name {
        Name(name)
    }
}

impl PartialEq<str> for Name {
    fn eq(&self, other: &str) -> bool {
        &*self.0 == other
    }
}

impl PartialEq<&str> for Name {
    fn eq(&self, other: &&str) -> bool {
        &*self.0 == *other
    }
}

impl fmt::Display for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for Name {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&*self.0, f)
    }
}

/// A row's identity within its table: a number or a text. A number above 2^53 − 1 serializes as
/// decimal text, which names the same row, since JSON readers such as JavaScript's round it.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Id {
    /// A numeric id.
    Number(u64),
    /// A text id.
    Text(Arc<str>),
}

impl Id {
    pub(crate) fn as_ref(&self) -> IdRef<'_> {
        match self {
            Id::Number(n) => IdRef::Number(*n),
            Id::Text(t) => IdRef::Text(t),
        }
    }
}

/// The largest whole number every JSON reader holds exactly.
const SAFE: u64 = (1 << 53) - 1;

impl serde::Serialize for Id {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Id::Number(n) if *n <= SAFE => serializer.serialize_u64(*n),
            Id::Number(n) => serializer.collect_str(n),
            Id::Text(t) => serializer.serialize_str(t),
        }
    }
}

impl Hash for Id {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.as_ref().hash(state);
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Id::Number(n) => write!(f, "{n}"),
            Id::Text(t) => f.write_str(t),
        }
    }
}

impl fmt::Debug for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Id::Number(n) => write!(f, "{n}"),
            Id::Text(t) => write!(f, "{t:?}"),
        }
    }
}

macro_rules! number_ids {
    ($($t:ty),*) => {$(
        impl From<$t> for Id {
            fn from(n: $t) -> Id {
                Id::Number(u64::from(n))
            }
        }
    )*};
}

number_ids!(u32, u16, u8);

impl From<u64> for Id {
    fn from(n: u64) -> Id {
        Id::Number(n)
    }
}

impl From<usize> for Id {
    fn from(n: usize) -> Id {
        Id::Number(n as u64)
    }
}

impl From<&str> for Id {
    fn from(text: &str) -> Id {
        Id::Text(text.into())
    }
}

impl From<String> for Id {
    fn from(text: String) -> Id {
        Id::Text(text.into())
    }
}

impl From<Arc<str>> for Id {
    fn from(text: Arc<str>) -> Id {
        Id::Text(text)
    }
}

/// A borrowed [`Id`], for lookups that must not allocate.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum IdRef<'a> {
    Number(u64),
    Text(&'a str),
}

impl IdRef<'_> {
    pub(crate) fn to_id(self) -> Id {
        match self {
            IdRef::Number(n) => Id::Number(n),
            IdRef::Text(t) => Id::Text(t.into()),
        }
    }
}

/// A row of a table in a dataset. It survives any change that keeps the names and the id.
#[derive(
    Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
pub struct Row {
    /// The dataset's name.
    pub data: Name,
    /// The table's name.
    pub table: Name,
    /// The row's id in the table.
    pub id: Id,
}

impl Row {
    /// The row with `id` in `table` of `data`.
    pub fn new(data: impl Into<Name>, table: impl Into<Name>, id: impl Into<Id>) -> Row {
        Row { data: data.into(), table: table.into(), id: id.into() }
    }
}

/// Rows of one table in a dataset, by id: what a view selects, fits, and tells as sets of rows.
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
pub struct Rows {
    /// The dataset's name.
    pub data: Name,
    /// The table's name.
    pub table: Name,
    /// The rows' ids in the table.
    pub ids: Vec<Id>,
}

impl Rows {
    /// The rows with `ids` in `table` of `data`.
    pub fn new<I: Into<Id>>(data: impl Into<Name>, table: impl Into<Name>, ids: impl IntoIterator<Item = I>) -> Rows {
        Rows { data: data.into(), table: table.into(), ids: ids.into_iter().map(Into::into).collect() }
    }

    /// Each row, in order.
    pub fn rows(&self) -> impl Iterator<Item = Row> + '_ {
        self.ids.iter().map(|id| Row { data: self.data.clone(), table: self.table.clone(), id: id.clone() })
    }

    /// `rows` as sets of rows, a set per table in the order each first appears.
    pub(crate) fn group(rows: impl IntoIterator<Item = Row>) -> Vec<Rows> {
        let mut sets: Vec<Rows> = Vec::new();
        for Row { data, table, id } in rows {
            match sets.iter_mut().rev().find(|s| s.data == data && s.table == table) {
                Some(set) => set.ids.push(id),
                None => sets.push(Rows { data, table, ids: vec![id] }),
            }
        }
        sets
    }

    /// Every row of `sets`, in order.
    pub(crate) fn flatten(sets: impl IntoIterator<Item = Rows>) -> Vec<Row> {
        sets.into_iter().flat_map(|set| set.rows().collect::<Vec<_>>()).collect()
    }
}

impl From<Row> for Rows {
    fn from(row: Row) -> Rows {
        Rows { data: row.data, table: row.table, ids: vec![row.id] }
    }
}

macro_rules! counter {
    ($($(#[$doc:meta])* $t:ident),*) => {$(
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
        pub(crate) struct $t(u64);

        impl $t {
            pub(crate) fn next() -> $t {
                static NEXT: AtomicU64 = AtomicU64::new(1);
                $t(NEXT.fetch_add(1, Ordering::Relaxed))
            }
        }
    )*};
}

counter!(
    /// Identifies one state of something that changes: a dataset, a table's rows, or a field.
    Version,
    /// Identifies the contents of one page; a written page gets a new id.
    PageId
);
