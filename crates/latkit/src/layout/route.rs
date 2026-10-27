//! Orthogonal routes: wires of horizontal and vertical runs around obstacles.
//!
//! Each net grows as a tree from its first terminal. Every terminal leaves its vertex by a short
//! stub along its side. Each further terminal, nearest first, branches off the tree by the
//! cheapest clear elbow, or else by an A* search over a sparse visibility graph: the free
//! stretches of the lines through nearby obstacles' corners, joined where they cross. Finally,
//! runs of different nets that share a line are spread onto separate tracks.
//!
//! Coordinates are plane units with y up: a top side faces +y.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use super::boxes::Boxes;
use super::rect::{Point, Rect, dot, grow, meets, union, valid};
use crate::scene::Side;

/// Where a wire meets a vertex: the point on its boundary, the side it leaves by (`None`: any), and
/// the obstacle it belongs to (an index into `obstacles`), which its own wire may touch.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Terminal {
    /// The point on the vertex's boundary.
    pub(crate) at: [f64; 2],
    /// The side the wire leaves by. With none, the wire leaves by the owner's side nearest `at`, or
    /// without an owner, along the axis toward the rest of the net.
    pub(crate) side: Option<Side>,
    /// The obstacle the terminal belongs to.
    pub(crate) owner: Option<u32>,
}

/// A net: every terminal it joins. Two terminals make a plain edge.
#[derive(Clone, PartialEq, Debug, Default)]
pub(crate) struct Net {
    /// The terminals. The route grows from the first.
    pub(crate) terminals: Vec<Terminal>,
}

/// Each net's route as polylines: a tree for nets of more than two terminals, sharing junction
/// points. Routes run in horizontal and vertical segments around `obstacles` (each
/// `[min x, min y, max x, max y]`), leave each terminal along its side, and keep parallel runs of
/// different nets `spacing` apart. Runs of `fixed` polylines (wires already routed) keep their
/// tracks, and new runs take tracks beside them. A net whose route cannot avoid the obstacles
/// still gets an orthogonal route through them.
///
/// Wires keep twice `spacing` from obstacles where they can. `groups` are soft obstacles: crossing
/// a border costs extra, so wires enter and leave a group once and keep off its borders. A net
/// with fewer than two terminals at finite points gets no polylines. Obstacles with a non-finite
/// or inverted box are ignored.
pub(crate) fn route(
    obstacles: &Boxes,
    groups: &[[f64; 4]],
    nets: &[Net],
    fixed: &[Vec<[f64; 2]>],
    spacing: f64,
) -> Vec<Vec<Vec<[f64; 2]>>> {
    let mut router = Router::new(obstacles, groups, spacing);
    let mut trees: Vec<Option<Tree>> = nets.iter().map(|net| router.net(net)).collect();
    let routed = trees.len();
    trees.extend(fixed.iter().filter(|line| line.len() > 1).map(|line| Some(Tree::fixed(line))));
    router.separate(&mut trees);
    trees.truncate(routed);
    trees.iter().map(|tree| tree.as_ref().map_or_else(Vec::new, Tree::polylines)).collect()
}

/// Points a rounded bend's arc has between its ends.
const ARC: usize = 3;

/// A net's polylines as drawn. Each bend between perpendicular runs is rounded with a radius of up
/// to `radius`. A part ending where another starts repeats its last point, so that point draws as
/// a junction without an arrowhead. No point repeats anywhere else (for example where two arcs
/// meet on a short run), since a repeat would draw as a junction too.
pub(crate) fn finish(lines: &[Vec<Point>], radius: f64) -> Vec<Vec<Point>> {
    lines
        .iter()
        .map(|line| {
            let mut out: Vec<Point> = Vec::with_capacity(line.len() + ARC * line.len().saturating_sub(2));
            out.extend(line.first());
            for k in 1..line.len().saturating_sub(1) {
                let (a, p, b) = (line[k - 1], line[k], line[k + 1]);
                let (u, v) = (direction(a, p), direction(p, b));
                let r = radius.min(manhattan(a, p) / 2.0).min(manhattan(p, b) / 2.0);
                if u[0] * v[0] + u[1] * v[1] != 0.0 || r <= SAME || (u == [0.0; 2]) || (v == [0.0; 2]) {
                    push_new(&mut out, p);
                    continue;
                }
                // A quarter circle from `p - u r` to `p + v r` about `p - u r + v r`.
                let center = [p[0] - u[0] * r + v[0] * r, p[1] - u[1] * r + v[1] * r];
                for i in 0..=ARC + 1 {
                    let t = i as f64 / (ARC + 1) as f64 * std::f64::consts::FRAC_PI_2;
                    let (cos, sin) = (t.cos(), t.sin());
                    let at = [center[0] - v[0] * r * cos + u[0] * r * sin, center[1] - v[1] * r * cos + u[1] * r * sin];
                    push_new(&mut out, at);
                }
            }
            if let Some(&last) = line.last().filter(|_| line.len() > 1) {
                push_new(&mut out, last);
            }
            let end = *out.last().expect("a polyline has points");
            if lines.iter().any(|other| other.first() == Some(&end)) {
                out.push(end);
            }
            out
        })
        .collect()
}

/// Pushes `p` onto `out` unless it repeats the last point (within `EPSILON`).
fn push_new(out: &mut Vec<Point>, p: Point) {
    if out.last().is_none_or(|&q| manhattan(q, p) > EPSILON) {
        out.push(p);
    }
}

/// How far wires keep from obstacles, in spacings.
const CLEARANCE: f64 = 2.0;

/// Offsets below this are rounding error: a point this near a box's side is on it.
const EPSILON: f64 = 1e-6;

/// Points closer than this are the same point.
const SAME: f64 = 1e-9;

/// How many attach points a branch tries, nearest first.
const ATTACHES: usize = 8;

/// How many attach points a search starts from when no elbow is clear.
const SEARCHED: usize = 3;

/// The number of visibility-graph crossings beyond which a search gives up.
const MAX_CROSSINGS: usize = 1 << 20;

/// The number of states a search expands before it gives up.
const MAX_VISITS: usize = 1 << 17;

/// How many crossings a flood from the goal must reach before the goal counts as open.
const POCKET: usize = 256;

/// How many times a search widens its window to cover the obstacles walling it in.
const WIDENINGS: usize = 1;

/// The cost of crossing a group's border, in clearances of length.
const CROSSING: f64 = 4.0;

/// No joint: the root's parent, or the end of a child list.
const NONE: usize = usize::MAX;

/// No state: marks a search's starting states.
const NOWHERE: u32 = u32::MAX;

impl Side {
    /// The unit normal out of this side.
    fn normal(self) -> Point {
        match self {
            Side::Left => [-1.0, 0.0],
            Side::Right => [1.0, 0.0],
            Side::Top => [0.0, 1.0],
            Side::Bottom => [0.0, -1.0],
        }
    }
}

/// A terminal resolved for routing: where its wire meets the vertex, its outward direction, and
/// its owner's box.
struct End {
    at: Point,
    normal: Point,
    owner: Option<Rect>,
}

/// Routes nets among the obstacles, then spreads their shared runs onto tracks.
struct Router<'a> {
    obstacles: Obstacles<'a>,
    groups: Groups,
    /// How far apart tracks run.
    spacing: f64,
    /// How far wires keep from obstacles where they can.
    clearance: f64,
    search: Search,
}

