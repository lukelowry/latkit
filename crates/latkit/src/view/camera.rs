use std::f64::consts::{PI, TAU};

use glam::{DMat4, DVec2, DVec3, DVec4};

use crate::Space;
use crate::gpu::shaders as wgsl;

/// Where a view looks.
#[derive(Clone, Copy, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize), serde(untagged, deny_unknown_fields))]
pub enum Camera {
    /// On the earth or a plane: what is at the center, how far in, and how tilted and turned.
    Map {
        /// Longitude and latitude on the earth, plane units on a plane.
        center: [f64; 2],
        /// On the earth the web mercator level; on a plane, log₂ of pixels per unit.
        zoom: f64,
        /// Degrees from looking straight down, up to 80.
        pitch: f64,
        /// Degrees clockwise from north, or from up on a plane.
        bearing: f64,
    },
    /// On a plot: the axis range across, and the value range up; `None` fits the values in view.
    Plot {
        /// The axis range shown.
        x: [f64; 2],
        /// The value range shown, or `None` to fit what is in view.
        y: Option<[f64; 2]>,
    },
}

/// Vertical field of view: the camera stands 1.5 heights from the ground.
const FOV: f64 = 0.643_501_108_793_284_4;
const MAX_LATITUDE: f64 = 85.051_128_779_806_59;
pub(crate) const MAX_PITCH: f64 = 80.0;
const MAX_ZOOM: f64 = 24.0;

/// A rectangle of the view, CSS pixels: left, top, right, bottom.
pub(crate) type Area = [f64; 4];

impl Camera {
    /// The camera a view of `space` starts with.
    pub(crate) fn default_for(space: &Space) -> Camera {
        match space {
            Space::Earth(_) => Camera::Map { center: [0.0, 20.0], zoom: 1.5, pitch: 0.0, bearing: 0.0 },
            Space::Plane(_) => Camera::Map { center: [0.0, 0.0], zoom: 0.0, pitch: 0.0, bearing: 0.0 },
            Space::Plot(_) => Camera::Plot { x: [0.0, 1.0], y: None },
        }
    }

    /// Whether this camera can look at `space`.
    pub(crate) fn fits(&self, space: &Space) -> bool {
        matches!(
            (self, space),
            (Camera::Map { .. }, Space::Earth(_) | Space::Plane(_)) | (Camera::Plot { .. }, Space::Plot(_))
        )
    }

    /// `self` eased toward `to` by `t` in `0..=1`; longitude and bearing turn the short way.
    pub(crate) fn ease(&self, to: &Camera, t: f64, earth: bool) -> Camera {
        let lerp = |a: f64, b: f64| a + (b - a) * t;
        let turn = |a: f64, b: f64, full: f64| a + ((b - a + full * 1.5).rem_euclid(full) - full * 0.5) * t;
        match (self, to) {
            (
                Camera::Map { center: c0, zoom: z0, pitch: p0, bearing: b0 },
                Camera::Map { center: c1, zoom: z1, pitch: p1, bearing: b1 },
            ) => Camera::Map {
                center: [if earth { turn(c0[0], c1[0], 360.0) } else { lerp(c0[0], c1[0]) }, lerp(c0[1], c1[1])],
                zoom: lerp(*z0, *z1),
                pitch: lerp(*p0, *p1),
                bearing: turn(*b0, *b1, 360.0),
            },
            (Camera::Plot { x: x0, y: y0 }, Camera::Plot { x: x1, y: y1 }) => Camera::Plot {
                x: [lerp(x0[0], x1[0]), lerp(x0[1], x1[1])],
                y: match (y0, y1) {
                    (Some(a), Some(b)) => Some([lerp(a[0], b[0]), lerp(a[1], b[1])]),
                    _ => *y1,
                },
            },
            _ => *to,
        }
    }

    /// Turned by `degrees` of bearing and pitch.
    pub(crate) fn turned(&self, degrees: [f64; 2]) -> Camera {
        match *self {
            Camera::Map { center, zoom, pitch, bearing } => Camera::Map {
                center,
                zoom,
                pitch: (pitch + degrees[1]).clamp(0.0, MAX_PITCH),
                bearing: (bearing + degrees[0]).rem_euclid(360.0),
            },
            plot => plot,
        }
    }

