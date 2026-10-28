//! The uniforms a frame writes for its shaders: the frame's, the eye's, and each mark's.

use glam::{DMat4, DVec3};

use super::camera::{Projected, split};
use super::marks::Shown;
use super::words::Kept;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Color, Grid, Length, Scene, Space, Theme};

fn matrix(m: DMat4) -> [[f32; 4]; 4] {
    m.to_cols_array_2d().map(|c| c.map(|v| v as f32))
}

fn vector(v: DVec3) -> [f32; 4] {
    [v.x as f32, v.y as f32, v.z as f32, 0.0]
}

/// The frame uniform for `scene` seen through `projected` in a target of `size` CSS pixels, at axis
/// coordinate `at` and `elapsed` seconds on the view's clock. `linear` says the target is sRGB and
/// encodes color itself, so shaders write linear color. Pointer, probe, and focus words start
/// empty. Theme lengths are in the space's unit, so in a diagram they scale with the zoom. The halo
/// and the focus glow are in CSS pixels everywhere.
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
    let graticule = matches!(&scene.space, Space::Earth(earth) if earth.graticule);
    // The sun's position at the earth's daylight instant, advanced by the shown axis coordinate.
    let (sun, atmosphere) = match &scene.space {
        Space::Earth(earth) => (
            earth.daylight.map(|t| crate::scene::sun(t + if at.is_finite() { at } else { 0.0 })),
            earth.atmosphere.then(|| theme.earth.atmosphere.to_array()),
        ),
        _ => (None, None),
    };
    // A negative red in the selected color means each row keeps its own color.
    let selected = theme.focus.selected.map_or([-1.0, 0.0, 0.0, 0.9], Color::to_array);
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
    frame.glow = theme.focus.glow;
    frame.dim = theme.focus.dim;
    frame.dash = theme.dash * unit;
    // Comet spacing and length keep their own unit. A stroke converts them to pixels as it draws.
    frame.flow_spacing = theme.flow.spacing.value();
    frame.flow_length = theme.flow.length.value();
    frame.flow_width = theme.flow.width * unit;
    frame.flow_unit = match theme.flow.spacing {
        Length::Space(_) => wgsl::FLOW_LENGTHS,
        Length::Units(_) => wgsl::FLOW_UNITS,
        Length::Px(_) => wgsl::FLOW_PX,
    };
    frame.bow = theme.edge.bow;
    // Hover is tracked either way. The controls only decide whether it glows.
    let glows = scene.controls.hover;
    frame.grow = if glows { theme.focus.grow } else { 1.0 };
    frame.shading = theme.shading;
    frame.arrow = theme.edge.arrow * unit;
    frame.halo = theme.text.halo;
    frame.group_padding = theme.diagram.group_padding * unit;
    frame.unit = unit;
    frame.zoom = projected.zoom as f32;
    frame.linear = u32::from(linear);
    frame.hover = if glows { theme.focus.hover.to_array() } else { [0.0; 4] };
    frame.selected = selected;
    frame.flow = theme.flow.color.to_array();
    frame.background = theme.background.to_array();
    frame.ground = theme.earth.ground.to_array();
    frame.grid_color = theme.grid.to_array();
    frame.grid_kind = grid_kind;
    frame.grid_pitch = grid_pitch as f32;
    frame.grid_spacing = theme.grid_spacing;
    frame.grid_fade = grid_fade(scene, projected, size) as f32;
    frame.graticule = u32::from(graticule);
    frame.sun = sun.map_or([0.0; 4], |s| [s[0] as f32, s[1] as f32, s[2] as f32, theme.earth.night.clamp(0.0, 1.0)]);
    frame.atmosphere = atmosphere.unwrap_or([0.0; 4]);
    frame.theme = theme_slots(theme);
    frame.shadow = theme.diagram.shadow.color.to_array();
    frame
}

/// The world distance from the center at which a plane's grid has faded out: a bit more than the
/// view shows looking straight down. 0 on a plot or the globe.
pub(crate) fn grid_fade(scene: &Scene, projected: &Projected, size: [f64; 2]) -> f64 {
    match &scene.space {
        Space::Plot(_) => 0.0,
        Space::Earth(_) if projected.globe >= 0.5 => 0.0,
        _ => 1.2 * size[0].hypot(size[1]) / projected.px_per_unit[0],
    }
}

