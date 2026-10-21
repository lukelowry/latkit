use std::fmt;

/// An sRGB color with straight alpha, each channel in `0..=1`, as in CSS.
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

    /// A color from `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`.
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

    /// A color from CSS: hex, `rgb(…)`, `rgba(…)`, or a named color.
    pub fn css(css: &str) -> Option<Color> {
        let css = css.trim();
        if css.starts_with('#') {
            return Color::hex(css);
        }
        let lower = css.to_ascii_lowercase();
        if let Some(args) = lower.strip_prefix("rgba(").or_else(|| lower.strip_prefix("rgb(")) {
            let parts: Vec<&str> = args.strip_suffix(')')?.split([',', '/', ' ']).filter(|p| !p.is_empty()).collect();
            if !(3..=4).contains(&parts.len()) {
                return None;
            }
            let channel = |p: &str| match p.strip_suffix('%') {
                Some(percent) => percent.parse::<f32>().ok().map(|v| v / 100.0),
                None => p.parse::<f32>().ok().map(|v| v / 255.0),
            };
            let alpha = |p: &str| match p.strip_suffix('%') {
                Some(percent) => percent.parse::<f32>().ok().map(|v| v / 100.0),
                None => p.parse::<f32>().ok(),
            };
            let a = parts.get(3).map_or(Some(1.0), |p| alpha(p))?;
            return Some(Color::rgba(channel(parts[0])?, channel(parts[1])?, channel(parts[2])?, a).clamped());
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

    /// Red, green, blue, and alpha as bytes.
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
}
