//! Mapbox vector tiles: a tile's layers, their features' geometry in longitude and latitude, clipped
//! to the tile so neighbors never overlap, and their properties.

use crate::tiles::TileKey;

type Point = [f64; 2];

/// What a feature's geometry is.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Kind {
    Points,
    Lines,
    Polygons,
}

/// A property value as a tile holds it.
#[derive(Clone, PartialEq, Debug)]
pub(crate) enum Property {
    Text(String),
    Number(f64),
    Bool(bool),
}

/// A feature's geometry, in degrees.
#[derive(Clone, PartialEq, Debug)]
pub(crate) enum Shape {
    Points(Vec<Point>),
    Lines(Vec<Vec<Point>>),
    Polygons(Vec<Vec<Vec<Point>>>),
}

impl Shape {
    pub(crate) fn kind(&self) -> Kind {
        match self {
            Shape::Points(_) => Kind::Points,
            Shape::Lines(_) => Kind::Lines,
            Shape::Polygons(_) => Kind::Polygons,
        }
    }
}

/// One feature: its place among its layer's features, its shape, and its properties by key.
#[derive(Clone, Debug)]
pub(crate) struct Feature {
    pub(crate) shape: Shape,
    pub(crate) properties: Vec<(u32, Property)>,
}

/// One layer: its name, its keys, and its features.
#[derive(Clone, Debug, Default)]
pub(crate) struct Layer {
    pub(crate) name: String,
    pub(crate) keys: Vec<String>,
    pub(crate) features: Vec<Feature>,
}

/// The layers of tile `key`'s `bytes`; a feature's geometry clipped to the tile, and one left with
/// nothing inside it dropped. Bytes that are no tile answer `None`.
pub(crate) fn decode(bytes: &[u8], key: TileKey) -> Option<Vec<Layer>> {
    let mut layers = Vec::new();
    let mut tile = Reader::new(bytes);
    while !tile.done() {
        let (field, wire) = tile.tag()?;
        if field == 3 && wire == LENGTH {
            layers.push(layer(tile.bytes()?, key)?);
        } else {
            tile.skip(wire)?;
        }
    }
    Some(layers)
}

fn layer(bytes: &[u8], key: TileKey) -> Option<Layer> {
    let mut out = Layer::default();
    let mut values = Vec::new();
    let mut raw = Vec::new();
    let mut extent = 4096_u32;
    let mut reader = Reader::new(bytes);
    while !reader.done() {
        let (field, wire) = reader.tag()?;
        match (field, wire) {
            (1, LENGTH) => out.name = String::from_utf8_lossy(reader.bytes()?).into_owned(),
            (2, LENGTH) => raw.push(reader.bytes()?),
            (3, LENGTH) => out.keys.push(String::from_utf8_lossy(reader.bytes()?).into_owned()),
            (4, LENGTH) => values.push(value(reader.bytes()?)?),
            (5, VARINT) => extent = reader.varint()? as u32,
            _ => reader.skip(wire)?,
        }
    }
    let frame = Frame::new(key, f64::from(extent.max(1)));
    out.features = raw.into_iter().filter_map(|bytes| feature(bytes, &values, &frame)).collect();
    Some(out)
}

fn value(bytes: &[u8]) -> Option<Property> {
    let mut reader = Reader::new(bytes);
    let mut out = Property::Bool(false);
    while !reader.done() {
        let (field, wire) = reader.tag()?;
        out = match (field, wire) {
            (1, LENGTH) => Property::Text(String::from_utf8_lossy(reader.bytes()?).into_owned()),
            (2, FIXED32) => Property::Number(f64::from(f32::from_le_bytes(reader.take()?))),
            (3, FIXED64) => Property::Number(f64::from_le_bytes(reader.take()?)),
            (4, VARINT) => Property::Number(reader.varint()? as i64 as f64),
            (5, VARINT) => Property::Number(reader.varint()? as f64),
            (6, VARINT) => Property::Number(zigzag(reader.varint()?) as f64),
            (7, VARINT) => Property::Bool(reader.varint()? != 0),
            _ => {
                reader.skip(wire)?;
                continue;
            }
        };
    }
    Some(out)
}