impl<'a> Router<'a> {
    /// A router among `boxes` and `groups`, with tracks `spacing` apart. A negative or non-finite
    /// spacing counts as zero.
    fn new(boxes: &'a Boxes, groups: &[Rect], spacing: f64) -> Router<'a> {
        let spacing = if spacing.is_finite() { spacing.max(0.0) } else { 0.0 };
        let clearance = spacing * CLEARANCE;
        let groups = Groups { boxes: groups.iter().copied().filter(valid).collect(), clearance };
        Router { obstacles: Obstacles { boxes }, groups, spacing, clearance, search: Search::new(2.0 * clearance) }
    }

    /// The shortest stub, and the least distance a track keeps a stub's end from its terminal.
    fn least(&self) -> f64 {
        self.spacing / 8.0
    }

    /// A net's tree: the first terminal's stub, then each further terminal's branch, nearest
    /// first. `None` for a net with fewer than two terminals at finite points.
    fn net(&mut self, net: &Net) -> Option<Tree> {
        let terminals: Vec<Terminal> =
            net.terminals.iter().filter(|terminal| terminal.at.iter().all(|v| v.is_finite())).copied().collect();
        let (first, rest) = terminals.split_first()?;
        let root = self.end(*first, rest.first()?.at);
        let mut readers: Vec<End> = rest.iter().map(|terminal| self.end(*terminal, root.at)).collect();
        crate::order::by_key(&mut readers, |a| crate::order::number(manhattan(a.at, root.at)));
        let mut tree = Tree::default();
        let origin = tree.add(root.at, NONE, Joint::Terminal);
        tree.add(self.stub(&root), origin, Joint::Stub(origin));
        for reader in &readers {
            let end = self.stub(reader);
            let branch = self.branch(&tree, end, reader, &root);
            let Attach { child, interior, .. } = branch.attach;
            let mut parent = if interior {
                tree.split(child, branch.points[0])
            } else if manhattan(branch.points[0], tree.points[child]) < SAME {
                child
            } else {
                tree.parent[child]
            };
            for &bend in branch.points.iter().take(branch.points.len() - 1).skip(1) {
                parent = tree.add(bend, parent, Joint::Bend);
            }
            let stub = tree.add(end, parent, Joint::Bend);
            let terminal = tree.add(reader.at, stub, Joint::Terminal);
            tree.joints[stub] = Joint::Stub(terminal);
        }
        Some(tree)
    }

    /// Resolves a terminal for routing. Its outward direction is its side's normal, else the normal
    /// of its owner's side nearest it, else the axis toward `toward`.
    fn end(&self, terminal: Terminal, toward: Point) -> End {
        let owner = self.obstacles.owned(terminal.owner);
        let at = terminal.at;
        let normal = match (terminal.side, owner) {
            (Some(side), _) => side.normal(),
            (None, Some(own)) => {
                let offset = [at[0] - own[0].midpoint(own[2]), at[1] - own[1].midpoint(own[3])];
                outward(offset, [own[2] - own[0], own[3] - own[1]])
            }
            (None, None) => outward([toward[0] - at[0], toward[1] - at[1]], [1.0, 1.0]),
        };
        End { at, normal, owner }
    }

    /// Where a terminal's stub ends: past its owner by the clearance, or halfway to an obstacle in
    /// the way, but at least `least` past the owner.
    fn stub(&self, end: &End) -> Point {
        let axis = usize::from(end.normal[0] == 0.0);
        let sign = end.normal[axis];
        let from = end.at[axis];
        let exit = end
            .owner
            .map_or(0.0, |own| (((if sign > 0.0 { own[axis + 2] } else { own[axis] }) - from) * sign).max(0.0));
        let length = exit + self.clearance;
        let far = from + sign * length;
        let across = end.at[1 - axis];
        let (lo, hi) = (from.min(far), from.max(far));
        let region = if axis == 0 { [lo, across, hi, across] } else { [across, lo, across, hi] };
        let mut nearest = length;
        self.obstacles.some(region, 0.0, |obstacle| {
            let near = ((if sign > 0.0 { obstacle[axis] } else { obstacle[axis + 2] }) - from) * sign;
            if near > exit + EPSILON && near < nearest {
                nearest = near;
            }
            false
        });
        let length = if nearest < length { (exit + self.least()).max(exit.midpoint(nearest)) } else { length };
        let mut point = end.at;
        point[axis] = from + sign * length;
        point
    }

    /// The cheapest clear path from the tree to a reader's stub end `end`. It is an elbow from one
    /// of the nearest attach points, else a search around the obstacles at decreasing clearance,
    /// else a plain elbow through them.
    fn branch(&mut self, tree: &Tree, end: Point, reader: &End, root: &End) -> Branch {
        let mut attaches = tree.attaches(end);
        attaches.truncate(ATTACHES);
        let into = [-reader.normal[0], -reader.normal[1]];
        let mut best =
            Best { tree, into, bend: self.search.bend, groups: &self.groups, cost: f64::INFINITY, branch: None };
        let clear = Some((&self.obstacles, self.clearance - EPSILON));
        for &attach in &attaches {
            let from = attach.point;
            let middle = [from[0].midpoint(end[0]), from[1].midpoint(end[1])];
            best.consider(&[from, [end[0], from[1]], end], attach, clear);
            best.consider(&[from, [from[0], end[1]], end], attach, clear);
            best.consider(&[from, [middle[0], from[1]], [middle[0], end[1]], end], attach, clear);
            best.consider(&[from, [from[0], middle[1]], [end[0], middle[1]], end], attach, clear);
        }
        // An elbow with no group cost is as good as anything a search would find.
        match best.branch.take() {
            Some(branch) if branch.points.windows(2).all(|w| self.groups.cost(w[0], w[1]) == 0.0) => return branch,
            elbow => best.branch = elbow,
        }
        // The search window frames the boxes a branch may have to go around: its terminal's owner,
        // and the root's owner when the branch may leave from the root's stub.
        let searched = &attaches[..attaches.len().min(SEARCHED)];
        let from_root = searched.iter().any(|attach| attach.point == tree.points[1]);
        let owners: Vec<Rect> = [reader.owner, root.owner.filter(|_| from_root)].into_iter().flatten().collect();
        let from: Vec<(Point, Option<Point>)> =
            searched.iter().map(|&attach| (attach.point, tree.stub_way(attach))).collect();
        let leg = Leg { from: &from, to: end, arrive: Some(reader.normal) };
        for by in [self.clearance, self.clearance / 2.0, 0.0] {
            if let Some((source, path)) = self.search.path(&self.obstacles, &self.groups, &leg, &owners, by) {
                best.consider(&path, attaches[source], None);
            }
            if let Some(branch) = best.branch.take() {
                return branch;
            }
        }
        let attach = attaches.first().copied().unwrap_or(Attach { point: tree.points[0], child: 1, interior: false });
        Branch { points: simplify(&[attach.point, [end[0], attach.point[1]], end]), attach }
    }

    /// Spreads runs of different nets that share a line onto separate tracks, `spacing` apart where
    /// the corridor between obstacles has room. Tracks are ordered by where the runs' ends turn, so
    /// runs nest rather than cross. A run moves its joints, so branches stay connected. Terminals
    /// never move, and stubs only grow.
    fn separate(&self, trees: &mut [Option<Tree>]) {
        let tolerance = self.spacing / 16.0;
        for axis in 0..2 {
            let mut runs = runs(trees, axis, self.least());
            crate::order::by_wide_key(&mut runs, |a| {
                crate::order::wide(crate::order::number(a.line), crate::order::number(a.along[0]))
            });
            let mut first = 0;
            while first < runs.len() {
                let mut end = first + 1;
                let mut reach = runs[first].along[1];
                while end < runs.len() && runs[end].line - runs[first].line < tolerance && runs[end].along[0] < reach {
                    reach = reach.max(runs[end].along[1]);
                    end += 1;
                }
                let cluster = &runs[first..end];
                first = end;
                if cluster.iter().any(|run| run.net != cluster[0].net) {
                    self.tracks(cluster, axis, trees);
                }
            }
        }
    }

    /// Spreads a cluster of runs on one line across tracks between the nearest obstacles' sides.
    fn tracks(&self, cluster: &[Run], axis: usize, trees: &mut [Option<Tree>]) {
        let gap = self.spacing;
        let line = cluster[0].line;
        let lo = cluster.iter().map(|run| run.along[0]).fold(f64::INFINITY, f64::min);
        let hi = cluster.iter().map(|run| run.along[1]).fold(f64::NEG_INFINITY, f64::max);
        let reach = gap * (cluster.len() + 2) as f64;
        let (mut low, mut high) = (line - reach, line + reach);
        let region =
            if axis == 0 { [line - reach, lo, line + reach, hi] } else { [lo, line - reach, hi, line + reach] };
        self.obstacles.some(region, 0.0, |obstacle| {
            if obstacle[axis + 2] <= line + EPSILON {
                low = low.max(obstacle[axis + 2] + gap / 2.0);
            } else if obstacle[axis] >= line - EPSILON {
                high = high.min(obstacle[axis] - gap / 2.0);
            }
            false
        });
        let mut order: Vec<&Run> = cluster.iter().collect();
        // Order by turn, then length (longest first where ends turn lower), then start. Sort by the
        // last key first, since each sort is stable.
        crate::order::by_key(&mut order, |a| crate::order::number(a.along[0]));
        crate::order::by_wide_key(&mut order, |a| {
            let length = crate::order::number(a.along[1] - a.along[0]);
            crate::order::wide(crate::order::number(a.turn), if a.turn > 0.0 { length } else { !length })
        });
        let last = (order.len() - 1) as f64;
        let step = gap.min((high - low).max(0.0) / last.max(1.0));
        let base =
            order.iter().position(|run| run.held()).map_or(line - last * step / 2.0, |held| line - held as f64 * step);
        let base = low.min(line).max(base.min(high.max(line) - last * step));
        for (rank, run) in order.iter().enumerate() {
            if run.held() {
                continue;
            }
            let at = (base + rank as f64 * step).min(run.limits[1]).max(run.limits[0]);
            if let Some(tree) = &mut trees[run.net] {
                for &joint in &run.joints {
                    tree.points[joint][axis] = at;
                }
            }
        }
    }
}

/// The axis direction by which an offset from a box's center exits it, relative to its `size`.
fn outward(offset: Point, size: Point) -> Point {
    let across = |k: usize| (offset[k] / size[k].max(f64::MIN_POSITIVE)).abs();
    let away = |v: f64| if v < 0.0 { -1.0 } else { 1.0 };
    if across(0) > across(1) { [away(offset[0]), 0.0] } else { [0.0, away(offset[1])] }
}

/// The kind of a tree's joint, which limits how tracks may move it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Joint {
    /// A bend or a junction, free to move.
    Bend,
    /// A terminal, which never moves.
    Terminal,
    /// A stub's outer end. Its stub from the given terminal joint may only grow.
    Stub(usize),
}

