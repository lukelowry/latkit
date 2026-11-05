//! Guides: the scene's title, its marks' legends, and a plot's axes, laid out around the marks.
//!
//! Each guide is measured, given a box, and drawn in it. A guide on a side takes room from the
//! marks: fits frame inside the room the sides leave, and marks draw only there. A guide in a
//! corner sits over the marks, on a backdrop. Guides on a side stack in scene order, the title
//! first, and wrap into another row or column when they run out of room. A plot's axes sit against
//! the marks, inside any guides on their side. Every length is in ems of the theme's text size, so
//! views that share a theme line up, and larger text spaces the layout to match.
//!
//! The layout is measured again only when the scene, the view's size, insets, or pixel ratio, a
//! legend's domain, or the loaded fonts change. Frames draw it as overlay sprites, in O(guides).
//!
//! A colormap that fits its values shows the domain fitted on the CPU over every row of the mark's
//! table, as a paged table's domains are. It is kept until a field it reads changes, so frames do
//! no work for it. A domain that reads what the view shows (the camera, the pointer, focus, or
//! time) changes from frame to frame, and its legend is not drawn.

use std::sync::Arc;

use super::View;
use super::axes::{GAP as LABEL_GAP, Gutters, TICK, Writer, gutters, label, line, step, ticks};
use super::camera::Area;
use crate::derive::stamp_of;
use crate::expr::Domain;
use crate::gpu::Inner;
use crate::gpu::shaders as wgsl;
use crate::{Axis, Color, ColormapKind, Place, Space, Theme};

/// Ems between the view's edge, inside its insets, and the guides beside it.
const PAD: f64 = 1.5;
/// Ems between guides, and between guides and the marks.
const GAP: f64 = 0.75;
/// Ems kept on a side of a plot that shows no text.
const BARE: f64 = 0.75;
/// Ems of backdrop around the guides in a corner, its corner radius, and its opacity.
const INSET: f64 = 0.5;
const ROUND: f64 = 0.35;
const BACKDROP: f32 = 0.85;
/// A bar's length and thickness in ems, and the least length an upright bar shrinks to.
const BAR: [f64; 2] = [20.0, 0.75];
const SHORTEST: f64 = 5.0;
/// Cells a continuous bar is drawn in.
const CELLS: usize = 64;
/// The most categories a legend shows, and the most names in a column of swatches.
const CATEGORIES: usize = 24;
const ROWS: usize = 8;
/// A swatch's size, and a row of swatches' height, in ems.
const SWATCH: f64 = 0.8;
const ROW: f64 = 1.5;
/// Text scales relative to the theme's text size: legend ticks and names, the title, and the
/// subtitle.
const SMALL: f64 = 0.9;
const TITLE: f64 = 1.75;
const SUBTITLE: f64 = 1.1;

/// The guides, laid out: the room each side takes from the marks, a plot's axes, and every guide
/// in its box.
#[derive(Default)]
pub(crate) struct Guides {
    /// The stamp of what the layout was measured from.
    stamp: u64,
    /// CSS pixels each side takes from the marks: top, right, bottom, and left. A plot's axes are
    /// part of it.
    pub(crate) room: [f64; 4],
    /// The space a plot's axes take, which `room` includes.
    pub(crate) axes: Gutters,
    /// Whether the atlas had no room for some text, so the next frame measures again. It is asked
    /// for once, not again after a second such layout.
    pub(crate) retry: bool,
    /// The guides in drawing order, each corner's backdrop before the guides on it.
    shown: Vec<(Guide, Area)>,
}

impl Guides {
    /// Whether `[x, y]`, in CSS pixels, lies on a corner's backdrop, over the marks.
    pub(crate) fn covers(&self, [x, y]: [f64; 2]) -> bool {
        self.backdrops().any(|a| x >= a[0] && x <= a[2] && y >= a[1] && y <= a[3])
    }

    /// The corners' backdrops, which cover the marks: at most one per corner.
    pub(crate) fn backdrops(&self) -> impl Iterator<Item = Area> + '_ {
        self.shown.iter().filter(|(guide, _)| matches!(guide, Guide::Backdrop)).map(|&(_, area)| area)
    }
}

/// A guide, measured.
enum Guide {
    /// The backdrop behind a corner's guides.
    Backdrop,
    /// The title, and a subtitle under it.
    Title(Text, Option<Text>),
    Legend(Legend),
}

