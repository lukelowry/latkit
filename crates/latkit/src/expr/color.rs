use std::fmt;

use super::ramp::{gamma, srgb};

/// An sRGB color with straight (not premultiplied) alpha, each channel in `0..=1`, as in CSS.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Color {
    /// Red.
    pub r: f32,
    /// Green.
    pub g: f32,
    /// Blue.
    pub b: f32,
    /// Opacity.
    pub a: f32,
}

impl Color {
    /// Opaque white.
    pub const WHITE: Color = Color::rgba(1.0, 1.0, 1.0, 1.0);
    /// Opaque black.
    pub const BLACK: Color = Color::rgba(0.0, 0.0, 0.0, 1.0);
    /// Fully transparent.
    pub const TRANSPARENT: Color = Color::rgba(0.0, 0.0, 0.0, 0.0);

    /// A color from channels in `0..=1`.
    pub const fn rgba(r: f32, g: f32, b: f32, a: f32) -> Color {
        Color { r, g, b, a }
    }

    /// An opaque color from channels in `0..=1`.
    pub const fn rgb(r: f32, g: f32, b: f32) -> Color {
        Color { r, g, b, a: 1.0 }
    }

    /// A color from `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`. `None` for any other text.
    pub fn hex(hex: &str) -> Option<Color> {
        let digits = hex.strip_prefix('#')?;
        if !digits.is_ascii() {
            return None;
        }
        let nibble = |i: usize| u8::from_str_radix(&digits[i..=i], 16).ok();
        let byte = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).ok();
        let [r, g, b, a] = match digits.len() {
            3 | 4 => {
                let channel = |i: usize| nibble(i).map(|v| v * 17);
                [channel(0)?, channel(1)?, channel(2)?, if digits.len() == 4 { channel(3)? } else { 255 }]
            }
            6 | 8 => [byte(0)?, byte(2)?, byte(4)?, if digits.len() == 8 { byte(6)? } else { 255 }],
            _ => return None,
        };
        Some(Color::from_bytes([r, g, b, a]))
    }

    /// A color from CSS: hex, a named color, `transparent`, or a color function: `rgb()`, `hsl()`,
    /// `hwb()`, `lab()`, `lch()`, `oklab()`, or `oklch()`, each with an optional alpha after a slash
    /// or a fourth comma, and `rgba()` and `hsla()` as their aliases. Colors outside sRGB are
    /// clipped to it. Case-insensitive. `None` if unrecognized.
    pub fn css(css: &str) -> Option<Color> {
        let css = css.trim();
        if css.starts_with('#') {
            return Color::hex(css);
        }
        let lower = css.to_ascii_lowercase();
        if lower.ends_with(')') {
            return function(&lower);
        }
        if lower == "transparent" {
            return Some(Color::TRANSPARENT);
        }
        let i = NAMED.binary_search_by(|(name, _)| name.cmp(&lower.as_str())).ok()?;
        let [r, g, b] = NAMED[i].1.to_be_bytes()[1..].try_into().ok()?;
        Some(Color::from_bytes([r, g, b, 255]))
    }

    /// The same color at opacity `a`.
    #[must_use]
    pub fn alpha(self, a: f32) -> Color {
        Color { a, ..self }
    }

    pub(crate) fn from_bytes(bytes: [u8; 4]) -> Color {
        let [red, green, blue, alpha] = bytes.map(|byte| f32::from(byte) / 255.0);
        Color::rgba(red, green, blue, alpha)
    }

    /// Red, green, blue, and alpha as bytes, clamped and rounded.
    pub fn to_rgba8(self) -> [u8; 4] {
        let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        [q(self.r), q(self.g), q(self.b), q(self.a)]
    }

    /// Packed as WGSL's `pack4x8unorm`: red in the low byte.
    pub(crate) fn packed(self) -> u32 {
        u32::from_le_bytes(self.to_rgba8())
    }

    pub(crate) fn to_array(self) -> [f32; 4] {
        [self.r, self.g, self.b, self.a]
    }

    fn clamped(self) -> Color {
        let c = |v: f32| v.clamp(0.0, 1.0);
        Color::rgba(c(self.r), c(self.g), c(self.b), c(self.a))
    }
}

