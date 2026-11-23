//! The uniforms a frame writes for its shaders: the frame's, the eye's, and each mark's.

use glam::{DMat4, DVec3};

use super::camera::{Projected, split};
use super::marks::Shown;
use super::words::Kept;
use crate::gpu::shaders as wgsl;
use crate::scene::mark::MarkKind;
use crate::{Color, Converge, Grid, Length, Scene, Space, Theme};

fn matrix(m: DMat4) -> [[f32; 4]; 4] {
    m.to_cols_array_2d().map(|c| c.map(|v| v as f32))
}

fn vector(v: DVec3) -> [f32; 4] {
    [v.x as f32, v.y as f32, v.z as f32, 0.0]
}

/// The seconds the sun moves in one step. It crosses the sky by a sixtieth of a degree in a step,
/// which changes no place's daylight (see `lib/daylight.wesl`) by more than about one level of an
/// 8-bit color. So a view playing through time draws its lit marks again once a step, rather than
/// every frame.
const SUN_STEP: f64 = 4.0;

/// The frame uniform for `scene` seen through `projected`, at axis coordinate `at` and `elapsed`
/// seconds on the view's clock. `linear` says the target is sRGB and encodes color itself, so
/// shaders write linear color. Pointer, probe, and focus words start empty. Theme lengths are in
/// CSS pixels.
pub(crate) fn frame(scene: &Scene, projected: &Projected, linear: bool, elapsed: f64, at: f64) -> wgsl::Frame {
    let theme = &scene.theme;
    let (cx, cy) = (split(projected.center[0]), split(projected.center[1]));
    // The sun's position at the earth's daylight instant, advanced by the shown axis coordinate, in
    // steps of `SUN_STEP`.
    let (sun, atmosphere) = match &scene.space {
        Space::Earth(earth) => (
            earth.daylight.map(|t| {
                let seconds = t + if at.is_finite() { at } else { 0.0 };
                crate::scene::sun((seconds / SUN_STEP).round() * SUN_STEP)
            }),
            earth.atmosphere.then(|| theme.earth.atmosphere.to_array()),
        ),
        _ => (None, None),
    };
    // A negative red in the selected color means each row keeps its own color.
    let selected = theme.focus.selected.map_or([-1.0, 0.0, 0.0, 0.9], Color::to_array);
    let mut frame: wgsl::Frame = bytemuck::Zeroable::zeroed();
    frame.center_hi = [cx.0, cy.0];
    frame.center_lo = [cx.1, cy.1];
    // Match the shader's f32 center while evaluating this view-wide basis only once.
    let (latitude_sin, latitude_cos) = (cy.0 + cy.1).to_radians().sin_cos();
    frame.latitude_sin = latitude_sin;
    frame.latitude_cos = latitude_cos;
    frame.globe_radius = latitude_cos.recip();
    frame.pointer = [-1e9, -1e9];
    frame.probe = [-1e9, -1e9];
    // The hover's probe may find any row.
    frame.probe_area = [f32::MIN, f32::MIN, f32::MAX, f32::MAX];
    frame.probe_skip = [wgsl::NONE; 2];
    frame.space = projected.space;
    frame.globe = projected.globe as f32;
    frame.mercator_y = projected.mercator_y as f32;
    frame.elapsed = elapsed as f32;
    frame.glow = theme.focus.glow;
    frame.dim = theme.focus.dim;
    frame.dash = theme.dash;
    // Comet spacing and length keep their own unit. A stroke converts them to pixels as it draws.
    frame.flow_spacing = theme.flow.spacing.value();
    frame.flow_length = theme.flow.length.value();
    frame.flow_width = theme.flow.width;
    frame.flow_unit = match theme.flow.spacing {
        Length::Px(_) => wgsl::FLOW_PX,
        Length::Units(_) => wgsl::FLOW_UNITS,
    };
    // Without parallel edges no lanes are derived, so nothing reads the gap or how they converge.
    let parallel = theme.edge.parallel.unwrap_or_default();
    frame.gap = px(parallel.gap, scene, projected);
    frame.converge = match parallel.converge {
        Converge::Squeeze => wgsl::CONVERGE_SQUEEZE,
        Converge::Fan => wgsl::CONVERGE_FAN,
        Converge::Straight => wgsl::CONVERGE_STRAIGHT,
    };
    // Hover is tracked either way. The controls only decide whether it glows.
    let glows = scene.controls.hover;
    frame.grow = if glows { theme.focus.grow } else { 1.0 };
    frame.arrow = theme.edge.arrow;
    frame.halo = theme.text.halo;
    frame.zoom = projected.zoom as f32;
    frame.linear = u32::from(linear);
    frame.hover = if glows { theme.focus.hover.to_array() } else { [0.0; 4] };
    frame.selected = selected;
    frame.flow = theme.flow.color.to_array();
    frame.background = theme.background.to_array();
    frame.ground = theme.earth.ground.to_array();
    frame.grid_color = theme.grid.color.to_array();
    frame.grid_width = theme.grid.width;
    grid(&mut frame, scene, projected);
    frame.sun = sun.map_or([0.0; 4], |s| [s[0] as f32, s[1] as f32, s[2] as f32, theme.earth.night.clamp(0.0, 1.0)]);
    frame.atmosphere = atmosphere.unwrap_or([0.0; 4]);
    frame.theme = theme_slots(theme);
    frame
}

