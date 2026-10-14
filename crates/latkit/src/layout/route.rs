//! Orthogonal routes: wires in horizontal and vertical runs around obstacles.
//!
//! Each net grows as a tree from its first terminal. Every terminal leaves its vertex along its side
//! by a stub, and each further terminal, nearest first, branches off the tree by the cheapest clear
//! elbow, or else by an A* search over a sparse visibility graph: the free stretches of the lines
//! through the nearby obstacles' corners, joined where they cross. Tracks then set apart the runs of
//! different nets that share a line.
//!
//! Sides are in plane units with y up: a top side faces +y.

use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::scene::Side;

/// Where a wire meets a vertex: the point on its boundary, the side it leaves by (None: any), and the
/// obstacle it belongs to (an index into `obstacles`), which its own wire may touch.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Terminal {
    /// The point on the vertex's boundary.
    pub(crate) at: [f64; 2],
    /// The side the wire leaves by; with none, the owner's side nearest `at`, or else the way toward
    /// the rest of the net.
    pub(crate) side: Option<Side>,
    /// The obstacle the terminal belongs to.
    pub(crate) owner: Option<u32>,
}

/// A net: every terminal it joins. Two terminals make a plain edge.
#[derive(Clone, PartialEq, Debug, Default)]
pub(crate) struct Net {
    /// The terminals; the route grows from the first.
    pub(crate) terminals: Vec<Terminal>,
}

/// Each net's route as polylines (a tree for nets of more than two terminals, sharing junction points),
/// running in horizontal and vertical segments around `obstacles` (each `[min x, min y, max x, max y]`),
/// leaving each terminal along its side, with parallel runs of different nets `spacing` apart. Runs of
/// `fixed` polylines, wires already routed, keep their tracks, and the new runs take tracks beside
/// them. A net whose route cannot avoid the obstacles still gets an orthogonal route through them.
///
/// Wires keep twice `spacing` from obstacles where they can. A net of fewer than two terminals at
/// finite points gets no polylines; obstacles with a non-finite or inverted box are left out.
pub(crate) fn route(
    obstacles: &[[f64; 4]],
    nets: &[Net],
    fixed: &[Vec<[f64; 2]>],
    spacing: f64,
) -> Vec<Vec<Vec<[f64; 2]>>> {
    let mut router = Router::new(obstacles, spacing);
    let mut trees: Vec<Option<Tree>> = nets.iter().map(|net| router.net(net)).collect();
    let routed = trees.len();
    trees.extend(fixed.iter().filter(|line| line.len() > 1).map(|line| Some(Tree::fixed(line))));
    router.separate(&mut trees);
    trees.truncate(routed);
    trees.iter().map(|tree| tree.as_ref().map_or_else(Vec::new, Tree::polylines)).collect()
}

/// Arc points a rounded bend takes between its ends.
const ARC: usize = 3;

/// A net's polylines as drawn: each bend between perpendicular runs rounded by up to `radius`, and
/// each part ending where another starts doubled at its end, so that point draws as a junction and
/// takes no arrowhead.
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
                    out.push(p);
                    continue;
                }
                // A quarter circle from `p - u r` to `p + v r` about `p - u r + v r`.
                let center = [p[0] - u[0] * r + v[0] * r, p[1] - u[1] * r + v[1] * r];
                for i in 0..=ARC + 1 {
                    let t = i as f64 / (ARC + 1) as f64 * std::f64::consts::FRAC_PI_2;
                    let (cos, sin) = (t.cos(), t.sin());
                    out.push([
                        center[0] - v[0] * r * cos + u[0] * r * sin,
                        center[1] - v[1] * r * cos + u[1] * r * sin,
                    ]);
                }
            }
            if line.len() > 1 {
                out.extend(line.last());
            }
            let end = *out.last().expect("a polyline has points");
            if lines.iter().any(|other| other.first() == Some(&end)) {
                out.push(end);
            }
            out
        })
        .collect()
}

/// A point on the plane.
type Point = [f64; 2];

/// A box: min x, min y, max x, max y.
type Rect = [f64; 4];

/// How far wires keep from obstacles, in spacings.
const CLEARANCE: f64 = 2.0;

/// Offsets below this are rounding: a point this near a box's side is on it.
const EPSILON: f64 = 1e-6;

/// Points nearer than this are one point.
const SAME: f64 = 1e-9;

/// Children per index node.
const NODE: usize = 16;

