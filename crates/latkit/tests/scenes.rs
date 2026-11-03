//! The scenes in `npm/test/scenes.js` decode with every option read, so the JSON form TypeScript
//! checks is the form latkit reads.

#![cfg(feature = "gpu")]

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
        let scene = match serde_json::from_value::<Scene>(scene) {
            Ok(scene) => scene,
            Err(error) => panic!("scene {i} does not decode: {error}"),
        };
        // Without sources, each mark misses its dataset. Anything else is an option left out.
        let failures = scene.failures(&[]).expect("no sources to clash");
        let left: Vec<_> = failures.iter().filter(|f| !f.to_string().contains("no source provides")).collect();
        assert!(left.is_empty(), "scene {i} leaves out options: {left:?}");
    }
}
