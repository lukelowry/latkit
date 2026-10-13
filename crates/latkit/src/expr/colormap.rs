use std::sync::Arc;

use super::Color;

/// Colors for a range of values: one of the catalog's, or one of your own.
///
/// Sequential and diverging maps clamp, cyclic maps wrap, and categorical maps bin values by their
/// integer part.
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
}

/// How a colormap spans values.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize), serde(rename_all = "lowercase"))]
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

struct Entry {
    name: &'static str,
    label: &'static str,
    kind: ColormapKind,
    count: u32,
    texels: [[u8; 4]; 256],
}

include!(concat!(env!("OUT_DIR"), "/colormaps.rs"));

impl Colormap {
    /// The catalog colormap named `name`, such as `"viridis"`.
    pub fn named(name: &str) -> Option<Colormap> {
        CATALOG.iter().position(|e| e.name == name).map(|i| Colormap(Map::Catalog(i as u8)))
    }

    /// A colormap through `colors`: evenly spaced and blended in sRGB, or one color per category.
    pub fn new(kind: ColormapKind, colors: &[Color]) -> Colormap {
        assert!(!colors.is_empty(), "a colormap needs a color");
        let count = colors.len();
        let texels = std::array::from_fn(|texel| match kind {
            ColormapKind::Categorical => colors[texel % count].to_bytes(),
            _ if count == 1 => colors[0].to_bytes(),
            _ => {
                let at = if kind == ColormapKind::Cyclic {
                    texel as f32 / 256.0 * count as f32
                } else {
                    texel as f32 / 255.0 * (count - 1) as f32
                };
                let left = at.floor() as usize;
                let right = if kind == ColormapKind::Cyclic { (left + 1) % count } else { (left + 1).min(count - 1) };
                let (from, to) = (colors[left % count].to_array(), colors[right].to_array());
                let weight = at - left as f32;
                let [red, green, blue, alpha] = std::array::from_fn(|c| from[c] + (to[c] - from[c]) * weight);
                Color::rgba(red, green, blue, alpha).to_bytes()
            }
        });
        Colormap(Map::Custom(Arc::new(Custom { kind, count: count as u32, texels })))
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
        Colormap(Map::Custom(Arc::new(Custom { kind: self.kind(), count: self.count(), texels })))
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

    /// Distinct colors of a categorical map; 256 samples of a continuous one.
    pub(crate) fn count(&self) -> u32 {
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
        let start = Colormap::VIRIDIS.sample(0.0).to_bytes();
        assert_eq!(start, [0x44, 0x01, 0x54, 255]);
        assert_eq!(Colormap::TAB10.sample(11.0), Colormap::TAB10.sample(1.0));
        assert_eq!(Colormap::GRAYS.sample(1.0).to_bytes(), [255, 255, 255, 255]);
    }

    #[test]
    fn custom_maps_blend_and_reverse() {
        let map = Colormap::new(ColormapKind::Sequential, &[Color::BLACK, Color::WHITE]);
        assert_eq!(map.sample(0.5).to_bytes(), [128, 128, 128, 255]);
        assert_eq!(map.reversed().sample(0.0).to_bytes(), [255, 255, 255, 255]);
        let categories = Colormap::new(ColormapKind::Categorical, &[Color::BLACK, Color::WHITE, Color::TRANSPARENT]);
        assert_eq!(categories.reversed().sample(0.0), Color::TRANSPARENT);
    }
}
