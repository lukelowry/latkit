//! Label preparation uses ordered cell coverage and per-code idempotent requests. All temporary
//! storage is shared across marks and views; no intermediate count is read back to the CPU.
use super::{
    listing::Inputs,
    pipelines::Variant,
    raster::{At, Draw, Raster, Render, Scan, Shared},
    retired::Retired,
    shaders::{NUMBER_CODES, Shader, WANTED, WordStep},
    texture::Texture,
    words::{LAYER_WORDS, Words},
};

/// The dictionary and its two packed result regions in the label table.
#[derive(Clone, Copy)]
pub(crate) struct Request {
    pub(crate) numeric: bool,
    pub(crate) codes: u32,
    pub(crate) wanted: u32,
    pub(crate) seen: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct Metadata {
    pub(crate) variant: Variant,
    pub(crate) rows: u32,
    pub(crate) destination: [u32; 2],
    pub(crate) strokes: super::screen::StrokeRead,
}

pub(crate) struct Texts {
    metadata: Words,
    positions: Words,
    flags: Words,
    bits: Words,
    counts: Words,
    prefix: Words,
    packed: Words,
    scan: Scan,
}

impl Texts {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Self {
        Self {
            metadata: Words::new(device, retired, "latkit label metadata"),
            positions: Words::new(device, retired, "latkit label positions"),
            flags: Words::new(device, retired, "latkit label requests"),
            bits: Words::new(device, retired, "latkit label bitsets"),
            counts: Words::new(device, retired, "latkit label counts"),
            prefix: Words::new(device, retired, "latkit label prefix"),
            packed: Words::new(device, retired, "latkit label packed"),
            scan: Scan::default(),
        }
    }

    pub(crate) fn metadata(
        &mut self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        labels: &Words,
        screen: &super::screen::Screen,
        metadata: Metadata,
    ) {
        let Metadata { variant, rows, destination, strokes } = metadata;
        self.metadata.ensure(raster.device, u64::from(rows.max(1)) * 4);
        self.positions.ensure(raster.device, u64::from(rows.max(1)) * 4);
        let (record_first, record_kind) = strokes.address();
        // The metadata (value 0), then the corners of the labels' boxes (value 1).
        for (value, output) in [(0, &self.metadata), (1, &self.positions)] {
            raster.render(Render {
                variant,
                shared: Some(shared(input)),
                uniform: 19,
                step: WordStep { value, record_first, record_kind, ..WordStep::of(rows) },
                bindings: &[
                    wgpu::BindGroupEntry { binding: 0, resource: input.pages.binding() },
                    wgpu::BindGroupEntry { binding: 9, resource: input.lists.binding() },
                    wgpu::BindGroupEntry { binding: 11, resource: screen.binding() },
                    wgpu::BindGroupEntry { binding: 13, resource: labels.binding() },
                ],
                output,
                words: rows * 4,
            });
        }
        self.metadata.copy_to(raster.encoder, 0, labels, destination[0], rows * 4);
        self.positions.copy_to(raster.encoder, 0, labels, destination[1], rows * 4);
    }

    pub(crate) fn claim(
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        labels: &Words,
        grid: &Texture,
        rows: u32,
        clear: bool,
    ) {
        raster.draw(Draw {
            variant: Variant::raster(Shader::Claims, "claim"),
            shared: Some(shared(input)),
            uniform: 19,
            step: WordStep { size: [grid.raw.width(), grid.raw.height()], ..WordStep::of(rows) },
            bindings: &[wgpu::BindGroupEntry { binding: 18, resource: labels.binding() }],
            target: &grid.view,
            vertices: 6,
            instances: rows,
            clear,
        });
    }

    /// Claims the cells `[first, last]` of `grid` for no label, as a guide's box does, after the
    /// labels of the mark `input` draws claimed theirs.
    pub(crate) fn claim_box(
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        labels: &Words,
        grid: &Texture,
        cells: [[u32; 2]; 2],
    ) {
        let [first, last] = cells;
        raster.draw(Draw {
            variant: Variant::raster(Shader::Claims, "claim"),
            shared: Some(shared(input)),
            uniform: 19,
            step: WordStep {
                source: first[0],
                other: first[1],
                destination: last[0],
                layer: last[1],
                value: 1,
                size: [grid.raw.width(), grid.raw.height()],
                ..WordStep::of(1)
            },
            bindings: &[wgpu::BindGroupEntry { binding: 18, resource: labels.binding() }],
            target: &grid.view,
            vertices: 6,
            instances: 1,
            clear: false,
        });
    }

    pub(crate) fn gather(
        &mut self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        labels: &Words,
        grid: &Texture,
        rows: u32,
        request: Request,
    ) {
        let Request { numeric, codes, wanted, seen } = request;
        self.flags.ensure(raster.device, u64::from(codes) * 4);
        for layer in 0..(codes * 4).div_ceil(LAYER_WORDS) {
            raster.draw(Draw {
                variant: Variant::raster(Shader::Requests, "request"),
                shared: Some(shared(input)),
                uniform: 19,
                step: WordStep {
                    size: [self.flags.texture().width(), self.flags.texture().height()],
                    layer,
                    ..WordStep::of(codes)
                },
                bindings: &[
                    wgpu::BindGroupEntry { binding: 13, resource: labels.binding() },
                    wgpu::BindGroupEntry { binding: 14, resource: wgpu::BindingResource::TextureView(&grid.view) },
                    wgpu::BindGroupEntry { binding: 18, resource: labels.binding() },
                ],
                target: &self.flags.attachment(layer),
                vertices: 1,
                instances: if numeric { NUMBER_CODES } else { rows },
                clear: true,
            });
        }
        let blocks = codes.div_ceil(64);
        self.bits.ensure(raster.device, u64::from(blocks) * 4);
        self.counts.ensure(raster.device, u64::from(blocks.next_multiple_of(4)));
        self.prefix.ensure(raster.device, u64::from((blocks + 1).next_multiple_of(4)));
        self.packed
            .ensure(raster.device, u64::from((1 + WANTED).next_multiple_of(4).max((codes / 32).next_multiple_of(4))));
        render(raster, "bits", &self.flags, &self.prefix, &self.bits, codes, blocks * 4);
        render(raster, "counts", &self.bits, &self.prefix, &self.counts, blocks, blocks.next_multiple_of(4));
        self.scan.record(raster, At::new(&self.counts, 0), At::new(&self.prefix, 0), blocks);
        let asked = (1 + WANTED).next_multiple_of(4);
        render(raster, "gather", &self.bits, &self.prefix, &self.packed, blocks, asked);
        self.packed.copy_to(raster.encoder, 0, labels, wanted, asked);
        let seen_words = (codes / 32).next_multiple_of(4);
        render(raster, "seen", &self.bits, &self.prefix, &self.packed, blocks, seen_words);
        self.packed.copy_to(raster.encoder, 0, labels, seen, seen_words);
    }
}

fn shared<'a>(input: &'a Inputs<'a>) -> Shared<'a> {
    Shared { view: input.view, mark: input.mark, offset: input.offset }
}

fn render(
    raster: &mut Raster<'_>,
    entry: &'static str,
    source: &Words,
    prefix: &Words,
    output: &Words,
    count: u32,
    words: u32,
) {
    raster.render(Render {
        variant: Variant::raster(Shader::TextCodes, entry),
        shared: None,
        uniform: 19,
        step: WordStep::of(count),
        bindings: &[
            wgpu::BindGroupEntry { binding: 18, resource: source.binding() },
            wgpu::BindGroupEntry { binding: 20, resource: prefix.binding() },
        ],
        output,
        words,
    });
}
