//! What a frame tells its shaders: the frame uniform, the eyes its passes draw through, and each
//! mark's uniform.

use glam::{DMat4, DVec3, DVec4};

use super::camera::{Projected, split};
use super::marks::Shown;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Color, Grid, Scene, Space, Theme};

fn matrix(m: DMat4) -> [[f32; 4]; 4] {
    m.to_cols_array_2d().map(|c| c.map(|v| v as f32))
}

fn vector(v: DVec3) -> [f32; 4] {
    [v.x as f32, v.y as f32, v.z as f32, 0.0]
}

/// The frame uniform for `scene` seen through `projected` in a target of `size` CSS pixels, showing
/// axis coordinate `at`, `elapsed` seconds of motion into the view's clock. Pointer, probe, focus,
/// and shade words start empty. In a diagram every length but glow and halo is a unit, so the
/// theme's lengths scale with the zoom.
pub(crate) fn frame(
    scene: &Scene,
    projected: &Projected,
    size: [f64; 2],
    linear: bool,
    elapsed: f64,
    at: f64,
) -> wgsl::Frame {
    let theme = &scene.theme;
    let (cx, cy) = (split(projected.center[0]), split(projected.center[1]));
    let grid = match &scene.space {
        Space::Plane(plane) => plane.grid,
        Space::Diagram(diagram) => diagram.grid,
        Space::Earth(_) | Space::Plot(_) => Grid::Off,
    };
    let (grid_kind, grid_pitch) = match grid {
        Grid::Off => (wgsl::GRID_OFF, 1.0),
        Grid::Lines { pitch } => (wgsl::GRID_LINES, pitch),
        Grid::Dots { pitch, .. } => (wgsl::GRID_DOTS, pitch),
    };
    let unit = if projected.space == wgsl::SPACE_DIAGRAM { projected.px_per_unit[0] as f32 } else { 1.0 };
    let (surface, graticule) = match &scene.space {
        Space::Earth(earth) => (earth.surface.unwrap_or(theme.surface), earth.graticule),
        _ => (theme.surface, false),
    };
    // The sun stands where it does at the earth's daylight instant, on by the axis coordinate shown.
    let (sun, atmosphere) = match &scene.space {
        Space::Earth(earth) => (
            earth.daylight.map(|t| crate::scene::sun(t + if at.is_finite() { at } else { 0.0 })),
            earth.atmosphere.then(|| theme.atmosphere.to_array()),
        ),
        _ => (None, None),
    };
    // A selected color with a negative red asks for each row's own color.
    let selected = theme.selected.map_or([-1.0, 0.0, 0.0, 0.9], Color::to_array);
    let mut frame: wgsl::Frame = bytemuck::Zeroable::zeroed();
    frame.light = vector(projected.light);
    frame.center_hi = [cx.0, cy.0];
    frame.center_lo = [cx.1, cy.1];
    frame.pointer = [-1e9, -1e9];
    frame.probe = [-1e9, -1e9];
    frame.space = projected.space;
    frame.globe = projected.globe as f32;
    frame.mercator_y = projected.mercator_y as f32;
    frame.elapsed = elapsed as f32;
    frame.glow = theme.glow;
    frame.dim = theme.dim;
    frame.dash = theme.dash * unit;
    frame.flow_spacing = theme.flow_spacing * unit;
    frame.lane_bow = theme.lane_bow;
    frame.hover_scale = theme.hover_scale;
    frame.shading = theme.shading;
    frame.arrow = theme.arrow * unit;
    frame.halo = theme.halo;
    frame.group_padding = theme.group_padding * unit;
    frame.unit = unit;
    frame.zoom = projected.zoom as f32;
    frame.linear = u32::from(linear);
    frame.hover = theme.hover.to_array();
    frame.selected = selected;
    frame.flow = theme.flow.to_array();
    frame.background = theme.background.to_array();
    frame.surface = surface.to_array();
    frame.grid_color = theme.grid.to_array();
    frame.grid_kind = grid_kind;
    frame.grid_pitch = grid_pitch as f32;
    frame.grid_fade = grid_fade(scene, projected, size) as f32;
    frame.graticule = u32::from(graticule);
    frame.sun = sun.map_or([0.0; 4], |s| [s[0] as f32, s[1] as f32, s[2] as f32, theme.night.clamp(0.0, 1.0)]);
    frame.atmosphere = atmosphere.unwrap_or([0.0; 4]);
    frame.theme = theme_slots(theme);
    frame.shade.color = theme.shadow.color.to_array();
    frame
}

