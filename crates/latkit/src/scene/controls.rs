use std::fmt;
use std::time::Duration;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde::de::{self, Deserializer, MapAccess, Visitor};

use super::form::{preset_schema, presets, seconds};
use crate::{Error, Modifiers, Result};

/// How a view responds to the pointer and keyboard, and how much it animates on its own: a preset
/// (`"none"` or `"inspect"`), or options that change the defaults. Each mark sets whether its own
/// rows pick, select, and drag. These options control the view itself.
#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", default, rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = preset_schema::<Controls>)]
pub struct Controls {
    /// What each input does, as in `{ "shift+primary": "box", "wheel": "pan" }`. Each key names an
    /// input after any modifier keys held with it (`shift+`, `control+`, `alt+`, `meta+`), and each
    /// value is the [`Action`](crate::Action) it takes. Each key given replaces its default, and `none` turns the
    /// input off. An input held with modifier keys no key names takes the action of the input alone.
    ///
    /// The inputs are a drag with the `primary`, `secondary`, or `middle` button (a finger drags as
    /// `primary`), the `wheel`, and two fingers that `pinch` (spread or close), `twist` (turn about
    /// each other), or `slide` (move together). A drag can `pan`, `turn`, `tilt`, `box`, `zoomBox`,
    /// `scrub`, or `connect`. The wheel can `zoom`, `pan`, `turn`, or `tilt`. A pinch can `zoom`, a
    /// twist can `turn`, and a slide can `pan` or `tilt`.
    ///
    /// Defaults: `primary` and `middle` pan, `shift+primary` and `secondary` turn, `wheel` and
    /// `pinch` zoom, and `slide` pans. Whatever the input, a drag that starts on a row of a
    /// draggable mark drags the row, unless the input turns, tilts, or draws a box.
    pub gestures: Gestures,
    /// Whether the keyboard controls the view. Defaults to `true`. Tab steps to the row nearest the
    /// view's center, and the next Tab or Shift+Tab leaves the view, so it is one stop in the
    /// page's tab order. Arrow keys step to the nearest row in their direction. Enter opens the row
    /// stepped to, Space selects it, and Escape stops stepping. With no row stepped to, arrow keys
    /// pan (Shift+arrows turn), `+` and `-` zoom, Home fits everything, and Escape clears the
    /// selection. The keys pan, turn, and zoom only if some input in `gestures` does.
    pub keyboard: bool,
    /// Whether the hovered row glows and a hovered vertex sized in CSS pixels grows. Defaults to
    /// `true`. Hover is tracked either way: [`Event::Hovered`](crate::Event) still fires and
    /// `hovered()` still returns the row.
    pub hover: bool,
    /// How far a row can be from the pointer and still be picked, in CSS pixels. Touch adds 8.
    /// Defaults to 6.
    pub pick_radius: f32,
    /// Whether Delete and Backspace report the selection as [`Event::Delete`](crate::Event).
    /// Defaults to `false`.
    pub delete: bool,
    /// Whether clicking again at the same point, with the camera unmoved, selects the next row
    /// under the pointer, nearest first. This lets overlapping rows each be selected. Defaults to
    /// `false`.
    pub cycle: bool,
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

/// What an input does. See [`Controls::gestures`](crate::Controls).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    /// Moves the camera with the pointer.
    Pan,
    /// Turns a map or plane about the point pressed, and tilts it. Where the camera cannot turn, in
    /// a diagram or on a plot, it pans instead.
    Turn,
    /// Tilts a map or plane about the point pressed, keeping its bearing. Where the camera cannot
    /// turn, it pans instead.
    Tilt,
    /// Zooms about the pointer.
    Zoom,
    /// Selects the rows inside the box dragged, whatever lies under the press.
    Box,
    /// Zooms to frame the box dragged, whatever lies under the press.
    ZoomBox,
    /// On a plot, moves the axis coordinate shown with the pointer, reported as
    /// [`Event::At`](crate::Event), and a click there moves it too. Elsewhere it pans.
    Scrub,
    /// Draws a connection from the vertex or port pressed, or drags an edge's end off its vertex,
    /// reported as [`Event::Connect`](crate::Event). Once any input connects, a drag from a port or
    /// an edge's end connects whatever its input. Elsewhere it pans.
    Connect,
    /// Nothing.
    None,
}

impl Action {
    /// Its name in JSON.
    fn name(self) -> &'static str {
        match self {
            Action::Pan => "pan",
            Action::Turn => "turn",
            Action::Tilt => "tilt",
            Action::Zoom => "zoom",
            Action::Box => "box",
            Action::ZoomBox => "zoomBox",
            Action::Scrub => "scrub",
            Action::Connect => "connect",
            Action::None => "none",
        }
    }
}

/// What starts a gesture: a button dragged, the wheel, or two fingers.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Control {
    Primary,
    Secondary,
    Middle,
    Wheel,
    Pinch,
    Twist,
    Slide,
}

/// Each source with its name in a gesture's key.
const SOURCES: [(Control, &str); 7] = [
    (Control::Primary, "primary"),
    (Control::Secondary, "secondary"),
    (Control::Middle, "middle"),
    (Control::Wheel, "wheel"),
    (Control::Pinch, "pinch"),
    (Control::Twist, "twist"),
    (Control::Slide, "slide"),
];

/// Each modifier key with its bit in a set of them and its name in a gesture's key.
const MODIFIERS: [(usize, &str); 4] = [(1, "shift"), (2, "control"), (4, "alt"), (8, "meta")];