/// The eye uniform: `projected` into a target of `size` CSS pixels at `pixel_ratio`.
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

/// The theme's values in slot order: colors packed, sizes as `f32` bits.
fn theme_slots(theme: &Theme) -> [[u32; 4]; 4] {
    let mut slots = [0_u32; wgsl::THEME_SLOTS as usize];
    let edge = theme.edge.color.unwrap_or(theme.vertex.color);
    slots[wgsl::THEME_VERTEX as usize] = theme.vertex.color.packed();
    slots[wgsl::THEME_VERTEX_RADIUS as usize] = theme.vertex.radius.to_bits();
    slots[wgsl::THEME_EDGE as usize] = edge.packed();
    slots[wgsl::THEME_EDGE_WIDTH as usize] = theme.edge.width.to_bits();
    slots[wgsl::THEME_LINE as usize] = theme.line.color.packed();
    slots[wgsl::THEME_LINE_WIDTH as usize] = theme.line.width.to_bits();
    slots[wgsl::THEME_AREA as usize] = theme.area.color.packed();
    slots[wgsl::THEME_TEXT as usize] = theme.text.color.packed();
    slots[wgsl::THEME_MISSING as usize] = theme.missing.packed();
    slots[wgsl::THEME_CLEAR as usize] = 0;
    slots[wgsl::THEME_GROUP as usize] = theme.diagram.group.packed();
    slots[wgsl::THEME_OUTLINE as usize] = theme.diagram.outline.map_or(0, Color::packed);
    slots[wgsl::THEME_CORNER as usize] = theme.diagram.corner.to_bits();
    slots[wgsl::THEME_PORT_SIZE as usize] = theme.diagram.port_size.to_bits();
    slots[wgsl::THEME_LIFT as usize] = theme.diagram.shadow.lift.to_bits();
    std::array::from_fn(|i| std::array::from_fn(|j| slots[i * 4 + j]))
}

/// Sets `mark`'s evaluation and easing fields: where the row-block lists of this frame's evaluation
/// and end pass start, how each word blends, and while it eases, the page tables of its frozen and
/// settled words and its progress on `clock`.
fn ease(mark: &mut wgsl::Mark, shown: &Shown, clock: &super::clock::Clock) {
    mark.block = shown.block;
    mark.end_block = shown.end_block;
    mark.blends = shown.offsets.blends;
    mark.frozen = wgsl::NONE;
    mark.settled = wgsl::NONE;
    mark.motion = 1.0;
    if let Some(transition) = &shown.transition {
        mark.frozen = shown.offsets.table(Kept::Frozen);
        mark.settled = shown.offsets.table(Kept::Settled);
        mark.motion = transition.motion(clock);
    }
}

/// The uniform of mark `index`, with its label slots from `labels` and its easing progress from
/// `clock`.
pub(crate) fn mark(
    index: usize,
    shown: &Shown,
    labels: &super::labels::Labels,
    clock: &super::clock::Clock,
) -> wgsl::Mark {
    let mut mark: wgsl::Mark = bytemuck::Zeroable::zeroed();
    mark.index = index as u32;
    mark.kind = shown.kind().code();
    mark.rows = shown.rows;
    mark.exits = shown.exits;
    mark.held = shown.held();
    mark.row_runs = shown.offsets.runs;
    mark.drawn = shown.drawn_rows.at.map_or(wgsl::NONE, |[start, _]| start);
    mark.reveal = shown.reveal;
    mark.state = shown.offsets.table(Kept::State);
    mark.stride = shown.stride();
    mark.extras = shown.extras();
    ease(&mut mark, shown, clock);
    mark.focus = shown.offsets.table(Kept::Focus);
    mark.normals = shown.offsets.table(Kept::Normals);
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
    [mark.size_min, mark.size_max] = crate::Size::ANY;
    if let Some(slots) = labels.slots(index) {
        mark.runs = slots.runs;
        mark.wanted = slots.wanted;
        mark.seen = slots.seen;
    }
    if let Some(compiled) = &shown.compiled {
        let program = &compiled.program;
        let drawing = &compiled.drawing;
        mark.primitive = shown.kind().primitive().code();
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
        [mark.size_min, mark.size_max] = drawing.size_px;
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
