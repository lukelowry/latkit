//! Text matches: for each `field.contains(text)` a mark uses, whether each row's text field
//! contains `text`, ignoring case. The results are boolean fields of a table beside the mark's own
//! table, which the GPU reads. Texts stay on the CPU, so matches are computed here, again only when
//! the field or the rows change. A page whose matches are unchanged keeps its column page, so only
//! changed pages upload.

use std::sync::Arc;

use super::{Derive, Input, Jobs, Tables, beside, kept};
use crate::data::{Field, Keyed, Name, Table, Values, Version};

/// The name of the derived field holding whether each row's text field `field` contains `text`,
/// ignoring case.
pub(crate) fn contains_of(field: &str, text: &str) -> Name {
    format!("{field}.contains({text})").into()
}

/// What a table's matches were made from: its structure version, and each field and text tested,
/// with the field's version.
type Made = (Version, Vec<(Name, Arc<str>, Option<Version>)>);

/// For each table, the distinct field and text pairs its marks test with `contains`, in mark order.
type Asked = Keyed<(Name, Name), Vec<(Name, Arc<str>)>>;

#[derive(Default)]
pub(crate) struct Matches {
    tables: Tables,
    made: Keyed<(Name, Name), Made>,
}

impl Derive for Matches {
    fn update(&mut self, input: &Input<'_>, _: &mut Jobs<'_>) -> bool {
        let mut asked = Asked::default();
        for mark in &input.scene.marks {
            let style = mark.style();
            let key = (style.data.clone(), style.table.clone());
            mark.for_each_expr(&mut |expr| {
                expr.for_each_contains(&mut |field, text| {
                    let fields = asked.entry(key.clone()).or_default();
                    if !fields.iter().any(|(f, t)| *f == field.name && **t == *text) {
                        fields.push((field.name.clone(), text.into()));
                    }
                });
            });
        }
        let mut changed = false;
        for (key, fields) in asked.iter() {
            let Some(table) = input.data(&key.0).and_then(|d| d.table(&key.1)) else { continue };
            let version = |f: &Name| table.field_named(f).map(Field::version);
            let made: Made =
                (table.structure, fields.iter().map(|(f, t)| (f.clone(), t.clone(), version(f))).collect());
            if self.made.get(key) == Some(&made) {
                continue;
            }
            let before = self.tables.get(key);
            let columns: Vec<(Name, Field)> = fields
                .iter()
                .map(|(field, text)| {
                    let name = contains_of(field, text);
                    let column = kept(&name, &holds(table, field, text), table, before);
                    (name, column)
                })
                .collect();
            self.tables.insert(key.clone(), beside(table, columns));
            self.made.insert(key.clone(), made);
            changed = true;
        }
        let before = self.tables.len();
        self.tables.retain(|key, _| asked.contains_key(key));
        self.made.retain(|key, _| asked.contains_key(key));
        changed || self.tables.len() != before
    }

    fn busy(&self) -> bool {
        false
    }

    fn tables(&self) -> &Tables {
        &self.tables
    }

    fn clear(&mut self) {
        self.tables.clear();
        self.made.clear();
    }
}

/// Whether each row of `table`'s text field `field` contains `text`, ignoring case. Missing
/// values, and fields that are missing or not text, match nothing. Reads page by page without
/// copying texts.
fn holds(table: &Table, field: &str, text: &str) -> Values {
    let needle = text.to_lowercase();
    let mut out = Vec::with_capacity(table.len());
    match table.field_named(field) {
        Some(Field::Values(column, _)) => {
            for page in column.pages() {
                let values = &page.values;
                match values.text() {
                    Some(texts) => out.extend(
                        texts.iter().enumerate().map(|(i, t)| values.is_valid(i) && crate::expr::holds(t, &needle)),
                    ),
                    None => out.extend(std::iter::repeat_n(false, values.len())),
                }
            }
        }
        _ => out.resize(table.len(), false),
    }
    out.resize(table.len(), false);
    Values::from(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Ids, Value};

    #[test]
    fn rows_contain_a_text_ignoring_case() {
        let names = vec![Some("Lake Travis"), None, Some("LAKE"), Some("Café")];
        let table = Table::new("Lake", Ids::count(4)).field("name", names);
        let rows =
            |values: Values| (0..values.len()).map(|i| values.get(i) == Some(Value::Bool(true))).collect::<Vec<_>>();
        assert_eq!(rows(holds(&table, "name", "lake")), [true, false, true, false]);
        assert_eq!(rows(holds(&table, "name", "CAFÉ")), [false, false, false, true], "beyond ASCII too");
        assert_eq!(rows(holds(&table, "absent", "x")), [false; 4]);
    }
}
