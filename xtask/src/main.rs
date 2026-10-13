//! Repository tasks, run as `cargo xtask <task>`.
//!
//! - `check`: format, lint every feature set and target, test, and document.
//! - `wasm`: build `latkit-js`, bind it with the `wasm-bindgen` CLI matching `Cargo.lock`, optimize it
//!   with `wasm-opt` when installed, and compile the npm wrapper.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let task = std::env::args().nth(1).unwrap_or_default();
    let result = match task.as_str() {
        "check" => check(),
        "wasm" => wasm(),
        _ => {
            eprintln!("usage: cargo xtask <check|wasm>");
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
    npx(&["--yes", "tsc", "-p", "npm/test"])
}

fn wasm() -> Result {
    cargo(&["build", "-p", "latkit-js", "--profile", "wasm", "--target", "wasm32-unknown-unknown"])?;
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
    let wasm = "target/wasm32-unknown-unknown/wasm/latkit_js.wasm";
    run("wasm-bindgen", &[wasm, "--target", "web", "--out-dir", "npm/pkg", "--out-name", "latkit"])?;
    let optimized = "npm/pkg/latkit_bg.wasm";
    if Command::new("wasm-opt").arg("--version").output().is_ok() {
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
