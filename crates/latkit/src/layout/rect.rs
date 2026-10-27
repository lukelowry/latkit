//! Axis-aligned boxes on the plane, as least x and y then greatest x and y, and points.

/// A point on the plane.
pub(crate) type Point = [f64; 2];

/// A box: least x, least y, greatest x, greatest y.
pub(crate) type Rect = [f64; 4];

/// The empty box. It is inverted, so a union with it yields the other box.
pub(crate) const EMPTY: Rect = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];

/// The smallest box containing `a` and `b`.
pub(crate) fn union(a: Rect, b: Rect) -> Rect {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

/// The zero-size box at `p`.
pub(crate) fn dot(p: Point) -> Rect {
    [p[0], p[1], p[0], p[1]]
}

/// The box centered on `center` that reaches `half` (half width, half height) each way.
pub(crate) fn around(center: Point, half: Point) -> Rect {
    [center[0] - half[0], center[1] - half[1], center[0] + half[0], center[1] + half[1]]
}

/// `r` grown by `by` on every side.
pub(crate) fn grow(r: Rect, by: f64) -> Rect {
    [r[0] - by, r[1] - by, r[2] + by, r[3] + by]
}

/// Whether two boxes overlap or touch.
pub(crate) fn meets(a: &Rect, b: &Rect) -> bool {
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

/// Whether a box is finite and not inverted.
pub(crate) fn valid(r: &Rect) -> bool {
    r.iter().all(|v| v.is_finite()) && r[0] <= r[2] && r[1] <= r[3]
}
