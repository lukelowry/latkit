//! Committed marks: a scene's mark, its program compiled against its data, and its GPU state.

use std::sync::Arc;

use super::drawing::Drawing;
use super::ends::End;
use super::sync::Tables;
use super::transition::{Begin, Transition};
use super::words::{Kept, Words};
use crate::data::{Table, Version};
use crate::expr::compile::{Deps, Reads};
use crate::gpu::shaders as wgsl;
use crate::gpu::{Inner, atlas};
use crate::scene::compile::{self, Compiled};
use crate::scene::mark::{Context, Key, MarkKind, Primitive};
use crate::{Error, Mark, Port, Result, Shape, Snapshot};

/// Where a mark's parts sit in the program buffer, as absolute word offsets.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Offsets {
    pub(crate) columns: u32,
    pub(crate) ranges: u32,
    pub(crate) code: u32,
    pub(crate) constants: u32,
    pub(crate) ends: u32,
    pub(crate) palette: u32,
    pub(crate) port_info: u32,
    pub(crate) blends: u32,
    /// The runs of held rows it draws, `NONE` where it draws every row as itself.
    pub(crate) runs: u32,
    /// The page table of each kind of words it keeps per row, by `Kept`; `NONE` where it keeps none.
    pub(crate) pages: [u32; 6],
}

impl Offsets {
    /// Where the page table of `kept` lies, or `NONE`.
    pub(crate) fn table(&self, kept: Kept) -> u32 {
        self.pages[kept as usize]
    }
}

impl Default for Offsets {
    fn default() -> Offsets {
        Offsets {
            columns: 0,
            ranges: 0,
            code: 0,
            constants: 0,
            ends: 0,
            palette: 0,
            port_info: wgsl::NONE,
            blends: 0,
            runs: wgsl::NONE,
            pages: [wgsl::NONE; 6],
        }
    }
}

/// What a mark's state holds: rows of a version of its table, as a drawing lays them out or as the
/// table orders them, and the origin of its dataset, whose rows are followed by id when they move.
#[derive(Clone)]
pub(crate) struct Holding {
    pub(crate) origin: Version,
    pub(crate) table: Table,
    pub(crate) drawing: Option<Arc<Drawing>>,
}

