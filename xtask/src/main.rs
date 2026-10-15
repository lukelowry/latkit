//! Repository tasks, run as `cargo xtask <task>`.
//!
//! - `check`: format, lint every feature set and target, test, document, type-check the npm
//!   package, its examples, and the gate, then run the browser gate.
//! - `browser`: the browser gate (`npm/examples/gate/gate.ts`) over a fresh `wasm --dev`: every
//!   shader variant's pipelines compile in Chrome within budget, and every example page draws and
//!   answers the pointer without errors or stalls.
//! - `bench`: the quick benchmark (`npm/examples/gate/bench.ts`) over a release `wasm`: the network
//!   page's grids, from 240 buses to two million, each held to budgets for loading, the frame's CPU
//!   and GPU time while the camera moves, and frames drawn while it does not.
//! - `wasm [--dev]`: build `latkit-js`, bind it with the `wasm-bindgen` CLI matching `Cargo.lock`,
//!   optimize it with the pinned Binaryen tool, and compile the npm wrapper. `--dev` builds faster
//!   and skips `wasm-opt`.
//! - `package`: build an isolated, optimized npm tarball and report its sizes and hashes.
//! - `package-test`: install the latest tarball into a consumer and verify it in Chrome.
//! - `examples`: `wasm --dev`, then serve the example suite at <http://127.0.0.1:5200>.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

fn main() -> ExitCode {
    let task = std::env::args().nth(1).unwrap_or_default();
    let dev = std::env::args().any(|a| a == "--dev");
    let result = match task.as_str() {
        "check" => check(),
        "browser" => browser(),
        "bench" => wasm(false).and_then(|()| run("node", &["npm/examples/gate/bench.ts"])),
        "wasm" => wasm(dev),
        "package" => package(),
        "package-test" => package_test(),
        "examples" => wasm(true).and_then(|()| pnpm(&["--dir", "npm/examples", "exec", "vite"])),
        _ => {
            eprintln!("usage: cargo xtask <check|browser|bench|wasm [--dev]|package|package-test|examples>");
            return ExitCode::FAILURE;
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask {task}: {error}");
            ExitCode::FAILURE
        }
    }
}

type Result<T = ()> = std::result::Result<T, String>;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("xtask sits in the workspace root").to_path_buf()
}

fn run(program: &str, args: &[&str]) -> Result {
    run_with(program, args, &[])
}

fn run_with(program: &str, args: &[&str], env: &[(&str, &str)]) -> Result {
    eprintln!("$ {program} {}", args.join(" "));
    let mut command = Command::new(program);
    command.args(args).current_dir(root()).envs(env.iter().copied());
    let status = command.status().map_err(|e| format!("{program}: {e}"))?;
    if status.success() { Ok(()) } else { Err(format!("{program} exited with {status}")) }
}

fn cargo(args: &[&str]) -> Result {
    run(env!("CARGO"), args)
}

