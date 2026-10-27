//! Repository tasks, run as `cargo xtask <task>`.
//!
//! - `check`: every CI job's steps (`ci <job>`), in CI's order. Locally, the crates package with
//!   uncommitted work, and the browser gate judges frame budgets on the GPU.
//! - `ci <job>`: the steps of one job of `.github/workflows/ci.yml`, which runs each job this way:
//!   - `format`: Prettier over every file. CI's `format` job has no Rust toolchain, so it runs
//!     `pnpm format:check` itself.
//!   - `rust`: formats, lints, tests (with GPU tests required), documents, and packages the crates,
//!     and checks that `native` stays out of browser builds.
//!   - `native-cli`: tests the CLI's native code, which CI runs on macOS and Windows.
//!   - `npm`: builds the npm package with `wasm --dev`, then lints, documents, type-checks, and
//!     tests it. Runs the browser gate over that build, then `package` and `package-test`.
//! - `browser`: the browser gate (`npm/examples/gate/gate.ts`) over a fresh `wasm --dev`. Checks
//!   that every shader variant's pipelines compile in Chrome within budget, and that every example
//!   page draws and responds to the pointer without errors or stalls. On `SwiftShader`, which Linux
//!   always uses, checks only that every pipeline compiles, since pages and times need a GPU.
//! - `bench [--quick] [--only a,b] [--repeats n] [--update] [--software]`: the benchmark
//!   (`benchmark/`) over a release `wasm`. Runs every scenario at increasing sizes in Chrome while
//!   the last size stays within budget. Measures each phase's time, GPU time, stalls, and exact
//!   work, and judges them against their allowed growth with size, the committed work, and this
//!   machine's times. A lost device stops the sweep. `--quick` runs each scenario once at its
//!   smallest size. See `benchmark/run.ts`.
//! - `wasm [--dev]`: builds `latkit-js`, binds it with the `wasm-bindgen` CLI version in
//!   `Cargo.lock`, and compiles the npm wrapper. `--dev` builds faster, without link-time
//!   optimization.
//! - `bindgen-version`: prints the `wasm-bindgen` version in `Cargo.lock`. CI installs that version
//!   of the CLI.
//! - `version`: sets the crates' version to the npm package's, as changesets set it.
//! - `package`: builds an isolated, optimized npm tarball, the one `pnpm release` publishes, and
//!   reports its sizes and hashes.
//! - `package-test`: installs the latest tarball into a consumer and verifies it in Chrome.
//! - `release`: runs `npm/release.mjs`, which verifies or publishes each artifact, then tags the
//!   release.
//! - `examples [--open]`: `wasm --dev`, then serves the example suite at <http://127.0.0.1:5200>.
//!   `--open` opens it in the browser once it is ready.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

