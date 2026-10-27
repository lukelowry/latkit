use std::borrow::Borrow;
use std::fmt;
use std::hash::{Hash, Hasher};
use std::ops::Deref;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use rustc_hash::FxHashMap;

/// The name of a dataset, table, or field. Cheap to clone, and compared and ordered by its text.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct Name(Arc<str>);

/// A name's schema is a string.
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

/// A row's id within its table, either a number or a text. A number above 2^53 − 1 serializes as
/// decimal text, since JSON readers such as JavaScript's would round it. The text names the same
/// row.
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

    /// The id as a number that every JSON reader represents exactly, as it serializes. `None` for a
    /// text id or a number above 2^53 − 1.
    pub fn exact_number(&self) -> Option<f64> {
        match self {
            Id::Number(n) if *n <= SAFE => Some(*n as f64),
            _ => None,
        }
    }

    /// The id that a JSON or JavaScript number names, if it is a whole number from 0 to 2^53 − 1.
    /// `None` for any other number, which may already be rounded.
    pub fn from_number(number: f64) -> Option<Id> {
        (number.fract() == 0.0 && (0.0..=SAFE as f64).contains(&number)).then_some(Id::Number(number as u64))
    }
}

/// The largest whole number every JSON reader represents exactly.
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

/// One row, identified by dataset name, table name, and id. It stays valid across any change that
/// keeps those names and the id.
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

/// Rows of one table in a dataset, by id. Views use it for selections, fits, and the rows events
/// report.
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

    /// Groups `rows` into one set per dataset and table, in order of first appearance.
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
    /// Identifies the contents of one page. A written page gets a new id.
    PageId
);

impl PageId {
    /// A page id made from `digest`, a hash of the page's words, so pages with equal contents
    /// share one id. Its top bit is set, so it never equals a counter-assigned id.
    pub(crate) fn of_content(digest: u64) -> PageId {
        PageId(digest | 1 << 63)
    }
}

/// A map that keeps its entries in a `Vec` in insertion order, with a hash index from key to
/// position. The index type does not depend on `V`, so the hash map code is compiled once per key
/// type. Removing an entry moves the last entry into its position.
#[derive(Clone, Debug)]
pub(crate) struct Keyed<K, V> {
    index: FxHashMap<K, u32>,
    entries: Vec<(K, V)>,
}

/// Values by name.
pub(crate) type Named<V> = Keyed<Name, V>;

impl<K, V> Default for Keyed<K, V> {
    fn default() -> Keyed<K, V> {
        Keyed { index: FxHashMap::default(), entries: Vec::new() }
    }
}

impl<K: Hash + Eq + Clone, V> Keyed<K, V> {
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn at<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> Option<usize>
    where
        K: Borrow<Q>,
    {
        self.index.get(key).map(|&i| i as usize)
    }

    pub(crate) fn get<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.at(key).map(|i| &self.entries[i].1)
    }

    pub(crate) fn get_mut<Q: Hash + Eq + ?Sized>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
    {
        self.at(key).map(|i| &mut self.entries[i].1)
    }

    pub(crate) fn contains_key<Q: Hash + Eq + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.index.contains_key(key)
    }

    /// Sets `key`'s value, returning the one it replaced.
    pub(crate) fn insert(&mut self, key: K, value: V) -> Option<V> {
        if let Some(i) = self.at(&key) {
            return Some(std::mem::replace(&mut self.entries[i].1, value));
        }
        self.index.insert(key.clone(), self.entries.len() as u32);
        self.entries.push((key, value));
        None
    }

    pub(crate) fn remove<Q: Hash + Eq + ?Sized>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        let i = self.index.remove(key)? as usize;
        let (_, value) = self.entries.swap_remove(i);
        if let Some((moved, _)) = self.entries.get(i) {
            self.index.insert(moved.clone(), i as u32);
        }
        Some(value)
    }

    /// The entry for `key`, present or not.
    pub(crate) fn entry(&mut self, key: K) -> Entry<'_, K, V> {
        Entry { keyed: self, key }
    }

    /// Keeps the entries for which `keep` returns true, in their order.
    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&K, &mut V) -> bool) {
        let before = self.entries.len();
        self.entries.retain_mut(|(key, value)| keep(key, value));
        if self.entries.len() != before {
            self.index.clear();
            self.index.extend(self.entries.iter().zip(0..).map(|((key, _), i)| (key.clone(), i)));
        }
    }

    pub(crate) fn clear(&mut self) {
        self.index.clear();
        self.entries.clear();
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    pub(crate) fn iter_mut(&mut self) -> impl Iterator<Item = (&K, &mut V)> {
        self.entries.iter_mut().map(|(key, value)| (&*key, value))
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &K> {
        self.entries.iter().map(|(key, _)| key)
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, value)| value)
    }
}

impl<K: Hash + Eq + Clone, V> FromIterator<(K, V)> for Keyed<K, V> {
    fn from_iter<I: IntoIterator<Item = (K, V)>>(entries: I) -> Keyed<K, V> {
        let mut keyed = Keyed::default();
        keyed.extend(entries);
        keyed
    }
}

impl<K: Hash + Eq + Clone, V> Extend<(K, V)> for Keyed<K, V> {
    fn extend<I: IntoIterator<Item = (K, V)>>(&mut self, entries: I) {
        for (key, value) in entries {
            self.insert(key, value);
        }
    }
}

impl<K, V> IntoIterator for Keyed<K, V> {
    type Item = (K, V);
    type IntoIter = std::vec::IntoIter<(K, V)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

impl<'a, K, V> IntoIterator for &'a Keyed<K, V> {
    type Item = (&'a K, &'a V);
    type IntoIter = std::iter::Map<std::slice::Iter<'a, (K, V)>, fn(&'a (K, V)) -> (&'a K, &'a V)>;

    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter().map(|(key, value)| (key, value))
    }
}

/// The entry of a [`Keyed`] for one key, present or not.
pub(crate) struct Entry<'a, K, V> {
    keyed: &'a mut Keyed<K, V>,
    key: K,
}

impl<'a, K: Hash + Eq + Clone, V> Entry<'a, K, V> {
    /// The key's value, inserting `make()` if it has none.
    pub(crate) fn or_insert_with(self, make: impl FnOnce() -> V) -> &'a mut V {
        let Entry { keyed, key } = self;
        let i = keyed.at(&key).unwrap_or_else(|| {
            keyed.index.insert(key.clone(), keyed.entries.len() as u32);
            keyed.entries.push((key, make()));
            keyed.entries.len() - 1
        });
        &mut keyed.entries[i].1
    }

    pub(crate) fn or_insert(self, value: V) -> &'a mut V {
        self.or_insert_with(|| value)
    }

    pub(crate) fn or_default(self) -> &'a mut V
    where
        V: Default,
    {
        self.or_insert_with(V::default)
    }
}

impl<K: Hash + Eq + Clone + Borrow<Q>, Q: Hash + Eq + ?Sized, V> std::ops::Index<&Q> for Keyed<K, V> {
    type Output = V;

    fn index(&self, key: &Q) -> &V {
        self.get(key).expect("the key is present")
    }
}
