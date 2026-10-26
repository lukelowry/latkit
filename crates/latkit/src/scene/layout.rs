use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Presets, preset_or, presets};

/// How the view places vertex rows that have no position: a name, or
/// `{ stress | layered: options }`. In a diagram it places blocks; on a plane or the earth it
/// places points among the rows they link to. Gaps are in position units: diagram units, plane
/// units, or degrees on the earth.
///
/// A row keeps its place once placed: rows added later are placed around the others, and
/// [`View::arrange`](crate::View::arrange) lays out every row again.
#[derive(Clone, Copy, PartialEq, Debug, Default, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = presets::<Layout>)]
pub enum Layout {
    /// No layout: vertices without a position are not drawn. The default.
    #[default]
    None,
    /// Drawn distances follow graph distances.
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

/// Stress majorization: vertices move until drawn distances match graph distances, then overlapping
/// boxes separate, keeping a quarter of `gap` between them.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Stress {
    /// Distance between the centers of linked vertices, in position units. Default 40.
    #[schemars(range(min = 0))]
    pub gap: f64,
}

impl Default for Stress {
    fn default() -> Stress {
        Stress { gap: 40.0 }
    }
}

/// Layered drawing: vertices in ranks, edges pointing along `flow`, and nets ranked from their
/// outputs.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Layered {
    /// The direction edges point; `right` by default.
    pub flow: Direction,
    /// Distance between vertices within a rank, in position units. Default 30.
    pub gap: f64,
    /// Distance between ranks, in position units. Default 80.
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
    /// A straight line on screen.
    Straight,
    /// Along the great circle, on the earth.
    Geodesic,
    /// Horizontal and vertical runs around vertices that leave and enter at their sides, with
    /// rounded bends. Diagrams only.
    Orthogonal,
}

/// How a line runs between its samples.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Interpolation {
    /// Straight from each sample to the next.
    #[default]
    Linear,
    /// Each value holds from the previous sample up to its own, so the line steps at the previous
    /// sample.
    StepBefore,
    /// Each value holds until the next sample, where the line steps.
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
