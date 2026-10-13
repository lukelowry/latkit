//! Committed marks: a scene's mark, its program compiled against its data, and its GPU state.

use std::sync::Arc;

use super::sync::Tables;
use crate::expr::compile::{Compiler, Deps, Fields, Program};
use crate::gpu::Inner;
use crate::scene::mark::{Drawing, Key, MarkKind};
use crate::{Data, Error, Kind, Mark, Name, Result, Theme};

/// A mark's program and how it draws, compiled against one schema of its data.
pub(crate) struct Compiled {
    pub(crate) program: Arc<Program>,
    pub(crate) drawing: Drawing,
    /// The schemas compiled against: the mark's data, then every dataset a join reads.
    pub(crate) schemas: Vec<(Name, u64)>,
}

/// Where a mark's parts sit in the program buffer, as absolute word offsets.
#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub(crate) struct Offsets {
    pub(crate) columns: u32,
    pub(crate) ranges: u32,
    pub(crate) code: u32,
    pub(crate) constants: u32,
    pub(crate) ends: u32,
}

pub(crate) struct Shown {
    pub(crate) mark: Mark,
    pub(crate) key: Key,
    pub(crate) compiled: Option<Compiled>,
    pub(crate) tables: Tables,
    /// Rows of the mark's table when last synced.
    pub(crate) rows: u32,
    /// Word offset of row 0 in the state buffer, word offset in the focus buffer, first domain.
    pub(crate) offset: u32,
    pub(crate) focus: u32,
    pub(crate) domains: u32,
    /// Channels to evaluate, and whether fitted domains reduce, next frame.
    pub(crate) dirty: u32,
    pub(crate) reduce: bool,
    /// The program's code and constants with colormap layers and text codes written in.
    pub(crate) code: Vec<[u32; 4]>,
    pub(crate) constants: Vec<u32>,
    /// Graph slot of vertex 0 of each table the program's ends name.
    pub(crate) ends: Vec<u32>,
    /// The mark's region of the program buffer, `[start, capacity]` in words, and where its parts
    /// are; `packed` is false until the region holds the current words.
    pub(crate) region: Option<[u32; 2]>,
    pub(crate) offsets: Offsets,
    pub(crate) packed: bool,
}

impl Shown {
    pub(crate) fn new(mark: Mark) -> Shown {
        Shown {
            key: mark.key(),
            mark,
            compiled: None,
            tables: Tables::default(),
            rows: 0,
            offset: 0,
            focus: 0,
            domains: 0,
            dirty: 0,
            reduce: false,
            code: Vec::new(),
            constants: Vec::new(),
            ends: Vec::new(),
            region: None,
            offsets: Offsets::default(),
            packed: false,
        }
    }

    pub(crate) fn kind(&self) -> MarkKind {
        self.key.kind
    }

    /// Whether the mark has a program, rows, and columns synced at least once.
    pub(crate) fn drawable(&self) -> bool {
        self.compiled.is_some() && self.rows > 0 && self.tables.synced()
    }

    /// State words per row.
    pub(crate) fn stride(&self) -> u32 {
        self.compiled.as_ref().map_or(0, |c| c.drawing.stride)
    }

    /// Fitted domains the program reduces.
    pub(crate) fn reductions(&self) -> u32 {
        self.compiled.as_ref().map_or(0, |c| c.program.domains.len() as u32)
    }

    /// Channels whose inputs include any of `deps`.
    pub(crate) fn channels_reading(&self, deps: Deps) -> u32 {
        let Some(compiled) = &self.compiled else { return 0 };
        compiled
            .program
            .channels
            .iter()
            .enumerate()
            .fold(0, |mask, (k, c)| if c.reads.deps.intersects(deps) { mask | 1 << k } else { mask })
    }

