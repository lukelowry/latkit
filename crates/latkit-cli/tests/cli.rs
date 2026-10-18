//! Exercise the executable's real file, pipe, diagnostic, and exit-code contracts.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use latkit::{Data, Image, Table};

const SCENE: &str = r#"{"space":"plane","marks":[{"vertices":{"of":["grid","Bus"],"position":["x","y"]}}]}"#;

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
    let mut data = Data::new("grid");
    data.apply(
        Table::new("Bus", 2)
            .field("x", vec![-10.0, 10.0])
            .field("y", vec![0.0, 0.0])
            .field("name", vec!["Alpha", "Beta"]),
    )
    .unwrap();
    std::fs::write(dir.path().join("scene.json"), SCENE).unwrap();
    std::fs::write(dir.path().join("grid.bin"), data.to_bytes()).unwrap();
    dir
}

#[test]
fn help_and_argument_errors_do_not_require_input_or_a_gpu() {
    let dir = tempfile::tempdir().unwrap();
    let help = run(dir.path(), &["render", "--help"], None);
    assert!(help.status.success());
    assert!(String::from_utf8(help.stdout).unwrap().contains("--elapsed"));
    for options in [
        vec![],
        vec!["--width", "0"],
        vec!["--pixel-ratio", "NaN"],
        vec!["--at", "inf"],
        vec!["--elapsed", "1e100"],
        vec!["--timeout", "0"],
    ] {
        let mut args = vec!["render", "missing.json"];
        if !options.is_empty() {
            args.extend(["-o", "out.png"]);
        }
        args.extend(options);
        assert_eq!(run(dir.path(), &args, None).status.code(), Some(2));
    }
    assert_eq!(run(dir.path(), &["validate", "-", "-d", "-"], None).status.code(), Some(2));
    assert_eq!(run(dir.path(), &["render", "missing", "-o", "out.jpg"], None).status.code(), Some(2));
}

#[test]
fn validation_accepts_scene_or_dataset_stdin_and_is_silent_on_success() {
    let dir = fixture();
    let bytes = std::fs::read(dir.path().join("grid.bin")).unwrap();
    for (args, stdin) in [
        (vec!["validate", "scene.json", "-d", "grid.bin"], None),
        (vec!["validate", "-", "-d", "grid.bin"], Some(SCENE.as_bytes())),
        (vec!["validate", "scene.json", "-d", "-"], Some(bytes.as_slice())),
    ] {
        let output = run(dir.path(), &args, stdin);
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout, [] as [u8; 0]);
        assert_eq!(output.stderr, [] as [u8; 0]);
    }
}

#[test]
fn failures_have_structured_paths_and_preserve_existing_output() {
    let dir = fixture();
    let output = run(dir.path(), &["--diagnostics", "json", "validate", "scene.json"], None);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(output.stdout, [] as [u8; 0]);
    let error: serde_json::Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["code"], "invalid");
    assert_eq!(error["path"], serde_json::json!(["marks", 0, "data"]));
    assert_eq!(error["source"], "scene.json");
    let output = run(dir.path(), &["validate", "scene.json", "-d", "grid.bin", "-d", "grid.bin"], None);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("duplicate"));
    std::fs::write(dir.path().join("out.png"), b"keep this").unwrap();
    let output = run(dir.path(), &["render", "scene.json", "-o", "out.png"], None);
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(std::fs::read(dir.path().join("out.png")).unwrap(), b"keep this");
    let invalid = run(dir.path(), &["validate", "-"], Some(br#"{"space":"plane","ease":1e100}"#));
    assert_eq!(invalid.status.code(), Some(1));
}

#[test]
fn labeled_png_renders_to_a_file_and_binary_stdout() {
    let dir = fixture();
    let scene =
        r#"{"space":"diagram","layout":{"layered":{}},"marks":[{"vertices":{"of":["grid","Bus"],"label":"name"}}]}"#;
    std::fs::write(dir.path().join("scene.json"), scene).unwrap();
    std::fs::write(dir.path().join("out.png"), b"replace me").unwrap();
    let output = run(
        dir.path(),
        &[
            "render",
            "scene.json",
            "-d",
            "grid.bin",
            "-o",
            "out.png",
            "--width",
            "127",
            "--height",
            "129",
            "--transparent",
        ],
        None,
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() && (stderr.contains("no GPU adapter") || stderr.contains("no GPU device")) {
        assert!(std::env::var_os("LATKIT_REQUIRE_GPU").is_none(), "GPU required: {stderr}");
        eprintln!("skipping native CLI GPU test: {stderr}");
        return;
    }
    assert!(output.status.success(), "{stderr}");
    assert_eq!(output.stdout, [] as [u8; 0]);
    let image = Image::from_png(&std::fs::read(dir.path().join("out.png")).unwrap()).unwrap();
    assert_eq!(image.size, [127, 129]);
    assert!(image.rgba.as_chunks::<4>().0.iter().any(|pixel| pixel[3] > 0));
    assert!(image.rgba.as_chunks::<4>().0.iter().any(|pixel| pixel[3] == 0));
    let stdout = run(
        dir.path(),
        &["render", "scene.json", "-d", "grid.bin", "-o", "-", "--width", "127", "--height", "129", "--transparent"],
        None,
    );
    assert!(stdout.status.success(), "{}", String::from_utf8_lossy(&stdout.stderr));
    assert_eq!(Image::from_png(&stdout.stdout).unwrap(), image);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 3, "no temporary output left behind");
}