/// A net being routed: joints, each joined to its parent by an axis-aligned segment. The first
/// joint is the root terminal.
#[derive(Default)]
struct Tree {
    points: Vec<Point>,
    parent: Vec<usize>,
    joints: Vec<Joint>,
}

impl Tree {
    /// A wire already routed, as a chain of joints that never move, so its runs keep their tracks.
    fn fixed(line: &[Point]) -> Tree {
        let mut tree = Tree::default();
        let mut parent = NONE;
        for &point in line {
            parent = tree.add(point, parent, Joint::Terminal);
        }
        tree
    }

    /// Adds a joint at `point` below `parent`.
    fn add(&mut self, point: Point, parent: usize, joint: Joint) -> usize {
        self.points.push(point);
        self.parent.push(parent);
        self.joints.push(joint);
        self.points.len() - 1
    }

    /// Inserts a joint at `point` on the segment from `child` to its parent.
    fn split(&mut self, child: usize, point: Point) -> usize {
        let joint = self.add(point, self.parent[child], Joint::Bend);
        self.parent[child] = joint;
        joint
    }

    /// Where a branch may attach, nearest to `toward` first: each joint except terminals, and each
    /// segment's nearest point to `toward`. Segments into terminals are stubs, which no branch
    /// attaches inside.
    fn attaches(&self, toward: Point) -> Vec<Attach> {
        let mut out = Vec::new();
        for child in 1..self.points.len() {
            let parent = self.parent[child];
            let (upper, lower) = (self.points[parent], self.points[child]);
            let (upper_held, lower_held) =
                (self.joints[parent] == Joint::Terminal, self.joints[child] == Joint::Terminal);
            if !upper_held {
                out.push(Attach { point: upper, child, interior: false });
            }
            if !lower_held {
                out.push(Attach { point: lower, child, interior: false });
            }
            if upper_held || lower_held {
                continue;
            }
            let nearest = |k: usize| toward[k].max(upper[k].min(lower[k])).min(upper[k].max(lower[k]));
            let point = if upper[0] == lower[0] { [upper[0], nearest(1)] } else { [nearest(0), upper[1]] };
            if manhattan(point, upper) > SAME && manhattan(point, lower) > SAME {
                out.push(Attach { point, child, interior: true });
            }
        }
        crate::order::by_key(&mut out, |a| crate::order::number(manhattan(a.point, toward)));
        out
    }

    /// When `attach` is at a joint with a stub into a terminal, the direction along that stub,
    /// which no branch may leave by.
    fn stub_way(&self, attach: Attach) -> Option<Point> {
        if attach.interior {
            return None;
        }
        let parent = self.parent[attach.child];
        let joint = if manhattan(attach.point, self.points[parent]) < SAME { parent } else { attach.child };
        let up = self.parent[joint];
        (0..self.points.len())
            .find(|&k| (k == up || self.parent[k] == joint) && self.joints[k] == Joint::Terminal)
            .map(|terminal| direction(attach.point, self.points[terminal]))
    }

    /// Moves a path's start along the tree while its first step runs along a tree segment, so the
    /// path attaches where it leaves the tree. Stubs stop it, since no branch attaches inside one.
    fn slide(&self, path: &mut Vec<Point>, mut attach: Attach) -> Attach {
        for _ in 0..self.points.len() {
            let [start, next, ..] = path[..] else { break };
            let way = direction(start, next);
            let along = (1..self.points.len()).find_map(|child| {
                let parent = self.parent[child];
                if self.joints[parent] == Joint::Terminal || self.joints[child] == Joint::Terminal {
                    return None;
                }
                let (upper, lower) = (self.points[parent], self.points[child]);
                let on = (start[0] == upper[0] && upper[0] == lower[0] && between(start[1], upper[1], lower[1]))
                    || (start[1] == upper[1] && upper[1] == lower[1] && between(start[0], upper[0], lower[0]));
                [upper, lower].into_iter().find(|&far| on && direction(start, far) == way).map(|far| (child, far))
            });
            let Some((child, far)) = along else { break };
            let (to_next, to_far) = (manhattan(start, next), manhattan(start, far));
            if to_next < to_far - SAME {
                path.remove(0);
                return Attach { point: next, child, interior: true };
            }
            attach = Attach { point: far, child, interior: false };
            if to_next <= to_far + SAME {
                path.remove(0);
            } else {
                path[0] = far;
            }
        }
        attach
    }

    /// The tree as polylines, each from the root or a junction to a leaf or the next junction.
    fn polylines(&self) -> Vec<Vec<Point>> {
        let count = self.points.len();
        let (mut children, mut siblings) = (vec![NONE; count], vec![NONE; count]);
        for joint in (1..count).rev() {
            let parent = self.parent[joint];
            siblings[joint] = children[parent];
            children[parent] = joint;
        }
        let mut polylines = Vec::new();
        let mut stack = if count > 0 { vec![0] } else { Vec::new() };
        while let Some(start) = stack.pop() {
            let mut first = children[start];
            while first != NONE {
                let mut line = vec![self.points[start]];
                let mut joint = first;
                loop {
                    line.push(self.points[joint]);
                    let child = children[joint];
                    if child == NONE || siblings[child] != NONE {
                        break;
                    }
                    joint = child;
                }
                polylines.push(simplify(&line));
                if children[joint] != NONE {
                    stack.push(joint);
                }
                first = siblings[first];
            }
        }
        polylines
    }
}

/// Where a branch may attach to a tree: a point on the segment from `child` to its parent, inside
/// it or at one of its joints.
#[derive(Clone, Copy)]
struct Attach {
    point: Point,
    child: usize,
    interior: bool,
}

/// A branch from a tree to a terminal's stub end: its path, starting where it attaches.
struct Branch {
    points: Vec<Point>,
    attach: Attach,
}

/// The cheapest branch found so far.
struct Best<'t> {
    tree: &'t Tree,
    /// The direction a branch enters the stub end: opposite the terminal's outward normal.
    into: Point,
    /// The cost of a bend, in length.
    bend: f64,
    groups: &'t Groups,
    cost: f64,
    branch: Option<Branch>,
}

