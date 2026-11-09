// @ts-check
// Scenes in their JSON form, checked twice: TypeScript checks them against `Scene`, and latkit's
// `tests/scenes.rs` decodes each one. The array below must stay JSON.

/** @type {import('../src/inputs.js').Scene[]} */
export default [
  { "space": "plane" },
  { "space": "earth", "ease": 0 },
  { "space": { "earth": { "projection": "globe" } }, "theme": "light" },
  { "space": "plot" },
  { "space": "plane", "layout": "stress" },
  { "space": { "plane": { "grid": "off" } } },
  { "space": { "plane": { "grid": { "dots": { "pitch": 10 } } } }, "layout": { "layered": { "direction": "down", "rankGap": 60 } } },
  { "space": { "earth": { "projection": "globe", "graticule": false } }, "theme": { "earth": { "ground": "#203040" } } },
  {
    "space": { "earth": { "projection": "globe", "daylight": 1782043200, "atmosphere": true } },
    "marks": [
      { "areas": ["base", "water"], "color": "#1d3557" },
      { "areas": ["city", "polygons"], "geometry": "geometry", "color": { "colormap": "tab10", "value": "$use" }, "label": "$name" },
      { "lines": ["city", "polygons"], "width": 1, "color": "rgba(255, 255, 255, 0.25)" },
      { "lines": ["base", "transportation"], "width": { "div": ["$lanes", 2] } }
    ],
    "theme": { "area": { "color": "#223344" }, "earth": { "atmosphere": "#5aa9ff88", "night": 0.35 } }
  },
  { "space": { "plot": { "x": { "label": "Time (s)" }, "y": { "grid": false } } } },
  {
    "space": { "plot": { "x": { "unit": " s" }, "y": { "unit": " Hz", "grid": false } } },
    "title": { "text": "Frequency", "subtitle": "After the fault", "place": "top" }
  },
  {
    "space": "plane",
    "title": "Voltage",
    "marks": [
      {
        "vertices": ["grid", "Bus"],
        "color": { "colormap": "viridis", "value": "$vm", "domain": [0.95, 1.05] },
        "legend": { "title": "Voltage", "unit": " pu", "place": "right" }
      },
      { "vertices": ["grid", "Plant"], "color": { "colormap": "tab10", "value": "$kind" }, "legend": "Kind" }
    ]
  },
  {
    "space": { "earth": { "projection": "globe" } },
    "marks": [
      {
        "edges": ["grid", "Branch"],
        "ends": ["from", "to"],
        "width": { "units": 2, "atLeast": 1 },
        "dash": { "gt": ["$loading", 0.9] },
        "flow": { "div": ["$p", 20] },
        "priority": { "abs": ["$p"] },
        "color": { "colormap": "amber", "value": "$loading", "domain": [0, 1] },
        "name": "branches"
      },
      {
        "vertices": ["grid", "Bus"],
        "position": ["$lon", "$lat"],
        "elevation": 0,
        "radius": { "add": [{ "div": ["$kv", 100] }, 1] },
        "marker": "diamond",
        "color": {
          "when": [[{ "state": "selected" }, "#ffb000"]],
          "otherwise": { "colormap": "balance", "value": { "field": "vm", "step": true }, "domain": [0.95, 1.05] }
        },
        "visible": { "and": [{ "ge": ["$kv", 115] }, { "contains": ["$name", "north"] }] }
      },
      {
        "vertices": ["grid", "Bus"],
        "name": "load",
        "size": [12, { "units": 4 }],
        "marker": { "block": { "corner": 2 } },
        "color": { "colormap": "viridis", "value": { "field": "load", "from": ["weather", "Station"] } }
      }
    ],
    "theme": {
      "base": "dark",
      "vertex": { "radius": 5, "corner": 4 },
      "edge": { "color": null },
      "focus": { "selected": "#ff8800" }
    }
  },
  {
    "space": { "plane": { "grid": { "lines": { "pitch": 1 } } } },
    "controls": { "gestures": { "secondary": "none", "shift+primary": "pan", "twist": "turn", "slide": "tilt" }, "pickRadius": 14 },
    "marks": [
      { "edges": ["mesh", "Spring"], "ends": ["a", "b"], "color": "#ffffff14" },
      { "vertices": ["mesh", "Vertex"], "position": ["$x", "$y"], "elevation": "$z", "select": false, "drag": true }
    ],
    "theme": { "text": { "font": "monospace", "size": 12 }, "plot": { "playhead": "#ffe5d4" } }
  },
  {
    "space": { "plot": { "x": { "label": "Time (s)" } } },
    "marks": [{ "lines": ["mesh", "Body"], "trace": "height", "color": "#66c7ff", "width": 2, "flow": 12 }]
  },
  {
    "space": { "plot": { "y": { "format": "engineering", "precision": 1, "ticks": [0, [0.5, "half"], 1] } } },
    "controls": { "gestures": { "shift+primary": "box", "alt+primary": "zoomBox", "wheel": "pan", "control+wheel": "zoom" } },
    "marks": [
      {
        "lines": ["mesh", "Body"],
        "trace": "speed",
        "interpolation": "stepAfter",
        "label": {
          "text": { "when": [[{ "ge": ["$rank", 2] }, "$name"]], "otherwise": null },
          "size": 11,
          "maxWidth": 120,
          "color": "white"
        }
      },
      {
        "vertices": ["grid", "Bus"],
        "marker": { "gauge": { "fill": "$load", "shape": "rounded" } },
        "ring": "red",
        "label": "$name",
        "radius": { "mul": [{ "state": "zoom" }, 2] }
      },
      { "vertices": ["grid", "Plant"], "marker": { "pie": { "slices": ["$coal", "$gas"], "colors": ["#333333", "#88aaff"], "hole": 0.4 } } },
      { "vertices": ["grid", "Icon"], "marker": { "icon": { "images": [{ "size": [1, 1], "rgba": [255, 0, 0, 255] }], "index": 0 } } },
      { "vertices": ["grid", "Custom"], "marker": { "wgsl": { "source": "fn marker(f: MarkerFragment) -> MarkerColor { return MarkerColor(f.color, 0.0); }", "inputs": ["$load"] } } },
      { "edges": ["grid", "Branch"], "ends": ["from", "to"] }
    ],
    "theme": { "edge": { "bow": 0.2, "arrow": 8 }, "text": { "halo": 2 }, "flow": { "spacing": { "units": 40 }, "length": { "units": 12 } } }
  },
  {
    "space": "plane",
    "layout": { "stress": { "gap": 50 } },
    "controls": { "gestures": { "alt+primary": "connect" }, "delete": true },
    "marks": [
      { "edges": ["plant", "Wire"], "ends": ["from", "to"], "bends": "path", "arrows": true, "width": 1.5 },
      { "edges": ["plant", "Net"], "joins": ["Device", "net"], "route": "straight" },
      { "vertices": ["plant", "Device"], "size": [40, 24], "marker": "block", "label": "$name" }
    ],
    "theme": { "vertex": { "corner": 6 } }
  }
];