/// A feature: `None` when nothing of it lies in the tile, or its bytes are no feature, which drops
/// it alone.
fn feature(bytes: &[u8], values: &[Property], frame: &Frame) -> Option<Feature> {
    let mut reader = Reader::new(bytes);
    let (mut tags, mut geometry, mut kind) = (Vec::new(), Vec::new(), 0);
    while !reader.done() {
        let (field, wire) = reader.tag()?;
        match (field, wire) {
            (2, LENGTH) => packed(reader.bytes()?, &mut tags)?,
            (2, VARINT) => tags.push(reader.varint()? as u32),
            (3, VARINT) => kind = reader.varint()?,
            (4, LENGTH) => packed(reader.bytes()?, &mut geometry)?,
            (4, VARINT) => geometry.push(reader.varint()? as u32),
            _ => reader.skip(wire)?,
        }
    }
    let shape = match kind {
        1 => frame.points(&geometry),
        2 => frame.lines(&geometry),
        3 => frame.polygons(&geometry),
        _ => None,
    };
    let shape = shape?;
    let properties = tags
        .as_chunks::<2>()
        .0
        .iter()
        .filter_map(|&[key, value]| Some((key, values.get(value as usize)?.clone())))
        .collect();
    Some(Feature { shape, properties })
}

/// A tile's frame: where its coordinates lie on the earth.
struct Frame {
    key: TileKey,
    extent: f64,
}

impl Frame {
    fn new(key: TileKey, extent: f64) -> Frame {
        Frame { key, extent }
    }

    /// The longitude and latitude of tile coordinates `p`.
    fn degrees(&self, p: [f64; 2]) -> Point {
        let n = f64::from(1_u32 << self.key.z.min(31));
        let x = (f64::from(self.key.x) + p[0] / self.extent) / n;
        let y = (f64::from(self.key.y) + p[1] / self.extent) / n;
        let lat = (std::f64::consts::PI * (1.0 - 2.0 * y)).sinh().atan().to_degrees();
        [x * 360.0 - 180.0, lat]
    }

    /// The tile's points, those outside it dropped.
    fn points(&self, geometry: &[u32]) -> Option<Shape> {
        let inside = |p: &[f64; 2]| p.iter().all(|&v| v >= 0.0 && v < self.extent);
        let points: Vec<Point> =
            paths(geometry).into_iter().flatten().filter(inside).map(|p| self.degrees(p)).collect();
        (!points.is_empty()).then_some(Shape::Points(points))
    }

    /// The tile's lines, cut where they leave it.
    fn lines(&self, geometry: &[u32]) -> Option<Shape> {
        let mut parts: Vec<Vec<Point>> = Vec::new();
        for path in paths(geometry) {
            for part in clip_line(&path, self.extent) {
                if part.len() >= 2 {
                    parts.push(part.into_iter().map(|p| self.degrees(p)).collect());
                }
            }
        }
        (!parts.is_empty()).then_some(Shape::Lines(parts))
    }

    /// The tile's polygons: each exterior ring, by its positive area, with the holes after it,
    /// clipped to the tile as a whole.
    fn polygons(&self, geometry: &[u32]) -> Option<Shape> {
        let mut groups: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
        for ring in paths(geometry) {
            let area = surveyor(&ring);
            if area > 0.0 {
                groups.push(vec![ring]);
            } else if let Some(group) = groups.last_mut().filter(|_| area < 0.0) {
                group.push(ring);
            }
        }
        let polygons: Vec<Vec<Vec<Point>>> = groups
            .iter()
            .flat_map(|group| clip_polygon(group, self.extent))
            .map(|polygon| {
                let closed = |ring: Vec<[f64; 2]>| {
                    let mut ring: Vec<Point> = ring.into_iter().map(|p| self.degrees(p)).collect();
                    ring.push(ring[0]);
                    ring
                };
                polygon.into_iter().map(closed).collect()
            })
            .collect();
        (!polygons.is_empty()).then_some(Shape::Polygons(polygons))
    }
}

