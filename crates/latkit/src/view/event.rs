//! What a view tells the application, and what the application asks of it.

use super::input::Modifiers;
use crate::{Error, Name, Row};

/// What happened in a view, for the application to act on. Drain them with
/// [`View::events`](crate::View::events).
#[derive(Clone, PartialEq, Debug)]
#[non_exhaustive]
pub enum Event {
    /// The row under the pointer changed; `None` when it left every row.
    Hover(Option<Hit>),
    /// A row was clicked.
    Click(Hit),
    /// A row was double clicked.
    Open(Hit),
    /// The selection changed.
    Select(Vec<Row>),
    /// A row of a draggable mark follows the pointer.
    Drag(Drag),
    /// The camera moved.
    Camera,
    /// The secondary button clicked, or the menu key pressed: what lies under the point, nearest
    /// first, for a menu of what to do with it.
    Menu {
        /// Where, CSS pixels from the top left: the pointer, or for the key the view's middle.
        point: [f32; 2],
        /// What lies under it, nearest first.
        hits: Vec<Hit>,
        /// Whether the menu key asked.
        keyboard: bool,
        /// The keys held.
        modifiers: Modifiers,
    },
    /// A connection was drawn with [`Controls::connect`](crate::Controls): from a port, a vertex
    /// with Alt held, or an edge whose end was dragged off it.
    Connect {
        /// The end it was drawn from: for an edge, the end that stayed.
        from: End,
        /// The vertex it was released over, if any.
        to: Option<End>,
        /// The edge whose other end was dragged, which `to` replaces.
        edge: Option<Row>,
        /// Where it was released, CSS pixels from the top left.
        point: [f32; 2],
    },
    /// Delete or Backspace with rows selected and [`Controls::delete`](crate::Controls) on.
    Delete(Vec<Row>),
    /// A mark does not fit its data and draws nothing until a scene or data fixes it.
    Error(Error),
}

/// A vertex a connection ends at, and its port when it has the one the connection meets.
#[derive(Clone, PartialEq, Debug)]
pub struct End {
    /// The vertex.
    pub row: Row,
    /// The port, by the reference field naming its net.
    pub port: Option<Name>,
}

/// A row under a point, as the frame drew it.
#[derive(Clone, PartialEq, Debug)]
pub struct Hit {
    /// The row.
    pub row: Row,
    /// The index of the scene's mark that drew it.
    pub mark: usize,
    /// The point of the row nearest the probe, CSS pixels from the top left.
    pub point: [f32; 2],
    /// That point in the space's coordinates: x, y, and elevation.
    pub position: [f64; 3],
    /// CSS pixels from the probe to the row.
    pub distance: f32,
    /// The port hit, when a vertex's port was.
    pub port: Option<Name>,
    /// The sample hit, when a line tracing a sampled field was.
    pub sample: Option<Sample>,
}

/// A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Sample {
    /// The frame, numbered from the first ever recorded.
    pub frame: u32,
    /// The axis coordinate.
    pub at: f64,
    /// The value.
    pub value: f64,
}

/// A row following the pointer: the drag starts once the pointer moves a few pixels from where it
/// pressed the row.
#[derive(Clone, PartialEq, Debug)]
pub struct Drag {
    /// Whether the drag starts, moves, or ends.
    pub phase: Phase,
    /// The row dragged, as it was hit.
    pub hit: Hit,
    /// The pointer, CSS pixels from the top left.
    pub point: [f32; 2],
    /// The point under the pointer at the depth the drag started, in the space's coordinates.
    pub position: [f64; 3],
}

/// The phase of a [`Drag`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// The pointer moved far enough to drag.
    Start,
    /// The pointer moved.
    Move,
    /// The pointer let go, or the drag was cancelled.
    End,
}

/// What [`View::fit`](crate::View::fit) frames.
#[derive(Clone, PartialEq, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Deserialize), serde(rename_all = "camelCase"))]
pub enum Fit {
    /// Everything drawn.
    All,
    /// These rows.
    Rows(Vec<Row>),
    /// Brings this row into view, keeping the zoom.
    Reveal(Row),
    /// The box from `min` to `max`: x, y, and elevation.
    Bounds {
        /// The least corner.
        min: [f64; 3],
        /// The greatest corner.
        max: [f64; 3],
    },
}

/// The pointer a view asks for over what it shows.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Cursor {
    /// The platform's default.
    #[default]
    Default,
    /// Over a row a click selects.
    Pointer,
    /// Over a row that drags.
    Grab,
    /// While dragging a row or the camera.
    Grabbing,
    /// While selecting a box.
    Crosshair,
}

/// What a view does each frame.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Stats {
    /// Frames rendered.
    pub frames: u64,
    /// Rows of every mark's table.
    pub rows: u64,
    /// Rows every mark draws: every row of a table drawn whole, the rows of the tiles in view of one
    /// drawn through tiles.
    pub drawn: u64,
    /// Bytes of data waiting to upload.
    pub uploading: u64,
    /// Bytes of data pages on the GPU, for every view of its `Gpu`.
    pub resident: u64,
    /// Bytes the GPU's [`Budget`](crate::Budget) lets data take.
    pub budget: u64,
    /// Whether the last frame drew everything as the data, scene, and camera say, with nothing
    /// standing in for work under way: see [`View::complete`](crate::View::complete).
    pub complete: bool,
    /// Milliseconds the last frame took to record on the CPU.
    pub cpu_ms: f32,
    /// Milliseconds the GPU takes on a frame: the median of the last frames it measured; 0 where the
    /// device cannot measure.
    pub gpu_ms: f32,
}