fn pnpm(args: &[&str]) -> Result {
    run(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" }, args)
}

fn check() -> Result {
    cargo(&["fmt", "--all", "--check"])?;
    cargo(&["clippy", "-p", "latkit", "--no-default-features", "--all-targets", "--", "-D", "warnings"])?;
    cargo(&["clippy", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"])?;
    cargo(&["clippy", "-p", "latkit-js", "--target", "wasm32-unknown-unknown", "--", "-D", "warnings"])?;
    cargo(&["test", "--workspace", "--all-features"])?;
    cargo(&["test", "-p", "latkit", "--no-default-features"])?;
    run_with(
        env!("CARGO"),
        &["doc", "-p", "latkit", "--no-deps", "--all-features"],
        &[("RUSTDOCFLAGS", "-D warnings")],
    )?;
    wasm(true)?;
    pnpm(&["exec", "tsc", "-p", "npm/test"])?;
    pnpm(&["--dir", "npm/examples", "exec", "tsc", "--noEmit"])?;
    pnpm(&["--dir", "npm/examples", "exec", "tsc", "-p", "gate"])?;
    browser_gate()
}

/// Builds the package for the browser, then runs the gate over the shaders the build linked.
fn browser() -> Result {
    wasm(true)?;
    browser_gate()
}

fn browser_gate() -> Result {
    let shaders = shaders_dir()?;
    run("node", &["npm/examples/gate/gate.ts", &shaders])
}

/// The directory `latkit`'s build script wrote the linked shaders and `shaders.json` to.
fn shaders_dir() -> Result<String> {
    eprintln!("$ cargo check -p latkit --message-format=json");
    let output = Command::new(env!("CARGO"))
        .args(["check", "-p", "latkit", "--message-format=json"])
        .current_dir(root())
        .stderr(Stdio::inherit())
        .output()
        .map_err(|e| format!("cargo: {e}"))?;
    if !output.status.success() {
        return Err(format!("cargo check exited with {}", output.status));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|message| {
            message["reason"] == "build-script-executed"
                && message["package_id"].as_str().is_some_and(|id| id.contains("/crates/latkit#"))
        })
        .and_then(|message| message["out_dir"].as_str().map(str::to_owned))
        .ok_or_else(|| "cargo did not report latkit's build output".to_owned())
}

fn wasm(dev: bool) -> Result {
    build_wasm(dev, "npm")
}

fn build_wasm(dev: bool, output: &str) -> Result {
    let profile = if dev { "wasm-dev" } else { "wasm" };
    cargo(&["build", "--locked", "-p", "latkit-js", "--profile", profile, "--target", "wasm32-unknown-unknown"])?;
    let lock = std::fs::read_to_string(root().join("Cargo.lock")).map_err(|e| format!("Cargo.lock: {e}"))?;
    let version = locked_version(&lock, "wasm-bindgen").ok_or("wasm-bindgen is not in Cargo.lock")?;
    let installed = Command::new("wasm-bindgen").arg("--version").output().ok();
    let installed = installed.and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
    if installed.split_whitespace().nth(1) != Some(version.as_str()) {
        return Err(format!(
            "wasm-bindgen CLI {version} is required (found {:?}); run `cargo install wasm-bindgen-cli --version {version}`",
            installed.trim()
        ));
    }
    let wasm = format!("target/wasm32-unknown-unknown/{profile}/latkit_js.wasm");
    let pkg = format!("{output}/pkg");
    let bind = [wasm.as_str(), "--target", "web", "--weak-refs", "--out-dir", &pkg, "--out-name", "latkit"];
    run("wasm-bindgen", &bind)?;
    let optimized = format!("{pkg}/latkit_bg.wasm");
    if dev {
        eprintln!("--dev: the wasm is not size-optimized");
    } else {
        run("node", &["npm/build.mjs", "optimize", &optimized])?;
    }
    run("node", &["npm/build.mjs", "compile", output])
}

fn package() -> Result {
    let stamp =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let stage = format!("target/npm/stage-{stamp}");
    run("node", &["npm/build.mjs", "prepare", &stage, env!("CARGO_PKG_VERSION")])?;
    build_wasm(false, &stage)?;
    run(
        if cfg!(windows) { "npm.cmd" } else { "npm" },
        &["pack", &format!("./{stage}"), "--ignore-scripts", "--pack-destination", "target/npm"],
    )?;
    run("node", &["npm/build.mjs", "report", &stage])
}

fn package_test() -> Result {
    // Preparation prints the isolated consumer path into a stable manifest for the browser runner.
    run("node", &["npm/build.mjs", "consumer"])?;
    let report = std::fs::read_to_string(root().join("target/npm/package.json")).map_err(|e| e.to_string())?;
    let report: serde_json::Value = serde_json::from_str(&report).map_err(|e| e.to_string())?;
    let tarball = report["tarball"].as_str().ok_or("package report has no tarball")?;
    let consumer = report["consumer"].as_str().ok_or("package report has no consumer")?;
    run(
        if cfg!(windows) { "npm.cmd" } else { "npm" },
        &[
            "install",
            "--prefix",
            consumer,
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--offline",
            tarball,
        ],
    )?;
    run("node", &["npm/examples/gate/package.ts"])
}

/// The version of `package` in a `Cargo.lock`.
fn locked_version(lock: &str, package: &str) -> Option<String> {
    let mut lines = lock.lines();
    while let Some(line) = lines.next() {
        if line == format!("name = \"{package}\"") {
            let version = lines.next()?.strip_prefix("version = \"")?.strip_suffix('"')?;
            return Some(version.to_owned());
        }
    }
    None
}
