//! Shared scratch for segment lists, drawn-row expansion, and height ordering.
use super::{
    order::Order,
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
            render(raster, input, "segments", &self.scanned, &self.work, kept, kept * 4);
            self.lengths.record(raster, At::new(&self.work, 0), At::new(&self.scanned, 0), kept);
            render(raster, input, "pack_segments", &self.scanned, &self.packed, kept, words);
        } else {
            let entry = if areas { "area_segments" } else { "segments_unmeasured" };
            render(raster, input, entry, &self.scanned, &self.packed, kept, words);
        }
        self.packed.copy_to(raster.encoder, 0, input.lists, destination, words);
    }

    pub(crate) fn order(&mut self, raster: &mut Raster<'_>, input: &Inputs<'_>, count: u32, destination: u32) {
        self.work.ensure(raster.device, u64::from(count) * 4);
        self.scanned.ensure(raster.device, u64::from(count) * 4);
        self.packed.ensure(raster.device, u64::from(count.next_multiple_of(4)));
        render(raster, input, "height_keys", &self.scanned, &self.work, count, count * 4);
        self.order.record(raster, At::new(&self.work, 0), At::new(&self.scanned, 0), count);
        render(raster, input, "pack_order", &self.scanned, &self.packed, count, count.next_multiple_of(4));
        self.packed.copy_to(raster.encoder, 0, input.lists, destination, count.next_multiple_of(4));
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
            source: 0,
            other: match entry {
                "segments" => 4,
                "pack_segments" | "segments_unmeasured" | "area_segments" => 2,
                _ => 0,
            },
            destination: 0,
            count,
            layer: 0,
            value: u32::from(input.measured),
            size: [0; 2],
        },
        output,
        words,
    });
}