/// A text and the size of its line box in CSS pixels.
struct Text {
    text: Arc<str>,
    size: [f64; 2],
}

/// A legend, measured for its place: a title over a bar or swatches.
struct Legend {
    title: Option<Text>,
    body: Body,
}

enum Body {
    /// A bar of the colormap, `length` CSS pixels long: fills along it, each from and to a
    /// fraction of its length, and ticks at fractions with their labels. Upright, its low end is at
    /// the bottom and labels sit right of it. Flat, its low end is at the left and labels sit under
    /// it. `gapped` bars leave a pixel between fills, one per category.
    Bar { fills: Vec<([f64; 2], Color)>, ticks: Vec<(f64, Text)>, length: f64, upright: bool, gapped: bool },
    /// A swatch of each color beside its name, in columns of up to `ROWS`.
    Swatches(Vec<(Color, Text)>),
}

/// What a scene asks a place to show, in scene order.
#[derive(Clone, Copy)]
enum Wanted {
    Title,
    Legend(usize),
}

/// Measures text as the overlay sets it. Text the atlas cannot set is estimated. Text it had no room
/// for this frame is noted, so the layout is measured again.
struct Measure<'a> {
    inner: &'a mut Inner,
    theme: &'a Theme,
    ratio: f64,
    guessed: bool,
}

impl Measure<'_> {
    /// The size of `text`'s line box at `scale` times the theme's text size, in CSS pixels.
    fn size(&mut self, text: &str, scale: f64) -> [f64; 2] {
        let measured = Writer::new(self.inner, self.theme, scale, self.ratio, Color::WHITE).size(text);
        measured.unwrap_or_else(|| {
            // Text that no host sets, or that the host can't set, keeps its estimate.
            self.guessed |= self.inner.atlas.full();
            let em = f64::from(self.theme.text.size) * scale;
            [0.6 * em * text.chars().count() as f64, 1.25 * em]
        })
    }

    fn text(&mut self, text: &Arc<str>, scale: f64) -> Text {
        Text { size: self.size(text, scale), text: text.clone() }
    }
}

/// Guides and their sizes, in lanes: rows on the top and bottom, columns elsewhere.
type Lanes = Vec<Vec<(Guide, [f64; 2])>>;

/// The thickness of `lanes` across their side, `GAP` CSS pixels apart: the sum of each row's
/// height when `rows`, else of each column's width.
fn thickness(lanes: &Lanes, rows: bool, gap: f64) -> f64 {
    let across =
        |lane: &Vec<(Guide, [f64; 2])>| lane.iter().map(|(_, size)| size[usize::from(rows)]).fold(0.0, f64::max);
    let sum: f64 = lanes.iter().map(across).sum();
    sum + gap * lanes.len().saturating_sub(1) as f64
}

/// Adds a guide `size` big to `lanes`, which hold `room` CSS pixels along their side: to the last
/// lane while it fits, else to a new one. With `alone`, the guide takes a lane of its own. In rows,
/// a title has its row to itself.
fn stack(lanes: &mut Lanes, guide: Guide, size: [f64; 2], rows: bool, room: f64, gap: f64, alone: bool) {
    let along = usize::from(!rows);
    let alone =
        alone || (rows && lanes.last().is_some_and(|lane| lane.iter().any(|(g, _)| matches!(g, Guide::Title(..)))));
    let fits = |lane: &Vec<(Guide, [f64; 2])>| {
        let used: f64 = lane.iter().map(|(_, s)| s[along] + gap).sum();
        used + size[along] <= room
    };
    match lanes.last_mut() {
        Some(lane) if !alone && fits(lane) => lane.push((guide, size)),
        _ => lanes.push(vec![(guide, size)]),
    }
}