/// The world distance from the center a plane's grid fades out by: what the view shows looking
/// straight down, and a little more. Shadows cover the same ground.
pub(crate) fn grid_fade(scene: &Scene, projected: &Projected, size: [f64; 2]) -> f64 {
    match &scene.space {
        Space::Plot(_) => 0.0,
        Space::Earth(_) if projected.globe >= 0.5 => 0.0,
        _ => 1.2 * size[0].hypot(size[1]) / projected.px_per_unit[0],
    }
}

/// The eye of the view: `projected` into a target of `size` CSS pixels at `pixel_ratio`.
pub(crate) fn eye(projected: &Projected, size: [f64; 2], pixel_ratio: f32) -> wgsl::Eye {
    let mut eye: wgsl::Eye = bytemuck::Zeroable::zeroed();
    eye.clip_from_world = matrix(projected.clip_from_world);
    eye.world_from_clip = matrix(projected.world_from_clip);
    eye.position = vector(projected.eye);
    eye.size = [size[0] as f32, size[1] as f32];
    eye.px_per_unit = projected.px_per_unit.map(|v| v as f32);
    eye.pixel_ratio = pixel_ratio;
    eye
}

/// The light's eye, looking down along `light` onto the square of ground `rect` (least x, y, greatest
/// x, y, world units), and the casters' lift in world units. Its CSS pixels are the view's: a
/// marker's quad keeps its size across the map.
pub(crate) fn light_eye(view: &wgsl::Eye, light: DVec3, rect: [f64; 4], lift: f64, texels: u32) -> wgsl::Eye {
    let [x0, y0, x1, y1] = rect;
    let (sx, sy) = (2.0 / (x1 - x0), 2.0 / (y1 - y0));
    let tilt = -light.truncate() / light.z.max(1e-3);
    // Ground point along the light, mapped to clip space; z lifted first.
    let cast = DMat4::from_cols(
        DVec4::new(sx, 0.0, 0.0, 0.0),
        DVec4::new(0.0, sy, 0.0, 0.0),
        DVec4::new(tilt.x * sx, tilt.y * sy, 0.0, 0.0),
        DVec4::new(-1.0 - x0 * sx, -1.0 - y0 * sy, 0.5, 1.0),
    ) * DMat4::from_translation(DVec3::new(0.0, 0.0, lift));
    let texels_per_unit = f64::from(texels) / (x1 - x0);
    let px = texels_per_unit / f64::from(view.px_per_unit[0]).max(1e-30);
    let mut eye = *view;
    eye.clip_from_world = matrix(cast);
    eye.world_from_clip = matrix(DMat4::IDENTITY);
    eye.size = [(f64::from(texels) / px) as f32; 2];
    eye.pixel_ratio = px as f32;
    eye.lift = lift as f32;
    eye
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
    slots[wgsl::THEME_AREA as usize] = theme.area.packed();
    slots[wgsl::THEME_TEXT as usize] = theme.text.packed();
    slots[wgsl::THEME_MISSING as usize] = theme.missing.packed();
    slots[wgsl::THEME_CLEAR as usize] = 0;
    slots[wgsl::THEME_SURFACE as usize] = theme.surface.packed();
    std::array::from_fn(|i| std::array::from_fn(|j| slots[i * 4 + j]))
}

