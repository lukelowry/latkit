//! Scenes: plain data that describes what a view draws. Each mark names a dataset, and the view
//! draws it from the sources it is given.

pub(crate) mod areas;
pub(crate) mod compile;
mod controls;
mod edges;
mod faces;
mod form;
mod guide;
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

use std::time::Duration;

pub use areas::Areas;
pub use controls::{Controls, Motion, Zoom};
pub use edges::Edges;
pub use faces::Faces;
pub(crate) use form::seconds;
pub use guide::{Legend, Place, Title};
pub use label::Label;
pub use layout::{Direction, Interpolation, Layered, Layout, Route, Stress};
pub use lines::Lines;
pub use mark::Mark;
pub use marker::{Marker, Shape};
pub use port::{Port, Side};
pub(crate) use space::sun;
pub use space::{Axis, Diagram, Earth, Grid, Plane, Plot, Projection, Space};
pub use theme::{
    AreaTheme, DiagramTheme, EarthTheme, EdgeTheme, FlowTheme, FocusTheme, Length, LineTheme, PlotTheme, ShadowTheme,
    TextTheme, Theme, VertexTheme,
};
pub use vertices::Vertices;

use self::mark::MarkKind;
use crate::{Error, Path, Result, Snapshot, Source, Step};

/// A view's content and behavior: a space, marks drawn in order, a layout, a theme, controls, an
/// ease duration, and an optional title.
///
/// A scene is plain data. In JSON, fields are camelCase, and the key naming each mark's kind holds
/// its dataset and table: `{ "vertices": ["grid", "Bus"], "radius": 4 }`. An option that can't be
/// read, or that the scene can't use, draws as if unset, and views list why in their
/// [`failures`](crate::View::failures).
///
/// ```
/// # use latkit::{Colormap, Edges, Earth, Projection, Scene, Vertices, field};
/// let voltage = field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05);
/// let buses = Vertices::of("grid", "Bus").position(field("lon"), field("lat")).color(voltage);
/// let scene = Scene::new(Earth::default().projection(Projection::Globe))
///     .draw(Edges::of("grid", "Branch").ends("from", "to"))
///     .draw(buses.legend("Bus voltage"))
///     .title("Voltage");
/// ```
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    /// The coordinate space positions are in.
    pub(crate) space: Space,
    /// The marks, in drawing order: each draws over the marks before it.
    #[serde(default)]
    pub(crate) marks: Vec<Mark>,
    /// How the view places vertex rows that have no position, such as a diagram's blocks or points
    /// on a plane or the earth. Defaults to `none`.
    #[serde(default)]
    pub(crate) layout: Layout,
    /// Default colors and sizes, and the look of text, focus, and each space. Defaults to `dark`.
    #[serde(default)]
    pub(crate) theme: Theme,
    /// How the view responds to the pointer and keyboard.
    #[serde(default)]
    pub(crate) controls: Controls,
    /// How many seconds scene and data changes take to animate. 0 turns animation off. Defaults to
    /// 0.3.
    #[serde(default = "ease", deserialize_with = "form::seconds")]
    #[schemars(with = "f64")]
    pub(crate) ease: Duration,
    /// The title: its text, or title options.
    #[serde(default)]
    pub(crate) title: Option<Title>,
    /// Why options read from JSON were left out, each at its path.
    #[serde(skip)]
    #[schemars(skip)]
    pub(crate) unread: Vec<Error>,
}

/// Reads a scene, leaving out each option it can't read and keeping why. Fails only when the scene
/// isn't an object, or its space, its marks, or a mark's dataset and table can't be read.
impl<'de> serde::Deserialize<'de> for Scene {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Scene, D::Error> {
        let form = serde_json::Value::deserialize(deserializer)?;
        let (Strict(mut scene), unread) = crate::json::lenient(form, option)?;
        scene.unread = unread;
        Ok(scene)
    }
}

/// A scene read as serde derives it, failing on the first option it can't read.
struct Strict(Scene);

impl<'de> serde::Deserialize<'de> for Strict {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Strict, D::Error> {
        Scene::deserialize(deserializer).map(Strict)
    }
}