impl fmt::Display for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [red, green, blue, alpha] = self.to_rgba8();
        write!(f, "#{red:02x}{green:02x}{blue:02x}")?;
        if alpha == 255 { Ok(()) } else { write!(f, "{alpha:02x}") }
    }
}

/// A color from a CSS color function, lowercase: its name, then three channels and an optional
/// alpha. A channel is a number, a percentage of its full range, or `none` for zero. A hue is in
/// degrees, or in `rad`, `grad`, or `turn`.
fn function(css: &str) -> Option<Color> {
    let (name, args) = css.strip_suffix(')')?.split_once('(')?;
    let parts: Vec<&str> = args.split([',', '/', ' ']).filter(|p| !p.is_empty()).collect();
    if !(3..=4).contains(&parts.len()) {
        return None;
    }
    // A number, or a percentage of `full`.
    let number = |p: &str, full: f32| match p {
        "none" => Some(0.0),
        _ => match p.strip_suffix('%') {
            Some(percent) => percent.parse::<f32>().ok().map(|v| v / 100.0 * full),
            None => p.parse::<f32>().ok(),
        },
    };
    let hue = |p: &str| {
        let units = [("deg", 1.0), ("grad", 0.9), ("rad", 180.0 / std::f32::consts::PI), ("turn", 360.0)];
        match units.iter().find_map(|&(unit, degrees)| Some((p.strip_suffix(unit)?, degrees))) {
            Some((value, degrees)) => value.parse::<f32>().ok().map(|v| v * degrees),
            None => number(p, 360.0),
        }
    };
    let polar = |chroma: f32, degrees: f32| {
        let (sin, cos) = degrees.to_radians().sin_cos();
        [chroma * cos, chroma * sin]
    };
    let [x, y, z] = [parts[0], parts[1], parts[2]];
    let alpha = parts.get(3).map_or(Some(1.0), |p| number(p, 1.0))?;
    let [r, g, b] = match name {
        "rgb" | "rgba" => [number(x, 255.0)? / 255.0, number(y, 255.0)? / 255.0, number(z, 255.0)? / 255.0],
        "hsl" | "hsla" => hsl(hue(x)?, number(y, 100.0)? / 100.0, number(z, 100.0)? / 100.0),
        "hwb" => hwb(hue(x)?, number(y, 100.0)? / 100.0, number(z, 100.0)? / 100.0),
        "lab" => lab(number(x, 100.0)?, number(y, 125.0)?, number(z, 125.0)?),
        "lch" => {
            let [a, b] = polar(number(y, 150.0)?, hue(z)?);
            lab(number(x, 100.0)?, a, b)
        }
        "oklab" => {
            let [r, g, b, _] = srgb([number(x, 1.0)?, number(y, 0.4)?, number(z, 0.4)?, 1.0]);
            [r, g, b]
        }
        "oklch" => {
            let [a, b] = polar(number(y, 0.4)?, hue(z)?);
            let [r, g, b, _] = srgb([number(x, 1.0)?, a, b, 1.0]);
            [r, g, b]
        }
        _ => return None,
    };
    [r, g, b, alpha].iter().all(|v| v.is_finite()).then(|| Color::rgba(r, g, b, alpha).clamped())
}

/// sRGB from hue in degrees, saturation, and lightness, each in `0..=1`.
fn hsl(hue: f32, saturation: f32, lightness: f32) -> [f32; 3] {
    let chroma = saturation * lightness.min(1.0 - lightness);
    let channel = |n: f32| {
        let k = (n + hue / 30.0).rem_euclid(12.0);
        lightness - chroma * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0)
    };
    [channel(0.0), channel(8.0), channel(4.0)]
}

/// sRGB from hue in degrees, whiteness, and blackness, each in `0..=1`.
fn hwb(hue: f32, white: f32, black: f32) -> [f32; 3] {
    if white + black >= 1.0 {
        let gray = white / (white + black);
        return [gray; 3];
    }
    hsl(hue, 1.0, 0.5).map(|c| c * (1.0 - white - black) + white)
}