pub(crate) struct Shown {
    pub(crate) mark: Mark,
    pub(crate) key: Key,
    pub(crate) compiled: Option<Compiled>,
    pub(crate) tables: Tables,
    /// Rows the mark draws, as of the tables last published, and rows past them that left and fade
    /// out.
    pub(crate) rows: u32,
    pub(crate) exits: u32,
    /// Rows it held when the frame began: what freezes.
    pub(crate) before: u32,
    /// What its state holds, as the tables last published lay it out.
    pub(crate) holding: Option<Holding>,
    /// How far the tiles of the table it draws in part have faded in or out, from 0 to 1.
    pub(crate) reveal: f32,
    /// Slots of held rows given a page of other rows this frame, whose labels start over.
    pub(crate) bound: Vec<u32>,
    /// Each fitted domain fitted over every row of a table drawn in part: the stamp of what it read,
    /// and its words.
    pub(crate) fitted: Vec<(u64, [u32; 2])>,
    /// What it keeps per row, in pages of the arena.
    pub(crate) words: Words,
    /// First fitted domain.
    pub(crate) domains: u32,
    /// Channels to evaluate, the row blocks they evaluate over, and whether fitted domains reduce,
    /// next frame. Set through `dirty_rows` and `all_dirty`, so every channel made dirty names its rows.
    pub(crate) dirty: u32,
    pub(crate) blocks: Blocks,
    pub(crate) reduce: bool,
    /// Row blocks whose state words start over, in pages new to it: evaluation writes every word of
    /// their rows before any channel does.
    pub(crate) fresh: Vec<u32>,
    /// Where this frame's evaluation lists the row blocks it covers, and how many.
    pub(crate) block: u32,
    pub(crate) block_count: u32,
    /// The row blocks whose ends the end pass finds next frame: where rows or their ends changed,
    /// and every block where the vertices they end at moved. Where this frame's end pass lists them,
    /// and how many.
    pub(crate) unresolved: Blocks,
    pub(crate) end_block: u32,
    pub(crate) end_block_count: u32,
    /// Whether this frame's ease pass writes what the mark shows from its frozen and settled state.
    pub(crate) easing: bool,
    /// The program's code and constants with colormap layers and text codes written in.
    pub(crate) code: Vec<[u32; 4]>,
    pub(crate) constants: Vec<u32>,
    /// Where the rows each end of its rows names are held, by end.
    pub(crate) ends: Vec<End>,
    /// A vertex mark's ports, `PORT_WORDS` each, their labels' places in the atlas written in.
    pub(crate) ports: Vec<u32>,
    /// The mark's region of the program buffer, `[start, capacity]` in words, and where its parts
    /// are; `packed` is false until the region holds the current words, and `written` what it holds.
    pub(crate) region: Option<[u32; 2]>,
    pub(crate) offsets: Offsets,
    pub(crate) packed: bool,
    pub(crate) written: Vec<u32>,
    /// A transition waiting to freeze, the one running, and where its remap words start; and whether
    /// this frame's froze rows where they moved, so their comets' travel follows them.
    pub(crate) begin: Option<Begin>,
    pub(crate) transition: Option<Transition>,
    pub(crate) remap: u32,
    pub(crate) carry: bool,
    /// Where the header of the list this frame's query builds over its instances starts.
    pub(crate) query: u32,
    /// The list numbering a stroke mark's segments when rows have different numbers of them.
    pub(crate) segments: super::lists::Segments,
    /// Where the words of the rows it draws of a table drawn in part lie.
    pub(crate) drawn_rows: super::lists::DrawnRows,
    /// Whether an edge mark follows great circles.
    pub(crate) geodesic: bool,
    /// Bumps whenever the mark's state is written, so what derives from it knows to follow; and
    /// whenever what places its labels is: where its rows stand, how large and whether they show,
    /// and their labels' texts and priorities. A color that changes every frame moves no label.
    pub(crate) version: u64,
    pub(crate) place_version: u64,
    /// The rows its focus draw lights.
    pub(crate) lit: super::focus::Lit,
    /// Why it no longer compiles against the data, kept until data fits it again, and whether a frame
    /// told it: the next frame does, unless a scene shown before then replaced the mark.
    pub(crate) failure: Option<(Error, bool)>,
}

impl Shown {
    pub(crate) fn new(mark: Mark) -> Shown {
        Shown {
            key: mark.key(),
            mark,
            compiled: None,
            tables: Tables::default(),
            rows: 0,
            exits: 0,
            before: 0,
            holding: None,
            reveal: 1.0,
            bound: Vec::new(),
            fitted: Vec::new(),
            words: Words::default(),
            domains: 0,
            dirty: 0,
            blocks: Blocks::default(),
            reduce: false,
            fresh: Vec::new(),
            block: 0,
            block_count: 0,
            unresolved: Blocks::default(),
            end_block: 0,
            end_block_count: 0,
            easing: false,
            code: Vec::new(),
            constants: Vec::new(),
            ends: Vec::new(),
            ports: Vec::new(),
            region: None,
            offsets: Offsets::default(),
            packed: false,
            written: Vec::new(),
            begin: None,
            transition: None,
            remap: 0,
            carry: false,
            query: wgsl::NONE,
            segments: super::lists::Segments::default(),
            drawn_rows: super::lists::DrawnRows::default(),
            geodesic: false,
            version: 0,
            place_version: 0,
            lit: super::focus::Lit::default(),
            failure: None,
        }
    }

    pub(crate) fn kind(&self) -> MarkKind {
        self.key.kind
    }

    /// Rows the mark holds evaluated whose data holds them: every per-row word is a held row's. A
    /// table drawn as it is holds its rows; one drawn in part a page of rows in each slot.
    pub(crate) fn live(&self) -> u32 {
        self.drawing().map_or(self.rows, |d| d.live())
    }