fn main() -> ExitCode {
    let task = std::env::args().nth(1).unwrap_or_default();
    let dev = std::env::args().any(|a| a == "--dev");
    let result = match task.as_str() {
        "check" => check(),
        "ci" => ci(&std::env::args().nth(2).unwrap_or_default()),
        "browser" => browser(),
        "bench" => wasm(false).and_then(|()| {
            let flags: Vec<String> = std::env::args().skip(2).collect();
            let mut args = vec!["benchmark/run.ts"];
            args.extend(flags.iter().map(String::as_str));
            run("node", &args)
        }),
        "wasm" => wasm(dev),
        "bindgen-version" => bindgen_version().map(|version| println!("{version}")),
        "version" => version(),
        "package" => package(),
        "package-test" => package_test(),
        "release" => run("node", &["npm/release.mjs"]),
        "examples" => wasm(true).and_then(|()| {
            let mut vite = vec!["--dir", "npm/examples", "exec", "vite"];
            if std::env::args().any(|a| a == "--open") {
                vite.push("--open");
            }
            pnpm(&vite)
        }),
        _ => {
            eprintln!(
                "usage: cargo xtask <check|ci <job>|browser|bench [flags]|wasm [--dev]|bindgen-version|version|package|package-test|release|examples [--open]>"
            );
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
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("xtask is in the workspace root").to_path_buf()
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

/// The jobs of `.github/workflows/ci.yml` that `ci` runs the steps of, in its order.
const JOBS: [&str; 4] = ["format", "rust", "native-cli", "npm"];

/// Runs every CI job's steps in CI's order.
fn check() -> Result {
    for job in JOBS {
        ci(job)?;
    }
    Ok(())
}

/// Runs the steps of CI job `job`.
fn ci(job: &str) -> Result {
    match job {
        "format" => pnpm(&["format:check"]),
        "rust" => rust(),
        "native-cli" => native_cli(),
        "npm" => npm(),
        _ => Err(format!("no CI job {job:?}; the jobs are {}", JOBS.join(", "))),
    }
}

fn rust() -> Result {
    let gpu = [("LATKIT_REQUIRE_GPU", "1")];
    cargo(&["fmt", "--all", "--check"])?;
    cargo(&["clippy", "--locked", "--workspace", "--all-targets", "--all-features", "--", "-D", "warnings"])?;
    cargo(&["clippy", "--locked", "-p", "latkit", "--no-default-features", "--all-targets", "--", "-D", "warnings"])?;
    cargo(&["clippy", "--locked", "-p", "latkit-js", "--target", "wasm32-unknown-unknown", "--", "-D", "warnings"])?;
    run_with(env!("CARGO"), &["test", "--locked", "--workspace"], &gpu)?;
    run_with(env!("CARGO"), &["test", "--locked", "-p", "latkit", "--no-default-features"], &gpu)?;
    run_with(
        env!("CARGO"),
        &["doc", "--locked", "-p", "latkit", "--no-deps", "--all-features"],
        &[("RUSTDOCFLAGS", "-D warnings")],
    )?;
    let package = |target: &[&str]| {
        let mut args = vec!["package", "--locked"];
        // CI's tree is clean. Locally, package uncommitted work as is.
        if std::env::var_os("CI").is_none() {
            args.push("--allow-dirty");
        }
        args.extend(["-p", "latkit"]);
        args.extend(target);
        cargo(&args)
    };
    package(&[])?;
    package(&["--target", "wasm32-unknown-unknown", "--features", "web"])?;
    cargo(&["check", "--locked", "-p", "latkit", "--target", "wasm32-unknown-unknown", "--features", "native,web"])
}

fn native_cli() -> Result {
    cargo(&["test", "--locked", "--package", "latkit", "--features", "native", "--lib", "--test", "validation"])?;
    cargo(&["test", "--locked", "--package", "latkit-cli"])
}

fn npm() -> Result {
    wasm(true)?;
    pnpm(&["lint"])?;
    run("node", &["npm/docs.mjs", "--check"])?;
    pnpm(&["typecheck"])?;
    pnpm(&["test"])?;
    browser_gate()?;
    package()?;
    package_test()
}

/// Builds the wasm package, then runs the browser gate over the shaders the build linked.
fn browser() -> Result {
    wasm(true)?;
    browser_gate()
}

fn browser_gate() -> Result {
    let shaders = shaders_dir()?;
    run("node", &["npm/examples/gate/gate.ts", &shaders])
}

/// The directory where `latkit`'s build script wrote the linked shaders and `shaders.json`.
fn shaders_dir() -> Result<String> {
    eprintln!("$ cargo check --locked -p latkit --message-format=json-render-diagnostics");
    let output = Command::new(env!("CARGO"))
        .args(["check", "--locked", "-p", "latkit", "--message-format=json-render-diagnostics"])
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
    let version = bindgen_version()?;
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
    // Creates an isolated consumer and adds its path to the package report for the browser runner.
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
    run("node", &["npm/examples/gate/package.ts"])?;
    run("node", &["npm/build.mjs", "verified"])
}

/// Sets the crates' version to the npm package's, which changesets sets, so everything released
/// together shares one version.
fn version() -> Result {
    let manifest = std::fs::read_to_string(root().join("npm/package.json")).map_err(|e| format!("npm: {e}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest).map_err(|e| format!("npm: {e}"))?;
    let version = manifest["version"].as_str().ok_or("npm/package.json has no version")?;
    let path = root().join("Cargo.toml");
    let toml = std::fs::read_to_string(&path).map_err(|e| format!("Cargo.toml: {e}"))?;
    let mut manifest = toml.parse::<toml_edit::DocumentMut>().map_err(|e| format!("Cargo.toml: {e}"))?;
    manifest["workspace"]["package"]["version"] = toml_edit::value(version);
    manifest["workspace"]["dependencies"]["latkit"]["version"] = toml_edit::value(version);
    std::fs::write(&path, manifest.to_string()).map_err(|e| format!("Cargo.toml: {e}"))?;
    cargo(&["update", "--workspace", "--offline"])
}

/// The `wasm-bindgen` version in `Cargo.lock`, which the `wasm-bindgen` CLI must match.
fn bindgen_version() -> Result<String> {
    let lock = std::fs::read_to_string(root().join("Cargo.lock")).map_err(|e| format!("Cargo.lock: {e}"))?;
    locked_version(&lock, "wasm-bindgen").ok_or_else(|| "wasm-bindgen is not in Cargo.lock".to_owned())
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