/// Gives each guide in `lanes`, rows or columns, its box. The first lane's outer edge lies at
/// `across[0]`, and later lanes follow in direction `across[1]` (1 or -1). In a lane, guides start
/// at `along[0]` and follow in direction `along[1]`. A guide sits at its lane's top or left edge, or
/// when `flush`, at its bottom or right edge.
fn place(lanes: Lanes, rows: bool, across: [f64; 2], along: [f64; 2], flush: bool, gap: f64) -> Vec<(Guide, Area)> {
    // The axis guides follow each other along, and the axis lanes follow each other across.
    let (a, b) = if rows { (0, 1) } else { (1, 0) };
    let mut shown = Vec::new();
    let mut edge = across[0];
    for lane in lanes {
        let thick = lane.iter().map(|(_, s)| s[b]).fold(0.0, f64::max);
        let low = if across[1] > 0.0 { edge } else { edge - thick };
        let mut at = along[0];
        for (guide, size) in lane {
            let mut corner = [0.0; 2];
            corner[a] = if along[1] > 0.0 { at } else { at - size[a] };
            corner[b] = if flush { low + thick - size[b] } else { low };
            shown.push((guide, [corner[0], corner[1], corner[0] + size[0], corner[1] + size[1]]));
            at += along[1] * (size[a] + gap);
        }
        edge += across[1] * (thick + gap);
    }
    shown
}

impl View {
    /// Lays out the guides when what they are measured from changed: the scene, the view's size,
    /// insets, or pixel ratio, a legend's domain, or the loaded fonts. A change to the room the
    /// sides take fits a plot's values again.
    pub(super) fn lay_out_guides(&mut self, inner: &mut Inner) {
        if !self.sized() {
            return;
        }
        let domains: Vec<Option<[u64; 2]>> =
            (0..self.scene.marks.len()).map(|i| self.legend_domain(i).map(|d| d.map(f64::to_bits))).collect();
        let size = self.size.map(f64::to_bits);
        let fonts = crate::host::fonts();
        let stamp = stamp_of((
            self.scene_version,
            self.pixel_ratio.to_bits(),
            size,
            self.insets.map(f32::to_bits),
            domains,
            fonts,
        ));
        if stamp == self.guides.stamp {
            return;
        }
        let (mut guides, guessed) = self.measure_guides(inner);
        // Text the atlas had no room for was estimated, so measure it again next frame.
        guides.stamp = if guessed { 0 } else { stamp };
        guides.retry = guessed && !self.guides.retry;
        if guides.room != self.guides.room {
            self.fitting.plot_due = true;
        }
        self.guides = guides;
    }

    /// Measures every guide and gives each a box. Returns whether any text was estimated.
    fn measure_guides(&self, inner: &mut Inner) -> (Guides, bool) {
        let theme = &self.scene.theme;
        let em = f64::from(theme.text.size);
        let (pad, gap) = (PAD * em, GAP * em);
        let mut m = Measure { inner, theme, ratio: f64::from(self.pixel_ratio), guessed: false };
        let plot = match &self.scene.space {
            Space::Plot(plot) => Some(plot),
            _ => None,
        };
        let axes = plot.map_or_else(Gutters::default, |plot| gutters(plot, em, |text| m.size(text, 1.0)));
        let [w, h] = self.size;
        let [top, right, bottom, left] = self.insets.map(f64::from);
        let bounds = [left, top, w - right, h - bottom];
        let wanted = self.wanted();
        // Sides: top, right, bottom, left, as lanes from the view's edge in.
        let mut sides: [Lanes; 4] = Default::default();
        // The top and bottom first, as wide as the view.
        let across = (bounds[2] - bounds[0] - 2.0 * pad).max(0.0);
        for &(place, want) in &wanted {
            let side = match place {
                Place::Top => 0,
                Place::Bottom => 2,
                _ => continue,
            };
            if let Some((guide, size)) = self.guide(want, false, across, &mut m) {
                stack(&mut sides[side], guide, size, true, across, gap, matches!(want, Wanted::Title));
            }
        }
        let mut room = [0.0; 4];
        let side_room = |lanes: &Lanes, side: usize| {
            let guides = if lanes.is_empty() { 0.0 } else { pad + thickness(lanes, side.is_multiple_of(2), gap) + gap };
            let edge = match plot {
                Some(_) if lanes.is_empty() => (if axes.text[side] { PAD } else { BARE }) * em,
                _ => 0.0,
            };
            guides + edge + axes.room[side]
        };
        room[0] = side_room(&sides[0], 0);
        room[2] = side_room(&sides[2], 2);
        // Then the left and right, as tall as the marks between the top and bottom.
        let tall = (bounds[3] - bounds[1] - room[0] - room[2]).max(0.0);
        for &(place, want) in &wanted {
            let side = match place {
                Place::Right => 1,
                Place::Left => 3,
                _ => continue,
            };
            if let Some((guide, size)) = self.guide(want, true, tall, &mut m) {
                stack(&mut sides[side], guide, size, false, tall, gap, false);
            }
        }
        room[1] = side_room(&sides[1], 1);
        room[3] = side_room(&sides[3], 3);
        let area = [bounds[0] + room[3], bounds[1] + room[0], bounds[2] - room[1], bounds[3] - room[2]];
        // Corners first, so their backdrops draw under every guide. Then rows from the top and
        // bottom edges in, and columns from the left and right edges in, from the marks' top.
        let mut shown = self.corners(&wanted, area, &mut m);
        let [top_lanes, right_lanes, bottom_lanes, left_lanes] = sides;
        let (left_edge, right_edge) = (bounds[0] + pad, bounds[2] - pad);
        shown.extend(place(top_lanes, true, [bounds[1] + pad, 1.0], [left_edge, 1.0], false, gap));
        shown.extend(place(bottom_lanes, true, [bounds[3] - pad, -1.0], [left_edge, 1.0], false, gap));
        shown.extend(place(left_lanes, false, [left_edge, 1.0], [area[1], 1.0], false, gap));
        shown.extend(place(right_lanes, false, [right_edge, -1.0], [area[1], 1.0], false, gap));
        (Guides { stamp: 0, room, axes, retry: false, shown }, m.guessed)
    }