/// `length` in CSS pixels at the camera's center, where a length in position units follows the zoom.
fn px(length: Length, scene: &Scene, projected: &Projected) -> f32 {
    match length {
        Length::Px(px) => px,
        // On the earth a position unit is a degree, and `px_per_unit` counts radians.
        Length::Units(units) => {
            let degrees = if matches!(scene.space, Space::Earth(_)) { std::f64::consts::PI / 180.0 } else { 1.0 };
            (f64::from(units) * projected.px_per_unit[0] * degrees) as f32
        }
    }
}

/// Sets the grid `frame` draws on `scene`'s ground: its kind, the two steps its lines lie at, how
/// far the finer has faded in, and the camera's center as a fraction of each step.
///
/// The camera's zoom alone picks the steps, so turning or tilting the view changes no line. The
/// finer is the finest step whose lines are the theme's `grid.spacing` apart at the camera's
/// center, and the coarser is the next. The finer fades in as zooming in spreads its lines from
/// that spacing to twice it, so a new step never pops in.
fn grid(frame: &mut wgsl::Frame, scene: &Scene, projected: &Projected) {
    let (grid, earth) = match &scene.space {
        Space::Plane(plane) => (plane.grid, false),
        Space::Earth(earth) => (earth.grid, true),
        Space::Plot(_) => (Grid::Off, false),
    };
    let (kind, step) = match grid {
        Grid::Off => (wgsl::GRID_OFF, None),
        Grid::Lines { step } => (wgsl::GRID_LINES, step),
        Grid::Dots { step } => (wgsl::GRID_DOTS, step),
    };
    let finest = step.filter(|step| step.is_finite() && *step > 0.0).unwrap_or(if earth { 0.01 } else { 10.0 });
    // CSS pixels per position unit at the camera's center: per degree of longitude on the earth.
    // On the earth `px_per_unit` counts radians.
    let px = projected.px_per_unit[0] * if earth { std::f64::consts::PI / 180.0 } else { 1.0 };
    let spacing = f64::from(scene.theme.grid.spacing).max(1.0);
    let fine = grid_step(spacing / px, finest, earth);
    let coarse = grid_step(fine * 1.5, finest, earth);
    let phase = |step: f64| [0, 1].map(|k| (projected.center[k] / step).rem_euclid(1.0) as f32);
    frame.grid_kind = kind;
    frame.grid_step = [fine as f32, coarse as f32];
    frame.grid_fade = ((fine * px / spacing - 1.0).clamp(0.0, 1.0)) as f32;
    frame.grid_phase = [phase(fine)[0], phase(fine)[1], phase(coarse)[0], phase(coarse)[1]];
}

/// The least step of a grid at least `least` position units: `finest` times 1, 2, or 5 and a power
/// of ten. On the earth the steps are those of degrees, with 30° and 90° past 10°, and none finer
/// than `finest`.
fn grid_step(least: f64, finest: f64, earth: bool) -> f64 {
    let round = |x: f64| {
        let decade = 10_f64.powf(x.log10().floor());
        let leading = x / decade;
        decade * [1.0, 2.0, 5.0].into_iter().find(|step| leading <= step * (1.0 + 1e-9)).unwrap_or(10.0)
    };
    if !earth {
        return finest * round((least / finest).max(1.0));
    }
    let degrees = if least <= 10.0 {
        round(least.max(1e-9))
    } else if least <= 30.0 {
        30.0
    } else {
        90.0
    };
    degrees.max(finest)
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
    eye.parallax = projected.parallax as f32;
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
    slots[wgsl::THEME_CORNER as usize] = theme.vertex.corner.to_bits();
    slots[wgsl::THEME_EDGE_HALO as usize] = theme.edge.halo.max(0.0).to_bits();
    slots[wgsl::THEME_LINE_HALO as usize] = theme.line.halo.max(0.0).to_bits();
    std::array::from_fn(|i| std::array::from_fn(|j| slots[i * 4 + j]))
}

