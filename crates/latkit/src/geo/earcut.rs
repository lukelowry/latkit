//! Polygon triangulation by ear clipping, ported from Mapbox's earcut 3.2.
//!
//! Each hole is joined to the outer ring by a bridge. Ears are clipped from a doubly linked ring.
//! Large polygons use a z-order index to find points that block an ear. When no ear can be
//! clipped, the ring is filtered while that removes points, then cured of local self-intersections
//! once, then split in two.

/// The null node index.
const NIL: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct Node {
    /// Index into the input points.
    i: u32,
    x: f64,
    y: f64,
    prev: u32,
    next: u32,
    /// Z-order code of the vertex. `prev_z` and `next_z` link the ring sorted by it.
    z: u32,
    prev_z: u32,
    next_z: u32,
    /// Whether the vertex is a single-point hole (a Steiner point), which filtering never removes.
    steiner: bool,
}

struct Rings<'a> {
    nodes: Vec<Node>,
    points: &'a [[f64; 2]],
    triangles: Vec<[u32; 3]>,
    /// Whether the last filter removed a point.
    filtered: bool,
}

/// Triangulates a polygon. `points` holds the outer ring, then each hole. `holes` lists the index
/// where each hole starts. Returns triangles as index triples into `points`.
pub(crate) fn earcut(points: &[[f64; 2]], holes: &[usize]) -> Vec<[u32; 3]> {
    let nodes = Vec::with_capacity(points.len() * 3 / 2);
    let mut rings = Rings { nodes, points, triangles: Vec::new(), filtered: false };
    let outer_end = holes.first().copied().unwrap_or(points.len());
    let mut outer = rings.linked(0, outer_end, true);
    if outer == NIL || rings.n(outer).next == rings.n(outer).prev {
        return rings.triangles;
    }
    if !holes.is_empty() {
        outer = rings.eliminate_holes(holes, outer);
    }
    // Polygons over 80 points index their ring in z-order to speed up ear tests.
    let (mut min, mut size) = ([0.0; 2], 0.0);
    if points.len() > 80 {
        let mut max = [f64::NEG_INFINITY; 2];
        min = [f64::INFINITY; 2];
        for p in &points[..outer_end] {
            for k in 0..2 {
                min[k] = min[k].min(p[k]);
                max[k] = max[k].max(p[k]);
            }
        }
        let span = (max[0] - min[0]).max(max[1] - min[1]);
        size = if span > 0.0 { 32767.0 / span } else { 0.0 };
    }
    rings.clip(outer, min, size);
    rings.triangles
}

