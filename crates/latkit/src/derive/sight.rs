//! What the camera sees, as tiles: the one place derivations read the camera. Tiles split a
//! square of the space four ways a level, the earth's web mercator square or a square of a plane; a
//! tile is wanted where it meets what the camera shows, and splits while it draws larger than its
//! size where it lies nearest the camera's focus.

use glam::DVec3;

use crate::tiles::TileKey;
use crate::view::Projected;

/// CSS pixels a tile spans drawn at its own level.
pub(crate) const TILE_PX: f64 = 512.0;
/// The latitude web mercator reaches, north and south.
const MAX_LATITUDE: f64 = 85.051_128_779_806_59;

/// Where a space's tiles lie: the earth's web mercator square, or a square of a plane.
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
    /// The square holding positions within `bounds` (west, south, east, north) on a plane, with a
    /// little room so nothing lies on its edge.
    pub(crate) fn plane(bounds: [f64; 4]) -> Domain {
        let [w, s, e, n] = if bounds[0] <= bounds[2] { bounds } else { [0.0, 0.0, 1.0, 1.0] };
        let size = (e - w).max(n - s).max(1e-9) * 1.02;
        let center = [w.midpoint(e), s.midpoint(n)];
        Domain::Plane { min: [center[0] - size / 2.0, center[1] - size / 2.0], size }
    }

    /// Where position `p` lies across the square, 0 to 1 from the west and from the north.
    pub(crate) fn unit(&self, p: [f64; 2]) -> [f64; 2] {
        match *self {
            Domain::Earth => {
                let lat = p[1].clamp(-MAX_LATITUDE, MAX_LATITUDE).to_radians();
                let y = 0.5 - (std::f64::consts::FRAC_PI_4 + lat / 2.0).tan().ln() / std::f64::consts::TAU;
                [((p[0] + 180.0) / 360.0).rem_euclid(1.0), y]
            }
            Domain::Plane { min, size } => [(p[0] - min[0]) / size, 1.0 - (p[1] - min[1]) / size],
        }
    }

    /// The position at `u` across the square.
    pub(crate) fn position(&self, u: [f64; 2]) -> [f64; 2] {
        match *self {
            Domain::Earth => {
                let lat = (std::f64::consts::PI * (1.0 - 2.0 * u[1])).sinh().atan().to_degrees();
                [u[0] * 360.0 - 180.0, lat]
            }
            Domain::Plane { min, size } => [min[0] + u[0] * size, min[1] + (1.0 - u[1]) * size],
        }
    }

    /// West, south, east, and north of tile `key`, grown on every side by `grow` across the square,
    /// within the square.
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

/// What the camera sees: where tiles are wanted and how large they draw.
pub(crate) struct Sight<'a> {
    pub(crate) projected: &'a Projected,
    /// The view's size, CSS pixels.
    pub(crate) size: [f64; 2],
    pub(crate) earth: bool,
}

/// West, south, east, north boxes, in position units: what the camera shows, in one box, or on the
/// earth two where it wraps the antimeridian.
pub(crate) type Region = Vec<[f64; 4]>;

