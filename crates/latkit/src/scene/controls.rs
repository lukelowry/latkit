use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Presets, preset_or, presets, seconds};

/// How a view answers the pointer and keyboard, and how much it moves on its own: a preset, or options
/// over the defaults. Each mark says whether its rows pick, select, and drag; these say what the view
/// itself does.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", default, rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = presets::<Controls>)]
pub struct Controls {
    /// Dragging the background moves the camera.
    pub pan: bool,
    /// What zooms: the wheel and pinching, or the wheel only with Control or Meta held (as a
    /// trackpad's pinch sends it), leaving the plain wheel to scroll the page; or nothing.
    pub zoom: Zoom,
    /// Dragging with the secondary button, or with Shift, turns and tilts a map or plane.
    pub turn: bool,
    /// Tab steps through the rows nearest the view's middle and arrows to the nearest row their way;
    /// Enter opens the row stepped to and Space selects it. Otherwise arrows pan, `+` and `-` zoom,
    /// Home fits, and Escape clears the selection.
    pub keyboard: bool,
    /// The row the user points at glows. It is hovered either way: events tell it.
    pub hover: bool,
    /// CSS pixels around the pointer that picks reach; touch reaches 8 more.
    pub pick_radius: f32,
    /// Dragging with Shift selects the rows in a box, instead of turning; a Shift click still toggles
    /// its row.
    pub select_box: bool,
    /// Dragging from a port, from a vertex with Alt, or an edge off its end draws a connection,
    /// told as [`Event::Connect`](crate::Event).
    pub connect: bool,
    /// Delete and Backspace tell [`Event::Delete`](crate::Event) with the selection.
    pub delete: bool,
    /// Clicking again where nothing moved selects the next row under the point, nearest first, so
    /// rows drawn over one another can each be selected.
    pub cycle: bool,
    /// Seconds a touch or a pen held still asks for a menu, as the secondary button does; zero never
    /// does.
    #[serde(deserialize_with = "seconds")]
    #[schemars(with = "f64")]
    pub press: Duration,
    /// How much the view moves on its own: eases, flights, coasting, orbits, label fades, comets, and
    /// what reads `elapsed()`.
    pub motion: Motion,
}

/// What zooms a view.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Zoom {
    /// The wheel, pinching, and the keys.
    #[default]
    Wheel,
    /// Pinching and the keys, and the wheel only with Control or Meta held, as a trackpad's pinch
    /// sends it: the plain wheel scrolls the page.
    Modifier,
    /// Nothing.
    Off,
}

/// How much a view moves on its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Motion {
    /// As the platform asks: reduced where the user asked their system for less motion.
    #[default]
    System,
    /// Every motion.
    Full,
    /// Only what the user moves: changes apply at once, flights jump, nothing coasts or orbits,
    /// labels show without fading, and comets and what reads `elapsed()` hold still.
    Reduced,
}

impl Presets for Controls {
    const NAMES: &'static [&'static str] = &["none", "inspect"];

    fn preset(name: &str) -> Option<Controls> {
        match name {
            "none" => Some(Controls::none()),
            "inspect" => Some(Controls::inspect()),
            _ => None,
        }
    }

    fn options<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Controls, D::Error> {
        Controls::deserialize(deserializer)
    }
}

impl<'de> Deserialize<'de> for Controls {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Controls, D::Error> {
        preset_or(deserializer)
    }
}

impl Default for Controls {
    fn default() -> Controls {
        Controls {
            pan: true,
            zoom: Zoom::Wheel,
            turn: true,
            keyboard: true,
            hover: true,
            pick_radius: 6.0,
            select_box: false,
            connect: false,
            delete: false,
            cycle: false,
            press: Duration::from_millis(500),
            motion: Motion::System,
        }
    }
}

impl Controls {
    /// A view that answers nothing: a still picture, its camera where the application puts it.
    pub fn none() -> Controls {
        Controls {
            pan: false,
            zoom: Zoom::Off,
            turn: false,
            keyboard: false,
            hover: false,
            press: Duration::ZERO,
            ..Controls::default()
        }
    }

    /// A view to inspect rows in: they glow under the pointer, select, and step with the keys, while
    /// the camera stays where the application puts it.
    pub fn inspect() -> Controls {
        Controls { pan: false, zoom: Zoom::Off, turn: false, ..Controls::default() }
    }
}