    /// Channels and domains reading any column of `columns` become dirty.
    pub(crate) fn columns_changed(&mut self, columns: u64) {
        let Some(compiled) = &self.compiled else { return };
        let program = &compiled.program;
        let reduce = program.domains.iter().any(|d| d.columns & columns != 0);
        for (k, channel) in program.channels.iter().enumerate() {
            if channel.reads.columns & columns != 0 || (reduce && channel.reads.deps.intersects(Deps::DOMAIN)) {
                self.dirty |= 1 << k;
            }
        }
        self.reduce |= reduce;
        self.packed = false;
    }

    pub(crate) fn all_dirty(&mut self) {
        if let Some(compiled) = &self.compiled {
            let n = compiled.program.channels.len();
            self.dirty = if n >= 32 { u32::MAX } else { (1 << n) - 1 };
            self.reduce = !compiled.program.domains.is_empty();
        }
    }

    /// Compiles the mark against `all`; it stays uncompiled while its data or table is not set.
    pub(crate) fn compile(&mut self, all: &[Data], theme: &Theme, gpu: &mut Inner) -> Result<()> {
        self.tables.release(gpu);
        self.compiled = None;
        self.packed = false;
        let style = self.mark.style();
        let Some(data) = all.iter().find(|d| *d.name() == style.data) else { return Ok(()) };
        let Some(table) = data.table(&style.table) else { return Ok(()) };
        let fields = Schema { table, all };
        let mut compiler = Compiler::new(&fields);
        let drawing = self.mark.compile(&mut compiler, theme)?;
        let program = compiler.finish();
        if program.channels.len() > 32 {
            return Err(Error::invalid("more than 32 options read data"));
        }
        let mut schemas = vec![(data.name().clone(), data.schema())];
        for column in &program.columns {
            if let Some((name, _)) = &column.of
                && !schemas.iter().any(|(n, _)| n == name)
                && let Some(other) = all.iter().find(|d| d.name() == name)
            {
                schemas.push((name.clone(), other.schema()));
            }
        }
        self.code.clone_from(&program.code);
        self.constants.clone_from(&program.constants);
        self.compiled = Some(Compiled { program: Arc::new(program), drawing, schemas });
        self.all_dirty();
        Ok(())
    }

    /// Whether `data` changed a schema the mark compiled against, or brought data it waited for.
    pub(crate) fn stale(&self, data: &Data) -> bool {
        match &self.compiled {
            None => *data.name() == self.mark.style().data,
            Some(compiled) => {
                compiled.schemas.iter().any(|(name, schema)| name == data.name() && *schema != data.schema())
            }
        }
    }

    /// Words the mark's region needs: descriptors and tables, ranges, code, constants, ends.
    pub(crate) fn packed_len(&self) -> u32 {
        let Some(compiled) = &self.compiled else { return 0 };
        (self.tables.len()
            + 2 * compiled.program.ranges.len()
            + 4 * self.code.len()
            + self.constants.len()
            + self.ends.len()) as u32
    }

    /// Appends the mark's words, which start at word `base` of the program buffer, and records where
    /// each part lands.
    pub(crate) fn pack(&mut self, base: u32, out: &mut Vec<u32>) {
        let Some(compiled) = &self.compiled else { return };
        let start = out.len();
        let at = |out: &Vec<u32>| base + (out.len() - start) as u32;
        let columns = at(out);
        self.tables.pack(columns, out);
        let ranges = at(out);
        out.extend(compiled.program.ranges.iter().flatten());
        let code = at(out);
        out.extend(self.code.iter().flatten());
        let constants = at(out);
        out.extend(&self.constants);
        let ends = at(out);
        out.extend(&self.ends);
        self.offsets = Offsets { columns, ranges, code, constants, ends };
    }
}

/// The fields a mark's expressions read: its own table's, and other datasets' for joins.
struct Schema<'a> {
    table: &'a crate::Table,
    all: &'a [Data],
}

impl Fields for Schema<'_> {
    fn kind(&self, of: Option<&(Name, Name)>, name: &str) -> Option<Kind> {
        match of {
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
