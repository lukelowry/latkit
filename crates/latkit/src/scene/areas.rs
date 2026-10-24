use super::mark::{Context, Drawing, GEOMETRY, MarkKind, Style, mark, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Kind, Name, Result};

mark!(
/// Rows drawn as the areas a polygon field holds: parcels, states, lakes, the land and water of a
/// map. The view cuts each row's polygons into triangles once, off the frame when they are large;
/// on the earth they bend with the globe and stay whole across the antimeridian. Outline areas with
/// a [`Lines`](crate::Lines) mark of the same table, which draws their rings.
///
/// ```
/// # use latkit::{field, Areas, Colormap};
/// let states = Areas::of("map", "states").color(field("load").colormap(Colormap::MAKO));
/// ```
Areas {
    /// The polygon field each row fills: one polygon's rings, or polygons. `geometry` unless set.
    geometry: Option<Name>,
});

impl Areas {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Areas {
        Areas { style: Style::new(data.into(), table.into()), geometry: None }
    }

    /// The polygon field each row fills: one polygon's rings, or polygons. Unless set, the field
    /// `geometry`.
    #[must_use]
    pub fn geometry(mut self, field: impl Into<Name>) -> Areas {
        self.geometry = Some(field.into());
        self
    }

    /// The field each row fills.
    pub(crate) fn field(&self) -> Name {
        self.geometry.clone().unwrap_or_else(|| GEOMETRY.into())
    }

    pub(crate) fn compile(&self, c: &mut Compiler<'_>, _: Context<'_>) -> Result<Drawing> {
        let field = self.field();
        match c.kind(&field) {
            Some(Kind::Parts | Kind::Polygons) => {}
            Some(_) => return Err(Error::invalid("not a polygon field").at(&field).at("geometry")),
            None if self.geometry.is_some() => return Err(Error::invalid("no such field").at(&field).at("geometry")),
            None => return Err(Error::invalid("name the polygon field each row fills").at("geometry")),
        }
        let color = Store::Color { word: wgsl::AREA_COLOR, fallback: wgsl::THEME_AREA };
        match &self.style.color {
            Some(paint) => c.channel("color", &paint.0, color)?,
            None => c.theme("color", wgsl::THEME_AREA, color)?,
        }
        c.channel("visible", &self.style.visible, Store::Flag { word: wgsl::AREA_FLAGS, bit: wgsl::VISIBLE })?;
        let mut drawing = Drawing::new(MarkKind::Areas, wgsl::AREA_WORDS);
        drawing.geometry = c.derived_path(&triangles_of(&field));
        Ok(drawing)
    }
}

/// The derived field holding the triangles of polygon field `field`: per row the point its label
/// hangs from, then three points per triangle.
pub(crate) fn triangles_of(field: &str) -> Name {
    format!("{field}.triangles").into()
}

style_methods!(Areas);