/// Attach points a branch tries, nearest first.
const ATTACHES: usize = 8;

/// Attach points a branch searches from when no elbow is clear.
const SEARCHED: usize = 3;

/// Crossings past which a search gives up.
const MAX_CROSSINGS: usize = 1 << 20;

/// Steps a search takes before it gives up.
const MAX_VISITS: usize = 1 << 17;

/// Crossings a flood from a search's goal reaches before it takes the goal for open.
const POCKET: usize = 256;

/// Times a search widens its window over the obstacles that wall it in.
const WIDENINGS: usize = 1;

/// No joint: the root's parent, or a joint without children.
const NONE: usize = usize::MAX;

/// No state: where a search starts.
const NOWHERE: u32 = u32::MAX;

/// A box holding nothing, which any union replaces.
const EMPTY: Rect = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];

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

/// A terminal as routing reads it: where its wire meets the vertex, the way out, and its owner's box.
struct End {
    at: Point,
    normal: Point,
    owner: Option<Rect>,
}

/// Plans nets among the obstacles, then sets their runs apart.
struct Router<'a> {
    obstacles: Obstacles<'a>,
    /// How far apart tracks run.
    spacing: f64,
    /// How far wires keep from obstacles where they can.
    clearance: f64,
    search: Search,
}

impl<'a> Router<'a> {
    /// A router among `boxes`, tracks `spacing` apart; a negative or non-finite spacing is zero.
    fn new(boxes: &'a [Rect], spacing: f64) -> Router<'a> {
        let spacing = if spacing.is_finite() { spacing.max(0.0) } else { 0.0 };
        let clearance = spacing * CLEARANCE;
        Router { obstacles: Obstacles::new(boxes), spacing, clearance, search: Search::new(2.0 * clearance) }
    }

    /// The shortest stub, and the least a track keeps a stub's end off its terminal.
    fn least(&self) -> f64 {
        self.spacing / 8.0
    }

    /// A net's tree: the first terminal's stub, then each further terminal's branch, nearest first;
    /// `None` for a net of fewer than two terminals at finite points.
    fn net(&mut self, net: &Net) -> Option<Tree> {
        let terminals: Vec<Terminal> =
            net.terminals.iter().filter(|terminal| terminal.at.iter().all(|v| v.is_finite())).copied().collect();
        let (first, rest) = terminals.split_first()?;
        let root = self.end(*first, rest.first()?.at);
        let mut readers: Vec<End> = rest.iter().map(|terminal| self.end(*terminal, root.at)).collect();
        readers.sort_by(|a, b| manhattan(a.at, root.at).total_cmp(&manhattan(b.at, root.at)));
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

    /// How routing reads a terminal. Its way out is its side; else its owner's side nearest it; else
    /// the axis toward `toward`.
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

    /// Where a terminal's stub ends: clear of its owner by the clearance, or halfway to an obstacle
    /// in the way.
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

    /// The cheapest clear way from the tree to a reader's stub end `end`: an elbow from one of the
    /// nearest attach points; else a search around the obstacles at less and less clearance; else a
    /// plain elbow through them.
    fn branch(&mut self, tree: &Tree, end: Point, reader: &End, root: &End) -> Branch {
        let mut attaches = tree.attaches(end);
        attaches.truncate(ATTACHES);
        let into = [-reader.normal[0], -reader.normal[1]];
        let mut best = Best { tree, into, bend: self.search.bend, cost: f64::INFINITY, branch: None };
        let clear = Some((&self.obstacles, self.clearance - EPSILON));
        for &attach in &attaches {
            let from = attach.point;
            let middle = [from[0].midpoint(end[0]), from[1].midpoint(end[1])];
            best.consider(&[from, [end[0], from[1]], end], attach, clear);
            best.consider(&[from, [from[0], end[1]], end], attach, clear);
            best.consider(&[from, [middle[0], from[1]], [middle[0], end[1]], end], attach, clear);
            best.consider(&[from, [from[0], middle[1]], [end[0], middle[1]], end], attach, clear);
        }
        if let Some(branch) = best.branch.take() {
            return branch;
        }
        // The window frames the boxes a branch may have to go around: its terminal's, and the root's
        // when the branch may leave the root's stub.
        let searched = &attaches[..attaches.len().min(SEARCHED)];
        let from_root = searched.iter().any(|attach| attach.point == tree.points[1]);
        let owners: Vec<Rect> = [reader.owner, root.owner.filter(|_| from_root)].into_iter().flatten().collect();
        let from: Vec<(Point, Option<Point>)> =
            searched.iter().map(|&attach| (attach.point, tree.stub_way(attach))).collect();
        let leg = Leg { from: &from, to: end, arrive: Some(reader.normal) };
        for by in [self.clearance, self.clearance / 2.0, 0.0] {
            if let Some((source, path)) = self.search.path(&self.obstacles, &leg, &owners, by) {
                best.consider(&path, attaches[source], None);
            }
            if let Some(branch) = best.branch.take() {
                return branch;
            }
        }
        let attach = attaches.first().copied().unwrap_or(Attach { point: tree.points[0], child: 1, interior: false });
        Branch { points: simplify(&[attach.point, [end[0], attach.point[1]], end]), attach }
    }

    /// Sets apart the runs of different nets that share a line: each takes its own track, `spacing`
    /// apart where the corridor between obstacles has room, ordered by where its ends turn so runs
    /// nest rather than cross. A run carries its joints, so branches stay joined; terminals never
    /// move, and stubs only grow.
    fn separate(&self, trees: &mut [Option<Tree>]) {
        let tolerance = self.spacing / 16.0;
        for axis in 0..2 {
            let mut runs = runs(trees, axis, self.least());
            runs.sort_by(|a, b| a.line.total_cmp(&b.line).then(a.along[0].total_cmp(&b.along[0])));
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
        order.sort_by(|a, b| {
            let (length_a, length_b) = (a.along[1] - a.along[0], b.along[1] - b.along[0]);
            a.turn
                .total_cmp(&b.turn)
                .then_with(|| if a.turn > 0.0 { length_a.total_cmp(&length_b) } else { length_b.total_cmp(&length_a) })
                .then(a.along[0].total_cmp(&b.along[0]))
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

/// The axis direction an offset from a box's middle leaves it by, measured across the box's `size`.
fn outward(offset: Point, size: Point) -> Point {
    let across = |k: usize| (offset[k] / size[k].max(f64::MIN_POSITIVE)).abs();
    let away = |v: f64| if v < 0.0 { -1.0 } else { 1.0 };
    if across(0) > across(1) { [away(offset[0]), 0.0] } else { [0.0, away(offset[1])] }
}

/// What a joint of a tree is, which says how far tracks may move it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Joint {
    /// A bend or a junction, free to move.
    Bend,
    /// A terminal, which never moves.
    Terminal,
    /// A stub's outer end, whose stub from the terminal joint given only grows.
    Stub(usize),
}

/// A net while it is planned: joints, each joined to its parent by an axis-aligned segment. The
/// first joint is the root's terminal.
#[derive(Default)]
struct Tree {
    points: Vec<Point>,
    parent: Vec<usize>,
    joints: Vec<Joint>,
}

impl Tree {
    /// A wire already routed, as a chain of joints none of which moves: its runs hold their tracks.
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

    /// A joint at `point` on the segment from `child` to its parent.
    fn split(&mut self, child: usize, point: Point) -> usize {
        let joint = self.add(point, self.parent[child], Joint::Bend);
        self.parent[child] = joint;
        joint
    }

    /// Where a branch may attach, nearest `toward` first: each joint but a terminal, and each
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
        out.sort_by(|a, b| manhattan(a.point, toward).total_cmp(&manhattan(b.point, toward)));
        out
    }

    /// The way from a joint `attach` is at along its stub into a terminal, which no branch leaves by.
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

    /// Moves a path's start along the tree while its first step runs along a segment of the tree, so
    /// the path attaches where it leaves the tree. Stubs, which no branch attaches inside, stop it.
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

/// A branch from a tree to a terminal's stub end: its path, from where it attaches.
struct Branch {
    points: Vec<Point>,
    attach: Attach,
}

/// The cheapest branch found so far.
struct Best<'t> {
    tree: &'t Tree,
    /// The way a branch enters the stub end: against the terminal's side.
    into: Point,
    /// What a bend costs, in length.
    bend: f64,
    cost: f64,
    branch: Option<Branch>,
}

impl Best<'_> {
    /// Keeps the path through `points` from `attach` when it turns well, costs less than the best so
    /// far, and, with `clear`, keeps out of the obstacles grown by the clearance given.
    fn consider(&mut self, points: &[Point], attach: Attach, clear: Option<(&Obstacles, f64)>) {
        let mut path = simplify(points);
        let attach = self.tree.slide(&mut path, attach);
        if !self.fits(&path, attach) {
            return;
        }
        let mut cost = path.len().saturating_sub(2) as f64 * self.bend;
        for pair in path.windows(2) {
            cost += manhattan(pair[0], pair[1]);
            if cost >= self.cost || clear.is_some_and(|(obstacles, by)| !obstacles.clear(pair[0], pair[1], by)) {
                return;
            }
        }
        if cost < self.cost {
            self.cost = cost;
            self.branch = Some(Branch { points: path, attach });
        }
    }

    /// Whether a path from the tree to the stub end turns well: it never doubles back along the
    /// stub, leaves a segment it attaches inside across it, and leaves a joint along none of the
    /// segments already there.
    fn fits(&self, path: &[Point], attach: Attach) -> bool {
        let (Some(&[start, next]), Some(&[before, last])) = (path.first_chunk(), path.last_chunk()) else {
            return path.len() == 1;
        };
        direction(before, last) != [-self.into[0], -self.into[1]] && self.leaves_well(start, next, attach)
    }

    /// Whether a path's first step, from `start` toward `next`, leaves the tree well.
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

/// What a search joins: the points it may leave from, each with a way it may not leave by, and the
/// point it reaches, with a way it may not arrive moving.
struct Leg<'p> {
    from: &'p [(Point, Option<Point>)],
    to: Point,
    arrive: Option<Point>,
}

/// How a search over one window ended.
enum Outcome {
    /// The path found, from the leg's start given.
    Found(usize, Vec<Point>),
    /// No way inside the window, though a wider one may hold one.
    Walled,
    /// No way at all, or too much to look through.
    Unreachable,
}

/// What a flood from a search's goal found before the search spreads over the window.
enum Reach {
    /// A start, or more than a pocket: the search is worth running.
    Open,
    /// A pocket without a start that reaches the window's edge: a wider window may join them.
    Apart,
    /// A pocket without a start, walled in inside the window.
    Enclosed,
}

/// A state waiting in a search: its estimated total cost, its cost so far, and the state, a crossing
/// and the axis of the step that reached it.
#[derive(Clone, Copy)]
struct Step {
    estimate: f64,
    cost: f64,
    state: u32,
}

impl Ord for Step {
    // The heap pops its greatest: the least estimate, then the farthest along, then the first state.
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

/// A free stretch of a line among a search's obstacles: the line's place across, and where the
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
    /// Its place in the search's columns.
    place: u32,
}

/// Searches for orthogonal paths around obstacles over a sparse visibility graph: the free spans of
/// the lines through the obstacles' corners, the path's two ends, and the window's edges, which meet
/// where they cross. Its scratch is shared by every search, grown and never shrunk.
struct Search {
    /// What a bend costs, in length.
    bend: f64,
    /// How far a window reaches past what it frames.
    margin: f64,
    /// The graph's vertices: horizontal span by span, each from left to right.
    crossings: Vec<Crossing>,
    /// The crossings of each vertical span from bottom to top, span after span.
    columns: Vec<u32>,
    /// Where each vertical span's crossings start in `columns`, then where the last ends.
    starts: Vec<u32>,
    /// The cheapest cost found to each state: a crossing, and the axis of the step that reached it.
    costs: Vec<f64>,
    /// The state each state was reached from.
    came: Vec<u32>,
    heap: BinaryHeap<Step>,
    /// Which crossings a flood has reached, and the order it reached them in.
    seen: Vec<bool>,
    queue: Vec<usize>,
}

impl Search {
    /// A search whose bends cost, and whose windows reach, `reach`.
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

    /// The cheapest orthogonal path for `leg` around the obstacles grown by `by`, from whichever start
    /// is cheapest, in a window framing the leg and the boxes `around`. The window widens over
    /// obstacles that wall it in. `None` when the leg's end or every start is inside an obstacle, or no
    /// way is found.
    fn path(&mut self, obstacles: &Obstacles, leg: &Leg, around: &[Rect], by: f64) -> Option<(usize, Vec<Point>)> {
        let frame = around.iter().fold(dot(leg.to), |frame, owner| union(frame, *owner));
        let frame = leg.from.iter().fold(frame, |frame, &(start, _)| union(frame, dot(start)));
        let mut window = grow(frame, self.margin);
        for _ in 0..=WIDENINGS {
            let boxes = obstacles.query(grow(window, by), by);
            let free = |point: Point| !boxes.iter().any(|obstacle| inside(point, obstacle));
            if !free(leg.to) || !leg.from.iter().any(|&(start, _)| free(start)) {
                return None;
            }
            match self.graph(&boxes, window, leg) {
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

    /// Builds the window's visibility graph through `ends` among `boxes`, the grown obstacles that
    /// meet it; false when it holds too many crossings to search.
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
        // Each vertical span's crossings, which come bottom to top as the rows do.
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

    /// A* over the window's visibility graph for `leg` among `boxes`, the grown obstacles that meet
    /// it: each state a crossing and the axis of the step that reached it.
    fn graph(&mut self, boxes: &[Rect], window: Rect, leg: &Leg) -> Outcome {
        let ends: Vec<Point> = leg.from.iter().map(|&(start, _)| start).chain([leg.to]).collect();
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
            // A start's first step leaves by any way but its banned one.
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
                let value = cost + manhattan(crossing.point, point) + turn;
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
        // A start walled in short of the window's edge stays walled in however wide the window.
        if edge { Outcome::Walled } else { Outcome::Unreachable }
    }

    /// The least a path can cost from `point`, reached along `axis` (`None` at a start, whose first
    /// step turns for free), to `to`: its length, and a bend for the turn it still needs.
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

    /// Floods the graph from `goal` for a pocket's worth of crossings, to fail fast where the goal is
    /// walled in apart from every start.
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

    /// The path that reached state `goal`, from the start.
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

/// The free spans of lines running along `along` (0: x, 1: y) within `window`, among `boxes`, the
/// grown obstacles that meet it: through each box's corners, or where its sides' lines enter the
/// window, through each of `ends`, and every span along the window's edges. Sorted by line, then
/// start.
fn spans(boxes: &[Rect], window: Rect, ends: &[Point], along: usize) -> Vec<Span> {
    let held = 1 - along;
    let (start, end) = (window[along], window[along + 2]);
    let (low, high) = (window[held], window[held + 2]);
    // A seed is a line and a point along it its span holds; NaN takes every span of the line.
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
    seeds.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    // A sweep across the lines: the boxes whose open stretch across holds the line, by start along.
    let mut order: Vec<usize> = (0..boxes.len()).collect();
    order.sort_by(|&a, &b| boxes[a][held].total_cmp(&boxes[b][held]).then(a.cmp(&b)));
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
        // The stretches of the line inside an obstacle, merged where they meet.
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
    spans.sort_by(|a, b| a.line.total_cmp(&b.line).then(a.lo.total_cmp(&b.lo)));
    spans.dedup();
    spans
}

/// The obstacles routing avoids, with an index over them.
struct Obstacles<'a> {
    boxes: &'a [Rect],
    index: Index,
}

impl<'a> Obstacles<'a> {
    /// The obstacles `boxes`, indexed.
    fn new(boxes: &'a [Rect]) -> Obstacles<'a> {
        Obstacles { boxes, index: Index::new(boxes) }
    }

    /// The box of obstacle `owner`, when there is one.
    fn owned(&self, owner: Option<u32>) -> Option<Rect> {
        owner.and_then(|owner| self.boxes.get(owner as usize)).copied().filter(valid)
    }

    /// Visits the obstacles meeting `region`, each grown by `by`, until `visit` returns true; whether
    /// it did.
    fn some(&self, region: Rect, by: f64, mut visit: impl FnMut(Rect) -> bool) -> bool {
        self.index.some(region, &mut |item| visit(grow(self.boxes[item], by)))
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

    /// Whether the axis-aligned segment from `a` to `b` keeps out of every obstacle grown by `by`.
    fn clear(&self, a: Point, b: Point, by: f64) -> bool {
        let span = grow([a[0].min(b[0]), a[1].min(b[1]), a[0].max(b[0]), a[1].max(b[1])], by);
        !self.some(span, by, |obstacle| crosses(a, b, &obstacle))
    }
}

/// A packed R-tree over the valid boxes: leaves in Z-order of their middles, [`NODE`] children a
/// node.
struct Index {
    /// The box at each leaf.
    items: Vec<usize>,
    /// Each node's box: the leaves, then each level up to the root.
    nodes: Vec<Rect>,
    /// Where each level's nodes start, leaves first; the last is the node count.
    starts: Vec<usize>,
}

impl Index {
    /// An index over `boxes`, leaving out those that are not [`valid`].
    fn new(boxes: &[Rect]) -> Index {
        let mut items: Vec<usize> = (0..boxes.len()).filter(|&item| valid(&boxes[item])).collect();
        let extent = items.iter().fold(EMPTY, |extent, &item| union(extent, boxes[item]));
        let cell =
            |v: f64, lo: f64, hi: f64| if hi > lo { ((v - lo) / (hi - lo) * f64::from(u16::MAX)) as u32 } else { 0 };
        items.sort_by_cached_key(|&item| {
            let middle = [boxes[item][0].midpoint(boxes[item][2]), boxes[item][1].midpoint(boxes[item][3])];
            (morton(cell(middle[0], extent[0], extent[2]), cell(middle[1], extent[1], extent[3])), item)
        });
        let mut nodes: Vec<Rect> = items.iter().map(|&item| boxes[item]).collect();
        let mut starts = vec![0];
        let mut level = 0;
        loop {
            let next = nodes.len();
            starts.push(next);
            for first in (level..next).step_by(NODE) {
                let node = nodes[first..(first + NODE).min(next)].iter().fold(EMPTY, |node, child| union(node, *child));
                nodes.push(node);
            }
            if nodes.len() - next <= 1 {
                break;
            }
            level = next;
        }
        starts.push(nodes.len());
        Index { items, nodes, starts }
    }

    /// Visits the boxes meeting `region` until `visit` returns true; whether it did.
    fn some(&self, region: Rect, visit: &mut impl FnMut(usize) -> bool) -> bool {
        let top = self.starts.len() - 2;
        !self.items.is_empty()
            && meets(&self.nodes[self.starts[top]], &region)
            && self.descend(top, self.starts[top], region, visit)
    }

    /// [`Index::some`] below `node` of `level`.
    fn descend(&self, level: usize, node: usize, region: Rect, visit: &mut impl FnMut(usize) -> bool) -> bool {
        let first = self.starts[level - 1] + (node - self.starts[level]) * NODE;
        let last = (first + NODE).min(self.starts[level]);
        (first..last).any(|child| {
            meets(&self.nodes[child], &region)
                && if level > 1 { self.descend(level - 1, child, region, visit) } else { visit(self.items[child]) }
        })
    }
}

/// Position along a Z-order curve on a 65536² grid.
fn morton(x: u32, y: u32) -> u32 {
    let spread = |v: u32| {
        let v = v & 0xffff;
        let v = (v | (v << 8)) & 0x00ff_00ff;
        let v = (v | (v << 4)) & 0x0f0f_0f0f;
        let v = (v | (v << 2)) & 0x3333_3333;
        (v | (v << 1)) & 0x5555_5555
    };
    spread(x) | (spread(y) << 1)
}

/// Whether a box is finite and not inverted.
fn valid(r: &Rect) -> bool {
    r.iter().all(|v| v.is_finite()) && r[0] <= r[2] && r[1] <= r[3]
}

/// The box holding both.
fn union(a: Rect, b: Rect) -> Rect {
    [a[0].min(b[0]), a[1].min(b[1]), a[2].max(b[2]), a[3].max(b[3])]
}

/// A box grown by `by` on every side.
fn grow(r: Rect, by: f64) -> Rect {
    [r[0] - by, r[1] - by, r[2] + by, r[3] + by]
}

/// The box holding only `p`.
fn dot(p: Point) -> Rect {
    [p[0], p[1], p[0], p[1]]
}

/// Whether two boxes meet, touching included.
fn meets(a: &Rect, b: &Rect) -> bool {
    a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

/// Whether box `a` lies within box `b`.
fn within(a: &Rect, b: &Rect) -> bool {
    a[0] >= b[0] && a[1] >= b[1] && a[2] <= b[2] && a[3] <= b[3]
}

/// Whether a point is on a box's edge.
fn on_edge(p: Point, r: &Rect) -> bool {
    p[0] == r[0] || p[0] == r[2] || p[1] == r[1] || p[1] == r[3]
}

/// Whether a point is strictly inside a box.
fn inside(p: Point, r: &Rect) -> bool {
    p[0] > r[0] + EPSILON && p[0] < r[2] - EPSILON && p[1] > r[1] + EPSILON && p[1] < r[3] - EPSILON
}

/// Whether the axis-aligned segment from `a` to `b` passes through a box's interior.
fn crosses(a: Point, b: Point, r: &Rect) -> bool {
    // A vertical segment holds its x and runs along y; a horizontal one holds its y.
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

/// The length of an orthogonal path between two points.
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

/// The axis signs of the way from one point to another.
fn direction(from: Point, to: Point) -> Point {
    [sign(to[0] - from[0]), sign(to[1] - from[1])]
}

/// A path's points without repeats or in-line middles.
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
    /// The joints it carries.
    joints: Vec<usize>,
    /// The line's coordinate on the axis tracks move it along.
    line: f64,
    /// Where it starts and ends along the line.
    along: [f64; 2],
    /// Where its ends turn: below zero toward lower lines, above toward higher.
    turn: f64,
    /// The lines tracks may move it between; one line for a run holding a terminal.
    limits: [f64; 2],
}

impl Run {
    /// Whether it holds a terminal, so no track moves it.
    fn held(&self) -> bool {
        self.limits[0] == self.limits[1]
    }
}

/// Every net's runs on lines across `axis`: maximal chains of segments along one line through
/// joints. A stub's end keeps `least` off its terminal.
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

    /// The point next to the terminal at `at` on its wire: the way the wire leaves it.
    fn leaving(wire: &[Vec<Point>], at: Point) -> Point {
        wire.iter()
            .find_map(|line| match line[..] {
                [first, next, ..] if first == at => Some(next),
                [.., next, last] if last == at => Some(next),
                _ => None,
            })
            .expect("the wire ends at the terminal")
    }

    /// Whether the polylines make one tree reaching every terminal: each starts at the first terminal
    /// or where another ends.
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
        assert_eq!(route(&boxes, &nets, &[], SPACING), vec![vec![vec![[20.0, 10.0], [100.0, 10.0]]]]);
    }

    #[test]
    fn a_wire_bends_around_an_obstacle_between() {
        let boxes = [[0.0, 0.0, 20.0, 20.0], [200.0, 0.0, 220.0, 20.0], [80.0, -30.0, 140.0, 50.0]];
        let nets = [Net { terminals: vec![on([20.0, 10.0], Side::Right, 0), on([200.0, 10.0], Side::Left, 1)] }];
        let wire = &route(&boxes, &nets, &[], SPACING)[0];
        assert!(orthogonal(wire), "{wire:?}");
        assert!(segments(wire).len() > 2, "it bends: {wire:?}");
        assert!(outside(wire, &boxes), "{wire:?}");
        assert!(one_tree(wire, &nets[0].terminals), "{wire:?}");
    }

    #[test]
    fn a_wall_too_long_for_the_window_is_gone_around() {
        let boxes = [
            [0.0, 0.0, 20.0, 20.0],
            [200.0, 0.0, 220.0, 20.0],
            [80.0, -100.0, 100.0, 120.0],
            [100.0, -400.0, 120.0, 90.0],
        ];
        let nets = [Net { terminals: vec![on([20.0, 10.0], Side::Right, 0), on([200.0, 10.0], Side::Left, 1)] }];
        let wire = &route(&boxes, &nets, &[], SPACING)[0];
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
        let routes = route(&boxes, &nets, &[], SPACING);
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
        let wire = &route(&boxes, std::slice::from_ref(&net), &[], SPACING)[0];
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
        let routes = route(&boxes, &nets, &[], SPACING);
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
        let wire = &route(&boxes, &nets, &[], SPACING)[0];
        assert!(orthogonal(wire) && one_tree(wire, &nets[0].terminals), "{wire:?}");
    }

    #[test]
    fn a_crowded_grid_routes_alike_every_time() {
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
        let routes = route(&boxes, &nets, &[], SPACING);
        assert_eq!(routes, route(&boxes, &nets, &[], SPACING), "the same input routes the same");
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
    fn nets_without_two_terminals_get_nothing() {
        let free = Terminal { at: [0.0, 0.0], side: None, owner: None };
        let nets = [
            Net::default(),
            Net { terminals: vec![free] },
            Net { terminals: vec![free, Terminal { at: [f64::NAN, 0.0], ..free }] },
        ];
        assert_eq!(route(&[], &nets, &[], SPACING), vec![Vec::<Vec<Point>>::new(); 3]);
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
        let wire = &route(&boxes, &nets, &[], SPACING)[0];
        assert!(orthogonal(wire) && outside(wire, &boxes), "{wire:?}");
        assert_eq!(leaving(wire, [20.0, 10.0])[1], 10.0, "it leaves by the side it is on: {wire:?}");
    }
}
