//! Vector tiles as data: tile URL templates, and decoding a tile into table rows with their shapes.

use super::mvt::{self, Kind, Shape};
use crate::data::{Ids, Name, Patch, Table, Value, Values};
use crate::host::Shaping;
use crate::tiles::TileKey;

/// A tile URL template with its zoom range and bounds, read from TileJSON or given directly.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct Template {
    pub(crate) url: String,
    pub(crate) min_zoom: u8,
    pub(crate) max_zoom: u8,
    /// West, south, east, north, in degrees.
    pub(crate) bounds: [f64; 4],
    /// Whether tile rows count from the south (the TMS scheme).
    pub(crate) tms: bool,
}

/// Bounds of the web mercator world: west, south, east, north, in degrees.
pub(crate) const WORLD: [f64; 4] = [-180.0, -85.051_128_78, 180.0, 85.051_128_78];

impl Template {
    /// Template `url` with common defaults: zooms 0 to 14, world bounds, and XYZ row order.
    pub(crate) fn of(url: &str) -> Template {
        Template { url: url.to_owned(), min_zoom: 0, max_zoom: 14, bounds: WORLD, tms: false }
    }

    /// Reads the TileJSON document `bytes` fetched from `base`, resolving its first tile URL
    /// against `base`. Errors if it is not TileJSON, names no tiles, or names image tiles.
    pub(crate) fn tilejson(bytes: &[u8], base: &str) -> Result<Template, String> {
        /// The TileJSON members read.
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
        let json = crate::json::from_bytes::<TileJson>(bytes).map_err(|e| format!("{base} is not TileJSON: {e}"))?;
        let template = json.tiles.first().ok_or_else(|| format!("the TileJSON at {base} lists no tile URLs"))?;
        if let Some(format) = json.format.as_deref()
            && ["png", "jpg", "jpeg", "webp", "avif"].contains(&format)
        {
            return Err(format!("the TileJSON at {base} has image tiles; only vector tiles are supported"));
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

/// A table decoded from each tile: the features of one `kind` in layer `layer`, as table `table`.
/// `shapes` lists the derived shape fields its marks draw.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Decoded {
    pub(crate) layer: String,
    pub(crate) kind: Kind,
    pub(crate) table: Name,
    pub(crate) shapes: Vec<Shaping>,
}

/// The most rows one tile adds to a table. Further rows are dropped. Row ids are the tile's id
/// times this plus the row's index, so ids from different tiles never collide.
pub(crate) const FEATURES: u64 = 1 << 20;

/// Name of the field holding a tile row's geometry.
const GEOMETRY: &str = "geometry";

/// Whether `name` is a derived shape field of a tile's table. Properties of that name are skipped.
pub(crate) fn shapes_field(name: &str) -> bool {
    [Shaping::Triangles { earth: true }, Shaping::Path].iter().any(|s| *s.field_of(GEOMETRY) == *name)
}

/// Decodes tile `key` from `bytes`, optionally gzip-compressed, into a patch setting each table of
/// `tables`. Each feature of the table's layer and kind becomes a row (a multi-point, a row per
/// point) with field `geometry`, its derived shape fields, and a field per property. A row's id is
/// the tile's Hilbert curve id times [`FEATURES`], plus the row's index. `None` if `bytes` are not
/// a tile.
pub(crate) fn decode(bytes: &[u8], key: TileKey, tables: &[Decoded]) -> Option<Patch> {
    let bytes = super::gunzipped(bytes).ok()?;
    let layers = mvt::decode(&bytes, key)?;
    let first = super::pmtiles::tile_id(key) * FEATURES;
    let mut patch = Patch::new();
    for decoded in tables {
        let Some(layer) = layers.iter().find(|l| l.name == decoded.layer) else { continue };
        let mut shapes: Vec<Shape> = Vec::new();
        let mut properties: Vec<&[(u32, Value)]> = Vec::new();
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
        let ids: Ids = (0..count as u64).map(|k| first + k).collect::<Vec<_>>().into();
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
        let depth = geometry.geometry().map_or(0, crate::data::Geometry::depth);
        let mut table = Table::new(decoded.table.clone(), ids);
        for &shaping in decoded.shapes.iter().filter(|s| s.takes(depth)) {
            table = table.field(shaping.field_of(GEOMETRY), shaping.shapes_of(&geometry));
        }
        table = table.field(GEOMETRY, geometry);
        for (k, key) in layer.keys.iter().enumerate() {
            if key == GEOMETRY || shapes_field(key) {
                continue;
            }
            let values: Vec<Option<Value>> = properties[..count]
                .iter()
                .map(|props| props.iter().find(|(i, _)| *i as usize == k).map(|(_, v)| v.clone()))
                .collect();
            if values.iter().any(Option::is_some) {
                table = table.field(key.as_str(), Values::infer(&values));
            }
        }
        patch = patch.set(table);
    }
    Some(patch)
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
        let triangles = Shaping::Triangles { earth: true };
        let tables =
            [Decoded { layer: "water".into(), kind: Kind::Polygons, table: "water".into(), shapes: vec![triangles] }];
        let patch = decode(&bytes, key, &tables).expect("a tile");
        let data = Data::new("base");
        data.apply(patch).expect("valid");
        let data = data.snapshot();
        let water = data.table("water").expect("the table");
        assert_eq!(water.len(), 1);
        let id = crate::geo::pmtiles::tile_id(key) * FEATURES;
        assert_eq!(water.get(id, "name"), Some(Value::Text("bay".into())), "stable ids");
        assert!(matches!(water.get(id, "geometry"), Some(Value::Polygons(_))));
        // The derived triangles field: a label point and at least one triangle.
        let triangles = water.get(id, "geometry.triangles");
        assert!(matches!(triangles, Some(Value::Path(points)) if points.len() >= 4));
        let other = [Decoded { layer: "water".into(), kind: Kind::Lines, table: "water".into(), shapes: Vec::new() }];
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
    fn tile_bounds_are_mercator_and_children_map_back_to_parents() {
        let key = TileKey { z: 1, x: 1, y: 0 };
        let [w, s, e, n] = key.bounds();
        assert_eq!([w, s, e], [0.0, 0.0, 180.0]);
        assert!((n - 85.051_128_78).abs() < 1e-6);
        assert_eq!(key.children()[3].ancestor(1), key);
    }
}
