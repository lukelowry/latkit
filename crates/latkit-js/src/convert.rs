//! JavaScript data to latkit's and back: ids and field values. Typed arrays copy once; plain arrays
//! read their first present element to know what they hold. A view's state crosses as JSON instead.

use js_sys::{Array, Float32Array, Float64Array, Int32Array, Object, Reflect, Uint8Array, Uint32Array};
use latkit::{Error, Result};
use wasm_bindgen::{JsCast, JsValue};

/// The largest whole number a JavaScript number holds exactly: 2âµÂ³ âˆ’ 1.
const SAFE: f64 = 9_007_199_254_740_991.0;

/// A parse error as an invalid-input error.
pub(crate) fn invalid(what: &str, error: &serde_json::Error) -> Error {
    Error::invalid(error.to_string()).at(what)
}

fn error(reason: &'static str) -> Error {
    Error::invalid(reason)
}

/// A numeric id: a whole number a JavaScript number holds exactly, never truncated.
fn number_id(n: f64) -> Result<u64> {
    if n.fract() == 0.0 && (0.0..=SAFE).contains(&n) {
        Ok(n as u64)
    } else {
        Err(error("a numeric id is a whole number from 0 to 2^53 - 1"))
    }
}

/// Row ids: a count, numbers, or texts.
pub(crate) fn ids(value: &JsValue) -> Result<latkit::Ids> {
    if let Some(n) = value.as_f64() {
        if n < 0.0 || n.fract() != 0.0 || n > f64::from(u32::MAX) {
            return Err(error("a row count is a whole number"));
        }
        return Ok(latkit::Ids::from(n as u32));
    }
    if let Some(a) = value.dyn_ref::<Uint32Array>() {
        return Ok(latkit::Ids::from(a.to_vec()));
    }
    if let Some(a) = value.dyn_ref::<Float64Array>() {
        let ids = a.to_vec().into_iter().enumerate().map(|(i, n)| number_id(n).map_err(|e| e.at(i)));
        return Ok(latkit::Ids::from(ids.collect::<Result<Vec<u64>>>()?));
    }
    let Some(array) = value.dyn_ref::<Array>() else { return Err(error("ids are a count, numbers, or texts")) };
    let first = array.iter().find(|v| !v.is_null() && !v.is_undefined());
    Ok(match first {
        Some(v) if v.is_string() => {
            latkit::Ids::from(array.iter().map(|v| v.as_string()).collect::<Vec<Option<String>>>())
        }
        _ => {
            let ids = array.iter().enumerate().map(|(i, v)| v.as_f64().map(number_id).transpose().map_err(|e| e.at(i)));
            latkit::Ids::from(ids.collect::<Result<Vec<Option<u64>>>>()?)
        }
    })
}

/// One id: a number or a text.
pub(crate) fn id(value: &JsValue) -> Result<latkit::Id> {
    if let Some(n) = value.as_f64() {
        return number_id(n).map(latkit::Id::Number);
    }
    value.as_string().map(latkit::Id::from).ok_or_else(|| error("an id is a number or a text"))
}

/// `table` with `fields`: each key a field; a value is values, or `{ reference, ids }`.
pub(crate) fn fields(mut table: latkit::Table, fields: &Object) -> Result<latkit::Table> {
    for entry in Object::entries(fields).iter() {
        let entry: Array = entry.unchecked_into();
        let name = entry.get(0).as_string().unwrap_or_default();
        let field = entry.get(1);
        let reference = Reflect::get(&field, &"reference".into()).ok().and_then(|r| r.as_string());
        table = match reference {
            Some(to) => {
                let ids_ = Reflect::get(&field, &"ids".into()).map_err(|_| error("a reference names its ids"))?;
                table.reference(name.as_str(), to, ids(&ids_).map_err(|e| e.at(name.as_str()))?)
            }
            None => table.field(name.as_str(), values(&field).map_err(|e| e.at(name.as_str()))?),
        };
    }
    Ok(table)
}

/// Every entry of `fields` as values.
pub(crate) fn values_of(fields: &Object) -> Result<Vec<(String, latkit::Values)>> {
    Object::entries(fields)
        .iter()
        .map(|entry| {
            let entry: Array = entry.unchecked_into();
            let name = entry.get(0).as_string().unwrap_or_default();
            let values = values(&entry.get(1)).map_err(|e| e.at(name.as_str()))?;
            Ok((name, values))
        })
        .collect()
}