impl Rings<'_> {
    fn n(&self, i: u32) -> &Node {
        &self.nodes[i as usize]
    }

    fn m(&mut self, i: u32) -> &mut Node {
        &mut self.nodes[i as usize]
    }

    fn xy(&self, i: u32) -> (f64, f64) {
        let n = self.n(i);
        (n.x, n.y)
    }

    /// Links points `start..end` into a circular list, reversed if needed so its winding matches
    /// `clockwise`. Drops a closing point equal to the first. Returns the last node, or `NIL`.
    fn linked(&mut self, start: usize, end: usize, clockwise: bool) -> u32 {
        let mut last = NIL;
        if clockwise == (signed_area(&self.points[start..end]) > 0.0) {
            for i in start..end {
                last = self.insert(i as u32, last);
            }
        } else {
            for i in (start..end).rev() {
                last = self.insert(i as u32, last);
            }
        }
        if last != NIL && self.equals(last, self.n(last).next) {
            let next = self.n(last).next;
            self.remove(last);
            last = next;
        }
        last
    }

    fn insert(&mut self, i: u32, last: u32) -> u32 {
        let [x, y] = self.points[i as usize];
        let p = self.nodes.len() as u32;
        let mut node = Node { i, x, y, prev: p, next: p, z: 0, prev_z: NIL, next_z: NIL, steiner: false };
        if last == NIL {
            self.nodes.push(node);
        } else {
            let after = self.n(last).next;
            node.next = after;
            node.prev = last;
            self.nodes.push(node);
            self.m(after).prev = p;
            self.m(last).next = p;
        }
        p
    }

    fn remove(&mut self, p: u32) {
        let Node { prev, next, prev_z, next_z, .. } = *self.n(p);
        self.m(next).prev = prev;
        self.m(prev).next = next;
        if prev_z != NIL {
            self.m(prev_z).next_z = next_z;
        }
        if next_z != NIL {
            self.m(next_z).prev_z = prev_z;
        }
    }

    fn equals(&self, a: u32, b: u32) -> bool {
        self.xy(a) == self.xy(b)
    }

    /// Twice the signed area of triangle `p q r`. Negative where the ring turns convexly at `q`,
    /// positive at a reflex turn.
    fn area(&self, p: u32, q: u32, r: u32) -> f64 {
        let ((px, py), (qx, qy), (rx, ry)) = (self.xy(p), self.xy(q), self.xy(r));
        (qy - py) * (rx - qx) - (qx - px) * (ry - qy)
    }

    /// Removes repeated and collinear points, except Steiner points. When `end` is `NIL` or
    /// `start`, it circles the whole ring until a full pass removes nothing. Otherwise it checks
    /// only the nodes from `start` through `end`, as around a new diagonal. Returns a node still in
    /// the ring.
    fn filter(&mut self, start: u32, end: u32) -> u32 {
        if start == NIL {
            return start;
        }
        let whole = end == NIL || end == start;
        let mut end = if end == NIL { start } else { end };
        let mut p = start;
        loop {
            let mut again = false;
            let (prev, next) = (self.n(p).prev, self.n(p).next);
            if p != next && !self.n(p).steiner && (self.equals(p, next) || self.area(prev, p, next) == 0.0) {
                if whole || p == end {
                    end = prev;
                }
                self.filtered = true;
                self.remove(p);
                p = prev;
                again = true;
            } else if whole || p != end {
                p = next;
                again = !whole;
            }
            if !again && p == end {
                return end;
            }
        }
    }

    /// Clips ears from the ring starting at `ear`, adding their triangles. When a full pass finds
    /// no ear, it filters the ring and retries while that removes points, then cures local
    /// self-intersections once, then splits the ring in two.
    fn clip(&mut self, mut ear: u32, min: [f64; 2], size: f64) {
        if ear == NIL {
            return;
        }
        if size > 0.0 {
            self.index(ear, min, size);
        }
        let (mut stop, mut cured) = (ear, false);
        while self.n(ear).prev != self.n(ear).next {
            let (prev, next) = (self.n(ear).prev, self.n(ear).next);
            let is_ear = if size > 0.0 { self.is_ear_hashed(ear, min, size) } else { self.is_ear(ear) };
            if is_ear {
                self.triangles.push([self.n(prev).i, self.n(ear).i, self.n(next).i]);
                self.remove(ear);
                ear = next;
                stop = next;
                continue;
            }
            ear = next;
            if ear == stop {
                self.filtered = false;
                ear = self.filter(ear, NIL);
                if self.filtered {
                    stop = ear;
                    continue;
                }
                if !cured {
                    ear = self.cure(ear);
                    stop = ear;
                    cured = true;
                    continue;
                }
                self.split(ear, min, size);
                break;
            }
        }
    }

    fn is_ear(&self, ear: u32) -> bool {
        let (a, b, c) = (self.n(ear).prev, ear, self.n(ear).next);
        if self.area(a, b, c) >= 0.0 {
            return false;
        }
        let ((ax, ay), (bx, by), (cx, cy)) = (self.xy(a), self.xy(b), self.xy(c));
        let (x0, y0, x1, y1) = (ax.min(bx).min(cx), ay.min(by).min(cy), ax.max(bx).max(cx), ay.max(by).max(cy));
        let mut p = self.n(c).next;
        while p != a {
            let n = self.n(p);
            if n.x >= x0
                && n.x <= x1
                && n.y >= y0
                && n.y <= y1
                && inside_except_first([ax, ay], [bx, by], [cx, cy], [n.x, n.y])
                && self.area(n.prev, p, n.next) >= 0.0
            {
                return false;
            }
            p = n.next;
        }
        true
    }

    fn is_ear_hashed(&self, ear: u32, min: [f64; 2], size: f64) -> bool {
        let (a, b, c) = (self.n(ear).prev, ear, self.n(ear).next);
        if self.area(a, b, c) >= 0.0 {
            return false;
        }
        let ((ax, ay), (bx, by), (cx, cy)) = (self.xy(a), self.xy(b), self.xy(c));
        let (x0, y0, x1, y1) = (ax.min(bx).min(cx), ay.min(by).min(cy), ax.max(bx).max(cx), ay.max(by).max(cy));
        let (low, high) = (z_order(x0, y0, min, size), z_order(x1, y1, min, size));
        let blocks = |p: u32| {
            let n = self.n(p);
            n.x >= x0
                && n.x <= x1
                && n.y >= y0
                && n.y <= y1
                && p != a
                && p != c
                && inside_except_first([ax, ay], [bx, by], [cx, cy], [n.x, n.y])
                && self.area(n.prev, p, n.next) >= 0.0
        };
        let (mut p, mut n) = (self.n(ear).prev_z, self.n(ear).next_z);
        while p != NIL && self.n(p).z >= low && n != NIL && self.n(n).z <= high {
            if blocks(p) {
                return false;
            }
            p = self.n(p).prev_z;
            if blocks(n) {
                return false;
            }
            n = self.n(n).next_z;
        }
        while p != NIL && self.n(p).z >= low {
            if blocks(p) {
                return false;
            }
            p = self.n(p).prev_z;
        }
        while n != NIL && self.n(n).z <= high {
            if blocks(n) {
                return false;
            }
            n = self.n(n).next_z;
        }
        true
    }

    /// Clips a triangle at each local self-intersection and returns a node of the remaining ring.
    fn cure(&mut self, start: u32) -> u32 {
        let (mut p, mut start, mut cured) = (start, start, false);
        loop {
            let a = self.n(p).prev;
            let next = self.n(p).next;
            let b = self.n(next).next;
            if self.crosses(a, p, next, b) && self.locally_inside(a, b) && self.locally_inside(b, a) {
                self.triangles.push([self.n(a).i, self.n(p).i, self.n(b).i]);
                self.remove(p);
                self.remove(next);
                p = b;
                start = b;
                cured = true;
            }
            p = self.n(p).next;
            if p == start {
                break;
            }
        }
        if cured { self.filter(p, NIL) } else { p }
    }

    /// Splits the ring in two along a valid diagonal, and clips each.
    fn split(&mut self, start: u32, min: [f64; 2], size: f64) {
        let mut a = start;
        loop {
            let mut b = self.n(self.n(a).next).next;
            while b != self.n(a).prev {
                if self.n(a).i != self.n(b).i && self.valid_diagonal(a, b) {
                    let c = self.split_polygon(a, b);
                    let a = self.filter(a, self.n(a).next);
                    let c = self.filter(c, self.n(c).next);
                    self.clip(a, min, size);
                    self.clip(c, min, size);
                    return;
                }
                b = self.n(b).next;
            }
            a = self.n(a).next;
            if a == start {
                break;
            }
        }
    }

    /// Joins every hole to the outer ring, leftmost first.
    fn eliminate_holes(&mut self, holes: &[usize], mut outer: u32) -> u32 {
        let mut queue = Vec::with_capacity(holes.len());
        for (k, &start) in holes.iter().enumerate() {
            let end = holes.get(k + 1).copied().unwrap_or(self.points.len());
            if end <= start {
                continue;
            }
            let list = self.linked(start, end, false);
            if list == NIL {
                continue;
            }
            if list == self.n(list).next {
                self.m(list).steiner = true;
            }
            queue.push(self.leftmost(list));
        }
        // Holes whose leftmost points coincide are ordered by the slope of their first edge, so
        // each one bridges to the shared point.
        let slope = |p: u32| {
            let (n, next) = (self.n(p), self.n(self.n(p).next));
            (next.y - n.y) / (next.x - n.x)
        };
        // Order by x, then y, then slope. The sorts are stable, so the last key sorts first.
        crate::order::by_key(&mut queue, |&p| crate::order::number(slope(p)));
        crate::order::by_wide_key(&mut queue, |&p| {
            let n = self.n(p);
            crate::order::wide(crate::order::number(n.x), crate::order::number(n.y))
        });
        for hole in queue {
            outer = self.eliminate_hole(hole, outer);
        }
        // Remove points the bridges made repeated or collinear before clipping.
        self.filter(outer, NIL)
    }

    fn eliminate_hole(&mut self, hole: u32, outer: u32) -> u32 {
        let Some(bridge) = self.hole_bridge(hole, outer) else { return outer };
        let reverse = self.split_polygon(bridge, hole);
        self.filter(reverse, self.n(reverse).next);
        self.filter(bridge, self.n(bridge).next)
    }

    /// Finds the outer ring node to bridge a hole to: one visible from `hole`, the hole's leftmost
    /// point. `None` if no ring edge lies to its left.
    fn hole_bridge(&self, hole: u32, outer: u32) -> Option<u32> {
        let (hx, hy) = self.xy(hole);
        let mut qx = f64::NEG_INFINITY;
        let mut m = NIL;
        let mut p = outer;
        // A hole that touches the outer ring at a point bridges there.
        if self.equals(hole, p) {
            return Some(p);
        }
        loop {
            let (px, py) = self.xy(p);
            let next = self.n(p).next;
            let (nx, ny) = self.xy(next);
            if self.equals(hole, next) {
                return Some(next);
            }
            if hy <= py && hy >= ny && ny != py {
                let x = px + (hy - py) * (nx - px) / (ny - py);
                if x <= hx && x > qx {
                    qx = x;
                    m = if px < nx { p } else { next };
                    if x == hx {
                        return Some(m);
                    }
                }
            }
            p = next;
            if p == outer {
                break;
            }
        }
        if m == NIL {
            return None;
        }
        let stop = m;
        let (mx, my) = self.xy(m);
        let mut tan_min = f64::INFINITY;
        p = m;
        loop {
            let (px, py) = self.xy(p);
            let (ax, cx) = if hy < my { (hx, qx) } else { (qx, hx) };
            if hx >= px && px >= mx && hx != px && inside_triangle([ax, hy], [mx, my], [cx, hy], [px, py]) {
                let tan = (hy - py).abs() / (hx - px);
                let (bx, _) = self.xy(m);
                // When the hole point lies on `p`'s horizontal edge (a T junction), a bridge along
                // that edge is valid although `locally_inside` rejects it.
                let (nx, ny) = self.xy(self.n(p).next);
                let along = py == hy && ny == hy && nx > hx;
                if (self.locally_inside(p, hole) || along)
                    && (tan < tan_min || (tan == tan_min && (px > bx || (px == bx && self.sector_contains(m, p)))))
                {
                    m = p;
                    tan_min = tan;
                }
            }
            p = self.n(p).next;
            if p == stop {
                break;
            }
        }
        Some(m)
    }

    fn sector_contains(&self, m: u32, p: u32) -> bool {
        self.area(self.n(m).prev, m, self.n(p).prev) < 0.0 && self.area(self.n(p).next, m, self.n(m).next) < 0.0
    }

    fn leftmost(&self, start: u32) -> u32 {
        let (mut p, mut left) = (start, start);
        loop {
            let (n, l) = (self.n(p), self.n(left));
            if n.x < l.x || (n.x == l.x && n.y < l.y) {
                left = p;
            }
            p = n.next;
            if p == start {
                break;
            }
        }
        left
    }

    /// Computes each node's z-order code and links the ring in z-order.
    fn index(&mut self, start: u32, min: [f64; 2], size: f64) {
        let mut p = start;
        loop {
            let n = *self.n(p);
            self.m(p).z = z_order(n.x, n.y, min, size);
            self.m(p).prev_z = n.prev;
            self.m(p).next_z = n.next;
            p = n.next;
            if p == start {
                break;
            }
        }
        let last = self.n(p).prev_z;
        self.m(last).next_z = NIL;
        self.m(p).prev_z = NIL;
        self.sort(p);
    }

    /// Merge-sorts the z-order list starting at `list`.
    fn sort(&mut self, mut list: u32) {
        let mut in_size = 1;
        loop {
            let mut p = list;
            list = NIL;
            let mut tail = NIL;
            let mut merges = 0;
            while p != NIL {
                merges += 1;
                let mut q = p;
                let mut p_size = 0;
                for _ in 0..in_size {
                    p_size += 1;
                    q = self.n(q).next_z;
                    if q == NIL {
                        break;
                    }
                }
                let mut q_size = in_size;
                while p_size > 0 || (q_size > 0 && q != NIL) {
                    let e;
                    if p_size != 0 && (q_size == 0 || q == NIL || self.n(p).z <= self.n(q).z) {
                        e = p;
                        p = self.n(p).next_z;
                        p_size -= 1;
                    } else {
                        e = q;
                        q = self.n(q).next_z;
                        q_size -= 1;
                    }
                    if tail == NIL {
                        list = e;
                    } else {
                        self.m(tail).next_z = e;
                    }
                    self.m(e).prev_z = tail;
                    tail = e;
                }
                p = q;
            }
            if tail != NIL {
                self.m(tail).next_z = NIL;
            }
            in_size *= 2;
            if merges <= 1 {
                break;
            }
        }
    }

    /// Whether diagonal `a b` lies inside the polygon. `b` must not be the node after `a`, and the
    /// diagonal must be locally inside at both ends, cross no edge, have its midpoint inside, and
    /// create no opposite-facing sectors. A zero-length diagonal between two reflex corners is also
    /// valid.
    fn valid_diagonal(&self, a: u32, b: u32) -> bool {
        let (na, nb) = (self.n(a), self.n(b));
        let zero_length =
            self.equals(a, b) && self.area(na.prev, a, na.next) > 0.0 && self.area(nb.prev, b, nb.next) > 0.0;
        self.n(na.next).i != nb.i
            && (zero_length
                || (self.locally_inside(a, b)
                    && self.locally_inside(b, a)
                    && (self.area(na.prev, a, nb.prev) != 0.0 || self.area(a, nb.prev, b) != 0.0)))
            && !self.intersects_polygon(a, b)
            && (zero_length || self.middle_inside(a, b))
    }

    /// Whether segments `p1 q1` and `p2 q2` cross. Touching does not count.
    fn crosses(&self, p1: u32, q1: u32, p2: u32, q2: u32) -> bool {
        let (o1, o2) = (sign(self.area(p1, q1, p2)), sign(self.area(p1, q1, q2)));
        let (o3, o4) = (sign(self.area(p2, q2, p1)), sign(self.area(p2, q2, q1)));
        o1 * o2 < 0 && o3 * o4 < 0
    }

    /// Whether segments `p1 q1` and `p2 q2` intersect, including touching.
    fn intersects(&self, p1: u32, q1: u32, p2: u32, q2: u32) -> bool {
        let o1 = sign(self.area(p1, q1, p2));
        let o2 = sign(self.area(p1, q1, q2));
        let o3 = sign(self.area(p2, q2, p1));
        let o4 = sign(self.area(p2, q2, q1));
        self.crosses(p1, q1, p2, q2)
            || (o1 == 0 && self.on_segment(p1, p2, q1))
            || (o2 == 0 && self.on_segment(p1, q2, q1))
            || (o3 == 0 && self.on_segment(p2, p1, q2))
            || (o4 == 0 && self.on_segment(p2, q1, q2))
    }

    /// For `q` collinear with segment `p r`, whether it lies on the segment, within its box.
    fn on_segment(&self, p: u32, q: u32, r: u32) -> bool {
        let ((px, py), (qx, qy), (rx, ry)) = (self.xy(p), self.xy(q), self.xy(r));
        qx <= px.max(rx) && qx >= px.min(rx) && qy <= py.max(ry) && qy >= py.min(ry)
    }

    /// Whether diagonal `a b` intersects a ring edge not incident to `a` or `b`.
    fn intersects_polygon(&self, a: u32, b: u32) -> bool {
        let (ia, ib) = (self.n(a).i, self.n(b).i);
        let ((ax, ay), (bx, by)) = (self.xy(a), self.xy(b));
        let (x0, x1, y0, y1) = (ax.min(bx), ax.max(bx), ay.min(by), ay.max(by));
        let mut p = a;
        loop {
            let next = self.n(p).next;
            let ((px, py), (nx, ny)) = (self.xy(p), self.xy(next));
            // Skip edges entirely outside the diagonal's bounding box.
            let apart = (px > x1 && nx > x1) || (px < x0 && nx < x0) || (py > y1 && ny > y1) || (py < y0 && ny < y0);
            let (ip, inext) = (self.n(p).i, self.n(next).i);
            if !apart && ip != ia && inext != ia && ip != ib && inext != ib && self.intersects(p, next, a, b) {
                return true;
            }
            p = next;
            if p == a {
                return false;
            }
        }
    }

    fn locally_inside(&self, a: u32, b: u32) -> bool {
        let n = self.n(a);
        if self.area(n.prev, a, n.next) < 0.0 {
            self.area(a, b, n.next) >= 0.0 && self.area(a, n.prev, b) >= 0.0
        } else {
            self.area(a, b, n.prev) < 0.0 || self.area(a, n.next, b) < 0.0
        }
    }

    fn middle_inside(&self, a: u32, b: u32) -> bool {
        let ((ax, ay), (bx, by)) = (self.xy(a), self.xy(b));
        let (px, py) = (f64::midpoint(ax, bx), f64::midpoint(ay, by));
        let mut inside = false;
        let mut p = a;
        loop {
            let (x, y) = self.xy(p);
            let next = self.n(p).next;
            let (nx, ny) = self.xy(next);
            if ((y > py) != (ny > py)) && ny != y && px < (nx - x) * (py - y) / (ny - y) + x {
                inside = !inside;
            }
            p = next;
            if p == a {
                return inside;
            }
        }
    }

    /// Splits the ring in two along diagonal `a b` by duplicating both nodes. Returns the copy of
    /// `b`, which lies in the second ring.
    fn split_polygon(&mut self, a: u32, b: u32) -> u32 {
        let (na, nb) = (*self.n(a), *self.n(b));
        let a2 = self.nodes.len() as u32;
        let b2 = a2 + 1;
        let fresh = |n: Node| Node { prev: NIL, next: NIL, z: 0, prev_z: NIL, next_z: NIL, steiner: false, ..n };
        self.nodes.push(fresh(na));
        self.nodes.push(fresh(nb));
        let (an, bp) = (na.next, nb.prev);
        self.m(a).next = b;
        self.m(b).prev = a;
        self.m(a2).next = an;
        self.m(an).prev = a2;
        self.m(b2).next = a2;
        self.m(a2).prev = b2;
        self.m(bp).next = b2;
        self.m(b2).prev = bp;
        b2
    }
}

