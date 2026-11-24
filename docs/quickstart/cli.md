# Command line

Render a two-second clip of the six-bus network. Gold comets show the direction of flow.

```{image} ../images/six-bus-flow.png
:alt: Six buses joined by seven lines. Gold comets travel from bus A through the network toward bus F.
:class: picture
```

With Rust 1.99 or newer, install the CLI.

```sh
cargo install latkit-cli --locked
```

Save these two files in an empty folder.

**grid.json** defines the buses and line endpoints. Bus IDs run from 0 (A) to 5 (F).

```{code-block} json
{
  "name": "grid",
  "patch": [
    { "replace": { "table": "Bus", "ids": { "count": 6 }, "fields": {
      "name": ["A", "B", "C", "D", "E", "F"],
      "x": [-160, -65, -65, 65, 65, 160], "y": [0, 58, -58, 58, -58, 0]
    } } },
    { "replace": { "table": "Line", "ids": { "count": 7 }, "fields": {
      "from": { "reference": "Bus", "ids": [0, 0, 1, 2, 2, 3, 4] },
      "to":   { "reference": "Bus", "ids": [1, 2, 3, 3, 4, 5, 5] }
    } } }
  ]
}
```

**scene.json** places the buses and animates the lines.

```{code-block} json
{
  "space": { "plane": { "grid": "off" } },
  "theme": { "flow": { "color": "#ffce8b", "width": 7 } },
  "marks": [
    { "edges": ["grid", "Line"], "ends": ["from", "to"], "color": "#527589", "width": 2, "flow": 64 },
    { "vertices": ["grid", "Bus"], "position": ["$x", "$y"], "radius": 8, "color": "#65d6bb", "label": "$name" }
  ]
}
```

On Windows, run this command in the same folder and open `network.mp4`.

```sh
latkit render scene.json -d grid.json --size 720x360 --span 0,2 --fps 20 -o network.mp4
```

On macOS or Linux, use `-o network.y4m` in the same command and open the clip in VLC.
