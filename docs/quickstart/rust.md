# Rust

Draw the six-bus network and save it as a looping PNG. Each frame advances the comets by 50 milliseconds.

```{image} ../images/six-bus-flow.png
:alt: Six buses joined by seven lines. Gold comets travel from bus A through the network toward bus F.
:class: picture
```

With Rust 1.99 or newer, create a project.

```sh
cargo new six-bus
cd six-bus
cargo add latkit --features native
cargo add pollster png
```

Replace `src/main.rs` with this code.

```{code-block} rust
use latkit::{field, Color, Data, Edges, Fit, Gpu, Grid, Ids, Label, Plane, Scene, Shot, Table, Theme, Vertices, View};
use std::{fs::File, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let grid = Data::new("grid");
    grid.apply(Table::new("Bus", Ids::count(6))
        .field("name", vec!["A", "B", "C", "D", "E", "F"])
        .field("x", vec![-160., -65., -65., 65., 65., 160.])
        .field("y", vec![0., 58., -58., 58., -58., 0.]))?;
    grid.apply(Table::new("Line", Ids::count(7))
        .reference("from", "Bus", vec![0_u64, 0, 1, 2, 2, 3, 4])
        .reference("to", "Bus", vec![1_u64, 2, 3, 3, 4, 5, 5]))?;

    let mut theme = Theme::dark();
    theme.flow.color = Color::hex("#ffce8b").unwrap();
    theme.flow.width = 7.0_f32.into();
    let scene = Scene::new(Plane { grid: Grid::Off, ..Plane::default() }).theme(theme)
        .draw(Edges::of("grid", "Line").ends("from", "to")
            .color(Color::hex("#527589").unwrap()).width(2.).flow(64.))
        .draw(Vertices::of("grid", "Bus").position(field("x"), field("y"))
            .color(Color::hex("#65d6bb").unwrap()).radius(8.).label(Label::new(field("name"))));
    let gpu = pollster::block_on(Gpu::new())?;
    gpu.set_host(latkit::host::Native::new());
    let mut view = View::new(&gpu, scene);
    view.set_sources([grid])?;
    view.fit(Fit::All);

    let mut png = png::Encoder::new(File::create("network.png")?, 720, 360);
    png.set_color(png::ColorType::Rgba);
    png.set_animated(20, 0)?;
    png.set_frame_delay(1, 20)?;
    let mut writer = png.write_header()?;
    for frame in 0..20 {
        let shot = Shot::new([720, 360]).elapsed(Duration::from_millis(frame * 50));
        let image = pollster::block_on(shot.image(&mut [&mut view]))?;
        writer.write_image_data(&image.rgba)?;
    }
    writer.finish()?;
    Ok(())
}
```

```sh
cargo run
```

Open `network.png` in a browser to see the comets move.
