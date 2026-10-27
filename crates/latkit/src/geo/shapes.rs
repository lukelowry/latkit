//! Converts geometry into drawable shapes: polygon triangles with a label anchor, and earth paths
//! that follow the globe.
//!
//! On the earth, longitudes are unwrapped across the antimeridian so no shape streaks across the
//! map. No piece spans more than [`EARTH_STEP`] degrees: triangles are split along a grid of that
//! pitch, and paths gain points.

use std::collections::BinaryHeap;

use super::earcut::earcut;

type Point = [f64; 2];

/// Largest span in degrees, in longitude or latitude, of an earth triangle or path segment. A chord
/// this long sags less than 1/2000 of the globe's radius.
pub(crate) const EARTH_STEP: f64 = 2.0;

/// Triangulates `polygons`, each an outer ring followed by holes, into a point list: the label
/// anchor first, then three points per triangle. The anchor lies in the polygon with the largest
/// outer ring. Returns an empty list when there are no triangles. With `earth`, rings are unwrapped
/// and triangles split along the [`EARTH_STEP`] grid.
pub(crate) fn triangles(polygons: &[Vec<Vec<Point>>], earth: bool) -> Vec<Point> {
    let mut out = vec![[f64::NAN; 2]];
    let mut largest: Option<(f64, Vec<Vec<Point>>)> = None;
    for polygon in polygons {
        let rings: Vec<Vec<Point>> = if earth { unwrapped(polygon) } else { polygon.clone() };
        let Some(outer) = rings.first().filter(|r| r.len() >= 3) else { continue };
        let area = ring_area(outer).abs();
        let mut points: Vec<Point> = Vec::with_capacity(rings.iter().map(Vec::len).sum());
        let mut holes = Vec::with_capacity(rings.len().saturating_sub(1));
        for (k, ring) in rings.iter().enumerate() {
            if k > 0 {
                if ring.len() < 3 {
                    continue;
                }
                holes.push(points.len());
            }
            points.extend(ring.iter().copied().filter(|p| p[0].is_finite() && p[1].is_finite()));
        }
        for t in earcut(&points, &holes) {
            let corners = t.map(|i| points[i as usize]);
            if earth { split(corners, &mut out) } else { out.extend(corners) }
        }
        if largest.as_ref().is_none_or(|(a, _)| area > *a) {
            largest = Some((area, rings));
        }
    }
    if out.len() == 1 {
        return Vec::new();
    }
    if let Some((_, rings)) = largest {
        out[0] = label_point(&rings);
    }
    out
}

/// Prepares `parts` for an earth path: longitudes unwrapped across the antimeridian, and points
/// added every [`EARTH_STEP`] degrees along longer segments. `None` if no segment needs either.
pub(crate) fn earth_parts(parts: &[Vec<Point>]) -> Option<Vec<Vec<Point>>> {
    let changes = parts.iter().any(|part| {
        part.windows(2).any(|w| (w[1][0] - w[0][0]).abs() > EARTH_STEP || (w[1][1] - w[0][1]).abs() > EARTH_STEP)
    });
    changes.then(|| parts.iter().map(|part| densified(&unwrap(part))).collect())
}

/// Unwraps each ring of `polygon` so its longitudes are continuous, then shifts it by whole turns
/// to start within 180 degrees of the outer ring's first point.
fn unwrapped(polygon: &[Vec<Point>]) -> Vec<Vec<Point>> {
    let first = polygon.first().and_then(|r| r.first()).map_or(0.0, |p| p[0]);
    polygon
        .iter()
        .map(|ring| {
            let mut ring = unwrap(ring);
            if let Some(start) = ring.first().map(|p| p[0]) {
                let shift = 360.0 * turns(first - start);
                if shift != 0.0 {
                    for p in &mut ring {
                        p[0] += shift;
                    }
                }
            }
            ring
        })
        .collect()
}

/// Shifts each longitude of `line` by whole turns to within 180 degrees of the previous point's.
fn unwrap(line: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::with_capacity(line.len());
    for &p in line {
        let mut p = p;
        if let Some(prev) = out.last() {
            p[0] += 360.0 * turns(prev[0] - p[0]);
        }
        out.push(p);
    }
    out
}