    /// The guides in the corners of `area`, over the marks, stacked away from their corner. Each
    /// corner's backdrop comes first.
    fn corners(&self, wanted: &[(Place, Wanted)], area: Area, m: &mut Measure<'_>) -> Vec<(Guide, Area)> {
        let em = f64::from(self.scene.theme.text.size);
        let (pad, gap, inset) = (PAD * em, GAP * em, INSET * em);
        let inside = [area[0] + pad, area[1] + pad, area[2] - pad, area[3] - pad];
        let wide = (inside[2] - inside[0]).max(0.0);
        let (mut backdrops, mut shown) = (Vec::new(), Vec::new());
        for corner in [Place::TopLeft, Place::TopRight, Place::BottomLeft, Place::BottomRight] {
            let mut columns: Lanes = Vec::new();
            for &(place, want) in wanted {
                if place == corner
                    && let Some((guide, size)) = self.guide(want, false, wide, m)
                {
                    stack(&mut columns, guide, size, false, (inside[3] - inside[1]).max(0.0), gap, false);
                }
            }
            if columns.is_empty() {
                continue;
            }
            let right = matches!(corner, Place::TopRight | Place::BottomRight);
            let across = if right { [inside[2], -1.0] } else { [inside[0], 1.0] };
            let low = matches!(corner, Place::BottomLeft | Place::BottomRight);
            let along = if low { [inside[3], -1.0] } else { [inside[1], 1.0] };
            let placed = place(columns, false, across, along, right, gap);
            let far = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
            let bound = placed
                .iter()
                .fold(far, |b, (_, at)| [b[0].min(at[0]), b[1].min(at[1]), b[2].max(at[2]), b[3].max(at[3])]);
            backdrops.push((Guide::Backdrop, [bound[0] - inset, bound[1] - inset, bound[2] + inset, bound[3] + inset]));
            shown.extend(placed);
        }
        backdrops.extend(shown);
        backdrops
    }

    /// What each place shows, in scene order: the title, then each legend in mark order. A title
    /// defaults to the top of a plot and the top-left corner elsewhere. A legend defaults to the
    /// right of a plot and the bottom-right corner elsewhere.
    fn wanted(&self) -> Vec<(Place, Wanted)> {
        let plot = matches!(self.scene.space, Space::Plot(_));
        let title = self
            .scene
            .title
            .as_ref()
            .map(|title| (title.place.unwrap_or(if plot { Place::Top } else { Place::TopLeft }), Wanted::Title));
        let legends = self.scene.marks.iter().enumerate().filter_map(|(i, mark)| {
            let legend = mark.style().legend.as_ref()?;
            Some((legend.place.unwrap_or(if plot { Place::Right } else { Place::BottomRight }), Wanted::Legend(i)))
        });
        title.into_iter().chain(legends).collect()
    }

