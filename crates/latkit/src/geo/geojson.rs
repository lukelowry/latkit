//! Reads GeoJSON into three tables by geometry type: `points`, `lines`, and `polygons`. Each row
//! holds its geometry in field `geometry` and each property in a field of its own.

use std::fmt;

use serde::Deserialize;
use serde::de::{self, IgnoredAny, SeqAccess, Visitor};
use serde_json::{Map, Value as Json};

use crate::data::{Ids, Name, Patch, Snapshot, Table, Value, Values};
use crate::{Error, Result};

type Point = [f64; 2];

/// Reads GeoJSON `bytes`, optionally gzip-compressed, as dataset `name`. The document may be a
/// feature collection, a single feature, or a bare geometry.
///
/// Points become rows of table `points` with a point field `geometry`. Line strings become rows of
/// `lines` (a parts field), and polygons rows of `polygons` (a polygons field). A multi-point adds
/// a row per point, and a geometry collection a row per member. Each property becomes a field of
/// numbers, booleans, or text, with any other value written as JSON. A null counts as missing.
///
/// A table keeps its features' ids when every row has one, all are non-negative integers or all are
/// strings, and none repeat. Otherwise its rows are numbered in order. Errors if `bytes` are not
/// GeoJSON.
pub(crate) fn geojson(name: impl Into<Name>, bytes: &[u8]) -> Result<Snapshot> {
    let bytes = super::gunzipped(bytes)?;
    let top: Top = crate::json::from_bytes(&bytes).map_err(|e| Error::invalid(format!("not GeoJSON: {e}")))?;
    let mut tables = [Rows::default(), Rows::default(), Rows::default()];
    let mut add = |feature: Feature| {
        if let Some(geometry) = feature.geometry {
            let properties = feature.properties.unwrap_or_default();
            geometry.into_rows(feature.id.as_ref(), &properties, &mut tables);
        }
    };
    match top.kind.as_str() {
        "FeatureCollection" => top.features.unwrap_or_default().into_iter().for_each(&mut add),
        "Feature" => add(Feature { id: top.id, geometry: top.geometry, properties: top.properties }),
        _ => add(Feature {
            id: None,
            geometry: Some(Geometry { kind: top.kind, coordinates: top.coordinates, geometries: top.geometries }),
            properties: None,
        }),
    }
    let mut patch = Patch::new();
    for (rows, name) in tables.into_iter().zip(["points", "lines", "polygons"]) {
        if let Some(table) = rows.table(name) {
            patch = patch.replace(table);
        }
    }
    Snapshot::new(name).applied(patch)
}

/// A document's top-level object, with the members of a feature collection, a feature, and a
/// geometry in one struct.
#[derive(Deserialize)]
struct Top {
    #[serde(rename = "type")]
    kind: String,
    features: Option<Vec<Feature>>,
    id: Option<Json>,
    geometry: Option<Geometry>,
    properties: Option<Map<String, Json>>,
    coordinates: Option<Coordinates>,
    geometries: Option<Vec<Geometry>>,
}

#[derive(Deserialize)]
struct Feature {
    id: Option<Json>,
    geometry: Option<Geometry>,
    properties: Option<Map<String, Json>>,
}

#[derive(Deserialize)]
struct Geometry {
    #[serde(rename = "type")]
    kind: String,
    coordinates: Option<Coordinates>,
    geometries: Option<Vec<Geometry>>,
}

/// Indices into the table array, by geometry type.
const POINTS: usize = 0;
const LINES: usize = 1;
const POLYGONS: usize = 2;

impl Geometry {
    /// Adds this geometry's rows, with the feature's id and properties, to the table for its type.
    fn into_rows(self, id: Option<&Json>, properties: &Map<String, Json>, tables: &mut [Rows; 3]) {
        let coordinates = self.coordinates.unwrap_or(Coordinates::Empty);
        match (self.kind.as_str(), coordinates) {
            ("Point", Coordinates::Position(p)) => tables[POINTS].push(id, properties, Shape::Point(p)),
            ("MultiPoint", Coordinates::Line(points)) => {
                for p in points {
                    tables[POINTS].push(id, properties, Shape::Point(p));
                }
            }
            ("LineString", Coordinates::Line(line)) => tables[LINES].push(id, properties, Shape::Parts(vec![line])),
            ("MultiLineString", Coordinates::Rings(lines)) => tables[LINES].push(id, properties, Shape::Parts(lines)),
            ("Polygon", Coordinates::Rings(rings)) => {
                tables[POLYGONS].push(id, properties, Shape::Polygons(vec![rings]));
            }
            ("MultiPolygon", Coordinates::Polygons(polygons)) => {
                tables[POLYGONS].push(id, properties, Shape::Polygons(polygons));
            }
            ("GeometryCollection", _) => {
                for member in self.geometries.unwrap_or_default() {
                    member.into_rows(id, properties, tables);
                }
            }
            // Unknown types, missing coordinates, and coordinates of the wrong depth add no row.
            _ => {}
        }
    }
}

