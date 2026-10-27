//! The camera's view as tiles; the only place derivations read the camera.
//!
//! Tiles split a square of the space four ways per level: the earth's Web Mercator square, or a
//! square of a plane. A tile is needed where it meets the region in sight, and splits while it
//! draws larger than its nominal size (`TILE_PX`) where it lies nearest the camera's focus.

use glam::DVec3;

use crate::geo::mercator;
use crate::tiles::TileKey;
use crate::view::Projected;

/// CSS pixels a tile spans when drawn at its own level.
pub(crate) const TILE_PX: f64 = 512.0;

/// The square a space's tiles divide: the earth's Web Mercator square, or a square of a plane.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Domain {
    Earth,
    /// A plane's square: its west and south edges and its size, in position units.
    Plane {
        min: [f64; 2],
        size: f64,
    },
}

impl Domain {
    /// The words a job writes the square as: zeros for the earth, else 1, its west and south edges,
    /// and its size.
    pub(crate) fn words(self) -> [f64; 4] {
        match self {
            Domain::Earth => [0.0; 4],
            Domain::Plane { min, size } => [1.0, min[0], min[1], size],
        }
    }

    /// The square written as `words`.
    pub(crate) fn from_words(words: [f64; 4]) -> Domain {
        match words {
            [0.0, ..] => Domain::Earth,
            [_, x, y, size] => Domain::Plane { min: [x, y], size },
        }
    }

    /// The plane square containing `bounds` (west, south, east, north), centered on them and 2%
    /// larger so nothing lies on its edge. Inverted bounds give the unit square.
    pub(crate) fn plane(bounds: [f64; 4]) -> Domain {
        let [w, s, e, n] = if bounds[0] <= bounds[2] { bounds } else { [0.0, 0.0, 1.0, 1.0] };
        let size = (e - w).max(n - s).max(1e-9) * 1.02;
        let center = [w.midpoint(e), s.midpoint(n)];
        Domain::Plane { min: [center[0] - size / 2.0, center[1] - size / 2.0], size }
    }

    /// Where position `p` lies in the square, 0 to 1 from the west and from the north. On the
    /// earth, latitude is clamped to Web Mercator's range and longitude wraps.
    pub(crate) fn unit(&self, p: [f64; 2]) -> [f64; 2] {
        match *self {
            Domain::Earth => [((p[0] + 180.0) / 360.0).rem_euclid(1.0), mercator::down(p[1])],
            Domain::Plane { min, size } => [(p[0] - min[0]) / size, 1.0 - (p[1] - min[1]) / size],
        }
    }

    /// The position at `u` in the square; the inverse of `unit`.
    pub(crate) fn position(&self, u: [f64; 2]) -> [f64; 2] {
        match *self {
            Domain::Earth => [u[0] * 360.0 - 180.0, mercator::latitude_down(u[1])],
            Domain::Plane { min, size } => [min[0] + u[0] * size, min[1] + (1.0 - u[1]) * size],
        }
    }

    /// West, south, east, and north of tile `key` in position units, grown on every side by `grow`
    /// (a fraction of the square) and clamped to the square.
    pub(crate) fn bounds(&self, key: TileKey, grow: f64) -> [f64; 4] {
        let n = f64::from(1_u32 << key.z);
        let (x, y) = (f64::from(key.x), f64::from(key.y));
        let west = (x / n - grow).max(0.0);
        let east = ((x + 1.0) / n + grow).min(1.0);
        let north = (y / n - grow).max(0.0);
        let south = ((y + 1.0) / n + grow).min(1.0);
        let [w, s] = self.position([west, south]);
        let [e, n] = self.position([east, north]);
        [w, s, e, n]
    }
}

/// The camera's view, for choosing tiles and measuring how large they draw.
pub(crate) struct Sight<'a> {
    pub(crate) projected: &'a Projected,
    /// The view's size, in CSS pixels.
    pub(crate) size: [f64; 2],
    pub(crate) earth: bool,
}

/// The region in sight as west, south, east, north boxes in position units: one box, or on the
/// earth two where the region crosses the antimeridian.
pub(crate) type Region = Vec<[f64; 4]>;

