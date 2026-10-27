use schemars::JsonSchema;
use serde::Deserialize;

use super::Shape;
use super::form::{preset_schema, presets};
use crate::gpu::shaders as wgsl;

/// A port on one side of a vertex's marker, where a net connects: a side name, or options. The
/// vertex names the net in a reference field. An output drives its net: layouts rank a net from its
/// outputs, and the net's arrows point away from them.
///
/// ```
/// # use latkit::{Port, Side, Vertices};
/// let pumps = Vertices::of("plant", "Pump").port("in", Side::Left).port("out", Port::output(Side::Right));
/// ```
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = preset_schema::<Port>)]
pub struct Port {
    /// The side of the marker it sits on.
    pub side: Side,
    /// Its position among the ports on its side, counted from the top or left. Ports without an
    /// `order` follow those with one, in declaration order.
    #[serde(default)]
    pub order: Option<u32>,
    /// Its name, drawn beside it inside the marker.
    #[serde(default)]
    pub label: Option<String>,
    /// Its shape. Defaults to an ellipse.
    #[serde(default)]
    pub shape: Shape,
    /// Whether it is an output, which drives its net. Defaults to `false` (an input).
    #[serde(default)]
    pub output: bool,
}

presets!(Port {
    "left" => Port::new(Side::Left),
    "right" => Port::new(Side::Right),
    "top" => Port::new(Side::Top),
    "bottom" => Port::new(Side::Bottom),
});

/// A side of a marker.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    /// The left side.
    Left,
    /// The right side.
    Right,
    /// The top.
    Top,
    /// The bottom.
    Bottom,
}

impl Port {
    /// A round input on `side`.
    pub fn new(side: Side) -> Port {
        Port { side, order: None, label: None, shape: Shape::Ellipse, output: false }
    }

    /// A round output on `side`.
    pub fn output(side: Side) -> Port {
        Port { output: true, ..Port::new(side) }
    }

    /// Sets the port's label.
    #[must_use]
    pub fn label(mut self, label: impl Into<String>) -> Port {
        self.label = Some(label.into());
        self
    }

    /// Each port of `ports` packed into a code: its side in bits 0–1, its place among the ports on
    /// that side (by `order`, then declaration order) in bits 2–9, the number of ports on that side
    /// in bits 10–17, and the `PORT_OUTPUT` bit for an output.
    pub(crate) fn codes(ports: &[&Port]) -> Vec<u32> {
        (0..ports.len())
            .map(|i| {
                let port = ports[i];
                let mut same: Vec<usize> = (0..ports.len()).filter(|&j| ports[j].side == port.side).collect();
                crate::order::by_key(&mut same, |&j| crate::order::pair(ports[j].order.unwrap_or(u32::MAX), j as u32));
                let place = same.iter().position(|&j| j == i).unwrap_or(0) as u32;
                let output = if port.output { wgsl::PORT_OUTPUT } else { 0 };
                port.side.code() | (place.min(255) << 2) | ((same.len() as u32).min(255) << 10) | output
            })
            .collect()
    }
}

impl From<Side> for Port {
    fn from(side: Side) -> Port {
        Port::new(side)
    }
}

crate::wire::codes!(Side { Left = 0, Right = 1, Top = 2, Bottom = 3 });