/// sRGB from CIE Lab under the D50 white point, as CSS defines `lab()`.
fn lab(l: f32, a: f32, b: f32) -> [f32; 3] {
    const TO_SRGB: [[f64; 3]; 3] = [
        [3.134_135_852_900_118_6, -1.617_385_998_018_043_2, -0.490_662_217_911_097_43],
        [-0.978_795_476_555_777_5, 1.916_254_377_395_988_1, 0.033_442_873_390_366_88],
        [0.071_955_392_557_947_42, -0.228_976_759_815_181_98, 1.405_386_035_113_118_2],
    ];
    const KAPPA: f64 = 24389.0 / 27.0;
    const EPSILON: f64 = 216.0 / 24389.0;
    let (l, a, b) = (f64::from(l), f64::from(a), f64::from(b));
    let fy = (l + 16.0) / 116.0;
    let (fx, fz) = (fy + a / 500.0, fy - b / 200.0);
    let cube = |f: f64| if f.powi(3) > EPSILON { f.powi(3) } else { (116.0 * f - 16.0) / KAPPA };
    let y = if l > KAPPA * EPSILON { fy.powi(3) } else { l / KAPPA };
    // XYZ under D50, adapted to D65 and converted to linear sRGB by one matrix.
    let xyz = [cube(fx) * 0.3457 / 0.3585, y, cube(fz) * (1.0 - 0.3457 - 0.3585) / 0.3585];
    TO_SRGB.map(|row| gamma((row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2]) as f32))
}

