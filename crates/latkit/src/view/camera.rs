use std::f64::consts::{PI, TAU};

use glam::{DMat3, DMat4, DVec3, DVec4};

use crate::Space;
use crate::gpu::shaders as wgsl;

/// Where a view looks.
#[derive(Clone, Copy, PartialEq, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum Camera {
    /// On the earth, a plane, or a diagram: the point looked at and turned about, how far in, and how
    /// tilted and turned. A diagram is always seen from straight above, upright.
    Map {
        /// Longitude, latitude, and elevation on the earth; x, y, and elevation on a plane or a
        /// diagram. In JSON, `[x, y]` looks at the ground.
        #[serde(with = "center")]
        #[schemars(with = "center::Center")]
        center: [f64; 3],
        /// On the earth the web mercator level; elsewhere, log₂ of pixels per unit.
        zoom: f64,
        /// Degrees from looking straight down, up to 75; 0 in a diagram.
        pitch: f64,
        /// Degrees clockwise from north, or from up on a plane; 0 in a diagram.
        bearing: f64,
    },
    /// On a plot: the axis range across, and the value range up, or none to fit the values in view.
    Plot {
        /// The axis range shown.
        x: [f64; 2],
        /// The value range shown, or none to fit what is in view.
        y: Option<[f64; 2]>,
    },
}

mod center {
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

    /// What a center is written as: the ground's `[x, y]`, or `[x, y, elevation]`.
    #[derive(schemars::JsonSchema)]
    #[serde(untagged)]
    #[schemars(inline)]
    #[allow(dead_code, reason = "its schema only")]
    pub(super) enum Center {
        Ground([f64; 2]),
        Point([f64; 3]),
    }

    pub(super) fn serialize<S: Serializer>(center: &[f64; 3], serializer: S) -> Result<S::Ok, S::Error> {
        if center[2] == 0.0 { [center[0], center[1]].serialize(serializer) } else { center.serialize(serializer) }
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[f64; 3], D::Error> {
        match Vec::<f64>::deserialize(deserializer)?[..] {
            [x, y] => Ok([x, y, 0.0]),
            [x, y, z] => Ok([x, y, z]),
            _ => Err(de::Error::custom("a center is [x, y] or [x, y, elevation]")),
        }
    }
}

/// Vertical field of view: the camera stands 1.5 heights from what it looks at.
const FOV: f64 = 0.643_501_108_793_284_4;
const MAX_LATITUDE: f64 = 85.051_128_779_806_59;
pub(crate) const MAX_PITCH: f64 = 75.0;
const MAX_ZOOM: f64 = 24.0;

/// A rectangle of the view, CSS pixels: left, top, right, bottom.
pub(crate) type Area = [f64; 4];

/// What fits framed: everything, and any rows framed since. The camera stays within reach of it.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Bounds {
    pub(crate) min: [f64; 3],
    pub(crate) max: [f64; 3],
    /// The least and greatest zoom the fits framed at.
    pub(crate) zoom: [f64; 2],
}

impl Bounds {
    /// Reach that holds both.
    pub(crate) fn with(self, other: Bounds) -> Bounds {
        Bounds {
            min: std::array::from_fn(|k| self.min[k].min(other.min[k])),
            max: std::array::from_fn(|k| self.max[k].max(other.max[k])),
            zoom: [self.zoom[0].min(other.zoom[0]), self.zoom[1].max(other.zoom[1])],
        }
    }

    /// The zooms the camera keeps within: a few levels out past what was framed, eight in.
    pub(crate) fn zooms(&self) -> [f64; 2] {
        [self.zoom[0] - 3.0, self.zoom[1] + 8.0]
    }
}

