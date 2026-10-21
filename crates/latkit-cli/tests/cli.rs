//! The executable's contracts: files, pipes, exit codes, diagnostics, and every output a render
//! writes, from a still to a video.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use latkit::Image;

const SCENE: &str =
    r#"{"space":"plane","ease":0,"marks":[{"vertices":{"of":["grid","Bus"],"position":["x","y"],"radius":6}}]}"#;
const DATA: &str = r#"{"name":"grid","patch":[{"replace":{"table":"Bus","ids":[10,20],"fields":{"x":[-10,10],"y":[0,0],"name":["Alpha","Beta"]}}}]}"#;
const CAMERA: &str = r#"{"center":[0,0],"zoom":2,"pitch":0,"bearing":0}"#;

fn run(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_latkit"))
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(bytes) = input {
        child.stdin.take().unwrap().write_all(bytes).unwrap();
    }
    drop(child.stdin.take());
    child.wait_with_output().unwrap()
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("scene.json"), SCENE).unwrap();
    std::fs::write(dir.path().join("grid.json"), DATA).unwrap();
    std::fs::write(dir.path().join("camera.json"), CAMERA).unwrap();
    dir
}

/// Whether the machine has no GPU, which only `LATKIT_REQUIRE_GPU` makes a failure.
fn no_gpu(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let missing = !output.status.success() && (stderr.contains("no GPU adapter") || stderr.contains("no GPU device"));
    assert!(!missing || std::env::var_os("LATKIT_REQUIRE_GPU").is_none(), "GPU required: {stderr}");
    missing
}