impl Best<'_> {
    /// Keeps the path through `points` from `attach` if it turns well, costs less than the best so
    /// far, and, with `clear`, avoids the obstacles grown by the given clearance.
    fn consider(&mut self, points: &[Point], attach: Attach, clear: Option<(&Obstacles, f64)>) {
        let mut path = simplify(points);
        let attach = self.tree.slide(&mut path, attach);
        if !self.fits(&path, attach) {
            return;
        }
        let mut cost = path.len().saturating_sub(2) as f64 * self.bend;
        for pair in path.windows(2) {
            cost += manhattan(pair[0], pair[1]) + self.groups.cost(pair[0], pair[1]);
            if cost >= self.cost || clear.is_some_and(|(obstacles, by)| !obstacles.clear(pair[0], pair[1], by)) {
                return;
            }
        }
        if cost < self.cost {
            self.cost = cost;
            self.branch = Some(Branch { points: path, attach });
        }
    }

    /// Whether a path from the tree to the stub end turns well: it does not double back along the
    /// stub, it leaves a segment it attaches inside at a right angle, and it leaves a joint along
    /// none of the joint's segments.
    fn fits(&self, path: &[Point], attach: Attach) -> bool {
        let (Some(&[start, next]), Some(&[before, last])) = (path.first_chunk(), path.last_chunk()) else {
            return path.len() == 1;
        };
        direction(before, last) != [-self.into[0], -self.into[1]] && self.leaves_well(start, next, attach)
    }

    /// Whether a path's first step, from `start` toward `next`, leaves the tree well: at a right
    /// angle to a segment it attaches inside, or along none of a joint's segments.
    fn leaves_well(&self, start: Point, next: Point, attach: Attach) -> bool {
        let tree = self.tree;
        let parent = tree.parent[attach.child];
        let (upper, lower) = (tree.points[parent], tree.points[attach.child]);
        if attach.interior {
            let along = usize::from(upper[0] == lower[0]);
            return next[along] == start[along];
        }
        let leaving = direction(start, next);
        let joint = if manhattan(start, upper) < SAME { parent } else { attach.child };
        let up = tree.parent[joint];
        (0..tree.points.len())
            .filter(|&k| k == up || tree.parent[k] == joint)
            .all(|k| direction(start, tree.points[k]) != leaving)
    }
}

/// A search's ends: the points it may start from, each with a direction it may not leave by, and
/// its goal, with a direction it may not arrive moving in.
struct Leg<'p> {
    from: &'p [(Point, Option<Point>)],
    to: Point,
    arrive: Option<Point>,
}

/// How a search over one window ended.
enum Outcome {
    /// The path found, with the index of the leg's start it begins at.
    Found(usize, Vec<Point>),
    /// No path inside the window, though a wider window may have one.
    Walled,
    /// No path at all, or too much to search.
    Unreachable,
}

/// What a flood from the goal found before the full search.
enum Reach {
    /// A start, or more than `POCKET` crossings: the search is worth running.
    Open,
    /// A small region around the goal, without a start, touching the window's edge: a wider
    /// window may reach a start.
    Apart,
    /// A small region around the goal, without a start, walled in inside the window.
    Enclosed,
}

/// A state queued in a search: its estimated total cost, its cost so far, and the state (a
/// crossing and the axis of the step that reached it).
#[derive(Clone, Copy)]
struct Step {
    estimate: f64,
    cost: f64,
    state: u32,
}

impl Ord for Step {
    // The max-heap pops the least estimate first, then the greatest cost, then the lowest state.
    fn cmp(&self, other: &Step) -> Ordering {
        other
            .estimate
            .total_cmp(&self.estimate)
            .then(self.cost.total_cmp(&other.cost))
            .then(other.state.cmp(&self.state))
    }
}

