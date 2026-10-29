//! Compiles marks against dataset schemas, for both validation and views.

use std::sync::Arc;

use super::mark::{Context, Drawing};
use crate::expr::compile::{Compiler, Fields, Program};
use crate::{Error, Kind, Mark, Name, Result, Snapshot, Table};

/// A mark compiled against the schemas of its dataset and the datasets its options join, with the
/// errors of options that did not fit, which store their unset values.
pub(crate) struct Compiled {
    pub(crate) program: Arc<Program>,
    pub(crate) drawing: Drawing,
    pub(crate) schemas: Vec<(Name, u64)>,
    pub(crate) failures: Vec<Error>,
}

/// Compiles `mark` against the schemas in `all`. Returns `None` while the mark's dataset or table
/// is missing. A view keeps such a mark pending, and validation reports the missing table before
/// calling this. Errors when the mark itself does not fit the data, such as its ends or geometry,
/// or when it compiles to more than 32 channels.
pub(crate) fn compile(mark: &Mark, all: &[Snapshot], context: Context<'_>) -> Result<Option<Compiled>> {
    let style = mark.style();
    let Some(data) = all.iter().find(|d| *d.name() == style.data) else { return Ok(None) };
    let Some(table) = data.table(&style.table) else { return Ok(None) };
    let fields = Schema { table, all };
    let mut compiler = Compiler::new(&fields);
    let drawing = mark.compile(&mut compiler, context)?;
    let failures = std::mem::take(&mut compiler.failures);
    let program = compiler.finish();
    if program.channels.len() > 32 {
        return Err(Error::invalid("more than 32 options read data"));
    }
    // A joined dataset not yet given has schema 0, so the mark compiles again once it arrives.
    let mut schemas = vec![(data.name().clone(), data.schema())];
    for name in mark.joins() {
        if !schemas.iter().any(|(n, _)| *n == name) {
            let schema = all.iter().find(|d| *d.name() == name).map_or(0, Snapshot::schema);
            schemas.push((name, schema));
        }
    }
    Ok(Some(Compiled { program: Arc::new(program), drawing, schemas, failures }))
}

struct Schema<'a> {
    table: &'a Table,
    all: &'a [Snapshot],
}

impl Fields for Schema<'_> {
    fn kind(&self, from: Option<&(Name, Name)>, name: &str) -> Option<Kind> {
        match from {
            None => self.table.kind(name),
            Some((data, table)) => self.all.iter().find(|d| d.name() == data)?.table(table)?.kind(name),
        }
    }

    fn empty(&self, from: Option<&(Name, Name)>, name: &str) -> bool {
        let table = match from {
            None => Some(self.table),
            Some((data, table)) => self.all.iter().find(|d| d.name() == data).and_then(|d| d.table(table)),
        };
        table.and_then(|t| t.field_named(name)).is_some_and(|field| !field.fixed())
    }

    fn target(&self, name: &str) -> Option<Name> {
        match self.table.field_named(name)? {
            crate::data::Field::Reference(reference) => Some(reference.to.clone()),
            _ => None,
        }
    }
}
