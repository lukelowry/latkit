//! Patches applied to a dataset agree with a plain model of rows, whatever the sequence.

use proptest::prelude::*;

use crate::{Data, Error, Id, Patch, Row, Table, Value};

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
                Patch::new().append([at], "T", [("s", values)])
            }
        }
    }

    fn check(&self, data: &Data) {
        let table = data.table("T").expect("the table exists");
        let ids: Vec<Id> = table.ids().collect();
        assert_eq!(ids, self.rows.iter().map(|m| Id::Number(m.0)).collect::<Vec<_>>());
        for &(id, x, r) in &self.rows {
            let row = Row::new("grid", "T", id);
            let has_x = table.kind("x").is_some();
            assert_eq!(data.get(&row, "x"), if has_x { x.map(Value::Number) } else { None }, "x of {id}");
            let wired = r.filter(|r| self.rows.iter().any(|m| m.0 == *r));
            assert_eq!(data.get(&row, "r"), wired.map(|r| Value::Row(Row::new("grid", "T", r))), "r of {id}");
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn patches_agree_with_the_model(changes in proptest::collection::vec(change(), 1..12)) {
        let mut data = Data::new("grid");
        data.apply(Patch::new().set(Table::new("T", Vec::<u64>::new()))).expect("an empty table");
        let mut model = Model { rows: Vec::new(), frames: Vec::new() };
        for change in &changes {
            let before = data.clone();
            let before_bytes = before.to_bytes();
            let patch = model.apply(change);
            data.apply(patch).expect("valid patches apply");
            model.check(&data);
            prop_assert_eq!(before.to_bytes(), before_bytes, "an earlier snapshot never changes");
            let back = Data::from_bytes(&data.to_bytes()).expect("round trip");
            model.check(&back);
        }
        for (frame, rows) in model.frames.iter().enumerate() {
            for &(id, value) in rows {
                if let Some(at) = model.rows.iter().position(|m| m.0 == id) {
                    let read = data.get_at(&Row::new("grid", "T", id), "s", frame as f64);
                    let want = value.map(|v| Value::Number(f64::from(v as f32)));
                    prop_assert_eq!(read, want, "frame {} of {} (row {})", frame, id, at);
                }
            }
        }
    }
}

#[test]
fn a_failed_patch_changes_nothing() {
    let mut data = Data::new("grid");
    data.apply(Table::new("Bus", vec![1_u64, 2]).field("kv", vec![230.0, 115.0])).expect("valid");
    let before = data.to_bytes();
    let error = data
        .apply(
            Patch::new()
                .set(Table::new("Bus", vec![3_u64]).field("kv", vec![69.0]))
                .set(Table::new("Bus", vec![4_u64]).field("kv", vec!["text"])),
        )
        .expect_err("text into a number field");
    assert!(matches!(&error, Error::Invalid { .. }), "{error}");
    assert_eq!(error.to_string(), "patch[1].Bus.kv: Text values for a Number field");
    assert_eq!(data.to_bytes(), before);
}

#[test]
fn field_lengths_must_match_rows() {
    let mut data = Data::new("grid");
    let error = data.apply(Table::new("Bus", 3).field("kv", vec![1.0, 2.0])).expect_err("short field");
    assert_eq!(error.to_string(), "patch[0].Bus.kv: 2 values for 3 rows");
}

#[test]
fn repeated_ids_are_refused() {
    let mut data = Data::new("grid");
    let error = data.apply(Table::new("Bus", vec!["a", "a"])).expect_err("repeated id");
    assert!(error.to_string().starts_with("patch[0].Bus.ids[1]"), "{error}");
}

#[test]
fn references_to_unknown_tables_are_refused() {
    let mut data = Data::new("grid");
    let error = data.apply(Table::new("Branch", 1).reference("from", "Bus", vec![1_u64])).expect_err("no Bus");
    assert_eq!(error.to_string(), "Branch.from: no table Bus");
}

#[test]
fn dangling_references_wire_up_when_the_row_arrives() {
    let mut data = Data::new("grid");
    data.apply(Patch::new().set(Table::new("Bus", vec![1_u64])).set(Table::new("Branch", 1).reference(
        "to",
        "Bus",
        vec![2_u64],
    )))
    .expect("valid");
    let branch = Row::new("grid", "Branch", 0_u64);
    assert_eq!(data.get(&branch, "to"), None);
    data.apply(Table::new("Bus", vec![2_u64])).expect("valid");
    assert_eq!(data.get(&branch, "to"), Some(Value::Row(Row::new("grid", "Bus", 2_u64))));
    data.apply(Patch::new().remove("Bus", vec![1_u64])).expect("valid");
    assert_eq!(data.get(&branch, "to"), Some(Value::Row(Row::new("grid", "Bus", 2_u64))));
}

#[test]
fn inverses_follow_every_change_and_snapshots_keep_theirs() {
    let inverse = |data: &Data, target: usize| {
        let Some(super::table::Field::Reference(r)) = data.table("Branch").and_then(|t| t.field_named("from")) else {
            panic!("a reference");
        };
        r.inverse().of(target).to_vec()
    };
    let mut data = Data::new("grid");
    data.apply(Patch::new().set(Table::new("Bus", vec![1_u64, 2, 3])).set(Table::new("Branch", 4).reference(
        "from",
        "Bus",
        vec![1_u64, 2, 1, 3],
    )))
    .expect("valid");
    assert_eq!(inverse(&data, 0), vec![0, 2]);
    assert_eq!(inverse(&data, 2), vec![3]);
    let before = data.clone();
    data.apply(Table::new("Branch", vec![1_u64]).reference("from", "Bus", vec![3_u64])).expect("valid");
    assert_eq!((inverse(&data, 0), inverse(&data, 2)), (vec![0, 2], vec![1, 3]));
    data.apply(Patch::new().remove("Bus", vec![1_u64])).expect("valid");
    // Bus 1 left: what named it names nothing, and the rest moved up a row.
    assert_eq!((inverse(&data, 0), inverse(&data, 1)), (vec![], vec![1, 3]));
    assert_eq!(inverse(&before, 0), vec![0, 2]);
}

#[test]
fn schema_changes_only_with_fields() {
    let mut data = Data::new("grid");
    data.apply(Table::new("Bus", 2).field("kv", vec![1.0, 2.0])).expect("valid");
    let schema = data.schema();
    data.apply(Table::new("Bus", 3).field("kv", vec![1.0, 2.0, 3.0])).expect("valid");
    assert_eq!(data.schema(), schema);
    data.apply(Table::new("Bus", 1).field("name", vec!["a"])).expect("valid");
    assert_ne!(data.schema(), schema);
}
