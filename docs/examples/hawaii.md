# Draw the Hawaiʻi one-line

```{image} ../images/hawaii.png
:alt: Numbered busbars on a one-line diagram. Gold circuits connect the 138 kV buses and gray circuits connect the 69 kV buses.
:class: picture
```

{download}`Open the full-resolution diagram <../images/hawaii.png>`.

Follow a circuit from one numbered busbar to the next. Paired windings mark transformers between the 138 kV and 69 kV systems. Parallel strokes are separate circuits. A gap where two strokes cross means they have no electrical connection.

The diagram shows the synthetic Hawaii40 case for Oʻahu, with 37 buses, 89 branches and 45 generators. A circle with a sine wave marks a generator, a triangle marks a load, and an open switch marks a disconnected generator.

## Explore the diagram

From the latkit checkout, run `cargo xtask examples --open` and choose **Hawaiʻi one-line**. Zoom in on a transformer, toggle the device symbols, or click a conductor to inspect its drawing row.

## Render the diagram

Download the {download}`scene <../gallery/hawaii/scene.json>`, {download}`drawing data <../gallery/hawaii/data.json>` and {download}`camera <../gallery/hawaii/camera.json>` to one directory. With the [CLI installed](../installation.md), run these commands there.

```sh
latkit validate scene.json -d data.json
latkit render scene.json -d data.json --camera camera.json --size 3804x1842 --scale 2 -o hawaii.png
```

The dataset stores drafted paths in plane coordinates. The scene draws conductors first, then windings, busbars, device symbols and labels. To change the line weights or voltage colors, edit `scene.json`.