    /// `want` measured, and its size. A legend's bar stands `upright` beside the marks or lies
    /// flat, as long as `room` CSS pixels along it allow. `None` for a legend with nothing to show
    /// yet.
    fn guide(&self, want: Wanted, upright: bool, room: f64, m: &mut Measure<'_>) -> Option<(Guide, [f64; 2])> {
        let em = f64::from(self.scene.theme.text.size);
        match want {
            Wanted::Title => {
                let title = self.scene.title.as_ref()?;
                let text = m.text(&title.text, TITLE);
                let subtitle = title.subtitle.as_ref().map(|subtitle| m.text(subtitle, SUBTITLE));
                let lower = subtitle.as_ref().map_or([0.0; 2], |s| s.size);
                let size = [text.size[0].max(lower[0]), text.size[1] + lower[1]];
                Some((Guide::Title(text, subtitle), size))
            }
            Wanted::Legend(i) => {
                let legend = self.legend(i, upright, room, m)?;
                let size = legend.size(em);
                Some((Guide::Legend(legend), size))
            }
        }
    }

    /// Mark `i`'s legend, measured: a bar of its colormap across the domain it shows, upright or
    /// flat in `room` CSS pixels along it, or a swatch for each named category. `None` while no
    /// domain has been fitted.
    fn legend(&self, i: usize, upright: bool, room: f64, m: &mut Measure<'_>) -> Option<Legend> {
        let theme = &self.scene.theme;
        let style = self.scene.marks.get(i)?.style();
        let legend = style.legend.as_ref()?;
        let (colormap, ..) = style.color.as_ref()?.colormap_of()?;
        let colormap = colormap.legible(theme.background, theme.contrast);
        let em = f64::from(theme.text.size);
        let title = legend.title.as_ref().filter(|title| !title.is_empty()).map(|title| m.text(title, 1.0));
        let color = |t: usize| Color::from_bytes(colormap.texels()[t.min(255)]);
        let names = colormap.named_categories();
        if !names.is_empty() {
            let swatches = names.iter().take(CATEGORIES).enumerate().map(|(k, name)| (color(k), m.text(name, SMALL)));
            return Some(Legend { title, body: Body::Swatches(swatches.collect()) });
        }
        let domain = self.legend_domain(i)?;
        let (mut fills, mut categories) = (Vec::new(), Vec::new());
        let categorical = colormap.kind() == ColormapKind::Categorical;
        if categorical {
            let first = domain[0].min(domain[1]).ceil() as i64;
            let last = domain[0].max(domain[1]).floor() as i64;
            let count = (last - first + 1).clamp(1, CATEGORIES as i64) as usize;
            for k in 0..count {
                let category = first + k as i64;
                let span = [k as f64 / count as f64, (k + 1) as f64 / count as f64];
                fills.push((span, color(category.unsigned_abs() as usize % 256)));
                categories.push((span[0].midpoint(span[1]), Arc::from(category.to_string())));
            }
        } else {
            for k in 0..CELLS {
                let t = ((k as f64 + 0.5) / CELLS as f64 * 255.0).round() as usize;
                fills.push(([k as f64 / CELLS as f64, (k + 1) as f64 / CELLS as f64], color(t)));
            }
        }
        // The labels along a bar `length` long: each category's, or ticks spaced to suit it.
        let mut labels_along = |length: f64| -> Vec<(f64, Text)> {
            if categorical {
                return categories.iter().map(|(t, name)| (*t, m.text(name, SMALL))).collect();
            }
            // Where a value lies along the bar, as the GPU maps it: either way round, and a domain
            // of one value puts it in the middle.
            let span = domain[1] - domain[0];
            let along = |v: f64| if span == 0.0 { 0.5 } else { (v - domain[0]) / span };
            let [lo, hi] = [domain[0].min(domain[1]), domain[0].max(domain[1])];
            let spacing = em * if upright { 2.5 } else { 6.0 };
            let step = if hi > lo { step(hi - lo, (length / spacing).max(1.0)) } else { 1.0 };
            let axis = Axis::default();
            let values: Vec<f64> = if hi > lo { ticks([lo, hi], step).collect() } else { vec![lo] };
            let greatest = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            values
                .into_iter()
                .map(|v| {
                    let mut text = label(v, step, &axis);
                    if let Some(unit) = legend.unit.as_deref().filter(|_| v == greatest) {
                        text.push_str(unit);
                    }
                    (along(v), m.text(&Arc::from(text), SMALL))
                })
                .collect()
        };
        // Labels reach past the bar's ends, and an upright bar's title sits above it. A bar whose
        // labels would pass `room` shortens to keep them in it, down to its least length.
        let over = title.as_ref().filter(|_| upright).map_or(0.0, |t| t.size[1] + TICK * em);
        let mut length = (room - over - em).clamp(SHORTEST * em, BAR[0] * em);
        let mut labels = labels_along(length);
        let excess = bar_layout(&labels, length, upright, em).0[usize::from(upright)] + over - room;
        if excess > 0.0 && length > SHORTEST * em {
            length = (length - excess).max(SHORTEST * em);
            labels = labels_along(length);
        }
        Some(Legend { title, body: Body::Bar { fills, ticks: labels, length, upright, gapped: categorical } })
    }