    /// The drawing of the table it draws in part, as last published.
    pub(crate) fn drawing(&self) -> Option<&Arc<Drawing>> {
        self.holding.as_ref().and_then(|h| h.drawing.as_ref())
    }

    /// The row of its table held row `h` holds.
    pub(crate) fn source_row(&self, h: u32) -> Option<u32> {
        match self.drawing() {
            Some(drawing) => drawing.source(h),
            None => (h < self.rows).then_some(h),
        }
    }

    /// The held row of row `r` of its table, if it holds it.
    pub(crate) fn held_row(&self, r: u32) -> Option<u32> {
        match self.drawing() {
            Some(drawing) => drawing.held_row(r),
            None => (r < self.rows).then_some(r),
        }
    }

    /// Where held row `h` draws among its rows, if it does.
    pub(crate) fn item_of(&self, h: u32) -> Option<u32> {
        match self.drawing() {
            Some(drawing) => drawing.item_of(h),
            None => (h < self.rows).then_some(h),
        }
    }

    /// Rows it draws that are not fading out with their tiles.
    pub(crate) fn steady_rows(&self) -> u32 {
        self.drawing().map_or(self.rows, |d| d.items - d.leaving_items)
    }

    /// The runs of held rows it draws, as `lib/drawn.wesl` reads them: how many, then each one's
    /// first row drawn, first held row, and fade; the rows that left last, steady. None where it
    /// draws every row as itself.
    fn runs(&self) -> Vec<u32> {
        let Some(drawing) = self.drawing() else { return Vec::new() };
        let exits = (self.exits > 0).then_some([drawing.items, drawing.live(), 0]);
        let count = drawing.runs.len() + usize::from(exits.is_some());
        let mut words = Vec::with_capacity(1 + count * wgsl::RUN_WORDS as usize);
        words.push(count as u32);
        for run in &drawing.runs {
            words.extend([run.item, run.held, run.fade]);
        }
        words.extend(exits.into_iter().flatten());
        words
    }

    /// Rows the mark holds evaluated, those that left and fade out included.
    pub(crate) fn held(&self) -> u32 {
        self.live() + self.exits
    }

    /// Whether the mark has a program, rows it holds and pages of words for them, and columns synced
    /// at least once: a mark holding only the rows the ends of edges drawn name evaluates them, and
    /// draws none.
    /// Whether the mark draws faces, which need normals.
    pub(crate) fn faces(&self) -> bool {
        self.kind() == MarkKind::Faces
    }

    pub(crate) fn drawable(&self) -> bool {
        self.compiled.is_some() && self.held() > 0 && self.tables.synced() && self.pages_held()
    }

    /// Whether its pages of words per row hold every row it holds.
    pub(crate) fn pages_held(&self) -> bool {
        let state = self.words.pages(Kept::State);
        state.width == self.stride() + self.extras()
            && state.blocks.len() as u32 >= self.held().div_ceil(wgsl::PAGE_ROWS)
    }

    /// Rows each page of its held rows holds: each slot's whole page of a table drawn in part, which
    /// evaluates whole, or a table's own rows a page at a time; rows that left follow either.
    pub(crate) fn page_rows(&self) -> Vec<u32> {
        let (live, held) = (self.live(), self.held());
        let full = |start: u32| self.drawing().is_some() && start < live;
        (0..held.div_ceil(wgsl::PAGE_ROWS))
            .map(|p| {
                let start = p * wgsl::PAGE_ROWS;
                if full(start) { wgsl::PAGE_ROWS } else { held.min(start + wgsl::PAGE_ROWS) - start }
            })
            .collect()
    }

    /// Lets go of what it holds on the GPU, as a mark does when it goes.
    pub(crate) fn release(&mut self, gpu: &mut Inner) {
        self.tables.release(gpu);
        self.words.release(&mut gpu.arena);
    }

