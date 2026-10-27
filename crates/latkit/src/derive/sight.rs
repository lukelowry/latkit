//! The camera's view as tiles. This is the only place derivations read the camera.
//!
//! Tiles split a square of the space four ways per level: the earth's Web Mercator square, or a
//! square of a plane. On the globe, the earth's square wraps at the antimeridian. On a flat map it
//! ends there, so the map is one world. A tile is needed where it meets the visible region. It
//! splits while it draws larger than its nominal size (`TILE_PX`) at its point nearest the camera's
//! focus. A tile's drawn size is the square root of the screen area it covers there, so a tile
//! foreshortened toward the globe's limb or a tilted horizon stays coarse. When a budget limits how
//! many tiles split, the tiles drawn largest split first.

use glam::DVec3;

use crate::geo::mercator;
use crate::tiles::TileKey;
use crate::view::Projected;

/// CSS pixels a tile spans when drawn at its own level.
pub(crate) const TILE_PX: f64 = 512.0;
/// CSS pixels past which a tile splits: its nominal size with 25% slack.
pub(crate) const SPLIT_PX: f64 = TILE_PX * 1.25;

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

    /// The position at `u` in the square. The inverse of `unit`.
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

/// The visible region as west, south, east, north boxes in position units: one box, or on the
/// globe two boxes where the region crosses the antimeridian.
pub(crate) type Region = Vec<[f64; 4]>;

