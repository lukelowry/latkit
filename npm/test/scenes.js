// @ts-check
// Scenes in their JSON form, checked twice: TypeScript checks them against `Scene`, and latkit's
// `tests/scenes.rs` decodes each one. The array below must stay JSON.

/** @type {import('../src/inputs.js').Scene[]} */
export default [
  { "space": "plane" },
  { "space": "earth", "ease": 0 },
  { "space": { "earth": { "projection": "globe" } }, "theme": "light" },
  { "space": "plot" },
  { "space": "diagram", "layout": "stress" },
  { "space": { "plane": { "grid": "off" } } },
  { "space": { "diagram": { "grid": { "dots": { "pitch": 10, "snap": true } } } }, "layout": { "layered": { "direction": "down", "rankGap": 60 } } },
  { "space": { "earth": { "projection": "globe", "graticule": false } }, "theme": { "earth": { "ground": "#203040" } } },
  {
    "space": { "earth": { "projection": "globe", "daylight": 1782043200, "atmosphere": true } },
    "marks": [
      { "areas": { "of": ["base", "water"], "color": "#1d3557" } },
      { "areas": { "of": ["city", "polygons"], "geometry": "geometry", "color": { "colormap": "tab10", "value": "$use" }, "label": "$name" } },
      { "lines": { "of": ["city", "polygons"], "width": 1, "color": "rgba(255, 255, 255, 0.25)" } },
      { "lines": { "of": ["base", "transportation"], "width": { "div": ["$lanes", 2] } } }
    ],
    "theme": { "area": { "color": "#223344" }, "earth": { "atmosphere": "#5aa9ff88", "night": 0.35 } }
  },
  { "space": { "plot": { "x": { "label": "Time (s)" }, "y": { "grid": false } } } },
  {
    "space": { "earth": { "projection": "globe" } },
    "marks": [
      {
        "edges": {
          "of": ["grid", "Branch"],
          "ends": ["from", "to"],
          "width": { "units": 2, "atLeast": 1 },
          "dash": { "gt": ["$loading", 0.9] },
          "flow": { "div": ["$p", 20] },
          "priority": { "abs": ["$p"] },
          "color": { "colormap": "amber", "value": "$loading", "domain": [0, 1] },
          "name": "branches"
        }
      },
      {
        "vertices": {
          "of": ["grid", "Bus"],
          "position": ["$lon", "$lat"],
          "elevation": 0,
          "radius": { "add": [{ "div": ["$kv", 100] }, 1] },
          "marker": "diamond",
          "color": {
            "when": [[{ "state": "selected" }, "#ffb000"]],
            "otherwise": { "colormap": "balance", "value": { "field": "vm", "step": true }, "domain": [0.95, 1.05] }
          },
          "visible": { "and": [{ "ge": ["$kv", 115] }, { "contains": ["$name", "north"] }] }
        }
      },
      {
        "vertices": {
          "of": ["grid", "Bus"],
          "name": "load",
          "size": [12, { "units": 4 }],
          "marker": { "block": { "corner": 2 } },
          "color": { "colormap": "viridis", "value": { "field": "load", "from": ["weather", "Station"] } }
        }
      }
    ],
    "theme": {
      "base": "dark",
      "vertex": { "radius": 5 },
      "edge": { "color": null },
      "focus": { "selected": "#ff8800" },
      "diagram": { "shadow": { "color": "#00000055", "lift": 4 } }
    }
  },
  {
    "space": { "plane": { "grid": { "lines": { "pitch": 1 } } } },
    "controls": { "turn": false, "pickRadius": 14 },
    "marks": [
      { "faces": { "of": ["mesh", "Face"], "corners": ["a", "b", "c"], "pick": false } },
      { "edges": { "of": ["mesh", "Spring"], "ends": ["a", "b"], "color": "#ffffff14" } },
      { "vertices": { "of": ["mesh", "Vertex"], "position": ["$x", "$y"], "elevation": "$z", "select": false, "drag": true } }
    ],
    "theme": { "shading": 0.7, "text": { "font": "monospace", "size": 12 }, "plot": { "playhead": "#ffe5d4" } }
  },
  {
    "space": { "plot": { "x": { "label": "Time (s)" } } },
    "marks": [{ "lines": { "of": ["mesh", "Body"], "trace": "height", "color": "#66c7ff", "width": 2, "flow": 12 } }]
  },
  {
    "space": { "plot": { "y": { "format": "engineering", "precision": 1, "ticks": [0, [0.5, "half"], 1] } } },
    "controls": { "selectBox": true },
    "marks": [
      {
        "lines": {
          "of": ["mesh", "Body"],
          "trace": "speed",
          "interpolation": "stepAfter",
          "label": {
            "text": { "when": [[{ "ge": ["$rank", 2] }, "$name"]], "otherwise": null },
            "size": 11,
            "maxWidth": 120,
            "color": "white"
          }
        }
      },
      {
        "vertices": {
          "of": ["grid", "Bus"],
          "marker": { "gauge": { "fill": "$load", "shape": "rounded" } },
          "ring": "red",
          "label": "$name",
          "radius": { "mul": [{ "state": "zoom" }, 2] }
        }
      },
      { "vertices": { "of": ["grid", "Plant"], "marker": { "pie": { "slices": ["$coal", "$gas"], "colors": ["#333333", "#88aaff"], "hole": 0.4 } } } },
      { "vertices": { "of": ["grid", "Icon"], "marker": { "icon": { "images": [{ "size": [1, 1], "rgba": [255, 0, 0, 255] }], "index": 0 } } } },
      { "vertices": { "of": ["grid", "Custom"], "marker": { "wgsl": { "source": "fn marker(f: MarkerFragment) -> MarkerColor { return MarkerColor(f.color, 0.0); }", "inputs": ["$load"] } } } },
      { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"] } }
    ],
    "theme": { "edge": { "spacing": 5, "arrow": 8 }, "text": { "halo": 2 }, "flow": { "spacing": { "units": 40 }, "length": { "units": 12 } } }
  },
  {
    "space": "diagram",
    "layout": { "stress": { "gap": 50 } },
    "controls": { "connect": true, "delete": true },
    "marks": [
      { "vertices": { "of": ["plant", "Area"], "contains": ["Device", "area"], "label": "$name", "shadow": true } },
      { "edges": { "of": ["plant", "Wire"], "ends": ["from", "to"], "bends": "path", "arrows": true, "width": { "px": 1.5 } } },
      { "edges": { "of": ["plant", "Net"], "route": "orthogonal", "arrows": true } },
      {
        "vertices": {
          "of": ["plant", "Device"],
          "size": [40, 24],
          "marker": "block",
          "ports": [
            ["input", "left"],
            ["output", { "side": "right", "order": 0, "label": "out", "shape": "diamond", "output": true }]
          ]
        }
      }
    ],
    "theme": { "diagram": { "groupPadding": 16, "portSize": 9, "group": "#1b2530", "shadow": { "color": "#00000040", "lift": 4 } } }
  }
];
