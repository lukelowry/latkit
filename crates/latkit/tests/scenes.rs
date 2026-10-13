//! The scenes of `npm/test/scenes.js` decode: the JSON form TypeScript checks is the form latkit reads.

#![cfg(feature = "serde")]

use latkit::Scene;

#[test]
fn the_npm_fixture_decodes() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../npm/test/scenes.js");
    let Ok(source) = std::fs::read_to_string(path) else {
        eprintln!("skipping: no {path} outside the repository");
        return;
    };
    let start = source.find("export default").and_then(|at| source[at..].find('[').map(|i| at + i));
    let end = source.rfind(']');
    let (Some(start), Some(end)) = (start, end) else { panic!("the fixture exports an array") };
    let scenes: Vec<serde_json::Value> = serde_json::from_str(&source[start..=end]).expect("the array is JSON");
    assert!(scenes.len() >= 9, "the fixture covers every form");
    for (i, scene) in scenes.into_iter().enumerate() {
        if let Err(error) = serde_json::from_value::<Scene>(scene) {
            panic!("scene {i} does not decode: {error}");
        }
    }
}
