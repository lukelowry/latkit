//! Shown marks: a scene's mark, its program compiled against its data, and its GPU state.

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
use crate::{Error, Mark, Result, Shape, Snapshot};

/// Where each part of a mark's region lies in the program buffer, as absolute word offsets.
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
    /// The runs of held rows it draws. `NONE` without a drawing, when the held rows are the table's
    /// rows.
    pub(crate) runs: u32,
    /// The page table of each kind of per-row words, indexed by `Kept`. `NONE` for a kind the mark
    /// does not keep.
    pub(crate) pages: [u32; 5],
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
            pages: [wgsl::NONE; 5],
        }
    }
}

/// The rows a mark's state holds: a version of its table, laid out by a drawing or in table order,
/// and the origin of its dataset. Rows that move are followed by id only within one origin.
#[derive(Clone)]
pub(crate) struct Holding {
    pub(crate) origin: Version,
    pub(crate) table: Table,
    pub(crate) drawing: Option<Arc<Drawing>>,
}

impl Holding {
    /// The table row at held row `h`, if it holds one there.
    pub(crate) fn source_row(&self, h: u32) -> Option<u32> {
        match &self.drawing {
            Some(drawing) => drawing.source(h),
            None => (h < self.table.len() as u32).then_some(h),
        }
    }
}

pub(crate) struct Shown {
    pub(crate) mark: Mark,
    pub(crate) key: Key,
    pub(crate) compiled: Option<Compiled>,
    pub(crate) tables: Tables,
    /// Rows the mark draws, as of the last published tables.
    pub(crate) rows: u32,
    /// Rows that left and are fading out, held after the live rows.
    pub(crate) exits: u32,
    /// Rows it held when the frame began. A starting transition freezes these.
    pub(crate) before: u32,
    /// The rows its state holds, as of the last published tables.
    pub(crate) holding: Option<Holding>,
    /// How far its paged table's tiles have faded in or out, from 0 to 1.
    pub(crate) reveal: f32,
    /// For a paged table, each fitted domain computed on the CPU over every row: the stamp of its
    /// inputs, and its words.
    pub(crate) fitted: Vec<(u64, [u32; 2])>,
    /// The domain its legend shows when its colormap fits its values: fitted on the CPU over every
    /// row, with the stamp of its inputs.
    pub(crate) legend: Option<(u64, [u32; 2])>,
    /// Its per-row words, in pages of the arena.
    pub(crate) words: Words,
    /// The index of its first fitted domain in the domains buffer.
    pub(crate) domains: u32,
    /// The channels to evaluate next frame, as a bit mask. `blocks` holds the row blocks to
    /// evaluate them over, and `reduce` whether fitted domains reduce. Set only through
    /// `dirty_rows` and `all_dirty`, so every dirty channel has row blocks.
    pub(crate) dirty: u32,
    pub(crate) blocks: Blocks,
    pub(crate) reduce: bool,
    /// Row blocks whose state words start over in newly allocated pages. Evaluation writes every
    /// word of their rows before any channel runs.
    pub(crate) fresh: Vec<u32>,
    /// Where this frame's evaluation lists its row blocks in the blocks buffer, and how many.
    pub(crate) block: u32,
    pub(crate) block_count: u32,
    /// The row blocks whose endpoints the end pass resolves next frame: blocks whose rows or
    /// endpoint references changed, and blocks whose rows end at vertices that moved.
    /// `end_block` and `end_block_count` locate this frame's list in the blocks buffer.
    pub(crate) unresolved: Blocks,
    pub(crate) end_block: u32,
    pub(crate) end_block_count: u32,
    /// Whether this frame's ease pass writes the mark's shown state from its frozen and settled
    /// words.
    pub(crate) easing: bool,
    /// The program's code and constants, with colormap layers and text codes filled in.
    pub(crate) code: Vec<[u32; 4]>,
    pub(crate) constants: Vec<u32>,
    /// The end table of each endpoint reference: where the vertex rows it references are held.
    pub(crate) ends: Vec<End>,
    /// A vertex mark's port words, `PORT_WORDS` per port, including the atlas corners of its label.
    pub(crate) ports: Vec<u32>,
    /// The mark's region of the program buffer, `[start, capacity]` in words. `offsets` locates its
    /// parts, `packed` is false until the region holds the current words, and `written` holds the
    /// words last written there.
    pub(crate) region: Option<[u32; 2]>,
    pub(crate) offsets: Offsets,
    pub(crate) packed: bool,
    pub(crate) written: Vec<u32>,
    /// A transition waiting to start. `transition` is the running one. `remap` is where its remap
    /// words start in the frame it starts, which the compute pass freezes it from (`NONE` in other
    /// frames). `carry` is whether this frame froze rows at new places, so their comets follow
    /// them.
    pub(crate) begin: Option<Begin>,
    pub(crate) transition: Option<Transition>,
    pub(crate) remap: u32,
    pub(crate) carry: bool,
    /// The probe-buffer word where this frame's query writes its result for this mark.
    pub(crate) query: u32,
    /// The list that numbers a stroke mark's segments when rows have different segment counts.
    pub(crate) segments: super::lists::Segments,
    /// For a paged table, where each drawn row's held-row word lies in the lists buffer.
    pub(crate) drawn_rows: super::lists::DrawnRows,
    /// Whether an edge mark follows great circles.
    pub(crate) geodesic: bool,
    /// Incremented whenever the mark's state is written, so anything derived from it updates.
    /// `place_version` is incremented whenever the channels that place its rows and labels are
    /// written: row positions, sizes, visibility, and label texts. A color that changes every frame
    /// moves no label.
    pub(crate) version: u64,
    pub(crate) place_version: u64,
    /// The rows its focus draw lights.
    pub(crate) lit: super::focus::Lit,
    /// Why it no longer compiles against the data, kept until the data fits again, and whether a
    /// frame has reported it. The next frame reports it unless a new scene replaces the mark first.
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
            fitted: Vec::new(),
            legend: None,
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
            remap: wgsl::NONE,
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

