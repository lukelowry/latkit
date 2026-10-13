//! Scenes from serde data, mirroring the builders field for field, in camelCase:
//!
//! ```json
//! {
//!   "space": "globe",
//!   "marks": [
//!     { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"], "flow": { "op": "div", "args": ["p", 20] } } },
//!     { "vertices": { "of": ["grid", "Bus"], "position": ["lon", "lat"], "color": { "colormap": "vm", "map": "balance" } } }
//!   ],
//!   "layout": { "layered": { "flow": "right" } },
//!   "theme": { "base": "light", "vertexRadius": 5 },
//!   "ease": 0.3
//! }
//! ```
//!
//! A space is `"plane"`, `"earth"` (mercator), `"globe"`, `"plot"`, or an object such as
//! `{ "plane": { "grid": { "dots": 10, "snap": true } } }`.

use std::time::Duration;

use serde::Deserialize;
use serde::de::{self, Deserializer};

use super::{
    Axis, Controls, Direction, Earth, Edges, Faces, Format, Grid, Image, Interpolation, Label, Layered, Layout, Lines,
    Mark, Marker, Plane, Plot, Port, Projection, Route, Scene, Shape, Side, Space, Stress, Theme, Vertices,
};
use crate::{Color, Expr, Name, Size};

impl<'de> Deserialize<'de> for Scene {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Scene, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Form {
            space: Space,
            #[serde(default)]
            marks: Vec<Mark>,
            #[serde(default)]
            layout: Layout,
            #[serde(default)]
            theme: Option<Theme>,
            #[serde(default)]
            controls: Option<Controls>,
            #[serde(default)]
            ease: Option<f64>,
        }
        let form = Form::deserialize(deserializer)?;
        let mut scene = Scene::new(form.space).layout(form.layout);
        if let Some(controls) = form.controls {
            scene = scene.controls(controls);
        }
        if let Some(theme) = form.theme {
            scene = scene.theme(theme);
        }
        if let Some(ease) = form.ease {
            if !(ease >= 0.0 && ease.is_finite()) {
                return Err(de::Error::custom("ease is seconds, at least 0"));
            }
            scene = scene.ease(Duration::from_secs_f64(ease));
        }
        Ok(form.marks.into_iter().fold(scene, Scene::draw))
    }
}

