//! Events a view reports to the application.
//!
//! An intent asks the application to act: a click, open, menu, drag, connection, or deletion. Each
//! is reported once, in the order the user acted. A change reports that view state moved and is
//! named after that state: `hovered`, `selection`, `camera`, `waiting`. Only the latest change of
//! each is reported, and the state can always be read, so a late listener can catch up. A view
//! reports only what the application did not do itself: its setters change state silently.

use std::collections::VecDeque;

use super::Camera;
use super::input::{Device, Modifiers};
use crate::{Error, Name, Pending, Row, Rows};

/// Something that happened in a view, as [`View::events`](crate::View::events) reports it.
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
    /// A row was double-clicked, or Enter was pressed on the row the keyboard points at.
    Open {
        /// The row.
        hit: Hit,
        /// How the user opened it.
        trigger: Trigger,
    },
    /// A context menu was requested: by a secondary click, the menu key, or a touch or pen held
    /// still. Lists the rows under the trigger's point, for a menu of actions on them.
    Menu {
        /// The rows under the point, nearest first.
        hits: Vec<Hit>,
        /// How the user asked.
        trigger: Trigger,
    },
    /// A row of a draggable mark is dragged. The drag starts once the pointer moves more than 4 CSS
    /// pixels from where it pressed the row.
    Drag {
        /// Whether the drag starts, moves, or ends.
        phase: Phase,
        /// The row dragged, as it was hit.
        hit: Hit,
        /// The row's new position in the space's coordinates: the hit point moved with the pointer
        /// since the press, at the depth where the drag started, so a vertex keeps its grab offset.
        /// Snapped to a diagram's dots when its grid snaps.
        position: [f64; 3],
        /// The pointer.
        trigger: Trigger,
    },
    /// A connection was drawn with [`Controls::connect`](crate::Controls) on: from a port, from a
    /// vertex with Alt held, or by dragging an edge's end off it.
    Connect {
        /// The end it was drawn from: for an edge, the end that stayed.
        from: End,
        /// The vertex it was released over, if any.
        to: Option<End>,
        /// The edge whose end was dragged off; `to` replaces that end.
        edge: Option<Row>,
        /// Where it was released.
        trigger: Trigger,
    },
    /// Delete or Backspace was pressed with rows selected and [`Controls::delete`](crate::Controls)
    /// on.
    Delete {
        /// The rows selected.
        rows: Vec<Rows>,
        /// The key.
        trigger: Trigger,
    },
    /// The hovered row changed: [`View::hovered`](crate::View::hovered).
    Hovered {
        /// The row now hovered; `None` once no row is.
        hit: Option<Hit>,
        /// The pointer, or the keys.
        trigger: Trigger,
    },
    /// The selection changed: [`View::selection`](crate::View::selection).
    Selection {
        /// The rows selected now.
        rows: Vec<Rows>,
        /// How the user changed it; `None` when the data dropped rows from it.
        trigger: Option<Trigger>,
    },
    /// The camera moved by a gesture, fit, flight, coast, or orbit:
    /// [`View::camera`](crate::View::camera).
    Camera(Camera),
    /// The work the last frame waited on changed; empty once frames are complete:
    /// [`View::waiting`](crate::View::waiting).
    Waiting(Waiting),
    /// Something failed; reported once. A mark that no longer fits its data is also listed in
    /// [`View::failures`](crate::View::failures).
    Error(Error),
}

/// Where the user acted, with which modifier keys, and with which device. For keyboard input, the
/// point is the row the keys point at, else the pointer, else the view's middle.
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, schemars::JsonSchema)]
pub struct Trigger {
    /// CSS pixels from the top left.
    pub point: [f32; 2],
    /// The modifier keys held.
    pub modifiers: Modifiers,
    /// The device used.
    pub device: Device,
}

impl Event {
    /// Whether it is an intent, which keeps its order among intents.
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

    /// Whether it makes the unreported `older` redundant: a change replaces an earlier change of
    /// the same state, a drag move the previous move, and an error an identical error.
    fn replaces(&self, older: &Event) -> bool {
        match (self, older) {
            (Event::Drag { phase: Phase::Move, .. }, Event::Drag { phase: Phase::Move, .. }) => true,
            (Event::Error(error), Event::Error(old)) => error == old,
            (Event::Hovered { .. } | Event::Selection { .. } | Event::Camera(_) | Event::Waiting(_), _) => {
                std::mem::discriminant(self) == std::mem::discriminant(older)
            }
            _ => false,
        }
    }
}

/// The events a view has yet to report, in order. An intent waiting on a pick holds its place, and
/// later intents wait behind it; changes and errors never wait.
#[derive(Default)]
pub(crate) struct Events(VecDeque<Slot>);

enum Slot {
    Ready(Event),
    Picking(Pending<Vec<Hit>>, Awaited),
    /// A pick that produced no event, removed once settled.
    Gone,
}

/// An intent waiting for its pick's hits.
#[derive(Clone)]
pub(crate) enum Awaited {
    Menu(Trigger),
    Connect {
        from: End,
        edge: Option<Row>,
        trigger: Trigger,
    },
    /// A repeated click where nothing moved: the selection moves to the next row under the point
    /// after `after`.
    Cycle {
        after: Option<Row>,
        trigger: Trigger,
    },
}