    /// Moved so that what lies under screen point `from` comes under `to`.
    pub(crate) fn panned(&self, view: &Projected, from: [f64; 2], to: [f64; 2]) -> Camera {
        match *self {
            Camera::Plot { x, y } => {
                let dx = (to[0] - from[0]) / view.px_per_unit[0];
                let dy = (to[1] - from[1]) / view.px_per_unit[1];
                Camera::Plot { x: [x[0] - dx, x[1] - dx], y: y.map(|y| [y[0] + dy, y[1] + dy]) }
            }
            Camera::Map { center, zoom, pitch, bearing } => {
                let moved = |center| Camera::Map { center, zoom, pitch, bearing };
                if view.space == wgsl::SPACE_EARTH && view.globe >= 0.5 {
                    let b = bearing.to_radians();
                    let d = DVec2::new(to[0] - from[0], to[1] - from[1]);
                    let d = DVec2::new(d.x * b.cos() + d.y * b.sin(), -d.x * b.sin() + d.y * b.cos());
                    let lat = center[1].to_radians().cos().max(0.05);
                    let lon = center[0] - (d.x / view.px_per_unit[0]).to_degrees() / lat;
                    let lat = (center[1] + (d.y / view.px_per_unit[1]).to_degrees()).clamp(-MAX_LATITUDE, MAX_LATITUDE);
                    return moved([wrap(lon), lat]);
                }
                match (view.ground(from), view.ground(to)) {
                    (Some(a), Some(b)) => moved(view.shifted(center, a - b)),
                    _ => *self,
                }
            }
        }
    }

    /// Zoomed in by `levels` (out when negative), keeping what lies under screen point `at`.
    pub(crate) fn zoomed(&self, space: &Space, size: [f64; 2], area: Area, levels: f64, at: [f64; 2]) -> Camera {
        match *self {
            Camera::Plot { x, y } => {
                let scale = (-levels).exp2();
                let about = |range: [f64; 2], t: f64| {
                    let pivot = range[0] + (range[1] - range[0]) * t;
                    [pivot - (pivot - range[0]) * scale, pivot + (range[1] - pivot) * scale]
                };
                let tx = ((at[0] - area[0]) / (area[2] - area[0]).max(1.0)).clamp(0.0, 1.0);
                let ty = ((area[3] - at[1]) / (area[3] - area[1]).max(1.0)).clamp(0.0, 1.0);
                Camera::Plot { x: about(x, tx), y: y.map(|y| about(y, ty)) }
            }
            Camera::Map { center, zoom, pitch, bearing } => {
                let globe = Projected::globe_of(space);
                let before = Projected::new(space, self, size, area, globe);
                let zoom = (zoom + levels).clamp(-MAX_ZOOM, MAX_ZOOM);
                let next = Camera::Map { center, zoom, pitch, bearing };
                let after = Projected::new(space, &next, size, area, globe);
                match (before.ground(at), after.ground(at)) {
                    (Some(a), Some(b)) if globe < 0.5 => {
                        Camera::Map { center: after.shifted(center, a - b), zoom, pitch, bearing }
                    }
                    _ => next,
                }
            }
        }
    }

    /// The camera framing the box `min..max` of positions inside `area` with `padding` CSS pixels to
    /// spare, keeping pitch and bearing.
    pub(crate) fn framing(&self, space: &Space, min: [f64; 3], max: [f64; 3], size: [f64; 2], area: Area) -> Camera {
        const PADDING: f64 = 24.0;
        let room = [(area[2] - area[0] - 2.0 * PADDING).max(1.0), (area[3] - area[1] - 2.0 * PADDING).max(1.0)];
        let (pitch, bearing) = match *self {
            Camera::Map { pitch, bearing, .. } => (pitch, bearing),
            Camera::Plot { .. } => (0.0, 0.0),
        };
        match space {
            Space::Plot(_) => {
                let pad = |lo: f64, hi: f64, px: f64| {
                    let span = (hi - lo).max(1e-9);
                    let extra = span * PADDING / px.max(1.0);
                    [lo - extra, hi + extra]
                };
                let x = if max[0] > min[0] { [min[0], max[0]] } else { [min[0] - 0.5, min[0] + 0.5] };
                Camera::Plot { x, y: Some(pad(min[1], max[1], room[1])) }
            }
            Space::Earth(_) => {
                let (y0, y1) = (mercator_y(min[1]), mercator_y(max[1]));
                let dx = (max[0] - min[0]).to_radians().max(1e-9);
                let dy = (y1 - y0).max(1e-9);
                let px_per_radian = (room[0] / dx).min(room[1] / dy);
                let zoom = (px_per_radian * TAU / 256.0).log2().clamp(0.0, 22.0);
                let center = [min[0].midpoint(max[0]), latitude(y0.midpoint(y1))];
                Camera::Map { center, zoom, pitch, bearing }.framed(space, min, max, size, area, room)
            }
            Space::Plane(_) => {
                let dx = (max[0] - min[0]).max(1e-9);
                let dy = (max[1] - min[1]).max(1e-9);
                let zoom = (room[0] / dx).min(room[1] / dy).log2().clamp(-MAX_ZOOM, MAX_ZOOM);
                let center = [min[0].midpoint(max[0]), min[1].midpoint(max[1])];
                Camera::Map { center, zoom, pitch, bearing }.framed(space, min, max, size, area, room)
            }
        }
    }