impl<'de> Deserialize<'de> for Space {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Space, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        enum Tagged {
            Earth(EarthForm),
            Plane(PlaneForm),
            Plot(PlotForm),
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Form {
            Name(String),
            Tagged(Tagged),
        }
        Ok(match Form::deserialize(deserializer)? {
            Form::Name(name) => match name.as_str() {
                "plane" => Space::Plane(Plane::default()),
                "earth" | "mercator" => Space::Earth(Earth::mercator()),
                "globe" => Space::Earth(Earth::globe()),
                "plot" => Space::Plot(Plot::default()),
                other => {
                    return Err(de::Error::unknown_variant(other, &["plane", "earth", "mercator", "globe", "plot"]));
                }
            },
            Form::Tagged(Tagged::Earth(e)) => Space::Earth(Earth {
                projection: e.projection,
                surface: e.surface,
                graticule: e.graticule.unwrap_or(true),
            }),
            Form::Tagged(Tagged::Plane(p)) => Space::Plane(Plane { grid: p.grid.unwrap_or(Plane::default().grid) }),
            Form::Tagged(Tagged::Plot(p)) => {
                Space::Plot(Plot { x: p.x.unwrap_or_default(), y: p.y.unwrap_or_default() })
            }
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EarthForm {
    #[serde(default)]
    projection: Projection,
    #[serde(default)]
    surface: Option<Color>,
    #[serde(default)]
    graticule: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlaneForm {
    #[serde(default)]
    grid: Option<Grid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlotForm {
    #[serde(default)]
    x: Option<Axis>,
    #[serde(default)]
    y: Option<Axis>,
}

impl<'de> Deserialize<'de> for Projection {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Projection, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "mercator" => Ok(Projection::Mercator),
            "globe" => Ok(Projection::Globe),
            other => Err(de::Error::unknown_variant(other, &["mercator", "globe"])),
        }
    }
}

impl<'de> Deserialize<'de> for Grid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Grid, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Form {
            #[serde(default)]
            lines: Option<f64>,
            #[serde(default)]
            dots: Option<f64>,
            #[serde(default)]
            snap: bool,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            Off(String),
            Form(Form),
        }
        match Either::deserialize(deserializer)? {
            Either::Off(off) if off == "off" => Ok(Grid::Off),
            Either::Off(other) => Err(de::Error::unknown_variant(&other, &["off"])),
            Either::Form(Form { lines: Some(pitch), dots: None, .. }) => Ok(Grid::Lines { pitch }),
            Either::Form(Form { lines: None, dots: Some(pitch), snap }) => Ok(Grid::Dots { pitch, snap }),
            Either::Form(_) => Err(de::Error::custom("a grid is \"off\", { lines: pitch }, or { dots: pitch, snap }")),
        }
    }
}

impl<'de> Deserialize<'de> for Axis {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Axis, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Tick {
            At(f64),
            Labeled(f64, Option<String>),
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Form {
            #[serde(default)]
            label: Option<String>,
            #[serde(default)]
            grid: Option<bool>,
            #[serde(default)]
            hidden: bool,
            #[serde(default)]
            ticks: Option<Vec<Tick>>,
            #[serde(default)]
            format: Option<String>,
            #[serde(default)]
            precision: Option<u8>,
        }
        let form = Form::deserialize(deserializer)?;
        let format = match form.format.as_deref() {
            None | Some("auto") => Format::Auto,
            Some("fixed") => Format::Fixed,
            Some("scientific") => Format::Scientific,
            Some("engineering") => Format::Engineering,
            Some(other) => {
                return Err(de::Error::unknown_variant(other, &["auto", "fixed", "scientific", "engineering"]));
            }
        };
        let ticks = form.ticks.map(|ticks| {
            ticks
                .into_iter()
                .map(|t| match t {
                    Tick::At(v) => (v, None),
                    Tick::Labeled(v, text) => (v, text),
                })
                .collect()
        });
        Ok(Axis {
            label: form.label,
            grid: form.grid.unwrap_or(true),
            hidden: form.hidden,
            ticks,
            format,
            precision: form.precision,
        })
    }
}

/// Applies the options every mark has.
macro_rules! style {
    ($form:ident, $mark:ident) => {{
        let mut mark = $mark;
        if let Some(color) = $form.color {
            mark = mark.color(color);
        }
        if let Some(visible) = $form.visible {
            mark = mark.visible(visible);
        }
        if let Some(name) = $form.name {
            mark = mark.named(name);
        }
        if let Some(on) = $form.pick {
            mark = mark.pick(on);
        }
        if let Some(on) = $form.select {
            mark = mark.select(on);
        }
        if let Some(on) = $form.drag {
            mark = mark.drag(on);
        }
        if let Some(label) = $form.label {
            mark = mark.label(label);
        }
        mark
    }};
}

impl<'de> Deserialize<'de> for Label {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Label, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Form {
            text: Expr,
            #[serde(default)]
            size: Option<f32>,
            #[serde(default)]
            color: Option<Expr>,
            #[serde(default)]
            priority: Option<Expr>,
            #[serde(default)]
            max_width: Option<f32>,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            Text(Expr),
            Form(Box<Form>),
        }
        Ok(match Either::deserialize(deserializer)? {
            Either::Text(text) => Label::new(text),
            Either::Form(form) => {
                let mut label = Label::new(form.text);
                if let Some(size) = form.size {
                    label = label.size(size);
                }
                if let Some(color) = form.color {
                    label = label.color(color);
                }
                if let Some(priority) = form.priority {
                    label = label.priority(priority);
                }
                if let Some(width) = form.max_width {
                    label = label.max_width(width);
                }
                label
            }
        })
    }
}

impl<'de> Deserialize<'de> for Mark {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Mark, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        enum Form {
            Vertices(VerticesForm),
            Edges(EdgesForm),
            Faces(FacesForm),
            Lines(LinesForm),
        }
        Ok(match Form::deserialize(deserializer)? {
            Form::Vertices(v) => Mark::Vertices(v.build()),
            Form::Edges(e) => Mark::Edges(e.build()),
            Form::Faces(f) => Mark::Faces(f.build()),
            Form::Lines(l) => Mark::Lines(l.build()),
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerticesForm {
    of: (Name, Name),
    #[serde(default)]
    position: Option<(Expr, Expr)>,
    #[serde(default)]
    elevation: Option<Expr>,
    #[serde(default)]
    radius: Option<Size>,
    #[serde(default)]
    size: Option<(Size, Size)>,
    #[serde(default)]
    marker: Option<Marker>,
    #[serde(default)]
    status: Option<Expr>,
    #[serde(default)]
    shadow: Option<bool>,
    #[serde(default)]
    ports: Vec<(Name, Port)>,
    #[serde(default)]
    contains: Option<(Name, Name)>,
    #[serde(default)]
    collapsed: Option<Expr>,
    #[serde(default)]
    color: Option<Expr>,
    #[serde(default)]
    visible: Option<Expr>,
    #[serde(default)]
    name: Option<Name>,
    #[serde(default)]
    pick: Option<bool>,
    #[serde(default)]
    select: Option<bool>,
    #[serde(default)]
    drag: Option<bool>,
    #[serde(default)]
    label: Option<Label>,
}

impl VerticesForm {
    fn build(self) -> Vertices {
        let mut v = Vertices::of(self.of.0, self.of.1);
        if let Some((x, y)) = self.position {
            v = v.position(x, y);
        }
        if let Some(z) = self.elevation {
            v = v.elevation(z);
        }
        if let Some(radius) = self.radius {
            v = v.radius(radius);
        }
        if let Some((w, h)) = self.size {
            v = v.size(w, h);
        }
        if let Some(marker) = self.marker {
            v = v.marker(marker);
        }
        if let Some(status) = self.status {
            v = v.status(status);
        }
        if let Some(on) = self.shadow {
            v = v.shadow(on);
        }
        for (reference, port) in self.ports {
            v = v.port(reference, port);
        }
        if let Some((table, reference)) = self.contains {
            v = v.contains(table, reference);
        }
        if let Some(collapsed) = self.collapsed {
            v = v.collapsed(collapsed);
        }
        style!(self, v)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EdgesForm {
    of: (Name, Name),
    #[serde(default)]
    ends: Option<(Name, Name)>,
    #[serde(default)]
    width: Option<Size>,
    #[serde(default)]
    dash: Option<Expr>,
    #[serde(default)]
    flow: Option<Expr>,
    #[serde(default)]
    shadow: Option<bool>,
    #[serde(default)]
    bends: Option<Name>,
    #[serde(default)]
    route: Option<Route>,
    #[serde(default)]
    arrows: Option<bool>,
    #[serde(default)]
    color: Option<Expr>,
    #[serde(default)]
    visible: Option<Expr>,
    #[serde(default)]
    name: Option<Name>,
    #[serde(default)]
    pick: Option<bool>,
    #[serde(default)]
    select: Option<bool>,
    #[serde(default)]
    drag: Option<bool>,
    #[serde(default)]
    label: Option<Label>,
}

impl EdgesForm {
    fn build(self) -> Edges {
        let mut e = Edges::of(self.of.0, self.of.1);
        if let Some((from, to)) = self.ends {
            e = e.ends(from, to);
        }
        if let Some(width) = self.width {
            e = e.width(width);
        }
        if let Some(dash) = self.dash {
            e = e.dash(dash);
        }
        if let Some(flow) = self.flow {
            e = e.flow(flow);
        }
        if let Some(on) = self.shadow {
            e = e.shadow(on);
        }
        if let Some(bends) = self.bends {
            e = e.bends(bends);
        }
        if let Some(route) = self.route {
            e = e.route(route);
        }
        if let Some(on) = self.arrows {
            e = e.arrows(on);
        }
        style!(self, e)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FacesForm {
    of: (Name, Name),
    #[serde(default)]
    corners: Option<(Name, Name, Name)>,
    #[serde(default)]
    shadow: Option<bool>,
    #[serde(default)]
    color: Option<Expr>,
    #[serde(default)]
    visible: Option<Expr>,
    #[serde(default)]
    name: Option<Name>,
    #[serde(default)]
    pick: Option<bool>,
    #[serde(default)]
    select: Option<bool>,
    #[serde(default)]
    drag: Option<bool>,
    #[serde(default)]
    label: Option<Label>,
}

impl FacesForm {
    fn build(self) -> Faces {
        let mut f = Faces::of(self.of.0, self.of.1);
        if let Some((a, b, c)) = self.corners {
            f = f.corners(a, b, c);
        }
        if let Some(on) = self.shadow {
            f = f.shadow(on);
        }
        style!(self, f)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LinesForm {
    of: (Name, Name),
    #[serde(default)]
    samples: Option<Name>,
    #[serde(default)]
    width: Option<Size>,
    #[serde(default)]
    dash: Option<Expr>,
    #[serde(default)]
    interpolation: Option<Interpolation>,
    #[serde(default)]
    color: Option<Expr>,
    #[serde(default)]
    visible: Option<Expr>,
    #[serde(default)]
    name: Option<Name>,
    #[serde(default)]
    pick: Option<bool>,
    #[serde(default)]
    select: Option<bool>,
    #[serde(default)]
    drag: Option<bool>,
    #[serde(default)]
    label: Option<Label>,
}

impl LinesForm {
    fn build(self) -> Lines {
        let mut l = Lines::of(self.of.0, self.of.1);
        if let Some(samples) = self.samples {
            l = l.samples(samples);
        }
        if let Some(width) = self.width {
            l = l.width(width);
        }
        if let Some(dash) = self.dash {
            l = l.dash(dash);
        }
        if let Some(interpolation) = self.interpolation {
            l = l.interpolation(interpolation);
        }
        style!(self, l)
    }
}

impl<'de> Deserialize<'de> for Controls {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Controls, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Form {
            pan: Option<bool>,
            zoom: Option<bool>,
            turn: Option<bool>,
            keyboard: Option<bool>,
            hover: Option<bool>,
            pick_radius: Option<f32>,
            select_box: Option<bool>,
            connect: Option<bool>,
            delete: Option<bool>,
        }
        let form = Form::deserialize(deserializer)?;
        let d = Controls::default();
        Ok(Controls {
            pan: form.pan.unwrap_or(d.pan),
            zoom: form.zoom.unwrap_or(d.zoom),
            turn: form.turn.unwrap_or(d.turn),
            keyboard: form.keyboard.unwrap_or(d.keyboard),
            hover: form.hover.unwrap_or(d.hover),
            pick_radius: form.pick_radius.unwrap_or(d.pick_radius),
            select_box: form.select_box.unwrap_or(d.select_box),
            connect: form.connect.unwrap_or(d.connect),
            delete: form.delete.unwrap_or(d.delete),
        })
    }
}

impl<'de> Deserialize<'de> for Marker {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Marker, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Block {
            #[serde(default)]
            corner: Option<f32>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Gauge {
            fill: Expr,
            #[serde(default)]
            shape: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Pie {
            slices: Vec<Expr>,
            colors: Vec<Color>,
            #[serde(default)]
            hole: f32,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wgsl {
            source: String,
            #[serde(default)]
            inputs: Vec<Expr>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct ImageForm {
            size: [u32; 2],
            rgba: Vec<u8>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Icon {
            images: Vec<ImageForm>,
            index: Expr,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        enum Tagged {
            Block(Block),
            Gauge(Gauge),
            Pie(Pie),
            Icon(Icon),
            Wgsl(Wgsl),
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Form {
            Name(String),
            Tagged(Tagged),
        }
        let shape = |name: Option<&str>| match name {
            None | Some("ellipse" | "disc") => Ok(Shape::Ellipse),
            Some("rectangle") => Ok(Shape::Rectangle),
            Some("rounded") => Ok(Shape::Rounded),
            Some("diamond") => Ok(Shape::Diamond),
            Some(other) => Err(de::Error::unknown_variant(other, &["ellipse", "rectangle", "rounded", "diamond"])),
        };
        Ok(match Form::deserialize(deserializer)? {
            Form::Name(name) => match name.as_str() {
                "disc" | "ellipse" => Marker::Shape(Shape::Ellipse),
                "rectangle" => Marker::Shape(Shape::Rectangle),
                "rounded" => Marker::Shape(Shape::Rounded),
                "diamond" => Marker::Shape(Shape::Diamond),
                "block" => Marker::block(),
                other => {
                    return Err(de::Error::unknown_variant(
                        other,
                        &["disc", "ellipse", "rectangle", "rounded", "diamond", "block"],
                    ));
                }
            },
            Form::Tagged(Tagged::Block(b)) => Marker::Block { corner: b.corner.unwrap_or(4.0) },
            Form::Tagged(Tagged::Gauge(g)) => Marker::Gauge { fill: g.fill, shape: shape(g.shape.as_deref())? },
            Form::Tagged(Tagged::Pie(p)) => Marker::Pie { slices: p.slices, colors: p.colors, hole: p.hole },
            Form::Tagged(Tagged::Wgsl(w)) => Marker::Wgsl { source: w.source.into(), inputs: w.inputs },
            Form::Tagged(Tagged::Icon(i)) => {
                let mut images = Vec::with_capacity(i.images.len());
                for image in i.images {
                    if image.rgba.len() != (image.size[0] * image.size[1] * 4) as usize {
                        return Err(de::Error::custom("an image's rgba holds four bytes per texel of its size"));
                    }
                    images.push(Image { size: image.size, rgba: image.rgba.into() });
                }
                Marker::Icon { images, index: i.index }
            }
        })
    }
}

impl<'de> Deserialize<'de> for Layout {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Layout, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct StressForm {
            #[serde(default)]
            gap: Option<f64>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct LayeredForm {
            #[serde(default)]
            flow: Option<Direction>,
            #[serde(default)]
            gap: Option<f64>,
            #[serde(default)]
            rank_gap: Option<f64>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        enum Tagged {
            Stress(StressForm),
            Layered(LayeredForm),
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Form {
            Name(String),
            Tagged(Tagged),
        }
        Ok(match Form::deserialize(deserializer)? {
            Form::Name(name) => match name.as_str() {
                "none" => Layout::None,
                "stress" => Layout::Stress(Stress::default()),
                "layered" => Layout::Layered(Layered::default()),
                other => return Err(de::Error::unknown_variant(other, &["none", "stress", "layered"])),
            },
            Form::Tagged(Tagged::Stress(s)) => Layout::Stress(Stress { gap: s.gap.unwrap_or(Stress::default().gap) }),
            Form::Tagged(Tagged::Layered(l)) => {
                let d = Layered::default();
                Layout::Layered(Layered {
                    flow: l.flow.unwrap_or(d.flow),
                    gap: l.gap.unwrap_or(d.gap),
                    rank_gap: l.rank_gap.unwrap_or(d.rank_gap),
                })
            }
        })
    }
}

impl<'de> Deserialize<'de> for Interpolation {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Interpolation, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "linear" => Ok(Interpolation::Linear),
            "stepBefore" => Ok(Interpolation::StepBefore),
            "stepAfter" => Ok(Interpolation::StepAfter),
            other => Err(de::Error::unknown_variant(other, &["linear", "stepBefore", "stepAfter"])),
        }
    }
}

impl<'de> Deserialize<'de> for Route {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Route, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "straight" => Ok(Route::Straight),
            "geodesic" => Ok(Route::Geodesic),
            "orthogonal" => Ok(Route::Orthogonal),
            other => Err(de::Error::unknown_variant(other, &["straight", "geodesic", "orthogonal"])),
        }
    }
}

impl<'de> Deserialize<'de> for Side {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Side, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "left" => Ok(Side::Left),
            "right" => Ok(Side::Right),
            "top" => Ok(Side::Top),
            "bottom" => Ok(Side::Bottom),
            other => Err(de::Error::unknown_variant(other, &["left", "right", "top", "bottom"])),
        }
    }
}

impl<'de> Deserialize<'de> for Port {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Port, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Full {
            side: Side,
            order: Option<u32>,
            label: Option<String>,
            shape: Option<String>,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Form {
            Side(Side),
            Full(Full),
        }
        Ok(match Form::deserialize(deserializer)? {
            Form::Side(side) => Port::new(side),
            Form::Full(full) => Port {
                side: full.side,
                order: full.order,
                label: full.label,
                shape: match full.shape.as_deref() {
                    None | Some("ellipse") => Shape::Ellipse,
                    Some("rectangle") => Shape::Rectangle,
                    Some("rounded") => Shape::Rounded,
                    Some("diamond") => Shape::Diamond,
                    Some(other) => {
                        return Err(de::Error::unknown_variant(other, &["ellipse", "rectangle", "rounded", "diamond"]));
                    }
                },
            },
        })
    }
}

impl<'de> Deserialize<'de> for Direction {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Direction, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "right" => Ok(Direction::Right),
            "left" => Ok(Direction::Left),
            "down" => Ok(Direction::Down),
            "up" => Ok(Direction::Up),
            other => Err(de::Error::unknown_variant(other, &["right", "left", "down", "up"])),
        }
    }
}

impl<'de> Deserialize<'de> for Theme {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Theme, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[allow(clippy::option_option, reason = "absent keeps the base theme's color; null removes it")]
        struct Form {
            #[serde(default)]
            base: Option<String>,
            background: Option<Color>,
            surface: Option<Color>,
            grid: Option<Color>,
            vertex: Option<Color>,
            vertex_radius: Option<f32>,
            #[serde(default, deserialize_with = "present")]
            edge: Option<Option<Color>>,
            edge_width: Option<f32>,
            line: Option<Color>,
            line_width: Option<f32>,
            shading: Option<f32>,
            text: Option<Color>,
            font: Option<String>,
            font_size: Option<f32>,
            playhead: Option<Color>,
            missing: Option<Color>,
            hover: Option<Color>,
            #[serde(default, deserialize_with = "present")]
            selected: Option<Option<Color>>,
            glow: Option<f32>,
            dim: Option<f32>,
            hover_scale: Option<f32>,
            dash: Option<f32>,
            flow: Option<Color>,
            flow_spacing: Option<f32>,
            edge_spacing: Option<f32>,
            arrow: Option<f32>,
            halo: Option<f32>,
            group_padding: Option<f32>,
            shadow: Option<ShadowForm>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct ShadowForm {
            color: Option<Color>,
            light: Option<[f32; 3]>,
            softness: Option<f32>,
            lift: Option<f32>,
        }
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Either {
            Name(String),
            Form(Box<Form>),
        }
        let base = |name: &str| match name {
            "dark" => Ok(Theme::dark()),
            "light" => Ok(Theme::light()),
            other => Err(de::Error::unknown_variant(other, &["dark", "light"])),
        };
        let form = match Either::deserialize(deserializer)? {
            Either::Name(name) => return base(&name),
            Either::Form(form) => form,
        };
        let mut t = match &form.base {
            Some(name) => base(name)?,
            None => Theme::default(),
        };
        macro_rules! set {
            ($($field:ident),*) => {$(
                if let Some(v) = form.$field {
                    t.$field = v;
                }
            )*};
        }
        set!(background, surface, grid, vertex, vertex_radius, edge, edge_width, missing, hover, selected, glow, dim);
        set!(hover_scale, dash, flow, flow_spacing, line, line_width, shading, text, font_size, playhead);
        set!(edge_spacing, arrow, halo, group_padding);
        if let Some(font) = form.font {
            t.font = font.into();
        }
        if let Some(shadow) = form.shadow {
            let s = &mut t.shadow;
            s.color = shadow.color.unwrap_or(s.color);
            s.light = shadow.light.unwrap_or(s.light);
            s.softness = shadow.softness.unwrap_or(s.softness);
            s.lift = shadow.lift.unwrap_or(s.lift);
        }
        Ok(t)
    }
}

/// Reads a field that is present, so `null` stays apart from absent: `Some(None)`, not `None`.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Colormap, field};

    #[test]
    fn scenes_match_builders() {
        let json = r#"{
            "space": "globe",
            "marks": [
                { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"], "width": 2 } },
                { "vertices": { "of": ["grid", "Bus"], "position": ["lon", "lat"], "radius": { "units": 3 },
                    "color": { "colormap": "vm", "map": "balance", "domain": [0.95, 1.05] } } }
            ],
            "theme": { "base": "light", "vertexRadius": 5 },
            "ease": 0
        }"#;
        let scene: Scene = serde_json::from_str(json).expect("a scene");
        let built = Scene::new(Earth::globe())
            .theme(Theme { vertex_radius: 5.0, ..Theme::light() })
            .ease(Duration::ZERO)
            .draw(Edges::of("grid", "Branch").ends("from", "to").width(2.0))
            .draw(
                Vertices::of("grid", "Bus")
                    .position("lon", "lat")
                    .radius(crate::units(3.0))
                    .color(field("vm").colormap(Colormap::BALANCE).domain(0.95..=1.05)),
            );
        assert_eq!(scene, built);
    }

    #[test]
    fn faces_lines_and_controls_match_builders() {
        let json = r##"{
            "space": "plane",
            "controls": { "turn": false, "pickRadius": 12 },
            "marks": [
                { "faces": { "of": ["mesh", "Face"], "corners": ["a", "b", "c"], "pick": false } },
                { "lines": { "of": ["mesh", "Body"], "samples": "height", "color": "#66c7ff", "width": 2 } },
                { "vertices": { "of": ["mesh", "Vertex"], "select": false, "drag": true } }
            ]
        }"##;
        let scene: Scene = serde_json::from_str(json).expect("a scene");
        let built = Scene::new(Plane::default())
            .controls(Controls { turn: false, pick_radius: 12.0, ..Controls::default() })
            .draw(Faces::of("mesh", "Face").corners("a", "b", "c").pick(false))
            .draw(Lines::of("mesh", "Body").samples("height").color(Color::hex("#66c7ff").expect("hex")).width(2.0))
            .draw(Vertices::of("mesh", "Vertex").select(false).drag(true));
        assert_eq!(scene, built);
    }

    #[test]
    fn null_removes_a_theme_color_and_absent_keeps_it() {
        let theme = |json: &str| serde_json::from_str::<Theme>(json).expect("a theme");
        assert!(Theme::default().selected.is_some());
        assert_eq!(theme(r#"{ "selected": null }"#).selected, None);
        assert_eq!(theme("{}").selected, Theme::default().selected);
    }

    #[test]
    fn unknown_options_are_refused() {
        let error = serde_json::from_str::<Scene>(
            r#"{"space": "plane", "marks": [{"vertices": {"of": ["a", "b"], "colour": "x"}}]}"#,
        )
        .expect_err("a typo");
        assert!(error.to_string().contains("colour"), "{error}");
    }
}
