//! Generates the Rust side of the GPU contract from the WESL shaders, and bakes the colormap catalog.

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=build");
    println!("cargo::rerun-if-changed=shaders");
    #[cfg(feature = "gpu")]
    {
        shaders::generate();
        colormaps::generate();
    }
}

#[cfg(feature = "gpu")]
#[path = "build/shaders.rs"]
mod shaders;

#[cfg(feature = "gpu")]
#[path = "build/colormaps.rs"]
mod colormaps;
