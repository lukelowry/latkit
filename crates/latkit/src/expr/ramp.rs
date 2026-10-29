//! Builds a colormap's 256 texels from its stops, both for the catalog baked at build time and for
//! maps made at run time. Colors blend in OKLab so lightness changes evenly. Cyclic ramps wrap, and
//! categorical ramps repeat their stops texel by texel. The file uses nothing from the crate, so
//! the build script includes it unchanged.

/// How a ramp spans its stops.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Spread {
    /// From the first stop to the last.
    Continuous,
    /// Around a circle: past the last stop, back to the first.
    Cyclic,
    /// Each texel takes the next stop's color, repeating.
    Categorical,
}

/// The 256 texels through `stops`: each an optional place from 0 to 1, ascending, and a
/// straight-alpha sRGB color with channels from 0 to 1. A stop without a place sits evenly between
/// its neighbors' places, like a CSS gradient. An unplaced first stop sits at 0. An unplaced last
/// stop sits at 1, except in a cyclic ramp. There, unplaced stops spread evenly up to one turn past
/// the first stop. A categorical ramp's texel `i` takes stop `i` modulo the stop count.
pub(crate) fn texels(spread: Spread, stops: &[(Option<f32>, [f32; 4])]) -> [[u8; 4]; 256] {
    assert!(!stops.is_empty(), "a ramp needs at least one stop");
    if spread == Spread::Categorical || stops.len() == 1 {
        return std::array::from_fn(|t| bytes(stops[t % stops.len()].1));
    }
    let cyclic = spread == Spread::Cyclic;
    let places = places(stops.iter().map(|s| s.0), cyclic);
    let lab: Vec<(f32, [f32; 4])> = places.into_iter().zip(stops.iter().map(|s| oklab(s.1))).collect();
    std::array::from_fn(|t| {
        let x = if cyclic { t as f32 / 256.0 } else { t as f32 / 255.0 };
        bytes(srgb(blend(&lab, x, cyclic)))
    })
}

/// Each stop's place, filled in evenly between those given.
fn places(given: impl Iterator<Item = Option<f32>>, cyclic: bool) -> Vec<f32> {
    let mut at: Vec<Option<f32>> = given.collect();
    let n = at.len();
    let first = *at[0].get_or_insert(0.0);
    if cyclic {
        at.push(Some(first + 1.0));
    } else {
        at[n - 1].get_or_insert(1.0);
    }
    let known: Vec<(usize, f32)> = at.iter().enumerate().filter_map(|(i, p)| Some((i, (*p)?))).collect();
    let mut places = vec![0.0; at.len()];
    for pair in known.windows(2) {
        let ((i, from), (j, to)) = (pair[0], pair[1]);
        for (k, place) in places.iter_mut().enumerate().take(j + 1).skip(i) {
            *place = from + (to - from) * (k - i) as f32 / (j - i) as f32;
        }
    }
    places.truncate(n);
    places
}

/// The OKLab color at `x` between the stops around it.
fn blend(stops: &[(f32, [f32; 4])], x: f32, cyclic: bool) -> [f32; 4] {
    let n = stops.len();
    let (first, last) = (stops[0], stops[n - 1]);
    let (a, b) = match stops.partition_point(|s| s.0 <= x) {
        // Before the first stop: when cyclic, blend from the last stop, one turn back.
        0 if cyclic => ((last.0 - 1.0, last.1), first),
        0 => (first, first),
        // Past the last stop: when cyclic, blend toward the first stop, one turn on.
        i if i == n && cyclic => (last, (first.0 + 1.0, first.1)),
        i if i == n => (last, last),
        i => (stops[i - 1], stops[i]),
    };
    let w = if b.0 > a.0 { ((x - a.0) / (b.0 - a.0)).clamp(0.0, 1.0) } else { 0.0 };
    std::array::from_fn(|c| a.1[c] + (b.1[c] - a.1[c]) * w)
}