/// Twice the signed area of a ring by the shoelace formula, with earcut's sign convention.
fn signed_area(points: &[[f64; 2]]) -> f64 {
    let Some(&last) = points.last() else { return 0.0 };
    let mut sum = 0.0;
    let mut j = last;
    for &p in points {
        sum += (j[0] - p[0]) * (p[1] + j[1]);
        j = p;
    }
    sum
}

/// The z-order (Morton) code of `(x, y)`, offset by `min` and scaled by `size` to 15 bits per axis.
fn z_order(x: f64, y: f64, min: [f64; 2], size: f64) -> u32 {
    let spread = |v: f64| {
        let mut v = (v * size) as u32 & 0x7fff;
        v = (v | (v << 8)) & 0x00ff_00ff;
        v = (v | (v << 4)) & 0x0f0f_0f0f;
        v = (v | (v << 2)) & 0x3333_3333;
        (v | (v << 1)) & 0x5555_5555
    };
    spread(x - min[0]) | (spread(y - min[1]) << 1)
}

fn inside_triangle(a: [f64; 2], b: [f64; 2], c: [f64; 2], p: [f64; 2]) -> bool {
    (c[0] - p[0]) * (a[1] - p[1]) >= (a[0] - p[0]) * (c[1] - p[1])
        && (a[0] - p[0]) * (b[1] - p[1]) >= (b[0] - p[0]) * (a[1] - p[1])
        && (b[0] - p[0]) * (c[1] - p[1]) >= (c[0] - p[0]) * (b[1] - p[1])
}

