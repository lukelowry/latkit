//! Platform-independent input: a browser canvas translates its events into these.

/// A pointer, wheel, or key event, with points in CSS pixels from the view's top left.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Input {
    /// A pointer was pressed.
    Down {
        /// Identifies the pointer while several are down.
        pointer: u32,
        /// Where it was pressed.
        point: [f32; 2],
        /// Which button.
        button: Button,
        /// Modifier keys held.
        modifiers: Modifiers,
        /// The device that pressed. A finger picks rows from farther away.
        device: Device,
    },
    /// A pointer moved.
    Move {
        /// Which pointer.
        pointer: u32,
        /// Where it moved to.
        point: [f32; 2],
        /// Modifier keys held.
        modifiers: Modifiers,
        /// The device that moved.
        device: Device,
    },
    /// A pointer was released.
    Up {
        /// Which pointer.
        pointer: u32,
        /// Where it was released.
        point: [f32; 2],
        /// Modifier keys held.
        modifiers: Modifiers,
    },
    /// The platform cancelled a pointer.
    Cancel {
        /// Which pointer.
        pointer: u32,
    },
    /// The wheel turned: CSS pixels, positive down and right.
    Wheel {
        /// Where the pointer is.
        point: [f32; 2],
        /// How far.
        delta: [f32; 2],
        /// Modifier keys held.
        modifiers: Modifiers,
    },
    /// A key went down or up while the view had focus.
    Key {
        /// Which key.
        key: Key,
        /// Whether it went down.
        down: bool,
        /// Modifier keys held.
        modifiers: Modifiers,
    },
    /// The pointer left the view.
    Leave,
}

/// A pointer button.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Button {
    /// The main button: left, or a touch.
    Primary,
    /// The context-menu button: right.
    Secondary,
    /// The middle button or wheel press.
    Middle,
}

/// The input device.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    /// A mouse or a trackpad.
    #[default]
    Mouse,
    /// A pen.
    Pen,
    /// A finger. Picks find rows up to 8 CSS pixels farther away.
    Touch,
    /// The keyboard.
    Keyboard,
}

/// Modifier keys held during an input.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Serialize, schemars::JsonSchema)]
pub struct Modifiers {
    /// Shift.
    pub shift: bool,
    /// Control.
    pub control: bool,
    /// Alt or Option.
    pub alt: bool,
    /// Meta: Command or Windows.
    pub meta: bool,
}

impl Modifiers {
    /// Whether a click toggles its row in the selection: Shift, Control, or Meta is held.
    pub fn toggles(self) -> bool {
        self.shift || self.control || self.meta
    }
}

/// The keys a view responds to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Key {
    /// Escape.
    Escape,
    /// Enter or Return.
    Enter,
    /// Delete.
    Delete,
    /// Backspace.
    Backspace,
    /// Home.
    Home,
    /// Tab.
    Tab,
    /// Space.
    Space,
    /// Plus or equals.
    Plus,
    /// Minus.
    Minus,
    /// Left arrow.
    Left,
    /// Right arrow.
    Right,
    /// Up arrow.
    Up,
    /// Down arrow.
    Down,
    /// A request for a context menu from the keyboard: the menu key or Shift+F10. A canvas sends it
    /// for each `contextmenu` event no pointer caused.
    Menu,
    /// Any other key.
    Other,
}