    /// Refines a map camera so the box's eight corners fill `room`: the perspective changes with the
    /// zoom, so a few rounds settle it.
    fn framed(self, space: &Space, min: [f64; 3], max: [f64; 3], size: [f64; 2], area: Area, room: [f64; 2]) -> Camera {
        let middle = [area[0].midpoint(area[2]), area[1].midpoint(area[3])];
        // The screen rectangle the box's corners span.
        let spans = |camera: &Camera| {
            let view = Projected::new(space, camera, size, area, 0.0);
            let mut lo = [f64::INFINITY; 2];
            let mut hi = [f64::NEG_INFINITY; 2];
            for i in 0..8 {
                let corner = [[min, max][i & 1][0], [min, max][(i >> 1) & 1][1], [min, max][i >> 2][2]];
                let Some(s) = view.screen(view.world(corner)) else { continue };
                lo = [lo[0].min(s[0]), lo[1].min(s[1])];
                hi = [hi[0].max(s[0]), hi[1].max(s[1])];
            }
            (lo[0] <= hi[0]).then_some((view, lo, hi))
        };
        let mut camera = self;
        for _ in 0..12 {
            let Camera::Map { center, zoom, pitch, bearing } = camera else { break };
            let Some((_, lo, hi)) = spans(&camera) else { break };
            let scale = (room[0] / (hi[0] - lo[0]).max(1e-9)).min(room[1] / (hi[1] - lo[1]).max(1e-9));
            camera = Camera::Map { center, zoom: (zoom + scale.log2()).clamp(-MAX_ZOOM, MAX_ZOOM), pitch, bearing };
            let Some((view, lo, hi)) = spans(&camera) else { break };
            let mid = [lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1])];
            if let (Some(a), Some(b)) = (view.ground(mid), view.ground(middle)) {
                let Camera::Map { center, zoom, .. } = camera else { break };
                camera = Camera::Map { center: view.shifted(center, a - b), zoom, pitch, bearing };
            }
            if (scale - 1.0).abs() < 1e-4 && (mid[0] - middle[0]).hypot(mid[1] - middle[1]) < 0.25 {
                break;
            }
        }
        camera
    }

    /// Centered on `position`, keeping everything else.
    pub(crate) fn centered(&self, position: [f64; 3]) -> Camera {
        match *self {
            Camera::Map { zoom, pitch, bearing, .. } => {
                Camera::Map { center: [position[0], position[1]], zoom, pitch, bearing }
            }
            Camera::Plot { x, y } => {
                let half = (x[1] - x[0]) / 2.0;
                Camera::Plot { x: [position[0] - half, position[0] + half], y }
            }
        }
    }
}

/// Longitude in `-180..180`.
fn wrap(lon: f64) -> f64 {
    (lon + 180.0).rem_euclid(360.0) - 180.0
}

pub(crate) fn mercator_y(latitude: f64) -> f64 {
    let lat = latitude.clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
    (PI / 4.0 + lat / 2.0).tan().ln()
}

pub(crate) fn latitude(mercator_y: f64) -> f64 {
    (2.0 * mercator_y.exp().atan() - PI / 2.0).to_degrees()
}

/// A camera looking at a space through a view of some size: everything a frame and the gestures
/// need to go between positions, world coordinates, and the screen.
///
/// World coordinates are what the shaders project: position units from the camera's center on a
/// plane or plot, mercator radians or the globe on the earth, with elevation up.
pub(crate) struct Projected {
    pub(crate) clip_from_world: DMat4,
    pub(crate) world_from_clip: DMat4,
    /// The camera's position, and the direction toward the key light.
    pub(crate) eye: DVec3,
    pub(crate) light: DVec3,
    pub(crate) center: [f64; 2],
    pub(crate) px_per_unit: [f64; 2],
    pub(crate) mercator_y: f64,
    pub(crate) globe: f64,
    pub(crate) space: u32,
    size: [f64; 2],
}