impl Sight<'_> {
    /// Where position `p` appears on screen. `None` when it does not show.
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

    /// Whether world point `w` faces the camera: always on a flat map, and only on the near side on
    /// the globe.
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

    /// The visible ground, sampled on a grid of points across the view. On a flat map it ends at
    /// the world's edges. On the globe it wraps the antimeridian.
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
        // Some samples miss a tilted map, which shows its horizon: grow the region by four times
        // its size on each side to cover the ground toward it. Otherwise pad it by 2%.
        let (grow_x, grow_y) = if missed {
            let size = (e - w).max(n - s) * 4.0;
            (size, size)
        } else {
            ((e - w) * 0.02, (n - s) * 0.02)
        };
        if globe {
            return boxes(w - grow_x, e + grow_x, s - grow_y, n + grow_y);
        }
        // A flat map is one world: the region ends at its edges rather than wrapping.
        vec![[(w - grow_x).max(-180.0), (s - grow_y).max(-90.0), (e + grow_x).min(180.0), (n + grow_y).min(90.0)]]
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

    /// How large tile `key` of `domain`'s square draws, in CSS pixels, and how far from the view's
    /// center the measured point is. The size is measured at the tile's point nearest each focus,
    /// and the largest is kept. It is the square root of the screen area the tile would cover at
    /// the scale there: the area spanned by steps of at most a pixel along its two edges, scaled up
    /// to the whole tile. So a tile foreshortened toward the globe's limb or a tilted horizon
    /// measures less than its longer side. Steps are short because a longer step from a large tile
    /// could pass the globe's horizon, where nothing projects, once the camera is close to the
    /// ground. On a flat map seen from above, every tile of a level measures the same wherever it
    /// lies.
    pub(crate) fn measure(&self, focus: &[[f64; 2]], domain: &Domain, key: TileKey) -> (f64, f64) {
        let side = 1.0 / f64::from(1_u32 << key.z);
        let (west, north) = (f64::from(key.x) * side, f64::from(key.y) * side);
        let step = (side / 64.0).min(self.pixel(domain));
        let (mut size, mut distance) = (0.0_f64, f64::INFINITY);
        for &f in focus {
            let [fx, fy] = domain.unit(f);
            let fx = match domain {
                // The globe wraps: shift the focus a turn either way, whichever is nearer.
                Domain::Earth if self.globe() => fx + (west + side / 2.0 - fx).round(),
                // A flat map is one world: a focus past its edge stays there, far from the tiles
                // across the antimeridian.
                Domain::Earth => (f[0] + 180.0) / 360.0,
                Domain::Plane { .. } => fx,
            };
            let at = [fx.clamp(west, west + side - step), fy.clamp(north, north + side - step)];
            let Some(p) = self.project(domain.position(at)) else { continue };
            // Where a step along each edge moves on screen. A step past the globe's horizon counts
            // as no move.
            let moved = |q: [f64; 2]| self.project(domain.position(q)).map_or([0.0; 2], |q| [q[0] - p[0], q[1] - p[1]]);
            let ([ax, ay], [bx, by]) = (moved([at[0] + step, at[1]]), moved([at[0], at[1] + step]));
            size = size.max(side / step * (ax * by - ay * bx).abs().sqrt());
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

/// Whether box `b` meets the visible region.
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
                // Under the center the globe is seen square on, so a tile measures its size there.
                // A large tile measures where it is largest, which may lie south of the center,
                // where a mercator step covers more of the globe.
                let nominal = 256.0 * 2_f64.powf(zoom) / n;
                assert!((0.95..1.3).contains(&(px / nominal)), "zoom {zoom}, level {z}: {px} px, not {nominal}");
            }
        }
    }

    #[test]
    fn tiles_foreshortened_by_a_tilted_camera_measure_the_area_they_cover() {
        let map = crate::Space::Earth(crate::Earth::default());
        let size = [800.0, 600.0];
        let center = [-74.0, 40.7];
        let [u, v] = Domain::Earth.unit(center);
        let key = TileKey { z: 12, x: (u * 4096.0) as u32, y: (v * 4096.0) as u32 };
        let measured = |pitch: f64| {
            let camera = crate::Camera::Map { center: [center[0], center[1], 0.0], zoom: 8.0, pitch, bearing: 0.0 };
            let projected = Projected::new(&map, &camera, size, [0.0, 0.0, size[0], size[1]], 0.0);
            let sight = Sight { projected: &projected, size, earth: true };
            sight.measure(&sight.focus(), &Domain::Earth, key).0
        };
        // Tilted 60°, a tile under the center keeps its width on screen and draws half as tall, so
        // its area as a side is about √½ of what it measures seen from above.
        let ratio = measured(60.0) / measured(0.0);
        assert!((0.65..0.8).contains(&ratio), "{ratio}");
    }

    #[test]
    fn a_flat_map_ends_at_the_antimeridian() {
        let map = crate::Space::Earth(crate::Earth::default());
        let size = [800.0, 600.0];
        let tile = |lon: f64| {
            let [u, v] = Domain::Earth.unit([lon, 0.0]);
            TileKey { z: 10, x: (u * 1024.0) as u32, y: (v * 1024.0) as u32 }
        };
        let (near, across) = (tile(179.0), tile(-179.0));
        // Seen from above, and tilted to show the horizon, which grows the region several times
        // over: on a globe that region would wrap past 180° onto the tiles across it.
        for pitch in [0.0, 75.0] {
            let camera = crate::Camera::Map { center: [179.0, 0.0, 0.0], zoom: 10.0, pitch, bearing: 0.0 };
            let projected = Projected::new(&map, &camera, size, [0.0, 0.0, size[0], size[1]], 0.0);
            let sight = Sight { projected: &projected, size, earth: true };
            let region = sight.region();
            assert!(region.iter().all(|r| r[0] >= -180.0 && r[2] <= 180.0), "pitch {pitch}: {region:?}");
            assert!(meets(&region, near.bounds()), "pitch {pitch}: {region:?}");
            assert!(!meets(&region, across.bounds()), "pitch {pitch}: {region:?}");
            let focus = sight.focus();
            let ((_, beside), (_, beyond)) =
                (sight.measure(&focus, &Domain::Earth, near), sight.measure(&focus, &Domain::Earth, across));
            assert!(beside < 1.0 && beyond > size[0], "pitch {pitch}: {beside} px and {beyond} px from the center");
        }
    }
}