fn bytes(color: [f32; 4]) -> [u8; 4] {
    color.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// `texels` with each color made lighter or darker, keeping its hue, until its contrast ratio with
/// `background` is at least `ratio`, as WCAG measures it. A color goes toward white on a background
/// that contrasts more with white, else toward black, as far as it must or can.
pub(crate) fn legible(texels: &[[u8; 4]; 256], background: [f32; 4], ratio: f32) -> [[u8; 4]; 256] {
    let ground = luminance(background);
    let lighten = contrast(1.0, ground) >= contrast(0.0, ground);
    let enough = |lab: [f32; 4]| contrast(luminance(srgb(lab)), ground) >= ratio;
    texels.map(|texel| {
        let lab = oklab(texel.map(|c| f32::from(c) / 255.0));
        if enough(lab) {
            return texel;
        }
        // Bisect the lightness between the color's, too little, and the far end's.
        let [mut near, mut far] = [lab[0], if lighten { 1.0 } else { 0.0 }];
        for _ in 0..20 {
            let middle = f32::midpoint(near, far);
            if enough([middle, lab[1], lab[2], lab[3]]) { far = middle } else { near = middle }
        }
        bytes(srgb([far, lab[1], lab[2], lab[3]]))
    })
}

/// The relative luminance of a straight-alpha sRGB color, as WCAG defines it.
fn luminance([r, g, b, _]: [f32; 4]) -> f32 {
    let [r, g, b] = [r, g, b].map(|c| linear(c.clamp(0.0, 1.0)));
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// The WCAG contrast ratio between two relative luminances.
fn contrast(a: f32, b: f32) -> f32 {
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

/// An sRGB channel in linear light.
fn linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// A linear-light channel encoded as sRGB.
pub(crate) fn gamma(c: f32) -> f32 {
    if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * c.max(0.0).powf(1.0 / 2.4) - 0.055 }
}

/// Converts a straight-alpha sRGB color to OKLab, keeping alpha.
pub(crate) fn oklab([r, g, b, a]: [f32; 4]) -> [f32; 4] {
    let [r, g, b] = [r, g, b].map(linear);
    let l = (0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    [
        0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
        a,
    ]
}

/// Converts an OKLab color to straight-alpha sRGB, keeping alpha.
pub(crate) fn srgb([l, a, b, alpha]: [f32; 4]) -> [f32; 4] {
    let l_ = (l + 0.396_337_78 * a + 0.215_803_76 * b).powi(3);
    let m_ = (l - 0.105_561_346 * a - 0.063_854_17 * b).powi(3);
    let s_ = (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
    let [r, g, b] = [
        4.076_741_7 * l_ - 3.307_711_6 * m_ + 0.230_969_94 * s_,
        -1.268_438 * l_ + 2.609_757_4 * m_ - 0.341_319_38 * s_,
        -0.004_196_086_3 * l_ - 0.703_418_6 * m_ + 1.707_614_7 * s_,
    ]
    .map(gamma);
    [r, g, b, alpha]
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLACK: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
    const WHITE: [f32; 4] = [1.0, 1.0, 1.0, 1.0];

    #[test]
    fn stops_sit_on_their_texels_and_blend_in_oklab() {
        let ramp = texels(Spread::Continuous, &[(None, BLACK), (None, WHITE)]);
        assert_eq!((ramp[0], ramp[255]), ([0, 0, 0, 255], [255, 255, 255, 255]));
        // OKLab's half lightness is a darker byte than sRGB's midpoint: about 100, not 128.
        assert!((95..105).contains(&ramp[128][0]), "{:?}", ramp[128]);
        let red = [1.0, 0.0, 0.0, 1.0];
        let placed = texels(Spread::Continuous, &[(None, BLACK), (Some(64.0 / 255.0), red), (None, WHITE)]);
        assert_eq!(placed[64], [255, 0, 0, 255], "a placed stop sets its texel's color");
        assert_eq!(placed[0], [0, 0, 0, 255]);
    }

    #[test]
    fn cyclic_ramps_wrap_and_categories_repeat() {
        let cyclic = texels(Spread::Cyclic, &[(None, BLACK), (None, WHITE)]);
        assert_eq!((cyclic[0], cyclic[128]), ([0, 0, 0, 255], [255, 255, 255, 255]));
        assert!(cyclic[255][0] < 20, "a cyclic ramp returns to its first stop: {:?}", cyclic[255]);
        assert_eq!(places([None, Some(0.5), None, None].into_iter(), false), [0.0, 0.5, 0.75, 1.0]);
        assert_eq!(places([None, None].into_iter(), true), [0.0, 0.5]);
        let categories = texels(Spread::Categorical, &[(None, BLACK), (None, WHITE)]);
        assert_eq!(categories[..3], [[0, 0, 0, 255], [255, 255, 255, 255], [0, 0, 0, 255]]);
    }

    #[test]
    fn legible_colors_keep_their_contrast_with_the_background() {
        let ramp = texels(Spread::Continuous, &[(None, BLACK), (None, WHITE)]);
        let dark = legible(&ramp, BLACK, 4.5);
        let ratio = |texel: [u8; 4]| contrast(luminance(texel.map(|c| f32::from(c) / 255.0)), 0.0);
        assert!(dark.iter().all(|&t| ratio(t) >= 4.45), "every color reads on black: {:?}", dark[0]);
        assert_eq!(dark[255], ramp[255], "colors that already read are unchanged");
        assert!(legible(&ramp, WHITE, 4.5)[255][0] < 120, "on white, light colors darken");
    }
}