impl Projected {
    /// How far a space's earth is morphed onto the globe.
    pub(crate) fn globe_of(space: &Space) -> f64 {
        match space {
            Space::Earth(earth) => f64::from(u8::from(earth.projection == crate::Projection::Globe)),
            _ => 0.0,
        }
    }

    /// The projection of `camera` looking at `space` in a view of `size` CSS pixels, its center in the
    /// middle of `area`. A plot's camera spans `area`; one without a value range shows `0..1`.
    pub(crate) fn new(space: &Space, camera: &Camera, size: [f64; 2], area: Area, globe: f64) -> Projected {
        let camera = if camera.fits(space) { *camera } else { Camera::default_for(space) };
        let (w, h) = (size[0].max(1.0), size[1].max(1.0));
        let room = [(area[2] - area[0]).max(1.0), (area[3] - area[1]).max(1.0)];
        let (center, px_per_unit, pitch, bearing, space_code) = match (space, camera) {
            (Space::Earth(_), Camera::Map { center, zoom, pitch, bearing }) => {
                let px = 256.0 * zoom.exp2() / TAU;
                (center, [px, px], pitch, bearing, wgsl::SPACE_EARTH)
            }
            (Space::Plane(_), Camera::Map { center, zoom, pitch, bearing }) => {
                let px = zoom.exp2();
                (center, [px, px], pitch, bearing, wgsl::SPACE_PLANE)
            }
            (_, Camera::Plot { x, y }) => {
                let y = y.unwrap_or([0.0, 1.0]);
                let px = [room[0] / (x[1] - x[0]).abs().max(1e-12), room[1] / (y[1] - y[0]).abs().max(1e-12)];
                ([x[0].midpoint(x[1]), y[0].midpoint(y[1])], px, 0.0, 0.0, wgsl::SPACE_PLOT)
            }
            _ => unreachable!("the camera fits the space"),
        };
        let distance = 0.5 * h / (0.5 * FOV).tan();
        // Reversed depth: the near plane maps to 1 and the far plane to 0.
        let projection = perspective(FOV, w / h, distance * 100.0, distance * 0.01);
        let view = DMat4::from_translation(DVec3::new(0.0, 0.0, -distance))
            * DMat4::from_rotation_x(-pitch.clamp(0.0, MAX_PITCH).to_radians())
            * DMat4::from_rotation_z(bearing.to_radians())
            * DMat4::from_scale(DVec3::new(px_per_unit[0], px_per_unit[1], px_per_unit[0]));
        let middle = [area[0].midpoint(area[2]) / w * 2.0 - 1.0, 1.0 - area[1].midpoint(area[3]) / h * 2.0];
        let offset = DMat4::from_cols(DVec4::X, DVec4::Y, DVec4::Z, DVec4::new(middle[0], middle[1], 0.0, 1.0));
        let clip_from_world = offset * projection * view;
        let world_from_view = view.inverse();
        let eye = world_from_view.transform_point3(DVec3::ZERO);
        let light = world_from_view.transform_vector3(DVec3::new(-0.4, 0.8, 1.0)).normalize_or_zero();
        let mercator = if space_code == wgsl::SPACE_EARTH { mercator_y(center[1]) } else { 0.0 };
        Projected {
            clip_from_world,
            world_from_clip: clip_from_world.inverse(),
            eye,
            light,
            center,
            px_per_unit,
            mercator_y: mercator,
            globe: if space_code == wgsl::SPACE_EARTH { globe } else { 0.0 },
            space: space_code,
            size: [w, h],
        }
    }

    /// The world coordinates of `position`: x, y, and elevation.
    pub(crate) fn world(&self, position: [f64; 3]) -> DVec3 {
        let [x, y, z] = position;
        if self.space != wgsl::SPACE_EARTH {
            return DVec3::new(x - self.center[0], y - self.center[1], z);
        }
        let flat = DVec3::new((x - self.center[0]).to_radians(), mercator_y(y) - self.mercator_y, z);
        if self.globe <= 0.0 {
            return flat;
        }
        let (lon, lat, lat0) = ((x - self.center[0]).to_radians(), y.clamp(-90.0, 90.0).to_radians(), self.center[1].to_radians());
        let v = DVec3::new(lat.cos() * lon.sin(), lat.sin(), lat.cos() * lon.cos());
        let s = DVec3::new(v.x, v.y * lat0.cos() - v.z * lat0.sin(), v.y * lat0.sin() + v.z * lat0.cos()) * (1.0 + z);
        let round = DVec3::new(s.x, s.y, s.z - 1.0) / lat0.cos();
        flat.lerp(round, self.globe)
    }