    /// Kind words per row.
    pub(crate) fn stride(&self) -> u32 {
        self.compiled.as_ref().map_or_else(|| kind_stride(self.kind()), |c| c.drawing.stride)
    }

    /// Extra words per row.
    pub(crate) fn extras(&self) -> u32 {
        self.compiled.as_ref().map_or(0, |c| c.drawing.extras)
    }

    /// What its channels and fitted domains read besides its own table's static fields, which their
    /// pipeline is made for: before its data says, neither joins, samples, nor the view.
    pub(crate) fn reads(&self) -> crate::gpu::pipelines::Reads {
        let Some(program) = self.compiled.as_ref().map(|c| &c.program) else {
            return crate::gpu::pipelines::Reads { joined: false, timed: false, viewed: false };
        };
        let viewing = [wgsl::OP_SELECTED, wgsl::OP_HOVERED, wgsl::OP_POINTER, wgsl::OP_ZOOM];
        crate::gpu::pipelines::Reads {
            joined: program.columns.iter().any(|c| c.from.is_some()),
            timed: program.columns.iter().any(|c| c.sampled),
            viewed: program.code.iter().any(|op| viewing.contains(&op[0])),
        }
    }

    /// The path its strokes read, or where its triangles' corners come from: one of the `PATH_` codes,
    /// which its pipelines are made for.
    pub(crate) fn path(&self) -> u32 {
        match &self.compiled {
            Some(c) if c.drawing.primitive != Primitive::Points => c.drawing.path,
            _ => wgsl::PATH_ENDS,
        }
    }

