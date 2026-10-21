//! latkit's rows and ids to JavaScript, and ids back: a query's columns cross as typed arrays and
//! arrays, built here once; everything else crosses as bytes or JSON.

use js_sys::{Array, Float64Array, Object, Reflect};
use latkit::Error;
use wasm_bindgen::{JsCast, JsValue};

/// The largest whole number a JavaScript number holds exactly: 2^53 - 1.
const SAFE: f64 = 9_007_199_254_740_991.0;

/// A value for JavaScript: a number, boolean, or text; a geometry as nested `[x, y]` arrays; a row a
/// reference names as its id.
fn value(value: &latkit::Value) -> JsValue {
    let xy = |p: &[f64; 2]| -> JsValue { Array::of2(&p[0].into(), &p[1].into()).into() };
    let path = |p: &Vec<[f64; 2]>| -> JsValue { p.iter().map(xy).collect::<Array>().into() };
    match value {
        latkit::Value::Number(n) => (*n).into(),
        latkit::Value::Bool(b) => (*b).into(),
        latkit::Value::Text(t) => JsValue::from_str(t),
        latkit::Value::Point(p) => xy(p),
        latkit::Value::Path(p) => path(p),
        latkit::Value::Parts(parts) => parts.iter().map(path).collect::<Array>().into(),
        latkit::Value::Polygons(polygons) => polygons
            .iter()
            .map(|rings| -> JsValue { rings.iter().map(path).collect::<Array>().into() })
            .collect::<Array>()
            .into(),
        latkit::Value::Row(row) => id_value(&row.id),
    }
}

/// `table` as a query answers it: `{ table, ids, fields, total }`, numbers as a `Float64Array`
/// (missing NaN), other values as arrays (missing `null`), a reference as `{ reference, ids }`.
pub(crate) fn table(table: &latkit::Table, total: usize) -> JsValue {
    let fields = Object::create(JsValue::NULL.unchecked_ref::<Object>());
    for field in table.describe().fields {
        let values = table.values(&field.name).unwrap_or_else(|| latkit::Values::from(Vec::<f64>::new()));
        let column: JsValue = match (&field.to, values.numbers()) {
            (Some(to), _) => object(&[("reference", JsValue::from_str(to)), ("ids", ids_value(&values))]),
            (None, Some(numbers)) => Float64Array::from(&numbers[..]).into(),
            (None, None) => {
                (0..values.len()).map(|i| values.get(i).map_or(JsValue::NULL, |v| value(&v))).collect::<Array>().into()
            }
        };
        let _ = Reflect::set(&fields, &JsValue::from_str(&field.name), &column);
    }
    let ids: Array = table.ids().map(|id| id_value(&id)).collect();
    object(&[
        ("table", JsValue::from_str(table.name())),
        ("ids", ids.into()),
        ("fields", fields.into()),
        ("total", (total as f64).into()),
    ])
}

/// Ids held as values, missing `null`.
fn ids_value(values: &latkit::Values) -> JsValue {
    (0..values.len()).map(|i| values.id(i).map_or(JsValue::NULL, |id| id_value(&id))).collect::<Array>().into()
}

/// An object of `entries`.
pub(crate) fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let object = Object::new();
    for (key, value) in entries {
        let _ = Reflect::set(&object, &JsValue::from_str(key), value);
    }
    object.into()
}

/// An id as a number or a text: a number too large for JavaScript's as its decimal text, which
/// names the same row.
pub(crate) fn id_value(id: &latkit::Id) -> JsValue {
    match id {
        latkit::Id::Number(n) if *n as f64 <= SAFE => (*n as f64).into(),
        latkit::Id::Number(n) => JsValue::from_str(&n.to_string()),
        latkit::Id::Text(t) => JsValue::from_str(t),
    }
}

/// The id JavaScript names: a whole number from 0 to 2^53 - 1, or a text.
pub(crate) fn id(value: &JsValue) -> Result<latkit::Id, Error> {
    if let Some(text) = value.as_string() {
        return Ok(latkit::Id::from(text));
    }
    match value.as_f64() {
        Some(n) if n.fract() == 0.0 && (0.0..=SAFE).contains(&n) => Ok(latkit::Id::Number(n as u64)),
        _ => Err(Error::invalid("an id is a whole number from 0 to 2^53 - 1, or a text").at("id")),
    }
}
