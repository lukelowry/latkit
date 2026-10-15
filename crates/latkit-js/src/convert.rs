//! JavaScript values to latkit's and back. Typed arrays copy once; plain arrays read their first
//! present element to know what they hold.

use js_sys::{Array, Float32Array, Float64Array, Int32Array, Object, Reflect, Uint8Array, Uint32Array};
use latkit::{Error, Result};
use wasm_bindgen::{JsCast, JsValue};

/// A parse error as an invalid-input error.
pub(crate) fn invalid(what: &str, error: &serde_json::Error) -> Error {
    Error::invalid(error.to_string()).at(what)
}

fn error(reason: &'static str) -> Error {
    Error::invalid(reason)
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
        return Ok(latkit::Ids::from(a.to_vec().into_iter().map(|v| v as u64).collect::<Vec<_>>()));
    }
    let Some(array) = value.dyn_ref::<Array>() else { return Err(error("ids are a count, numbers, or texts")) };
    let first = array.iter().find(|v| !v.is_null() && !v.is_undefined());
    Ok(match first {
        Some(v) if v.is_string() => {
            latkit::Ids::from(array.iter().map(|v| v.as_string()).collect::<Vec<Option<String>>>())
        }
        _ => latkit::Ids::from(array.iter().map(|v| v.as_f64().map(|n| n as u64)).collect::<Vec<Option<u64>>>()),
    })
}

/// One id: a number or a text.
pub(crate) fn id(value: &JsValue) -> Result<latkit::Id> {
    if let Some(n) = value.as_f64() {
        return Ok(latkit::Id::Number(n as u64));
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

pub(crate) fn object(entries: &[(&str, JsValue)]) -> JsValue {
    let object = Object::new();
    for (key, value) in entries {
        let _ = Reflect::set(&object, &(*key).into(), value);
    }
    object.into()
}

fn numbers(values: &[f64]) -> JsValue {
    values.iter().map(|&v| JsValue::from(v)).collect::<Array>().into()
}

/// An id as a number or a text.
pub(crate) fn id_value(id: &latkit::Id) -> JsValue {
    match id {
        latkit::Id::Number(n) => (*n as f64).into(),
        latkit::Id::Text(t) => JsValue::from_str(t),
    }
}

/// A row as `{ data, table, id }`.
pub(crate) fn row(row: &latkit::Row) -> JsValue {
    object(&[
        ("data", JsValue::from_str(&row.data)),
        ("table", JsValue::from_str(&row.table)),
        ("id", id_value(&row.id)),
    ])
}

/// A row from `{ data, table, id }`.
pub(crate) fn row_of(value: &JsValue) -> Result<latkit::Row> {
    let text = |key: &str| Reflect::get(value, &key.into()).ok().and_then(|v| v.as_string());
    let (Some(data), Some(table)) = (text("data"), text("table")) else {
        return Err(error("a row is { data, table, id }"));
    };
    let id = Reflect::get(value, &"id".into()).map_err(|_| error("a row is { data, table, id }"))?;
    Ok(latkit::Row::new(data, table, self::id(&id)?))
}

/// A hit as `{ row, mark, point, position, distance, port?, sample? }`.
pub(crate) fn hit(hit: &latkit::Hit) -> JsValue {
    let mut entries = vec![
        ("row", row(&hit.row)),
        ("mark", (hit.mark as f64).into()),
        ("point", numbers(&hit.point.map(f64::from))),
        ("position", numbers(&hit.position)),
        ("distance", f64::from(hit.distance).into()),
    ];
    if let Some(port) = &hit.port {
        entries.push(("port", JsValue::from_str(port)));
    }
    if let Some(sample) = &hit.sample {
        let sample = object(&[
            ("frame", f64::from(sample.frame).into()),
            ("at", sample.at.into()),
            ("value", sample.value.into()),
        ]);
        entries.push(("sample", sample));
    }
    object(&entries)
}

/// A connection's end as `{ row, port? }`.
fn end(end: &latkit::End) -> JsValue {
    let mut entries = vec![("row", row(&end.row))];
    if let Some(port) = &end.port {
        entries.push(("port", JsValue::from_str(port)));
    }
    object(&entries)
}

/// Keys held as `{ shift, control, alt, meta }`.
fn modifiers(m: latkit::Modifiers) -> JsValue {
    object(&[("shift", m.shift.into()), ("control", m.control.into()), ("alt", m.alt.into()), ("meta", m.meta.into())])
}

/// An event as `{ type, detail }`.
pub(crate) fn event(event: &latkit::Event) -> JsValue {
    let (kind, detail) = match event {
        latkit::Event::Hover(found) => ("hover", found.as_ref().map_or(JsValue::NULL, hit)),
        latkit::Event::Click(found) => ("click", hit(found)),
        latkit::Event::Open(found) => ("open", hit(found)),
        latkit::Event::Select(rows) => ("select", rows.iter().map(row).collect::<Array>().into()),
        latkit::Event::Drag(drag) => {
            let phase = match drag.phase {
                latkit::Phase::Start => "start",
                latkit::Phase::Move => "move",
                latkit::Phase::End => "end",
            };
            let detail = object(&[
                ("phase", JsValue::from_str(phase)),
                ("hit", hit(&drag.hit)),
                ("point", numbers(&drag.point.map(f64::from))),
                ("position", numbers(&drag.position)),
            ]);
            ("drag", detail)
        }
        latkit::Event::Menu { point, hits, keyboard, modifiers } => {
            let detail = object(&[
                ("point", numbers(&point.map(f64::from))),
                ("hits", hits.iter().map(hit).collect::<Array>().into()),
                ("keyboard", (*keyboard).into()),
                ("modifiers", self::modifiers(*modifiers)),
            ]);
            ("menu", detail)
        }
        latkit::Event::Connect { from, to, edge, point } => {
            let detail = object(&[
                ("from", end(from)),
                ("to", to.as_ref().map_or(JsValue::NULL, end)),
                ("edge", edge.as_ref().map_or(JsValue::NULL, row)),
                ("point", numbers(&point.map(f64::from))),
            ]);
            ("connect", detail)
        }
        latkit::Event::Delete(rows) => ("delete", rows.iter().map(row).collect::<Array>().into()),
        latkit::Event::Camera => ("camera", JsValue::UNDEFINED),
        latkit::Event::Error(e) => ("error", crate::Error::from(e.clone()).into()),
        _ => ("other", JsValue::UNDEFINED),
    };
    object(&[("type", JsValue::from_str(kind)), ("detail", detail)])
}

/// Stats as `{ frames, rows, drawn, uploading, resident, budget, waiting, cpuMs, gpuMs }`.
pub(crate) fn stats(stats: &latkit::Stats) -> JsValue {
    object(&[
        ("frames", (stats.frames as f64).into()),
        ("rows", (stats.rows as f64).into()),
        ("drawn", (stats.drawn as f64).into()),
        ("uploading", (stats.uploading as f64).into()),
        ("resident", (stats.resident as f64).into()),
        ("budget", (stats.budget as f64).into()),
        ("complete", stats.complete.into()),
        ("cpuMs", f64::from(stats.cpu_ms).into()),
        ("gpuMs", f64::from(stats.gpu_ms).into()),
    ])
}