    /// Fits the domain each legend shows where its colormap fits its values. Each is kept until the
    /// fields it reads change.
    pub(super) fn fit_legends(&mut self) {
        for i in 0..self.marks.len() {
            let style = self.marks[i].mark.style();
            let Some((colormap, input, Domain::Fit)) =
                style.legend.as_ref().and(style.color.as_ref()).and_then(crate::Expr::colormap_of)
            else {
                continue;
            };
            let shown = &self.marks[i];
            let fitted = (colormap.kind() != ColormapKind::Categorical)
                .then(|| shown.compiled.as_ref()?.program.fitted.iter().position(|f| f == input))
                .flatten()
                .filter(|&d| shown.reads_only_data(d));
            self.marks[i].legend = fitted.and_then(|d| self.domain_on_cpu(i, d, self.marks[i].legend));
        }
    }

    /// The domain mark `i`'s legend shows: a fixed domain, a categorical map's categories, the
    /// domain over the input field's history, or the domain fitted to the mark's values. `None`
    /// without a legend, or while no value has been fitted.
    fn legend_domain(&self, i: usize) -> Option<[f64; 2]> {
        let style = self.scene.marks.get(i)?.style();
        style.legend.as_ref()?;
        let (colormap, input, domain) = style.color.as_ref()?.colormap_of()?;
        match domain {
            Domain::Fixed(domain) => Some(domain),
            Domain::Fit | Domain::All if colormap.kind() == ColormapKind::Categorical => {
                Some([0.0, f64::from(colormap.count())])
            }
            Domain::All => {
                let shown = self.marks.get(i)?;
                let program = &shown.compiled.as_ref()?.program;
                let name = input.field_name()?;
                let &(at, _) =
                    program.histories.iter().find(|&&(_, column)| program.columns[column as usize].name == *name)?;
                let word = |k: u32| shown.constants.get((at + k) as usize).map(|&w| f64::from(f32::from_bits(w)));
                Some([word(1)?, word(2)?])
            }
            Domain::Fit => {
                let (_, [least, most]) = self.marks.get(i)?.legend?;
                let decode = |word: u32| f64::from(crate::order::from_number32(word));
                (least != 0 || most != 0).then(|| [decode(!least), decode(most)])
            }
        }
    }

    /// The sprites of the guides: each corner's backdrop, the title, and the legends.
    pub(super) fn guide_sprites(&self, inner: &mut Inner) -> Vec<wgsl::Sprite> {
        let theme = &self.scene.theme;
        let em = f64::from(theme.text.size);
        let ratio = f64::from(self.pixel_ratio);
        let mut sprites = Vec::new();
        for (guide, at) in &self.guides.shown {
            match guide {
                Guide::Backdrop => {
                    sprites.push(fill([at[0], at[1]], [at[2], at[3]], theme.background.alpha(BACKDROP), ROUND * em));
                }
                Guide::Title(title, subtitle) => {
                    let mut writer = Writer::new(inner, theme, TITLE, ratio, theme.text.color);
                    sprites.extend(writer.text(&title.text, [at[0], at[1]], [0.0, 0.0]));
                    if let Some(subtitle) = subtitle {
                        let mut writer = Writer::new(inner, theme, SUBTITLE, ratio, theme.text.color.alpha(0.7));
                        sprites.extend(writer.text(&subtitle.text, [at[0], at[1] + title.size[1]], [0.0, 0.0]));
                    }
                }
                Guide::Legend(legend) => legend.draw(*at, theme, inner, ratio, &mut sprites),
            }
        }
        sprites
    }
}