    /// Live held rows, not counting exits. Every per-row word belongs to a held row. An unpaged
    /// table's held rows are its rows. A paged table holds a page of rows per slot.
    pub(crate) fn live(&self) -> u32 {
        self.drawing().map_or(self.rows, |d| d.live())
    }

    /// The drawing of its paged table, as last published.
    pub(crate) fn drawing(&self) -> Option<&Arc<Drawing>> {
        self.holding.as_ref().and_then(|h| h.drawing.as_ref())
    }

    /// The table row at held row `h`.
    pub(crate) fn source_row(&self, h: u32) -> Option<u32> {
        self.holding.as_ref()?.source_row(h)
    }

    /// The held row of table row `r`, if the mark holds it.
    pub(crate) fn held_row(&self, r: u32) -> Option<u32> {
        match self.drawing() {
            Some(drawing) => drawing.held_row(r),
            None => (r < self.rows).then_some(r),
        }
    }

    /// The position of held row `h` among the rows the mark draws, if it draws it.
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

    /// The runs of held rows it draws, in the layout `lib/drawn.wesl` reads: the count, then each
    /// run's first drawn row, first held row, and fade. Exits come last, as one steady run. Empty
    /// without a drawing.
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

    /// Held rows, exits included.
    pub(crate) fn held(&self) -> u32 {
        self.live() + self.exits
    }

    /// Whether the mark draws faces, which need normals.
    pub(crate) fn faces(&self) -> bool {
        self.kind() == MarkKind::Faces
    }

    /// Whether the mark can evaluate and draw: it has a program, held rows with pages of words for
    /// them, and columns synced at least once. A mark holding only the rows that drawn edges end at
    /// evaluates them but draws none.
    pub(crate) fn drawable(&self) -> bool {
        self.compiled.is_some() && self.held() > 0 && self.tables.synced() && self.pages_held()
    }