/// A polygon, its exterior then its holes, clipped to the square `0..extent` as a whole: a ring
/// wholly inside it stays; the runs of the rest inside it join along its edge, where the polygon's
/// inside lies, into exteriors; and each hole inside goes to the exterior around it. Clipping each
/// ring alone would leave a hole crossing the edge running along its exterior there, which no
/// triangulation reads right.
fn clip_polygon(rings: &[Vec<[f64; 2]>], extent: f64) -> Vec<Vec<Vec<[f64; 2]>>> {
    let inside = |p: &[f64; 2]| p.iter().all(|&v| (0.0..=extent).contains(&v));
    let (mut exteriors, mut holes, mut runs) = (Vec::new(), Vec::new(), Vec::new());
    // Whether the square lies within the polygon, as the rings that miss it say.
    let mut covered = false;
    for (k, ring) in rings.iter().enumerate().filter(|(_, r)| r.len() >= 3) {
        if ring.iter().all(inside) {
            if k == 0 {
                exteriors.push(ring.clone());
            } else {
                holes.push(ring.clone());
            }
            continue;
        }
        let crossing = runs_inside(ring, extent);
        // A ring missing the square holds all of it or none: the exterior first, then a hole within.
        if crossing.is_empty() && contains(ring, [extent / 2.0; 2]) {
            covered = k == 0;
        }
        runs.extend(crossing);
    }
    if !runs.is_empty() {
        exteriors.extend(join(&runs, extent));
    } else if covered {
        exteriors.push(vec![[0.0, 0.0], [extent, 0.0], [extent, extent], [0.0, extent]]);
    }
    let mut polygons: Vec<Vec<Vec<[f64; 2]>>> = exteriors.into_iter().map(|e| vec![e]).collect();
    for hole in holes {
        let within = |p: &&[f64; 2]| p.iter().all(|&v| v > 0.0 && v < extent);
        let Some(&point) = hole.iter().find(within) else { continue };
        let around = match polygons.len() {
            1 => polygons.first_mut(),
            _ => polygons.iter_mut().find(|p| contains(&p[0], point)),
        };
        if let Some(polygon) = around {
            polygon.push(hole);
        }
    }
    polygons
}

/// The runs of closed `ring`, which has a point outside the square `0..extent`, inside it: each from
/// where it enters to where it leaves, on the edge. A run lying along the edge alone bounds nothing,
/// and drops.
fn runs_inside(ring: &[[f64; 2]], extent: f64) -> Vec<Vec<[f64; 2]>> {
    let outside = |p: &[f64; 2]| p.iter().any(|&v| !(0.0..=extent).contains(&v));
    let Some(start) = ring.iter().position(outside) else { return Vec::new() };
    let on_edge = |p: &[f64; 2]| p.iter().any(|&v| v.abs() <= extent * 1e-9 || (v - extent).abs() <= extent * 1e-9);
    let n = ring.len();
    let (mut runs, mut run) = (Vec::new(), Vec::new());
    for k in 0..n {
        let (a, b) = (ring[(start + k) % n], ring[(start + k + 1) % n]);
        let Some((p, q)) = clip_segment(a, b, extent) else { continue };
        if run.is_empty() {
            run.push(onto_edge(p, extent));
        }
        if q == b {
            run.push(q);
            continue;
        }
        // The segment leaves the square: the run ends.
        run.push(onto_edge(q, extent));
        if run.len() >= 2 && !run.iter().all(on_edge) {
            runs.push(std::mem::take(&mut run));
        }
        run.clear();
    }
    runs
}

/// `p`, near the square's edge, moved onto it.
fn onto_edge(p: [f64; 2], extent: f64) -> [f64; 2] {
    let gaps = [p[1].abs(), (p[0] - extent).abs(), (p[1] - extent).abs(), p[0].abs()];
    let edge = (0..4).min_by(|&a, &b| gaps[a].total_cmp(&gaps[b])).unwrap_or(0);
    let p = p.map(|v| v.clamp(0.0, extent));
    match edge {
        0 => [p[0], 0.0],
        1 => [extent, p[1]],
        2 => [p[0], extent],
        _ => [0.0, p[1]],
    }
}

/// How far along the square's edge `p` lies, from the corner at 0 the way an exterior winds: along
/// y = 0, then x = extent, y = extent, and x = 0.
fn along(p: [f64; 2], extent: f64) -> f64 {
    let gaps = [p[1].abs(), (p[0] - extent).abs(), (p[1] - extent).abs(), p[0].abs()];
    match (0..4).min_by(|&a, &b| gaps[a].total_cmp(&gaps[b])).unwrap_or(0) {
        0 => p[0],
        1 => extent + p[1],
        2 => 3.0 * extent - p[0],
        _ => 4.0 * extent - p[1],
    }
}

