//! Scenes: plain-data descriptions of a view's content. Marks name their datasets, and the view
//! draws them from the sources it is given.

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
pub use theme::{
    AreaTheme, DiagramTheme, EarthTheme, EdgeTheme, FlowTheme, FocusTheme, Length, LineTheme, PlotTheme, ShadowTheme,
    TextTheme, Theme, VertexTheme,
};
pub use vertices::Vertices;

use crate::{Error, Result, Snapshot, Source};

/// A view's content and behavior: a space, marks drawn in order, a layout, a theme, controls, an
/// ease duration, and an optional title.
///
/// A scene is plain data. In JSON, fields are camelCase, and the key naming each mark's kind holds
/// its dataset and table: `{ "vertices": ["grid", "Bus"], "radius": 4 }`.
///
/// ```
/// # use latkit::{Colormap, Edges, Earth, Projection, Scene, Vertices, field};
/// let voltage = field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05);
/// let buses = Vertices::of("grid", "Bus").position(field("lon"), field("lat")).color(voltage);
/// let scene = Scene::new(Earth::default().projection(Projection::Globe))
///     .draw(Edges::of("grid", "Branch").ends("from", "to"))
///     .draw(buses.legend("Bus voltage · pu"))
///     .title("Voltage");
/// ```
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    /// The coordinate space positions are in.
    pub(crate) space: Space,
    /// The marks, in drawing order: each draws over the marks before it.
    #[serde(default)]
    pub(crate) marks: Vec<Mark>,
    /// How the view places vertex rows that have no position: a diagram's blocks, or points on a
    /// plane or the earth. `none` by default.
    #[serde(default)]
    pub(crate) layout: Layout,
    /// Default colors and sizes, and the look of text, focus, and each space; `dark` by default.
    #[serde(default)]
    pub(crate) theme: Theme,
    /// How the view responds to the pointer and keyboard.
    #[serde(default)]
    pub(crate) controls: Controls,
    /// Seconds over which scene and data changes animate; 0.3 by default, 0 for none.
    #[serde(default = "ease", deserialize_with = "form::seconds")]
    #[schemars(with = "f64")]
    pub(crate) ease: Duration,
    /// A title drawn at the view's top left, larger than the theme's text.
    #[serde(default)]
    pub(crate) title: Option<Arc<str>>,
    /// A subtitle drawn under the title.
    #[serde(default)]
    pub(crate) subtitle: Option<Arc<str>>,
}

/// The default ease duration.
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

    /// Adds `mark`, drawn over the marks added before it.
    #[must_use]
    pub fn draw(mut self, mark: impl Into<Mark>) -> Scene {
        self.marks.push(mark.into());
        self
    }

    /// Sets the layout that places vertex rows without a position: a diagram's blocks, or points on
    /// a plane or the earth.
    #[must_use]
    pub fn layout(mut self, layout: impl Into<Layout>) -> Scene {
        self.layout = layout.into();
        self
    }

    /// Sets the theme.
    #[must_use]
    pub fn theme(mut self, theme: Theme) -> Scene {
        self.theme = theme;
        self
    }

    /// Sets how the view responds to the pointer and keyboard.
    #[must_use]
    pub fn controls(mut self, controls: Controls) -> Scene {
        self.controls = controls;
        self
    }

    /// Sets how long scene and data changes animate; zero applies them at once. Default 0.3 s.
    #[must_use]
    pub fn ease(mut self, over: Duration) -> Scene {
        self.ease = over;
        self
    }

    /// Sets a title drawn at the view's top left, in the theme's text color and font but larger.
    #[must_use]
    pub fn title(mut self, title: impl Into<Arc<str>>) -> Scene {
        self.title = Some(title.into());
        self
    }

    /// Sets a subtitle drawn under the title.
    #[must_use]
    pub fn subtitle(mut self, subtitle: impl Into<Arc<str>>) -> Scene {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// The scene's space.
    pub fn space(&self) -> &Space {
        &self.space
    }

    /// Checks the scene against `sources` without a GPU, with the same compiler a view uses.
    ///
    /// Every drawn dataset and table must be present, except datasets that a [`Source::Tiles`]
    /// gives: a view fetches those while drawing, so their marks are checked as tiles arrive.
    /// Errors on duplicate source names, missing datasets or tables, options a mark cannot compile,
    /// and anything else the scene itself gets wrong, such as two marks with one key.
    pub fn validate(&self, sources: &[Source]) -> Result<()> {
        self.check()?;
        for (i, source) in sources.iter().enumerate() {
            if sources[..i].iter().any(|other| other.name() == source.name()) {
                return Err(Error::invalid(format!("two sources named '{}'", source.name())).at(i).at("sources"));
            }
        }
        let snapshots: Vec<Snapshot> = sources
            .iter()
            .filter_map(|source| match source {
                Source::Data(data) => Some(data.snapshot()),
                Source::Snapshot(snapshot) => Some(snapshot.clone()),
                Source::Tiles(_) => None,
            })
            .collect();
        for (i, mark) in self.marks.iter().enumerate() {
            let style = mark.style();
            if sources.iter().any(|s| matches!(s, Source::Tiles(t) if *t.name() == style.data)) {
                continue;
            }
            let dataset = snapshots.iter().find(|d| *d.name() == style.data).ok_or_else(|| {
                let reason = format!("no source provides dataset '{}'", style.data);
                Error::invalid(reason).at(mark.kind().name()).at(i).at("marks")
            })?;
            if let Some(error) = mark.absent_from(dataset) {
                return Err(error.at(i).at("marks"));
            }
            compile::compile(
                mark,
                &snapshots,
                mark::Context { theme: &self.theme, space: &self.space, layout: &self.layout },
            )
            .map_err(|error| error.at(i).at("marks"))?;
        }
        Ok(())
    }

    /// Checks the scene's own consistency, which needs no data. Errors when a plot has a layout,
    /// when the theme's comet spacing and length use different units, when two marks share a key
    /// (they would be indistinguishable across scenes), when a mark uses an option its space lacks,
    /// and when a legend has no colormap with a fixed domain or named categories to show.
    pub(crate) fn check(&self) -> Result<()> {
        let diagram = matches!(self.space, Space::Diagram(_));
        if matches!(self.space, Space::Plot(_)) && self.layout != Layout::None {
            return Err(Error::invalid("a plot cannot have a layout").at("layout"));
        }
        let flow = &self.theme.flow;
        if !flow.spacing.alike(flow.length) {
            let reason = "comet spacing and length must use the same unit, which each row's flow also uses";
            return Err(Error::invalid(reason).at("length").at("flow").at("theme"));
        }
        for (i, mark) in self.marks.iter().enumerate() {
            if self.marks[..i].iter().any(|m| m.key() == mark.key()) {
                let reason = "draws the same table as an earlier mark of its kind; give one a `name`";
                return Err(Error::invalid(reason).at(i).at("marks"));
            }
            if let Some((option, reason)) = mark.misplaced(diagram) {
                return Err(Error::invalid(reason).at(option).at(i).at("marks"));
            }
            let style = mark.style();
            let shown = match style.color.as_ref().and_then(crate::Expr::colormap_of) {
                Some((colormap, domain)) => domain.is_some() || !colormap.named_categories().is_empty(),
                None => false,
            };
            if style.legend.is_some() && !shown {
                let reason = "a legend needs a color mapped through a colormap with a domain or named categories";
                return Err(Error::invalid(reason).at("legend").at(i).at("marks"));
            }
        }
        Ok(())
    }
}
