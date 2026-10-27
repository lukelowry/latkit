//! Compiles marks against dataset schemas, for both validation and views.

use std::sync::Arc;

use super::mark::{Context, Drawing};
use crate::expr::compile::{Compiler, Fields, Program};
use crate::{Error, Kind, Mark, Name, Result, Snapshot, Table};

/// A mark compiled against the schemas of its dataset and any datasets it joins.
pub(crate) struct Compiled {
    pub(crate) program: Arc<Program>,
    pub(crate) drawing: Drawing,
    pub(crate) schemas: Vec<(Name, u64)>,
}

/// Compiles `mark` against the schemas in `all`. Returns `None` while the mark's dataset or table
/// is missing. A view keeps such a mark pending, and validation reports the missing table before
/// calling this. Errors when an option fails to compile or the mark compiles to more than 32
/// channels.
pub(crate) fn compile(mark: &Mark, all: &[Snapshot], context: Context<'_>) -> Result<Option<Compiled>> {
    let style = mark.style();
    let Some(data) = all.iter().find(|d| *d.name() == style.data) else { return Ok(None) };
    let Some(table) = data.table(&style.table) else { return Ok(None) };
    let fields = Schema { table, all };
    let mut compiler = Compiler::new(&fields);
    let drawing = mark.compile(&mut compiler, context)?;
    let program = compiler.finish();
    if program.channels.len() > 32 {
        return Err(Error::invalid("more than 32 options read data"));
    }
    let mut schemas = vec![(data.name().clone(), data.schema())];
    for column in &program.columns {
        if let Some((name, _)) = &column.from
            && !schemas.iter().any(|(n, _)| n == name)
            && let Some(other) = all.iter().find(|d| d.name() == name)
        {
            schemas.push((name.clone(), other.schema()));
        }
    }
    Ok(Some(Compiled { program: Arc::new(program), drawing, schemas }))
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

    fn target(&self, name: &str) -> Option<Name> {
        match self.table.field_named(name)? {
            crate::data::Field::Reference(reference) => Some(reference.to.clone()),
            _ => None,
        }
    }
}
