//! Bounds fitting through integer raster reductions, using the same geometry as drawing.
use super::{
    listing::Inputs,
    pipelines::Variant,
    raster::{At, Raster, Render, Shared},
    reduce::Maximum,
    retired::Retired,
    shaders::{SCAN_BLOCK, WordStep},
    words::Words,
};

pub(crate) struct Bounds {
    first: Words,
    last: Words,
    maximum: Maximum,
}
impl Bounds {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Self {
        Self {
            first: Words::new(device, retired, "latkit bounds first"),
            last: Words::new(device, retired, "latkit bounds last"),
            maximum: Maximum::new(device, retired),
        }
    }

    pub(crate) fn record(
        &mut self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        variant: Variant,
        count: u32,
        output: At<'_>,
    ) {
        if count == 0 {
            return;
        }
        let records = count.div_ceil(SCAN_BLOCK);
        self.first.ensure(raster.device, u64::from(records) * 4);
        self.last.ensure(raster.device, u64::from(records) * 4);
        raster.render(Render {
            variant,
            shared: Some(Shared { view: input.view, mark: input.mark, offset: input.offset }),
            bindings: &[
                wgpu::BindGroupEntry { binding: 0, resource: input.pages.binding() },
                wgpu::BindGroupEntry { binding: 9, resource: input.lists.binding() },
            ],
            uniform: 19,
            step: WordStep { source: 0, other: 0, destination: 0, count, layer: 0, value: 0, size: [0; 2] },
            outputs: &[&self.first, &self.last],
            words: records * 4,
        });
        self.maximum.record(raster, At::new(&self.first, 0), output, records);
        self.maximum.record(raster, At::new(&self.last, 0), At::new(output.words, output.at + 4), records);
    }
}
