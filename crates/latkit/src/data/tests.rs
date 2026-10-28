//! Dataset tests, including a property test that any sequence of patches leaves a dataset matching
//! a plain model of its rows.

use proptest::prelude::*;

use crate::{Data, EnvelopeRequest, Error, Id, Ids, Patch, Row, Snapshot, Table, Value};

/// One row of the model: id, number field `x`, and reference `r` to another row's id.
type ModelRow = (u64, Option<f64>, Option<u64>);

#[derive(Clone, Debug)]
enum Change {
    Set(Vec<(u64, Option<f64>, Option<u64>)>, bool, bool),
    Remove(Vec<u64>),
    Append(Vec<Option<f64>>),
}

fn change() -> impl Strategy<Value = Change> {
    let id = 0..12_u64;
    let row = (id.clone(), proptest::option::of(-10.0..10.0_f64), proptest::option::of(0..14_u64));
    prop_oneof![
        3 => (proptest::collection::vec(row, 0..8), any::<bool>(), any::<bool>()).prop_map(|(rows, x, r)| {
            let mut seen = std::collections::HashSet::new();
            Change::Set(rows.into_iter().filter(|(id, ..)| seen.insert(*id)).collect(), x, r)
        }),
        1 => proptest::collection::vec(id, 0..5).prop_map(Change::Remove),
        1 => proptest::collection::vec(proptest::option::of(-1.0..1.0_f64), 0..1).prop_map(Change::Append),
    ]
}

struct Model {
    rows: Vec<ModelRow>,
    /// Frames of field `s`: per frame, the value of each row present then.
    frames: Vec<Vec<(u64, Option<f64>)>>,
}

impl Model {
    fn apply(&mut self, change: &Change) -> Patch {
        match change {
            Change::Set(rows, write_x, write_r) => {
                let mut table = Table::new("T", rows.iter().map(|r| r.0).collect::<Vec<_>>());
                if *write_x {
                    table = table.field("x", rows.iter().map(|r| r.1).collect::<Vec<_>>());
                }
                if *write_r {
                    table = table.reference("r", "T", rows.iter().map(|r| r.2).collect::<Vec<_>>());
                }
                for &(id, x, r) in rows {
                    let at = self.rows.iter().position(|m| m.0 == id).unwrap_or_else(|| {
                        self.rows.push((id, None, None));
                        self.rows.len() - 1
                    });
                    if *write_x {
                        self.rows[at].1 = x;
                    }
                    if *write_r {
                        self.rows[at].2 = r;
                    }
                }
                Patch::new().set(table)
            }
            Change::Remove(ids) => {
                self.rows.retain(|m| !ids.contains(&m.0));
                Patch::new().remove("T", ids.clone())
            }
            Change::Append(values) => {
                let values: Vec<Option<f64>> =
                    (0..self.rows.len()).map(|i| values.first().copied().flatten().map(|v| v + i as f64)).collect();
                let at = self.frames.len() as f64;
                self.frames.push(self.rows.iter().zip(&values).map(|(m, v)| (m.0, *v)).collect());
                Patch::new().append("T", [at], [("s", values)])
            }
        }
    }

