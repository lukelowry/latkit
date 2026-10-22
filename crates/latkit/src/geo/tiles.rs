//! Vector tiles as data: where tiles come from, and a tile decoded into the rows of the tables marks
//! draw from it.

use super::mvt::{self, Kind, Property, Shape};
use crate::data::{Ids, Name, Patch, Table, Values};
use crate::tiles::TileKey;

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
        /// What a TileJSON document says that tiles draw by.
        #[derive(serde::Deserialize)]
        struct TileJson {
            #[serde(default)]
            tiles: Vec<String>,
            format: Option<String>,
            minzoom: Option<f64>,
            maxzoom: Option<f64>,
            bounds: Option<Vec<f64>>,
            scheme: Option<String>,
        }
        let text = std::str::from_utf8(bytes).map_err(|e| format!("{base} is not TileJSON: {e}"))?;
        let json = crate::from_json::<TileJson>(text).map_err(|e| format!("{base} is not TileJSON: {e}"))?;
        let template = json.tiles.first().ok_or_else(|| format!("the TileJSON at {base} names no tiles"))?;
        if let Some(format) = json.format.as_deref()
            && ["png", "jpg", "jpeg", "webp", "avif"].contains(&format)
        {
            return Err(format!("the TileJSON at {base} names image tiles; only vector tiles draw"));
        }
        let zoom = |z: Option<f64>, or: u8| z.filter(|z| *z >= 0.0).map_or(or, |z| z.min(24.0) as u8);
        let bounds = json.bounds.as_deref().and_then(|b| <[f64; 4]>::try_from(b).ok()).unwrap_or(WORLD);
        Ok(Template {
            url: crate::url::resolve(base, template),
            min_zoom: zoom(json.minzoom, 0),
            max_zoom: zoom(json.maxzoom, 14),
            bounds,
            tms: json.scheme.as_deref() == Some("tms"),
        })
    }

    /// The URL of tile `key`.
    pub(crate) fn url_of(&self, key: TileKey) -> String {
        let y = if self.tms { (1_u32 << key.z) - 1 - key.y } else { key.y };
        self.url.replace("{z}", &key.z.to_string()).replace("{x}", &key.x.to_string()).replace("{y}", &y.to_string())
    }
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
