//! Vector tiles as data: where tiles come from, and a tile decoded into the rows of the tables marks
//! draw from it.

use std::sync::Arc;

use super::mvt::{self, Kind, Property, Shape};
use crate::data::{Ids, Name, Patch, Table, Values};

/// Vector tiles a view fetches as its camera asks for them, kept as a dataset the view owns: a
/// PMTiles archive, a TileJSON document, or a URL template with `{z}`, `{x}`, and `{y}`. Give them
/// to a view with [`View::set_tiles`](crate::View::set_tiles).
///
/// Each layer is a table of its features of the kind marks draw it as: polygons for
/// [`Areas`](crate::Areas), lines for [`Lines`](crate::Lines), points for
/// [`Vertices`](crate::Vertices), polygons first where marks of several kinds draw one layer. A table
/// named `layer:polygons`, `layer:lines`, or `layer:points` holds that kind whatever draws it. Every
/// feature's properties are fields, and its row's id is stable, made from its tile and its place in
/// it, so a tile fetched again finds its rows selected as they were.
///
/// ```
/// # use latkit::geo::Tiles;
/// let base = Tiles::vector("base", "https://tiles.openfreemap.org/planet");
/// ```
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Tiles {
    pub(crate) name: Name,
    pub(crate) url: Arc<str>,
}

impl Tiles {
    /// The vector tiles at `url`, drawn as dataset `name`.
    pub fn vector(name: impl Into<Name>, url: impl Into<Arc<str>>) -> Tiles {
        Tiles { name: name.into(), url: url.into() }
    }

    /// The dataset the tiles are drawn as.
    pub fn name(&self) -> &Name {
        &self.name
    }

    /// Where the tiles come from.
    pub fn url(&self) -> &str {
        &self.url
    }
}

/// A tile: its zoom, column, and row, rows counting from the north.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub(crate) struct TileKey {
    pub(crate) z: u8,
    pub(crate) x: u32,
    pub(crate) y: u32,
}

impl TileKey {
    /// West, south, east, and north, in degrees.
    pub(crate) fn bounds(self) -> [f64; 4] {
        let n = f64::from(1_u32 << self.z);
        let latitude = |t: f64| (std::f64::consts::PI * (1.0 - 2.0 * t)).sinh().atan().to_degrees();
        let (x, y) = (f64::from(self.x), f64::from(self.y));
        [x / n * 360.0 - 180.0, latitude((y + 1.0) / n), (x + 1.0) / n * 360.0 - 180.0, latitude(y / n)]
    }

    /// The tile `levels` zooms up that holds this one.
    pub(crate) fn ancestor(self, levels: u8) -> TileKey {
        TileKey { z: self.z - levels, x: self.x >> levels, y: self.y >> levels }
    }

    /// Its four children.
    pub(crate) fn children(self) -> [TileKey; 4] {
        let (z, x, y) = (self.z + 1, self.x * 2, self.y * 2);
        [TileKey { z, x, y }, TileKey { z, x: x + 1, y }, TileKey { z, x, y: y + 1 }, TileKey { z, x: x + 1, y: y + 1 }]
    }
}

/// Tiles fetched from a URL template, from a TileJSON document or given as one.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Template {
    pub(crate) url: String,
    pub(crate) min_zoom: u8,
    pub(crate) max_zoom: u8,
    /// West, south, east, north.
    pub(crate) bounds: [f64; 4],
    /// Whether rows count from the south, as TMS has them.
    pub(crate) tms: bool,
}

/// The whole earth web mercator reaches.
pub(crate) const WORLD: [f64; 4] = [-180.0, -85.051_128_78, 180.0, 85.051_128_78];

impl Template {
    /// The template `url`, its zooms and bounds as most sources serve them.
    pub(crate) fn of(url: &str) -> Template {
        Template { url: url.to_owned(), min_zoom: 0, max_zoom: 14, bounds: WORLD, tms: false }
    }