impl PartialOrd for Step {
    fn partial_cmp(&self, other: &Step) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Step {
    fn eq(&self, other: &Step) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Step {}

/// A free stretch of a line among a search's obstacles: the line's coordinate, and where the
/// stretch starts and ends along it.
#[derive(Clone, Copy, PartialEq)]
struct Span {
    line: f64,
    lo: f64,
    hi: f64,
}

/// Where a horizontal and a vertical span cross: a vertex of a search's graph.
#[derive(Clone, Copy)]
struct Crossing {
    point: Point,
    /// The horizontal span, then the vertical one.
    spans: [u32; 2],
    /// Its index in the search's `columns`.
    place: u32,
}

/// Searches for orthogonal paths around obstacles over a sparse visibility graph: the free spans
/// of the lines through the obstacles' corners, the path's ends, and the window's edges, with
/// vertices where they cross. Every search reuses its scratch buffers, which never shrink.
struct Search {
    /// The cost of a bend, in length.
    bend: f64,
    /// How far a window extends past the points and boxes it frames.
    margin: f64,
    /// The graph's vertices: horizontal span by span, each from left to right.
    crossings: Vec<Crossing>,
    /// The crossings of each vertical span from bottom to top, span after span.
    columns: Vec<u32>,
    /// Where each vertical span's crossings start in `columns`, then where the last ends.
    starts: Vec<u32>,
    /// The cheapest cost found to each state (a crossing and the axis of the step that reached it).
    costs: Vec<f64>,
    /// The state each state was reached from.
    came: Vec<u32>,
    heap: BinaryHeap<Step>,
    /// Which crossings a flood has reached.
    seen: Vec<bool>,
    /// The crossings a flood reached, in the order it reached them.
    queue: Vec<usize>,
}

impl Search {
    /// A search where a bend costs `reach`, and windows extend `reach` past what they frame.
    fn new(reach: f64) -> Search {
        Search {
            bend: reach,
            margin: reach,
            crossings: Vec::new(),
            columns: Vec::new(),
            starts: Vec::new(),
            costs: Vec::new(),
            came: Vec::new(),
            heap: BinaryHeap::new(),
            seen: Vec::new(),
            queue: Vec::new(),
        }
    }

    /// The cheapest orthogonal path for `leg` around the obstacles grown by `by`, from the cheapest
    /// start, within a window framing the leg and the boxes `around`. The window widens to cover
    /// obstacles that wall it in. `None` when the goal or every start is inside an obstacle, or no
    /// path is found.
    fn path(
        &mut self,
        obstacles: &Obstacles,
        groups: &Groups,
        leg: &Leg,
        around: &[Rect],
        by: f64,
    ) -> Option<(usize, Vec<Point>)> {
        let frame = around.iter().fold(dot(leg.to), |frame, owner| union(frame, *owner));
        let frame = leg.from.iter().fold(frame, |frame, &(start, _)| union(frame, dot(start)));
        let mut window = grow(frame, self.margin);
        for _ in 0..=WIDENINGS {
            let boxes = obstacles.query(grow(window, by), by);
            let free = |point: Point| !boxes.iter().any(|obstacle| inside(point, obstacle));
            if !free(leg.to) || !leg.from.iter().any(|&(start, _)| free(start)) {
                return None;
            }
            match self.graph(&boxes, groups, window, leg) {
                Outcome::Found(source, path) => return Some((source, path)),
                Outcome::Unreachable => return None,
                Outcome::Walled => {}
            }
            if boxes.iter().all(|obstacle| within(obstacle, &window)) {
                return None;
            }
            window = grow(boxes.iter().fold(window, |walls, obstacle| union(walls, *obstacle)), self.margin);
        }
        None
    }

    /// Builds the window's visibility graph through `ends` among `boxes` (the grown obstacles that
    /// meet the window). Returns false when it has too many crossings to search.
    fn build(&mut self, boxes: &[Rect], window: Rect, ends: &[Point]) -> bool {
        let horizontal = spans(boxes, window, ends, 0);
        let vertical = spans(boxes, window, ends, 1);
        self.crossings.clear();
        for (row, span) in horizontal.iter().enumerate() {
            let first = vertical.partition_point(|other| other.line < span.lo);
            for (column, other) in
                vertical.iter().enumerate().skip(first).take_while(|(_, other)| other.line <= span.hi)
            {
                if other.lo <= span.line && span.line <= other.hi {
                    let spans = [row as u32, column as u32];
                    self.crossings.push(Crossing { point: [other.line, span.line], spans, place: 0 });
                }
            }
            if self.crossings.len() > MAX_CROSSINGS {
                return false;
            }
        }
        // Index each vertical span's crossings. They come bottom to top, as the rows do.
        self.starts.clear();
        self.starts.resize(vertical.len() + 1, 0);
        for crossing in &self.crossings {
            self.starts[crossing.spans[1] as usize] += 1;
        }
        let mut total = 0;
        for start in &mut self.starts {
            (*start, total) = (total, total + *start);
        }
        let mut cursor = self.starts.clone();
        self.columns.clear();
        self.columns.resize(self.crossings.len(), 0);
        for (index, crossing) in self.crossings.iter_mut().enumerate() {
            let at = &mut cursor[crossing.spans[1] as usize];
            crossing.place = *at;
            self.columns[*at as usize] = index as u32;
            *at += 1;
        }
        true
    }

    /// Runs A* over the window's visibility graph for `leg` among `boxes` (the grown obstacles that
    /// meet the window). Each state is a crossing plus the axis of the step that reached it, and
    /// each step also pays its `groups` border cost. The groups' lanes, just inside and outside
    /// their borders, are lines of the graph too.
    fn graph(&mut self, boxes: &[Rect], groups: &Groups, window: Rect, leg: &Leg) -> Outcome {
        let groups = groups.within(window);
        let mut ends: Vec<Point> = leg.from.iter().map(|&(start, _)| start).chain([leg.to]).collect();
        ends.extend(groups.lanes());
        if !self.build(boxes, window, &ends) {
            return Outcome::Unreachable;
        }
        let find = |point: Point| self.crossings.iter().position(|crossing| crossing.point == point);
        let Some(goal) = find(leg.to) else { return Outcome::Unreachable };
        let sources: Vec<(usize, Option<Point>)> =
            leg.from.iter().filter_map(|&(start, banned)| find(start).map(|vertex| (vertex, banned))).collect();
        if sources.is_empty() {
            return Outcome::Unreachable;
        }
        match self.flood(goal, &sources, window) {
            Reach::Open => {}
            Reach::Apart => return Outcome::Walled,
            Reach::Enclosed => return Outcome::Unreachable,
        }
        let states = self.crossings.len() * 2;
        self.costs.clear();
        self.costs.resize(states, f64::INFINITY);
        self.came.clear();
        self.came.resize(states, NOWHERE);
        self.heap.clear();
        for &(vertex, _) in &sources {
            for axis in 0..2 {
                let state = vertex * 2 + axis;
                self.costs[state] = 0.0;
                let estimate = self.estimate(self.crossings[vertex].point, None, leg.to);
                self.heap.push(Step { estimate, cost: 0.0, state: state as u32 });
            }
        }
        let (mut visits, mut edge) = (0, false);
        while let Some(Step { cost, state, .. }) = self.heap.pop() {
            let state = state as usize;
            if cost > self.costs[state] {
                continue;
            }
            let (vertex, axis) = (state / 2, state % 2);
            if vertex == goal {
                let path = self.trace(state);
                let source = leg.from.iter().position(|&(start, _)| start == path[0]).unwrap_or(0);
                return Outcome::Found(source, path);
            }
            visits += 1;
            if visits > MAX_VISITS {
                return Outcome::Unreachable;
            }
            let crossing = self.crossings[vertex];
            edge |= on_edge(crossing.point, &window);
            // A start's first step may leave in any direction but its banned one.
            let first = self.came[state] == NOWHERE;
            let banned =
                if first { sources.iter().find(|source| source.0 == vertex).and_then(|source| source.1) } else { None };
            for (k, next) in self.neighbors(vertex).into_iter().enumerate() {
                let Some(next) = next else { continue };
                let along = k / 2;
                let point = self.crossings[next].point;
                let way = Some(direction(crossing.point, point));
                if (banned.is_some() && way == banned) || (next == goal && way == leg.arrive) {
                    continue;
                }
                let turn = if !first && along != axis { self.bend } else { 0.0 };
                let value = cost + manhattan(crossing.point, point) + turn + groups.cost(crossing.point, point);
                let reached = next * 2 + along;
                if value >= self.costs[reached] {
                    continue;
                }
                self.costs[reached] = value;
                self.came[reached] = state as u32;
                let estimate = value + self.estimate(point, Some(along), leg.to);
                self.heap.push(Step { estimate, cost: value, state: reached as u32 });
            }
        }
        // If the search never reached the window's edge, a wider window would not help.
        if edge { Outcome::Walled } else { Outcome::Unreachable }
    }

    /// A lower bound on the cost from `point`, reached along `axis`, to `to`: the Manhattan
    /// distance, plus a bend if a turn is still needed. `axis` is `None` at a start, whose first
    /// step turns for free.
    fn estimate(&self, point: Point, axis: Option<usize>, to: Point) -> f64 {
        let turns = match ([point[0] != to[0], point[1] != to[1]], axis) {
            ([true, true], _) | ([true, false], Some(1)) | ([false, true], Some(0)) => 1.0,
            _ => 0.0,
        };
        manhattan(point, to) + turns * self.bend
    }

    /// The crossings next to `vertex`: left and right along its horizontal span, then down and up
    /// along its vertical one.
    fn neighbors(&self, vertex: usize) -> [Option<usize>; 4] {
        let crossing = self.crossings[vertex];
        let row = |other: usize| self.crossings.get(other).is_some_and(|c| c.spans[0] == crossing.spans[0]);
        let place = crossing.place as usize;
        let column = crossing.spans[1] as usize;
        let (low, high) = (self.starts[column] as usize, self.starts[column + 1] as usize);
        [
            vertex.checked_sub(1).filter(|&left| row(left)),
            Some(vertex + 1).filter(|&right| row(right)),
            (place > low).then(|| self.columns[place - 1] as usize),
            (place + 1 < high).then(|| self.columns[place + 1] as usize),
        ]
    }

    /// Floods the graph from `goal` for up to `POCKET` crossings, to fail fast when the goal is
    /// walled off from every start.
    fn flood(&mut self, goal: usize, sources: &[(usize, Option<Point>)], window: Rect) -> Reach {
        self.seen.clear();
        self.seen.resize(self.crossings.len(), false);
        self.queue.clear();
        self.queue.push(goal);
        self.seen[goal] = true;
        let (mut next, mut edge) = (0, false);
        while let Some(&vertex) = self.queue.get(next) {
            if next >= POCKET || sources.iter().any(|source| source.0 == vertex) {
                return Reach::Open;
            }
            next += 1;
            edge |= on_edge(self.crossings[vertex].point, &window);
            for other in self.neighbors(vertex).into_iter().flatten() {
                if !self.seen[other] {
                    self.seen[other] = true;
                    self.queue.push(other);
                }
            }
        }
        if edge { Reach::Apart } else { Reach::Enclosed }
    }

    /// The simplified path to state `goal`, from its start.
    fn trace(&self, goal: usize) -> Vec<Point> {
        let mut path = Vec::new();
        let mut state = goal;
        loop {
            path.push(self.crossings[state / 2].point);
            match self.came[state] {
                NOWHERE => break,
                previous => state = previous as usize,
            }
        }
        path.reverse();
        simplify(&path)
    }
}

/// The free spans of lines running along axis `along` (0: x, 1: y) within `window`, among `boxes`
/// (the grown obstacles that meet it). Lines pass through each box's corners (clamped into the
/// window) and through each of `ends`, taking the free span at that point. Lines along the
/// window's edges take every free span. Sorted by line, then start.
fn spans(boxes: &[Rect], window: Rect, ends: &[Point], along: usize) -> Vec<Span> {
    let held = 1 - along;
    let (start, end) = (window[along], window[along + 2]);
    let (low, high) = (window[held], window[held + 2]);
    // A seed is a line and a point along it, which selects the free span holding that point. NaN
    // selects every free span of the line.
    let mut seeds: Vec<Point> = boxes
        .iter()
        .flat_map(|r| {
            [[r[held], r[along]], [r[held], r[along + 2]], [r[held + 2], r[along]], [r[held + 2], r[along + 2]]]
        })
        .chain(ends.iter().map(|point| [point[held], point[along]]))
        .filter(|&[line, _]| (low..=high).contains(&line))
        .map(|[line, at]| [line, at.max(start).min(end)])
        .chain([[low, f64::NAN], [high, f64::NAN]])
        .collect();
    crate::order::by_wide_key(&mut seeds, |a| {
        crate::order::wide(crate::order::number(a[0]), crate::order::number(a[1]))
    });
    // Sweep across the lines, keeping the boxes whose extent across contains the line, by start.
    let mut order: Vec<usize> = (0..boxes.len()).collect();
    crate::order::by_key(&mut order, |&a| crate::order::number(boxes[a][held]));
    let mut order = order.into_iter().peekable();
    let mut active: Vec<Rect> = Vec::new();
    let mut spans = Vec::new();
    let mut merged: Vec<[f64; 2]> = Vec::new();
    for seeds in seeds.chunk_by(|a, b| a[0] == b[0]) {
        let line = seeds[0][0];
        while let Some(r) = order.next_if(|&next| boxes[next][held] + EPSILON < line).map(|next| boxes[next]) {
            let at = active.partition_point(|other| other[along] <= r[along]);
            active.insert(at, r);
        }
        active.retain(|r| line < r[held + 2] - EPSILON);
        // The stretches of the line inside obstacles, merged where they touch.
        merged.clear();
        for r in &active {
            match merged.last_mut() {
                Some(last) if r[along] <= last[1] + EPSILON => last[1] = last[1].max(r[along + 2]),
                _ => merged.push([r[along], r[along + 2]]),
            }
        }
        for &[_, at] in seeds {
            if at.is_nan() {
                let mut lo = start;
                for &[from, to] in &merged {
                    if lo > end {
                        break;
                    }
                    if from > lo {
                        spans.push(Span { line, lo, hi: from.min(end) });
                    }
                    lo = lo.max(to);
                }
                if lo <= end {
                    spans.push(Span { line, lo, hi: end });
                }
                continue;
            }
            let after = merged.partition_point(|stretch| stretch[0] <= at - EPSILON);
            if after > 0 && merged[after - 1][1] > at + EPSILON {
                continue;
            }
            let lo = if after > 0 { merged[after - 1][1].max(start) } else { start };
            let hi = merged.get(after).map_or(end, |stretch| stretch[0].min(end));
            spans.push(Span { line, lo: lo.min(at), hi: hi.max(at) });
        }
    }
    crate::order::by_wide_key(&mut spans, |a| {
        crate::order::wide(crate::order::number(a.line), crate::order::number(a.lo))
    });
    spans.dedup();
    spans
}

/// The groups wires route among: boxes they may cross, at a cost.
struct Groups {
    boxes: Vec<Rect>,
    /// How far wires keep from obstacles. A border's lanes lie half this inside and outside it.
    clearance: f64,
}

impl Groups {
    /// The cost of a run from `a` to `b` beyond its length: [`CROSSING`] clearances per border it
    /// crosses, plus the length it runs along a border closer than half a clearance.
    fn cost(&self, a: Point, b: Point) -> f64 {
        let along = usize::from(a[0] == b[0]);
        let held = 1 - along;
        let (lo, hi, line) = (a[along].min(b[along]), a[along].max(b[along]), a[held]);
        let near = self.clearance / 2.0;
        let mut cost = 0.0;
        for r in &self.boxes {
            if line > r[held] && line < r[held + 2] {
                let crossed = [r[along], r[along + 2]].iter().filter(|&&side| side > lo && side < hi).count();
                cost += crossed as f64 * CROSSING * self.clearance;
            }
            for side in [r[held], r[held + 2]] {
                if (line - side).abs() < near {
                    cost += (hi.min(r[along + 2]) - lo.max(r[along])).max(0.0);
                }
            }
        }
        cost
    }

    /// The groups meeting `window`.
    fn within(&self, window: Rect) -> Groups {
        Groups { boxes: self.boxes.iter().copied().filter(|r| meets(r, &window)).collect(), clearance: self.clearance }
    }

    /// The corners of the lanes along every group's borders, half a clearance inside and outside,
    /// which the search's lines pass through.
    fn lanes(&self) -> Vec<Point> {
        let half = self.clearance / 2.0;
        let mut out = Vec::new();
        for r in &self.boxes {
            for by in [half, -half] {
                let g = grow(*r, by);
                if g[0] < g[2] && g[1] < g[3] {
                    out.extend([[g[0], g[1]], [g[2], g[1]], [g[0], g[3]], [g[2], g[3]]]);
                }
            }
        }
        out
    }
}

/// The obstacles routing avoids, read from an index of boxes.
struct Obstacles<'a> {
    boxes: &'a Boxes,
}

impl Obstacles<'_> {
    /// The box of obstacle `owner`, when there is one.
    fn owned(&self, owner: Option<u32>) -> Option<Rect> {
        owner.and_then(|owner| self.boxes.get(owner as usize))
    }

