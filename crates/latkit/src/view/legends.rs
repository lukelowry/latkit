//! A scene's title and its marks' legends, drawn over the marks.
//!
//! The title and subtitle sit at the top left. Legends stack upward from the bottom right, each
//! under its title: a ticked bar of the mark's colormap across its domain, a color cell per
//! category, or, for named categories, a swatch beside each name. Rebuilt each frame as overlay
//! sprites, in O(legends).

use std::sync::Arc;

use super::View;
use super::axes::{Align, Writer, label, line, step, ticks};
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::{Axis, Color, Colormap, ColormapKind, Theme};

/// CSS pixels between the view's inset edge and the title or legends.
const MARGIN: f64 = 16.0;
/// A legend's bar: width and height, CSS pixels.
const BAR: [f64; 2] = [220.0, 8.0];
/// Cells a continuous bar is drawn in.
const CELLS: usize = 64;
/// The most categories a legend shows.
const CATEGORIES: usize = 24;
/// The most names a column of a legend lists.
const ROWS: usize = 8;
/// Text scale of a legend's tick labels and names, relative to the theme's text size.
const SMALL: f64 = 0.9;
/// Text scales of the title and subtitle, relative to the theme's text size, and their line height
/// relative to their own size.
const TITLE: f64 = 1.75;
const SUBTITLE: f64 = 1.1;
const LEADING: f64 = 1.35;

impl View {
    /// CSS pixels the title and subtitle take below the top inset, including the margin above them
    /// and half a margin below; 0 when the scene has neither.
    pub(super) fn title_band(&self) -> f64 {
        let font = f64::from(self.scene.theme.text.size);
        let lines: f64 = [(self.scene.title.is_some(), TITLE), (self.scene.subtitle.is_some(), SUBTITLE)]
            .into_iter()
            .filter_map(|(shown, scale)| shown.then_some(font * scale * LEADING))
            .sum();
        if lines > 0.0 { 1.5 * MARGIN + lines } else { 0.0 }
    }