    /// The TileJSON document `bytes`, found at `base`.
    pub(crate) fn tilejson(bytes: &[u8], base: &str) -> Result<Template, String> {
        let json: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|e| format!("{base} is not TileJSON: {e}"))?;
        let template = json["tiles"][0].as_str().ok_or_else(|| format!("the TileJSON at {base} names no tiles"))?;
        if let Some(format) = json["format"].as_str()
            && ["png", "jpg", "jpeg", "webp", "avif"].contains(&format)
        {
            return Err(format!("the TileJSON at {base} names image tiles; only vector tiles draw"));
        }
        let zoom = |key: &str, or: u8| json[key].as_u64().map_or(or, |z| z.min(24) as u8);
        let bounds = json["bounds"]
            .as_array()
            .filter(|b| b.len() == 4)
            .and_then(|b| Some([b[0].as_f64()?, b[1].as_f64()?, b[2].as_f64()?, b[3].as_f64()?]))
            .unwrap_or(WORLD);
        Ok(Template {
            url: resolve(template, base),
            min_zoom: zoom("minzoom", 0),
            max_zoom: zoom("maxzoom", 14),
            bounds,
            tms: json["scheme"].as_str() == Some("tms"),
        })
    }

    /// The URL of tile `key`.
    pub(crate) fn url_of(&self, key: TileKey) -> String {
        let y = if self.tms { (1_u32 << key.z) - 1 - key.y } else { key.y };
        self.url.replace("{z}", &key.z.to_string()).replace("{x}", &key.x.to_string()).replace("{y}", &y.to_string())
    }
}

/// `url` resolved against `base`: as it is when absolute.
fn resolve(url: &str, base: &str) -> String {
    if url.contains("://") || url.starts_with("data:") {
        return url.to_owned();
    }
    if let Some(rest) = url.strip_prefix('/') {
        // From the base's origin.
        let origin_end = base.find("://").map_or(0, |s| s + 3);
        let origin = base[origin_end..].find('/').map_or(base.len(), |k| origin_end + k);
        return format!("{}/{rest}", &base[..origin]);
    }
    let dir = base.rfind('/').map_or("", |k| &base[..=k]);
    format!("{dir}{url}")
}

/// A table a tile decodes into: its layer's features of one kind, as table `table`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Decoded {
    pub(crate) layer: String,
    pub(crate) kind: Kind,
    pub(crate) table: Name,
}

/// Features a tile's table numbers at most; ids beyond its place in the tile never collide.
pub(crate) const FEATURES: u64 = 1 << 20;

/// Tile `key`'s rows as a patch of every table of `tables`: each feature of the table's layer and
/// kind a row (a multi-point a row per point), its geometry field `geometry` and its properties
/// fields. A row's id is the tile's place along the Hilbert curve times [`FEATURES`], plus its own
/// place among the table's rows. `None` when the bytes are no tile.
pub(crate) fn decode(bytes: &[u8], key: TileKey, tables: &[Decoded]) -> Option<Patch> {
    let bytes = super::gunzipped(bytes).ok()?;
    let layers = mvt::decode(&bytes, key)?;
    let first = super::pmtiles::tile_id(key) * FEATURES;
    let mut patch = Patch::new();
    for decoded in tables {
        let Some(layer) = layers.iter().find(|l| l.name == decoded.layer) else { continue };
        let mut shapes: Vec<Shape> = Vec::new();
        let mut properties: Vec<&[(u32, Property)]> = Vec::new();
        for feature in layer.features.iter().filter(|f| f.shape.kind() == decoded.kind) {
            match &feature.shape {
                Shape::Points(points) => {
                    for &p in points {
                        shapes.push(Shape::Points(vec![p]));
                        properties.push(&feature.properties);
                    }
                }
                shape => {
                    shapes.push(shape.clone());
                    properties.push(&feature.properties);
                }
            }
        }
        let count = shapes.len().min(FEATURES as usize);
        if count == 0 {
            continue;
        }
        let ids: Vec<u64> = (0..count as u64).map(|k| first + k).collect();
        let geometry: Values = match decoded.kind {
            Kind::Points => shapes[..count]
                .iter()
                .map(|s| if let Shape::Points(p) = s { p[0] } else { [f64::NAN; 2] })
                .collect::<Vec<_>>()
                .into(),
            Kind::Lines => shapes
                .into_iter()
                .take(count)
                .map(|s| if let Shape::Lines(parts) = s { parts } else { Vec::new() })
                .collect::<Vec<_>>()
                .into(),
            Kind::Polygons => shapes
                .into_iter()
                .take(count)
                .map(|s| if let Shape::Polygons(polygons) = s { polygons } else { Vec::new() })
                .collect::<Vec<_>>()
                .into(),
        };
        let mut table = Table::new(decoded.table.clone(), Ids::from(ids)).field("geometry", geometry);
        for (k, key) in layer.keys.iter().enumerate() {
            if key == "geometry" {
                continue;
            }
            let values: Vec<Option<&Property>> = properties[..count]
                .iter()
                .map(|props| props.iter().find(|(i, _)| *i as usize == k).map(|(_, v)| v))
                .collect();
            if values.iter().any(Option::is_some) {
                table = table.field(key.as_str(), field(&values));
            }
        }
        patch = patch.set(table);
    }
    Some(patch)
}