    /// Visits the obstacles meeting `region`, each grown by `by`, until `visit` returns true.
    /// Returns whether it did.
    fn some(&self, region: Rect, by: f64, mut visit: impl FnMut(Rect) -> bool) -> bool {
        self.boxes.some(region, &mut |item| visit(grow(self.boxes.get(item).expect("a box visited"), by)))
    }

    /// The obstacles meeting `region`, each grown by `by`.
    fn query(&self, region: Rect, by: f64) -> Vec<Rect> {
        let mut out = Vec::new();
        self.some(region, by, |obstacle| {
            out.push(obstacle);
            false
        });
        out
    }

    /// Whether the axis-aligned segment from `a` to `b` avoids every obstacle grown by `by`.
    fn clear(&self, a: Point, b: Point, by: f64) -> bool {
        let span = grow([a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])], by);
        !self.some(span, by, |obstacle| crosses(a, b, &obstacle))
    }
}

/// Whether box `a` lies within box `b`.
fn within(a: &Rect, b: &Rect) -> bool {
    a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
}

/// Whether a point is on a box's edge.
fn on_edge(p: Point, r: &Rect) -> bool {
    p[0] == r[0] || p[0] == r[2] || p[1] == r[1] || p[1] == r[3]
}

/// Whether a point is strictly inside a box, by more than `EPSILON`.
fn inside(p: Point, r: &Rect) -> bool {
    p[0] > r[0] + EPSILON && p[0] < r[2] - EPSILON && p[1] > r[1] + EPSILON && p[1] < r[3] - EPSILON
}

/// Whether the axis-aligned segment from `a` to `b` passes through a box's interior.
fn crosses(a: Point, b: Point, r: &Rect) -> bool {
    // A vertical segment has a fixed x and runs along y. A horizontal one has a fixed y.
    let held = usize::from(a[0] != b[0]);
    let runs = 1 - held;
    a[held] > r[held] + EPSILON
        && a[held] < r[held + 2] - EPSILON
        && a[runs].max(b[runs]) > r[runs] + EPSILON
        && a[runs].min(b[runs]) < r[runs + 2] - EPSILON
}

/// Whether `v` lies between `a` and `b`, either way round.
fn between(v: f64, a: f64, b: f64) -> bool {
    a.min(b) <= v && v <= a.max(b)
}

/// The Manhattan distance between two points: the length of an orthogonal path between them.
fn manhattan(a: Point, b: Point) -> f64 {
    (a[0] - b[0]).abs() + (a[1] - b[1]).abs()
}

