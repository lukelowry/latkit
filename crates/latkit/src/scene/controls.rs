use std::time::Duration;

use schemars::JsonSchema;
use serde::Deserialize;

use super::form::{preset_schema, presets, seconds};

/// How a view responds to the pointer and keyboard, and how much it animates on its own: a preset
/// (`"none"` or `"inspect"`), or options that change the defaults. Each mark sets whether its own
/// rows pick, select, and drag. These options control the view itself.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", default, rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = preset_schema::<Controls>)]
pub struct Controls {
    /// Whether dragging the background pans the camera. Defaults to `true`.
    pub pan: bool,
    /// Which input zooms the view. `wheel` zooms with the wheel and pinching. `modifier` zooms with
    /// pinching, and with the wheel only while Control or Meta is held (as trackpad pinches send
    /// it), so the plain wheel scrolls the page. `off` turns zooming off. Defaults to `wheel`.
    pub zoom: Zoom,
    /// Whether dragging with the secondary button, or with Shift, rotates and tilts a map or plane.
    /// Defaults to `true`.
    pub turn: bool,
    /// Whether the keyboard controls the view. Defaults to `true`. Tab steps to the row nearest the
    /// view's center, and the next Tab or Shift+Tab leaves the view, so it is one stop in the
    /// page's tab order. Arrow keys step to the nearest row in their direction. Enter opens the row
    /// stepped to, Space selects it, and Escape stops stepping. With no row stepped to, arrow keys
    /// pan (Shift+arrows turn), `+` and `-` zoom, Home fits everything, and Escape clears the
    /// selection.
    pub keyboard: bool,
    /// Whether the hovered row glows and a hovered vertex sized in CSS pixels grows. Defaults to
    /// `true`. Hover is tracked either way: [`Event::Hovered`](crate::Event) still fires and
    /// `hovered()` still returns the row.
    pub hover: bool,
    /// How far a row can be from the pointer and still be picked, in CSS pixels. Touch adds 8.
    /// Defaults to 6.
    pub pick_radius: f32,
    /// Whether Shift+drag selects the rows inside a box instead of turning the camera. Shift+click
    /// still toggles one row. Defaults to `false`.
    pub select_box: bool,
    /// Whether the user can draw connections by dragging from a port, from a vertex with Alt held,
    /// or an edge's end off its vertex. Connections are reported as
    /// [`Event::Connect`](crate::Event). Defaults to `false`.
    pub connect: bool,
    /// Whether Delete and Backspace report the selection as [`Event::Delete`](crate::Event).
    /// Defaults to `false`.
    pub delete: bool,
    /// Whether clicking again at the same point, with the camera unmoved, selects the next row
    /// under the pointer, nearest first. This lets overlapping rows each be selected. Defaults to
    /// `false`.
    pub cycle: bool,
    /// Whether clicking or dragging across a plot moves the coordinate shown to the pointer,
    /// instead of panning. Moves are reported as [`Event::At`](crate::Event). Defaults to `false`.
    pub scrub: bool,
    /// How many seconds a touch or pen must hold still to request a menu
    /// ([`Event::Menu`](crate::Event)), like the secondary button. 0 turns this off. Defaults to
    /// 0.5.
    #[serde(deserialize_with = "seconds")]
    #[schemars(with = "f64")]
    pub press: Duration,
    /// How much the view animates on its own: eases, camera flights, coasting, orbits, comets, and
    /// options that read `elapsed()`. `system` follows the user's reduced-motion setting, `full`
    /// animates everything, and `reduced` animates only motion the user drives. Defaults to
    /// `system`.
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
    /// Follows the system setting: reduced when the user has asked their system for less motion.
    #[default]
    System,
    /// All motion.
    Full,
    /// Only motion the user drives: changes apply at once, flights jump, nothing coasts or orbits,
    /// and comets and options that read `elapsed()` stay still.
    Reduced,
}

presets!(Controls { "none" => Controls::none(), "inspect" => Controls::inspect() });

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
            scrub: false,
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
    /// the keys. Only the application moves the camera.
    pub fn inspect() -> Controls {
        Controls { pan: false, zoom: Zoom::Off, turn: false, ..Controls::default() }
    }
}