impl Control {
    /// Whether this input can take `action`.
    fn takes(self, action: Action) -> bool {
        use Action as A;
        match self {
            Control::Primary | Control::Secondary | Control::Middle => !matches!(action, A::Zoom),
            Control::Wheel => matches!(action, A::Zoom | A::Pan | A::Turn | A::Tilt | A::None),
            Control::Pinch => matches!(action, A::Zoom | A::None),
            Control::Twist => matches!(action, A::Turn | A::None),
            Control::Slide => matches!(action, A::Pan | A::Tilt | A::None),
        }
    }
}

impl Modifiers {
    /// The set of these modifier keys as bits: Shift 1, Control 2, Alt 4, Meta 8.
    pub(crate) fn bits(self) -> usize {
        usize::from(self.shift)
            | usize::from(self.control) << 1
            | usize::from(self.alt) << 2
            | usize::from(self.meta) << 3
    }
}

/// What each input does, with each set of modifier keys held: see
/// [`Controls::gestures`](crate::Controls).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Gestures([Option<Action>; SOURCES.len() * 16]);

impl Default for Gestures {
    fn default() -> Gestures {
        let mut gestures = Gestures::none();
        for (source, bits, action) in [
            (Control::Primary, 0, Action::Pan),
            (Control::Primary, 1, Action::Turn),
            (Control::Secondary, 0, Action::Turn),
            (Control::Middle, 0, Action::Pan),
            (Control::Wheel, 0, Action::Zoom),
            (Control::Pinch, 0, Action::Zoom),
            (Control::Slide, 0, Action::Pan),
        ] {
            gestures.0[source as usize * 16 + bits] = Some(action);
        }
        gestures
    }
}

impl Gestures {
    /// Gestures where no input does anything.
    pub fn none() -> Gestures {
        Gestures([None; SOURCES.len() * 16])
    }

    /// These gestures with the input `key` names, as in `"shift+primary"`, taking `action`. Fails
    /// if `key` names no input, or the input cannot take `action`.
    pub fn with(mut self, key: &str, action: Action) -> Result<Gestures> {
        self.set(key, action).map_err(|reason| Error::invalid(reason).at(key))?;
        Ok(self)
    }

    /// Sets the input `key` names to take `action`, or says why it cannot.
    fn set(&mut self, key: &str, action: Action) -> std::result::Result<(), String> {
        let Some((source, bits)) = parse(key) else {
            let inputs: Vec<&str> = SOURCES.iter().map(|(_, name)| *name).collect();
            return Err(format!(
                "{key:?} is not an input: expected one of {} after any of shift+, control+, alt+, meta+",
                inputs.join(", ")
            ));
        };
        if !source.takes(action) {
            return Err(format!("{key:?} cannot {}", action.name()));
        }
        self.0[source as usize * 16 + bits] = Some(action);
        Ok(())
    }

    /// What `source` does with `modifiers` held: its own action, or else the action of `source`
    /// alone.
    pub(crate) fn get(&self, source: Control, modifiers: Modifiers) -> Action {
        let at = |bits: usize| self.0[source as usize * 16 + bits];
        at(modifiers.bits()).or(at(0)).unwrap_or(Action::None)
    }

    /// Whether any input takes `action`.
    pub(crate) fn any(&self, action: Action) -> bool {
        self.0.contains(&Some(action))
    }
}

/// The input `key` names, and its modifier keys as bits, if it names one.
fn parse(key: &str) -> Option<(Control, usize)> {
    let mut words = key.split('+');
    let input = words.next_back()?;
    let source = SOURCES.iter().find(|(_, name)| *name == input)?.0;
    let mut bits = 0;
    for word in words {
        let bit = MODIFIERS.iter().find(|(_, name)| *name == word)?.0;
        if bits & bit != 0 {
            return None;
        }
        bits |= bit;
    }
    Some((source, bits))
}

impl<'de> Deserialize<'de> for Gestures {
    /// Reads the actions given over the defaults.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Gestures, D::Error> {
        struct Keys;

        impl<'de> Visitor<'de> for Keys {
            type Value = Gestures;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an action for each input, as { \"shift+primary\": \"box\" }")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Gestures, A::Error> {
                let mut gestures = Gestures::default();
                while let Some(key) = map.next_key::<String>()? {
                    let action: Action = map.next_value()?;
                    gestures.set(&key, action).map_err(de::Error::custom)?;
                }
                Ok(gestures)
            }
        }

        deserializer.deserialize_map(Keys)
    }
}

impl JsonSchema for Gestures {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Gestures".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut action = generator.subschema_for::<Action>();
        action.insert(
            "description".into(),
            "The action of the input the key names, after any modifier keys held with it, as in `shift+primary`."
                .into(),
        );
        let inputs = SOURCES.map(|(_, name)| name).join("|");
        let modifiers = MODIFIERS.map(|(_, name)| name).join("|");
        json_schema!({
            "description": "What each input does, by the input and the modifier keys held with it. See [`Controls::gestures`](crate::Controls).",
            "type": "object",
            "propertyNames": { "pattern": format!("^(({modifiers})\\+)*({inputs})$") },
            "additionalProperties": action,
        })
    }
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
            gestures: Gestures::default(),
            keyboard: true,
            hover: true,
            pick_radius: 6.0,
            delete: false,
            cycle: false,
            press: Duration::from_millis(500),
            motion: Motion::System,
        }
    }
}

impl Controls {
    /// Controls for a still picture: no input moves the camera, and there is no keyboard, hover
    /// glow, or press menu. Marks that select still select on click, and marks that drag still
    /// drag.
    pub fn none() -> Controls {
        Controls {
            gestures: Gestures::none(),
            keyboard: false,
            hover: false,
            press: Duration::ZERO,
            ..Controls::default()
        }
    }

    /// Controls for inspecting rows: rows glow under the pointer, select on click, and step with
    /// the keys. Only the application moves the camera.
    pub fn inspect() -> Controls {
        Controls { gestures: Gestures::none(), ..Controls::default() }
    }
}