    /// Whether its state pages have the current row width and cover every held row.
    pub(crate) fn pages_held(&self) -> bool {
        let state = self.words.pages(Kept::State);
        state.width == self.width() && state.blocks.len() as u32 >= self.held().div_ceil(wgsl::PAGE_ROWS)
    }

    /// The row count of each page of its held rows, as [`page_rows`] lays them out.
    pub(crate) fn page_rows(&self) -> Vec<u32> {
        page_rows(self.live(), self.held(), self.drawing().is_some())
    }

    /// Releases its tables and pages on the GPU, as when the mark is removed.
    pub(crate) fn release(&mut self, gpu: &mut Inner) {
        self.tables.release(gpu);
        self.words.release(&mut gpu.arena);
    }

    /// Words per row that the mark's kind uses.
    pub(crate) fn stride(&self) -> u32 {
        self.kind().stride()
    }

    /// Extra words per row.
    pub(crate) fn extras(&self) -> u32 {
        self.compiled.as_ref().map_or(0, |c| c.drawing.extras)
    }

    /// Words per row: the kind's, then the extras.
    pub(crate) fn width(&self) -> u32 {
        self.stride() + self.extras()
    }

    /// Words per row for each kind of word page: state, focus, and normals (when faces are
    /// `summing` normals at its rows). 0 for a kind the mark keeps none of.
    pub(crate) fn kept_widths(&self, summing: bool) -> [(Kept, u32); 3] {
        [(Kept::State, self.width()), (Kept::Focus, 1), (Kept::Normals, if summing { wgsl::NORMAL_WORDS } else { 0 })]
    }

    /// What its channels and fitted domains read besides its own table's static fields. This picks
    /// their pipeline variant. Before the mark compiles, it reads no joins, samples, or view state.
    pub(crate) fn reads(&self) -> crate::gpu::pipelines::Reads {
        let Some(program) = self.compiled.as_ref().map(|c| &c.program) else {
            return crate::gpu::pipelines::Reads::NONE;
        };
        let viewing = [wgsl::OP_SELECTED, wgsl::OP_HOVERED, wgsl::OP_POINTER, wgsl::OP_ZOOM];
        crate::gpu::pipelines::Reads {
            joined: program.columns.iter().any(|c| c.from.is_some()),
            timed: program.columns.iter().any(|c| c.sampled),
            viewed: program.code.iter().any(|op| viewing.contains(&op[0])),
        }
    }

    /// The `PATH_` code its pipelines are built for, as [`Mark::path`](crate::Mark) decides it.
    pub(crate) fn path(&self) -> u32 {
        self.compiled.as_ref().map_or(wgsl::PATH_ENDS, |c| c.drawing.path)
    }

