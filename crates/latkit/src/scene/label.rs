use std::sync::Arc;

use crate::Expr;

/// A row's text, placed beside, inside, or along what its mark draws, following it every frame.
/// Labels that would overlap give way by priority; among equals, those already shown keep their place. In a
/// diagram a label is part of the drawing: it scales with the zoom, fades out once too small to
/// read, and shows wherever it fits its vertex.
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
    pub(crate) priority: Option<Expr>,
    pub(crate) max_width: Option<f32>,
    pub(crate) font: Option<Arc<str>>,
    pub(crate) max: Option<u32>,
}

impl Label {
    /// Labels each row with a text field's value.
    pub fn new(text: impl Into<Expr>) -> Label {
        Label { text: text.into(), size: None, color: None, priority: None, max_width: None, font: None, max: None }
    }

    /// Text size, CSS pixels, or units in a diagram; the theme's font size unless set.
    #[must_use]
    pub fn size(mut self, size: f32) -> Label {
        self.size = Some(size);
        self
    }

    /// Each row's text color; the theme's text color unless set.
    #[must_use]
    pub fn color(mut self, color: impl Into<Expr>) -> Label {
        self.color = Some(color.into());
        self
    }

    /// Each row's priority: where labels would overlap, the higher shows. The mark's priority
    /// unless set.
    #[must_use]
    pub fn priority(mut self, priority: impl Into<Expr>) -> Label {
        self.priority = Some(priority.into());
        self
    }

    /// How far a line of text runs before it wraps: CSS pixels, or units in a diagram.
    #[must_use]
    pub fn max_width(mut self, width: f32) -> Label {
        self.max_width = Some(width);
        self
    }

    /// The CSS font family list its texts are set in; the theme's font unless set.
    #[must_use]
    pub fn font(mut self, font: impl Into<Arc<str>>) -> Label {
        self.font = Some(font.into());
        self
    }

    /// Shows at most `max` labels at once, those of highest priority among the rows in view; where
    /// they would overlap, fewer.
    #[must_use]
    pub fn max(mut self, max: u32) -> Label {
        self.max = Some(max);
        self
    }
}