fn ok(output: &Output) {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

/// Writes frames: `x` positions of the two buses, as patches of slices of one binary file.
fn frames(dir: &Path, xs: &[[f32; 2]]) {
    let bytes: Vec<u8> = xs.iter().flatten().flat_map(|x| x.to_le_bytes()).collect();
    std::fs::create_dir_all(dir.join("sequence")).unwrap();
    std::fs::write(dir.join("sequence/x.f32"), bytes).unwrap();
    let lines: Vec<String> = (0..xs.len())
        .map(|i| {
            format!(
                r#"{{"at":{i},"patch":{{"grid":[{{"set":{{"table":"Bus","ids":[10,20],"fields":{{"x":{{"file":"x.f32","dtype":"f32le","offset":{},"count":2}}}}}}}}]}}}}"#,
                i * 8
            )
        })
        .collect();
    std::fs::write(dir.join("sequence/frames.jsonl"), lines.join("\n")).unwrap();
}

const COMMON: [&str; 9] = [
    "render",
    "scene.json",
    "-d",
    "grid.json",
    "--camera",
    "camera.json",
    "--frames",
    "sequence/frames.jsonl",
    "--size=64x64",
];

#[test]
fn usage_errors_exit_2_before_reading_or_drawing() {
    let dir = tempfile::tempdir().unwrap();
    let help = run(dir.path(), &["render", "--help"], None);
    ok(&help);
    assert!(String::from_utf8(help.stdout).unwrap().contains("--frames"));
    for args in [
        vec!["render", "missing.json"],
        vec!["render", "missing.json", "-o", "out.png", "--size", "0x10"],
        vec!["render", "missing.json", "-o", "out.png", "--scale", "NaN"],
        vec!["render", "missing.json", "-o", "out.png", "--at", "inf"],
        vec!["render", "missing.json", "-o", "out.png", "--elapsed", "1e100"],
        vec!["render", "missing.json", "-o", "out.png", "--deadline", "0"],
        vec!["render", "missing.json", "-o", "out.gif"],
        vec!["render", "missing.json", "-o", "out.mp4"],
        vec!["render", "missing.json", "--frames", "f.jsonl", "-o", "out.mp4", "--size", "62x64"],
        vec!["render", "missing.json", "--frames", "f.jsonl", "-o", "out.mp4", "--transparent"],
        vec!["render", "missing.json", "--frames", "f.jsonl", "-o", "out.mp4", "--fps", "0"],
        vec!["render", "missing.json", "--frames", "f.jsonl", "-o", "out/%04d.y4m"],
        vec!["render", "missing.json", "-o", "out/%04d.png"],
        vec!["render", "a.json", "b.json", "-o", "out.png"],
        vec!["render", "a.json", "-o", "out.png", "--tiles", "base.pmtiles"],
        vec!["validate", "-", "-d", "-"],
    ] {
        assert_eq!(run(dir.path(), &args, None).status.code(), Some(2), "{args:?}");
    }
}

#[test]
fn validation_reads_everything_without_a_gpu_and_is_silent_on_success() {
    let dir = fixture();
    frames(dir.path(), &[[-4.0, 4.0], [0.0, 8.0]]);
    for (args, stdin) in [
        (vec!["validate", "scene.json", "-d", "grid.json"], None),
        (vec!["validate", "-", "-d", "grid.json"], Some(SCENE.as_bytes())),
        (vec!["validate", "scene.json", "-d", "-"], Some(DATA.as_bytes())),
        (vec!["validate", "scene.json", "-d", "grid.json", "--frames", "sequence/frames.jsonl"], None),
    ] {
        let output = run(dir.path(), &args, stdin);
        ok(&output);
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
    }
    // A frame naming no dataset fails at its line, as JSON when asked.
    let bad = r#"{"at":0,"patch":{"absent":[{"forget":{"before":0}}]}}"#;
    std::fs::write(dir.path().join("sequence/bad.jsonl"), format!("{{\"at\":0}}\n{bad}")).unwrap();
    let args = ["--diagnostics", "json", "validate", "scene.json", "-d", "grid.json", "--frames", "sequence/bad.jsonl"];
    let output = run(dir.path(), &args, None);
    assert_eq!(output.status.code(), Some(1));
    let told: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(told["type"], "error");
    assert_eq!(told["detail"]["code"], "invalid");
    assert_eq!(told["detail"]["path"], "frames[1].patch.absent");
    // A camera for each view looks at its own view's space: a plot's cannot look at a plane.
    std::fs::write(dir.path().join("sequence/bad.jsonl"), r#"{"camera": [{"x": [0, 1]}]}"#).unwrap();
    let output = run(dir.path(), &args, None);
    let told: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(told["detail"]["path"], "frames[0].camera[0]");
    assert!(told["detail"]["source"].as_str().unwrap().ends_with("bad.jsonl"));
}

#[test]
fn failures_name_the_part_and_the_file_and_keep_the_output() {
    let dir = fixture();
    let output = run(dir.path(), &["--diagnostics", "json", "validate", "scene.json"], None);
    assert_eq!(output.status.code(), Some(1));
    let told: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(told["detail"]["path"], "marks[0].vertices.of");
    assert_eq!(told["detail"]["source"], "scene.json");
    let twice = run(dir.path(), &["validate", "scene.json", "-d", "grid.json", "-d", "grid.json"], None);
    assert!(String::from_utf8_lossy(&twice.stderr).contains("duplicate"));
    std::fs::write(dir.path().join("out.png"), b"keep this").unwrap();
    assert_eq!(run(dir.path(), &["render", "scene.json", "-o", "out.png"], None).status.code(), Some(1));
    assert_eq!(std::fs::read(dir.path().join("out.png")).unwrap(), b"keep this");
    // A legend shows a color mapped through a colormap with a domain or named categories.
    let legend = r#"{"space":"plane","marks":[{"vertices":{"of":["grid","Bus"],"legend":"Buses"}}]}"#;
    let output =
        run(dir.path(), &["--diagnostics", "json", "validate", "-", "-d", "grid.json"], Some(legend.as_bytes()));
    let told: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(told["detail"]["path"], "marks[0].vertices.legend");
}

#[test]
fn inspect_describes_datasets_and_geojson_takes_a_name() {
    let dir = fixture();
    let geo = r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"n":1},"geometry":{"type":"Point","coordinates":[1,2]}}]}"#;
    std::fs::write(dir.path().join("places.geojson"), geo).unwrap();
    let output = run(dir.path(), &["inspect", "grid.json", "places=places.geojson"], None);
    ok(&output);
    let told: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(told[0]["name"], "grid");
    let bus = &told[0]["tables"][0];
    assert_eq!((&bus["name"], &bus["rows"]), (&"Bus".into(), &2.into()));
    assert_eq!(bus["fields"][0], serde_json::json!({ "name": "name", "kind": "text" }));
    assert_eq!(told[1]["name"], "places");
    assert_eq!(told[1]["tables"][0]["rows"], 1);
    assert_eq!(run(dir.path(), &["inspect", "places.geojson"], None).status.code(), Some(1), "GeoJSON needs a name");
}

#[test]
fn schema_describes_every_input_and_frames() {
    let dir = fixture();
    let output = run(dir.path(), &["schema", "frames"], None);
    ok(&output);
    let schema: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(schema["$ref"], "#/$defs/Frame");
    let frame = &schema["$defs"]["Frame"]["properties"];
    assert_eq!(frame["patch"]["$ref"], "#/$defs/Patches");
    assert!(frame["camera"].to_string().contains("#/$defs/Camera"), "{frame}");
    let all: serde_json::Value = serde_json::from_slice(&run(dir.path(), &["schema"], None).stdout).unwrap();
    assert!(all.get("$ref").is_none() && all["$defs"]["Scene"].is_object());
}

