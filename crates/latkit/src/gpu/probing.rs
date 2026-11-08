//! GPU picking and queries share one geometry program. Hover reduces priority records; queries
//! scan occupancy flags and materialize only the retained hits. The same program locates a row
//! or tests box membership. A small scatter pass combines box hits into row flags and bitsets.
use super::{
    listing::Inputs,
    pipelines::Variant,
    raster::{At, Draw, Raster, Render, Scan, Shared},
    reduce::Maximum,
    retired::Retired,
    shaders::{Shader, WordStep},
    words::{LAYER_WORDS, Words},
};

pub(crate) struct ProbeInputs<'a> {
    pub(crate) geometry: Inputs<'a>,
    pub(crate) depth: &'a wgpu::TextureView,
    pub(crate) output: &'a Words,
    pub(crate) variant: Variant,
}

pub(crate) struct Probing {
    first: Words,
    counts: Words,
    prefix: Words,
    packed: Words,
    winners: Words,
    winner: Words,
    details: Words,
    maximum: Maximum,
    scan: Scan,
}

impl Probing {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Self {
        let words = |name| Words::new(device, retired, name);
        Self {
            first: words("latkit hit first"),
            counts: words("latkit hit counts"),
            prefix: words("latkit hit prefix"),
            packed: words("latkit hit packed"),
            winners: words("latkit probe winners"),
            winner: words("latkit probe winner"),
            details: words("latkit probe details"),
            maximum: Maximum::new(device, retired),
            scan: Scan::default(),
        }
    }

    pub(crate) fn begin(&mut self, raster: &mut Raster<'_>, marks: u32) {
        let marks = marks.max(1);
        self.winners.ensure(raster.device, u64::from(marks) * 4);
        self.details.ensure(raster.device, u64::from(marks) * 8);
        raster.fill(&self.first, At::new(&self.winners, 0), marks * 4, 0);
        raster.fill(&self.first, At::new(&self.details, 0), marks * 8, 0);
    }

    pub(crate) fn nearest(&mut self, raster: &mut Raster<'_>, input: &ProbeInputs<'_>, count: u32, mark: u32) {
        self.first.ensure(raster.device, u64::from(count.max(1)) * 4);
        self.packed.ensure(raster.device, 8);
        geometry(
            raster,
            input,
            input.variant.entry("probe"),
            [&self.winner, &self.details],
            &self.first,
            WordStep { value: mark, ..step(count) },
            count * 4,
        );
        self.maximum.greatest(raster, At::new(&self.first, 0), At::new(&self.winners, mark * 4), count);
        geometry(
            raster,
            input,
            input.variant.entry("probe"),
            [&self.winners, &self.details],
            &self.packed,
            WordStep { source: mark * 4, other: 1, ..step(count) },
            8,
        );
        self.packed.copy_to(raster.encoder, 0, &self.details, mark * 8, 8);
    }

    pub(crate) fn finish(&mut self, raster: &mut Raster<'_>, input: &ProbeInputs<'_>, marks: u32) {
        self.maximum.greatest(raster, At::new(&self.winners, 0), At::new(&self.winner, 0), marks.max(1));
        geometry(
            raster,
            input,
            input.variant.entry("finish"),
            [&self.winner, &self.details],
            input.output,
            step(marks),
            12,
        );
    }

    pub(crate) fn locate(&mut self, raster: &mut Raster<'_>, input: &ProbeInputs<'_>) {
        geometry(
            raster,
            input,
            input.variant.entry("probe"),
            [&self.winner, &self.details],
            input.output,
            WordStep { destination: 8, other: 4, ..step(1) },
            4,
        );
    }

