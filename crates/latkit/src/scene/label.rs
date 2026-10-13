use crate::Expr;

/// A row's text, placed beside, inside, or along what its mark draws. Labels that would overlap give
/// way by priority, and those already shown keep their place.
///
/// ```
/// # use latkit::{field, Label, Vertices};
/// let buses = Vertices::of("grid", "Bus").position("lon", "lat").label(Label::new("name").priority(field("kv")));
/// ```
#[derive(Clone, PartialEq, Debug)]
pub struct Label {
    pub(crate) text: Expr,
    pub(crate) size: Option<f32>,
    pub(crate) color: Option<Expr>,
    pub(crate) priority: Expr,
    pub(crate) max_width: Option<f32>,
}

impl Label {
    /// Labels each row with a text field's value.
    pub fn new(text: impl Into<Expr>) -> Label {
        Label { text: text.into(), size: None, color: None, priority: 0.0.into(), max_width: None }
    }

    /// Text size, CSS pixels; the theme's font size unless set.
    #[must_use]
    pub fn size(mut self, px: f32) -> Label {
        self.size = Some(px);
        self
    }

    /// Each row's text color; the theme's text color unless set.
    #[must_use]
    pub fn color(mut self, color: impl Into<Expr>) -> Label {
        self.color = Some(color.into());
        self
    }

    /// Each row's priority: where labels would overlap, the higher shows.
    #[must_use]
    pub fn priority(mut self, priority: impl Into<Expr>) -> Label {
        self.priority = priority.into();
        self
    }

    /// CSS pixels a line of text runs to before it wraps.
    #[must_use]
    pub fn max_width(mut self, px: f32) -> Label {
        self.max_width = Some(px);
        self
    }
}
