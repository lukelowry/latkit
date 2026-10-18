# Native CLI gallery

These 1600 × 1000 PNGs are rendered by the installed `latkit` CLI. Every mark and caption is
drawn by latkit; the images have no postprocessing. The synthetic data is generated locally,
with no downloaded assets or bundled fonts.

## Helios

480 substations and 896 connections, with flowing edges, data-driven colors, and native labels.

![Helios transmission network](helios.png)

## Interference

33,600 particles colored and sized by the interaction of two radial waves.

![Particle interference field](interference.png)

## Tidal forms

100 closed contours containing 48,100 coordinates, with harmonic deformations and a continuous palette.

![Tidal contour artwork](tides.png)

## Reproduce

From the repository root:

```sh
cargo install --path crates/latkit-cli --locked --profile cli
cargo run --locked -p latkit-cli --example gallery -- examples/cli-gallery
```

The [generator](../../crates/latkit-cli/examples/gallery.rs) writes the scene JSON, binary datasets,
and PNGs here. It uses `Data::to_bytes()` and validates each scene with the Rust API, then invokes
the installed executable for rendering. It adds no dependencies to the CLI.

Render or edit one existing scene independently:

```sh
latkit validate examples/cli-gallery/helios.json --data examples/cli-gallery/helios.bin
latkit render examples/cli-gallery/helios.json --data examples/cli-gallery/helios.bin --output examples/cli-gallery/helios.png --width 1600 --height 1000 --elapsed 1.25
```

`LATKIT_BIN` selects a different executable for the generator. `LATKIT_FONT` selects a font file;
without it, the CLI discovers system fonts. These included renders use Windows Segoe UI
(`C:/Windows/Fonts/segoeui.ttf`). For direct CLI calls, the equivalent option is `--font FILE`.
Text can differ across systems unless the same font is supplied. No font file is redistributed here.

The `.bin` files are normal latkit datasets, not executable code. Keeping them beside the scene
JSON lets you reproduce the images with only the CLI, without compiling the generator.