impl Sight<'_> {
    /// Where position `p` appears on screen; `None` when it does not show.
    fn project(&self, p: [f64; 2]) -> Option<[f64; 2]> {
        let w = self.projected.world([p[0], p[1], 0.0]);
        if !self.facing(w) {
            return None;
        }
        self.projected.screen(w).map(|s| [s[0], s[1]])
    }

    /// The position on the ground under screen point `p`.
    fn ground(&self, p: [f64; 2]) -> Option<[f64; 2]> {
        let w = self.projected.ground(p)?;
        let [x, y, _] = self.projected.position(w);
        Some([x, y])
    }

    /// The globe's center and radius, in world units.
    fn sphere(&self) -> (DVec3, f64) {
        let radius = 1.0 / self.projected.center[1].to_radians().cos();
        (DVec3::new(0.0, 0.0, -radius), radius)
    }

    fn globe(&self) -> bool {
        self.earth && self.projected.globe >= 0.5
    }

    /// Whether world point `w` faces the camera: always on a flat map; on the globe, only on the
    /// near side.
    fn facing(&self, w: DVec3) -> bool {
        if !self.globe() {
            return true;
        }
        let (center, _) = self.sphere();
        (w - center).dot(self.projected.eye - w) > 0.0
    }

    /// The part of `domain`'s square that one CSS pixel spans at the camera's scale: the earth's
    /// square is a turn of longitude, and a plane's is `size` position units.
    fn pixel(&self, domain: &Domain) -> f64 {
        let square = match *domain {
            Domain::Earth => std::f64::consts::TAU,
            Domain::Plane { size, .. } => size,
        };
        1.0 / (square * self.projected.px_per_unit[0]).max(f64::MIN_POSITIVE)
    }

    /// Where tiles draw largest: the camera's center, and the ground at the bottom middle of the
    /// view, which is the nearest ground when the camera is tilted.
    pub(crate) fn focus(&self) -> Vec<[f64; 2]> {
        let center = [self.projected.center[0], self.projected.center[1]];
        let near = self.ground([self.size[0] / 2.0, self.size[1]]);
        std::iter::once(center).chain(near).collect()
    }

    /// The ground in sight, sampled on a grid of points across the view.
    pub(crate) fn region(&self) -> Region {
        const SAMPLES: usize = 7;
        let globe = self.globe();
        let center = self.projected.center;
        let (mut w, mut s, mut e, mut n) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut missed = false;
        let last = (SAMPLES - 1) as f64;
        for i in 0..SAMPLES {
            for j in 0..SAMPLES {
                let at = [self.size[0] * i as f64 / last, self.size[1] * j as f64 / last];
                let Some([x, y]) = self.ground(at) else {
                    missed = true;
                    continue;
                };
                // Keep longitudes near the center's, so a view across the antimeridian is one span.
                let x = if globe { center[0] + turn(center[0], x) } else { x };
                (w, e, s, n) = (w.min(x), e.max(x), s.min(y), n.max(y));
            }
        }
        if !self.earth {
            if w > e {
                return Vec::new();
            }
            if missed {
                // Some samples miss a tilted plane, which shows its horizon: grow the region by
                // four times its size on each side to cover the ground toward it.
                let size = (e - w).max(n - s) * 4.0;
                return vec![[w - size, s - size, e + size, n + size]];
            }
            return vec![[w, s, e, n]];
        }
        if globe {
            if missed {
                return self.cap();
            }
            let shows = |lat: f64| {
                self.project([center[0], lat])
                    .is_some_and(|p| p[0] >= 0.0 && p[1] >= 0.0 && p[0] <= self.size[0] && p[1] <= self.size[1])
            };
            if shows(90.0) {
                return boxes(-180.0, 180.0, s, 90.0);
            }
            if shows(-90.0) {
                return boxes(-180.0, 180.0, -90.0, n);
            }
        }
        if w > e {
            return vec![[-180.0, -90.0, 180.0, 90.0]];
        }
        if missed {
            // Some samples miss a tilted map, which shows its horizon: grow the region by four
            // times its size on each side to cover the ground toward it.
            let size = (e - w).max(n - s) * 4.0;
            return boxes(w - size, e + size, s - size, n + size);
        }
        let (pad_x, pad_y) = ((e - w) * 0.02, (n - s) * 0.02);
        if globe {
            return boxes(w - pad_x, e + pad_x, s - pad_y, n + pad_y);
        }
        vec![[(w - pad_x).max(-180.0), (s - pad_y).max(-90.0), (e + pad_x).min(180.0), (n + pad_y).min(90.0)]]
    }

    /// The cap of the globe the camera can see, out to its horizon.
    fn cap(&self) -> Region {
        let (center, radius) = self.sphere();
        let out = self.projected.eye - center;
        let reach = (radius / out.length().max(radius)).acos().to_degrees();
        let [lon, lat, _] = self.projected.position(center + out.normalize_or_zero() * radius);
        if reach >= 89.0 {
            return vec![[-180.0, -90.0, 180.0, 90.0]];
        }
        let (south, north) = (lat - reach, lat + reach);
        if north >= 90.0 || south <= -90.0 {
            return boxes(-180.0, 180.0, south, north);
        }
        let half = (reach.to_radians().sin() / lat.to_radians().cos()).min(1.0).asin().to_degrees();
        boxes(lon - half, lon + half, south, north)
    }

    /// How large tile `key` of `domain`'s square draws, in CSS pixels, at its point nearest each
    /// focus, and how far that point is from the view's center. It scales up how far a step of at
    /// most a pixel moves on screen there. A longer step from a large tile could pass the globe's
    /// horizon, where nothing projects, once the camera is close to the ground. On a flat map every
    /// tile of a level measures the same wherever it lies.
    pub(crate) fn measure(&self, focus: &[[f64; 2]], domain: &Domain, key: TileKey) -> (f64, f64) {
        let side = 1.0 / f64::from(1_u32 << key.z);
        let (west, north) = (f64::from(key.x) * side, f64::from(key.y) * side);
        let step = (side / 64.0).min(self.pixel(domain));
        let (mut size, mut distance) = (0.0_f64, f64::INFINITY);
        for &f in focus {
            let [fx, fy] = domain.unit(f);
            // The earth's square wraps: shift the focus a turn either way, whichever is nearer.
            let fx = if *domain == Domain::Earth { fx + (west + side / 2.0 - fx).round() } else { fx };
            let at = [fx.clamp(west, west + side - step), fy.clamp(north, north + side - step)];
            let Some(p) = self.project(domain.position(at)) else { continue };
            let reach = |q: [f64; 2]| {
                self.project(domain.position(q)).map_or(0.0, |q| side / step * (q[0] - p[0]).hypot(q[1] - p[1]))
            };
            size = size.max(reach([at[0] + step, at[1]])).max(reach([at[0], at[1] + step]));
            distance = distance.min((p[0] - self.size[0] / 2.0).hypot(p[1] - self.size[1] / 2.0));
        }
        (size, distance)
    }
}

