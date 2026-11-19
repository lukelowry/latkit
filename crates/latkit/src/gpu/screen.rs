//! The screen store: where each instance of a stroke or point mark a frame draws lies on screen. The
//! frame writes an instance's record once, before it draws the mark, and every draw of the mark
//! reads it (see `lib/screen.wesl`). A record is one texel in each layer of a group of four, at the
//! same place, so one point's fragment writes it whole. Each frame writes the records it draws
//! before the draws that read them, so the store keeps nothing when it grows, and serves every view.

use super::listing::Inputs;
use super::pipelines::Variant;
use super::raster::Raster;
use super::retired::Retired;
use super::shaders::{WORD_HEIGHT, WORD_WIDTH, WordStep};

/// Texels in a record, one in each layer of its group.
const RECORD_TEXELS: u32 = 4;

pub(crate) struct Screen {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    /// The records a layer holds across and down.
    size: [u32; 2],
    /// Incremented whenever the texture is replaced, so the pass groups binding it are rebuilt.
    pub(crate) generation: u64,
    retired: Retired,
}

impl Screen {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Screen {
        let (texture, size) = make(device, 1);
        Screen { view: view(&texture), texture, size, generation: 0, retired: retired.clone() }
    }

    /// Makes room for `records` records.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, records: u32) {
        if records <= self.capacity() {
            return;
        }
        let (texture, size) = make(device, records);
        self.view = view(&texture);
        self.size = size;
        self.retired.retire(std::mem::replace(&mut self.texture, texture));
        self.generation += 1;
    }

    fn capacity(&self) -> u32 {
        self.size[0] * self.size[1] * (self.texture.depth_or_array_layers() / RECORD_TEXELS)
    }

    pub(crate) fn binding(&self) -> wgpu::BindingResource<'_> {
        wgpu::BindingResource::TextureView(&self.view)
    }

    /// Writes the records of the first `count` instances of the mark `input` draws, from record
    /// `at`, with `variant`: a point per instance, one pass for each group of layers they reach.
    pub(crate) fn place(&self, raster: &mut Raster<'_>, input: &Inputs<'_>, variant: Variant, count: u32, at: u32) {
        let shader = variant.shader();
        let layout = raster.pipelines.pass_layout(raster.device, shader);
        let pipeline = raster.pipelines.render(raster.device, variant);
        let per = self.size[0] * self.size[1];
        let mut first = 0;
        while first < count {
            let (group, texel) = ((at + first) / per, (at + first) % per);
            let points = (count - first).min(per - texel);
            let step = WordStep { source: first, destination: texel, size: self.size, ..WordStep::of(points) };
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
            let layers: Vec<wgpu::TextureView> = (0..RECORD_TEXELS)
                .map(|k| {
                    self.texture.create_view(&wgpu::TextureViewDescriptor {
                        dimension: Some(wgpu::TextureViewDimension::D2),
                        base_array_layer: group * RECORD_TEXELS + k,
                        array_layer_count: Some(1),
                        ..Default::default()
                    })
                })
                .collect();
            let attachments: Vec<Option<wgpu::RenderPassColorAttachment<'_>>> = layers
                .iter()
                .map(|view| {
                    Some(wgpu::RenderPassColorAttachment {
                        view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                    })
                })
                .collect();
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
            pass.draw(0..points, 0..1);
            first += points;
        }
    }
}

/// A store holding `records` records, and the records a layer holds across and down: a power of two
/// of them in one row, or rows of the word textures' width, as many as a power of two needs, in
/// groups of at most their height.
fn make(device: &wgpu::Device, records: u32) -> (wgpu::Texture, [u32; 2]) {
    let width = records.max(1).next_power_of_two().min(WORD_WIDTH);
    let rows = records.max(1).div_ceil(width);
    let height = rows.next_power_of_two().min(WORD_HEIGHT);
    let groups = rows.div_ceil(height);
    let desc = wgpu::TextureDescriptor {
        label: Some("latkit screen"),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: groups * RECORD_TEXELS },
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
    (texture, [width, height])
}

fn view(texture: &wgpu::Texture) -> wgpu::TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    })
}

impl Drop for Screen {
    fn drop(&mut self) {
        self.retired.retire(self.texture.clone());
    }
}