    /// The sprites of the scene's title and subtitle, and of its marks' legends.
    pub(super) fn annotations(&self, inner: &mut Inner) -> Vec<wgsl::Sprite> {
        let scene = &self.scene;
        let legends =
            || scene.marks.iter().filter_map(|m| Some((m.style().legend.as_ref()?, m.style().color.as_ref()?)));
        if scene.title.is_none() && scene.subtitle.is_none() && legends().next().is_none() {
            return Vec::new();
        }
        let theme = &scene.theme;
        let [w, h] = self.size;
        let [top, right, bottom, left] = self.insets.map(f64::from);
        let area = [left + MARGIN, top + MARGIN, w - right - MARGIN, h - bottom - MARGIN];
        let ratio = f64::from(self.pixel_ratio);
        let font = f64::from(theme.text.size);
        let writer = |inner: &mut Inner, scale: f64, color: Color, f: &mut dyn FnMut(&mut Writer<'_>)| {
            let size_px = (font * scale * ratio).round().max(1.0) as u32;
            f(&mut Writer { inner, font: theme.text.font.clone(), size_px, ratio, color });
        };
        let mut sprites = Vec::new();
        let mut y = area[1];
        for (text, scale, color) in
            [(&scene.title, TITLE, theme.text.color), (&scene.subtitle, SUBTITLE, theme.text.color.alpha(0.7))]
        {
            let Some(text) = text else { continue };
            writer(inner, scale, color, &mut |w| sprites.extend(w.text(text, [area[0], y], Align::BelowRight)));
            y += font * scale * LEADING;
        }
        let mut base = area[3];
        for (title, color) in legends() {
            let Some((colormap, domain)) = color.colormap_of() else { continue };
            let write = |s, color, f: &mut dyn FnMut(&mut Writer<'_>)| writer(inner, s, color, f);
            let height = if !colormap.named_categories().is_empty() {
                categories(&mut sprites, theme, [area[2], base], colormap, ratio, write, title)
            } else if let Some(domain) = domain {
                legend(&mut sprites, theme, [area[2], base], colormap, domain, write, title)
            } else {
                continue;
            };
            base -= height + MARGIN * 0.75;
        }
        sprites
    }
}

/// Draws a legend of `colormap`'s named categories with its bottom-right corner at `corner`: a
/// swatch of each category's color beside its name, in columns of up to `ROWS`, under `title`,
/// snapped to device pixels of `ratio`. Returns its height.
fn categories(
    sprites: &mut Vec<wgsl::Sprite>,
    theme: &Theme,
    corner: [f64; 2],
    colormap: &Colormap,
    ratio: f64,
    mut write: impl FnMut(f64, Color, &mut dyn FnMut(&mut Writer<'_>)),
    title: &Arc<str>,
) -> f64 {
    let font = f64::from(theme.text.size);
    let names = colormap.named_categories();
    let names = &names[..names.len().min(CATEGORIES)];
    let [row, swatch] = [font * 1.5, font * 0.8];
    let rows = names.len().min(ROWS);
    let top = corner[1] - rows as f64 * row;
    let start = sprites.len();
    // Lay out from x = 0, each column clear of the names before it, then shift it all into place.
    let mut x = 0.0;
    for (column, names) in names.chunks(ROWS).enumerate() {
        let mut right = x;
        for (r, name) in names.iter().enumerate() {
            let middle = top + (r as f64 + 0.5) * row;
            let category = column * ROWS + r;
            let color = Color::from_bytes(colormap.texels()[category]);
            sprites.push(fill([x, middle - swatch / 2.0], [x + swatch, middle + swatch / 2.0], color));
            write(SMALL, theme.text.color.alpha(0.85), &mut |w| {
                if let Some(text) = w.text(name, [x + swatch + font * 0.5, middle], Align::Right) {
                    right = f64::max(right, f64::from(text.b[0]));
                    sprites.push(text);
                }
            });
        }
        x = right + font * 1.5;
    }
    let mut height = corner[1] - top;
    if !title.is_empty() {
        write(1.0, theme.text.color, &mut |w| sprites.extend(w.text(title, [0.0, top - 5.0], Align::Above)));
        height += font * 1.4 + 5.0;
    }
    let right = sprites[start..].iter().fold(0.0_f32, |right, s| right.max(s.a[0]).max(s.b[0]));
    let shift = ((corner[0] - f64::from(right)) * ratio).round() / ratio;
    for sprite in &mut sprites[start..] {
        sprite.a[0] += shift as f32;
        sprite.b[0] += shift as f32;
    }
    height
}

/// Draws a bar legend of `colormap` across `domain`, under `title`, with the bar's right end at
/// `corner`'s x and the tick labels' bottom at its y. Returns its height.
fn legend(
    sprites: &mut Vec<wgsl::Sprite>,
    theme: &Theme,
    corner: [f64; 2],
    colormap: &Colormap,
    domain: [f64; 2],
    mut write: impl FnMut(f64, Color, &mut dyn FnMut(&mut Writer<'_>)),
    title: &Arc<str>,
) -> f64 {
    let font = f64::from(theme.text.size);
    let bar_bottom = corner[1] - font * SMALL * 1.4 - 4.0;
    let [left, top] = [corner[0] - BAR[0], bar_bottom - BAR[1]];
    let color = |t: usize| Color::from_bytes(colormap.texels()[t.min(255)]);
    let text = theme.text.color.alpha(0.85);
    let across = |v: f64| left + (v - domain[0]) / (domain[1] - domain[0]).max(f64::MIN_POSITIVE) * BAR[0];
    let mut labels: Vec<(String, f64)> = Vec::new();
    if colormap.kind() == ColormapKind::Categorical {
        let first = domain[0].min(domain[1]).ceil() as i64;
        let last = domain[0].max(domain[1]).floor() as i64;
        let count = (last - first + 1).clamp(1, CATEGORIES as i64) as usize;
        let cell = BAR[0] / count as f64;
        for i in 0..count {
            let category = first + i as i64;
            let x = left + cell * i as f64;
            sprites.push(fill(
                [x + 1.0, top],
                [x + cell - 1.0, bar_bottom],
                color(category.unsigned_abs() as usize % 256),
            ));
            labels.push((category.to_string(), x + cell / 2.0));
        }
    } else {
        for i in 0..CELLS {
            let x = |i: usize| left + BAR[0] * i as f64 / CELLS as f64;
            let t = ((i as f64 + 0.5) / CELLS as f64 * 255.0).round() as usize;
            sprites.push(fill([x(i), top], [x(i + 1), bar_bottom], color(t)));
        }
        let [lo, hi] = [domain[0].min(domain[1]), domain[0].max(domain[1])];
        let step = step(hi - lo, (BAR[0] / (font * 6.0)).max(1.0));
        let axis = Axis::default();
        for v in ticks([lo, hi], step) {
            let at = across(v);
            sprites.push(line([at, bar_bottom], [at, bar_bottom + 3.0], 1.0, text.alpha(0.5)));
            labels.push((label(v, step, &axis), at));
        }
    }
    write(SMALL, text, &mut |w| {
        for (label, at) in &labels {
            sprites.extend(w.text(label, [*at, bar_bottom + 4.0], Align::Below));
        }
    });
    let mut height = corner[1] - top;
    if !title.is_empty() {
        write(1.0, theme.text.color, &mut |w| sprites.extend(w.text(title, [left, top - 5.0], Align::Above)));
        height += font * 1.4 + 5.0;
    }
    height
}

/// A rectangle filled with `color`, corner `a` to corner `b`, CSS pixels.
fn fill(a: [f64; 2], b: [f64; 2], color: Color) -> wgsl::Sprite {
    let mut sprite = line(a, b, 0.0, color);
    sprite.kind = wgsl::SPRITE_FILL;
    sprite
}