    /// The position at world coordinates `w`.
    pub(crate) fn position(&self, w: DVec3) -> [f64; 3] {
        if self.space != wgsl::SPACE_EARTH {
            return [w.x + self.center[0], w.y + self.center[1], w.z];
        }
        if self.globe < 0.5 {
            return [self.center[0] + w.x.to_degrees(), latitude(w.y + self.mercator_y), w.z];
        }
        let lat0 = self.center[1].to_radians();
        let s = DVec3::new(w.x * lat0.cos(), w.y * lat0.cos(), w.z * lat0.cos() + 1.0);
        let r = s.length().max(1e-12);
        let u = s / r;
        let v = DVec3::new(u.x, u.y * lat0.cos() + u.z * lat0.sin(), -u.y * lat0.sin() + u.z * lat0.cos());
        [wrap(self.center[0] + v.x.atan2(v.z).to_degrees()), v.y.clamp(-1.0, 1.0).asin().to_degrees(), r - 1.0]
    }

    /// Where world point `w` lands, CSS pixels from the top left, with its depth; `None` behind the
    /// camera.
    pub(crate) fn screen(&self, w: DVec3) -> Option<[f64; 3]> {
        let clip = self.clip_from_world * w.extend(1.0);
        (clip.w > 0.0).then(|| {
            let ndc = clip.truncate() / clip.w;
            [(ndc.x * 0.5 + 0.5) * self.size[0], (0.5 - ndc.y * 0.5) * self.size[1], ndc.z]
        })
    }

    /// The world point drawn at screen point `p` at `depth`.
    pub(crate) fn unproject(&self, p: [f64; 2], depth: f64) -> DVec3 {
        let ndc = DVec4::new(p[0] / self.size[0] * 2.0 - 1.0, 1.0 - p[1] / self.size[1] * 2.0, depth, 1.0);
        let w = self.world_from_clip * ndc;
        w.truncate() / w.w
    }

    /// Where the ray under screen point `p` meets the ground, in world coordinates.
    pub(crate) fn ground(&self, p: [f64; 2]) -> Option<DVec3> {
        let near = self.unproject(p, 1.0);
        let far = self.unproject(p, 0.0);
        let t = near.z / (near.z - far.z);
        (t.is_finite() && t >= 0.0).then(|| near.lerp(far, t))
    }

    /// `center` moved by world offset `d` along the ground.
    pub(crate) fn shifted(&self, center: [f64; 2], d: DVec3) -> [f64; 2] {
        if self.space != wgsl::SPACE_EARTH {
            return [center[0] + d.x, center[1] + d.y];
        }
        [wrap(center[0] + d.x.to_degrees()), latitude(self.mercator_y + d.y).clamp(-MAX_LATITUDE, MAX_LATITUDE)]
    }
}

/// A right-handed perspective projection onto WebGPU's clip space, depth `0..=1` from `near` to
/// `far`; passing the far distance as `near` reverses depth.
fn perspective(fov: f64, aspect: f64, near: f64, far: f64) -> DMat4 {
    let f = 1.0 / (0.5 * fov).tan();
    DMat4::from_cols_array(&[
        f / aspect,
        0.0,
        0.0,
        0.0,
        0.0,
        f,
        0.0,
        0.0,
        0.0,
        0.0,
        far / (near - far),
        -1.0,
        0.0,
        0.0,
        near * far / (near - far),
        0.0,
    ])
}

