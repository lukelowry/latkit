use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Presets, preset_or, presets};

/// How the view places vertex rows without positions: a diagram's blocks, sized, or the points of a
/// plane or the earth, among the rows linked to them, gaps in the space's units: a name, or `{ stress
/// | layered: options }`. A place, once given, holds: rows added later are placed around the rest,
/// and [`View::arrange`](crate::View::arrange) lays every row out again.
#[derive(Clone, Copy, PartialEq, Debug, Default, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = presets::<Layout>)]
pub enum Layout {
    /// Unplaced vertices are not drawn.
    #[default]
    None,
    /// Distances on the drawing follow distances in the graph.
    Stress(Stress),
    /// Ranks along a direction, for flows and hierarchies.
    Layered(Layered),
}

impl Presets for Layout {
    const NAMES: &'static [&'static str] = &["none", "stress", "layered"];

    fn preset(name: &str) -> Option<Layout> {
        match name {
            "none" => Some(Layout::None),
            "stress" => Some(Layout::Stress(Stress::default())),
            "layered" => Some(Layout::Layered(Layered::default())),
            _ => None,
        }
    }

    fn options<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Layout, D::Error> {
        Layout::deserialize(deserializer)
    }
}

impl<'de> Deserialize<'de> for Layout {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Layout, D::Error> {
        preset_or(deserializer)
    }
}

/// Stress majorization: each pair of vertices pulls toward its graph distance; then their boxes
/// part, keeping a quarter of the gap clear.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Stress {
    /// Units between adjacent vertices' centers.
    #[schemars(range(min = 0))]
    pub gap: f64,
}

impl Default for Stress {
    fn default() -> Stress {
        Stress { gap: 40.0 }
    }
}

/// Layered drawing: vertices in ranks, edges pointing along `flow`, and nets from their outputs.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
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
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    /// Straight across the screen.
    Straight,
    /// Along the great circle, on the earth.
    Geodesic,
    /// In horizontal and vertical runs around vertices, leaving and entering at their sides, bends
    /// rounded. Diagrams only.
    Orthogonal,
}

/// How a line runs between its samples.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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