/// Whole turns (360 degrees) that bring a longitude step of `degrees` within 180 degrees. A step of
/// exactly 180 is kept as given, because a zoom-1 tile's edges span exactly that and their
/// direction matters.
fn turns(degrees: f64) -> f64 {
    degrees.signum() * ((degrees.abs() - 180.0) / 360.0).ceil().max(0.0)
}

/// Adds points every [`EARTH_STEP`] degrees along longer segments of `line`, interpolated linearly
/// in longitude and latitude.
fn densified(line: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::with_capacity(line.len());
    for (k, &p) in line.iter().enumerate() {
        if k > 0 {
            let a = line[k - 1];
            let steps = ((p[0] - a[0]).abs().max((p[1] - a[1]).abs()) / EARTH_STEP).ceil() as usize;
            for s in 1..steps {
                let t = s as f64 / steps as f64;
                out.push([a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t]);
            }
        }
        out.push(p);
    }
    out
}

/// Cuts triangle `t` along the [`EARTH_STEP`] grid and fans each cell's piece into triangles. A
/// triangle within one cell is kept whole. Each crossing is computed from its edge's endpoints in a
/// fixed order, so triangles sharing an edge get identical crossings and no cracks appear.
fn split(t: [Point; 3], out: &mut Vec<Point>) {
    let cell = |v: f64| (v / EARTH_STEP).floor();
    let lo = [0, 1].map(|k| cell(t[0][k].min(t[1][k]).min(t[2][k])));
    let hi = [0, 1].map(|k| cell(t[0][k].max(t[1][k]).max(t[2][k])));
    if lo == hi || !lo.iter().chain(&hi).all(|v| v.is_finite()) {
        out.extend(t);
        return;
    }
    let mut piece: Vec<Point> = Vec::with_capacity(9);
    let mut next: Vec<Point> = Vec::with_capacity(9);
    let mut x = lo[0];
    while x <= hi[0] {
        let mut y = lo[1];
        while y <= hi[1] {
            piece.clear();
            piece.extend(t);
            for (axis, at, keep_above) in [
                (0, x * EARTH_STEP, true),
                (0, (x + 1.0) * EARTH_STEP, false),
                (1, y * EARTH_STEP, true),
                (1, (y + 1.0) * EARTH_STEP, false),
            ] {
                clip(&piece, axis, at, keep_above, &mut next);
                std::mem::swap(&mut piece, &mut next);
                if piece.len() < 3 {
                    break;
                }
            }
            for k in 1..piece.len().saturating_sub(1) {
                out.extend([piece[0], piece[k], piece[k + 1]]);
            }
            y += 1.0;
        }
        x += 1.0;
    }
}

/// Clips convex polygon `piece` to one side of the line where coordinate `axis` equals `at`: at or
/// above it when `keep_above`, else at or below it. Writes the result to `out`.
fn clip(piece: &[Point], axis: usize, at: f64, keep_above: bool, out: &mut Vec<Point>) {
    out.clear();
    let inside = |p: &Point| if keep_above { p[axis] >= at } else { p[axis] <= at };
    for (k, &p) in piece.iter().enumerate() {
        let q = piece[(k + 1) % piece.len()];
        let (p_in, q_in) = (inside(&p), inside(&q));
        if p_in {
            out.push(p);
        }
        if p_in != q_in {
            out.push(crossing(p, q, axis, at));
        }
    }
}

/// Where segment `p q` crosses the line where coordinate `axis` equals `at`. The endpoints are
/// ordered first, so the result does not depend on the segment's direction.
fn crossing(p: Point, q: Point, axis: usize, at: f64) -> Point {
    let (a, b) = if (p[0], p[1]) <= (q[0], q[1]) { (p, q) } else { (q, p) };
    let t = (at - a[axis]) / (b[axis] - a[axis]);
    let other = 1 - axis;
    let mut out = [0.0; 2];
    out[axis] = at;
    out[other] = a[other] + (b[other] - a[other]) * t;
    out
}

