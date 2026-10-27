//! Conversion of latkit rows and ids to JavaScript, and of ids back. A query's columns cross as
//! typed arrays and arrays, built here once. Everything else crosses as bytes or JSON.

use js_sys::{Array, Float64Array, Object, Reflect};
use latkit::Error;
use wasm_bindgen::{JsCast, JsValue};

/// `value` as a JavaScript value. Numbers, booleans, and text convert directly. A geometry becomes
/// nested `[x, y]` arrays, and a referenced row becomes its id.
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

/// A query result as `{ table, ids, fields, total }`. A number column becomes a `Float64Array`
/// (missing values are NaN), a reference column `{ reference, ids }`, and any other column an array
/// (missing values are `null`).
pub(crate) fn query_result(read: &latkit::QueryResult) -> JsValue {
    let table = &read.table;
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
        ("total", (read.total as f64).into()),
    ])
}

/// A column of ids as an array, with `null` for missing ids.
fn ids_value(values: &latkit::Values) -> JsValue {
    (0..values.len()).map(|i| values.id(i).map_or(JsValue::NULL, |id| id_value(&id))).collect::<Array>().into()
}

/// A JavaScript object with `entries` as its properties.
pub(crate) fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let object = Object::new();
    for (key, value) in entries {
        let _ = Reflect::set(&object, &JsValue::from_str(key), value);
    }
    object.into()
}

/// An id as JSON writes it: a number, or a string for a text id or a number above 2^53 − 1.
pub(crate) fn id_value(id: &latkit::Id) -> JsValue {
    id.exact_number().map_or_else(|| JsValue::from_str(&id.to_string()), JsValue::from)
}

/// Parses a JavaScript id: a whole number from 0 to 2^53 − 1, or a string.
pub(crate) fn id(value: &JsValue) -> Result<latkit::Id, Error> {
    value
        .as_string()
        .map(latkit::Id::from)
        .or_else(|| value.as_f64().and_then(latkit::Id::from_number))
        .ok_or_else(|| Error::invalid("expected a whole number from 0 to 2^53 - 1, or a string").at("id"))
}

/// `values` as exactly `N` numbers, or an invalid error at `what`.
pub(crate) fn fixed<T: Copy, const N: usize>(values: &[T], what: &str) -> Result<[T; N], Error> {
    values.try_into().map_err(|_| Error::invalid(format!("expected {N} numbers")).at(what))
}
