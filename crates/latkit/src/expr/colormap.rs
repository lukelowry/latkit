use std::borrow::Cow;
use std::sync::Arc;

use super::Color;
use super::ramp::{self, Spread};
#[cfg(feature = "gpu")]
use crate::gpu::shaders as wgsl;
use crate::{Error, Result};

/// Colors for a range of values: a catalog colormap or a custom one.
///
/// Sequential and diverging maps clamp, cyclic maps wrap, and categorical maps bin values by their
/// integer part: category `i` takes color `i`. [`Colormap::values`] bins by value instead, a number
/// or a text for each category, and [`Colormap::categories`] names the categories.
#[derive(Clone, PartialEq, Debug)]
pub struct Colormap(Map);

#[derive(Clone, PartialEq, Debug)]
enum Map {
    Catalog(u8),
    Custom(Arc<Custom>),
}

#[derive(PartialEq, Debug)]
struct Custom {
    kind: ColormapKind,
    count: u32,
    texels: [[u8; 4]; 256],
    categories: Vec<Arc<str>>,
    values: Vec<Category>,
}

/// A value that a category of a colormap or a case of [`Expr::matched`](crate::Expr::matched)
/// names: a number, which a row's value equals, or a text, which a row's text field equals exactly.
#[derive(Clone, PartialEq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(untagged)]
#[schemars(inline)]
pub enum Category {
    /// A number.
    Number(f64),
    /// A text.
    Text(Arc<str>),
}

impl Category {
    /// The value as a legend writes it.
    fn written(&self) -> Arc<str> {
        match self {
            Category::Number(number) => number.to_string().into(),
            Category::Text(text) => text.clone(),
        }
    }
}

impl From<f64> for Category {
    fn from(number: f64) -> Category {
        Category::Number(number)
    }
}

impl From<i32> for Category {
    fn from(number: i32) -> Category {
        Category::Number(f64::from(number))
    }
}

impl From<&str> for Category {
    fn from(text: &str) -> Category {
        Category::Text(text.into())
    }
}

impl From<Arc<str>> for Category {
    fn from(text: Arc<str>) -> Category {
        Category::Text(text)
    }
}

/// How a colormap maps values: `sequential` and `diverging` maps clamp, `cyclic` maps wrap, and
/// `categorical` maps give each integer its own color.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ColormapKind {
    /// Low to high.
    Sequential,
    /// Below and above a midpoint.
    Diverging,
    /// Around a circle: values wrap.
    Cyclic,
    /// Distinct colors for distinct integers.
    Categorical,
}

impl ColormapKind {
    fn spread(self) -> Spread {
        match self {
            ColormapKind::Sequential | ColormapKind::Diverging => Spread::Continuous,
            ColormapKind::Cyclic => Spread::Cyclic,
            ColormapKind::Categorical => Spread::Categorical,
        }
    }

    /// The code shaders identify it by.
    #[cfg(feature = "gpu")]
    pub(crate) fn code(self) -> u32 {
        match self {
            ColormapKind::Sequential => wgsl::COLORMAP_SEQUENTIAL,
            ColormapKind::Diverging => wgsl::COLORMAP_DIVERGING,
            ColormapKind::Cyclic => wgsl::COLORMAP_CYCLIC,
            ColormapKind::Categorical => wgsl::COLORMAP_CATEGORICAL,
        }
    }
}

/// A colormap color stop: a [`Color`], spaced evenly between its neighbors, or a `(place, Color)`
/// pair with a place from 0 to 1.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Stop {
    at: Option<f32>,
    color: Color,
}

impl From<Color> for Stop {
    fn from(color: Color) -> Stop {
        Stop { at: None, color }
    }
}

impl From<&Color> for Stop {
    fn from(color: &Color) -> Stop {
        Stop::from(*color)
    }
}

impl From<(f32, Color)> for Stop {
    fn from((at, color): (f32, Color)) -> Stop {
        Stop { at: Some(at), color }
    }
}

struct Entry {
    name: &'static str,
    label: &'static str,
    kind: ColormapKind,
    count: u32,
    texels: [[u8; 4]; 256],
}

