//! Shared scratch for segment lists, drawn-row expansion, and height ordering, and a view's own
//! scratch for a height order sorted a few passes a frame.
use super::{
    order::{Order, Sorting},
    pipelines::{Projection, Variant},
    raster::{At, Lengths, Raster, Render, Scan, Shared},
    retired::Retired,
    shaders::{Shader, WordStep},
    words::Words,
};

pub(crate) struct Inputs<'a> {
    pub(crate) pages: &'a Words,
    pub(crate) lists: &'a Words,
    pub(crate) view: &'a wgpu::BindGroup,
    pub(crate) mark: &'a wgpu::BindGroup,
    pub(crate) offset: u32,
    pub(crate) path: u32,
    pub(crate) projection: Projection,
    pub(crate) measured: bool,
}

/// A segment list's input size and reserved output regions.
#[derive(Clone, Copy)]
pub(crate) struct Segments {
    pub(crate) items: u32,
    pub(crate) kept: u32,
    pub(crate) counts: u32,
    pub(crate) destination: u32,
    pub(crate) areas: bool,
}

pub(crate) struct Listing {
    work: Words,
    scanned: Words,
    packed: Words,
    scan: Scan,
    lengths: Lengths,
    order: Order,
}

impl Listing {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Listing {
        Self {
            work: Words::new(device, retired, "latkit list records"),
            scanned: Words::new(device, retired, "latkit list prefixes"),
            packed: Words::new(device, retired, "latkit packed list"),
            scan: Scan::default(),
            lengths: Lengths::default(),
            order: Order::new(device, retired),
        }
    }

    pub(crate) fn expand(&mut self, raster: &mut Raster<'_>, input: &Inputs<'_>, count: u32, destination: u32) {
        let words = count.next_multiple_of(4);
        self.work.ensure(raster.device, u64::from(words));
        render(raster, input, "expand_runs", &self.scanned, &self.work, count, words);
        self.work.copy_to(raster.encoder, 0, input.lists, destination, words);
    }

    pub(crate) fn segments(&mut self, raster: &mut Raster<'_>, input: &Inputs<'_>, plan: Segments) {
        let Segments { items, kept, counts, destination, areas } = plan;
        let scratch = if input.measured { kept * 4 } else { 0 };
        self.work.ensure(raster.device, u64::from(scratch.max(items * 4)));
        self.scanned.ensure(raster.device, u64::from(scratch.max((items + 1).next_multiple_of(4))));
        let words = (kept * 2).next_multiple_of(4);
        self.packed.ensure(raster.device, u64::from(words.max(items.next_multiple_of(4))));
        render(raster, input, "count_segments", &self.scanned, &self.work, items, items * 4);
        render(raster, input, "pack_counts", &self.work, &self.packed, items, items.next_multiple_of(4));
        self.scan.record(raster, At::new(&self.packed, 0), At::new(&self.scanned, 0), items);
        self.scanned.copy_to(raster.encoder, 0, input.lists, counts, (items + 1).next_multiple_of(4));
        if input.measured {
            self.lengths_along(raster, input, kept, words);
        } else {
            let entry = if areas { "area_segments" } else { "segments_unmeasured" };
            render(raster, input, entry, &self.scanned, &self.packed, kept, words);
        }
        self.packed.copy_to(raster.encoder, 0, input.lists, destination, words);
    }

    /// Measures again the distance along of each of a built segment list's `kept` entries, and
    /// writes the entries at `destination`, without counting the list again.
    pub(crate) fn measure(&mut self, raster: &mut Raster<'_>, input: &Inputs<'_>, kept: u32, destination: u32) {
        let words = (kept * 2).next_multiple_of(4);
        self.work.ensure(raster.device, u64::from(kept * 4));
        self.scanned.ensure(raster.device, u64::from(kept * 4));
        self.packed.ensure(raster.device, u64::from(words));
        self.lengths_along(raster, input, kept, words);
        self.packed.copy_to(raster.encoder, 0, input.lists, destination, words);
    }

    /// Writes `kept` entries into `packed`: each segment's row and the distance along its row's path
    /// where it ends, the sum of its length and those of the segments before it.
    fn lengths_along(&mut self, raster: &mut Raster<'_>, input: &Inputs<'_>, kept: u32, words: u32) {
        render(raster, input, "segments", &self.scanned, &self.work, kept, kept * 4);
        self.lengths.record(raster, At::new(&self.work, 0), At::new(&self.scanned, 0), kept);
        render(raster, input, "pack_segments", &self.scanned, &self.packed, kept, words);
    }

