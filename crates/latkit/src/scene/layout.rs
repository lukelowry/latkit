/// How vertices without positions are placed.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub enum Layout {
    /// Unplaced vertices are not drawn.
    #[default]
    None,
    /// Distances on the drawing follow distances in the graph.
    Stress(Stress),
    /// Ranks along a direction, for flows and hierarchies.
    Layered(Layered),
}

/// Stress majorization: each pair of vertices pulls toward its graph distance.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Stress {
    /// Units between adjacent vertices.
    pub gap: f64,
}

impl Default for Stress {
    fn default() -> Stress {
        Stress { gap: 40.0 }
    }
}

/// Layered drawing: vertices in ranks, edges pointing along `flow`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Layered {
    /// Where edges point.
    pub flow: Direction,
    /// Units between vertices of a rank.
    pub gap: f64,
    /// Units between ranks.
    pub rank_gap: f64,
}

impl Default for Layered {
    fn default() -> Layered {
        Layered { flow: Direction::Right, gap: 30.0, rank_gap: 80.0 }
    }
}

/// How an edge runs between its ends.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    /// Straight across the screen.
    Straight,
    /// Along the great circle, on the earth.
    Geodesic,
    /// In horizontal and vertical runs around vertices, leaving and entering at their sides.
    Orthogonal,
}

/// How a line runs between its samples.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Interpolation {
    /// Straight from each sample to the next.
    #[default]
    Linear,
    /// Each value holds from the sample before it: steps rise at their samples' ends.
    StepBefore,
    /// Each value holds until the next sample: steps rise at the next sample.
    StepAfter,
}

/// A direction on screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Direction {
    /// Toward the right.
    #[default]
    Right,
    /// Toward the left.
    Left,
    /// Toward the bottom.
    Down,
    /// Toward the top.
    Up,
}

impl From<Stress> for Layout {
    fn from(stress: Stress) -> Layout {
        Layout::Stress(stress)
    }
}

impl From<Layered> for Layout {
    fn from(layered: Layered) -> Layout {
        Layout::Layered(layered)
    }
}