    /// Whether a list numbers its instances: strokes whose rows have different segment counts
    /// (through a geometry column, along great circles, or bowed into lanes), and areas, whose rows
    /// have different triangle counts.
    pub(crate) fn listed(&self) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        match self.kind().primitive() {
            Primitive::Strokes => compiled.drawing.geometry != wgsl::NONE || self.curved(),
            Primitive::Triangles => self.path() == wgsl::PATH_GEOMETRY,
            Primitive::Points => false,
        }
    }

    /// Whether its edges curve between their endpoints, along great circles or bowed into lanes.
    /// The GPU counts each edge's pieces. For great circles, the total is read back to size the
    /// segment list.
    pub(crate) fn curved(&self) -> bool {
        self.path() == wgsl::PATH_ENDS && (self.geodesic || self.laned())
    }

    /// Whether its edges bow into lanes among the edges joining the same two vertices.
    pub(crate) fn laned(&self) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        compiled.drawing.lane != wgsl::NONE && self.tables.holds(compiled.drawing.lane)
    }

    /// Instances its list needs space for: every path's segments plus each curve's pieces (as last
    /// counted), or every area's triangles.
    pub(crate) fn segment_capacity(&self) -> u32 {
        let rows = (self.rows + self.exits) as usize;
        let Some(compiled) = &self.compiled else { return 1 };
        let points = self.tables.points(compiled.drawing.geometry) as usize;
        if self.kind().primitive() == Primitive::Triangles {
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

    /// A bit mask of the channels that place its rows and labels: row position, size, and
    /// visibility, and label text.
    pub(crate) fn placing_channels(&self) -> u32 {
        let Some(compiled) = &self.compiled else { return 0 };
        let shaping = ["position", "radius", "width", "height", "elevation", "visible", "text"];
        compiled
            .program
            .channels
            .iter()
            .enumerate()
            .fold(0, |mask, (k, c)| if shaping.contains(&&*c.name) { mask | 1 << k } else { mask })
    }

    /// A version of where its rows are drawn: `place_version`, or while a transition runs,
    /// `version`, which changes every frame that eases them. The flag says which one it is.
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

    /// A bit mask of the channels whose inputs include any of `deps`.
    pub(crate) fn channels_reading(&self, deps: Deps) -> u32 {
        let Some(compiled) = &self.compiled else { return 0 };
        compiled
            .program
            .channels
            .iter()
            .enumerate()
            .fold(0, |mask, (k, c)| if c.reads.deps.intersects(deps) { mask | 1 << k } else { mask })
    }

    /// Marks the channels and domains that read any of `columns` dirty. They evaluate over `blocks`
    /// (the changed pages) when the channels read only their own rows, otherwise over every row.
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
        // A fitted domain, or a table read through a join, reads beyond a row's own block.
        let joined =
            program.columns.iter().enumerate().any(|(i, c)| c.from.is_some() && columns & Reads::column(i) != 0);
        // Rows whose endpoint references changed resolve their endpoints again.
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

    /// Marks `channels` to evaluate next frame over the row blocks `blocks`, or over every row for
    /// `None`. An empty block list marks nothing.
    pub(crate) fn dirty_rows(&mut self, channels: u32, blocks: Option<&[u32]>) {
        if channels != 0 && blocks.is_none_or(|b| !b.is_empty()) {
            self.dirty |= channels;
            self.blocks.add(blocks);
        }
    }

    /// Whether any of `columns` holds static values that ease when they change: values a channel
    /// that eases reads, or the path a stroke follows. A column only shaders read, such as a lane,
    /// or only a label's text reads, changes at once.
    pub(crate) fn static_columns(&self, columns: u64) -> bool {
        let Some(compiled) = &self.compiled else { return false };
        let program = &compiled.program;
        let geometry = compiled.drawing.geometry;
        let eased = program.channels.iter().filter(|c| c.eases).fold(0, |mask, c| mask | c.reads.columns)
            | if geometry == wgsl::NONE { 0 } else { 1 << geometry.min(63) };
        program.columns.iter().enumerate().any(|(i, c)| !c.sampled && columns & eased & (1 << i.min(63)) != 0)
    }

    /// Rows in row blocks `blocks` were rewritten in place, and every other row is unchanged. Those
    /// blocks evaluate every channel, constants included. A fitted domain reads every row, so with
    /// one, every row evaluates.
    pub(crate) fn rows_rewritten(&mut self, blocks: &[u32]) {
        let Some(compiled) = &self.compiled else { return };
        if !compiled.program.domains.is_empty() {
            return self.all_dirty();
        }
        self.slots_bound(blocks);
    }

    /// Slots `blocks` received pages of other rows. Those blocks evaluate every channel, constants
    /// included, and resolve their endpoints. The data itself is unchanged, so fitted domains stay
    /// valid.
    pub(crate) fn slots_bound(&mut self, blocks: &[u32]) {
        let Some(compiled) = &self.compiled else { return };
        let n = compiled.program.channels.len();
        let ends = !compiled.program.ends.is_empty() && !blocks.is_empty();
        self.dirty_rows(if n >= 32 { u32::MAX } else { (1 << n) - 1 }, Some(blocks));
        if ends {
            self.unresolved.add(Some(blocks));
        }
    }

    /// Marks every channel dirty over every row, and every row's endpoints unresolved.
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

    /// Compiles the mark against the datasets `all` in `context`. It stays uncompiled while its
    /// dataset or table is missing.
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

    /// Whether `data` changes a schema the mark compiled against, or is the dataset an uncompiled
    /// mark waits for.
    pub(crate) fn stale(&self, data: &Snapshot) -> bool {
        match &self.compiled {
            None => *data.name() == self.mark.style().data,
            Some(compiled) => {
                compiled.schemas.iter().any(|(name, schema)| name == data.name() && *schema != data.schema())
            }
        }
    }

    /// Writes its port words: each port's code (`codes`, among the ports of its table), shape,
    /// reference column, and the atlas corners of its label. The host sets each label in `font` the
    /// first time.
    pub(crate) fn write_ports(&mut self, font: &Arc<str>, codes: &[u32], gpu: &mut Inner) {
        self.ports.clear();
        let Some(compiled) = &self.compiled else { return };
        let ports = &compiled.drawing.ports;
        let host = gpu.host.clone();
        for ((_, port, column), &code) in ports.iter().zip(codes) {
            let corners = port.label.as_deref().and_then(|label| {
                let run = atlas::run(label.into(), font.clone(), compiled.drawing.port_label_size, None);
                gpu.atlas.text(host.as_deref(), &run)
            });
            let [uv0, uv1] = corners.map_or([0, 0], |glyphs| glyphs.corners());
            self.ports.extend([code, shape_code(port.shape), *column, uv0, uv1]);
        }
    }

    /// Words the mark's program region needs: column descriptors and tables, ranges, code,
    /// constants, end tables, the marker palette, ports, runs, page tables, and blends.
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

    /// How each word of a row blends while the mark eases toward what its channels evaluate. Stored
    /// numbers and colors interpolate, a position's high words move by their offset, and other
    /// stored words snap to the new value. A word no channel stores keeps its value.
    fn blends(&self) -> Vec<u32> {
        let mut blends = vec![wgsl::BLEND_KEEP; self.width() as usize];
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
        // Evaluation writes these for every vertex row: its flags' units and its size range.
        if self.kind() == MarkKind::Vertices {
            set(wgsl::VERTEX_FLAGS, wgsl::BLEND_SNAP);
            set(wgsl::VERTEX_RANGE, wgsl::BLEND_SNAP);
        }
        blends
    }

    /// Appends the mark's words, which start at program-buffer word `base`, and records each part's
    /// offset.
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
        let mut pages = [wgsl::NONE; 5];
        for (kept, blocks) in self.words.tables() {
            pages[kept as usize] = at(out);
            out.extend(blocks);
        }
        self.offsets = Offsets { columns, ranges, code, constants, ends, palette, port_info, blends, runs, pages };
    }
}

/// The row blocks (pages of held rows) to process next: all of them, or a list of those that
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

    /// The blocks within a mark's `rows` held rows, ascending and without repeats.
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

/// The row count of each page of `held` rows, of which the first `live` are not exits. A `paged`
/// table gets a full page per slot, since each slot evaluates as a whole page. An unpaged table's
/// rows are split into pages. Exits follow in either case.
pub(crate) fn page_rows(live: u32, held: u32, paged: bool) -> Vec<u32> {
    (0..held.div_ceil(wgsl::PAGE_ROWS))
        .map(|p| {
            let start = p * wgsl::PAGE_ROWS;
            if paged && start < live { wgsl::PAGE_ROWS } else { held.min(start + wgsl::PAGE_ROWS) - start }
        })
        .collect()
}

fn shape_code(shape: Shape) -> u32 {
    match shape {
        Shape::Ellipse => wgsl::SHAPE_ELLIPSE,
        Shape::Rectangle => wgsl::SHAPE_RECTANGLE,
        Shape::Rounded => wgsl::SHAPE_ROUNDED,
        Shape::Diamond => wgsl::SHAPE_DIAMOND,
    }
}