/// The option to leave out of a scene for an error at `path`: the path cut short at the option it
/// lies in. `None` when the scene can't be read without that part: its space, its marks, a mark, or
/// a mark's dataset and table.
fn option(path: &Path) -> Option<Path> {
    let steps = &path.0;
    let name = |i: usize| match steps.get(i) {
        Some(Step::Name(name)) => Some(name.as_str()),
        _ => None,
    };
    let (least, most) = match name(0)? {
        "marks" if name(2).is_some_and(|key| MarkKind::ALL.iter().any(|kind| kind.name() == key)) => return None,
        "marks" => (3, if matches!(name(2), Some("label" | "legend")) { 4 } else { 3 }),
        "space" => (3, if name(1) == Some("plot") { 4 } else { 3 }),
        "theme" | "layout" => (1, 3),
        "title" | "controls" => (1, 2),
        _ => (1, 1),
    };
    (steps.len() >= least).then(|| Path(steps[..steps.len().min(most)].to_vec()))
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
            unread: Vec::new(),
        }
    }

    /// Adds `mark`, drawn over the marks added before it.
    #[must_use]
    pub fn draw(mut self, mark: impl Into<Mark>) -> Scene {
        self.marks.push(mark.into());
        self
    }

    /// Sets the layout that places vertex rows without a position, such as a diagram's blocks or
    /// points on a plane or the earth.
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

    /// Sets how long scene and data changes take to animate. Zero applies them at once. Defaults to
    /// 0.3 s.
    #[must_use]
    pub fn ease(mut self, over: Duration) -> Scene {
        self.ease = over;
        self
    }

    /// Sets the [`Title`]: its text, or title options.
    #[must_use]
    pub fn title(mut self, title: impl Into<Title>) -> Scene {
        self.title = Some(title.into());
        self
    }

    /// The scene's space.
    pub fn space(&self) -> &Space {
        &self.space
    }

    /// What a view drawing this scene from `sources` lists in its
    /// [`failures`](crate::View::failures), found without a GPU, and each mark whose dataset no
    /// source provides. A mark of a dataset from [`Source::Tiles`] is checked as its tiles arrive,
    /// so it is left out. Errors when two sources share a name.
    pub fn failures(&self, sources: &[Source]) -> Result<Vec<Error>> {
        for (i, source) in sources.iter().enumerate() {
            if sources[..i].iter().any(|other| other.name() == source.name()) {
                return Err(Error::invalid(format!("two sources named '{}'", source.name())).at(i).at("sources"));
            }
        }
        let mut scene = self.clone();
        let mut failures = std::mem::take(&mut scene.unread);
        failures.extend(scene.sanitize());
        let snapshots: Vec<Snapshot> = sources
            .iter()
            .filter_map(|source| match source {
                Source::Data(data) => Some(data.snapshot()),
                Source::Snapshot(snapshot) => Some(snapshot.clone()),
                Source::Tiles(_) => None,
            })
            .collect();
        let context = mark::Context { theme: &scene.theme, space: &scene.space, layout: &scene.layout };
        for (i, mark) in scene.marks.iter().enumerate() {
            let at = |error: Error| error.at(i).at("marks");
            let style = mark.style();
            if scene.twin(i) {
                failures.push(at(twin()));
                continue;
            }
            if sources.iter().any(|s| matches!(s, Source::Tiles(t) if *t.name() == style.data)) {
                continue;
            }
            let Some(dataset) = snapshots.iter().find(|d| *d.name() == style.data) else {
                let reason = format!("no source provides dataset '{}'", style.data);
                failures.push(at(Error::invalid(reason).at(mark.kind().name())));
                continue;
            };
            if let Some(error) = mark.absent_from(dataset) {
                failures.push(at(error));
                continue;
            }
            match compile::compile(mark, &snapshots, context) {
                Ok(Some(compiled)) => failures.extend(compiled.failures.into_iter().map(at)),
                Ok(None) => {}
                Err(error) => failures.push(at(error)),
            }
        }
        Ok(failures)
    }

    /// Resets each option the scene can't use to its default, and returns why, each at its path: a
    /// plot's layout, comet lengths in two units, options the space lacks, and legends without a
    /// colormap to show.
    pub(crate) fn sanitize(&mut self) -> Vec<Error> {
        let mut failures = Vec::new();
        if matches!(self.space, Space::Plot(_)) && self.layout != Layout::None {
            self.layout = Layout::None;
            failures.push(Error::invalid("a plot cannot have a layout").at("layout"));
        }
        let flow = &mut self.theme.flow;
        if !flow.spacing.alike(flow.length) {
            let base = Theme::dark().flow;
            (flow.spacing, flow.length) = (base.spacing, base.length);
            let reason = "comet spacing and length must use the same unit, which each row's flow also uses";
            failures.push(Error::invalid(reason).at("length").at("flow").at("theme"));
        }
        let diagram = matches!(self.space, Space::Diagram(_));
        for (i, mark) in self.marks.iter_mut().enumerate() {
            for (option, reason) in mark.unplace(diagram) {
                failures.push(Error::invalid(reason).at(option).at(i).at("marks"));
            }
            let style = mark.style_mut();
            if style.legend.is_some() && style.color.as_ref().and_then(crate::Expr::colormap_of).is_none() {
                style.legend = None;
                let reason = "a legend needs a color mapped through a colormap";
                failures.push(Error::invalid(reason).at("legend").at(i).at("marks"));
            }
        }
        failures
    }

    /// Whether mark `i` has the key of an earlier mark: the same kind, table, and name. Views can't
    /// tell the two apart across scenes, so it draws nothing.
    pub(crate) fn twin(&self, i: usize) -> bool {
        let key = self.marks[i].key();
        self.marks[..i].iter().any(|m| m.key() == key)
    }
}

/// Why a [twin](Scene::twin) mark draws nothing.
pub(crate) fn twin() -> Error {
    Error::invalid("draws the same table as an earlier mark of its kind. Give one a `name`.")
}