impl Events {
    /// Queues `event`, dropping the unreported events it makes redundant.
    pub(crate) fn tell(&mut self, event: Event) {
        self.0.retain(|slot| !matches!(slot, Slot::Ready(older) if event.replaces(older)));
        self.0.push_back(Slot::Ready(event));
    }

    /// Queues the intent `awaited` produces once `hits` resolves.
    pub(crate) fn tell_after(&mut self, hits: Pending<Vec<Hit>>, awaited: Awaited) {
        self.0.push_back(Slot::Picking(hits, awaited));
    }

    /// Turns each intent whose pick resolved into its event, in place. One that produces no event
    /// is removed.
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

    /// The first unreported error. A shot fails on it and leaves it queued for the view's owner.
    pub(crate) fn error(&self) -> Option<&Error> {
        self.0.iter().find_map(|slot| match slot {
            Slot::Ready(Event::Error(error)) => Some(error),
            _ => None,
        })
    }

    /// Takes every event ready to report, except intents queued behind one still waiting on its
    /// pick.
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

/// A vertex a connection ends at, and the port the connection meets, if any.
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
    /// The name of the mark that drew it, if named. It tells two marks of one table apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mark: Option<Name>,
    /// The index of the mark in the scene the frame drew.
    #[serde(skip)]
    pub(crate) index: usize,
    /// The row's point nearest the probe, in CSS pixels from the top left: a vertex's or port's
    /// middle, or the nearest point of a stroke or triangle.
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
    /// The frame, numbered from the first ever recorded. JSON uses a decimal string above 2^53 - 1.
    #[serde(serialize_with = "sample_index")]
    #[schemars(with = "crate::Id")]
    pub frame: u64,
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
    /// The pointer was released, or the drag was cancelled.
    End,
}

/// What [`View::fit`](crate::View::fit) frames.
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[schemars(description = "The target of a view's fit.")]
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

/// The cursor a view wants shown over it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Cursor {
    /// The platform's default.
    #[default]
    Default,
    /// Over a row a click selects.
    Pointer,
    /// Over a draggable row.
    Grab,
    /// While dragging a row or the camera.
    Grabbing,
    /// While selecting a box or drawing a connection.
    Crosshair,
}

/// Counters describing a view's frames.
#[derive(Clone, Copy, PartialEq, Debug, Default, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Frames rendered.
    pub frames: u64,
    /// Rows of every mark's table.
    pub rows: u64,
    /// Rows every mark draws: every row of a table drawn whole, and the rows of the tiles in view
    /// of a paged table.
    pub drawn: u64,
    /// Draw calls the last frame recorded, label draws included.
    pub draws: u64,
    /// Instances the last frame's draws drew: points, segments, triangles, and glyphs. An upper
    /// bound for segments, which the GPU may cull.
    pub instances: u64,
    /// Fetched tiles the view draws, of every tile source.
    pub tiles: u64,
    /// Tiles being fetched or decoded, of every tile source.
    pub tiles_loading: u64,
    /// Milliseconds the last frame took to record on the CPU.
    pub cpu_ms: f32,
    /// Milliseconds the GPU takes per frame: the median of recently measured frames; 0 if the
    /// device cannot measure.
    pub gpu_ms: f32,
}

/// The work a frame was still waiting on, by kind; empty when the frame was complete.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Waiting {
    /// Pipelines the view uses are still compiling. Until those it draws with finish, the view
    /// draws nothing new.
    pub compiling: bool,
    /// Pages its marks draw are still uploading, or tables are not yet built from them.
    pub data: bool,
    /// Layouts, routes, lanes, shapes, tiles, or pyramids under way.
    pub derived: bool,
    /// A label placement being read back, or texts requested and not yet set.
    pub labels: bool,
    /// A fit due or being measured.
    pub fit: bool,
    /// Segment counts being read back, or a transition beginning.
    pub marks: bool,
}

impl Waiting {
    /// Whether it waits on nothing: the frame was complete.
    pub fn is_empty(&self) -> bool {
        *self == Waiting::default()
    }

    /// The names of the fields that are set.
    pub fn names(&self) -> impl Iterator<Item = &'static str> {
        let Waiting { compiling, data, derived, labels, fit, marks } = *self;
        [
            ("compiling", compiling),
            ("data", data),
            ("derived", derived),
            ("labels", labels),
            ("fit", fit),
            ("marks", marks),
        ]
        .into_iter()
        .filter_map(|(name, waiting)| waiting.then_some(name))
    }
}

impl std::fmt::Display for Waiting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.names().collect::<Vec<_>>().join(", "))
    }
}

/// Serializes as the list of names [`Waiting::names`] gives.
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
            "description": "What a frame still waits on: pipelines the scene draws with, which compile before the view draws anything new (`compiling`); pages uploading, or tables not yet built from them (`data`); layouts, routes, lanes, shapes, tiles, or pyramids (`derived`); label placement, or text not yet set (`labels`); a fit due or being measured (`fit`); segment counts, or a transition starting (`marks`). Empty once the frame is complete.",
            "type": "array",
            "items": { "enum": ["compiling", "data", "derived", "labels", "fit", "marks"] },
        })
    }
}

#[allow(clippy::trivially_copy_pass_by_ref, reason = "serde serialize_with takes a reference")]
fn sample_index<S: serde::Serializer>(index: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(&crate::Id::Number(*index), serializer)
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
    fn a_change_replaces_the_undelivered_one() {
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