enum Shape {
    Point(Point),
    Parts(Vec<Vec<Point>>),
    Polygons(Vec<Vec<Vec<Point>>>),
}

/// Rows read for one table: each row's id, properties, and shape.
#[derive(Default)]
struct Rows {
    ids: Vec<Option<Json>>,
    properties: Vec<Map<String, Json>>,
    shapes: Vec<Shape>,
}

impl Rows {
    fn push(&mut self, id: Option<&Json>, properties: &Map<String, Json>, shape: Shape) {
        self.ids.push(id.cloned());
        self.properties.push(properties.clone());
        self.shapes.push(shape);
    }

    /// Builds table `name` from the rows, or `None` if there are none.
    fn table(self, name: &str) -> Option<Table> {
        if self.shapes.is_empty() {
            return None;
        }
        let count = self.shapes.len();
        let mut table = Table::new(name, ids(&self.ids).unwrap_or_else(|| Ids::count(count as u32)));
        let geometry: Values = match &self.shapes[0] {
            Shape::Point(_) => self
                .shapes
                .iter()
                .map(|s| if let Shape::Point(p) = s { *p } else { [f64::NAN; 2] })
                .collect::<Vec<_>>()
                .into(),
            Shape::Parts(_) => self
                .shapes
                .into_iter()
                .map(|s| if let Shape::Parts(parts) = s { parts } else { Vec::new() })
                .collect::<Vec<_>>()
                .into(),
            Shape::Polygons(_) => self
                .shapes
                .into_iter()
                .map(|s| if let Shape::Polygons(polygons) = s { polygons } else { Vec::new() })
                .collect::<Vec<_>>()
                .into(),
        };
        table = table.field("geometry", geometry);
        let mut keys: Vec<&String> = Vec::new();
        for properties in &self.properties {
            for key in properties.keys() {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
        }
        for key in keys {
            // A property named `geometry` would replace the geometry field, so skip it.
            if key == "geometry" {
                continue;
            }
            let values: Vec<Option<&Json>> =
                self.properties.iter().map(|p| p.get(key.as_str()).filter(|v| !v.is_null())).collect();
            table = table.field(key.as_str(), property(&values));
        }
        Some(table)
    }
}

/// The rows' ids, if every row has one, all are non-negative integers or all are strings, and none
/// repeat. Else `None`.
fn ids(ids: &[Option<Json>]) -> Option<Ids> {
    let mut seen = std::collections::HashSet::with_capacity(ids.len());
    if ids.iter().all(|id| id.as_ref().and_then(Json::as_u64).is_some_and(|n| seen.insert(n.to_string()))) {
        return Some(Ids::from(
            ids.iter().map(|id| id.as_ref().and_then(Json::as_u64).unwrap_or(0)).collect::<Vec<u64>>(),
        ));
    }
    seen.clear();
    if ids.iter().all(|id| id.as_ref().and_then(Json::as_str).is_some_and(|t| seen.insert(t.to_owned()))) {
        let texts: Vec<&str> = ids.iter().map(|id| id.as_ref().and_then(Json::as_str).unwrap_or("")).collect();
        return Some(Ids::from(texts));
    }
    None
}

/// Converts a property's values into a field, typed as [`Values::infer`] types them, with arrays
/// and objects written as JSON text.
fn property(values: &[Option<&Json>]) -> Values {
    let values: Vec<Option<Value>> = values
        .iter()
        .map(|v| {
            v.map(|v| match v {
                Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
                Json::Bool(b) => Value::Bool(*b),
                Json::String(text) => Value::Text(text.as_str().into()),
                other => Value::Text(other.to_string().into()),
            })
        })
        .collect();
    Values::infer(&values)
}

/// Coordinates of any nesting depth: a position, a list of positions, a list of those, or a list of
/// polygons. Positions keep longitude and latitude and drop any altitude.
enum Coordinates {
    Number(f64),
    Position(Point),
    Line(Vec<Point>),
    Rings(Vec<Vec<Point>>),
    Polygons(Vec<Vec<Vec<Point>>>),
    Empty,
}

impl<'de> Deserialize<'de> for Coordinates {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> std::result::Result<Coordinates, D::Error> {
        deserializer.deserialize_any(Depth)
    }
}

/// Reads coordinates of any depth. The first element of each array sets the depth of the rest.
struct Depth;

impl<'de> Visitor<'de> for Depth {
    type Value = Coordinates;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GeoJSON coordinates")
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Coordinates, E> {
        Ok(Coordinates::Number(v))
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Coordinates, E> {
        Ok(Coordinates::Number(v as f64))
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Coordinates, E> {
        Ok(Coordinates::Number(v as f64))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Coordinates, A::Error> {
        Ok(match seq.next_element::<Coordinates>()? {
            None => Coordinates::Empty,
            Some(Coordinates::Number(x)) => {
                let y = seq.next_element::<f64>()?.unwrap_or(f64::NAN);
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Coordinates::Position([x, y])
            }
            Some(Coordinates::Position(p)) => {
                let mut line = vec![p];
                while let Some(Position(p)) = seq.next_element()? {
                    line.push(p);
                }
                Coordinates::Line(line)
            }
            Some(Coordinates::Line(first)) => {
                let mut rings = vec![first];
                while let Some(ring) = seq.next_element::<Vec<Position>>()? {
                    rings.push(ring.into_iter().map(|p| p.0).collect());
                }
                Coordinates::Rings(rings)
            }
            Some(Coordinates::Rings(first)) => {
                let mut polygons = vec![first];
                while let Some(polygon) = seq.next_element::<Vec<Vec<Position>>>()? {
                    polygons.push(polygon.into_iter().map(|r| r.into_iter().map(|p| p.0).collect()).collect());
                }
                Coordinates::Polygons(polygons)
            }
            Some(Coordinates::Polygons(_) | Coordinates::Empty) => {
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Coordinates::Empty
            }
        })
    }
}

/// One position: longitude and latitude, ignoring any altitude.
struct Position(Point);

impl<'de> Deserialize<'de> for Position {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> std::result::Result<Position, D::Error> {
        struct Numbers;
        impl<'de> Visitor<'de> for Numbers {
            type Value = Position;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a position")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Position, A::Error> {
                let x = seq.next_element::<f64>()?.unwrap_or(f64::NAN);
                let y = seq.next_element::<f64>()?.unwrap_or(f64::NAN);
                while seq.next_element::<IgnoredAny>()?.is_some() {}
                Ok(Position([x, y]))
            }
        }
        deserializer.deserialize_seq(Numbers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Kind, Value};

    const COLLECTION: &str = r#"{
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "id": 7, "properties": {"name": "Austin", "pop": 974447, "capital": true},
             "geometry": {"type": "Point", "coordinates": [-97.74, 30.27, 149.0]}},
            {"type": "Feature", "id": 9, "properties": {"name": "Dallas", "pop": null, "tags": ["big"]},
             "geometry": {"type": "Point", "coordinates": [-96.8, 32.78]}},
            {"type": "Feature", "properties": {"river": "Colorado"},
             "geometry": {"type": "LineString", "coordinates": [[-98.0, 30.0], [-97.0, 29.0]]}},
            {"type": "Feature", "properties": {"county": "Travis"},
             "geometry": {"type": "MultiPolygon", "coordinates": [[[[0, 0], [1, 0], [1, 1], [0, 0]]],
                                                                 [[[2, 2], [3, 2], [3, 3], [2, 2]]]]}}
        ]
    }"#;