    /// Counts the comet slots of the `items` segments whose records start at record `first` in
    /// `screen`, scans the counts into where each segment's slots start, at `counts`, and writes
    /// the `kept` slots at `destination` (see `raster/comets.wesl`). `input` binds the copy of the
    /// mark's uniform that says where its slots lie.
    pub(crate) fn comet_slots(
        &mut self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        screen: &super::screen::Screen,
        first: u32,
        [items, kept]: [u32; 2],
        [counts, destination]: [u32; 2],
    ) {
        let words = (kept * 2).next_multiple_of(4);
        self.packed.ensure(raster.device, u64::from(words.max(items.next_multiple_of(4))));
        self.scanned.ensure(raster.device, u64::from((items + 1).next_multiple_of(4)));
        let render = |raster: &mut Raster<'_>, entry: &'static str, output: &Words, count: u32, words: u32| {
            raster.render(Render {
                variant: Variant::raster(Shader::Comets, entry),
                shared: Some(Shared { view: input.view, mark: input.mark, offset: input.offset }),
                bindings: &[
                    wgpu::BindGroupEntry { binding: 9, resource: input.lists.binding() },
                    wgpu::BindGroupEntry { binding: 11, resource: screen.binding() },
                ],
                uniform: 19,
                step: WordStep { source: first, ..WordStep::of(count) },
                output,
                words,
            });
        };
        render(raster, "count_slots", &self.packed, items, items.next_multiple_of(4));
        self.scan.record(raster, At::new(&self.packed, 0), At::new(&self.scanned, 0), items);
        self.scanned.copy_to(raster.encoder, 0, input.lists, counts, (items + 1).next_multiple_of(4));
        render(raster, "slots", &self.packed, kept, words);
        self.packed.copy_to(raster.encoder, 0, input.lists, destination, words);
    }

    /// Writes the order the mark's first `count` instances draw in, lowest first, at `destination`
    /// in the lists buffer. Scratch has room for the list's `kept` instances, so a count that
    /// changes between sorts never makes it again.
    pub(crate) fn order(
        &mut self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        (count, kept): (u32, u32),
        destination: u32,
    ) {
        self.work.ensure(raster.device, u64::from(kept) * 4);
        self.scanned.ensure(raster.device, u64::from(kept) * 4);
        self.packed.ensure(raster.device, u64::from(kept.next_multiple_of(4)));
        render(raster, input, "height_keys", &self.scanned, &self.work, count, count * 4);
        let sides = (At::new(&self.work, 0), At::new(&self.scanned, 0));
        self.order.record(raster, sides, count, kept, super::shaders::HEIGHT_BITS);
        render(raster, input, "pack_order", &self.scanned, &self.packed, count, count.next_multiple_of(4));
        self.packed.copy_to(raster.encoder, 0, input.lists, destination, count.next_multiple_of(4));
    }
}

/// A height order sorted a few passes a frame, one mark's at a time, in scratch of its own, so
/// the passes other lists run between its frames leave it be: each instance keyed by its height
/// when the sort began, the order they land in, and the sort's own scratch.
pub(crate) struct Background {
    keys: Words,
    sorted: Words,
    packed: Words,
    order: Order,
    sorting: Option<Sorting>,
}

impl Background {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Background {
        Background {
            keys: Words::new(device, retired, "latkit sort keys"),
            sorted: Words::new(device, retired, "latkit sorted keys"),
            packed: Words::new(device, retired, "latkit sorted order"),
            order: Order::new(device, retired),
            sorting: None,
        }
    }

    /// Keys the first `count` instances of the mark `input` draws by their heights now, and starts
    /// sorting them. `kept` instances fit its scratch.
    pub(crate) fn begin(&mut self, raster: &mut Raster<'_>, input: &Inputs<'_>, (count, kept): (u32, u32)) {
        self.keys.ensure(raster.device, u64::from(kept) * 4);
        self.sorted.ensure(raster.device, u64::from(kept) * 4);
        render(raster, input, "height_keys", &self.sorted, &self.keys, count, count * 4);
        self.sorting = Some(self.order.begin(raster, count, kept, super::shaders::HEIGHT_BITS));
    }

    /// Runs at most `passes` of the sort's passes, at least one.
    pub(crate) fn advance(&mut self, raster: &mut Raster<'_>, passes: u32) {
        let Some(sorting) = &mut self.sorting else { return };
        let sides = (At::new(&self.keys, 0), At::new(&self.sorted, 0));
        self.order.advance(raster, sides, sorting, passes);
    }

    /// Writes the sorted order of `count` instances at `destination` in the lists of the mark
    /// `input` draws, and ends the sort.
    pub(crate) fn land(&mut self, raster: &mut Raster<'_>, input: &Inputs<'_>, count: u32, destination: u32) {
        let words = count.next_multiple_of(4);
        self.packed.ensure(raster.device, u64::from(words));
        render(raster, input, "pack_order", &self.sorted, &self.packed, count, words);
        self.packed.copy_to(raster.encoder, 0, input.lists, destination, words);
        self.sorting = None;
    }
}

fn render(
    raster: &mut Raster<'_>,
    input: &Inputs<'_>,
    entry: &'static str,
    source: &Words,
    output: &Words,
    count: u32,
    words: u32,
) {
    let geometry = matches!(entry, "count_segments" | "segments" | "height_keys");
    raster.render(Render {
        variant: Variant::raster(Shader::Lists, entry)
            .path(if geometry { input.path } else { super::shaders::PATH_ENDS })
            .projection(if geometry { input.projection } else { Projection::Dynamic }),
        shared: Some(Shared { view: input.view, mark: input.mark, offset: input.offset }),
        bindings: &[
            wgpu::BindGroupEntry { binding: 0, resource: input.pages.binding() },
            wgpu::BindGroupEntry { binding: 9, resource: input.lists.binding() },
            wgpu::BindGroupEntry { binding: 18, resource: source.binding() },
        ],
        uniform: 19,
        step: WordStep {
            other: match entry {
                "segments" => 4,
                "pack_segments" | "segments_unmeasured" | "area_segments" => 2,
                _ => 0,
            },
            value: u32::from(input.measured),
            ..WordStep::of(count)
        },
        output,
        words,
    });
}