/// Values: a typed array (a `Uint8Array` of booleans, nonzero true), or an array of numbers,
/// booleans, texts, or `[x, y]` geometries; `null` is missing.
pub(crate) fn values(value: &JsValue) -> Result<latkit::Values> {
    if let Some(a) = value.dyn_ref::<Uint8Array>() {
        return Ok(a.to_vec().iter().map(|&b| b != 0).collect::<Vec<bool>>().into());
    }
    if let Some(a) = value.dyn_ref::<Float64Array>() {
        return Ok(a.to_vec().into());
    }
    if let Some(a) = value.dyn_ref::<Float32Array>() {
        return Ok(a.to_vec().into());
    }
    if let Some(a) = value.dyn_ref::<Int32Array>() {
        return Ok(a.to_vec().into());
    }
    if let Some(a) = value.dyn_ref::<Uint32Array>() {
        return Ok(a.to_vec().into());
    }
    let Some(array) = value.dyn_ref::<Array>() else { return Err(error("values are a typed array or an array")) };
    let first = array.iter().find(|v| !v.is_null() && !v.is_undefined());
    let Some(first) = first else { return Ok(vec![None::<f64>; array.length() as usize].into()) };
    if first.as_f64().is_some() {
        return Ok(array.iter().map(|v| v.as_f64()).collect::<Vec<_>>().into());
    }
    if first.as_bool().is_some() {
        return Ok(array.iter().map(|v| v.as_bool()).collect::<Vec<_>>().into());
    }
    if first.is_string() {
        return Ok(array.iter().map(|v| v.as_string()).collect::<Vec<_>>().into());
    }
    let depth = depth(&first);
    let rows = array.iter();
    Ok(match depth {
        0 => rows.map(|v| point(&v)).collect::<Vec<_>>().into(),
        1 => rows.map(|v| path(&v)).collect::<Vec<_>>().into(),
        2 => rows.map(|v| list(&v, path)).collect::<Vec<_>>().into(),
        3 => rows.map(|v| list(&v, |p| list(p, path))).collect::<Vec<_>>().into(),
        _ => return Err(error("geometries nest at most polygons of rings of [x, y] points")),
    })
}

/// How deep a geometry nests below `[x, y]`.
fn depth(value: &JsValue) -> usize {
    let mut depth = 0;
    let mut v = value.clone();
    while let Some(array) = v.dyn_ref::<Array>() {
        let first = array.get(0);
        if first.as_f64().is_some() {
            return depth;
        }
        depth += 1;
        v = first;
    }
    depth
}

fn point(value: &JsValue) -> [f64; 2] {
    value
        .dyn_ref::<Array>()
        .map_or([f64::NAN; 2], |a| [a.get(0).as_f64().unwrap_or(f64::NAN), a.get(1).as_f64().unwrap_or(f64::NAN)])
}

fn path(value: &JsValue) -> Vec<[f64; 2]> {
    value.dyn_ref::<Array>().map_or_else(Vec::new, |a| a.iter().map(|p| point(&p)).collect())
}

fn list<T>(value: &JsValue, item: impl Fn(&JsValue) -> T) -> Vec<T> {
    value.dyn_ref::<Array>().map_or_else(Vec::new, |a| a.iter().map(|v| item(&v)).collect())
}

/// A value for JavaScript: numbers, booleans, texts, nested `[x, y]` arrays, or `{ data, table, id }`.
pub(crate) fn value(value: &latkit::Value) -> JsValue {
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
        latkit::Value::Row(row) => self::row(row),
    }
}

/// An id as a number or a text.
pub(crate) fn id_value(id: &latkit::Id) -> JsValue {
    match id {
        latkit::Id::Number(n) => (*n as f64).into(),
        latkit::Id::Text(t) => JsValue::from_str(t),
    }
}

/// A row a reference field names, as `{ data, table, id }`.
fn row(row: &latkit::Row) -> JsValue {
    let object = Object::new();
    for (key, value) in
        [("data", JsValue::from_str(&row.data)), ("table", JsValue::from_str(&row.table)), ("id", id_value(&row.id))]
    {
        let _ = Reflect::set(&object, &key.into(), &value);
    }
    object.into()
}