    /// Whether it numbers its instances with a list: strokes whose rows' paths have different numbers
    /// of segments, running through a geometry column, along great circles, or bowed into lanes; and
    /// areas, whose rows have different numbers of triangles.
    pub(crate) fn listed(&self) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        match compiled.drawing.primitive {
            Primitive::Strokes => compiled.drawing.geometry != wgsl::NONE || self.curved(),
            Primitive::Triangles => self.path() == wgsl::PATH_GEOMETRY,
            Primitive::Points => false,
        }
    }

    /// Whether its edges curve between their ends, along great circles or bowed into lanes: how many
    /// pieces each takes is found on the GPU and read back.
    pub(crate) fn curved(&self) -> bool {
        self.path() == wgsl::PATH_ENDS && (self.geodesic || self.laned())
    }

    /// Whether its edges bow into lanes among the edges joining the same two vertices.
    pub(crate) fn laned(&self) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        compiled.drawing.lane != wgsl::NONE && self.tables.holds(compiled.drawing.lane)
    }

    /// Instances its list must have room for: every path's segments, each curve's pieces as last
    /// found; or every area's triangles.
    pub(crate) fn segment_capacity(&self) -> u32 {
        let rows = (self.rows + self.exits) as usize;
        let Some(compiled) = &self.compiled else { return 1 };
        let points = self.tables.points(compiled.drawing.geometry) as usize;
        if compiled.drawing.primitive == Primitive::Triangles {
            return (points / 3 + rows).max(1) as u32;
        }
        let pieces = if !self.curved() {
            0
        } else if self.geodesic {
            (self.segments.found.value as usize).max(rows * 4)
        } else {
            rows * wgsl::BOW_PIECES as usize
        };
        (points + rows + pieces).max(1) as u32
    }

    /// Vertices each of its instances draws: a quad per point or segment, three corners per triangle.
    pub(crate) fn corners(&self) -> u32 {
        match self.compiled.as_ref().map(|c| c.drawing.primitive) {
            Some(Primitive::Triangles) => 3,
            _ => 4,
        }
    }

    /// Its channels that say where its rows' labels go and whether they show: where rows stand, how
    /// large they are and whether they show, and their labels' texts and priorities.
    pub(crate) fn placing_channels(&self) -> u32 {
        let Some(compiled) = &self.compiled else { return 0 };
        let shaping = ["position", "radius", "width", "height", "elevation", "visible", "text", "priority"];
        compiled
            .program
            .channels
            .iter()
            .enumerate()
            .fold(0, |mask, (k, c)| if shaping.contains(&&*c.name) { mask | 1 << k } else { mask })
    }

    /// A version of where its rows are drawn: their places, and while a transition runs, every frame
    /// that eases them.
    pub(crate) fn places_drawn(&self) -> (bool, u64) {
        if self.transition.is_some() { (true, self.version) } else { (false, self.place_version) }
    }

    /// Ports each row has.
    pub(crate) fn port_count(&self) -> u32 {
        self.compiled.as_ref().map_or(0, |c| c.drawing.ports.len() as u32)
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

    /// Channels and domains reading any column of `columns` become dirty: over the row blocks
    /// `blocks` names, the pages that changed, while the channels read only their own rows; else over
    /// every row.
    pub(crate) fn columns_changed(&mut self, columns: u64, blocks: Option<&[u32]>) {
        let Some(compiled) = &self.compiled else { return };
        let program = &compiled.program;
        let reduce = program.domains.iter().any(|d| d.columns & columns != 0);
        let mut channels = 0;
        for (k, channel) in program.channels.iter().enumerate() {
            if channel.reads.columns & columns != 0 || (reduce && channel.reads.deps.intersects(Deps::DOMAIN)) {
                channels |= 1 << k;
            }
        }
        // A fitted domain, or a table read through a join, reaches past a row's own block.
        let joined =
            program.columns.iter().enumerate().any(|(i, c)| c.from.is_some() && columns & Reads::column(i) != 0);
        // Rows whose ends' references changed find them again.
        let ends = program
            .ends
            .iter()
            .any(|end| end.column != wgsl::NONE && columns & Reads::column(end.column as usize) != 0);
        self.dirty_rows(channels, blocks.filter(|_| !reduce && !joined));
        self.reduce |= reduce;
        if ends {
            self.unresolved.add(blocks);
        }
        self.packed = false;
    }

    /// Channels `channels` evaluate again on the next frame, over the row blocks `blocks` names, or
    /// over every row for `None`; naming no block, none does.
    pub(crate) fn dirty_rows(&mut self, channels: u32, blocks: Option<&[u32]>) {
        if channels != 0 && blocks.is_none_or(|b| !b.is_empty()) {
            self.dirty |= channels;
            self.blocks.add(blocks);
        }
    }

    /// Whether any column of `columns` holds static values that show eased: values a channel reads,
    /// or the path a stroke runs along. Changing one eases; a column only shaders read, such as a
    /// lane, shows at once.
    pub(crate) fn static_columns(&self, columns: u64) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        let program = &compiled.program;
        let geometry = compiled.drawing.geometry;
        let eased = program.channels.iter().fold(0, |mask, c| mask | c.reads.columns)
            | if geometry == wgsl::NONE { 0 } else { 1 << geometry.min(63) };
        program.columns.iter().enumerate().any(|(i, c)| !c.sampled && columns & eased & (1 << i.min(63)) != 0)
    }

    /// Rows rewritten in place in row blocks `blocks`, every other row where it was: those blocks
    /// evaluate every channel, constants included. A fitted domain reads every row, so with one every
    /// row does.
    pub(crate) fn rows_rewritten(&mut self, blocks: &[u32]) {
        let Some(compiled) = &self.compiled else { return };
        if !compiled.program.domains.is_empty() {
            return self.all_dirty();
        }
        self.slots_bound(blocks);
    }

    /// Slots `blocks` of held rows given pages of rows held before or never: those blocks evaluate
    /// every channel, constants included, and find their ends. Their rows' data is as it was, so
    /// domains fitted to it hold.
    pub(crate) fn slots_bound(&mut self, blocks: &[u32]) {
        let Some(compiled) = &self.compiled else { return };
        let n = compiled.program.channels.len();
        let ends = !compiled.program.ends.is_empty() && !blocks.is_empty();
        self.dirty_rows(if n >= 32 { u32::MAX } else { (1 << n) - 1 }, Some(blocks));
        if ends {
            self.unresolved.add(Some(blocks));
        }
    }

    /// Every row evaluates every channel and finds its ends.
    pub(crate) fn all_dirty(&mut self) {
        if let Some(compiled) = &self.compiled {
            let n = compiled.program.channels.len();
            self.dirty = if n >= 32 { u32::MAX } else { (1 << n) - 1 };
            self.blocks = Blocks::All;
            self.reduce = !compiled.program.domains.is_empty();
            if !compiled.program.ends.is_empty() {
                self.unresolved = Blocks::All;
            }
        }
    }

    /// Compiles the mark against `all` in `context`; it stays uncompiled while its data or table is
    /// not set.
    pub(crate) fn compile(&mut self, all: &[Snapshot], context: Context<'_>, gpu: &mut Inner) -> Result<()> {
        self.tables.release(gpu);
        self.compiled = None;
        self.packed = false;
        let Some(compiled) = compile::compile(&self.mark, all, context)? else { return Ok(()) };
        self.code.clone_from(&compiled.program.code);
        self.constants.clone_from(&compiled.program.constants);
        self.compiled = Some(compiled);
        self.all_dirty();
        Ok(())
    }

    /// Whether `data` changed a schema the mark compiled against, or brought data it waited for.
    pub(crate) fn stale(&self, data: &Snapshot) -> bool {
        match &self.compiled {
            None => *data.name() == self.mark.style().data,
            Some(compiled) => {
                compiled.schemas.iter().any(|(name, schema)| name == data.name() && *schema != data.schema())
            }
        }
    }

    /// Writes its ports' words: each one's code, shape, and reference column, and where the atlas
    /// holds its label, set in `font` by the host the first time.
    pub(crate) fn write_ports(&mut self, font: &Arc<str>, gpu: &mut Inner) {
        self.ports.clear();
        let Some(compiled) = &self.compiled else { return };
        let ports = &compiled.drawing.ports;
        let codes = Port::codes(&ports.iter().map(|(_, port, _)| port).collect::<Vec<_>>());
        let host = gpu.host.clone();
        for ((_, port, column), code) in ports.iter().zip(codes) {
            let corners = port.label.as_deref().and_then(|label| {
                let run = atlas::run(label.into(), font.clone(), compiled.drawing.port_label_size, None);
                gpu.atlas.text(host.as_deref(), &run)
            });
            let [uv0, uv1] = corners.map_or([0, 0], |glyphs| glyphs.corners());
            self.ports.extend([code, shape_code(port.shape), *column, uv0, uv1]);
        }
    }

    /// Words the mark's program region needs: descriptors and tables, ranges, code, constants, ends,
    /// its markers' palette, its ports, and how each word of its rows eases.
    pub(crate) fn packed_len(&self) -> u32 {
        let Some(compiled) = &self.compiled else { return 0 };
        (self.tables.len()
            + 2 * compiled.program.ranges.len()
            + 4 * self.code.len()
            + self.constants.len()
            + super::ends::words(&self.ends)
            + compiled.drawing.markers.palette.len()
            + self.ports.len()
            + self.drawing().map_or(0, |d| 1 + (d.runs.len() + 1) * wgsl::RUN_WORDS as usize)
            + self.words.len()) as u32
            + self.stride()
            + self.extras()
    }

    /// How each word of a row eases while the mark eases toward what its channels evaluate: a number
    /// or a color its channels store mixes, a position's high words move by their offset, and what
    /// else they store shows as evaluated; a word no channel stores keeps what it holds.
    fn blends(&self) -> Vec<u32> {
        let mut blends = vec![wgsl::BLEND_KEEP; (self.stride() + self.extras()) as usize];
        let mut set = |word: u32, blend: u32| {
            if let Some(b) = blends.get_mut(word as usize) {
                *b = blend;
            }
        };
        for &[op, word, ..] in &self.code {
            match op {
                wgsl::OP_STORE => set(word, wgsl::BLEND_NUMBER),
                wgsl::OP_STORE_COLOR => set(word, wgsl::BLEND_COLOR),
                wgsl::OP_STORE_POSITION | wgsl::OP_POSITION => {
                    set(word, wgsl::BLEND_POSITION);
                    set(word + 1, wgsl::BLEND_POSITION);
                    set(word + 2, wgsl::BLEND_SNAP);
                    set(word + 3, wgsl::BLEND_SNAP);
                    set(word + wgsl::VERTEX_FLAGS - wgsl::VERTEX_POSITION, wgsl::BLEND_SNAP);
                }
                wgsl::OP_STORE_FLAG | wgsl::OP_STORE_CODE => set(word, wgsl::BLEND_SNAP),
                _ => {}
            }
        }
        // What evaluation writes of every vertex row: its flags' units, and its size's range.
        if self.kind() == MarkKind::Vertices {
            set(wgsl::VERTEX_FLAGS, wgsl::BLEND_SNAP);
            set(wgsl::VERTEX_RANGE, wgsl::BLEND_SNAP);
        }
        blends
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
        super::ends::pack(&self.ends, &compiled.program.ends, ends, out);
        let palette = at(out);
        out.extend(&compiled.drawing.markers.palette);
        let port_info = if self.ports.is_empty() { wgsl::NONE } else { at(out) };
        out.extend(&self.ports);
        let blends = at(out);
        out.extend(self.blends());
        let runs = if self.drawing().is_some() { at(out) } else { wgsl::NONE };
        out.extend(self.runs());
        let mut pages = [wgsl::NONE; 6];
        for (kept, blocks) in self.words.tables() {
            pages[kept as usize] = at(out);
            out.extend(blocks);
        }
        self.offsets = Offsets { columns, ranges, code, constants, ends, palette, port_info, blends, runs, pages };
    }
}