impl Camera {
    /// The camera a view of `space` starts with.
    pub(crate) fn default_for(space: &Space) -> Camera {
        match space {
            Space::Earth(_) => Camera::Map { center: [0.0, 20.0, 0.0], zoom: 1.5, pitch: 0.0, bearing: 0.0 },
            Space::Plane(_) | Space::Diagram(_) => {
                Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 0.0, bearing: 0.0 }
            }
            Space::Plot(_) => Camera::Plot { x: [0.0, 1.0], y: None },
        }
    }

    /// Whether this camera can look at `space`.
    pub fn fits(&self, space: &Space) -> bool {
        matches!(
            (self, space),
            (Camera::Map { .. }, Space::Earth(_) | Space::Plane(_) | Space::Diagram(_))
                | (Camera::Plot { .. }, Space::Plot(_))
        )
    }

    /// The camera `t` of the way from `self` to `to`, `t` from 0 to 1, as a view of `space` flies:
    /// bearing, and on the earth longitude, turn the short way. A script moving the camera over time
    /// reads it.
    #[must_use]
    pub fn ease(&self, to: &Camera, t: f64, space: &Space) -> Camera {
        let earth = matches!(space, Space::Earth(_));
        let lerp = |a: f64, b: f64| a + (b - a) * t;
        let turn = |a: f64, b: f64, full: f64| a + ((b - a + full * 1.5).rem_euclid(full) - full * 0.5) * t;
        match (self, to) {
            (
                Camera::Map { center: c0, zoom: z0, pitch: p0, bearing: b0 },
                Camera::Map { center: c1, zoom: z1, pitch: p1, bearing: b1 },
            ) => Camera::Map {
                center: [
                    if earth { turn(c0[0], c1[0], 360.0) } else { lerp(c0[0], c1[0]) },
                    lerp(c0[1], c1[1]),
                    lerp(c0[2], c1[2]),
                ],
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

    /// Moved so `anchor` moves `delta` CSS pixels on screen. A map slides along the level through
    /// the anchor; where that level runs off toward the horizon, it slides as far as the anchor's
    /// depth across the screen would take it, still level.
    pub(crate) fn panned(&self, view: &Projected, anchor: [f64; 3], delta: [f64; 2]) -> Camera {
        match *self {
            Camera::Plot { x, y } => {
                let dx = delta[0] / view.px_per_unit[0];
                let dy = delta[1] / view.px_per_unit[1];
                Camera::Plot { x: [x[0] - dx, x[1] - dx], y: y.map(|y| [y[0] + dy, y[1] + dy]) }
            }
            Camera::Map { center, zoom, pitch, bearing } => {
                let a = view.world(anchor);
                let Some(s) = view.screen(a) else { return *self };
                let to = [s[0] + delta[0], s[1] + delta[1]];
                if view.globe >= 0.5 {
                    // Past the globe's edge there is nothing to hold the anchor to.
                    if view.surface(to).is_none() {
                        return *self;
                    }
                    return view.keeping(*self, anchor, to);
                }
                let reach = 50.0 * (view.eye - a).length();
                let level = view.on_plane(to, a.z).filter(|p| (*p - view.eye).length() < reach);
                let p = match level {
                    Some(p) if view.grazing(to) > 0.1 => p,
                    _ => view.unproject(to, s[2]),
                };
                Camera::Map { center: view.shifted(center, a - p, 0.0), zoom, pitch, bearing }
            }
        }
    }

    /// Turned by `degrees` of bearing and pitch about `anchor`, which keeps its place on screen.
    pub(crate) fn turned(&self, view: &Projected, anchor: [f64; 3], degrees: [f64; 2]) -> Camera {
        let Camera::Map { center, zoom, pitch, bearing } = *self else { return *self };
        if view.space == wgsl::SPACE_DIAGRAM {
            return *self;
        }
        let to_pitch = (pitch + degrees[1]).clamp(0.0, MAX_PITCH);
        let to_bearing = (bearing + degrees[0]).rem_euclid(360.0);
        if view.globe >= 0.5 {
            let turned = Camera::Map { center, zoom, pitch: to_pitch, bearing: to_bearing };
            return match view.screen(view.world(anchor)) {
                Some(s) => view.keeping(turned, anchor, [s[0], s[1]]),
                None => turned,
            };
        }
        // The camera turns rigidly about the anchor: its center goes with it.
        let rig = |p: f64, b: f64| DMat3::from_rotation_z(-b.to_radians()) * DMat3::from_rotation_x(p.to_radians());
        let r = rig(to_pitch, to_bearing) * rig(pitch, bearing).transpose();
        let a = view.world(anchor);
        let c = DVec3::new(0.0, 0.0, center[2]);
        let moved = a + r * (c - a);
        let d = moved - c;
        Camera::Map { center: view.shifted(center, d, d.z), zoom, pitch: to_pitch, bearing: to_bearing }
    }

    /// Zoomed in by `levels`, out when negative, toward `anchor`, which keeps its place on screen. A
    /// map's zoom stays within `limits` (what a fit framed lets it reach) before the anchor moves the
    /// center, so a zoom held at its limit moves nothing.
    pub(crate) fn zoomed(&self, view: &Projected, anchor: [f64; 3], levels: f64, limits: Option<[f64; 2]>) -> Camera {
        match *self {
            Camera::Plot { x, y } => {
                let scale = (-levels).exp2();
                let about = |range: [f64; 2], pivot: f64| {
                    [pivot + (range[0] - pivot) * scale, pivot + (range[1] - pivot) * scale]
                };
                Camera::Plot { x: about(x, anchor[0]), y: y.map(|y| about(y, anchor[1])) }
            }
            Camera::Map { center, zoom, pitch, bearing } => {
                let [least, most] = limits.unwrap_or([-MAX_ZOOM, MAX_ZOOM]);
                let (least, most) = (least.max(-MAX_ZOOM), most.min(MAX_ZOOM));
                // A zoom already past a limit is not pulled back toward it by a gesture going further.
                let to = (zoom + levels).clamp(least.min(zoom), most.max(zoom));
                if to == zoom {
                    return *self;
                }
                if view.globe >= 0.5 {
                    let zoomed = Camera::Map { center, zoom: to, pitch, bearing };
                    return match view.screen(view.world(anchor)) {
                        Some(s) => view.keeping(zoomed, anchor, [s[0], s[1]]),
                        None => zoomed,
                    };
                }
                let a = view.world(anchor);
                let c = DVec3::new(0.0, 0.0, center[2]);
                let d = (a + (c - a) * (zoom - to).exp2()) - c;
                Camera::Map { center: view.shifted(center, d, d.z), zoom: to, pitch, bearing }
            }
        }
    }

    /// Within reach of what `bounds` framed: zoomed no further out than a few levels past it, no
    /// further in than eight, looking across no farther than its size from it, and no higher or
    /// lower than it reaches, so the camera stays above what stands on the ground.
    pub(crate) fn within(&self, bounds: &Bounds) -> Camera {
        let Camera::Map { center, zoom, pitch, bearing } = *self else { return *self };
        let span = (0..2).map(|k| bounds.max[k] - bounds.min[k]).fold(0.0, f64::max).max(1e-9);
        let across = |k: usize| center[k].clamp(bounds.min[k] - span, bounds.max[k] + span);
        Camera::Map {
            center: [across(0), across(1), center[2].clamp(bounds.min[2], bounds.max[2])],
            zoom: zoom.clamp(bounds.zooms()[0], bounds.zooms()[1]),
            pitch: pitch.clamp(0.0, MAX_PITCH),
            bearing,
        }
    }

    /// The camera framing the box `min..max` of positions inside `area` with room to spare, looking
    /// at its middle and keeping pitch and bearing.
    pub(crate) fn framing(&self, space: &Space, min: [f64; 3], max: [f64; 3], size: [f64; 2], area: Area) -> Camera {
        const PADDING: f64 = 24.0;
        let room = [(area[2] - area[0] - 2.0 * PADDING).max(1.0), (area[3] - area[1] - 2.0 * PADDING).max(1.0)];
        let (pitch, bearing) = match *self {
            Camera::Map { pitch, bearing, .. } => (pitch.clamp(0.0, MAX_PITCH), bearing),
            Camera::Plot { .. } => (0.0, 0.0),
        };
        let height = min[2].midpoint(max[2]);
        // A box with no extent, as one point's is, has no zoom of its own: the camera looks at it at
        // the zoom it shows.
        if let Camera::Map { zoom, .. } = *self
            && !matches!(space, Space::Plot(_))
            && max[0] - min[0] <= 1e-9
            && max[1] - min[1] <= 1e-9
        {
            return Camera::Map { center: [min[0], min[1], height], zoom, pitch, bearing };
        }
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
                let center = [min[0].midpoint(max[0]), latitude(y0.midpoint(y1)), height];
                Camera::Map { center, zoom, pitch, bearing }.framed(space, min, max, size, area, room)
            }
            Space::Plane(_) | Space::Diagram(_) => {
                let dx = (max[0] - min[0]).max(1e-9);
                let dy = (max[1] - min[1]).max(1e-9);
                let zoom = (room[0] / dx).min(room[1] / dy).log2().clamp(-MAX_ZOOM, MAX_ZOOM);
                let center = [min[0].midpoint(max[0]), min[1].midpoint(max[1]), height];
                Camera::Map { center, zoom, pitch, bearing }.framed(space, min, max, size, area, room)
            }
        }
    }

    /// Refines a map camera, still looking at the box's middle, so the box's eight corners reach no
    /// farther from the middle of `area` than `room` allows: the perspective changes with the zoom,
    /// so a few rounds settle it.
    fn framed(self, space: &Space, min: [f64; 3], max: [f64; 3], size: [f64; 2], area: Area, room: [f64; 2]) -> Camera {
        let middle = [area[0].midpoint(area[2]), area[1].midpoint(area[3])];
        let mut camera = self;
        for _ in 0..12 {
            let Camera::Map { center, zoom, pitch, bearing } = camera else { break };
            let view = Projected::new(space, &camera, size, area, 0.0);
            let mut reach = [1e-9_f64; 2];
            for i in 0..8 {
                let corner = [[min, max][i & 1][0], [min, max][(i >> 1) & 1][1], [min, max][i >> 2][2]];
                let Some(s) = view.screen(view.world(corner)) else { continue };
                reach = [reach[0].max((s[0] - middle[0]).abs()), reach[1].max((s[1] - middle[1]).abs())];
            }
            let scale = (0.5 * room[0] / reach[0]).min(0.5 * room[1] / reach[1]);
            camera = Camera::Map { center, zoom: (zoom + scale.log2()).clamp(-MAX_ZOOM, MAX_ZOOM), pitch, bearing };
            if (scale - 1.0).abs() < 1e-4 {
                break;
            }
        }
        camera
    }

    /// Looking at `position`, keeping everything else.
    pub(crate) fn centered(&self, position: [f64; 3]) -> Camera {
        match *self {
            Camera::Map { zoom, pitch, bearing, .. } => Camera::Map { center: position, zoom, pitch, bearing },
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
/// World coordinates are what the shaders project: position units from the camera's center across a
/// plane or plot, mercator radians or the globe on the earth, with elevation up.
#[derive(Clone)]
pub(crate) struct Projected {
    pub(crate) clip_from_world: DMat4,
    pub(crate) world_from_clip: DMat4,
    /// The camera's position, and the direction toward the key light.
    pub(crate) eye: DVec3,
    pub(crate) light: DVec3,
    pub(crate) center: [f64; 3],
    pub(crate) px_per_unit: [f64; 2],
    /// The camera's zoom: the web mercator level on the earth, log₂ pixels per unit elsewhere.
    pub(crate) zoom: f64,
    pub(crate) mercator_y: f64,
    pub(crate) globe: f64,
    pub(crate) space: u32,
    size: [f64; 2],
    area: Area,
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
            (Space::Diagram(_), Camera::Map { center, zoom, .. }) => {
                let px = zoom.exp2();
                (center, [px, px], 0.0, 0.0, wgsl::SPACE_DIAGRAM)
            }
            (_, Camera::Plot { x, y }) => {
                let y = y.unwrap_or([0.0, 1.0]);
                let px = [room[0] / (x[1] - x[0]).abs().max(1e-12), room[1] / (y[1] - y[0]).abs().max(1e-12)];
                ([x[0].midpoint(x[1]), y[0].midpoint(y[1]), 0.0], px, 0.0, 0.0, wgsl::SPACE_PLOT)
            }
            _ => unreachable!("the camera fits the space"),
        };
        let distance = 0.5 * h / (0.5 * FOV).tan();
        // Reversed depth: the near plane maps to 1 and the far plane to 0.
        let projection = perspective(FOV, w / h, distance * 100.0, distance * 0.01);
        // A diagram's y runs down the screen.
        let up = if space_code == wgsl::SPACE_DIAGRAM { -px_per_unit[1] } else { px_per_unit[1] };
        let view = DMat4::from_translation(DVec3::new(0.0, 0.0, -distance))
            * DMat4::from_rotation_x(-pitch.clamp(0.0, MAX_PITCH).to_radians())
            * DMat4::from_rotation_z(bearing.to_radians())
            * DMat4::from_scale(DVec3::new(px_per_unit[0], up, px_per_unit[0]))
            * DMat4::from_translation(DVec3::new(0.0, 0.0, -center[2]));
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
            zoom: px_per_unit[0].max(1e-300).log2()
                - if space_code == wgsl::SPACE_EARTH { (256.0 / TAU).log2() } else { 0.0 },
            mercator_y: mercator,
            globe: if space_code == wgsl::SPACE_EARTH { globe } else { 0.0 },
            space: space_code,
            size: [w, h],
            area,
        }
    }

    /// `camera` moved on the globe, its center only, so that `anchor` lands at screen point `to`:
    /// Newton's method on the center's longitude and latitude from where it stands. Where no center
    /// puts the anchor there in front of the globe, `camera` as it is.
    pub(crate) fn keeping(&self, camera: Camera, anchor: [f64; 3], to: [f64; 2]) -> Camera {
        let Camera::Map { center, zoom, pitch, bearing } = camera else { return camera };
        let earth = Space::Earth(crate::Earth::globe());
        let at = |center: [f64; 3]| {
            let camera = Camera::Map { center, zoom, pitch, bearing };
            let view = Projected::new(&earth, &camera, self.size, self.area, self.globe);
            let w = view.world(anchor);
            let radius = 1.0 / center[1].to_radians().cos();
            let front = (w - DVec3::new(0.0, 0.0, -radius)).dot(view.eye - w) > 0.0;
            view.screen(w).filter(|_| front).map(|s| [s[0], s[1]])
        };
        // A step a few pixels wide measures how the anchor moves with the center.
        let step = 4.0 * 360.0 / (256.0 * zoom.exp2());
        let mut c = center;
        for _ in 0..8 {
            let Some(s) = at(c) else { return camera };
            let miss = [to[0] - s[0], to[1] - s[1]];
            if miss[0].hypot(miss[1]) < 0.01 {
                break;
            }
            let moved = |dc: [f64; 2]| {
                at([c[0] + dc[0], c[1] + dc[1], c[2]]).map(|m| [(m[0] - s[0]) / step, (m[1] - s[1]) / step])
            };
            let (Some(dx), Some(dy)) = (moved([step, 0.0]), moved([0.0, step])) else { return camera };
            let det = dx[0] * dy[1] - dy[0] * dx[1];
            if det.abs() < 1e-12 {
                return camera;
            }
            let along = [(miss[0] * dy[1] - dy[0] * miss[1]) / det, (dx[0] * miss[1] - miss[0] * dx[1]) / det];
            let scale = (30.0 / along[0].hypot(along[1]).max(1e-12)).min(1.0);
            c = [wrap(c[0] + along[0] * scale), (c[1] + along[1] * scale).clamp(-MAX_LATITUDE, MAX_LATITUDE), c[2]];
        }
        match at(c) {
            Some(s) if (s[0] - to[0]).hypot(s[1] - to[1]) < 0.5 => Camera::Map { center: c, zoom, pitch, bearing },
            _ => camera,
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
        let lon = (x - self.center[0]).to_radians();
        let (lat, lat0) = (y.clamp(-90.0, 90.0).to_radians(), self.center[1].to_radians());
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

    /// The ray under screen point `p`: where it leaves the near plane, and its direction.
    fn ray(&self, p: [f64; 2]) -> (DVec3, DVec3) {
        let near = self.unproject(p, 1.0);
        (near, (self.unproject(p, 0.0) - near).normalize_or_zero())
    }

    /// How steeply the ray under `p` meets a level: 1 looking straight down, 0 along the horizon.
    pub(crate) fn grazing(&self, p: [f64; 2]) -> f64 {
        self.ray(p).1.z.abs()
    }

    /// Where the ray under `p` meets the level at elevation `z`, in front of the camera.
    pub(crate) fn on_plane(&self, p: [f64; 2], z: f64) -> Option<DVec3> {
        let (o, d) = self.ray(p);
        let t = (z - o.z) / d.z;
        (t.is_finite() && t >= 0.0).then(|| o + d * t)
    }

    /// Where the ray under `p` meets the ground: the plane's level, the map, or the globe.
    pub(crate) fn surface(&self, p: [f64; 2]) -> Option<DVec3> {
        if self.globe < 0.5 {
            return self.on_plane(p, 0.0);
        }
        let radius = 1.0 / self.center[1].to_radians().cos();
        let (o, d) = self.ray(p);
        let to = DVec3::new(0.0, 0.0, -radius) - o;
        let along = to.dot(d);
        let miss = (to - d * along).length_squared();
        let half = (radius * radius - miss).sqrt();
        (half.is_finite() && along - half >= 0.0).then(|| o + d * (along - half))
    }

    /// `center` moved by world offset `d` across the ground, and up by `raise`.
    pub(crate) fn shifted(&self, center: [f64; 3], d: DVec3, raise: f64) -> [f64; 3] {
        if self.space != wgsl::SPACE_EARTH {
            return [center[0] + d.x, center[1] + d.y, center[2] + raise];
        }
        let lat = latitude(self.mercator_y + d.y).clamp(-MAX_LATITUDE, MAX_LATITUDE);
        [wrap(center[0] + d.x.to_degrees()), lat, center[2] + raise]
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

    fn plane() -> Space {
        Space::Plane(Plane::default())
    }

    fn to_screen(view: &Projected, p: [f64; 3]) -> [f64; 2] {
        let s = view.screen(view.world(p)).expect("in front");
        [s[0], s[1]]
    }

    fn near(a: [f64; 2], b: [f64; 2]) -> bool {
        (a[0] - b[0]).hypot(a[1] - b[1]) < 1e-6
    }

    #[test]
    fn plane_centers_and_scales() {
        let camera = Camera::Map { center: [10.0, 20.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 0.0 };
        let view = Projected::new(&plane(), &camera, SIZE, AREA, 0.0);
        assert!(near(to_screen(&view, [10.0, 20.0, 0.0]), [400.0, 300.0]));
        assert!(near(to_screen(&view, [11.0, 21.0, 0.0]), [402.0, 298.0]), "two pixels per unit, y up");
    }

    #[test]
    fn a_diagram_runs_y_down_and_never_turns() {
        let space = Space::Diagram(crate::Diagram::default());
        let camera = Camera::Map { center: [10.0, 20.0, 0.0], zoom: 1.0, pitch: 40.0, bearing: 30.0 };
        let view = Projected::new(&space, &camera, SIZE, AREA, 0.0);
        assert!(near(to_screen(&view, [10.0, 20.0, 0.0]), [400.0, 300.0]));
        assert!(near(to_screen(&view, [11.0, 21.0, 0.0]), [402.0, 302.0]), "two pixels per unit, y down, upright");
        assert_eq!(camera.turned(&view, [0.0; 3], [20.0, 10.0]), camera);
        let back = view.position(view.surface([402.0, 302.0]).expect("the sheet"));
        assert!((back[0] - 11.0).abs() < 1e-9 && (back[1] - 21.0).abs() < 1e-9, "{back:?}");
    }

    #[test]
    fn the_center_is_a_point_in_space() {
        let camera = Camera::Map { center: [1.0, 2.0, 5.0], zoom: 3.0, pitch: 60.0, bearing: 40.0 };
        let view = Projected::new(&plane(), &camera, SIZE, AREA, 0.0);
        assert!(near(to_screen(&view, [1.0, 2.0, 5.0]), [400.0, 300.0]), "the center is in the middle");
    }

    #[test]
    fn depth_is_reversed_and_unprojects() {
        let camera = Camera::Map { center: [0.0; 3], zoom: 2.0, pitch: 50.0, bearing: 30.0 };
        let view = Projected::new(&plane(), &camera, SIZE, AREA, 0.0);
        let low = view.screen(view.world([0.0, 0.0, 0.0])).expect("in front");
        let high = view.screen(view.world([0.0, 0.0, 30.0])).expect("in front");
        assert!(high[2] > low[2], "nearer is greater: {low:?} {high:?}");
        let back = view.position(view.unproject([high[0], high[1]], high[2]));
        assert!((back[2] - 30.0).abs() < 1e-6 && back[0].abs() < 1e-6, "{back:?}");
        assert!(view.surface([low[0], low[1]]).expect("the ground").length() < 1e-6);
    }

    #[test]
    fn framing_holds_a_tilted_box_and_looks_at_its_middle() {
        let camera = Camera::Map { center: [0.0; 3], zoom: 0.0, pitch: 58.0, bearing: 30.0 };
        let (min, max) = ([-4.0, -4.0, 0.0], [4.0, 4.0, 2.4]);
        let framed = camera.framing(&plane(), min, max, SIZE, AREA);
        let Camera::Map { center, .. } = framed else { panic!("a map camera") };
        assert_eq!(center, [0.0, 0.0, 1.2], "turns about the box's middle");
        let view = Projected::new(&plane(), &framed, SIZE, AREA, 0.0);
        for i in 0..8 {
            let s = to_screen(&view, [[min, max][i & 1][0], [min, max][(i >> 1) & 1][1], [min, max][i >> 2][2]]);
            assert!((23.0..=777.0).contains(&s[0]) && (23.0..=577.0).contains(&s[1]), "corner {i}: {s:?}");
        }
    }

    #[test]
    fn panning_turning_and_zooming_keep_the_anchor_in_place() {
        let camera = Camera::Map { center: [0.0, 0.0, 1.0], zoom: 3.0, pitch: 40.0, bearing: 10.0 };
        let view = Projected::new(&plane(), &camera, SIZE, AREA, 0.0);
        let anchor = [3.0, -2.0, 1.5];
        let at = to_screen(&view, anchor);
        let check = |camera: Camera, want: [f64; 2]| {
            let after = Projected::new(&plane(), &camera, SIZE, AREA, 0.0);
            let s = to_screen(&after, anchor);
            assert!((s[0] - want[0]).abs() < 1e-6 && (s[1] - want[1]).abs() < 1e-6, "{s:?} for {want:?}");
        };
        check(camera.panned(&view, anchor, [120.0, -50.0]), [at[0] + 120.0, at[1] - 50.0]);
        check(camera.turned(&view, anchor, [35.0, 12.0]), at);
        check(camera.zoomed(&view, anchor, 1.5, None), at);
        check(camera.zoomed(&view, anchor, -2.0, None), at);
    }

    #[test]
    fn panning_toward_the_horizon_does_not_fling() {
        let camera = Camera::Map { center: [0.0; 3], zoom: 4.0, pitch: 75.0, bearing: 0.0 };
        let view = Projected::new(&plane(), &camera, SIZE, AREA, 0.0);
        let anchor = view.position(view.surface([400.0, 200.0]).expect("ground"));
        let Camera::Map { center, .. } = camera.panned(&view, anchor, [0.0, -190.0]) else { panic!("a map") };
        assert!(center[1].abs() < 100.0, "a drag to the horizon stays near: {center:?}");
    }

    #[test]
    fn earth_positions_round_trip() {
        for globe in [0.0, 1.0] {
            let space = Space::Earth(if globe > 0.0 { Earth::globe() } else { Earth::mercator() });
            let camera = Camera::Map { center: [-97.0, 31.0, 0.0], zoom: 4.0, pitch: 0.0, bearing: 0.0 };
            let view = Projected::new(&space, &camera, SIZE, AREA, globe);
            let p = [-95.5, 29.75, 0.0];
            let back = view.position(view.world(p));
            assert!((back[0] - p[0]).abs() < 1e-9 && (back[1] - p[1]).abs() < 1e-9, "globe {globe}: {back:?}");
            let s = to_screen(&view, p);
            let ground = view.position(view.surface(s).expect("the surface"));
            assert!((ground[0] - p[0]).abs() < 1e-6 && (ground[1] - p[1]).abs() < 1e-6, "globe {globe}: {ground:?}");
        }
        assert!((latitude(mercator_y(37.5)) - 37.5).abs() < 1e-9);
    }

    #[test]
    fn globe_gestures_keep_the_anchor_under_the_pointer() {
        let space = Space::Earth(Earth::globe());
        let camera = Camera::Map { center: [-97.0, 31.0, 0.0], zoom: 3.0, pitch: 20.0, bearing: 15.0 };
        let view = Projected::new(&space, &camera, SIZE, AREA, 1.0);
        let anchor = view.position(view.surface([520.0, 260.0]).expect("the globe"));
        let at = to_screen(&view, anchor);
        let check = |moved: Camera, want: [f64; 2]| {
            let after = Projected::new(&space, &moved, SIZE, AREA, 1.0);
            let s = to_screen(&after, anchor);
            assert!((s[0] - want[0]).abs() < 0.5 && (s[1] - want[1]).abs() < 0.5, "{s:?} for {want:?}");
        };
        check(camera.panned(&view, anchor, [-90.0, 40.0]), [at[0] - 90.0, at[1] + 40.0]);
        check(camera.zoomed(&view, anchor, 1.25, None), at);
        check(camera.zoomed(&view, anchor, -0.75, None), at);
        check(camera.turned(&view, anchor, [25.0, 10.0]), at);
    }

    #[test]
    fn longitude_eases_the_short_way() {
        let a = Camera::Map { center: [170.0, 0.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 350.0 };
        let b = Camera::Map { center: [-170.0, 0.0, 0.0], zoom: 1.0, pitch: 0.0, bearing: 10.0 };
        let earth = Space::Earth(crate::Earth::default());
        let Camera::Map { center, bearing, .. } = a.ease(&b, 0.5, &earth) else { panic!("a map camera") };
        assert!((center[0] - 180.0).abs() < 1e-9);
        assert!((bearing - 360.0).abs() < 1e-9);
    }
}