    #[test]
    fn features_become_rows_of_tables_by_kind() {
        let data = geojson("texas", COLLECTION.as_bytes()).expect("valid");
        let points = data.table("points").expect("points");
        assert_eq!(points.len(), 2);
        assert_eq!(points.get(7_u64, "geometry"), Some(Value::Point([-97.74, 30.27])), "altitude skipped");
        assert_eq!(points.get(7_u64, "pop"), Some(Value::Number(974_447.0)));
        assert_eq!(points.get(9_u64, "pop"), None, "null is missing");
        assert_eq!(points.get(7_u64, "capital"), Some(Value::Bool(true)));
        assert_eq!(points.get(9_u64, "tags"), Some(Value::Text("[\"big\"]".into())), "other values as JSON");
        assert_eq!(data.table("lines").map(|t| t.kind("geometry")), Some(Some(Kind::Parts)));
        let polygons = data.table("polygons").expect("polygons");
        assert_eq!(polygons.kind("geometry"), Some(Kind::Polygons));
        let Some(Value::Polygons(shapes)) = polygons.get(0_u64, "geometry") else { panic!("polygons") };
        assert_eq!(shapes.len(), 2, "a multipolygon is one row");
        assert_eq!(polygons.get(0_u64, "county"), Some(Value::Text("Travis".into())));
    }

    #[test]
    fn gzip_compressed_geojson_reads_the_same() {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(COLLECTION.as_bytes()).expect("written");
        let data = geojson("texas", &encoder.finish().expect("finished")).expect("valid");
        assert_eq!(data.table("points").map(Table::len), Some(2));
    }

    #[test]
    fn a_bare_geometry_reads_and_a_truncated_document_errors() {
        let data = geojson("g", br#"{"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 1], [0, 0]]]}"#)
            .expect("a geometry");
        assert_eq!(data.table("polygons").map(Table::len), Some(1));
        assert!(geojson("g", b"{\"type\": \"FeatureCollection\"").is_err(), "a truncated document errors");
    }
}
