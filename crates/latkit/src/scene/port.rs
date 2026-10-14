use super::Shape;
use crate::gpu::shaders as wgsl;

/// A vertex's port: where a net its reference field names meets it, on one side of its marker. An
/// output drives its net: layouts rank a net from its outputs, and its arrows point away from them.
///
/// ```
/// # use latkit::{Port, Side, Vertices};
/// let pumps = Vertices::of("plant", "Pump").port("in", Side::Left).port("out", Port::output(Side::Right));
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Port {
    /// The side it sits on.
    pub side: Side,
    /// Its place among the ports on that side, from the top or the left; in declaration order unless set.
    pub order: Option<u32>,
    /// Its name, drawn beside it inside the marker.
    pub label: Option<String>,
    /// Its marker.
    pub shape: Shape,
    /// Whether it drives the net its reference field names.
    pub output: bool,
}

/// A side of a marker.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
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

    /// This port, labeled `label`.
    #[must_use]
    pub fn label(mut self, label: impl Into<String>) -> Port {
        self.label = Some(label.into());
        self
    }

    /// Each of `ports`' codes: its side in two bits, its place among the ports on its side (by their
    /// order, then as declared) and how many share the side in eight bits each, and whether it is an
    /// output.
    pub(crate) fn codes(ports: &[&Port]) -> Vec<u32> {
        (0..ports.len())
            .map(|i| {
                let port = ports[i];
                let mut same: Vec<usize> = (0..ports.len()).filter(|&j| ports[j].side == port.side).collect();
                same.sort_by_key(|&j| (ports[j].order.unwrap_or(u32::MAX), j));
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

impl Side {
    pub(crate) fn code(self) -> u32 {
        match self {
            Side::Left => 0,
            Side::Right => 1,
            Side::Top => 2,
            Side::Bottom => 3,
        }
    }

    /// The side of `code`, or `None` for any other number.
    pub(crate) fn from_code(code: u32) -> Option<Side> {
        [Side::Left, Side::Right, Side::Top, Side::Bottom].get(code as usize).copied()
    }
}