    fn check(&self, data: &Snapshot) {
        let table = data.table("T").expect("the table exists");
        let ids: Vec<Id> = table.ids().collect();
        assert_eq!(ids, self.rows.iter().map(|m| Id::Number(m.0)).collect::<Vec<_>>());
        for &(id, x, r) in &self.rows {
            let has_x = table.kind("x").is_some();
            assert_eq!(data.get("T", id, "x", None), if has_x { x.map(Value::Number) } else { None }, "x of {id}");
            let wired = r.filter(|r| self.rows.iter().any(|m| m.0 == *r));
            assert_eq!(data.get("T", id, "r", None), wired.map(|r| Value::Row(Row::new("grid", "T", r))), "r of {id}");
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn patches_agree_with_the_model(changes in proptest::collection::vec(change(), 1..12)) {
        let data = Data::new("grid");
        data.apply(Patch::new().set(Table::new("T", Vec::<u64>::new()))).expect("an empty table");
        let mut model = Model { rows: Vec::new(), frames: Vec::new() };
        for change in &changes {
            let before = data.snapshot();
            let before_bytes = before.to_bytes();
            let patch = model.apply(change);
            data.apply(patch).expect("valid patches apply");
            model.check(&data.snapshot());
            prop_assert_eq!(before.to_bytes(), before_bytes, "an earlier snapshot never changes");
            let back = Snapshot::from_bytes(&data.snapshot().to_bytes()).expect("round trip");
            model.check(&back);
        }
        let data = data.snapshot();
        for (frame, rows) in model.frames.iter().enumerate() {
            for &(id, value) in rows {
                if let Some(at) = model.rows.iter().position(|m| m.0 == id) {
                    let read = data.get("T", id, "s", frame as f64);
                    let want = value.map(|v| Value::Number(f64::from(v as f32)));
                    prop_assert_eq!(read, want, "frame {} of {} (row {})", frame, id, at);
                }
            }
        }
    }
}

#[test]
fn a_failed_patch_changes_nothing() {
    let data = Data::new("grid");
    data.apply(Table::new("Bus", vec![1_u64, 2]).field("kv", vec![230.0, 115.0])).expect("valid");
    let before = data.snapshot().to_bytes();
    let error = data
        .apply(
            Patch::new()
                .set(Table::new("Bus", vec![3_u64]).field("kv", vec![69.0]))
                .set(Table::new("Bus", vec![4_u64]).field("kv", vec!["text"])),
        )
        .expect_err("text into a number field");
    assert!(matches!(&error, Error::Invalid { .. }), "{error}");
    assert_eq!(error.to_string(), "patch[1].Bus.kv: Text values for a Number field");
    assert_eq!(data.snapshot().to_bytes(), before);
}

#[test]
fn consecutive_appends_merge_and_report_their_own_errors() {
    let table = || Table::new("Bus", vec![1_u64, 2]).field("kv", vec![230.0, 115.0]);
    let one = Data::new("grid");
    one.apply(Patch::new().replace(table()).append(
        "Bus",
        [0.0, 1.0, 2.0],
        [("vm", vec![1.0_f32, 2.0, 3.0, 4.0, 5.0, 6.0])],
    ))
    .expect("valid");
    let each = Data::new("grid");
    let mut patch = Patch::new().replace(table());
    for f in 0..3 {
        let v = 2.0 * f as f32;
        patch = patch.append("Bus", [f64::from(f)], [("vm", vec![v + 1.0, v + 2.0])]);
    }
    each.apply(patch).expect("valid");
    assert_eq!(each.snapshot().to_bytes(), one.snapshot().to_bytes(), "appends of one frame each merge into one");
    let error = each
        .apply(
            Patch::new()
                .append("Bus", [3.0], [("vm", vec![1.0_f32, 1.0])])
                .append("Bus", [4.0], [("vm", vec![1.0_f32])])
                .append("Bus", [5.0], [("vm", vec![1.0_f32, 1.0])]),
        )
        .expect_err("a frame missing a row's value");
    assert!(error.to_string().starts_with("patch[1].Bus.vm"), "{error}");
}

#[test]
fn field_lengths_must_match_rows() {
    let data = Data::new("grid");
    let error = data.apply(Table::new("Bus", Ids::count(3)).field("kv", vec![1.0, 2.0])).expect_err("short field");
    assert_eq!(error.to_string(), "patch[0].Bus.kv: 2 values for 3 rows");
}

#[test]
fn repeated_ids_are_refused() {
    let data = Data::new("grid");
    let error = data.apply(Table::new("Bus", vec!["a", "a"])).expect_err("repeated id");
    assert!(error.to_string().starts_with("patch[0].Bus.ids[1]"), "{error}");
}

#[test]
fn references_to_unknown_tables_are_refused() {
    let data = Data::new("grid");
    let error =
        data.apply(Table::new("Branch", Ids::count(1)).reference("from", "Bus", vec![1_u64])).expect_err("no Bus");
    assert_eq!(error.to_string(), "Branch.from: no table Bus");
}

#[test]
fn missing_values_fit_any_kind_until_a_field_holds_a_value() {
    let data = Data::new("grid");
    let kind = || data.snapshot().table("Bus").and_then(|t| t.kind("name"));
    // A field written with no value takes the kind of its first values, and missing values write to
    // a field of any kind.
    data.apply(Table::new("Bus", Ids::count(2)).field("name", vec![None::<f64>; 2])).expect("missing values");
    data.apply(Table::new("Bus", Ids::count(2)).field("name", vec![Some("a"), None])).expect("texts after none");
    assert_eq!(kind(), Some(crate::Kind::Text));
    data.apply(Table::new("Bus", Ids::count(2)).field("name", vec![None::<f64>; 2])).expect("missing texts");
    assert_eq!(kind(), Some(crate::Kind::Text));
    // Once a field has held a value, its kind is fixed.
    let error = data.apply(Table::new("Bus", Ids::count(1)).field("name", vec![1.0])).expect_err("a number");
    assert_eq!(error.to_string(), "patch[0].Bus.name: Number values for a Text field");
    // A field with no value can become a reference.
    data.apply(Table::new("Bus", Ids::count(1)).field("feeds", vec![None::<f64>])).expect("missing values");
    data.apply(Table::new("Bus", Ids::count(1)).reference("feeds", "Bus", vec![1_u64])).expect("a reference");
    assert_eq!(data.snapshot().get("Bus", 0_u64, "feeds", None), Some(Value::Row(Row::new("grid", "Bus", 1_u64))));
}

#[test]
fn a_reference_takes_its_tables_id_kind() {
    let data = Data::new("grid");
    let branch = |ids: Ids| Table::new("Branch", Ids::count(1)).reference("to", "Bus", ids);
    data.apply(Patch::new().set(Table::new("Bus", vec!["a", "b"])).set(branch(vec![None::<u64>].into())))
        .expect("a reference with no ids yet");
    data.apply(branch(vec!["b"].into())).expect("the table's text ids");
    assert_eq!(data.snapshot().get("Branch", 0_u64, "to", None), Some(Value::Row(Row::new("grid", "Bus", "b"))));
    // Missing ids write to a reference of either kind.
    data.apply(branch(vec![None::<u64>].into())).expect("missing ids");
    assert_eq!(data.snapshot().get("Branch", 0_u64, "to", None), None);
    let error = data
        .apply(Table::new("Line", Ids::count(1)).reference("to", "Bus", vec![1_u64]))
        .expect_err("number ids for text ids");
    assert_eq!(error.to_string(), "Line.to: number ids for table Bus, whose ids are texts");
}

#[test]
fn dangling_references_resolve_once_the_row_exists() {
    let data = Data::new("grid");
    data.apply(Patch::new().set(Table::new("Bus", vec![1_u64])).set(Table::new("Branch", Ids::count(1)).reference(
        "to",
        "Bus",
        vec![2_u64],
    )))
    .expect("valid");
    let to = || data.snapshot().get("Branch", 0_u64, "to", None);
    assert_eq!(to(), None);
    data.apply(Table::new("Bus", vec![2_u64])).expect("valid");
    assert_eq!(to(), Some(Value::Row(Row::new("grid", "Bus", 2_u64))));
    data.apply(Patch::new().remove("Bus", vec![1_u64])).expect("valid");
    assert_eq!(to(), Some(Value::Row(Row::new("grid", "Bus", 2_u64))));
}

#[test]
fn inverses_follow_every_change_and_snapshots_keep_theirs() {
    let inverse = |data: &Snapshot, target: usize| {
        let Some(super::table::Field::Reference(r)) = data.table("Branch").and_then(|t| t.field_named("from")) else {
            panic!("a reference");
        };
        r.inverse().of(target).to_vec()
    };
    let data = Data::new("grid");
    data.apply(
        Patch::new().set(Table::new("Bus", vec![1_u64, 2, 3])).set(Table::new("Branch", Ids::count(4)).reference(
            "from",
            "Bus",
            vec![1_u64, 2, 1, 3],
        )),
    )
    .expect("valid");
    assert_eq!(inverse(&data.snapshot(), 0), vec![0, 2]);
    assert_eq!(inverse(&data.snapshot(), 2), vec![3]);
    let before = data.snapshot();
    data.apply(Table::new("Branch", vec![1_u64]).reference("from", "Bus", vec![3_u64])).expect("valid");
    let now = data.snapshot();
    assert_eq!((inverse(&now, 0), inverse(&now, 2)), (vec![0, 2], vec![1, 3]));
    data.apply(Patch::new().remove("Bus", vec![1_u64])).expect("valid");
    // Bus 1 is gone: the rows that referenced it are unwired, and the later buses moved up a row.
    let now = data.snapshot();
    assert_eq!((inverse(&now, 0), inverse(&now, 1)), (vec![], vec![1, 3]));
    assert_eq!(inverse(&before, 0), vec![0, 2]);
}

/// A dataset of `rows` rows of `Line` with a `flow` sampled over `frames` frames, one per second.
fn sampled(rows: usize, frames: usize) -> Snapshot {
    let data = Data::new("grid");
    let at: Vec<f64> = (0..frames).map(|f| f as f64).collect();
    let flow: Vec<f64> = (0..frames * rows).map(|i| ((i * 7919) % 1000) as f64 - 500.0).collect();
    data.apply(
        Patch::new()
            .axis("time", "s")
            .replace(Table::new("Line", Ids::count(rows as u32)).reference("from", "Bus", vec![0_u32; rows]))
            .replace(Table::new("Bus", Ids::count(1)).field("name", vec!["a"]))
            .append("Line", at, [("flow", flow)]),
    )
    .expect("valid");
    data.snapshot()
}

#[test]
fn describe_names_tables_fields_and_spans() {
    let description = sampled(3, 10).describe();
    assert_eq!(description.axis, Some(["time".into(), "s".into()]));
    assert_eq!(description.span, Some([0.0, 9.0]));
    let line = description.tables.iter().find(|t| t.name.as_str() == "Line").expect("Line");
    assert_eq!(line.rows, 3);
    let json = serde_json::to_value(line).expect("serializes");
    assert_eq!(
        json["fields"],
        serde_json::json!([
            { "name": "flow", "kind": "sampled", "span": [0.0, 9.0] },
            { "name": "from", "kind": "reference", "to": "Bus" },
        ])
    );
}

#[test]
fn envelopes_match_a_scan_of_the_frames() {
    let (rows, frames) = (3, 700);
    let data = sampled(rows, frames);
    let envelope = |field: &str, range: [f64; 2], spans: usize, ids: Option<Vec<u32>>| {
        let request =
            EnvelopeRequest { table: "Line".into(), field: field.into(), range, spans, ids: ids.map(Ids::from) };
        data.envelope(&request)
    };
    let value = |row: usize, frame: usize| (((frame * rows + row) * 7919) % 1000) as f32 - 500.0;
    for (range, spans) in [([0.0, 699.0], 1), ([0.0, 699.0], 7), ([13.5, 600.0], 5), ([650.0, 2000.0], 3)] {
        let envelope = envelope("flow", range, spans, None).expect("an envelope");
        assert_eq!(envelope.at.len(), spans + 1);
        for row in 0..rows {
            for s in 0..spans {
                let (lo, hi) = (envelope.at[s], envelope.at[s + 1]);
                let inside =
                    (0..frames).filter(|&f| f as f64 >= lo && (f as f64) < hi || s == spans - 1 && f as f64 == hi);
                let values: Vec<f32> = inside.map(|f| value(row, f)).collect();
                let least = values.iter().copied().reduce(f32::min).unwrap_or(f32::NAN);
                let greatest = values.iter().copied().reduce(f32::max).unwrap_or(f32::NAN);
                let i = row * spans + s;
                let same = |a: f32, b: f32| a == b || a.is_nan() && b.is_nan();
                assert!(
                    same(envelope.least[i], least) && same(envelope.greatest[i], greatest),
                    "{range:?}/{spans} row {row} span {s}"
                );
            }
        }
    }
    let picked = envelope("flow", [0.0, 699.0], 2, Some(vec![2, 0])).expect("an envelope");
    let all = envelope("flow", [0.0, 699.0], 2, None).expect("an envelope");
    assert_eq!(picked.least, [&all.least[4..6], &all.least[0..2]].concat());
    assert!(envelope("from", [0.0, 1.0], 1, None).is_err());
    assert!(envelope("flow", [0.0, 1.0], 1, Some(vec![9])).is_err());
    let json: EnvelopeRequest = serde_json::from_value(serde_json::json!({
        "table": "Line", "field": "flow", "range": [0, 699], "spans": 2, "ids": [2, 0],
    }))
    .expect("a request");
    assert_eq!(data.envelope(&json).expect("an envelope"), picked);
    let error = data.envelope(&EnvelopeRequest { table: "Nope".into(), ..json }).expect_err("no table");
    assert_eq!(error.to_string(), "Nope: no such table");
}

#[cfg(feature = "gpu")]
#[test]
fn queries_filter_sort_page_and_select() {
    use crate::{Order, Query, QueryResult, field};
    let data = Data::new("grid");
    let loading = vec![40.0, 95.0, 120.0, 95.0, 10.0];
    data.apply(
        Table::new("Branch", Ids::count(5)).field("loading", loading).field("name", vec!["a", "b", "c", "d", "e"]),
    )
    .expect("valid");
    let data = data.snapshot();
    let names = |read: &QueryResult| read.table.ids().map(|id| read.table.get(id, "name")).collect::<Vec<_>>();
    let text = |s: &str| Some(Value::Text(s.into()));
    let hot = Query::of("Branch").filter(field("loading").gt(90.0)).sort(field("loading"), Order::Descending);
    let sorted = data.query(&hot).expect("a query");
    assert_eq!((names(&sorted), sorted.total), (vec![text("c"), text("b"), text("d")], 3), "ties keep their order");
    let page = data.query(&hot.clone().offset(1).limit(1)).expect("a query");
    assert_eq!((names(&page), page.total), (vec![text("b")], 3), "the filter kept three, the page one");
    let least = data.query(&Query::of("Branch").sort(field("loading"), Order::Ascending).limit(2)).expect("a query");
    assert_eq!(names(&least), [text("e"), text("a")]);
    let selected =
        data.query(&Query::of("Branch").limit(1).select("double", field("loading") * 2.0)).expect("a query").table;
    assert_eq!(selected.fields().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["double"]);
    assert_eq!(selected.get(0_u64, "double"), Some(Value::Number(80.0)));
    let ids = data.query(&Query::of("Branch").limit(2).ids_alone()).expect("a query").table;
    assert_eq!((ids.len(), ids.fields().count()), (2, 0), "ids alone");
    let json: Query = serde_json::from_value(serde_json::json!({
        "of": "Branch", "filter": { "lt": ["$loading", 100] }, "sort": [["$loading", "descending"]], "limit": 2,
        "select": { "name": "$name" },
    }))
    .expect("a query");
    let read = data.query(&json).expect("a query");
    assert_eq!(names(&read), [text("b"), text("d")], "a selected field comes back as stored");
    let named = data.query(&Query::of("Branch").ids([3_u64, 1, 9])).expect("by ids");
    assert_eq!(names(&named), [text("d"), text("b")], "in the order given, unknown ids skipped");
    let lake = data.query(&Query::of("Branch").filter(field("name").contains("C"))).expect("contains");
    assert_eq!(names(&lake), [text("c")], "ignoring case");
    assert!(data.query(&Query::of("Nope")).is_err());
}

#[cfg(feature = "gpu")]
#[test]
fn queries_read_sampled_fields_at_a_coordinate() {
    use crate::{Query, field};
    let data = sampled(2, 4);
    let at_two = data.query(&Query::of("Line").at(2.0).select("flow", field("flow"))).expect("a query").table;
    let flow = |row: usize, frame: usize| Value::Number(((((frame * 2 + row) * 7919) % 1000) as f64) - 500.0);
    assert_eq!(at_two.get(1_u64, "flow"), Some(flow(1, 2)));
    let last = data.query(&Query::of("Line")).expect("a query").table;
    assert_eq!(last.kind("flow"), Some(crate::Kind::Number));
    assert_eq!(last.get(0_u64, "flow"), Some(flow(0, 3)));
}

#[test]
fn ids_too_large_for_json_numbers_are_written_as_text() {
    let big = (1_u64 << 53) + 1;
    let data = Data::new("grid");
    data.apply(Table::new("Bus", vec![big, 7]).field("kv", vec![1.0, 2.0])).expect("valid");
    assert_eq!(serde_json::to_string(&Id::Number(big)).expect("an id"), format!("\"{big}\""));
    assert_eq!(serde_json::to_string(&Id::Number(7)).expect("an id"), "7");
    let now = data.snapshot();
    let text = Id::from(big.to_string());
    assert_eq!(now.get("Bus", text, "kv", None), Some(Value::Number(1.0)), "the decimal text finds the row");
    assert_eq!(now.get("Bus", big, "kv", None), Some(Value::Number(1.0)));
    let counted = Table::new("Count", Ids::count(3)).field("x", vec![0.0, 1.0, 2.0]);
    data.apply(counted).expect("valid");
    assert_eq!(data.snapshot().get("Count", Id::from("2"), "x", None), Some(Value::Number(2.0)));
}

#[test]
fn schema_changes_only_with_fields() {
    let data = Data::new("grid");
    data.apply(Table::new("Bus", Ids::count(2)).field("kv", vec![1.0, 2.0])).expect("valid");
    let schema = data.snapshot().schema();
    data.apply(Table::new("Bus", Ids::count(3)).field("kv", vec![1.0, 2.0, 3.0])).expect("valid");
    assert_eq!(data.snapshot().schema(), schema);
    data.apply(Table::new("Bus", Ids::count(1)).field("name", vec!["a"])).expect("valid");
    assert_ne!(data.snapshot().schema(), schema);
}

#[test]
fn appending_by_id_keeps_other_rows_last_values() {
    let data = Data::new("grid");
    data.apply(Patch::new().set(Table::new("Bus", [10_u64, 20, 30])).append(
        "Bus",
        [0.0],
        [("vm", vec![1.0, 1.1, 1.2])],
    ))
    .expect("valid");
    data.apply(Patch::new().append_rows("Bus", [1.0], [("vm", vec![0.9])], [30_u64])).expect("by id");
    let vm = |id: u64| data.snapshot().get("Bus", id, "vm", 1.0);
    assert_eq!(vm(10), Some(Value::Number(1.0)), "other rows keep their last value");
    assert_eq!(vm(30), Some(Value::Number(f64::from(0.9_f32))), "recorded");
    let error = data.apply(Patch::new().append_rows("Bus", [2.0], [("vm", vec![1.0])], [40_u64]));
    assert!(error.is_err_and(|e| e.to_string().contains("no row")), "appending to an unknown id fails");
}

#[test]
fn a_patch_applies_only_to_its_named_dataset() {
    let grid = Data::new("grid");
    grid.apply(Patch::to("grid").set(Table::new("Bus", Ids::count(1)))).expect("its own dataset");
    let error = grid.apply(Patch::to("weather").set(Table::new("Cell", Ids::count(1))));
    assert!(error.is_err_and(|e| e.to_string().contains("weather")));
    let bytes = grid.snapshot().to_bytes();
    assert_eq!(Patch::from_bytes(&bytes).expect("a patch").data().map(crate::Name::as_str), Some("grid"));
    assert!(Snapshot::from_bytes(&Patch::new().to_bytes()).is_err(), "dataset bytes must name the dataset");
}
