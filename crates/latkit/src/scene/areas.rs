use super::mark::{Context, Drawing, GEOMETRY, MarkKind, Style, mark, style_methods};
use crate::expr::compile::{Compiler, Store};
use crate::gpu::shaders as wgsl;
use crate::{Error, Kind, Name, Result};

mark!(
/// Rows drawn as the areas of a polygon field: parcels, states, lakes, the land and water of a map.
/// The view triangulates each row's polygons once, in the background when they are large. On the
/// earth, areas follow the globe's curve and stay whole across the antimeridian. To outline areas,
/// add a [`Lines`](crate::Lines) mark of the same table, which draws their rings.
///
/// ```
/// # use latkit::{field, Areas, Colormap};
/// let states = Areas::of("map", "states").color(field("load").colormap(Colormap::MAKO));
/// ```
Areas {
    /// The polygon field each row fills, holding one polygon's rings or several polygons; the field
    /// named `geometry` by default.
    geometry: Option<Name>,
});

impl Areas {
    /// Draws the rows of `table` in dataset `data`.
    pub fn of(data: impl Into<Name>, table: impl Into<Name>) -> Areas {
        Areas { style: Style::new(data.into(), table.into()), geometry: None }
    }

    /// Sets the polygon field each row fills, holding one polygon's rings or several polygons; the
    /// field named `geometry` by default.
    #[must_use]
    pub fn geometry(mut self, field: impl Into<Name>) -> Areas {
        self.geometry = Some(field.into());
        self
    }

    /// The polygon field each row fills.
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
        let mut drawing = Drawing::new(MarkKind::Areas);
        drawing.geometry = c.derived_path(&triangles_of(&field));
        Ok(drawing)
    }
}

/// The name of the derived field holding polygon field `field`'s triangles: for each row, the point
/// its label anchors to, then three points per triangle.
pub(crate) fn triangles_of(field: &str) -> Name {
    format!("{field}.triangles").into()
}

style_methods!(Areas);