include!(concat!(env!("OUT_DIR"), "/colormaps.rs"));

impl Colormap {
    /// Every catalog colormap, in order.
    pub fn catalog() -> impl Iterator<Item = Colormap> {
        (0..CATALOG.len()).map(|i| Colormap(Map::Catalog(i as u8)))
    }

    /// The catalog colormap named `name`, such as `"viridis"`. `None` if the catalog has none.
    pub fn named(name: &str) -> Option<Colormap> {
        CATALOG.iter().position(|e| e.name == name).map(|i| Colormap(Map::Catalog(i as u8)))
    }

    /// A colormap through `stops`, each a color or a `(place, color)` pair. Colors blend in OKLab,
    /// so lightness changes evenly. A color without a place sits evenly between its neighbors, like
    /// a CSS gradient. A categorical map takes one color per category.
    ///
    /// Errors when `stops` is empty, when places lie outside `0..=1` or out of order, and when a
    /// categorical map has places or more than 256 colors.
    pub fn new<S: Into<Stop>>(kind: ColormapKind, stops: impl IntoIterator<Item = S>) -> Result<Colormap> {
        let stops: Vec<(Option<f32>, [f32; 4])> =
            stops.into_iter().map(Into::into).map(|s: Stop| (s.at, s.color.to_array())).collect();
        let places = || stops.iter().filter_map(|s| s.0);
        let wrong: Option<Cow<'static, str>> = match kind {
            _ if stops.is_empty() => Some("a colormap needs a color".into()),
            ColormapKind::Categorical if places().next().is_some() => Some("categories cannot have places".into()),
            ColormapKind::Categorical if stops.len() > 256 => {
                Some(format!("a categorical map has at most 256 colors, not {}", stops.len()).into())
            }
            _ if places().any(|p| !(0.0..=1.0).contains(&p)) => Some("a color's place must be from 0 to 1".into()),
            _ if !places().is_sorted() => Some("colors' places must ascend".into()),
            _ => None,
        };
        if let Some(reason) = wrong {
            return Err(Error::invalid(reason));
        }
        let texels = ramp::texels(kind.spread(), &stops);
        let custom = Custom { kind, count: stops.len() as u32, texels, categories: Vec::new(), values: Vec::new() };
        Ok(Colormap(Map::Custom(Arc::new(custom))))
    }

    /// This categorical map with its categories named in order from category 0, for its legend.
    /// Panics if the map is not categorical.
    #[must_use]
    pub fn categories<S: Into<Arc<str>>>(&self, names: impl IntoIterator<Item = S>) -> Colormap {
        assert_eq!(self.kind(), ColormapKind::Categorical, "only a categorical map has categories");
        let categories = names.into_iter().map(Into::into).collect();
        Colormap(Map::Custom(Arc::new(Custom { categories, ..self.custom() })))
    }

    /// This categorical map with a value for each category, in order from category 0: a number or
    /// a text. A row whose value equals `values[i]` takes color `i`, and a row whose value is none
    /// of them takes the theme's `missing` color. A legend names each category by its value, unless
    /// [`categories`](Colormap::categories) names it. Panics if the map is not categorical.
    ///
    /// ```
    /// # use latkit::{field, Colormap};
    /// let color = field("kv").colormap(Colormap::TAB10.values([69, 138]));
    /// let fuel = field("fuel").colormap(Colormap::TAB10.values(["gas", "wind", "solar"]));
    /// ```
    #[must_use]
    pub fn values<V: Into<Category>>(&self, values: impl IntoIterator<Item = V>) -> Colormap {
        assert_eq!(self.kind(), ColormapKind::Categorical, "only a categorical map has values");
        let values = values.into_iter().map(Into::into).collect();
        Colormap(Map::Custom(Arc::new(Custom { values, ..self.custom() })))
    }

    /// The map as a custom one, with its colors, names, and values.
    fn custom(&self) -> Custom {
        Custom {
            kind: self.kind(),
            count: self.count(),
            texels: *self.texels(),
            categories: self.named_categories().to_vec(),
            values: self.category_values().to_vec(),
        }
    }

    /// The names of the categories, from category 0. Empty unless named.
    pub(crate) fn named_categories(&self) -> &[Arc<str>] {
        match &self.0 {
            Map::Catalog(_) => &[],
            Map::Custom(c) => &c.categories,
        }
    }

    /// The value of each category, from category 0. Empty when a value's integer part is its
    /// category.
    pub(crate) fn category_values(&self) -> &[Category] {
        match &self.0 {
            Map::Catalog(_) => &[],
            Map::Custom(c) => &c.values,
        }
    }

    /// The name a legend gives each category: its own, else its value as written. Empty when the
    /// map has neither.
    pub(crate) fn category_names(&self) -> Vec<Arc<str>> {
        let (names, values) = (self.named_categories(), self.category_values());
        let name = |i: usize| names.get(i).cloned().unwrap_or_else(|| values[i].written());
        (0..names.len().max(values.len())).map(name).collect()
    }

    /// How the colormap maps values.
    pub fn kind(&self) -> ColormapKind {
        match &self.0 {
            Map::Catalog(i) => CATALOG[*i as usize].kind,
            Map::Custom(c) => c.kind,
        }
    }

    /// The catalog name, or `None` for a custom colormap.
    pub fn name(&self) -> Option<&'static str> {
        match &self.0 {
            Map::Catalog(i) => Some(CATALOG[*i as usize].name),
            Map::Custom(_) => None,
        }
    }

    /// A human-readable title, such as `"Red / Blue"`. `"Custom"` for a custom colormap.
    pub fn label(&self) -> &str {
        match &self.0 {
            Map::Catalog(i) => CATALOG[*i as usize].label,
            Map::Custom(_) => "Custom",
        }
    }

    /// This colormap with each color made lighter or darker, keeping its hue, until its contrast
    /// ratio with `background` is at least `ratio`, as WCAG measures it. Unchanged for a ratio of 1
    /// or less.
    pub(crate) fn legible(&self, background: Color, ratio: f32) -> Colormap {
        if ratio <= 1.0 {
            return self.clone();
        }
        let texels = ramp::legible(self.texels(), background.to_array(), ratio);
        Colormap(Map::Custom(Arc::new(Custom { texels, ..self.custom() })))
    }

    /// The same colors in reverse order.
    #[must_use]
    pub fn reversed(&self) -> Colormap {
        let mut texels = *self.texels();
        match self.kind() {
            ColormapKind::Categorical => texels[..self.count() as usize].reverse(),
            _ => texels.reverse(),
        }
        if self.kind() == ColormapKind::Categorical {
            let n = self.count() as usize;
            for i in n..256 {
                texels[i] = texels[i % n];
            }
        }
        Colormap(Map::Custom(Arc::new(Custom { texels, ..self.custom() })))
    }

    /// The color at `t`. A continuous map takes `t` in `0..=1`, clamping it, or wrapping it for a
    /// cyclic map. A categorical map takes a category number, binned by its integer part.
    pub fn sample(&self, t: f32) -> Color {
        let texels = self.texels();
        if self.kind() == ColormapKind::Categorical {
            return Color::from_bytes(texels[(t.abs().floor() as usize) % self.count() as usize]);
        }
        let t = if self.kind() == ColormapKind::Cyclic { t - t.floor() } else { t.clamp(0.0, 1.0) };
        let at = t * 255.0;
        let (left, weight) = (at.floor() as usize, at - at.floor());
        let (from, to) = (texels[left], texels[(left + 1).min(255)]);
        let [red, green, blue, alpha] =
            std::array::from_fn(|c| (f32::from(from[c]) * (1.0 - weight) + f32::from(to[c]) * weight) / 255.0);
        Color::rgba(red, green, blue, alpha)
    }

    /// The number of colors the map was made from. For a categorical map, its category count.
    pub fn count(&self) -> u32 {
        match &self.0 {
            Map::Catalog(i) => CATALOG[*i as usize].count,
            Map::Custom(c) => c.count,
        }
    }

    pub(crate) fn texels(&self) -> &[[u8; 4]; 256] {
        match &self.0 {
            Map::Catalog(i) => &CATALOG[*i as usize].texels,
            Map::Custom(c) => &c.texels,
        }
    }

    /// Identifies the colormap's colors, so maps with the same colors share one texture layer.
    pub(crate) fn key(&self) -> ColormapKey {
        use std::hash::{Hash, Hasher};
        match &self.0 {
            Map::Catalog(i) => ColormapKey::Catalog(*i),
            Map::Custom(c) => {
                let mut hasher = rustc_hash::FxHasher::default();
                (c.kind, c.count, &c.texels).hash(&mut hasher);
                ColormapKey::Custom(hasher.finish())
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum ColormapKey {
    Catalog(u8),
    Custom(u64),
}

impl From<&Colormap> for Colormap {
    fn from(colormap: &Colormap) -> Colormap {
        colormap.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_maps_sample() {
        assert_eq!(Colormap::named("viridis"), Some(Colormap::VIRIDIS));
        assert_eq!(Colormap::VIRIDIS.kind(), ColormapKind::Sequential);
        assert_eq!(Colormap::PHASE.kind(), ColormapKind::Cyclic);
        assert_eq!(Colormap::NAMES.len(), 46);
        let start = Colormap::VIRIDIS.sample(0.0).to_rgba8();
        assert_eq!(start, [0x44, 0x01, 0x54, 255]);
        assert_eq!(Colormap::TAB10.sample(11.0), Colormap::TAB10.sample(1.0));
        assert_eq!(Colormap::GRAYS.sample(1.0).to_rgba8(), [255, 255, 255, 255]);
    }

    #[test]
    fn custom_maps_blend_and_reverse() {
        let map = Colormap::new(ColormapKind::Sequential, [Color::BLACK, Color::WHITE]).unwrap();
        // Blended in OKLab, half lightness is a darker byte than sRGB's midpoint.
        assert!((95..105).contains(&map.sample(0.5).to_rgba8()[0]));
        assert_eq!(map.reversed().sample(0.0).to_rgba8(), [255, 255, 255, 255]);
        let placed = Colormap::new(ColormapKind::Sequential, [(0.0, Color::BLACK), (0.5, Color::WHITE)]).unwrap();
        assert_eq!(placed.sample(0.75).to_rgba8(), [255, 255, 255, 255]);
        let categories =
            Colormap::new(ColormapKind::Categorical, [Color::BLACK, Color::WHITE, Color::TRANSPARENT]).unwrap();
        assert_eq!(categories.reversed().sample(0.0), Color::TRANSPARENT);
        let named = Colormap::TAB10.categories(["a", "b"]);
        assert_eq!(named.sample(1.0), Colormap::TAB10.sample(1.0));
        assert_eq!(named.reversed().named_categories(), named.named_categories());
        assert_eq!(&*named.named_categories()[1], "b");
        assert_eq!(named.key(), Colormap::TAB10.categories(["c"]).key());
        let valued = Colormap::TAB10.values([69, 138]);
        assert_eq!(valued.category_names().iter().map(|n| &**n).collect::<Vec<_>>(), ["69", "138"]);
        assert_eq!(&*valued.categories(["low"]).category_names()[0], "low", "a name stands for its value");
    }

    #[test]
    fn wrong_stops_fail() {
        let wrong = |kind, stops: &[(f32, Color)]| Colormap::new(kind, stops.iter().copied()).unwrap_err().to_string();
        assert!(Colormap::new(ColormapKind::Sequential, [Color::BLACK; 0]).is_err());
        assert!(wrong(ColormapKind::Sequential, &[(0.5, Color::BLACK), (0.2, Color::WHITE)]).contains("ascend"));
        assert!(wrong(ColormapKind::Cyclic, &[(1.5, Color::BLACK)]).contains("0 to 1"));
        assert!(wrong(ColormapKind::Categorical, &[(0.0, Color::BLACK)]).contains("cannot have places"));
        assert!(Colormap::new(ColormapKind::Categorical, [Color::BLACK; 257]).is_err());
    }
}
