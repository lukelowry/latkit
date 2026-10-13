//! What a frame tells its shaders: the frame uniform and each mark's uniform.

use super::camera::{Camera, Projected, split};
use super::marks::Shown;
use crate::gpu::shaders as wgsl;
use crate::{Color, Grid, Projection, Scene, Space, Theme};

/// The frame uniform for `scene` seen through `camera` in a target of `size` CSS pixels.
pub(crate) fn frame(
    scene: &Scene,
    camera: &Camera,
    size: [f64; 2],
    pixel_ratio: f32,
    linear: bool,
    elapsed: f64,
) -> wgsl::Frame {
    let theme = &scene.theme;
    let globe = match &scene.space {
        Space::Earth(earth) => f64::from(u8::from(earth.projection == Projection::Globe)),
        _ => 0.0,
    };
    let projection = Projected::new(&scene.space, camera, size, globe);
    let matrix = |m: glam::DMat4| m.to_cols_array_2d().map(|c| c.map(|v| v as f32));
    let (cx, cy) = (split(projection.center[0]), split(projection.center[1]));
    let (grid_kind, grid_pitch) = match &scene.space {
        Space::Plane(plane) => match plane.grid {
            Grid::Off => (wgsl::GRID_OFF, 1.0),
            Grid::Lines { pitch } => (wgsl::GRID_LINES, pitch),
            Grid::Dots { pitch, .. } => (wgsl::GRID_DOTS, pitch),
        },
        _ => (wgsl::GRID_OFF, 1.0),
    };
    let surface = match &scene.space {
        Space::Earth(earth) => earth.surface.unwrap_or(theme.surface),
        _ => theme.surface,
    };
    // A negative red asks for each row's own color.
    let selected = theme.selected.map_or([-1.0, 0.0, 0.0, 0.9], Color::to_array);
    wgsl::Frame {
        clip_from_world: matrix(projection.clip_from_world),
        world_from_clip: matrix(projection.clip_from_world.inverse()),
        center_hi: [cx.0, cy.0],
        center_lo: [cx.1, cy.1],
        size: [size[0] as f32, size[1] as f32],
        px_per_unit: projection.px_per_unit.map(|v| v as f32),
        pointer: [-1e9, -1e9],
        pick_origin: [0.0, 0.0],
        pixel_ratio,
        space: projection.space,
        globe: projection.globe as f32,
        mercator_y: projection.mercator_y as f32,
        pick_scale: 1.0,
        pick_radius: 0.0,
        elapsed: elapsed as f32,
        selecting: 0,
        glow: theme.glow,
        dim: theme.dim,
        dash: theme.dash,
        flow_spacing: theme.flow_spacing,
        edge_spacing: 4.0,
        hover_scale: theme.hover_scale,
        linear: u32::from(linear),
        _pad0: [0],
        hover: theme.hover.to_array(),
        selected,
        flow: theme.flow.to_array(),
        background: theme.background.to_array(),
        surface: surface.to_array(),
        grid_color: theme.grid.to_array(),
        grid_kind,
        grid_pitch: grid_pitch as f32,
        grid_pad0: 0.0,
        grid_pad1: 0.0,
        theme: theme_slots(theme),
    }
}

/// The theme's values in slot order: colors packed, sizes as `f32` bits.
fn theme_slots(theme: &Theme) -> [[u32; 4]; 4] {
    let mut slots = [0_u32; wgsl::THEME_SLOTS as usize];
    let edge = theme.edge.unwrap_or(theme.vertex);
    slots[wgsl::THEME_VERTEX as usize] = theme.vertex.packed();
    slots[wgsl::THEME_VERTEX_RADIUS as usize] = theme.vertex_radius.to_bits();
    slots[wgsl::THEME_EDGE as usize] = edge.packed();
    slots[wgsl::THEME_EDGE_WIDTH as usize] = theme.edge_width.to_bits();
    slots[wgsl::THEME_MISSING as usize] = theme.missing.packed();
    std::array::from_fn(|i| std::array::from_fn(|j| slots[i * 4 + j]))
}

/// The uniform of mark `index`.
pub(crate) fn mark(index: usize, shown: &Shown) -> wgsl::Mark {
    let mut mark: wgsl::Mark = bytemuck::Zeroable::zeroed();
    mark.index = index as u32;
    mark.rows = shown.rows;
    mark.state = shown.offset;
    mark.previous = wgsl::NONE;
    mark.remap = wgsl::NONE;
    mark.focus = shown.focus;
    mark.domains = shown.domains;
    mark.columns = shown.offsets.columns;
    mark.ranges = shown.offsets.ranges;
    mark.code = shown.offsets.code;
    mark.constants = shown.offsets.constants;
    mark.ends = shown.offsets.ends;
    mark.motion = 1.0;
    mark.mask = shown.dirty;
    if let Some(compiled) = &shown.compiled {
        let program = &compiled.program;
        mark.stride = compiled.drawing.stride;
        mark.channels = program.channels.len() as u32;
        mark.reductions = program.domains.len() as u32;
        mark.units = program.units;
        mark.flags = compiled.drawing.flags;
        let (marker, shape, corner) = compiled.drawing.marker;
        mark.marker = marker;
        mark.shape = shape;
        mark.corner = corner;
    }
    mark
}
