//! The title and legends a view draws beside or over its marks.

use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer};

use super::form::{Text, text_or, text_schema};

/// Where a title or legend sits. A side (`top`, `right`, `bottom`, or `left`) takes room from the
/// marks, which stay clear of it. A corner sits over the marks, on a backdrop of the theme's
/// background. Either way, the pointer reaches no row under it. A title and legends in one place
/// stack in scene order, the title first.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Place {
    /// Above the marks.
    Top,
    /// Right of the marks.
    Right,
    /// Below the marks.
    Bottom,
    /// Left of the marks.
    Left,
    /// Over the marks, at the top left.
    TopLeft,
    /// Over the marks, at the top right.
    TopRight,
    /// Over the marks, at the bottom left.
    BottomLeft,
    /// Over the marks, at the bottom right.
    BottomRight,
}

/// A scene's title: its text, or options with its text, a subtitle, and a place.
///
/// ```
/// # use latkit::{Place, Plot, Scene, Title};
/// let scene = Scene::new(Plot::default()).title(Title::new("Frequency").subtitle("Bus 101").place(Place::Top));
/// ```
#[derive(Clone, PartialEq, Debug, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = text_schema)]
pub struct Title {
    /// The title, in the theme's text color and font, 1.75 times its size.
    pub(crate) text: Arc<str>,
    /// A line under the title, fainter and 1.1 times the theme's text size.
    #[serde(default)]
    pub(crate) subtitle: Option<Arc<str>>,
    /// Where the title sits. Defaults to `top` on a plot and `top-left` elsewhere.
    #[serde(default)]
    pub(crate) place: Option<Place>,
}

impl Title {
    /// A title of `text`, in its default place.
    pub fn new(text: impl Into<Arc<str>>) -> Title {
        Title { text: text.into(), subtitle: None, place: None }
    }

    /// Sets a line under the title.
    #[must_use]
    pub fn subtitle(mut self, subtitle: impl Into<Arc<str>>) -> Title {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// Sets where the title sits.
    #[must_use]
    pub fn place(mut self, place: Place) -> Title {
        self.place = Some(place);
        self
    }
}

impl From<&str> for Title {
    fn from(text: &str) -> Title {
        Title::new(text)
    }
}

impl From<String> for Title {
    fn from(text: String) -> Title {
        Title::new(text)
    }
}

impl From<Arc<str>> for Title {
    fn from(text: Arc<str>) -> Title {
        Title::new(text)
    }
}

impl Text for Title {
    fn of_text(text: &str) -> Title {
        Title::new(text)
    }

    fn options<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Title, D::Error> {
        Title::deserialize(deserializer)
    }
}

impl<'de> Deserialize<'de> for Title {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Title, D::Error> {
        text_or(deserializer)
    }
}

/// A legend of a mark's colors: its title, or options with a title, a unit, and a place. It shows
/// a ticked bar of the colormap across its domain, a cell for each category, or a swatch beside
/// each name in the colormap's `categories`. The mark's `color` must map through a colormap with a
/// fixed domain or named categories. In a conditional, `otherwise` is searched before the cases.
///
/// On the left or right, a bar stands upright beside the marks. Elsewhere it lies flat.
///
/// ```
/// # use latkit::{Colormap, Legend, Place, Vertices, field};
/// let voltage = field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05);
/// let buses = Vertices::of("grid", "Bus").color(voltage).legend(Legend::new("Voltage").unit(" pu").place(Place::Right));
/// ```
#[derive(Clone, PartialEq, Debug, Default, Deserialize, JsonSchema)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
#[schemars(transform = text_schema)]
pub struct Legend {
    /// The title over the legend.
    #[serde(default)]
    pub(crate) title: Option<Arc<str>>,
    /// Text written after the last tick's value of a bar, such as `" pu"` or `"%"`.
    #[serde(default)]
    pub(crate) unit: Option<Arc<str>>,
    /// Where the legend sits. Defaults to `right` on a plot and `bottom-right` elsewhere.
    #[serde(default)]
    pub(crate) place: Option<Place>,
}

impl Legend {
    /// A legend titled `title`, in its default place.
    pub fn new(title: impl Into<Arc<str>>) -> Legend {
        Legend { title: Some(title.into()), unit: None, place: None }
    }

    /// Sets the text written after the last tick's value of a bar, such as `" pu"` or `"%"`.
    #[must_use]
    pub fn unit(mut self, unit: impl Into<Arc<str>>) -> Legend {
        self.unit = Some(unit.into());
        self
    }

    /// Sets where the legend sits.
    #[must_use]
    pub fn place(mut self, place: Place) -> Legend {
        self.place = Some(place);
        self
    }
}

impl From<&str> for Legend {
    fn from(title: &str) -> Legend {
        Legend::new(title)
    }
}

impl From<String> for Legend {
    fn from(title: String) -> Legend {
        Legend::new(title)
    }
}

impl From<Arc<str>> for Legend {
    fn from(title: Arc<str>) -> Legend {
        Legend::new(title)
    }
}

impl Text for Legend {
    fn of_text(text: &str) -> Legend {
        Legend::new(text)
    }

    fn options<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Legend, D::Error> {
        Legend::deserialize(deserializer)
    }
}

impl<'de> Deserialize<'de> for Legend {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Legend, D::Error> {
        text_or(deserializer)
    }
}
