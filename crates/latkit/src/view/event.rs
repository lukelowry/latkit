//! What a view tells the application, and what the application asks of it.

use crate::{Error, Row};

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
    /// A mark does not fit its data and draws nothing until a scene or data fixes it.
    Error(Error),
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
}

/// What a view does each frame.
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Stats {
    /// Frames rendered.
    pub frames: u64,
    /// Rows of every mark.
    pub rows: u64,
    /// Bytes of data waiting to upload.
    pub uploading: u64,
    /// Bytes of data resident on the GPU, for every view of its `Gpu`.
    pub gpu_bytes: u64,
    /// Milliseconds the last frame took to record on the CPU.
    pub cpu_ms: f32,
}
