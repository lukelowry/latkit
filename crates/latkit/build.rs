//! Build script: generates Rust mirrors of the WESL shaders' types and bind layouts, and
//! precomputes the colormap catalog.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=build");
    println!("cargo::rerun-if-changed=shaders");
    println!("cargo::rerun-if-changed=src/gpu/specialize.rs");
    println!("cargo::rerun-if-changed=src/gpu/prune.rs");
    println!("cargo::rerun-if-changed=src/gpu/glsl.rs");
    println!("cargo::rerun-if-changed=src/expr/ramp.rs");
    // Translating shaders recurses deeply, deeper still when this script is built unoptimized, and
    // a main thread's stack can be as small as 1 MiB. Run it on a thread with room to spare.
    #[cfg(feature = "gpu")]
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(shaders::generate)
        .expect("a thread for the shaders")
        .join()
        .expect("the shaders are generated");
    colormaps::generate();
}

#[cfg(feature = "gpu")]
#[path = "build/shaders.rs"]
mod shaders;

#[cfg(feature = "gpu")]
#[path = "src/gpu/specialize.rs"]
mod specialize;

#[cfg(feature = "gpu")]
#[path = "src/gpu/prune.rs"]
mod prune;

#[cfg(feature = "gpu")]
#[path = "src/gpu/glsl.rs"]
mod glsl;

#[path = "build/colormaps.rs"]
mod colormaps;

#[path = "src/expr/ramp.rs"]
#[allow(dead_code, reason = "the build bakes only the catalog's texels")]
mod ramp;
