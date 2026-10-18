//! Scenes: what a view draws, as plain data. Marks name their data; the view is given the data.

pub(crate) mod areas;
pub(crate) mod compile;
mod controls;
mod decode;
mod edges;
mod faces;
mod label;
mod layout;
pub(crate) mod lines;
pub(crate) mod mark;
mod marker;
mod port;
mod space;
mod theme;
mod vertices;

use std::sync::Arc;
use std::time::Duration;

pub use areas::Areas;
pub use controls::Controls;
pub use edges::Edges;
pub use faces::Faces;
pub use label::Label;
pub use layout::{Direction, Interpolation, Layered, Layout, Route, Stress};
pub use lines::Lines;
pub use mark::Mark;
pub use marker::{Marker, Shape};
pub use port::{Port, Side};
pub(crate) use space::sun;
pub use space::{Axis, Diagram, Earth, Format, Grid, Plane, Plot, Projection, Space};
pub use theme::{Shadow, Theme};
pub use vertices::Vertices;

use crate::{Data, Error, Expr, Result};

/// What a view draws and how it answers input: a space, marks in drawing order, a layout, a theme,
/// controls, how long changes ease, and the title written over it.
///
/// ```
/// # use latkit::{Colormap, Edges, Earth, Scene, Vertices, field};
/// let voltage = field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05);
/// let scene = Scene::new(Earth::globe())
///     .draw(Edges::of("grid", "Branch").ends("from", "to"))
///     .draw(Vertices::of("grid", "Bus").position("lon", "lat").color(voltage).legend("Bus voltage · pu"))
///     .title("Voltage");
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Scene {
    pub(crate) space: Space,
    pub(crate) marks: Vec<Mark>,
    pub(crate) layout: Layout,
    pub(crate) theme: Theme,
    pub(crate) controls: Controls,
    pub(crate) ease: Duration,
    pub(crate) title: Option<Arc<str>>,
    pub(crate) subtitle: Option<Arc<str>>,
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
            title: None,
            subtitle: None,
        }
    }

    /// Draws `mark` over the marks before it.
    #[must_use]
    pub fn draw(mut self, mark: impl Into<Mark>) -> Scene {
        self.marks.push(mark.into());
        self
    }

    /// Places vertices that have no position. Diagrams only.
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

    /// Writes `title` at the view's top left, in the theme's text and font, larger.
    #[must_use]
    pub fn title(mut self, title: impl Into<Arc<str>>) -> Scene {
        self.title = Some(title.into());
        self
    }

    /// Writes `subtitle` under the title.
    #[must_use]
    pub fn subtitle(mut self, subtitle: impl Into<Arc<str>>) -> Scene {
        self.subtitle = Some(subtitle.into());
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

    /// Checks the scene against complete datasets without creating a GPU. Uses the same expression
    /// compiler as a view, but requires every drawn dataset and table to be present.
    pub fn validate(&self, data: &[Data]) -> Result<()> {
        self.check()?;
        for (i, item) in data.iter().enumerate() {
            if data[..i].iter().any(|other| other.name() == item.name()) {
                return Err(Error::invalid("duplicate dataset name").at(i).at("data"));
            }
        }
        for (i, mark) in self.marks.iter().enumerate() {
            let style = mark.style();
            let dataset = data.iter().find(|d| *d.name() == style.data).ok_or_else(|| {
                Error::invalid(format!("dataset '{}' was not supplied", style.data)).at("data").at(i).at("marks")
            })?;
            if dataset.table(&style.table).is_none() {
                return Err(Error::invalid(format!("table '{}' is absent from '{}'", style.table, style.data))
                    .at("table")
                    .at(i)
                    .at("marks"));
            }
            compile::compile(mark, data, mark::Context { theme: &self.theme, space: &self.space })
                .map_err(|error| error.at(i).at("marks"))?;
        }
        Ok(())
    }

    /// Two marks with one key would be indistinguishable across scenes; options a space does not have
    /// are refused.
    pub(crate) fn check(&self) -> Result<()> {
        let diagram = matches!(self.space, Space::Diagram(_));
        if !diagram && self.layout != Layout::None {
            return Err(Error::invalid("only a diagram lays out vertices").at("layout"));
        }
        for (i, mark) in self.marks.iter().enumerate() {
            if self.marks[..i].iter().any(|m| m.key() == mark.key()) {
                let reason = "draws the same table as an earlier mark of its kind; give one a name with named";
                return Err(Error::invalid(reason).at(i).at("marks"));
            }
            if let Some((option, reason)) = mark.misplaced(diagram) {
                return Err(Error::invalid(reason).at(option).at(i).at("marks"));
            }
            let style = mark.style();
            let colors = style.color.as_ref().and_then(Expr::colormap_of);
            if style.legend.is_some() && !matches!(colors, Some((_, Some(_)))) {
                let reason = "a legend shows a color mapped through a colormap with a domain";
                return Err(Error::invalid(reason).at("legend").at(i).at("marks"));
            }
        }
        Ok(())
    }
}