/// A property's values as a field: numbers where every value present is one, booleans likewise,
/// texts otherwise.
fn field(values: &[Option<&Property>]) -> Values {
    let present = || values.iter().flatten();
    if present().all(|v| matches!(v, Property::Number(_))) {
        return values
            .iter()
            .map(|v| v.and_then(|v| if let Property::Number(n) = v { Some(*n) } else { None }))
            .collect::<Vec<_>>()
            .into();
    }
    if present().all(|v| matches!(v, Property::Bool(_))) {
        return values
            .iter()
            .map(|v| v.and_then(|v| if let Property::Bool(b) = v { Some(*b) } else { None }))
            .collect::<Vec<_>>()
            .into();
    }
    values.iter().map(|v| v.map(text)).collect::<Vec<Option<String>>>().into()
}

/// A property written as text.
pub(crate) fn text(property: &Property) -> String {
    match property {
        Property::Text(t) => t.clone(),
        Property::Number(n) => n.to_string(),
        Property::Bool(b) => b.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::mvt::tests::{square, tile};
    use crate::{Data, Value};

    #[test]
    fn a_tile_decodes_into_its_tables_rows() {
        let key = TileKey { z: 3, x: 2, y: 3 };
        let bytes = tile("water", 3, &square(100, 100, 1000), "bay");
        let tables = [Decoded { layer: "water".into(), kind: Kind::Polygons, table: "water".into() }];
        let patch = decode(&bytes, key, &tables).expect("a tile");
        let mut data = Data::new("base");
        data.apply(patch).expect("valid");
        let water = data.table("water").expect("the table");
        assert_eq!(water.len(), 1);
        let id = crate::geo::pmtiles::tile_id(key) * FEATURES;
        assert_eq!(water.get(id, "name"), Some(Value::Text("bay".into())), "stable ids");
        assert!(matches!(water.get(id, "geometry"), Some(Value::Polygons(_))));
        let other = [Decoded { layer: "water".into(), kind: Kind::Lines, table: "water".into() }];
        assert!(decode(&bytes, key, &other).expect("a tile").is_empty(), "no lines in it");
    }

    #[test]
    fn templates_fill_and_resolve() {
        let json = br#"{"tiles": ["/planet/{z}/{x}/{y}.pbf"], "minzoom": 0, "maxzoom": 14, "scheme": "xyz"}"#;
        let template = Template::tilejson(json, "https://tiles.example/planet").expect("TileJSON");
        assert_eq!(template.url_of(TileKey { z: 2, x: 1, y: 3 }), "https://tiles.example/planet/2/1/3.pbf");
        assert_eq!(resolve("t/{z}.pbf", "https://a.b/c/d.json"), "https://a.b/c/t/{z}.pbf");
        let tms = Template { tms: true, ..Template::of("{z}/{x}/{y}") };
        assert_eq!(tms.url_of(TileKey { z: 1, x: 0, y: 0 }), "1/0/1");
    }

    #[test]
    fn tile_bounds_meet_their_parents() {
        let key = TileKey { z: 1, x: 1, y: 0 };
        let [w, s, e, n] = key.bounds();
        assert_eq!([w, s, e], [0.0, 0.0, 180.0]);
        assert!((n - 85.051_128_78).abs() < 1e-6);
        assert_eq!(key.children()[3].ancestor(1), key);
    }
}