/// Twice the signed area of a ring.
fn ring_area(ring: &[Point]) -> f64 {
    let Some(&last) = ring.last() else { return 0.0 };
    let mut sum = 0.0;
    let mut j = last;
    for &p in ring {
        sum += (j[0] - p[0]) * (p[1] + j[1]);
        j = p;
    }
    sum
}

/// A polygon's label anchor: the interior point farthest from its edges, found to within 1/50 of
/// its longer side by polylabel's method.
fn label_point(rings: &[Vec<Point>]) -> Point {
    let Some(outer) = rings.first() else { return [f64::NAN; 2] };
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for p in outer {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let (short, long) = ((hi[0] - lo[0]).min(hi[1] - lo[1]), (hi[0] - lo[0]).max(hi[1] - lo[1]));
    if short.is_nan() || short <= 0.0 {
        return [lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1])];
    }
    // Initial cells are squares as wide as the shorter side, with at most 16 along the longer side.
    let size = short.max(long / 16.0);
    let precision = long / 50.0;
    let probe = |center: Point, half: f64| Cell::new(center, half, signed_distance(center, rings));
    let mut queue = BinaryHeap::new();
    let mut h = size / 2.0;
    let mut x = lo[0];
    while x < hi[0] {
        let mut y = lo[1];
        while y < hi[1] {
            queue.push(probe([x + h, y + h], h));
            y += size;
        }
        x += size;
    }
    let mut best = probe(centroid(outer), 0.0);
    let middle = probe([lo[0].midpoint(hi[0]), lo[1].midpoint(hi[1])], 0.0);
    if middle.distance > best.distance {
        best = middle;
    }
    // Each probe is a pass over the rings, so cap the probes to bound the cost on huge polygons.
    let mut probes = 0;
    while let Some(cell) = queue.pop() {
        if cell.distance > best.distance {
            best = cell;
        }
        if cell.max - best.distance <= precision || probes > 4096 {
            continue;
        }
        h = cell.half / 2.0;
        for [dx, dy] in [[-1.0, -1.0], [1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]] {
            queue.push(probe([cell.center[0] + dx * h, cell.center[1] + dy * h], h));
            probes += 1;
        }
    }
    best.center
}

/// A square cell in polylabel's search: its center, half its side, the signed distance from its
/// center to the polygon's edges (negative outside), and `max`, an upper bound on that distance for
/// any point in the cell.
#[derive(Clone, Copy)]
struct Cell {
    center: Point,
    half: f64,
    distance: f64,
    max: f64,
}

impl Cell {
    fn new(center: Point, half: f64, distance: f64) -> Cell {
        Cell { center, half, distance, max: distance + half * std::f64::consts::SQRT_2 }
    }
}

impl PartialEq for Cell {
    fn eq(&self, other: &Cell) -> bool {
        self.max == other.max
    }
}

impl Eq for Cell {}

impl PartialOrd for Cell {
    fn partial_cmp(&self, other: &Cell) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Cell {
    fn cmp(&self, other: &Cell) -> std::cmp::Ordering {
        self.max.total_cmp(&other.max)
    }
}

/// The distance from `p` to the nearest edge of `rings`: positive inside, negative outside.
fn signed_distance(p: Point, rings: &[Vec<Point>]) -> f64 {
    let mut inside = false;
    let mut nearest = f64::INFINITY;
    for ring in rings {
        let Some(&last) = ring.last() else { continue };
        let mut a = last;
        for &b in ring {
            if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
                inside = !inside;
            }
            nearest = nearest.min(segment_distance_squared(p, a, b));
            a = b;
        }
    }
    let distance = nearest.sqrt();
    if inside { distance } else { -distance }
}

fn segment_distance_squared(p: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length = dx * dx + dy * dy;
    let t = if length > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length).clamp(0.0, 1.0) } else { 0.0 };
    let (x, y) = (a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
    x * x + y * y
}