/// The exteriors `runs` make: from where each leaves the square, along its edge the way the
/// polygon's inside lies to where the next enters, past the corners between, until the first again.
fn join(runs: &[Vec<[f64; 2]>], extent: f64) -> Vec<Vec<[f64; 2]>> {
    let around = 4.0 * extent;
    let entries: Vec<f64> = runs.iter().map(|r| along(r[0], extent)).collect();
    let ahead = |from: f64, to: f64| (to - from).rem_euclid(around);
    let corner = |k: i64| match k.rem_euclid(4) {
        0 => [0.0, 0.0],
        1 => [extent, 0.0],
        2 => [extent, extent],
        _ => [0.0, extent],
    };
    let mut used = vec![false; runs.len()];
    let mut rings = Vec::new();
    for first in 0..runs.len() {
        if used[first] {
            continue;
        }
        let (mut ring, mut run) = (Vec::new(), first);
        loop {
            used[run] = true;
            ring.extend_from_slice(&runs[run]);
            let exit = along(runs[run][runs[run].len() - 1], extent);
            let next = (0..runs.len())
                .filter(|&k| !used[k] || k == first)
                .min_by(|&a, &b| ahead(exit, entries[a]).total_cmp(&ahead(exit, entries[b])))
                .unwrap_or(first);
            let to = exit + ahead(exit, entries[next]);
            let first_corner = (exit / extent).floor() as i64 + 1;
            for k in first_corner.. {
                if k as f64 * extent >= to {
                    break;
                }
                ring.push(corner(k));
            }
            if next == first {
                break;
            }
            run = next;
        }
        if ring.len() >= 3 {
            rings.push(ring);
        }
    }
    rings
}

/// Whether closed `ring` holds `p`, by the crossings of a ray from it.
fn contains(ring: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut inside = false;
    let mut a = ring[ring.len() - 1];
    for &b in ring {
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]) {
            inside = !inside;
        }
        a = b;
    }
    inside
}

/// The paths a geometry's commands draw, in tile coordinates: each move starts one, a close returns
/// to its start (left implicit).
fn paths(geometry: &[u32]) -> Vec<Vec<[f64; 2]>> {
    let mut paths: Vec<Vec<[f64; 2]>> = Vec::new();
    let (mut x, mut y) = (0_i64, 0_i64);
    let mut i = 0;
    while i < geometry.len() {
        let command = geometry[i];
        let (id, count) = (command & 7, (command >> 3) as usize);
        i += 1;
        match id {
            1 | 2 => {
                for k in 0..count {
                    let (Some(&dx), Some(&dy)) = (geometry.get(i), geometry.get(i + 1)) else { return paths };
                    i += 2;
                    x += zigzag(u64::from(dx));
                    y += zigzag(u64::from(dy));
                    if id == 1 && (k == 0 || paths.is_empty()) {
                        paths.push(Vec::new());
                    }
                    if let Some(path) = paths.last_mut() {
                        path.push([x as f64, y as f64]);
                    }
                    // A move with several points is several points, each its own path.
                    if id == 1 && count > 1 && k + 1 < count {
                        paths.push(Vec::new());
                    }
                }
            }
            7 => {}
            _ => return paths,
        }
    }
    paths.retain(|p| !p.is_empty());
    paths
}

/// Twice a ring's area by the surveyor's formula in tile coordinates, y down: positive for an
/// exterior ring.
fn surveyor(ring: &[[f64; 2]]) -> f64 {
    let Some(&last) = ring.last() else { return 0.0 };
    let mut sum = 0.0;
    let mut a = last;
    for &b in ring {
        sum += a[0] * b[1] - b[0] * a[1];
        a = b;
    }
    sum
}

/// `line` cut to the square `0..extent`: the runs of it inside.
fn clip_line(line: &[[f64; 2]], extent: f64) -> Vec<Vec<[f64; 2]>> {
    let mut parts: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut current: Vec<[f64; 2]> = Vec::new();
    for w in line.windows(2) {
        let Some((a, b)) = clip_segment(w[0], w[1], extent) else {
            if current.len() >= 2 {
                parts.push(std::mem::take(&mut current));
            }
            current.clear();
            continue;
        };
        if current.last() != Some(&a) {
            if current.len() >= 2 {
                parts.push(std::mem::take(&mut current));
            }
            current.clear();
            current.push(a);
        }
        current.push(b);
        // The segment left the tile: what follows starts a new run.
        if b != w[1] {
            parts.push(std::mem::take(&mut current));
        }
    }
    if current.len() >= 2 {
        parts.push(current);
    }
    parts
}

