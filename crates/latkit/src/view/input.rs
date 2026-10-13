//! Input as a view reads it, from any platform: `web` and `winit` translate their events into these.

/// A pointer, wheel, or key event, with points in CSS pixels from the view's top left.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Input {
    /// A pointer pressed.
    Down {
        /// Tells pointers apart while several are down.
        pointer: u32,
        /// Where.
        point: [f32; 2],
        /// Which button.
        button: Button,
        /// Keys held.
        modifiers: Modifiers,
        /// Whether a finger pressed: picks reach farther.
        touch: bool,
    },
    /// A pointer moved.
    Move {
        /// Which pointer.
        pointer: u32,
        /// Where to.
        point: [f32; 2],
        /// Keys held.
        modifiers: Modifiers,
    },
    /// A pointer let go.
    Up {
        /// Which pointer.
        pointer: u32,
        /// Where.
        point: [f32; 2],
        /// Keys held.
        modifiers: Modifiers,
    },
    /// The platform took a pointer away.
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
        /// Keys held.
        modifiers: Modifiers,
    },
    /// A key went down or up while the view had focus.
    Key {
        /// Which key.
        key: Key,
        /// Whether it went down.
        down: bool,
        /// Keys held.
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
    /// The context button: right.
    Secondary,
    /// The middle button or wheel press.
    Middle,
}

/// Keys held during an input.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
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

/// The keys a view answers.
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
    /// The context menu key.
    Menu,
    /// Any other key.
    Other,
}
