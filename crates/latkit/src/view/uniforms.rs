//! What a frame tells its shaders: the frame uniform and each mark's uniform.

use super::camera::{Projected, split};
use super::marks::Shown;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Color, Grid, Scene, Space, Theme};

/// The frame uniform for `scene` seen through `projected` in a target of `size` CSS pixels. Pointer,
/// probe, and focus words start empty.
pub(crate) fn frame(
    scene: &Scene,
    projected: &Projected,
    size: [f64; 2],
    pixel_ratio: f32,
    linear: bool,
    elapsed: f64,
) -> wgsl::Frame {
    let theme = &scene.theme;
    let matrix = |m: glam::DMat4| m.to_cols_array_2d().map(|c| c.map(|v| v as f32));
    let vector = |v: glam::DVec3| [v.x as f32, v.y as f32, v.z as f32, 0.0];
    let (cx, cy) = (split(projected.center[0]), split(projected.center[1]));
    let (grid_kind, grid_pitch) = match &scene.space {
        Space::Plane(plane) => match plane.grid {
            Grid::Off => (wgsl::GRID_OFF, 1.0),
            Grid::Lines { pitch } => (wgsl::GRID_LINES, pitch),
            Grid::Dots { pitch, .. } => (wgsl::GRID_DOTS, pitch),
        },
        _ => (wgsl::GRID_OFF, 1.0),
    };
    let (surface, graticule) = match &scene.space {
        Space::Earth(earth) => (earth.surface.unwrap_or(theme.surface), earth.graticule),
        _ => (theme.surface, false),
    };
    // A plane's grid fades out past what the view shows looking straight down.
    let grid_fade = match &scene.space {
        Space::Plane(_) => 1.2 * size[0].hypot(size[1]) / projected.px_per_unit[0],
        _ => 0.0,
    };
    // A negative red asks for each row's own color.
    let selected = theme.selected.map_or([-1.0, 0.0, 0.0, 0.9], Color::to_array);
    let mut frame: wgsl::Frame = bytemuck::Zeroable::zeroed();
    frame.clip_from_world = matrix(projected.clip_from_world);
    frame.world_from_clip = matrix(projected.world_from_clip);
    frame.eye = vector(projected.eye);
    frame.light = vector(projected.light);
    frame.center_hi = [cx.0, cy.0];
    frame.center_lo = [cx.1, cy.1];
    frame.size = [size[0] as f32, size[1] as f32];
    frame.px_per_unit = projected.px_per_unit.map(|v| v as f32);
    frame.pointer = [-1e9, -1e9];
    frame.probe = [-1e9, -1e9];
    frame.pixel_ratio = pixel_ratio;
    frame.space = projected.space;
    frame.globe = projected.globe as f32;
    frame.mercator_y = projected.mercator_y as f32;
    frame.elapsed = elapsed as f32;
    frame.glow = theme.glow;
    frame.dim = theme.dim;
    frame.dash = theme.dash;
    frame.flow_spacing = theme.flow_spacing;
    frame.edge_spacing = 4.0;
    frame.hover_scale = theme.hover_scale;
    frame.shading = theme.shading;
    frame.linear = u32::from(linear);
    frame.hover = theme.hover.to_array();
    frame.selected = selected;
    frame.flow = theme.flow.to_array();
    frame.background = theme.background.to_array();
    frame.surface = surface.to_array();
    frame.grid_color = theme.grid.to_array();
    frame.shadow = theme.shadow.to_array();
    frame.grid_kind = grid_kind;
    frame.grid_pitch = grid_pitch as f32;
    frame.grid_fade = grid_fade as f32;
    frame.graticule = u32::from(graticule);
    frame.theme = theme_slots(theme);
    frame
}

/// The theme's values in slot order: colors packed, sizes as `f32` bits.
fn theme_slots(theme: &Theme) -> [[u32; 4]; 4] {
    let mut slots = [0_u32; wgsl::THEME_SLOTS as usize];
    let edge = theme.edge.unwrap_or(theme.vertex);
    slots[wgsl::THEME_VERTEX as usize] = theme.vertex.packed();
    slots[wgsl::THEME_VERTEX_RADIUS as usize] = theme.vertex_radius.to_bits();
    slots[wgsl::THEME_EDGE as usize] = edge.packed();
    slots[wgsl::THEME_EDGE_WIDTH as usize] = theme.edge_width.to_bits();
    slots[wgsl::THEME_LINE as usize] = theme.line.packed();
    slots[wgsl::THEME_LINE_WIDTH as usize] = theme.line_width.to_bits();
    slots[wgsl::THEME_TEXT as usize] = theme.text.packed();
    slots[wgsl::THEME_MISSING as usize] = theme.missing.packed();
    std::array::from_fn(|i| std::array::from_fn(|j| slots[i * 4 + j]))
}

/// The uniform of mark `index`.
pub(crate) fn mark(index: usize, shown: &Shown) -> wgsl::Mark {
    let mut mark: wgsl::Mark = bytemuck::Zeroable::zeroed();
    mark.index = index as u32;
    mark.kind = match shown.kind() {
        MarkKind::Vertices => wgsl::MARK_VERTICES,
        MarkKind::Edges => wgsl::MARK_EDGES,
        MarkKind::Faces => wgsl::MARK_FACES,
        MarkKind::Lines => wgsl::MARK_LINES,
    };
    mark.rows = shown.rows;
    mark.state = shown.offset;
    mark.previous = wgsl::NONE;
    mark.remap = wgsl::NONE;
    mark.trace = wgsl::NONE;
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
        mark.trace = compiled.drawing.trace;
        let (marker, shape, corner) = compiled.drawing.marker;
        mark.marker = marker;
        mark.shape = shape;
        mark.corner = corner;
    }
    mark
}