impl Sight<'_> {
    /// Where position `p` lands on screen, if it shows.
    fn project(&self, p: [f64; 2]) -> Option<[f64; 2]> {
        let w = self.projected.world([p[0], p[1], 0.0]);
        if !self.facing(w) {
            return None;
        }
        self.projected.screen(w).map(|s| [s[0], s[1]])
    }

    /// The position on the ground under screen point `p`.
    fn ground(&self, p: [f64; 2]) -> Option<[f64; 2]> {
        let w = self.projected.surface(p)?;
        let [x, y, _] = self.projected.position(w);
        Some([x, y])
    }

    /// The center of the globe the earth is, and its radius, in world units.
    fn sphere(&self) -> (DVec3, f64) {
        let radius = 1.0 / self.projected.center[1].to_radians().cos();
        (DVec3::new(0.0, 0.0, -radius), radius)
    }

    fn globe(&self) -> bool {
        self.earth && self.projected.globe >= 0.5
    }

    /// Whether world point `w` faces the camera: always on a map, on the globe its near side.
    fn facing(&self, w: DVec3) -> bool {
        if !self.globe() {
            return true;
        }
        let (center, _) = self.sphere();
        (w - center).dot(self.projected.eye - w) > 0.0
    }

    /// Where tiles draw largest: where the camera looks, and tilted, the nearest ground it shows.
    pub(crate) fn focus(&self) -> Vec<[f64; 2]> {
        let center = [self.projected.center[0], self.projected.center[1]];
        let near = self.ground([self.size[0] / 2.0, self.size[1]]);
        std::iter::once(center).chain(near).collect()
    }

    /// The ground the camera shows, sampled on a grid of points across the view.
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
                // Longitudes kept beside the center's, so a view across the antimeridian is one span.
                let x = if globe { center[0] + turn(center[0], x) } else { x };
                (w, e, s, n) = (w.min(x), e.max(x), s.min(y), n.max(y));
            }
        }
        if !self.earth {
            if w > e {
                return Vec::new();
            }
            if missed {
                // A tilted plane past its horizon: everything toward it.
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
            // A tilted map past its horizon: everything toward it.
            let size = (e - w).max(n - s) * 4.0;
            return boxes(w - size, e + size, s - size, n + size);
        }
        let (pad_x, pad_y) = ((e - w) * 0.02, (n - s) * 0.02);
        if globe {
            return boxes(w - pad_x, e + pad_x, s - pad_y, n + pad_y);
        }
        vec![[(w - pad_x).max(-180.0), (s - pad_y).max(-90.0), (e + pad_x).min(180.0), (n + pad_y).min(90.0)]]
    }

    /// The cap of the globe the camera can see past its horizon.
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

    /// How large tile `key` of `domain`'s square draws where it lies nearest each focus, and how far
    /// from the view's middle that lands. It steps across the tile in the square, where the tiles of a
    /// level are alike, so on a flat map they all measure the same wherever they lie.
    pub(crate) fn measure(&self, focus: &[[f64; 2]], domain: &Domain, key: TileKey) -> (f64, f64) {
        let side = 1.0 / f64::from(1_u32 << key.z);
        let (west, north) = (f64::from(key.x) * side, f64::from(key.y) * side);
        let step = side / 64.0;
        let (mut size, mut distance) = (0.0_f64, f64::INFINITY);
        for &f in focus {
            let [fx, fy] = domain.unit(f);
            // The earth's square wraps: the focus a turn either way, whichever lies nearer the tile.
            let fx = if *domain == Domain::Earth { fx + (west + side / 2.0 - fx).round() } else { fx };
            let at = [fx.clamp(west, west + side - step), fy.clamp(north, north + side - step)];
            let Some(p) = self.project(domain.position(at)) else { continue };
            let reach =
                |q: [f64; 2]| self.project(domain.position(q)).map_or(0.0, |q| 64.0 * (q[0] - p[0]).hypot(q[1] - p[1]));
            size = size.max(reach([at[0] + step, at[1]])).max(reach([at[0], at[1] + step]));
            distance = distance.min((p[0] - self.size[0] / 2.0).hypot(p[1] - self.size[1] / 2.0));
        }
        (size, distance)
    }
}

/// The shortest turn from longitude `from` to `to`, in degrees.
fn turn(from: f64, to: f64) -> f64 {
    (to - from + 540.0).rem_euclid(360.0) - 180.0
}

/// The boxes of a longitude range that may wrap, and a latitude range.
fn boxes(west: f64, east: f64, south: f64, north: f64) -> Region {
    let (s, n) = (south.max(-90.0), north.min(90.0));
    if east - west >= 360.0 {
        return vec![[-180.0, s, 180.0, n]];
    }
    let w = (west + 180.0).rem_euclid(360.0) - 180.0;
    let e = w + (east - west);
    if e <= 180.0 { vec![[w, s, e, n]] } else { vec![[w, s, 180.0, n], [-180.0, s, e - 360.0, n]] }
}

/// Whether box `b` meets what the camera shows.
pub(crate) fn meets(region: &Region, b: [f64; 4]) -> bool {
    region.iter().any(|r| b[0] <= r[2] && b[2] >= r[0] && b[1] <= r[3] && b[3] >= r[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_place_positions_across_their_square() {
        let earth = Domain::Earth;
        let u = earth.unit([0.0, 0.0]);
        assert!((u[0] - 0.5).abs() < 1e-12 && (u[1] - 0.5).abs() < 1e-12);
        let back = earth.position(earth.unit([-97.5, 30.25]));
        assert!((back[0] + 97.5).abs() < 1e-9 && (back[1] - 30.25).abs() < 1e-9);
        let plane = Domain::plane([0.0, 0.0, 10.0, 5.0]);
        let u = plane.unit([5.0, 2.5]);
        assert!((u[0] - 0.5).abs() < 1e-12 && (u[1] - 0.5).abs() < 1e-12, "the middle of the data");
        let b = plane.bounds(TileKey { z: 1, x: 0, y: 0 }, 0.0);
        assert!(b[0] < 0.0 && b[3] > 5.0, "the northwest quarter: {b:?}");
    }
}