/// The uniform of mark `index`, easing by `clock`.
pub(crate) fn mark(
    index: usize,
    shown: &Shown,
    labels: Option<super::labels::Slots>,
    clock: &super::clock::Clock,
) -> wgsl::Mark {
    let mut mark: wgsl::Mark = bytemuck::Zeroable::zeroed();
    let region = &shown.region;
    mark.index = index as u32;
    mark.kind = match shown.kind() {
        MarkKind::Vertices => wgsl::MARK_VERTICES,
        MarkKind::Edges => wgsl::MARK_EDGES,
        MarkKind::Faces => wgsl::MARK_FACES,
        MarkKind::Lines => wgsl::MARK_LINES,
        MarkKind::Areas => wgsl::MARK_AREAS,
    };
    mark.rows = shown.rows;
    mark.exits = shown.exits;
    mark.state = region.state;
    mark.stride = shown.stride();
    mark.extra = region.extra;
    mark.extras = shown.extras();
    mark.frozen = wgsl::NONE;
    mark.frozen_extra = wgsl::NONE;
    mark.motion = 1.0;
    if let Some(transition) = &shown.transition {
        mark.frozen = region.state;
        mark.frozen_extra = region.extra;
        mark.motion = transition.motion(clock);
    }
    mark.focus = region.focus;
    mark.domains = shown.domains;
    mark.columns = shown.offsets.columns;
    mark.ranges = shown.offsets.ranges;
    mark.code = shown.offsets.code;
    mark.constants = shown.offsets.constants;
    mark.ends = shown.offsets.ends;
    mark.palette = shown.offsets.palette;
    mark.port_info = shown.offsets.port_info;
    mark.ports = shown.port_count();
    mark.mask = shown.dirty;
    mark.remap = shown.remap;
    mark.focused = shown.lit.at;
    mark.focused_rows = shown.lit.rows;
    mark.pieces = shown.lit.pieces;
    mark.trace = wgsl::NONE;
    mark.per_row = 1;
    mark.list = shown.segments.list.map_or(wgsl::NONE, |list| list.header);
    mark.query = shown.query;
    mark.geometry = wgsl::NONE;
    mark.frozen_geometry = wgsl::NONE;
    mark.lane = wgsl::NONE;
    mark.label = wgsl::NONE;
    if let Some(slots) = labels {
        mark.candidates = slots.candidates;
        mark.runs = slots.runs;
        mark.wanted = slots.wanted;
        mark.seen = slots.seen;
        mark.label_id = slots.id;
    }
    if let Some(compiled) = &shown.compiled {
        let program = &compiled.program;
        let drawing = &compiled.drawing;
        mark.primitive = drawing.primitive.code();
        mark.channels = program.channels.len() as u32;
        mark.reductions = program.domains.len() as u32;
        mark.units = program.units;
        mark.flags = drawing.flags;
        mark.trace = drawing.trace;
        let markers = &drawing.markers;
        mark.marker = markers.marker;
        mark.shape = markers.shape;
        mark.corner = markers.corner;
        mark.hole = markers.hole;
        mark.inputs = markers.inputs;
        mark.input = markers.input;
        mark.geometry = drawing.geometry;
        mark.lane = drawing.lane;
        if shown.transition.is_some() {
            mark.frozen_geometry = shown.tables.frozen().unwrap_or(wgsl::NONE);
        }
        mark.port_label_size = drawing.port_label_size;
        if let Some(labeling) = &drawing.label {
            mark.label = labeling.extra;
            mark.label_size = labeling.size;
        }
        if shown.kind() == MarkKind::Lines {
            mark.per_row = shown.segments_per_row();
        }
        if shown.segments.list.is_some() {
            mark.per_row = wgsl::NONE;
        }
        if shown.geodesic {
            mark.flags |= wgsl::GEODESIC;
        }
    }
    mark
}