    pub(crate) fn hits(
        &mut self,
        raster: &mut Raster<'_>,
        input: &ProbeInputs<'_>,
        count: u32,
        room: u32,
        destination: u32,
    ) {
        self.first.ensure(raster.device, u64::from(count.max(1)) * 4);
        self.counts.ensure(raster.device, u64::from(count.next_multiple_of(4).max(4)));
        self.prefix.ensure(raster.device, u64::from((count + 1).next_multiple_of(4)));
        self.packed.ensure(raster.device, u64::from(4 + room * 8));
        geometry(
            raster,
            input,
            input.variant.entry("probe"),
            [&self.winner, &self.details],
            &self.first,
            WordStep { other: 2, ..step(count) },
            count * 4,
        );
        pack(raster, "counts", &self.first, &self.counts, step(count), count.next_multiple_of(4));
        self.scan.record(raster, At::new(&self.counts, 0), At::new(&self.prefix, 0), count);
        geometry(
            raster,
            input,
            input.variant.entry("probe"),
            [&self.prefix, &self.details],
            &self.packed,
            WordStep { other: 3, value: room, ..step(count) },
            4 + room * 8,
        );
        self.packed.copy_to(raster.encoder, 0, input.output, destination, 4 + room * 8);
    }

    pub(crate) fn boxed(
        &mut self,
        raster: &mut Raster<'_>,
        input: &ProbeInputs<'_>,
        count: u32,
        rows: u32,
        destination: u32,
    ) {
        self.first.ensure(raster.device, u64::from(count.max(1)) * 4);
        self.counts.ensure(raster.device, u64::from(rows.max(1)) * 4);
        geometry(
            raster,
            input,
            input.variant.entry("probe"),
            [&self.winner, &self.details],
            &self.first,
            WordStep { other: 5, ..step(count) },
            count * 4,
        );
        let variant = Variant::raster(Shader::Boxed, "boxed_row");
        for layer in 0..(rows.max(1) * 4).div_ceil(LAYER_WORDS) {
            raster.draw(Draw {
                variant,
                shared: None,
                uniform: 19,
                step: WordStep {
                    layer,
                    size: [self.counts.texture().width(), self.counts.texture().height()],
                    ..step(count)
                },
                bindings: &[wgpu::BindGroupEntry { binding: 18, resource: self.first.binding() }],
                target: &self.counts.attachment(layer),
                vertices: 1,
                instances: count,
                clear: true,
            });
        }
        let words = rows.div_ceil(32).next_multiple_of(4);
        self.packed.ensure(raster.device, u64::from(words.max(4)));
        pack(raster, "boxed", &self.counts, &self.packed, step(rows), words);
        self.packed.copy_to(raster.encoder, 0, input.output, destination, words);
    }
}

fn step(count: u32) -> WordStep {
    WordStep { source: 0, other: 0, destination: 0, count, layer: 0, value: 0, size: [0; 2] }
}
fn shared<'a>(input: &'a ProbeInputs<'a>) -> Shared<'a> {
    Shared { view: input.geometry.view, mark: input.geometry.mark, offset: input.geometry.offset }
}
fn bindings<'a>(input: &'a ProbeInputs<'a>, source: &'a Words, details: &'a Words) -> [wgpu::BindGroupEntry<'a>; 5] {
    [
        wgpu::BindGroupEntry { binding: 0, resource: input.geometry.pages.binding() },
        wgpu::BindGroupEntry { binding: 9, resource: input.geometry.lists.binding() },
        wgpu::BindGroupEntry { binding: 6, resource: wgpu::BindingResource::TextureView(input.depth) },
        wgpu::BindGroupEntry { binding: 18, resource: source.binding() },
        wgpu::BindGroupEntry { binding: 20, resource: details.binding() },
    ]
}
fn geometry(
    raster: &mut Raster<'_>,
    input: &ProbeInputs<'_>,
    variant: Variant,
    [source, details]: [&Words; 2],
    output: &Words,
    step: WordStep,
    words: u32,
) {
    raster.render(Render {
        variant,
        shared: Some(shared(input)),
        bindings: &bindings(input, source, details),
        uniform: 19,
        step,
        output,
        words,
    });
}
fn pack(raster: &mut Raster<'_>, entry: &'static str, first: &Words, output: &Words, step: WordStep, words: u32) {
    raster.render(Render {
        variant: Variant::raster(Shader::QueryPack, entry),
        shared: None,
        uniform: 19,
        step,
        bindings: &[wgpu::BindGroupEntry { binding: 18, resource: first.binding() }],
        output,
        words,
    });
}