impl Legend {
    /// Its width and height in CSS pixels, for text `em` pixels high.
    fn size(&self, em: f64) -> [f64; 2] {
        let (body, _) = self.body.layout(em);
        match &self.title {
            Some(title) => [title.size[0].max(body[0]), title.size[1] + TICK * em + body[1]],
            None => body,
        }
    }

    /// Draws the legend with its top left at `at`'s.
    fn draw(&self, at: Area, theme: &Theme, inner: &mut Inner, ratio: f64, sprites: &mut Vec<wgsl::Sprite>) {
        let em = f64::from(theme.text.size);
        let mut top = at[1];
        if let Some(title) = &self.title {
            let mut writer = Writer::new(inner, theme, 1.0, ratio, theme.text.color);
            sprites.extend(writer.text(&title.text, [at[0], top], [0.0, 0.0]));
            top += title.size[1] + TICK * em;
        }
        let (_, origin) = self.body.layout(em);
        let [x, y] = [at[0] + origin[0], top + origin[1]];
        let text = theme.text.color.alpha(0.85);
        let mut writer = Writer::new(inner, theme, SMALL, ratio, text);
        match &self.body {
            Body::Bar { fills, ticks, length, upright, gapped } => {
                let thick = BAR[1] * em;
                // A point at fraction `t` along the bar, and a span of it from `a` to `b`, across
                // its whole thickness.
                let point =
                    |t: f64| if *upright { [x + thick, y + (1.0 - t) * length] } else { [x + t * length, y + thick] };
                let gap = if *gapped { 1.0 / length } else { 0.0 };
                for &([a, b], color) in fills {
                    let (a, b) = (a + gap, (b - gap).max(a + gap));
                    let [from, to] = if *upright {
                        [[x, y + (1.0 - b) * length], [x + thick, y + (1.0 - a) * length]]
                    } else {
                        [[x + a * length, y], [x + b * length, y + thick]]
                    };
                    sprites.push(fill(from, to, color, 0.0));
                }
                let mark = TICK * em;
                for (t, label) in ticks {
                    let base = point(*t);
                    if *upright {
                        sprites.push(line(base, [base[0] + mark, base[1]], 1.0, text.alpha(0.5)));
                        sprites.extend(writer.text(
                            &label.text,
                            [base[0] + mark + LABEL_GAP * em, base[1]],
                            [0.0, 0.5],
                        ));
                    } else {
                        sprites.push(line(base, [base[0], base[1] + mark], 1.0, text.alpha(0.5)));
                        sprites.extend(writer.text(&label.text, [base[0], base[1] + mark], [0.5, 0.0]));
                    }
                }
            }
            Body::Swatches(swatches) => {
                let (row, swatch) = (ROW * em, SWATCH * em);
                let mut left = x;
                for column in swatches.chunks(ROWS) {
                    let mut widest: f64 = 0.0;
                    for (r, (color, name)) in column.iter().enumerate() {
                        let middle = y + (r as f64 + 0.5) * row;
                        sprites.push(fill(
                            [left, middle - swatch / 2.0],
                            [left + swatch, middle + swatch / 2.0],
                            *color,
                            0.0,
                        ));
                        sprites.extend(writer.text(&name.text, [left + swatch + 0.5 * em, middle], [0.0, 0.5]));
                        widest = widest.max(name.size[0]);
                    }
                    left += swatch + 0.5 * em + widest + ROW * em;
                }
            }
        }
    }
}

impl Body {
    /// Its width and height in CSS pixels, for text `em` pixels high, and where its bar's corner
    /// lies within them. Labels can reach past a bar's ends.
    fn layout(&self, em: f64) -> ([f64; 2], [f64; 2]) {
        match self {
            Body::Bar { ticks, length, upright, .. } => bar_layout(ticks, *length, *upright, em),
            Body::Swatches(swatches) => {
                let rows = swatches.len().min(ROWS);
                let width: f64 = swatches
                    .chunks(ROWS)
                    .map(|column| SWATCH * em + 0.5 * em + column.iter().map(|(_, n)| n.size[0]).fold(0.0, f64::max))
                    .sum::<f64>()
                    + ROW * em * swatches.len().div_ceil(ROWS).saturating_sub(1) as f64;
                ([width, rows as f64 * ROW * em], [0.0, 0.0])
            }
        }
    }
}

