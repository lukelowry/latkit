use std::f64::consts::{PI, TAU};

use glam::{DMat4, DVec3};

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

    /// The camera showing `bounds` (`[min x, min y, max x, max y]` in position units) with `padding`
    /// CSS pixels around it in a view of `size` CSS pixels.
    pub(crate) fn fit(&self, space: &Space, bounds: [f64; 4], size: [f64; 2], padding: f64) -> Camera {
        let room = [(size[0] - 2.0 * padding).max(1.0), (size[1] - 2.0 * padding).max(1.0)];
        match (space, self) {
            (Space::Earth(_), Camera::Map { pitch, bearing, .. }) => {
                let (y0, y1) = (mercator_y(bounds[1]), mercator_y(bounds[3]));
                let dx = (bounds[2] - bounds[0]).to_radians().max(1e-9);
                let dy = (y1 - y0).max(1e-9);
                let px_per_radian = (room[0] / dx).min(room[1] / dy);
                let zoom = (px_per_radian * TAU / 256.0).log2().clamp(0.0, 22.0);
                let center = [bounds[0].midpoint(bounds[2]), latitude(y0.midpoint(y1))];
                Camera::Map { center, zoom, pitch: *pitch, bearing: *bearing }
            }
            (Space::Plane(_), Camera::Map { pitch, bearing, .. }) => {
                let dx = (bounds[2] - bounds[0]).max(1e-9);
                let dy = (bounds[3] - bounds[1]).max(1e-9);
                let zoom = (room[0] / dx).min(room[1] / dy).log2();
                let center = [bounds[0].midpoint(bounds[2]), bounds[1].midpoint(bounds[3])];
                Camera::Map { center, zoom, pitch: *pitch, bearing: *bearing }
            }
            (Space::Plot(_), _) => {
                let pad = |lo: f64, hi: f64, px: f64| {
                    let span = (hi - lo).max(1e-9);
                    let extra = span * padding / px.max(1.0);
                    [lo - extra, hi + extra]
                };
                Camera::Plot { x: [bounds[0], bounds[2]], y: Some(pad(bounds[1], bounds[3], room[1])) }
            }
            _ => Camera::default_for(space).fit(space, bounds, size, padding),
        }
    }
}

pub(crate) fn mercator_y(latitude: f64) -> f64 {
    let lat = latitude.clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
    (PI / 4.0 + lat / 2.0).tan().ln()
}

pub(crate) fn latitude(mercator_y: f64) -> f64 {
    (2.0 * mercator_y.exp().atan() - PI / 2.0).to_degrees()
}

/// What the frame uniform needs from a camera looking at a space.
pub(crate) struct Projected {
    pub(crate) clip_from_world: DMat4,
    pub(crate) center: [f64; 2],
    pub(crate) px_per_unit: [f64; 2],
    pub(crate) mercator_y: f64,
    pub(crate) globe: f64,
    pub(crate) space: u32,
}

impl Projected {
    /// The projection of `camera` looking at `space` in a view of `size` CSS pixels.
    pub(crate) fn new(space: &Space, camera: &Camera, size: [f64; 2], globe: f64) -> Projected {
        let camera = if camera.fits(space) { *camera } else { Camera::default_for(space) };
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
                let px = [size[0] / (x[1] - x[0]).abs().max(1e-12), size[1] / (y[1] - y[0]).abs().max(1e-12)];
                ([x[0].midpoint(x[1]), y[0].midpoint(y[1])], px, 0.0, 0.0, wgsl::SPACE_PLOT)
            }
            _ => unreachable!("the camera fits the space"),
        };
        let (w, h) = (size[0].max(1.0), size[1].max(1.0));
        let distance = 0.5 * h / (0.5 * FOV).tan();
        let projection = perspective(FOV, w / h, distance * 0.01, distance * 100.0);
        let view = DMat4::from_translation(DVec3::new(0.0, 0.0, -distance))
            * DMat4::from_rotation_x(-pitch.clamp(0.0, MAX_PITCH).to_radians())
            * DMat4::from_rotation_z(bearing.to_radians())
            * DMat4::from_scale(DVec3::new(px_per_unit[0], px_per_unit[1], px_per_unit[0]));
        let mercator = if space_code == wgsl::SPACE_EARTH { mercator_y(center[1]) } else { 0.0 };
        Projected {
            clip_from_world: projection * view,
            center,
            px_per_unit,
            mercator_y: mercator,
            globe: if space_code == wgsl::SPACE_EARTH { globe } else { 0.0 },
            space: space_code,
        }
    }

    /// Where position `p` lands on screen, in CSS pixels from the top left, on a flat projection.
    #[cfg(test)]
    fn to_screen(&self, p: [f64; 2], size: [f64; 2]) -> [f64; 2] {
        let world = match self.space {
            wgsl::SPACE_EARTH => {
                DVec3::new((p[0] - self.center[0]).to_radians(), mercator_y(p[1]) - self.mercator_y, 0.0)
            }
            _ => DVec3::new(p[0] - self.center[0], p[1] - self.center[1], 0.0),
        };
        let clip = self.clip_from_world * world.extend(1.0);
        let ndc = [clip.x / clip.w, clip.y / clip.w];
        [(ndc[0] * 0.5 + 0.5) * size[0], (0.5 - ndc[1] * 0.5) * size[1]]
    }
}

/// A right-handed perspective projection onto WebGPU's clip space, depth `0..=1`.
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

    #[test]
    fn plane_centers_and_scales() {
        let space = Space::Plane(Plane::default());
        let camera = Camera::Map { center: [10.0, 20.0], zoom: 1.0, pitch: 0.0, bearing: 0.0 };
        let projection = Projected::new(&space, &camera, [800.0, 600.0], 0.0);
        let center = projection.to_screen([10.0, 20.0], [800.0, 600.0]);
        assert!((center[0] - 400.0).abs() < 1e-6 && (center[1] - 300.0).abs() < 1e-6);
        let right = projection.to_screen([11.0, 21.0], [800.0, 600.0]);
        assert!((right[0] - 402.0).abs() < 1e-6, "two pixels per unit at zoom 1");
        assert!((right[1] - 298.0).abs() < 1e-6, "y up");
    }

    #[test]
    fn fit_frames_bounds() {
        let space = Space::Earth(Earth::mercator());
        let camera = Camera::default_for(&space).fit(&space, [-100.0, 30.0, -90.0, 40.0], [800.0, 600.0], 20.0);
        let projection = Projected::new(&space, &camera, [800.0, 600.0], 0.0);
        let lo = projection.to_screen([-100.0, 30.0], [800.0, 600.0]);
        let hi = projection.to_screen([-90.0, 40.0], [800.0, 600.0]);
        assert!(lo[0] >= 19.0 && hi[0] <= 781.0 && hi[1] >= 19.0 && lo[1] <= 581.0, "{lo:?} {hi:?}");
        assert!((latitude(mercator_y(37.5)) - 37.5).abs() < 1e-9);
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