/// `f64` split into an `f32` and what it drops.
pub(crate) fn split(x: f64) -> (f32, f32) {
    let hi = x as f32;
    (hi, (x - f64::from(hi)) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Earth, Plane};

    const SIZE: [f64; 2] = [800.0, 600.0];
    const AREA: Area = [0.0, 0.0, 800.0, 600.0];

    fn to_screen(view: &Projected, p: [f64; 3]) -> [f64; 2] {
        let s = view.screen(view.world(p)).expect("in front");
        [s[0], s[1]]
    }

    #[test]
    fn plane_centers_and_scales() {
        let space = Space::Plane(Plane::default());
        let camera = Camera::Map { center: [10.0, 20.0], zoom: 1.0, pitch: 0.0, bearing: 0.0 };
        let view = Projected::new(&space, &camera, SIZE, AREA, 0.0);
        let center = to_screen(&view, [10.0, 20.0, 0.0]);
        assert!((center[0] - 400.0).abs() < 1e-6 && (center[1] - 300.0).abs() < 1e-6);
        let right = to_screen(&view, [11.0, 21.0, 0.0]);
        assert!((right[0] - 402.0).abs() < 1e-6, "two pixels per unit at zoom 1");
        assert!((right[1] - 298.0).abs() < 1e-6, "y up");
    }

    #[test]
    fn depth_is_reversed_and_unprojects() {
        let space = Space::Plane(Plane::default());
        let camera = Camera::Map { center: [0.0, 0.0], zoom: 2.0, pitch: 50.0, bearing: 30.0 };
        let view = Projected::new(&space, &camera, SIZE, AREA, 0.0);
        let low = view.screen(view.world([0.0, 0.0, 0.0])).expect("in front");
        let high = view.screen(view.world([0.0, 0.0, 30.0])).expect("in front");
        assert!(high[2] > low[2], "nearer is greater: {low:?} {high:?}");
        let back = view.position(view.unproject([high[0], high[1]], high[2]));
        assert!((back[2] - 30.0).abs() < 1e-6 && back[0].abs() < 1e-6, "{back:?}");
        let ground = view.ground([low[0], low[1]]).expect("the ground");
        assert!(ground.length() < 1e-6);
    }

    #[test]
    fn framing_holds_a_tilted_box() {
        let space = Space::Plane(Plane::default());
        let camera = Camera::Map { center: [0.0, 0.0], zoom: 0.0, pitch: 58.0, bearing: 30.0 };
        let (min, max) = ([-4.0, -4.0, 0.0], [4.0, 4.0, 2.4]);
        let framed = camera.framing(&space, min, max, SIZE, AREA);
        let view = Projected::new(&space, &framed, SIZE, AREA, 0.0);
        for i in 0..8 {
            let s = to_screen(&view, [[min, max][i & 1][0], [min, max][(i >> 1) & 1][1], [min, max][i >> 2][2]]);
            assert!((23.0..=777.0).contains(&s[0]) && (23.0..=577.0).contains(&s[1]), "corner {i}: {s:?}");
        }
    }

    #[test]
    fn earth_positions_round_trip() {
        for globe in [0.0, 1.0] {
            let space = Space::Earth(if globe > 0.0 { Earth::globe() } else { Earth::mercator() });
            let camera = Camera::Map { center: [-97.0, 31.0], zoom: 4.0, pitch: 0.0, bearing: 0.0 };
            let view = Projected::new(&space, &camera, SIZE, AREA, globe);
            let p = [-95.5, 29.75, 0.0];
            let back = view.position(view.world(p));
            assert!((back[0] - p[0]).abs() < 1e-9 && (back[1] - p[1]).abs() < 1e-9, "globe {globe}: {back:?}");
        }
        assert!((latitude(mercator_y(37.5)) - 37.5).abs() < 1e-9);
    }

    #[test]
    fn panning_keeps_the_grabbed_point_under_the_pointer() {
        let space = Space::Plane(Plane::default());
        let camera = Camera::Map { center: [0.0, 0.0], zoom: 3.0, pitch: 40.0, bearing: 10.0 };
        let view = Projected::new(&space, &camera, SIZE, AREA, 0.0);
        let grabbed = view.position(view.ground([300.0, 400.0]).expect("ground"));
        let panned = camera.panned(&view, [300.0, 400.0], [420.0, 350.0]);
        let after = Projected::new(&space, &panned, SIZE, AREA, 0.0);
        let s = to_screen(&after, grabbed);
        assert!((s[0] - 420.0).abs() < 1e-6 && (s[1] - 350.0).abs() < 1e-6, "{s:?}");
    }

    #[test]
    fn longitude_eases_the_short_way() {
        let a = Camera::Map { center: [170.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 350.0 };
        let b = Camera::Map { center: [-170.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 10.0 };
        let Camera::Map { center, bearing, .. } = a.ease(&b, 0.5, true) else { panic!("a map camera") };
        assert!((center[0] - 180.0).abs() < 1e-9);
        assert!((bearing - 360.0).abs() < 1e-9);
    }
}
