//! Screen-space stroke records shared by drawing, labels, and queries in one frame.
//! Each producer writes before its consumers. Views and captures can reuse the same texture.

use super::listing::Inputs;
use super::pipelines::Variant;
use super::raster::{Draw, Raster, Shared};
use super::retired::Retired;
use super::shaders::{self, WORD_HEIGHT, WORD_WIDTH, WordStep};
use super::words::Words;

#[derive(Clone, Copy, Default)]
pub(crate) enum StrokeRead {
    #[default]
    Empty,
    Paint(u32),
    Segments(u32),
    Anchors(u32),
    One(u32),
    Trace(u32),
}

impl StrokeRead {
    pub(crate) fn address(self) -> (u32, u32) {
        match self {
            Self::Paint(first) => (first, shaders::READ_PAINT),
            Self::Segments(first) => (first, shaders::READ_SEGMENTS),
            Self::Anchors(first) => (first, shaders::READ_ANCHORS),
            Self::One(first) => (first, shaders::READ_ONE),
            Self::Trace(_) | Self::Empty => (0, shaders::READ_EMPTY),
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
    #[cfg(target_arch = "wasm32")]
    pub(crate) cache: super::gl::PlacementCache,
}

impl Screen {
    pub(crate) fn new(device: &wgpu::Device, retired: &Retired) -> Self {
        let (texture, size) = make(device, 1);
        Self {
            view: view(&texture),
            layers: layers(&texture),
            texture,
            size,
            generation: 0,
            #[cfg(target_arch = "wasm32")]
            cache: super::gl::PlacementCache::default(),
            retired: retired.clone(),
        }
    }

    /// Reserves four texels per paint record, two per query span and one per trace sample.
    pub(crate) fn fit(&mut self, device: &wgpu::Device, records: u32, spans: u32, samples: u32) {
        let records = records + (spans * 2 + samples).div_ceil(4);
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
        (scratch, page_bytes): (&mut Words, u32),
    ) {
        let shader = variant.shader();
        let stride = if shader == shaders::Shader::TracePoints {
            1
        } else if mode < shaders::PLACE_SPANS {
            4
        } else {
            2
        };
        let per = self.per_layer() / stride;
        let mut first = 0;
        while first < count {
            let slot = at + first;
            let layer = slot / per;
            let left = (count - first).min(per - slot % per);
            let (points, base) = if shader == shaders::Shader::ScreenProjected {
                project_page(raster, input, (scratch, page_bytes), mode, [start, count, first, left])
            } else {
                (left, 0)
            };
            let step = WordStep {
                source: start + first,
                other: base,
                destination: (slot % per) * stride,
                size: self.size,
                value: mode,
                ..WordStep::of(points)
            };
            raster.draw(Draw {
                variant,
                shared: Some(Shared { view: input.view, mark: input.mark, offset: input.offset }),
                bindings: &[
                    wgpu::BindGroupEntry { binding: 0, resource: input.pages.binding() },
                    wgpu::BindGroupEntry { binding: 9, resource: input.lists.binding() },
                    wgpu::BindGroupEntry { binding: 18, resource: scratch.binding() },
                ],
                uniform: 19,
                step,
                target: &self.layers[layer as usize],
                vertices: 3,
                instances: points,
                clear: false,
            });
            first += points;
        }
    }
}

/// Projects the points for a batch plus its adjoining segments. Returns how many
/// segments fit and which source slot starts the scratch page.
fn project_page(
    raster: &mut Raster<'_>,
    input: &Inputs<'_>,
    (scratch, page_bytes): (&mut Words, u32),
    mode: u32,
    [start, count, first, points]: [u32; 4],
) -> (u32, u32) {
    let dense = matches!(mode, shaders::PLACE_ROWS | shaders::PLACE_SPANS);
    let slots = if dense { 3 } else { 6 };
    // Reuse list-building scratch. Five segment slots fit one segment and its two neighbors on each side.
    let words = if input.path == shaders::PATH_BENDS { 16 } else { 8 };
    let capacity = (page_bytes / (4 * words * slots)).max(5);
    let points = points.min(capacity - 4);
    let lo = if dense { first.saturating_sub(2) } else { first };
    let hi = if dense { (first + points).saturating_add(2) } else { first + points };
    let base = start + lo;
    let entries = (hi - lo) * slots;
    scratch.ensure(raster.device, u64::from(entries) * u64::from(words));
    let texture = scratch.texture();
    raster.draw(Draw {
        variant: Variant::raster(shaders::Shader::Project, "point").path(input.path).projection(input.projection),
        shared: Some(Shared { view: input.view, mark: input.mark, offset: input.offset }),
        bindings: &[
            wgpu::BindGroupEntry { binding: 0, resource: input.pages.binding() },
            wgpu::BindGroupEntry { binding: 9, resource: input.lists.binding() },
        ],
        uniform: 19,
        step: WordStep {
            source: base,
            other: start + count - 1,
            value: mode,
            size: [texture.width(), texture.height()],
            ..WordStep::of(hi - lo)
        },
        target: &scratch.attachment(0),
        vertices: 3,
        instances: entries,
        clear: false,
    });
    (points, base)
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
