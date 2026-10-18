//! Reproducible data and scenes, rendered by the installed `latkit` executable.
//!
//! `cargo run --locked -p latkit-cli --example gallery -- examples/cli-gallery`
//! Set `LATKIT_BIN` to select an executable, and `LATKIT_FONT` to use an explicit font file.

use std::{f64::consts::TAU, fs, path::Path, process::Command};

use latkit::{Data, Scene, Table};
use serde_json::{Value, json};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() -> Result<()> {
    let destination = std::env::args_os().nth(1).unwrap_or_else(|| "examples/cli-gallery".into());
    let destination = Path::new(&destination);
    fs::create_dir_all(destination)?;
    for (name, mut data, mut scene, title, subtitle) in [helios()?, interference()?, tides()?] {
        caption(&mut data, &mut scene, title, subtitle)?;
        let decoded: Scene = serde_json::from_value(scene.clone())?;
        decoded.validate(std::slice::from_ref(&data))?;
        let scene_path = destination.join(format!("{name}.json"));
        let data_path = destination.join(format!("{name}.bin"));
        let image_path = destination.join(format!("{name}.png"));
        fs::write(&scene_path, format!("{}\n", serde_json::to_string_pretty(&scene)?))?;
        fs::write(&data_path, data.to_bytes())?;
        let executable = std::env::var_os("LATKIT_BIN").unwrap_or_else(|| "latkit".into());
        let mut command = Command::new(executable);
        command.arg("render").arg(&scene_path).arg("--data").arg(&data_path).arg("--output").arg(&image_path);
        command.args(["--width", "1600", "--height", "1000", "--elapsed", "1.25"]);
        if let Some(font) = std::env::var_os("LATKIT_FONT") {
            command.arg("--font").arg(font);
        }
        if !command.status()?.success() {
            return Err(format!("rendering {} failed", image_path.display()).into());
        }
        println!("{}", image_path.display());
    }
    Ok(())
}