/// Whether `p` lies in triangle `a b c` and is not at `a`. Bridges duplicate points, and a copy of
/// `a` must not block the ear.
fn inside_except_first(a: [f64; 2], b: [f64; 2], c: [f64; 2], p: [f64; 2]) -> bool {
    a != p && inside_triangle(a, b, c, p)
}

fn sign(v: f64) -> i8 {
    if v > 0.0 {
        1
    } else if v < 0.0 {
        -1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Twice the total area of `triangles`.
    fn covered(points: &[[f64; 2]], triangles: &[[u32; 3]]) -> f64 {
        triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| points[i as usize]);
                ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs()
            })
            .sum()
    }

    #[test]
    fn a_square_is_two_triangles() {
        let square = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let triangles = earcut(&square, &[]);
        assert_eq!(triangles.len(), 2);
        assert!((covered(&square, &triangles) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn holes_are_left_out() {
        let mut points = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        points.extend([[2.0, 2.0], [2.0, 4.0], [4.0, 4.0], [4.0, 2.0]]);
        points.extend([[6.0, 6.0], [6.0, 8.0], [8.0, 8.0], [8.0, 6.0]]);
        let triangles = earcut(&points, &[4, 8]);
        assert!((covered(&points, &triangles) - 2.0 * (100.0 - 8.0)).abs() < 1e-9, "{triangles:?}");
    }

    #[test]
    fn holes_touching_the_ring_or_each_other_are_left_out() {
        /// Hole points, the index where each hole starts, and the expected area.
        type Case<'a> = (&'a [[f64; 2]], &'a [usize], f64);
        let outer = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let cases: [Case<'_>; 3] = [
            // A hole touching the outer ring at its corner.
            (&[[0.0, 0.0], [3.0, 1.0], [1.0, 3.0]], &[4], 96.0),
            // A hole touching the outer ring's edge.
            (&[[0.0, 5.0], [3.0, 4.0], [3.0, 6.0]], &[4], 97.0),
            // Two holes sharing their leftmost point.
            (&[[5.0, 5.0], [7.0, 4.0], [7.0, 6.0], [5.0, 5.0], [7.0, 7.0], [6.0, 9.0]], &[4, 7], 95.0),
        ];
        for (holes, starts, area) in cases {
            let points = [&outer[..], holes].concat();
            let triangles = earcut(&points, starts);
            assert!((covered(&points, &triangles) - 2.0 * area).abs() < 1e-9, "{holes:?}: {triangles:?}");
        }
    }

    #[test]
    fn large_rings_hash_their_ears() {
        // A 200-point star: every other corner is reflex, which exercises the hashed ear test.
        let points: Vec<[f64; 2]> = (0..200)
            .map(|k| {
                let a = f64::from(k) / 200.0 * std::f64::consts::TAU;
                let r = if k % 2 == 0 { 10.0 } else { 4.0 };
                [r * a.cos(), r * a.sin()]
            })
            .collect();
        let triangles = earcut(&points, &[]);
        assert_eq!(triangles.len(), 198);
        let area = signed_area(&points).abs();
        assert!((covered(&points, &triangles) - area).abs() < 1e-6 * area);
    }

    #[test]
    fn degenerate_rings_give_no_triangles() {
        let none: Vec<[u32; 3]> = Vec::new();
        assert_eq!(earcut(&[[0.0, 0.0], [1.0, 1.0]], &[]), none);
        assert_eq!(earcut(&[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0]], &[]), none, "collinear");
    }
}
