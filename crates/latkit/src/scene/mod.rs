//! Scenes: what a view draws, as plain data. Marks name their data; the view is given the data.

mod controls;
#[cfg(feature = "serde")]
mod decode;
mod edges;
mod faces;
mod layout;
mod lines;
pub(crate) mod mark;
mod marker;
mod space;
mod theme;
mod vertices;

use std::time::Duration;

pub use controls::Controls;
pub use edges::Edges;
pub use faces::Faces;
pub use layout::{Direction, Layered, Layout, Stress};
pub use lines::Lines;
pub use mark::Mark;
pub use marker::{Marker, Shape};
pub use space::{Axis, Earth, Grid, Plane, Plot, Projection, Space};
pub use theme::Theme;
pub use vertices::Vertices;

use crate::{Error, Result};

/// What a view draws and how it answers input: a space, marks in drawing order, a layout, a theme,
/// controls, and how long changes ease.
///
/// ```
/// # use latkit::{Edges, Earth, Scene, Vertices};
/// let scene = Scene::new(Earth::globe())
///     .draw(Edges::of("grid", "Branch").ends("from", "to"))
///     .draw(Vertices::of("grid", "Bus").position("lon", "lat"));
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Scene {
    pub(crate) space: Space,
    pub(crate) marks: Vec<Mark>,
    pub(crate) layout: Layout,
    pub(crate) theme: Theme,
    pub(crate) controls: Controls,
    pub(crate) ease: Duration,
}

impl Scene {
    /// An empty scene in `space`.
    pub fn new(space: impl Into<Space>) -> Scene {
        Scene {
            space: space.into(),
            marks: Vec::new(),
            layout: Layout::None,
            theme: Theme::default(),
            controls: Controls::default(),
            ease: Duration::from_millis(300),
        }
    }

    /// Draws `mark` over the marks before it.
    #[must_use]
    pub fn draw(mut self, mark: impl Into<Mark>) -> Scene {
        self.marks.push(mark.into());
        self
    }

    /// Places vertices that have no position.
    #[must_use]
    pub fn layout(mut self, layout: impl Into<Layout>) -> Scene {
        self.layout = layout.into();
        self
    }

    /// The theme.
    #[must_use]
    pub fn theme(mut self, theme: Theme) -> Scene {
        self.theme = theme;
        self
    }

    /// How the view answers the pointer and keyboard.
    #[must_use]
    pub fn controls(mut self, controls: Controls) -> Scene {
        self.controls = controls;
        self
    }

    /// How long changed descriptions and new data ease; zero changes at once.
    #[must_use]
    pub fn ease(mut self, over: Duration) -> Scene {
        self.ease = over;
        self
    }

    /// The space.
    pub fn space(&self) -> &Space {
        &self.space
    }

    /// The marks in drawing order.
    pub fn marks(&self) -> &[Mark] {
        &self.marks
    }

    /// Two marks with one key would be indistinguishable across scenes.
    pub(crate) fn check(&self) -> Result<()> {
        for (i, mark) in self.marks.iter().enumerate() {
            if self.marks[..i].iter().any(|m| m.key() == mark.key()) {
                let reason = "draws the same table as an earlier mark of its kind; give one a name with named";
                return Err(Error::invalid(reason).at(i).at("marks"));
            }
        }
        Ok(())
    }
}
