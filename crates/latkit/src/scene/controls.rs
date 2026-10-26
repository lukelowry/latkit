use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Presets, preset_or, presets, seconds};

/// How a view responds to the pointer and keyboard, and how much it animates on its own: a preset
/// (`"none"` or `"inspect"`), or options over the defaults. Each mark controls whether its own rows
/// pick, select, and drag; these options control the view itself.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", default, rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = presets::<Controls>)]
pub struct Controls {
    /// Whether dragging the background pans the camera. Default `true`.
    pub pan: bool,
    /// Which input zooms the view: the wheel and pinching (`wheel`, the default); pinching, and the
    /// wheel only with Control or Meta held, as trackpad pinches send it, so the plain wheel
    /// scrolls the page (`modifier`); or nothing (`off`).
    pub zoom: Zoom,
    /// Whether dragging with the secondary button, or with Shift, rotates and tilts a map or plane.
    /// Default `true`.
    pub turn: bool,
    /// Whether the keyboard controls the view. Default `true`. Tab and Shift+Tab step through the
    /// rows nearest the view's center, and arrow keys step to the nearest row in their direction.
    /// Enter opens the stepped-to row and Space selects it. With no row stepped to, arrow keys pan
    /// (Shift+arrows turn), `+` and `-` zoom, Home fits everything, and Escape clears the
    /// selection.
    pub keyboard: bool,
    /// Whether the hovered row glows, and a hovered vertex sized in CSS pixels grows. Default
    /// `true`. Rows are hovered either way: [`Event::Hovered`](crate::Event) still fires and
    /// `hovered()` still reads them.
    pub hover: bool,
    /// How far from the pointer, in CSS pixels, a row can be and still be picked; touch adds 8.
    /// Default 6.
    pub pick_radius: f32,
    /// Whether Shift+drag selects the rows inside a box instead of turning the camera. Shift+click
    /// still toggles one row. Default `false`.
    pub select_box: bool,
    /// Whether the user can draw connections, reported as [`Event::Connect`](crate::Event): by
    /// dragging from a port, from a vertex with Alt held, or an edge's end off its vertex. Default
    /// `false`.
    pub connect: bool,
    /// Whether Delete and Backspace report the selection as [`Event::Delete`](crate::Event).
    /// Default `false`.
    pub delete: bool,
    /// Whether clicking again at the same point, with the camera unmoved, selects the next row
    /// under it, nearest first, so overlapping rows can each be selected. Default `false`.
    pub cycle: bool,
    /// Seconds a touch or pen must hold still to request a menu ([`Event::Menu`](crate::Event)),
    /// as the secondary button does; 0 turns this off. Default 0.5.
    #[serde(deserialize_with = "seconds")]
    #[schemars(with = "f64")]
    pub press: Duration,
    /// How much the view animates on its own: eases, camera flights, coasting, orbits, label fades,
    /// comets, and options that read `elapsed()`. `system` (the default) follows the user's
    /// reduced-motion setting, `full` animates everything, and `reduced` animates only motion the
    /// user drives.
    pub motion: Motion,
}

/// Which input zooms a view.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Zoom {
    /// The wheel, pinching, and the keys.
    #[default]
    Wheel,
    /// Pinching and the keys, and the wheel only with Control or Meta held (as trackpad pinches
    /// send it), so the plain wheel scrolls the page.
    Modifier,
    /// No input zooms.
    Off,
}

/// How much a view animates on its own.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Motion {
    /// Follows the system: reduced when the user asked their system for less motion.
    #[default]
    System,
    /// All motion.
    Full,
    /// Only motion the user drives: changes apply at once, flights jump, nothing coasts or orbits,
    /// labels appear without fading, and comets and options that read `elapsed()` stay still.
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
    /// Controls for a still picture: no panning, zooming, turning, keyboard, hover glow, or press
    /// menus, so only the application moves the camera. Marks that select still select on click.
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

    /// Controls for inspecting rows: rows glow under the pointer, select on click, and step with
    /// the keys, while the camera moves only when the application moves it.
    pub fn inspect() -> Controls {
        Controls { pan: false, zoom: Zoom::Off, turn: false, ..Controls::default() }
    }
}