/// −1, 0, or 1 as `v` is below, at, or above zero.
fn sign(v: f64) -> f64 {
    if v > 0.0 {
        1.0
    } else if v < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// The sign of each axis of the direction from `from` to `to`.
fn direction(from: Point, to: Point) -> Point {
    [sign(to[0] - from[0]), sign(to[1] - from[1])]
}

/// A path's points with repeats and collinear middle points removed.
pub(crate) fn simplify(path: &[Point]) -> Vec<Point> {
    let mut out: Vec<Point> = Vec::with_capacity(path.len());
    for &p in path {
        if out.last() == Some(&p) {
            continue;
        }
        if let [.., a, b] = out[..]
            && ((a[0] == b[0] && b[0] == p[0]) || (a[1] == b[1] && b[1] == p[1]))
        {
            out.pop();
        }
        out.push(p);
    }
    out
}

/// A net's chain of segments along one line, which a track moves as one.
struct Run {
    net: usize,
    /// The joints a track moves with it.
    joints: Vec<usize>,
    /// The line's coordinate on the axis tracks move it along.
    line: f64,
    /// Where it starts and ends along the line.
    along: [f64; 2],
    /// Which way its ends turn: negative toward lower lines, positive toward higher.
    turn: f64,
    /// The lines tracks may move it between, or a single line for a run holding a terminal.
    limits: [f64; 2],
}

impl Run {
    /// Whether its limits allow one line only (it holds a terminal), so no track moves it.
    fn held(&self) -> bool {
        self.limits[0] == self.limits[1]
    }
}

/// Every net's runs whose line has a fixed `axis` coordinate: maximal chains of segments along one
/// line. A stub's end keeps at least `least` from its terminal.
fn runs(trees: &[Option<Tree>], axis: usize, least: f64) -> Vec<Run> {
    let mut runs = Vec::new();
    for (net, tree) in trees.iter().enumerate() {
        let Some(tree) = tree else { continue };
        let count = tree.points.len();
        let line = |joint: usize| tree.points[joint][axis];
        let along = |joint: usize| tree.points[joint][1 - axis];
        let on_line = |a: usize, b: usize| line(a) == line(b) && along(a) != along(b);
        let mut neighbors = vec![Vec::new(); count];
        for child in 1..count {
            let parent = tree.parent[child];
            neighbors[child].push(parent);
            neighbors[parent].push(child);
        }
        let mut component = vec![NONE; count];
        for seed in 0..count {
            if component[seed] != NONE || !neighbors[seed].iter().any(|&other| on_line(seed, other)) {
                continue;
            }
            let mut joints = Vec::new();
            let mut stack = vec![seed];
            component[seed] = seed;
            while let Some(joint) = stack.pop() {
                joints.push(joint);
                for &other in &neighbors[joint] {
                    if component[other] == NONE && on_line(joint, other) {
                        component[other] = seed;
                        stack.push(other);
                    }
                }
            }
            let (mut first, mut last) = (joints[0], joints[0]);
            let mut limits = [f64::NEG_INFINITY, f64::INFINITY];
            for &joint in &joints {
                if along(joint) < along(first) {
                    first = joint;
                }
                if along(joint) > along(last) {
                    last = joint;
                }
                match tree.joints[joint] {
                    Joint::Terminal => limits = [line(joint); 2],
                    Joint::Stub(terminal) => {
                        let out = sign(line(joint) - line(terminal));
                        if out > 0.0 {
                            limits[0] = limits[0].max(line(terminal) + least);
                        } else if out < 0.0 {
                            limits[1] = limits[1].min(line(terminal) - least);
                        }
                    }
                    Joint::Bend => {}
                }
            }
            let turn = |joint: usize| -> f64 {
                neighbors[joint]
                    .iter()
                    .filter(|&&other| component[other] != seed)
                    .map(|&other| sign(line(other) - line(joint)))
                    .sum()
            };
            let at = line(seed);
            runs.push(Run {
                net,
                line: at,
                along: [along(first), along(last)],
                turn: turn(first) + turn(last),
                limits: [limits[0].min(at), limits[1].max(at)],
                joints,
            });
        }
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPACING: f64 = 8.0;

    /// A terminal at `at` on `side` of obstacle `owner`.
    fn on(at: Point, side: Side, owner: u32) -> Terminal {
        Terminal { at, side: Some(side), owner: Some(owner) }
    }

    /// Every segment of a net's polylines.
    fn segments(wire: &[Vec<Point>]) -> Vec<[Point; 2]> {
        wire.iter().flat_map(|line| line.windows(2).map(|pair| [pair[0], pair[1]])).collect()
    }

    /// Whether every segment runs horizontally or vertically.
    fn orthogonal(wire: &[Vec<Point>]) -> bool {
        segments(wire).iter().all(|[a, b]| a[0] == b[0] || a[1] == b[1])
    }

    /// Whether no segment passes through any of `boxes`.
    fn outside(wire: &[Vec<Point>], boxes: &[Rect]) -> bool {
        segments(wire).iter().all(|[a, b]| boxes.iter().all(|r| !crosses(*a, *b, r)))
    }

    /// The point after the terminal at `at` on its wire, which shows the way the wire leaves it.
    fn leaving(wire: &[Vec<Point>], at: Point) -> Point {
        wire.iter()
            .find_map(|line| match line[..] {
                [first, next, ..] if first == at => Some(next),
                [.., next, last] if last == at => Some(next),
                _ => None,
            })
            .expect("the wire ends at the terminal")
    }

    /// Whether the polylines make one tree reaching every terminal: each starts at the first
    /// terminal or where another ends.
    fn one_tree(wire: &[Vec<Point>], terminals: &[Terminal]) -> bool {
        let mut reached = vec![terminals[0].at];
        let mut joined = vec![false; wire.len()];
        while let Some(line) = (0..wire.len()).find(|&line| !joined[line] && reached.contains(&wire[line][0])) {
            joined[line] = true;
            reached.extend(wire[line].last());
        }
        joined.iter().all(|&joined| joined) && terminals.iter().all(|terminal| reached.contains(&terminal.at))
    }

    #[test]
    fn side_by_side_boxes_join_by_a_straight_run() {
        let boxes = [[0.0, 0.0, 20.0, 20.0], [100.0, 0.0, 120.0, 20.0]];
        let nets = [Net { terminals: vec![on([20.0, 10.0], Side::Right, 0), on([100.0, 10.0], Side::Left, 1)] }];
        assert_eq!(
            route(&Boxes::new(boxes.to_vec()), &[], &nets, &[], SPACING),
            vec![vec![vec![[20.0, 10.0], [100.0, 10.0]]]]
        );
    }

    #[test]
    fn a_wire_bends_around_an_obstacle_between() {
        let boxes = [[0.0, 0.0, 20.0, 20.0], [200.0, 0.0, 220.0, 20.0], [80.0, -30.0, 140.0, 50.0]];
        let nets = [Net { terminals: vec![on([20.0, 10.0], Side::Right, 0), on([200.0, 10.0], Side::Left, 1)] }];
        let wire = &route(&Boxes::new(boxes.to_vec()), &[], &nets, &[], SPACING)[0];
        assert!(orthogonal(wire), "{wire:?}");
        assert!(segments(wire).len() > 2, "it bends: {wire:?}");
        assert!(outside(wire, &boxes), "{wire:?}");
        assert!(one_tree(wire, &nets[0].terminals), "{wire:?}");
    }

    #[test]
    fn wires_go_around_groups_they_do_not_join() {
        // A thin group lies on the straight path between two blocks: going through is shorter,
        // going around stays outside it.
        let boxes = [[20.0, 45.0, 40.0, 55.0], [160.0, 45.0, 180.0, 55.0]];
        let group = [90.0, 44.0, 110.0, 56.0];
        let nets = [Net { terminals: vec![on([40.0, 50.0], Side::Right, 0), on([160.0, 50.0], Side::Left, 1)] }];
        let through = &route(&Boxes::new(boxes.to_vec()), &[], &nets, &[], SPACING)[0];
        assert_eq!(segments(through).len(), 1, "without the group, straight: {through:?}");
        let around = &route(&Boxes::new(boxes.to_vec()), &[group], &nets, &[], SPACING)[0];
        assert!(outside(around, &[group]), "with it, around: {around:?}");
        assert!(orthogonal(around) && one_tree(around, &nets[0].terminals), "{around:?}");
    }

    #[test]
    fn bends_meeting_on_a_short_run_do_not_repeat_points() {
        // An S-bend whose middle run is shorter than two radii: the arcs of its bends meet halfway.
        let wire = finish(&[vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [40.0, 10.0]]], 8.0);
        let line = &wire[0];
        assert!(line.windows(2).all(|w| manhattan(w[0], w[1]) > EPSILON), "no repeated point: {line:?}");
        assert_eq!((line[0], line[line.len() - 1]), ([0.0, 0.0], [40.0, 10.0]));
        // A part ending where another starts still repeats its last point: a junction.
        let tree = finish(&[vec![[0.0, 0.0], [10.0, 0.0]], vec![[10.0, 0.0], [10.0, 10.0]]], 8.0);
        assert_eq!(tree[0], [[0.0, 0.0], [10.0, 0.0], [10.0, 0.0]]);
    }

    #[test]
    fn crossing_or_running_along_a_group_border_adds_cost() {
        let groups = Groups { boxes: vec![[0.0, 0.0, 100.0, 90.0]], clearance: 2.0 * SPACING };
        assert_eq!(groups.cost([-10.0, 10.0], [10.0, 10.0]), CROSSING * 2.0 * SPACING, "a crossing");
        assert_eq!(groups.cost([10.0, 10.0], [20.0, 10.0]), 0.0, "inside, away from the border");
        assert_eq!(groups.cost([10.0, 88.0], [30.0, 88.0]), 20.0, "along the border");
    }

    #[test]
    fn a_wall_longer_than_the_search_window_is_routed_around() {
        let boxes = [
            [0.0, 0.0, 20.0, 20.0],
            [200.0, 0.0, 220.0, 20.0],
            [80.0, -100.0, 100.0, 120.0],
            [100.0, -400.0, 120.0, 90.0],
        ];
        let nets = [Net { terminals: vec![on([20.0, 10.0], Side::Right, 0), on([200.0, 10.0], Side::Left, 1)] }];
        let wire = &route(&Boxes::new(boxes.to_vec()), &[], &nets, &[], SPACING)[0];
        assert!(orthogonal(wire) && outside(wire, &boxes), "{wire:?}");
    }

    #[test]
    fn terminals_leave_along_their_sides() {
        let boxes = [
            [0.0, 0.0, 20.0, 20.0],
            [100.0, 100.0, 120.0, 120.0],
            [0.0, 200.0, 20.0, 220.0],
            [100.0, -100.0, 120.0, -80.0],
        ];
        let nets = [
            Net { terminals: vec![on([10.0, 20.0], Side::Top, 0), on([100.0, 110.0], Side::Left, 1)] },
            Net { terminals: vec![on([10.0, 200.0], Side::Bottom, 2), on([120.0, -90.0], Side::Right, 3)] },
        ];
        let routes = route(&Boxes::new(boxes.to_vec()), &[], &nets, &[], SPACING);
        for (net, wire) in nets.iter().zip(&routes) {
            assert!(orthogonal(wire) && outside(wire, &boxes), "{wire:?}");
            for terminal in &net.terminals {
                let next = leaving(wire, terminal.at);
                let out = [next[0] - terminal.at[0], next[1] - terminal.at[1]];
                let normal = terminal.side.expect("a side").normal();
                let ahead = out[0] * normal[0] + out[1] * normal[1];
                assert!(ahead > 0.0 && ahead == manhattan(next, terminal.at), "{terminal:?} leaves toward {next:?}");
            }
        }
    }

    #[test]
    fn a_net_of_three_terminals_is_one_tree() {
        let boxes = [[0.0, 0.0, 20.0, 20.0], [100.0, -60.0, 120.0, -40.0], [100.0, 60.0, 120.0, 80.0]];
        let net = Net {
            terminals: vec![
                on([20.0, 10.0], Side::Right, 0),
                on([100.0, -50.0], Side::Left, 1),
                on([100.0, 70.0], Side::Left, 2),
            ],
        };
        let wire = &route(&Boxes::new(boxes.to_vec()), &[], std::slice::from_ref(&net), &[], SPACING)[0];
        assert!(wire.len() >= 3, "a junction splits it: {wire:?}");
        assert!(orthogonal(wire) && outside(wire, &boxes), "{wire:?}");
        assert!(one_tree(wire, &net.terminals), "{wire:?}");
    }

    #[test]
    fn parallel_runs_of_different_nets_keep_spacing_apart() {
        let boxes =
            [[0.0, 0.0, 20.0, 20.0], [0.0, 30.0, 20.0, 50.0], [100.0, 60.0, 120.0, 80.0], [100.0, 90.0, 120.0, 110.0]];
        let nets = [
            Net { terminals: vec![on([20.0, 10.0], Side::Right, 0), on([100.0, 70.0], Side::Left, 2)] },
            Net { terminals: vec![on([20.0, 40.0], Side::Right, 1), on([100.0, 100.0], Side::Left, 3)] },
        ];
        let routes = route(&Boxes::new(boxes.to_vec()), &[], &nets, &[], SPACING);
        // A segment as the axis it runs along, its line, and its extent along it.
        let run = |[a, b]: [Point; 2]| {
            let axis = usize::from(a[0] == b[0]);
            (axis, a[1 - axis], [a[axis].min(b[axis]), a[axis].max(b[axis])])
        };
        let mut beside = 0;
        for one in segments(&routes[0]).into_iter().map(run) {
            for other in segments(&routes[1]).into_iter().map(run) {
                let overlap = one.2[1].min(other.2[1]) - one.2[0].max(other.2[0]);
                if one.0 != other.0 || overlap <= EPSILON {
                    continue;
                }
                let apart = (one.1 - other.1).abs();
                assert!(apart >= SPACING - EPSILON, "runs {apart} apart: {routes:?}");
                beside += usize::from(apart < 2.0 * SPACING);
            }
        }
        assert!(beside > 0, "the nets run side by side: {routes:?}");
    }

    #[test]
    fn an_enclosed_terminal_still_gets_an_orthogonal_route() {
        let ring = [
            [80.0, 40.0, 140.0, 50.0],
            [80.0, -30.0, 140.0, -20.0],
            [80.0, -30.0, 90.0, 50.0],
            [130.0, -30.0, 140.0, 50.0],
        ];
        let mut boxes = vec![[0.0, 0.0, 20.0, 20.0], [100.0, 0.0, 120.0, 20.0]];
        boxes.extend(ring);
        let nets = [Net { terminals: vec![on([20.0, 10.0], Side::Right, 0), on([100.0, 10.0], Side::Left, 1)] }];
        let wire = &route(&Boxes::new(boxes), &[], &nets, &[], SPACING)[0];
        assert!(orthogonal(wire) && one_tree(wire, &nets[0].terminals), "{wire:?}");
    }

    #[test]
    fn a_crowded_grid_routes_the_same_every_time() {
        let mut boxes = Vec::new();
        for row in 0..30 {
            for column in 0..30 {
                let (x, y) = (f64::from(column) * 60.0, f64::from(row) * 50.0);
                boxes.push([x, y, x + 30.0, y + 20.0]);
            }
        }
        let mut seed = 0x2545_f491_u32;
        let mut next = move |below: u32| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed % below
        };
        let sides = [Side::Left, Side::Right, Side::Top, Side::Bottom];
        let nets: Vec<Net> = (0..300)
            .map(|n| {
                let terminals = (0..if n % 5 == 0 { 3 } else { 2 })
                    .map(|_| {
                        let owner = next(900);
                        let r: Rect = boxes[owner as usize];
                        let side = sides[next(4) as usize];
                        let at = match side {
                            Side::Left => [r[0], r[1].midpoint(r[3])],
                            Side::Right => [r[2], r[1].midpoint(r[3])],
                            Side::Top => [r[0].midpoint(r[2]), r[3]],
                            Side::Bottom => [r[0].midpoint(r[2]), r[1]],
                        };
                        on(at, side, owner)
                    })
                    .collect();
                Net { terminals }
            })
            .collect();
        let obstacles = Boxes::new(boxes.clone());
        let routes = route(&obstacles, &[], &nets, &[], SPACING);
        assert_eq!(routes, route(&obstacles, &[], &nets, &[], SPACING), "the same input routes the same");
        for (net, wire) in nets.iter().zip(&routes) {
            assert!(orthogonal(wire), "{wire:?}");
            assert!(one_tree(wire, &net.terminals), "{net:?}: {wire:?}");
            let others: Vec<Rect> = (0..boxes.len())
                .filter(|&other| net.terminals.iter().all(|terminal| terminal.owner != Some(other as u32)))
                .map(|other| boxes[other])
                .collect();
            assert!(outside(wire, &others), "{net:?}: {wire:?}");
        }
    }

    #[test]
    fn nets_without_two_valid_terminals_get_no_wire() {
        let free = Terminal { at: [0.0, 0.0], side: None, owner: None };
        let nets = [
            Net::default(),
            Net { terminals: vec![free] },
            Net { terminals: vec![free, Terminal { at: [f64::NAN, 0.0], ..free }] },
        ];
        assert_eq!(route(&Boxes::default(), &[], &nets, &[], SPACING), vec![Vec::<Vec<Point>>::new(); 3]);
    }

    #[test]
    fn terminals_without_sides_leave_toward_the_rest_of_the_net() {
        let boxes = [[0.0, 0.0, 20.0, 20.0]];
        let nets = [Net {
            terminals: vec![
                Terminal { at: [20.0, 10.0], side: None, owner: Some(0) },
                Terminal { at: [100.0, 50.0], side: None, owner: None },
            ],
        }];
        let wire = &route(&Boxes::new(boxes.to_vec()), &[], &nets, &[], SPACING)[0];
        assert!(orthogonal(wire) && outside(wire, &boxes), "{wire:?}");
        assert_eq!(leaving(wire, [20.0, 10.0])[1], 10.0, "it leaves by the side it is on: {wire:?}");
    }
}
