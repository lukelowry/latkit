//! Build script: generates Rust mirrors of the WESL shaders' types and bind layouts, and
//! precomputes the colormap catalog.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=build");
    println!("cargo::rerun-if-changed=shaders");
    println!("cargo::rerun-if-changed=src/expr/ramp.rs");
    #[cfg(feature = "gpu")]
    {
        shaders::generate();
    }
    colormaps::generate();
}

#[cfg(feature = "gpu")]
#[path = "build/shaders.rs"]
mod shaders;

#[path = "build/colormaps.rs"]
mod colormaps;

#[path = "src/expr/ramp.rs"]
#[allow(dead_code, reason = "the build bakes only the catalog's texels")]
mod ramp;
