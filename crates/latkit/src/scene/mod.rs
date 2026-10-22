//! Scenes: what a view draws, as plain data. Marks name their data; the view is given the data.

pub(crate) mod areas;
pub(crate) mod compile;
mod controls;
mod edges;
mod faces;
mod form;
mod label;
mod layout;
pub(crate) mod lines;
pub(crate) mod mark;
mod marker;
mod port;
mod space;
#[cfg(test)]
mod tests;
mod theme;
mod vertices;

use std::sync::Arc;
use std::time::Duration;

pub use areas::Areas;
pub use controls::{Controls, Motion, Zoom};
pub use edges::Edges;
pub use faces::Faces;
pub(crate) use form::seconds;
pub use label::Label;
pub use layout::{Direction, Interpolation, Layered, Layout, Route, Stress};
pub use lines::Lines;
pub use mark::Mark;
pub use marker::{Marker, Shape};
pub use port::{Port, Side};
pub(crate) use space::sun;
pub use space::{Axis, Diagram, Earth, Format, Grid, Plane, Plot, Projection, Space};
pub use theme::{Flow, Shadow, Theme};
pub use vertices::Vertices;

use crate::{Data, Error, Expr, Result};

/// What a view draws and how it answers input: a space, marks in drawing order, a layout, a theme,
/// controls, how long changes ease, and the title written over it. Plain data: as JSON, each field by
/// its name in camelCase, each mark `{ vertices | edges | faces | lines | areas: options }`.
///
/// ```
/// # use latkit::{Colormap, Edges, Earth, Scene, Vertices, field};
/// let voltage = field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05);
/// let scene = Scene::new(Earth::globe())
///     .draw(Edges::of("grid", "Branch").ends("from", "to"))
///     .draw(Vertices::of("grid", "Bus").position("lon", "lat").color(voltage).legend("Bus voltage · pu"))
///     .title("Voltage");
/// ```
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    pub(crate) space: Space,
    /// What the view draws, in drawing order.
    #[serde(default)]
    pub(crate) marks: Vec<Mark>,
    /// How the view places vertex rows without positions: a diagram's blocks, or points on a plane
    /// or the earth, gaps in the space's units.
    #[serde(default)]
    pub(crate) layout: Layout,
    #[serde(default)]
    pub(crate) theme: Theme,
    #[serde(default)]
    pub(crate) controls: Controls,
    /// Seconds that changes ease over; 0.3 unless set.
    #[serde(default = "ease", deserialize_with = "form::seconds")]
    #[schemars(with = "f64")]
    pub(crate) ease: Duration,
    /// Written at the view's top left, larger than the theme's text.
    #[serde(default)]
    pub(crate) title: Option<Arc<str>>,
    /// Written under the title.
    #[serde(default)]
    pub(crate) subtitle: Option<Arc<str>>,
}

/// How long changes ease unless set.
fn ease() -> Duration {
    Duration::from_millis(300)
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
            ease: ease(),
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

    /// Places vertex rows that have no position: a diagram's blocks, or points on a plane or the earth.
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

    /// Checks the scene against complete datasets without creating a GPU. Uses the same expression
    /// compiler as a view, but requires every drawn dataset and table to be present, but for the
    /// datasets `tiles` make, which a view fetches as it draws: their marks are checked once they do.
    pub fn validate(&self, data: &[Data], tiles: &[crate::Tiles]) -> Result<()> {
        self.check()?;
        for (i, item) in data.iter().enumerate() {
            if data[..i].iter().any(|other| other.name() == item.name()) {
                return Err(Error::invalid("duplicate dataset name").at(i).at("data"));
            }
        }
        for (i, mark) in self.marks.iter().enumerate() {
            let style = mark.style();
            if tiles.iter().any(|t| *t.name() == style.data) {
                continue;
            }
            let dataset = data.iter().find(|d| *d.name() == style.data).ok_or_else(|| {
                mark.within(i, Error::invalid(format!("dataset '{}' was not supplied", style.data)).at("of"))
            })?;
            if let Some(error) = mark.absent_from(dataset) {
                return Err(mark.within(i, error));
            }
            compile::compile(
                mark,
                data,
                mark::Context { theme: &self.theme, space: &self.space, layout: &self.layout },
            )
            .map_err(|error| mark.within(i, error))?;
        }
        Ok(())
    }

    /// Two marks with one key would be indistinguishable across scenes; options a space does not have
    /// are refused.
    pub(crate) fn check(&self) -> Result<()> {
        let diagram = matches!(self.space, Space::Diagram(_));
        if matches!(self.space, Space::Plot(_)) && self.layout != Layout::None {
            return Err(Error::invalid("a plot lays out no vertices").at("layout"));
        }
        for (i, mark) in self.marks.iter().enumerate() {
            if self.marks[..i].iter().any(|m| m.key() == mark.key()) {
                let reason = "draws the same table as an earlier mark of its kind; give one a `name`";
                return Err(Error::invalid(reason).at(i).at("marks"));
            }
            if let Some((option, reason)) = mark.misplaced(diagram) {
                return Err(mark.within(i, Error::invalid(reason).at(option)));
            }
            let style = mark.style();
            let shown = match style.color.as_ref().and_then(Expr::colormap_of) {
                Some((colormap, domain)) => domain.is_some() || !colormap.named_categories().is_empty(),
                None => false,
            };
            if style.legend.is_some() && !shown {
                let reason = "a legend shows a color mapped through a colormap with a domain or named categories";
                return Err(mark.within(i, Error::invalid(reason).at("legend")));
            }
        }
        Ok(())
    }
}