/// Sets `mark`'s easing fields: how each word blends, and while it eases, the page tables of its frozen and
/// settled words and its progress on `clock`.
fn ease(mark: &mut wgsl::Mark, shown: &Shown, clock: &super::clock::Clock) {
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

/// The uniform of mark `index`, with its label slots from `labels`, its easing progress from
/// `clock`, and its lengths in CSS pixels at `projected`'s zoom.
pub(crate) fn mark(
    index: usize,
    shown: &Shown,
    labels: &super::labels::Labels,
    clock: &super::clock::Clock,
    scene: &Scene,
    projected: &Projected,
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
    mark.domains = shown.domains;
    mark.columns = shown.offsets.columns;
    mark.ranges = shown.offsets.ranges;
    mark.code = shown.offsets.code;
    mark.constants = shown.offsets.constants;
    mark.ends = shown.offsets.ends;
    [mark.from_state, mark.from_stride] = shown.end_layout(0);
    [mark.to_state, mark.to_stride] = shown.end_layout(1);
    mark.palette = shown.offsets.palette;
    mark.mask = shown.dirty;
    mark.remap = shown.remap;
    mark.focused = shown.lit.at;
    mark.pieces = shown.lit.pieces;
    mark.trace = wgsl::NONE;
    mark.per_row = 1;
    mark.list = shown.segments.list.map_or(wgsl::NONE, |list| list.header);
    mark.height_order = shown.height_order.list.map_or(wgsl::NONE, |list| list.header);
    mark.geometry = wgsl::NONE;
    mark.frozen_geometry = wgsl::NONE;
    mark.lane = wgsl::NONE;
    mark.label = wgsl::NONE;
    mark.number = wgsl::NONE;
    [mark.size_min, mark.size_max] = crate::Size::ANY;
    if let Some(slots) = labels.slots(index) {
        mark.runs = slots.runs;
        mark.label_metadata = slots.metadata;
        mark.label_positions = slots.positions;
    }
    if let Some(compiled) = &shown.compiled {
        let program = &compiled.program;
        let drawing = &compiled.drawing;
        mark.primitive = shown.kind().primitive().code();
        mark.channels = program.channels.len() as u32;
        mark.reductions = program.domains.len() as u32;
        mark.units = program.units;
        mark.flags = drawing.flags;
        if let Some([records, points, rows, capacity, head]) = shown.tables.trace_layout(shown.offsets.columns) {
            mark.trace = records;
            mark.trace_points = points;
            mark.trace_rows = rows;
            mark.trace_capacity = capacity;
            mark.trace_head = head;
        }
        let markers = &drawing.markers;
        mark.marker = markers.marker;
        mark.shape = markers.shape;
        mark.corner = markers.corner;
        // A symbol's stroke takes the place of a pie's hole.
        mark.hole = markers.stroke.map_or(markers.hole, |width| px(width, scene, projected).max(0.0));
        // How many inputs in the low byte, and above it the extra word of the first.
        mark.inputs = markers.inputs | markers.input << 8;
        if let Some(shading) = &drawing.shade {
            mark.shade_inputs = shading.inputs | shading.input << 8;
        }
        mark.geometry = drawing.geometry;
        mark.lane = drawing.lane;
        if shown.transition.is_some() {
            mark.frozen_geometry = shown.tables.frozen().unwrap_or(wgsl::NONE);
        }
        [mark.size_min, mark.size_max] = drawing.size_px;
        if let Some(labeling) = &drawing.label {
            mark.label = labeling.extra;
            mark.label_size = px(labeling.size, scene, projected);
            [mark.label_right, mark.label_down] = labeling.offset.map(|length| px(length, scene, projected));
            mark.number = labeling.number.as_ref().map_or(wgsl::NONE, |(number, _)| *number);
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
        if shown.along_units {
            mark.flags |= wgsl::ALONG_UNITS;
        }
    }
    mark
}
