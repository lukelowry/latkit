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
//!   optimize it with `wasm-opt` when installed, and compile the npm wrapper. `--dev` builds faster
//!   and skips `wasm-opt`.
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
        "examples" => wasm(true).and_then(|()| pnpm(&["--dir", "npm/examples", "exec", "vite"])),
        _ => {
            eprintln!("usage: cargo xtask <check|browser|bench|wasm [--dev]|examples>");
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

fn npx(args: &[&str]) -> Result {
    run(if cfg!(windows) { "npx.cmd" } else { "npx" }, args)
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
    npx(&["--yes", "tsc", "-p", "npm/test"])?;
    pnpm(&["--dir", "npm/examples", "exec", "tsc", "--noEmit"])?;
    pnpm(&["--dir", "npm/examples", "exec", "tsc", "-p", "gate"])?;
    browser()
}

/// Builds the package for the browser, then runs the gate over the shaders the build linked.
fn browser() -> Result {
    let shaders = shaders_dir()?;
    wasm(true)?;
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
    let profile = if dev { "wasm-dev" } else { "wasm" };
    cargo(&["build", "-p", "latkit-js", "--profile", profile, "--target", "wasm32-unknown-unknown"])?;
    let lock = std::fs::read_to_string(root().join("Cargo.lock")).map_err(|e| format!("Cargo.lock: {e}"))?;
    let version = locked_version(&lock, "wasm-bindgen").ok_or("wasm-bindgen is not in Cargo.lock")?;
    let installed = Command::new("wasm-bindgen").arg("--version").output().ok();
    let installed = installed.and_then(|o| String::from_utf8(o.stdout).ok()).unwrap_or_default();
    if !installed.contains(&version) {
        return Err(format!(
            "wasm-bindgen CLI {version} is required (found {:?}); run `cargo install wasm-bindgen-cli --version {version}`",
            installed.trim()
        ));
    }
    let wasm = format!("target/wasm32-unknown-unknown/{profile}/latkit_js.wasm");
    let bind = [wasm.as_str(), "--target", "web", "--weak-refs", "--out-dir", "npm/pkg", "--out-name", "latkit"];
    run("wasm-bindgen", &bind)?;
    let optimized = "npm/pkg/latkit_bg.wasm";
    if dev {
        eprintln!("--dev: the wasm is not size-optimized");
    } else if Command::new("wasm-opt").arg("--version").output().is_ok() {
        run(
            "wasm-opt",
            &["-Oz", "--enable-simd", "--enable-bulk-memory", "--enable-reference-types", optimized, "-o", optimized],
        )?;
    } else {
        eprintln!("wasm-opt not found: the wasm is not size-optimized");
    }
    npx(&["--yes", "tsc", "-p", "npm"])
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
