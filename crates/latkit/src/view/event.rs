//! What a view tells the application. An intent asks something of it: a click, an open, a menu, a
//! drag, a connection, a deletion, each told once, in the order the user acted. A change tells that
//! state the view keeps moved: hover, selection, camera, what a frame waits on. Only the latest change
//! of each is told, and the state can always be read, so a listener added late reads what it missed.
//! A view tells only what the application did not do itself: its setters change state silently.

use std::collections::VecDeque;

use super::Camera;
use super::input::{Device, Modifiers};
use crate::{Error, Name, Pending, Row, Rows};

/// What happened in a view, for the application to act on. Drain them with
/// [`View::events`](crate::View::events).
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
#[serde(tag = "type", content = "detail", rename_all = "lowercase")]
#[schemars(rename = "ViewEvent")]
#[non_exhaustive]
pub enum Event {
    /// A row was clicked.
    Click {
        /// The row.
        hit: Hit,
        /// How the user clicked it.
        trigger: Trigger,
    },
    /// A row was double clicked, or Enter pressed on the row the keys point at.
    Open {
        /// The row.
        hit: Hit,
        /// How the user opened it.
        trigger: Trigger,
    },
    /// The secondary button clicked, or the menu key pressed: what lies under the trigger's point,
    /// for a menu of what to do with it.
    Menu {
        /// What lies under the point, nearest first.
        hits: Vec<Hit>,
        /// How the user asked.
        trigger: Trigger,
    },
    /// A row of a draggable mark follows the pointer: the drag starts once the pointer moves a few
    /// pixels from where it pressed the row.
    Drag {
        /// Whether the drag starts, moves, or ends.
        phase: Phase,
        /// The row dragged, as it was hit.
        hit: Hit,
        /// Where the row goes, in the space's coordinates: where it was hit, moved as the pointer moved
        /// since the press, at the depth the drag started; a vertex keeps where it was grabbed. On a
        /// diagram's dots when its grid snaps.
        position: [f64; 3],
        /// The pointer.
        trigger: Trigger,
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
        /// Where it was released.
        trigger: Trigger,
    },
    /// Delete or Backspace with rows selected and [`Controls::delete`](crate::Controls) on.
    Delete {
        /// The rows selected.
        rows: Vec<Rows>,
        /// The key.
        trigger: Trigger,
    },
    /// What the user points at changed: [`View::hovered`](crate::View::hovered).
    Hover {
        /// The row now pointed at; `None` once it left every row.
        hit: Option<Hit>,
        /// The pointer, or the keys.
        trigger: Trigger,
    },
    /// The selection changed: [`View::selection`](crate::View::selection).
    Select {
        /// The rows selected now.
        rows: Vec<Rows>,
        /// How the user changed it; `None` when the data dropped rows from it.
        trigger: Option<Trigger>,
    },
    /// The camera moved by a gesture, a fit, a flight, coasting, or an orbit:
    /// [`View::camera`](crate::View::camera).
    Camera(Camera),
    /// What the last frame stood in for changed; nothing once it is complete:
    /// [`View::complete`](crate::View::complete).
    Waiting(Waiting),
    /// Something failed, told once. A mark its data no longer fits also lists in
    /// [`View::failures`](crate::View::failures).
    Error(Error),
}

/// Where, with what keys, and with what the user acted. For keys, the point is the row they point
/// at, else the pointer, else the view's middle.
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, schemars::JsonSchema)]
pub struct Trigger {
    /// CSS pixels from the top left.
    pub point: [f32; 2],
    /// The keys held.
    pub modifiers: Modifiers,
    /// What acted.
    pub device: Device,
}

impl Event {
    /// Whether it asks something of the application, so keeps its place among intents.
    fn intent(&self) -> bool {
        matches!(
            self,
            Event::Click { .. }
                | Event::Open { .. }
                | Event::Menu { .. }
                | Event::Drag { .. }
                | Event::Connect { .. }
                | Event::Delete { .. }
        )
    }

    /// Whether it leaves `older`, still untold, nothing to say: a change replaces the change of the
    /// same state, a drag's move the move before it, an error the same error.
    fn replaces(&self, older: &Event) -> bool {
        match (self, older) {
            (Event::Drag { phase: Phase::Move, .. }, Event::Drag { phase: Phase::Move, .. }) => true,
            (Event::Error(error), Event::Error(old)) => error == old,
            (Event::Hover { .. } | Event::Select { .. } | Event::Camera(_) | Event::Waiting(_), _) => {
                std::mem::discriminant(self) == std::mem::discriminant(older)
            }
            _ => false,
        }
    }
}

/// What a view has yet to tell, in the order it happened. An intent waiting on a pick holds its
/// place, and the intents after it wait behind it; changes and errors never wait.
#[derive(Default)]
pub(crate) struct Events(VecDeque<Slot>);

