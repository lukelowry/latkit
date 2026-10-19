use std::borrow::Cow;
use std::sync::Arc;

use super::Color;
use super::ramp::{self, Spread};
use crate::{Error, Result};

/// Colors for a range of values: one of the catalog's, or one of your own.
///
/// Sequential and diverging maps clamp, cyclic maps wrap, and categorical maps bin values by their
/// integer part: category `i` takes color `i`, and may be named with [`Colormap::categories`].
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
}

/// How a colormap spans values.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ColormapKind {
    /// Low to high.
    Sequential,
    /// Below and above a middle.
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
}

/// A colormap's color, at a place from 0 to 1 or evenly between its neighbors: from a [`Color`] or
/// a `(place, Color)` pair.
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

/// The catalog's names, in order.
pub(crate) fn catalog() -> impl Iterator<Item = &'static str> {
    CATALOG.iter().map(|e| e.name)
}

impl Colormap {
    /// The catalog colormap named `name`, such as `"viridis"`.
    pub fn named(name: &str) -> Option<Colormap> {
        CATALOG.iter().position(|e| e.name == name).map(|i| Colormap(Map::Catalog(i as u8)))
    }

    /// A colormap through `stops`, colors or `(place, color)` pairs: blended in OKLab, so lightness
    /// runs evenly, a color without a place evenly between its neighbors as in a CSS gradient; or
    /// for a categorical map, one color per category. Fails without a stop, for places outside
    /// `0..=1` or out of order, and for a categorical map's places or more than 256 categories.
    pub fn new<S: Into<Stop>>(kind: ColormapKind, stops: impl IntoIterator<Item = S>) -> Result<Colormap> {
        let stops: Vec<(Option<f32>, [f32; 4])> =
            stops.into_iter().map(Into::into).map(|s: Stop| (s.at, s.color.to_array())).collect();
        let places = || stops.iter().filter_map(|s| s.0);
        let wrong: Option<Cow<'static, str>> = match kind {
            _ if stops.is_empty() => Some("a colormap needs a color".into()),
            ColormapKind::Categorical if places().next().is_some() => Some("a category's color has no place".into()),
            ColormapKind::Categorical if stops.len() > 256 => {
                Some(format!("a categorical map has at most 256 colors, not {}", stops.len()).into())
            }
            _ if places().any(|p| !(0.0..=1.0).contains(&p)) => Some("a color's place is from 0 to 1".into()),
            _ if !places().is_sorted() => Some("colors' places ascend".into()),
            _ => None,
        };
        if let Some(reason) = wrong {
            return Err(Error::invalid(reason));
        }
        let texels = ramp::texels(kind.spread(), &stops);
        Ok(Colormap(Map::Custom(Arc::new(Custom { kind, count: stops.len() as u32, texels, categories: Vec::new() }))))
    }

    /// The same categorical map with its categories named in order, from category 0: what its legend
    /// lists. Panics for a continuous map.
    #[must_use]
    pub fn categories<S: Into<Arc<str>>>(&self, names: impl IntoIterator<Item = S>) -> Colormap {
        assert_eq!(self.kind(), ColormapKind::Categorical, "only a categorical map has categories");
        let categories = names.into_iter().map(Into::into).collect();
        Colormap(Map::Custom(Arc::new(Custom {
            kind: self.kind(),
            count: self.count(),
            texels: *self.texels(),
            categories,
        })))
    }

    /// The names of the categories, from category 0; none unless named.
    pub(crate) fn named_categories(&self) -> &[Arc<str>] {
        match &self.0 {
            Map::Catalog(_) => &[],
            Map::Custom(c) => &c.categories,
        }
    }

    /// How the colormap spans values.
    pub fn kind(&self) -> ColormapKind {
        match &self.0 {
            Map::Catalog(i) => CATALOG[*i as usize].kind,
            Map::Custom(c) => c.kind,
        }
    }

    /// The catalog name, or `None` for a colormap of your own.
    pub fn name(&self) -> Option<&'static str> {
        match &self.0 {
            Map::Catalog(i) => Some(CATALOG[*i as usize].name),
            Map::Custom(_) => None,
        }
    }

    /// A readable title, such as `"Red / Blue"`.
    pub fn label(&self) -> &str {
        match &self.0 {
            Map::Catalog(i) => CATALOG[*i as usize].label,
            Map::Custom(_) => "Custom",
        }
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
        let categories = self.named_categories().to_vec();
        Colormap(Map::Custom(Arc::new(Custom { kind: self.kind(), count: self.count(), texels, categories })))
    }

    /// The color at `t` in `0..=1`: clamped, wrapped for cyclic maps, binned for categorical maps.
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

    /// How many colors it was made from: a categorical map's categories.
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

    /// Identifies the colormap's colors, for sharing one texture layer.
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
        // Blended in OKLab: half lightness, a darker byte than sRGB's middle.
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
    }

    #[test]
    fn wrong_stops_fail() {
        let wrong = |kind, stops: &[(f32, Color)]| Colormap::new(kind, stops.iter().copied()).unwrap_err().to_string();
        assert!(Colormap::new(ColormapKind::Sequential, [Color::BLACK; 0]).is_err());
        assert!(wrong(ColormapKind::Sequential, &[(0.5, Color::BLACK), (0.2, Color::WHITE)]).contains("ascend"));
        assert!(wrong(ColormapKind::Cyclic, &[(1.5, Color::BLACK)]).contains("0 to 1"));
        assert!(wrong(ColormapKind::Categorical, &[(0.0, Color::BLACK)]).contains("no place"));
        assert!(Colormap::new(ColormapKind::Categorical, [Color::BLACK; 257]).is_err());
    }
}