/// The pages of a mark's rows that evaluate next: every page, or those listed, the pages that
/// changed.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Blocks {
    All,
    Listed(Vec<u32>),
}

impl Default for Blocks {
    fn default() -> Blocks {
        Blocks::Listed(Vec::new())
    }
}

impl Blocks {
    /// Adds the blocks `blocks` names, or every block for `None`.
    pub(crate) fn add(&mut self, blocks: Option<&[u32]>) {
        match (&mut *self, blocks) {
            (Blocks::All, _) => {}
            (Blocks::Listed(listed), Some(more)) => listed.extend_from_slice(more),
            (Blocks::Listed(_), None) => *self = Blocks::All,
        }
    }

    /// The blocks of a mark of `rows` rows to evaluate, in order, each once.
    pub(crate) fn of(&self, rows: u32) -> Vec<u32> {
        let count = rows.div_ceil(wgsl::PAGE_ROWS);
        match self {
            Blocks::All => (0..count).collect(),
            Blocks::Listed(listed) => {
                let mut blocks: Vec<u32> = listed.iter().copied().filter(|&b| b < count).collect();
                blocks.sort_unstable();
                blocks.dedup();
                blocks
            }
        }
    }
}

/// Kind words per row of a mark of `kind`.
pub(crate) fn kind_stride(kind: MarkKind) -> u32 {
    match kind {
        MarkKind::Vertices => wgsl::VERTEX_WORDS,
        MarkKind::Edges => wgsl::EDGE_WORDS,
        MarkKind::Faces => wgsl::FACE_WORDS,
        MarkKind::Lines => wgsl::LINE_WORDS,
        MarkKind::Areas => wgsl::AREA_WORDS,
    }
}

fn shape_code(shape: Shape) -> u32 {
    match shape {
        Shape::Ellipse => wgsl::SHAPE_ELLIPSE,
        Shape::Rectangle => wgsl::SHAPE_RECTANGLE,
        Shape::Rounded => wgsl::SHAPE_ROUNDED,
        Shape::Diamond => wgsl::SHAPE_DIAMOND,
    }
}