enum Slot {
    Ready(Event),
    Picking(Pending<Vec<Hit>>, Awaited),
    /// A pick that made nothing, dropped once settled.
    Gone,
}

/// What an intent waits on a pick for.
#[derive(Clone)]
pub(crate) enum Awaited {
    Menu(Trigger),
    Connect {
        from: End,
        edge: Option<Row>,
        trigger: Trigger,
    },
    /// A click again where nothing moved: the selection moves to the row under the point after
    /// `after`.
    Cycle {
        after: Option<Row>,
        trigger: Trigger,
    },
}

impl Events {
    /// Queues `event`, dropping what it leaves nothing to say.
    pub(crate) fn tell(&mut self, event: Event) {
        self.0.retain(|slot| !matches!(slot, Slot::Ready(older) if event.replaces(older)));
        self.0.push_back(Slot::Ready(event));
    }

    /// Queues the intent `awaited` makes once `hits` answers.
    pub(crate) fn tell_after(&mut self, hits: Pending<Vec<Hit>>, awaited: Awaited) {
        self.0.push_back(Slot::Picking(hits, awaited));
    }

    /// Makes, in place, each event whose pick answered; one that makes nothing leaves no place.
    pub(crate) fn settle(&mut self, mut make: impl FnMut(Vec<Hit>, Awaited) -> Option<Event>) {
        let mut made = false;
        for slot in &mut self.0 {
            if let Slot::Picking(hits, awaited) = slot
                && let Some(hits) = hits.take()
            {
                *slot = match make(hits.unwrap_or_default(), awaited.clone()) {
                    Some(event) => Slot::Ready(event),
                    None => Slot::Gone,
                };
                made = true;
            }
        }
        if made {
            self.0.retain(|slot| !matches!(slot, Slot::Gone));
        }
    }

    /// The first error untold: a shot fails on it, and it stays for the view's owner.
    pub(crate) fn error(&self) -> Option<&Error> {
        self.0.iter().find_map(|slot| match slot {
            Slot::Ready(Event::Error(error)) => Some(error),
            _ => None,
        })
    }

    /// Takes what can be told: all but the intents behind one still waiting on its pick.
    pub(crate) fn drain(&mut self) -> std::vec::IntoIter<Event> {
        let (mut told, mut held) = (Vec::new(), VecDeque::new());
        for slot in self.0.drain(..) {
            match slot {
                Slot::Ready(event) if held.is_empty() || !event.intent() => told.push(event),
                slot => held.push_back(slot),
            }
        }
        self.0 = held;
        told.into_iter()
    }
}

impl Extend<Event> for Events {
    fn extend<I: IntoIterator<Item = Event>>(&mut self, events: I) {
        events.into_iter().for_each(|event| self.tell(event));
    }
}

/// A vertex a connection ends at, and its port when it has the one the connection meets.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct End {
    /// The vertex.
    pub row: Row,
    /// The port, by the reference field naming its net.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<Name>,
}

/// A row under a point, as the frame drew it.
#[derive(Clone, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct Hit {
    /// The row.
    pub row: Row,
    /// The name of the mark that drew it, when it has one: what tells two marks of one table apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mark: Option<Name>,
    /// The index of the mark in the scene the frame drew.
    #[serde(skip)]
    pub(crate) index: usize,
    /// The point of the row nearest the probe, CSS pixels from the top left: a vertex's or a port's
    /// middle, the nearest point of a stroke or a triangle.
    pub point: [f32; 2],
    /// That point in the space's coordinates: x, y, and elevation.
    pub position: [f64; 3],
    /// CSS pixels from the probe to the row.
    pub distance: f32,
    /// The port hit, when a vertex's port was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<Name>,
    /// The sample hit, when a line tracing a sampled field was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample: Option<Sample>,
}

/// A sample of a traced field: its frame, the axis coordinate it was recorded at, and its value.
#[derive(Clone, Copy, PartialEq, Debug, serde::Serialize, schemars::JsonSchema)]
pub struct Sample {
    /// The frame, numbered from the first ever recorded.
    pub frame: u32,
    /// The axis coordinate.
    pub at: f64,
    /// The value.
    pub value: f64,
}

/// The phase of a [`Drag`](Event::Drag).
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// The pointer moved far enough to drag.
    Start,
    /// The pointer moved.
    Move,
    /// The pointer let go, or the drag was cancelled.
    End,
}