/// CSS named colors, sorted by name.
#[allow(clippy::unreadable_literal)]
static NAMED: &[(&str, u32)] = &[
    ("aliceblue", 0xf0f8ff),
    ("antiquewhite", 0xfaebd7),
    ("aqua", 0x00ffff),
    ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff),
    ("beige", 0xf5f5dc),
    ("bisque", 0xffe4c4),
    ("black", 0x000000),
    ("blanchedalmond", 0xffebcd),
    ("blue", 0x0000ff),
    ("blueviolet", 0x8a2be2),
    ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887),
    ("cadetblue", 0x5f9ea0),
    ("chartreuse", 0x7fff00),
    ("chocolate", 0xd2691e),
    ("coral", 0xff7f50),
    ("cornflowerblue", 0x6495ed),
    ("cornsilk", 0xfff8dc),
    ("crimson", 0xdc143c),
    ("cyan", 0x00ffff),
    ("darkblue", 0x00008b),
    ("darkcyan", 0x008b8b),
    ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9),
    ("darkgreen", 0x006400),
    ("darkgrey", 0xa9a9a9),
    ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b),
    ("darkolivegreen", 0x556b2f),
    ("darkorange", 0xff8c00),
    ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000),
    ("darksalmon", 0xe9967a),
    ("darkseagreen", 0x8fbc8f),
    ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f),
    ("darkslategrey", 0x2f4f4f),
    ("darkturquoise", 0x00ced1),
    ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493),
    ("deepskyblue", 0x00bfff),
    ("dimgray", 0x696969),
    ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff),
    ("firebrick", 0xb22222),
    ("floralwhite", 0xfffaf0),
    ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff),
    ("gainsboro", 0xdcdcdc),
    ("ghostwhite", 0xf8f8ff),
    ("gold", 0xffd700),
    ("goldenrod", 0xdaa520),
    ("gray", 0x808080),
    ("green", 0x008000),
    ("greenyellow", 0xadff2f),
    ("grey", 0x808080),
    ("honeydew", 0xf0fff0),
    ("hotpink", 0xff69b4),
    ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082),
    ("ivory", 0xfffff0),
    ("khaki", 0xf0e68c),
    ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5),
    ("lawngreen", 0x7cfc00),
    ("lemonchiffon", 0xfffacd),
    ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080),
    ("lightcyan", 0xe0ffff),
    ("lightgoldenrodyellow", 0xfafad2),
    ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90),
    ("lightgrey", 0xd3d3d3),
    ("lightpink", 0xffb6c1),
    ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa),
    ("lightskyblue", 0x87cefa),
    ("lightslategray", 0x778899),
    ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de),
    ("lightyellow", 0xffffe0),
    ("lime", 0x00ff00),
    ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6),
    ("magenta", 0xff00ff),
    ("maroon", 0x800000),
    ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd),
    ("mediumorchid", 0xba55d3),
    ("mediumpurple", 0x9370db),
    ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee),
    ("mediumspringgreen", 0x00fa9a),
    ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585),
    ("midnightblue", 0x191970),
    ("mintcream", 0xf5fffa),
    ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5),
    ("navajowhite", 0xffdead),
    ("navy", 0x000080),
    ("oldlace", 0xfdf5e6),
    ("olive", 0x808000),
    ("olivedrab", 0x6b8e23),
    ("orange", 0xffa500),
    ("orangered", 0xff4500),
    ("orchid", 0xda70d6),
    ("palegoldenrod", 0xeee8aa),
    ("palegreen", 0x98fb98),
    ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093),
    ("papayawhip", 0xffefd5),
    ("peachpuff", 0xffdab9),
    ("peru", 0xcd853f),
    ("pink", 0xffc0cb),
    ("plum", 0xdda0dd),
    ("powderblue", 0xb0e0e6),
    ("purple", 0x800080),
    ("rebeccapurple", 0x663399),
    ("red", 0xff0000),
    ("rosybrown", 0xbc8f8f),
    ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513),
    ("salmon", 0xfa8072),
    ("sandybrown", 0xf4a460),
    ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee),
    ("sienna", 0xa0522d),
    ("silver", 0xc0c0c0),
    ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd),
    ("slategray", 0x708090),
    ("slategrey", 0x708090),
    ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f),
    ("steelblue", 0x4682b4),
    ("tan", 0xd2b48c),
    ("teal", 0x008080),
    ("thistle", 0xd8bfd8),
    ("tomato", 0xff6347),
    ("turquoise", 0x40e0d0),
    ("violet", 0xee82ee),
    ("wheat", 0xf5deb3),
    ("white", 0xffffff),
    ("whitesmoke", 0xf5f5f5),
    ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_css() {
        assert_eq!(Color::hex("#ff8000"), Some(Color::from_bytes([255, 128, 0, 255])));
        assert_eq!(Color::hex("#f80c"), Some(Color::from_bytes([255, 136, 0, 204])));
        assert_eq!(Color::css("rgb(255, 0, 0)"), Some(Color::rgb(1.0, 0.0, 0.0)));
        assert_eq!(Color::css("rgba(0 0 255 / 50%)"), Some(Color::rgba(0.0, 0.0, 1.0, 0.5)));
        assert_eq!(Color::css("RebeccaPurple"), Color::hex("#663399"));
        assert_eq!(Color::css("nope"), None);
        assert!(NAMED.windows(2).all(|w| w[0].0 < w[1].0), "sorted for binary search");
        assert_eq!(Color::hex("#336699").unwrap().to_string(), "#336699");
        assert_eq!(Color::hex("#336699").unwrap().packed(), 0xff99_6633);
    }

    #[test]
    fn parses_css_color_functions() {
        let bytes = |css: &str| Color::css(css).map(Color::to_rgba8);
        let near = |css: &str, want: [u8; 4]| {
            let got = bytes(css).unwrap_or_else(|| panic!("{css} parses"));
            assert!(got.iter().zip(want).all(|(&g, w)| g.abs_diff(w) <= 1), "{css}: {got:?}, not {want:?}");
        };
        near("hsl(120 100% 25%)", [0, 128, 0, 255]);
        near("hsla(0.5turn, 100%, 50%, 0.5)", [0, 255, 255, 128]);
        near("hwb(0 0% 0%)", [255, 0, 0, 255]);
        near("hwb(90deg 60% 60%)", [128, 128, 128, 255]);
        near("oklch(62.8% 0.2577 29.23)", [255, 0, 0, 255]);
        near("oklab(1 0 0)", [255, 255, 255, 255]);
        near("lab(54.29% 80.82 69.9)", [255, 0, 0, 255]);
        near("lch(54.29 106.84 40.85deg / 25%)", [255, 0, 0, 64]);
        near("hsl(none 0% 50%)", [128, 128, 128, 255]);
        assert_eq!(Color::css("oklch(1 2)"), None);
        assert_eq!(Color::css("cmyk(0 0 0 0)"), None);
    }
}