/// The shortest signed turn from longitude `from` to `to`, in degrees.
fn turn(from: f64, to: f64) -> f64 {
    (to - from + 540.0).rem_euclid(360.0) - 180.0
}

/// The boxes covering a longitude range that may wrap the antimeridian, and a latitude range
/// clamped to ±90°.
fn boxes(west: f64, east: f64, south: f64, north: f64) -> Region {
    let (s, n) = (south.max(-90.0), north.min(90.0));
    if east - west >= 360.0 {
        return vec![[-180.0, s, 180.0, n]];
    }
    let w = (west + 180.0).rem_euclid(360.0) - 180.0;
    let e = w + (east - west);
    if e <= 180.0 { vec![[w, s, e, n]] } else { vec![[w, s, 180.0, n], [-180.0, s, e - 360.0, n]] }
}

/// Whether box `b` meets the region in sight.
pub(crate) fn meets(region: &Region, b: [f64; 4]) -> bool {
    region.iter().any(|r| b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_map_positions_into_their_unit_square() {
        let earth = Domain::Earth;
        let u = earth.unit([0.0, 0.0]);
        assert!((u[0] - 0.5).abs() < 1e-12 && (u[1] - 0.5).abs() < 1e-12);
        let back = earth.position(earth.unit([-97.5, 30.25]));
        assert!((back[0] + 97.5).abs() < 1e-9 && (back[1] - 30.25).abs() < 1e-9);
        let plane = Domain::plane([0.0, 0.0, 10.0, 5.0]);
        let u = plane.unit([5.0, 2.5]);
        assert!((u[0] - 0.5).abs() < 1e-12 && (u[1] - 0.5).abs() < 1e-12, "the middle of the data maps to 0.5");
        let b = plane.bounds(TileKey { z: 1, x: 0, y: 0 }, 0.0);
        assert!(b[0] < 0.0 && b[3] > 5.0, "the northwest quarter: {b:?}");
    }

    #[test]
    fn tiles_under_the_focus_measure_their_size_on_the_globe_at_any_zoom() {
        let globe = crate::Space::Earth(crate::Earth::default().projection(crate::Projection::Globe));
        let size = [800.0, 600.0];
        let center = [-74.0, 40.7];
        // Past zoom 12 the camera's horizon is nearer than a sixty-fourth of the root tile.
        for zoom in [3.0, 8.0, 13.0, 18.0, 22.0] {
            let camera = crate::Camera::Map { center: [center[0], center[1], 0.0], zoom, pitch: 0.0, bearing: 0.0 };
            let projected = Projected::new(&globe, &camera, size, [0.0, 0.0, size[0], size[1]], 1.0);
            let sight = Sight { projected: &projected, size, earth: true };
            let [u, v] = Domain::Earth.unit(center);
            for z in [0_u8, 6, 12] {
                let n = f64::from(1_u32 << z);
                let key = TileKey { z, x: (u * n) as u32, y: (v * n) as u32 };
                let (px, _) = sight.measure(&sight.focus(), &Domain::Earth, key);
                // A large tile measures where it is largest: south of the center, a mercator step
                // covers more of the globe.
                let nominal = 256.0 * 2_f64.powf(zoom) / n;
                assert!((0.95..1.3).contains(&(px / nominal)), "zoom {zoom}, level {z}: {px} px, not {nominal}");
            }
        }
    }
}
