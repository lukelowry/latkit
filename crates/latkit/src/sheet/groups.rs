//! A diagram's groups. A group's box surrounds its members, padded, with its title band across the
//! top; a group with no placed members is centered at its own place. Each group keeps its members'
//! boxes indexed, so an edit refits only the groups above the vertices it moved.

use std::cmp::Reverse;
use std::collections::BTreeSet;

use rustc_hash::FxHashMap;

use super::Vertex;
use crate::data::Row;
use crate::layout::boxes::Boxes;
use crate::layout::rect::{EMPTY, Rect, around, valid};

/// Every group of a diagram with its members' boxes, and the groups' boxes for wire routing.
#[derive(Default)]
pub(crate) struct Groups {
    /// Each group's vertex index and its members' boxes, y down, by member.
    members: Vec<(usize, Boxes)>,
    /// Each vertex's group, as an index into `members`, and its place among that group's members.
    member: Vec<Option<(usize, usize)>>,
    /// Each vertex's index into `members`, where it is a group.
    index: Vec<Option<usize>>,
    /// The groups' boxes, y up, by index: wires cross them at a cost and keep off their borders.
    boxes: Boxes,
}

/// What a group's box needs besides its members: each vertex mark's title band height, the padding
/// around members, and the places layouts gave rows without positions.
pub(crate) struct Framing<'a> {
    pub(crate) header: &'a [f64],
    pub(crate) padding: f64,
    pub(crate) places: &'a FxHashMap<Row, [f64; 2]>,
}

impl Groups {
    /// The groups of `vertices`, each placed around its members, innermost first.
    pub(crate) fn new(vertices: &mut [Vertex], framing: &Framing<'_>) -> Groups {
        let mut index = vec![None; vertices.len()];
        let mut members: Vec<(usize, Vec<usize>)> = Vec::new();
        for v in (0..vertices.len()).filter(|&v| vertices[v].group) {
            index[v] = Some(members.len());
            members.push((v, Vec::new()));
        }
        let mut member = vec![None; vertices.len()];
        for v in 0..vertices.len() {
            if let Some(g) = vertices[v].parent.and_then(|p| index[p]) {
                member[v] = Some((g, members[g].1.len()));
                members[g].1.push(v);
            }
        }
        let mut order: Vec<usize> = (0..members.len()).collect();
        crate::order::by_key(&mut order, |&g| !u64::from(vertices[members[g].0].depth));
        let mut groups: Vec<Option<(usize, Boxes)>> = (0..members.len()).map(|_| None).collect();
        for g in order {
            let v = members[g].0;
            let held = Boxes::new(members[g].1.iter().map(|&m| vertices[m].bounds.unwrap_or(EMPTY)).collect());
            vertices[v].bounds = stand(&vertices[v], held.extent(), framing);
            groups[g] = Some((v, held));
        }
        let groups: Vec<(usize, Boxes)> = groups.into_iter().map(|g| g.expect("every group is placed")).collect();
        let boxes = Boxes::new(groups.iter().map(|&(v, _)| up(vertices[v].bounds)).collect());
        Groups { members: groups, member, index, boxes }
    }

    /// Refits the groups above vertices `touched`, which an edit resized or moved. Each group
    /// holding one is refit from its members, deepest first, continuing upward while a group's box
    /// changes. Returns the groups whose boxes changed.
    pub(crate) fn refit(&mut self, vertices: &mut [Vertex], touched: &[usize], framing: &Framing<'_>) -> Vec<usize> {
        let mut due: BTreeSet<(Reverse<u32>, usize)> = BTreeSet::new();
        for &v in touched {
            if let Some((g, place)) = self.member[v] {
                self.members[g].1.set(place, vertices[v].bounds.unwrap_or(EMPTY));
                let group = self.members[g].0;
                due.insert((Reverse(vertices[group].depth), group));
            }
            if vertices[v].group {
                due.insert((Reverse(vertices[v].depth), v));
            }
        }
        let mut changed = Vec::new();
        while let Some((_, v)) = due.pop_first() {
            let g = self.index[v].expect("a group");
            let bounds = stand(&vertices[v], self.members[g].1.extent(), framing);
            if bounds == vertices[v].bounds {
                continue;
            }
            vertices[v].bounds = bounds;
            self.boxes.set(g, up(bounds));
            changed.push(v);
            if let Some((parent, place)) = self.member[v] {
                self.members[parent].1.set(place, bounds.unwrap_or(EMPTY));
                let group = self.members[parent].0;
                due.insert((Reverse(vertices[group].depth), group));
            }
        }
        changed
    }

    /// Every group's box, y up, `EMPTY` where it has none.
    pub(crate) fn boxes(&self) -> &[Rect] {
        self.boxes.all()
    }

    /// The box around every group, y up.
    pub(crate) fn extent(&self) -> Rect {
        self.boxes.extent()
    }
}

/// Group `group`'s box around `held`, its members' extent, y down; at its own place when `held` is
/// empty. `None` when it has neither.
fn stand(group: &Vertex, held: Rect, framing: &Framing<'_>) -> Option<Rect> {
    if valid(&held) {
        let (top, padding) = (framing.header[group.mark], framing.padding);
        return Some([held[0] - padding, held[1] - padding - top, held[2] + padding, held[3] + padding]);
    }
    let center = group.pin.or_else(|| framing.places.get(&group.key).copied());
    center.map(|c| around(c, group.half))
}

/// A y-down box flipped to y up for routing; `EMPTY` for none.
fn up(bounds: Option<Rect>) -> Rect {
    bounds.map_or(EMPTY, |b| [b[0], -b[3], b[2], -b[1]])
}