/// The width and height in CSS pixels of a bar `length` long with labels `ticks`, for text `em`
/// pixels high, and where the bar's corner lies within them. Labels can reach past its ends.
fn bar_layout(ticks: &[(f64, Text)], length: f64, upright: bool, em: f64) -> ([f64; 2], [f64; 2]) {
    let thick = BAR[1] * em;
    let mark = TICK * em;
    let tallest = ticks.iter().map(|(_, l)| l.size[1]).fold(0.0, f64::max);
    let widest = ticks.iter().map(|(_, l)| l.size[0]).fold(0.0, f64::max);
    // How far labels reach before and after the bar along it.
    let reach = |center: &dyn Fn(f64) -> f64, half: &dyn Fn(&Text) -> f64| {
        ticks.iter().fold([0.0_f64, length], |[lo, hi], (t, label)| {
            let c = center(*t);
            [lo.min(c - half(label)), hi.max(c + half(label))]
        })
    };
    if upright {
        let [lo, hi] = reach(&|t| (1.0 - t) * length, &|l| l.size[1] / 2.0);
        ([thick + mark + LABEL_GAP * em + widest, hi - lo], [0.0, -lo])
    } else {
        let [lo, hi] = reach(&|t| t * length, &|l| l.size[0] / 2.0);
        ([hi - lo, thick + mark + tallest], [-lo, 0.0])
    }
}

/// A rectangle filled with `color` from corner `a` to corner `b`, in CSS pixels, with corners
/// rounded by `radius`.
fn fill(a: [f64; 2], b: [f64; 2], color: Color, radius: f64) -> wgsl::Sprite {
    let mut sprite = line(a, b, radius as f32, color);
    sprite.kind = wgsl::SPRITE_FILL;
    sprite
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A title guide `size` big.
    fn guide(size: [f64; 2]) -> (Guide, [f64; 2]) {
        let text = |size| Text { text: "t".into(), size };
        (Guide::Title(text(size), None), size)
    }

    /// A legend guide `size` big.
    fn legend(size: [f64; 2]) -> (Guide, [f64; 2]) {
        (Guide::Legend(Legend { title: None, body: Body::Swatches(Vec::new()) }), size)
    }

    #[test]
    fn guides_wrap_into_new_lanes_and_a_title_keeps_its_row() {
        let mut columns: Lanes = Vec::new();
        for size in [[10.0, 40.0], [20.0, 40.0], [5.0, 40.0]] {
            let (g, s) = legend(size);
            stack(&mut columns, g, s, false, 100.0, 10.0, false);
        }
        // 40 + 10 + 40 fits 100, a third does not.
        assert_eq!(columns.iter().map(Vec::len).collect::<Vec<_>>(), [2, 1]);
        assert_eq!(thickness(&columns, false, 10.0), 20.0 + 10.0 + 5.0, "the widest of each column, and a gap");
        let mut rows: Lanes = Vec::new();
        let (g, s) = guide([30.0, 20.0]);
        stack(&mut rows, g, s, true, 500.0, 10.0, true);
        let (g, s) = legend([30.0, 12.0]);
        stack(&mut rows, g, s, true, 500.0, 10.0, false);
        assert_eq!(rows.len(), 2, "a legend after a title starts a row of its own");
        assert_eq!(thickness(&rows, true, 10.0), 20.0 + 10.0 + 12.0);
    }

    #[test]
    fn lanes_place_guides_from_their_edge_and_corner() {
        let lanes: Lanes = vec![vec![legend([10.0, 20.0]), legend([30.0, 10.0])], vec![legend([5.0, 5.0])]];
        // Columns from a right edge at 100 inward, from a bottom at 200 up, flush right.
        let placed: Vec<Area> =
            place(lanes, false, [100.0, -1.0], [200.0, -1.0], true, 4.0).into_iter().map(|(_, at)| at).collect();
        assert_eq!(placed[0], [90.0, 180.0, 100.0, 200.0], "the first sits in the corner");
        assert_eq!(placed[1], [70.0, 166.0, 100.0, 176.0], "the next above it, flush right");
        assert_eq!(placed[2], [61.0, 195.0, 66.0, 200.0], "a second column left of the first's widest");
    }
}
