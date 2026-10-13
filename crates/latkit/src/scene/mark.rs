use super::{Edges, Vertices};
use crate::expr::compile::Compiler;
use crate::{Expr, Name, Result};

/// One drawn table of a scene.
#[derive(Clone, PartialEq, Debug)]
#[non_exhaustive]
pub enum Mark {
    /// Rows drawn as markers.
    Vertices(Vertices),
    /// Rows drawn as strokes between vertices.
    Edges(Edges),
}

impl From<Vertices> for Mark {
    fn from(mark: Vertices) -> Mark {
        Mark::Vertices(mark)
    }
}

impl From<Edges> for Mark {
    fn from(mark: Edges) -> Mark {
        Mark::Edges(mark)
    }
}

/// Options every mark has.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Style {
    pub(crate) data: Name,
    pub(crate) table: Name,
    pub(crate) color: Option<Expr>,
    pub(crate) visible: Expr,
    pub(crate) name: Option<Name>,
}

impl Style {
    pub(crate) fn new(data: Name, table: Name) -> Style {
        Style { data, table, color: None, visible: true.into(), name: None }
    }
}

/// What a scene's marks are drawn as.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum MarkKind {
    Vertices,
    Edges,
}

/// Identifies a mark across scenes: a new scene's mark with the same key eases from the old one.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Key {
    pub(crate) kind: MarkKind,
    pub(crate) data: Name,
    pub(crate) table: Name,
    pub(crate) name: Option<Name>,
}

/// What a compiled mark draws with, besides its program.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) struct Drawing {
    pub(crate) kind: MarkKind,
    /// State words per row.
    pub(crate) stride: u32,
    pub(crate) flags: u32,
    pub(crate) marker: (u32, u32, f32),
}

impl Mark {
    pub(crate) fn style(&self) -> &Style {
        match self {
            Mark::Vertices(m) => &m.style,
            Mark::Edges(m) => &m.style,
        }
    }

    pub(crate) fn key(&self) -> Key {
        let style = self.style();
        let kind = match self {
            Mark::Vertices(_) => MarkKind::Vertices,
            Mark::Edges(_) => MarkKind::Edges,
        };
        Key { kind, data: style.data.clone(), table: style.table.clone(), name: style.name.clone() }
    }

    pub(crate) fn compile(&self, compiler: &mut Compiler<'_>, theme: &super::Theme) -> Result<Drawing> {
        match self {
            Mark::Vertices(m) => m.compile(compiler),
            Mark::Edges(m) => m.compile(compiler, theme),
        }
    }
}

/// The options every mark has, as inherent methods.
macro_rules! style_methods {
    ($mark:ty) => {
        impl $mark {
            /// Each row's color.
            #[must_use]
            pub fn color(mut self, color: impl Into<$crate::Expr>) -> Self {
                self.style.color = Some(color.into());
                self
            }

            /// Whether each row is drawn and picked.
            #[must_use]
            pub fn visible(mut self, visible: impl Into<$crate::Expr>) -> Self {
                self.style.visible = visible.into();
                self
            }

            /// Names the mark, so two marks of one table can be told apart across scenes.
            #[must_use]
            pub fn named(mut self, name: impl Into<$crate::Name>) -> Self {
                self.style.name = Some(name.into());
                self
            }
        }
    };
}

pub(crate) use style_methods;
