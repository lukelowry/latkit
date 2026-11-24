//! Screen-space stroke records shared by drawing, labels, and queries in one frame.
//! Each producer writes before its consumers. Views and captures can reuse the same texture.

use super::listing::Inputs;
use super::pipelines::Variant;
use super::raster::Raster;
use super::retired::Retired;
use super::shaders::{self, WORD_HEIGHT, WORD_WIDTH, WordStep};

#[derive(Clone, Copy, Default)]
pub(crate) enum StrokeRead {
    #[default]
    Empty,
    Paint(u32),
    Segments(u32),
    Anchors(u32),
    One(u32),
}

impl StrokeRead {
    pub(crate) fn address(self) -> (u32, u32) {
        match self {
            Self::Paint(first) => (first, shaders::READ_PAINT),
            Self::Segments(first) => (first, shaders::READ_SEGMENTS),
            Self::Anchors(first) => (first, shaders::READ_ANCHORS),
            Self::One(first) => (first, shaders::READ_ONE),
            Self::Empty => (0, shaders::READ_EMPTY),
        }
    }
}

/// Paint takes four consecutive RGBA texels and a query centerline takes two. A frame
/// allocates paint first, then only the compact spans its consumers need.
pub(crate) struct Screen {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    /// Each layer as a render target.
    layers: Vec<wgpu::TextureView>,
    /// Texels across and down each layer.
    size: [u32; 2],
    /// Incremented whenever the texture is replaced, so the pass groups binding it are rebuilt.
    pub(crate) generation: u64,
    retired: Retired,
}

impl Screen {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Self {
        let (texture, size) = make(device, 1);
        Self { view: view(&texture), layers: layers(&texture), texture, size, generation: 0, retired: retired.clone() }
    }

    /// Reserves four texels per paint record and two per query span.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, records: u32, spans: u32) {
        let records = records + spans.div_ceil(2);
        if records <= self.capacity() {
            return;
        }
        let (texture, size) = make(device, records);
        self.view = view(&texture);
        self.layers = layers(&texture);
        self.size = size;
        self.retired.retire(std::mem::replace(&mut self.texture, texture));
        self.generation += 1;
    }

    fn capacity(&self) -> u32 {
        self.per_layer() / 4 * self.texture.depth_or_array_layers()
    }

    pub(crate) fn binding(&self) -> wgpu::BindingResource<'_> {
        wgpu::BindingResource::TextureView(&self.view)
    }

    fn per_layer(&self) -> u32 {
        self.size[0] * self.size[1]
    }

    pub(crate) fn place(
        &self,
        raster: &mut Raster<'_>,
        input: &Inputs<'_>,
        variant: Variant,
        [start, count, at]: [u32; 3],
        mode: u32,
    ) {
        let shader = variant.shader();
        let layout = raster.pipelines.pass_layout(raster.device, shader);
        let pipeline = raster.pipelines.render(raster.device, variant);
        let stride = if mode < shaders::PLACE_SPANS { 4 } else { 2 };
        let per = self.per_layer() / stride;
        let mut first = 0;
        while first < count {
            let slot = at + first;
            let layer = slot / per;
            let points = (count - first).min(per - slot % per);
            let step = WordStep {
                source: start + first,
                destination: (slot % per) * stride,
                size: self.size,
                value: mode,
                ..WordStep::of(points)
            };
            let uniform = raster.queue.uniform(raster.device, bytemuck::bytes_of(&step));
            let entries: Vec<wgpu::BindGroupEntry<'_>> = shader
                .source()
                .pass
                .iter()
                .map(|binding| wgpu::BindGroupEntry {
                    binding: binding.slot,
                    resource: match binding.slot {
                        0 => input.pages.binding(),
                        9 => input.lists.binding(),
                        19 => uniform.as_entire_binding(),
                        other => unreachable!("no resource for the screen pass's binding {other}"),
                    },
                })
                .collect();
            let bindings = raster.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(shader.source().label),
                layout: &layout,
                entries: &entries,
            });
            let attachments = [Some(wgpu::RenderPassColorAttachment {
                view: &self.layers[layer as usize],
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })];
            let mut pass = raster.encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some(shader.source().label),
                color_attachments: &attachments,
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, input.view, &[]);
            pass.set_bind_group(1, input.mark, &[input.offset]);
            pass.set_bind_group(2, &bindings, &[]);
            pass.draw(0..3, 0..step.count);
            first += points;
        }
    }
}

/// Packs records into power-of-two rows. Additional layers start once a layer reaches `WORD_HEIGHT`.
fn make(device: &wgpu::Device, records: u32) -> (wgpu::Texture, [u32; 2]) {
    let width = records.max(1).next_power_of_two().min(WORD_WIDTH / 4);
    let rows = records.max(1).div_ceil(width);
    let height = rows.next_power_of_two().min(WORD_HEIGHT);
    let groups = rows.div_ceil(height);
    let desc = wgpu::TextureDescriptor {
        label: Some("latkit screen"),
        size: wgpu::Extent3d { width: width * 4, height, depth_or_array_layers: groups },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Uint,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    };
    #[cfg(target_arch = "wasm32")]
    let texture = super::gl::array_texture(device, &desc);
    #[cfg(not(target_arch = "wasm32"))]
    let texture = device.create_texture(&desc);
    (texture, [width * 4, height])
}

fn view(texture: &wgpu::Texture) -> wgpu::TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    })
}

fn layers(texture: &wgpu::Texture) -> Vec<wgpu::TextureView> {
    (0..texture.depth_or_array_layers())
        .map(|layer| {
            texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2),
                base_array_layer: layer,
                array_layer_count: Some(1),
                ..Default::default()
            })
        })
        .collect()
}

impl Drop for Screen {
    fn drop(&mut self) {
        self.retired.retire(self.texture.clone());
    }
}