/// A ring's centroid, or its first point when it has no area.
fn centroid(ring: &[Point]) -> Point {
    let (mut area, mut x, mut y) = (0.0, 0.0, 0.0);
    let Some(&last) = ring.last() else { return [f64::NAN; 2] };
    let mut a = last;
    for &b in ring {
        let f = a[0] * b[1] - b[0] * a[1];
        x += (a[0] + b[0]) * f;
        y += (a[1] + b[1]) * f;
        area += f * 3.0;
        a = b;
    }
    if area == 0.0 { ring[0] } else { [x / area, y / area] }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, side: f64) -> Vec<Point> {
        vec![[x, y], [x + side, y], [x + side, y + side], [x, y + side], [x, y]]
    }

    /// Total area of a point list's triangles, after its label anchor.
    fn covered(points: &[Point]) -> f64 {
        points[1..]
            .chunks(3)
            .map(|t| {
                ((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1])).abs() / 2.0
            })
            .sum()
    }

    #[test]
    fn a_square_triangulates_with_its_label_in_the_middle() {
        let points = triangles(&[vec![square(0.0, 0.0, 10.0)]], false);
        assert_eq!(points.len(), 1 + 6);
        assert!((covered(&points) - 100.0).abs() < 1e-9);
        let [x, y] = points[0];
        assert!((x - 5.0).abs() < 0.3 && (y - 5.0).abs() < 0.3, "{:?}", points[0]);
    }

    #[test]
    fn a_half_world_tile_does_not_wrap_regardless_of_its_first_corner() {
        // A zoom-1 tile is half the world wide, so its edges span exactly 180 degrees.
        let corners = [[0.0, 0.0], [180.0, 0.0], [180.0, 80.0], [0.0, 80.0]];
        for start in 0..4 {
            let mut ring: Vec<Point> = (0..4).map(|k| corners[(start + k) % 4]).collect();
            ring.push(ring[0]);
            let points = triangles(&[vec![ring]], true);
            assert!((covered(&points) - 180.0 * 80.0).abs() < 1e-6, "from corner {start}");
            assert!(points[1..].iter().all(|p| (0.0..=180.0).contains(&p[0])), "from corner {start}");
        }
    }

    #[test]
    fn a_hole_moves_the_label_off_it() {
        let polygon = vec![square(0.0, 0.0, 10.0), square(3.0, 3.0, 4.0)];
        let points = triangles(&[polygon], false);
        assert!((covered(&points) - 84.0).abs() < 1e-9);
        let [x, y] = points[0];
        assert!(!(3.0..=7.0).contains(&x) || !(3.0..=7.0).contains(&y), "{:?}", points[0]);
    }

    #[test]
    fn earth_triangles_split_along_the_grid_without_losing_area() {
        let points = triangles(&[vec![square(0.5, 0.5, 9.0)]], true);
        assert!((covered(&points) - 81.0).abs() < 1e-6, "{}", covered(&points));
        for t in points[1..].chunks(3) {
            for k in 0..2 {
                let (lo, hi) = (
                    t.iter().map(|p| p[k]).fold(f64::INFINITY, f64::min),
                    t.iter().map(|p| p[k]).fold(f64::NEG_INFINITY, f64::max),
                );
                assert!(hi - lo <= EARTH_STEP + 1e-9, "a triangle spans at most one grid step: {lo}..{hi}");
            }
        }
    }

    #[test]
    fn rings_across_the_antimeridian_stay_whole() {
        let ring = vec![[179.0, 0.0], [-179.0, 0.0], [-179.0, 1.0], [179.0, 1.0], [179.0, 0.0]];
        let points = triangles(&[vec![ring]], true);
        assert!((covered(&points) - 2.0).abs() < 1e-9, "{}", covered(&points));
        assert!(points[1..].iter().all(|p| p[0] >= 179.0 && p[0] <= 181.0), "unwrapped east: {points:?}");
    }

    #[test]
    fn earth_parts_bend_and_unwrap() {
        assert!(earth_parts(&[vec![[0.0, 0.0], [1.0, 1.0]]]).is_none(), "short segments need no bending");
        let parts = earth_parts(&[vec![[170.0, 10.0], [-170.0, 10.0]]]).expect("a long segment bends");
        assert_eq!(parts[0].first(), Some(&[170.0, 10.0]));
        assert_eq!(parts[0].last(), Some(&[190.0, 10.0]));
        assert!(parts[0].windows(2).all(|w| (w[1][0] - w[0][0]).abs() <= EARTH_STEP + 1e-9));
    }
}