type Artwork = (&'static str, Data, Value, &'static str, &'static str);

fn scene(marks: Value) -> Value {
    let mut scene = json!({
        "space": {"plane": {"grid": "off"}}, "ease": 0,
        "theme": {"background": "#080f1c", "text": "#c7d5e4", "font": "sans-serif",
            "halo": 0, "flow": "#d9fff0a0", "flowSpacing": 100}
    });
    scene["marks"] = marks;
    scene
}

fn caption(data: &mut Data, scene: &mut Value, title: &str, subtitle: &str) -> Result<()> {
    // Invisible anchors give every image the same framing, independently of its geometry.
    data.apply(Table::new("Frame", 2).field("x", vec![-760.0, 760.0]).field("y", vec![-460.0, 460.0]))?;
    let marks = scene["marks"].as_array_mut().expect("scene marks");
    marks.push(json!({"vertices": {"of": ["art", "Frame"], "position": ["x", "y"],
        "radius": 0, "color": "#00000000", "pick": false}}));
    for (table, text, y, size, color) in [
        ("Title", title, 405.0, 34, "#f1f6ff"),
        ("Subtitle", subtitle, 360.0, 16, "#8eabc0"),
        ("Footer", "LATKIT / NATIVE GPU / SCENE + DATA -> PNG", -420.0, 12, "#6f8ba4"),
    ] {
        data.apply(Table::new(table, 1).field("x", vec![-690.0]).field("y", vec![y]).field("text", vec![text]))?;
        marks.push(json!({"vertices": {"of": ["art", table], "position": ["x", "y"],
            "radius": 0, "color": "#00000000", "pick": false,
            "label": {"text": "text", "size": size, "color": color, "priority": 255}}}));
    }
    Ok(())
}

fn helios() -> Result<Artwork> {
    let mut data = Data::new("art");
    let (mut x, mut y, mut heat, mut radius, mut names) = (vec![], vec![], vec![], vec![], vec![]);
    let (mut from, mut to) = (Vec::<u32>::new(), Vec::<u32>::new());
    for ring in 0..5_u32 {
        for node in 0..96_u32 {
            let angle = f64::from(node) * TAU / 96.0 + f64::from(ring) * 0.075;
            let r = 92.0 + f64::from(ring) * 55.0 + 8.0 * (angle * 6.0).sin();
            x.push(190.0 + r * angle.cos());
            y.push(-35.0 + r * angle.sin());
            heat.push(0.25 + 0.7 * (angle * 0.5 + f64::from(ring) * 0.3).sin().powi(2));
            radius.push(if node % 12 == 0 { 5.0 } else { 2.3 });
            names.push(if ring == 4 && node % 12 == 0 { format!("S{:02}", node / 12 + 1) } else { String::new() });
            let id = ring * 96 + node;
            from.push(id);
            to.push(ring * 96 + (node + 1) % 96);
            if ring > 0 {
                from.push(id);
                to.push((ring - 1) * 96 + (node + 3) % 96);
            }
            if ring == 0 && node % 3 == 0 {
                from.push(id);
                to.push((node + 37) % 96);
            }
        }
    }
    data.apply(
        Table::new("Node", x.len())
            .field("x", x)
            .field("y", y)
            .field("heat", heat)
            .field("radius", radius)
            .field("name", names),
    )?;
    data.apply(Table::new("Link", from.len()).reference("from", "Node", from).reference("to", "Node", to))?;
    data.apply(
        Table::new("Note", 5).field("x", vec![-660.0; 5]).field("y", vec![200.0, 155.0, 80.0, 35.0, -40.0]).field(
            "text",
            vec![
                "480 SUBSTATIONS",
                "896 CONNECTIONS",
                "Five concentric regions",
                "One connected system",
                "Synthetic topology / 01",
            ],
        ),
    )?;
    let scene = scene(json!([
        {"edges": {"of": ["art", "Link"], "ends": ["from", "to"], "width": 0.85, "flow": 18}},
        {"vertices": {"of": ["art", "Node"], "position": ["x", "y"], "radius": "radius",
            "color": {"colormap": "heat", "map": "viridis", "domain": [0, 1]},
            "label": {"text": "name", "size": 13, "color": "#c0e5dd"}}},
        {"vertices": {"of": ["art", "Note"], "position": ["x", "y"], "radius": 0, "color": "#00000000",
            "label": {"text": "text", "size": 17, "color": "#9dcabf"}}}
    ]));
    Ok(("helios", data, scene, "01 / HELIOS", "Flow through a synthetic transmission network"))
}

fn interference() -> Result<Artwork> {
    let mut data = Data::new("art");
    let (mut x, mut y, mut heat, mut radius) = (vec![], vec![], vec![], vec![]);
    for row in 0..140 {
        for column in 0..240 {
            let px = f64::from(column) / 239.0 * 1280.0 - 640.0;
            let py = f64::from(row) / 139.0 * 560.0 - 315.0;
            let a = ((px + 260.0).hypot(py + 20.0) * 0.035).sin();
            let b = ((px - 240.0).hypot(py - 10.0) * 0.045).cos();
            let value = (a + b + 2.0) * 0.25;
            x.push(px + 9.0 * (py * 0.022).sin());
            y.push(py + 13.0 * (px * 0.016 + py * 0.01).sin());
            heat.push(0.18 + value * 0.82);
            radius.push(0.8 + value * 1.7);
        }
    }
    data.apply(
        Table::new("Particle", x.len()).field("x", x).field("y", y).field("heat", heat).field("radius", radius),
    )?;
    let scene = scene(json!([
        {"vertices": {"of": ["art", "Particle"], "position": ["x", "y"], "radius": "radius",
            "color": {"colormap": "heat", "map": "magma", "domain": [0, 1]}}}
    ]));
    Ok((
        "interference",
        data,
        scene,
        "02 / INTERFERENCE",
        "33,600 particles / two wave sources / one interference field",
    ))
}

fn tides() -> Result<Artwork> {
    let mut data = Data::new("art");
    let mut paths = Vec::new();
    let mut levels = Vec::new();
    for contour in 0..100 {
        let level = f64::from(contour) / 99.0;
        let r = 55.0 + 250.0 * level;
        let points = (0..=480)
            .map(|step| {
                let a = f64::from(step) / 480.0 * TAU;
                let ripple = 1.0 + 0.12 * (a * 3.0 + level * 5.0).sin() + 0.07 * (a * 7.0 - level * 4.0).cos();
                [95.0 + 1.65 * r * ripple * a.cos(), -35.0 + 0.83 * r * ripple * a.sin()]
            })
            .collect::<Vec<_>>();
        paths.push(points);
        levels.push(level);
    }
    data.apply(Table::new("Contour", paths.len()).field("geometry", paths).field("level", levels))?;
    let scene = scene(json!([
        {"lines": {"of": ["art", "Contour"], "width": 1.15,
            "color": {"colormap": "level", "map": "turbo", "domain": [0, 1]}}}
    ]));
    Ok(("tides", data, scene, "03 / TIDAL FORMS", "100 closed contours / 48,100 coordinates / harmonic geometry"))
}