/// Segment `a b` clipped to the square `0..extent`, by Liang and Barsky.
fn clip_segment(a: [f64; 2], b: [f64; 2], extent: f64) -> Option<([f64; 2], [f64; 2])> {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let (mut t0, mut t1) = (0.0_f64, 1.0_f64);
    for (p, q) in [(-dx, a[0]), (dx, extent - a[0]), (-dy, a[1]), (dy, extent - a[1])] {
        if p == 0.0 {
            if q < 0.0 {
                return None;
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    if t0 > t1 {
        return None;
    }
    let at = |t: f64| {
        if t == 0.0 {
            a
        } else if t == 1.0 {
            b
        } else {
            [a[0] + dx * t, a[1] + dy * t]
        }
    };
    Some((at(t0), at(t1)))
}

fn zigzag(n: u64) -> i64 {
    ((n >> 1) as i64) ^ -((n & 1) as i64)
}

fn packed(bytes: &[u8], out: &mut Vec<u32>) -> Option<()> {
    let mut reader = Reader::new(bytes);
    while !reader.done() {
        out.push(reader.varint()? as u32);
    }
    Some(())
}

const VARINT: u8 = 0;
const FIXED64: u8 = 1;
const LENGTH: u8 = 2;
const FIXED32: u8 = 5;

/// Protocol buffer fields, read in order; `None` past the end or on a malformed field.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes }
    }

    fn done(&self) -> bool {
        self.bytes.is_empty()
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0_u64;
        for shift in (0..64).step_by(7) {
            let (&byte, rest) = self.bytes.split_first()?;
            self.bytes = rest;
            value |= u64::from(byte & 0x7f) << shift;
            if byte < 0x80 {
                return Some(value);
            }
        }
        None
    }

    /// The next field's number and wire type.
    fn tag(&mut self) -> Option<(u32, u8)> {
        let tag = self.varint()?;
        Some(((tag >> 3) as u32, (tag & 7) as u8))
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = usize::try_from(self.varint()?).ok()?;
        let (head, rest) = self.bytes.split_at_checked(len)?;
        self.bytes = rest;
        Some(head)
    }

    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.bytes.split_first_chunk::<N>()?;
        self.bytes = rest;
        Some(*head)
    }

    fn skip(&mut self, wire: u8) -> Option<()> {
        match wire {
            VARINT => self.varint().map(drop),
            FIXED64 => self.take::<8>().map(drop),
            LENGTH => self.bytes().map(drop),
            FIXED32 => self.take::<4>().map(drop),
            _ => None,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Protocol buffer fields, written.
    #[derive(Default)]
    pub(crate) struct Writer(pub(crate) Vec<u8>);

    impl Writer {
        pub(crate) fn varint(&mut self, mut v: u64) {
            while v >= 0x80 {
                self.0.push((v as u8) | 0x80);
                v >>= 7;
            }
            self.0.push(v as u8);
        }

        pub(crate) fn tag(&mut self, field: u32, wire: u8) {
            self.varint(u64::from(field << 3) | u64::from(wire));
        }

        pub(crate) fn bytes(&mut self, field: u32, bytes: &[u8]) {
            self.tag(field, LENGTH);
            self.varint(bytes.len() as u64);
            self.0.extend_from_slice(bytes);
        }

        pub(crate) fn packed(&mut self, field: u32, values: &[u32]) {
            let mut inner = Writer::default();
            for &v in values {
                inner.varint(u64::from(v));
            }
            self.bytes(field, &inner.0);
        }
    }

    pub(crate) fn zig(v: i64) -> u32 {
        ((v << 1) ^ (v >> 63)) as u32
    }

    /// A tile of one layer `name` holding one feature of `kind` drawn by `geometry`, with property
    /// `name` set to `value`.
    pub(crate) fn tile(layer: &str, kind: u64, geometry: &[u32], value: &str) -> Vec<u8> {
        let mut feature = Writer::default();
        feature.packed(2, &[0, 0]);
        feature.tag(3, VARINT);
        feature.varint(kind);
        feature.packed(4, geometry);
        let mut text = Writer::default();
        text.bytes(1, value.as_bytes());
        let mut l = Writer::default();
        l.tag(15, VARINT);
        l.varint(2);
        l.bytes(1, layer.as_bytes());
        l.bytes(2, &feature.0);
        l.bytes(3, b"name");
        l.bytes(4, &text.0);
        l.tag(5, VARINT);
        l.varint(4096);
        let mut t = Writer::default();
        t.bytes(3, &l.0);
        t.0
    }

    /// A square's commands, from `(x, y)` of `side`, clockwise in tile coordinates.
    pub(crate) fn square(x: i64, y: i64, side: i64) -> Vec<u32> {
        vec![9, zig(x), zig(y), 26, zig(side), 0, 0, zig(side), zig(-side), 0, 15]
    }

    #[test]
    fn a_polygon_decodes_to_degrees() {
        let key = TileKey { z: 0, x: 0, y: 0 };
        let layers = decode(&tile("water", 3, &square(1024, 1024, 2048), "lake"), key).expect("a tile");
        assert_eq!(layers.len(), 1);
        assert_eq!(layers[0].name, "water");
        let feature = &layers[0].features[0];
        let Shape::Polygons(polygons) = &feature.shape else { panic!("polygons") };
        let ring = &polygons[0][0];
        assert_eq!(ring.len(), 5, "closed");
        assert!((ring[0][0] + 90.0).abs() < 1e-9, "a quarter in: {:?}", ring[0]);
        assert!(ring[0][1] > 60.0 && ring[0][1] < 70.0, "mercator latitude: {:?}", ring[0]);
        assert_eq!(feature.properties, vec![(0, Property::Text("lake".into()))]);
    }

    #[test]
    fn a_polygon_clips_as_a_whole() {
        let square = |x: f64, y: f64, side: f64, exterior: bool| {
            let ring = vec![[x, y], [x + side, y], [x + side, y + side], [x, y + side]];
            if exterior { ring } else { ring.into_iter().rev().collect() }
        };
        // A sea over the tile and its buffer, with islands across its left edge, across its corner,
        // inside it, and outside it.
        let rings = [
            square(-64.0, -64.0, 4224.0, true),
            square(-200.0, 1800.0, 500.0, false),
            square(3900.0, -100.0, 400.0, false),
            square(1000.0, 1000.0, 200.0, false),
            square(5000.0, 5000.0, 100.0, false),
        ];
        let polygons = clip_polygon(&rings, 4096.0);
        assert_eq!(polygons.len(), 1);
        assert_eq!(polygons[0].len(), 2, "islands across the edge notch the sea; the one inside stays a hole");
        let points: Vec<[f64; 2]> = polygons[0].concat();
        let triangles = super::super::earcut::earcut(&points, &[polygons[0][0].len()]);
        let area: f64 = triangles
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| points[i as usize]);
                ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0
            })
            .sum();
        let sea = 4096.0 * 4096.0 - 300.0 * 500.0 - 196.0 * 300.0 - 200.0 * 200.0;
        assert!((area - sea).abs() < 1e-6, "{area} drawn of {sea}");
        // A sea the tile lies wholly in is the tile; one beside it is nothing.
        assert_eq!(clip_polygon(&[square(-100.0, -100.0, 5000.0, true)], 4096.0)[0][0].len(), 4);
        assert_eq!(clip_polygon(&[square(5000.0, 0.0, 100.0, true)], 4096.0).len(), 0);
    }

    #[test]
    fn shapes_are_clipped_to_the_tile() {
        let key = TileKey { z: 1, x: 1, y: 0 };
        // A square reaching past the tile's left edge: clipped there.
        let layers = decode(&tile("land", 3, &square(-512, 1024, 1024), "x"), key).expect("a tile");
        let Shape::Polygons(polygons) = &layers[0].features[0].shape else { panic!("polygons") };
        assert!(polygons[0][0].iter().all(|p| p[0] >= -1e-9), "west of 0 is clipped: {:?}", polygons[0][0]);
        // A line wholly outside draws nothing.
        let outside = vec![9, zig(-100), zig(10), 10, zig(-50), 0];
        let layers = decode(&tile("road", 2, &outside, "y"), key).expect("a tile");
        assert!(layers[0].features.is_empty());
    }

    #[test]
    fn a_polygon_wholly_outside_leaves_nothing() {
        let key = TileKey { z: 1, x: 1, y: 0 };
        // Commands move relative to where the last ring ended, (-3000, 600): the second starts at (100, 100).
        let mut geometry = square(-3000, 100, 500);
        geometry.extend(square(3100, -500, 500));
        let layers = decode(&tile("land", 3, &geometry, "x"), key).expect("a tile");
        let Shape::Polygons(polygons) = &layers[0].features[0].shape else { panic!("polygons") };
        assert_eq!(polygons.len(), 1, "only the one inside: {polygons:?}");
        assert!(polygons.iter().flatten().all(|ring| ring.len() >= 4));
    }

    #[test]
    fn lines_are_cut_where_they_leave() {
        let parts = clip_line(&[[-10.0, 5.0], [10.0, 5.0], [10.0, -10.0], [20.0, 5.0]], 100.0);
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert_eq!(parts[0][0], [0.0, 5.0]);
    }
}