#[test]
fn query_writes_a_json_line_a_row() {
    let dir = fixture();
    let query =
        r#"{"of":"Bus","sort":[["x","descending"]],"select":{"name":"name","twice":{"op":"mul","args":["x",2]}}}"#;
    let output = run(dir.path(), &["query", "grid.json", query], None);
    ok(&output);
    let lines: Vec<serde_json::Value> =
        String::from_utf8(output.stdout).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(
        lines,
        [
            serde_json::json!({ "id": 20, "name": "Beta", "twice": 20.0 }),
            serde_json::json!({ "id": 10, "name": "Alpha", "twice": -20.0 }),
        ]
    );
    std::fs::write(dir.path().join("query.json"), r#"{"of":"Bus","filter":{"op":"lt","args":["x",0]}}"#).unwrap();
    let output = run(dir.path(), &["query", "-", "query.json"], Some(DATA.as_bytes()));
    ok(&output);
    assert_eq!(String::from_utf8(output.stdout).unwrap().lines().count(), 1);
    let output = run(dir.path(), &["query", "grid.json", r#"{"of":"Nope"}"#], None);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("no such table"));
}

#[test]
fn a_history_tiles_and_draws_from_its_spans_as_from_itself() {
    let dir = tempfile::tempdir().unwrap();
    let at: Vec<String> = (0..2000).map(|t| t.to_string()).collect();
    let v: Vec<String> = (0..2000).map(|t| format!("{:.4}", 0.5 + 0.4 * (f64::from(t) / 40.0).sin())).collect();
    let data = format!(
        r#"{{"name":"signals","patch":[{{"axis":{{"name":"time","unit":"s"}}}},{{"replace":{{"table":"Signal","ids":{{"count":1}}}}}},{{"append":{{"at":[{}],"table":"Signal","fields":{{"v":[{}]}}}}}}]}}"#,
        at.join(","),
        v.join(",")
    );
    std::fs::write(dir.path().join("signals.json"), data).unwrap();
    let scene = r##"{"space":"plot","ease":0,"marks":[{"lines":{"of":["signals","Signal"],"trace":"v","color":"#ff0000","width":2}}]}"##;
    std::fs::write(dir.path().join("plot.json"), scene).unwrap();
    std::fs::write(dir.path().join("camera.json"), r#"{"x":[100,300],"y":[0,1]}"#).unwrap();
    ok(&run(dir.path(), &["tile", "signals.json", "-o", "tiles", "--chunk", "64"], None));
    for file in ["tiles/frames.json", "tiles/base.latk", "tiles/0/0/0.latk", "tiles/0/1/3.latk"] {
        assert!(dir.path().join(file).is_file(), "{file}");
    }
    assert_eq!(run(dir.path(), &["tile", "signals.json", "-o", "tiles", "--chunk", "12"], None).status.code(), Some(1));
    let render = |source: [&str; 2]| {
        let args = ["render", "plot.json", source[0], source[1], "--camera", "camera.json", "--size", "96x64"];
        run(dir.path(), &[&args[..], &["--format", "rgba", "-o", "-"]].concat(), None)
    };
    let whole = render(["-d", "signals.json"]);
    if no_gpu(&whole) {
        return;
    }
    ok(&whole);
    let tiled = render(["--tiles", "signals=tiles/frames.json"]);
    ok(&tiled);
    let pixels = |o: &Output| o.stdout.as_chunks::<4>().0.to_vec();
    let differing = pixels(&whole).iter().zip(pixels(&tiled)).filter(|(a, b)| a[0].abs_diff(b[0]) > 8).count();
    assert!(differing < 32, "{differing} pixels differ");
    assert!(pixels(&tiled).iter().any(|p| p[0] > 200 && p[1] < 60), "the trace draws");
}

#[test]
fn a_labeled_still_renders_to_a_file_and_to_stdout() {
    let dir = fixture();
    let scene = r#"{"space":"diagram","layout":{"layered":{}},"title":"Grid","marks":[{"vertices":{"of":["grid","Bus"],"label":"name"}}]}"#;
    std::fs::write(dir.path().join("scene.json"), scene).unwrap();
    std::fs::write(dir.path().join("out.png"), b"replace me").unwrap();
    let args = ["render", "scene.json", "-d", "grid.json", "-o", "out.png", "--size", "127x129", "--transparent"];
    let output = run(dir.path(), &args, None);
    if no_gpu(&output) {
        return;
    }
    ok(&output);
    assert_eq!(output.stdout, b"");
    let image = Image::from_png(&std::fs::read(dir.path().join("out.png")).unwrap()).unwrap();
    assert_eq!(image.size, [127, 129]);
    assert!(image.rgba.as_chunks::<4>().0.iter().any(|p| p[3] > 0));
    assert!(image.rgba.as_chunks::<4>().0.iter().any(|p| p[3] == 0));
    let mut args = args.to_vec();
    args[5] = "-";
    let stdout = run(dir.path(), &args, None);
    ok(&stdout);
    assert_eq!(Image::from_png(&stdout.stdout).unwrap(), image);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 4, "no temporary output left behind");
    for (file, starts) in [("out.jpg", &[0xff, 0xd8, 0xff][..]), ("out.webp", &b"RIFF"[..])] {
        args[5] = file;
        ok(&run(dir.path(), &args, None));
        assert!(std::fs::read(dir.path().join(file)).unwrap().starts_with(starts), "{file} is what it says");
    }
}

#[test]
fn panels_draw_a_scene_each() {
    let dir = fixture();
    let plot = r#"{"space":"plot","marks":[]}"#;
    std::fs::write(dir.path().join("plot.json"), plot).unwrap();
    let args = [
        "render",
        "scene.json",
        "plot.json",
        "-d",
        "grid.json",
        "--panel",
        "0,0,0.5,1",
        "--panel",
        "0.5,0,0.5,1",
        "--size",
        "128x64",
        "--format",
        "rgba",
        "-o",
        "-",
    ];
    let output = run(dir.path(), &args, None);
    if no_gpu(&output) {
        return;
    }
    ok(&output);
    assert_eq!(output.stdout.len(), 128 * 64 * 4);
}

#[test]
fn a_frame_stream_writes_every_output_and_holds_still_frames() {
    let dir = fixture();
    // The third frame changes nothing: it is held, and a raw stream repeats the second.
    frames(dir.path(), &[[-4.0, 4.0], [0.0, 8.0], [0.0, 8.0]]);
    let mut args = COMMON.to_vec();
    args.extend(["--format", "rgba", "-o", "-"]);
    let output = run(dir.path(), &args, None);
    if no_gpu(&output) {
        return;
    }
    ok(&output);
    let frame = 64 * 64 * 4;
    assert_eq!(output.stdout.len(), frame * 3);
    let [first, second, third] = [0, 1, 2].map(|i| &output.stdout[i * frame..(i + 1) * frame]);
    assert_ne!(first, second);
    assert_eq!(second, third);

    // A sequence never truncates itself into one PNG, nor destroys an old file.
    std::fs::write(dir.path().join("out.png"), b"keep").unwrap();
    let mut args = COMMON.to_vec();
    args.extend(["-o", "out.png"]);
    assert_eq!(run(dir.path(), &args, None).status.code(), Some(1));
    assert_eq!(std::fs::read(dir.path().join("out.png")).unwrap(), b"keep");

    let mut args = COMMON.to_vec();
    args.extend(["-o", "pngs/frame-%03d.png"]);
    std::fs::create_dir(dir.path().join("pngs")).unwrap();
    ok(&run(dir.path(), &args, None));
    let names: Vec<String> = std::fs::read_dir(dir.path().join("pngs"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(names.len(), 3, "{names:?}");
    let png =
        |n: u32| Image::from_png(&std::fs::read(dir.path().join(format!("pngs/frame-{n:03}.png"))).unwrap()).unwrap();
    assert_eq!(&png(0).rgba[..], first);
    assert_eq!(png(1), png(2));

    let mut args = COMMON.to_vec();
    args.extend(["-o", "out.y4m"]);
    ok(&run(dir.path(), &args, None));
    let y4m = std::fs::read(dir.path().join("out.y4m")).unwrap();
    let header = b"YUV4MPEG2 W64 H64 F60:1 Ip A1:1 C420jpeg XCOLORRANGE=LIMITED\n";
    assert!(y4m.starts_with(header));
    assert_eq!(y4m.len(), header.len() + 3 * (6 + 64 * 64 * 3 / 2));

    #[cfg(windows)]
    {
        let mut args = COMMON.to_vec();
        args.extend(["-o", "out.mp4"]);
        ok(&run(dir.path(), &args, None));
        let mp4 = std::fs::read(dir.path().join("out.mp4")).unwrap();
        assert_eq!(&mp4[4..8], b"ftyp");
        assert!(mp4.windows(4).any(|w| w == b"moov") && mp4.windows(4).any(|w| w == b"moof"));
        let absent = "{\"at\":0}\n{\"at\":0,\"patch\":{\"absent\":[]}}";
        std::fs::write(dir.path().join("sequence/frames.jsonl"), absent).unwrap();
        assert_eq!(run(dir.path(), &args, None).status.code(), Some(1));
        assert_eq!(std::fs::read(dir.path().join("out.mp4")).unwrap(), mp4, "a failed video keeps the file before");
    }
}