/// What [`View::fit`](crate::View::fit) frames.
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[schemars(description = "What a view's fit frames.")]
#[serde(rename_all = "camelCase")]
pub enum Fit {
    /// Everything drawn.
    All,
    /// These rows.
    Rows(Vec<Rows>),
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
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Frames rendered.
    pub frames: u64,
    /// Rows of every mark's table.
    pub rows: u64,
    /// Rows every mark draws: every row of a table drawn whole, the rows of the tiles in view of one
    /// drawn through tiles.
    pub drawn: u64,
    /// Draw calls the last frame recorded, shadows and labels with the marks.
    pub draws: u64,
    /// Instances the last frame's draws drew: points, segments, triangles, glyphs; at most, for
    /// segments the GPU culls.
    pub instances: u64,
    /// Fetched tiles the view draws, of every tile source.
    pub tiles: u64,
    /// Tiles being fetched or decoded, of every tile source.
    pub tiles_loading: u64,
    /// Bytes of data waiting to upload.
    pub uploading: u64,
    /// Bytes of data pages on the GPU, for every view of its `Gpu`.
    pub resident: u64,
    /// Bytes the GPU's [`Budget`](crate::Budget) lets data take.
    pub budget: u64,
    /// The work under way the last frame stood in for; nothing when it drew everything as the data,
    /// scene, and camera say: see [`View::complete`](crate::View::complete).
    pub waiting: Waiting,
    /// Milliseconds the last frame took to record on the CPU.
    pub cpu_ms: f32,
    /// Milliseconds the GPU takes on a frame: the median of the last frames it measured; 0 where the
    /// device cannot measure.
    pub gpu_ms: f32,
}

/// The work under way a frame stood in for, by kind; nothing when the frame was complete.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Waiting {
    /// Pages its marks draw still uploading, or tables not yet built from them.
    pub data: bool,
    /// Layouts, routes, lanes, shapes, tiles, or pyramids under way.
    pub derived: bool,
    /// A label placement being read back, or texts asked for and not yet set.
    pub labels: bool,
    /// A fit due or being measured.
    pub fit: bool,
    /// Row regions laid out again, segment counts being read back, or a transition beginning.
    pub marks: bool,
}

impl Waiting {
    /// Whether it waits on nothing: the frame was complete.
    pub fn is_empty(&self) -> bool {
        *self == Waiting::default()
    }

    /// The names of what it waits on, as its fields are named.
    pub fn names(&self) -> impl Iterator<Item = &'static str> {
        let Waiting { data, derived, labels, fit, marks } = *self;
        [("data", data), ("derived", derived), ("labels", labels), ("fit", fit), ("marks", marks)]
            .into_iter()
            .filter_map(|(name, waiting)| waiting.then_some(name))
    }
}

impl std::fmt::Display for Waiting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.names().collect::<Vec<_>>().join(", "))
    }
}

/// The names of what it waits on, as [`Waiting::names`] gives them.
impl serde::Serialize for Waiting {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.names())
    }
}

impl schemars::JsonSchema for Waiting {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Waiting".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "description": "Work under way a frame stands in for: pages uploading or tables not yet built from them (`data`); layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); a label placement or texts not yet set (`labels`); a fit due or being measured (`fit`); row regions laid out again, segment counts, or a transition beginning (`marks`). Empty once a frame is complete.",
            "type": "array",
            "items": { "enum": ["data", "derived", "labels", "fit", "marks"] },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(id: u64) -> Event {
        let hit = Hit {
            row: Row::new("d", "t", id),
            mark: None,
            index: 0,
            point: [0.0; 2],
            position: [0.0; 3],
            distance: 0.0,
            port: None,
            sample: None,
        };
        Event::Click { hit, trigger: Trigger::default() }
    }

    fn told(events: &mut Events) -> Vec<Event> {
        events.drain().collect()
    }

    #[test]
    fn intents_wait_behind_a_pick_while_changes_pass() {
        let mut events = Events::default();
        let (hits, reply) = Pending::new();
        events.tell_after(hits, Awaited::Menu(Trigger::default()));
        events.tell(click(1));
        events.tell(Event::Waiting(Waiting::default()));
        assert_eq!(told(&mut events), vec![Event::Waiting(Waiting::default())], "the click waits for the menu");
        reply.resolve(Ok(Vec::new()));
        events.settle(|hits, awaited| match awaited {
            Awaited::Menu(trigger) => Some(Event::Menu { hits, trigger }),
            Awaited::Connect { .. } | Awaited::Cycle { .. } => unreachable!("only a menu waits"),
        });
        let after = told(&mut events);
        assert!(matches!(after.as_slice(), [Event::Menu { .. }, Event::Click { .. }]), "in the order asked: {after:?}");
    }

    #[test]
    fn a_change_replaces_the_one_still_untold() {
        let mut events = Events::default();
        let mut waiting = Waiting { data: true, ..Waiting::default() };
        events.tell(Event::Waiting(waiting));
        events.tell(click(1));
        waiting.data = false;
        events.tell(Event::Waiting(waiting));
        events.tell(Event::Error(Error::Timeout));
        events.tell(Event::Error(Error::Timeout));
        assert_eq!(told(&mut events), vec![click(1), Event::Waiting(waiting), Event::Error(Error::Timeout)]);
    }
}
