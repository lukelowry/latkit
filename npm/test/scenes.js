// @ts-check
// Scenes in their JSON form, checked twice: TypeScript checks them against `Scene`, and latkit's
// `tests/scenes.rs` decodes each one. The array below must stay JSON.

/** @type {import('../src/forms.js').Scene[]} */
export default [
  { "space": "plane" },
  { "space": "earth", "ease": 0 },
  { "space": "globe", "theme": "light" },
  { "space": "plot" },
  { "space": "diagram", "layout": "stress" },
  { "space": { "plane": { "grid": "off" } } },
  { "space": { "diagram": { "grid": { "dots": 10, "snap": true } } }, "layout": { "layered": { "flow": "down", "rankGap": 60 } } },
  { "space": { "earth": { "projection": "globe", "surface": "#203040", "graticule": false } } },
  {
    "space": { "earth": { "projection": "globe", "daylight": 1782043200, "atmosphere": true } },
    "marks": [
      { "areas": { "of": ["base", "water"], "color": "#1d3557" } },
      { "areas": { "of": ["city", "polygons"], "rings": "geometry", "color": { "colormap": "use", "map": "tab10" }, "label": "name" } },
      { "lines": { "of": ["city", "polygons"], "width": 1, "color": "#ffffff40" } },
      { "lines": { "of": ["base", "transportation"], "width": { "op": "div", "args": ["lanes", 2] } } }
    ],
    "theme": { "area": "#223344", "atmosphere": "#5aa9ff88", "night": 0.35 }
  },
  { "space": { "plot": { "x": { "label": "Time (s)" }, "y": { "grid": false } } } },
  {
    "space": "globe",
    "marks": [
      {
        "edges": {
          "of": ["grid", "Branch"],
          "ends": ["from", "to"],
          "width": { "units": 2 },
          "dash": { "op": "gt", "args": ["loading", 0.9] },
          "flow": { "op": "div", "args": ["p", 20] },
          "color": { "colormap": "loading", "map": "amber", "domain": [0, 1] },
          "name": "branches"
        }
      },
      {
        "vertices": {
          "of": ["grid", "Bus"],
          "position": ["lon", "lat"],
          "elevation": 0,
          "radius": { "op": "add", "args": [{ "op": "div", "args": ["kv", 100] }, 1] },
          "marker": "diamond",
          "color": {
            "when": [[{ "state": "selected" }, { "color": "#ffb000" }]],
            "otherwise": { "colormap": { "field": "vm", "step": true }, "map": "balance", "domain": [0.95, 1.05] }
          },
          "visible": { "op": "and", "args": [{ "op": "ge", "args": ["kv", 115] }, { "is": ["kind", "substation"] }] }
        }
      },
      {
        "vertices": {
          "of": ["grid", "Bus"],
          "name": "load",
          "size": [12, { "units": 4 }],
          "marker": { "block": { "corner": 2 } },
          "shadow": true,
          "color": { "scale": { "field": "load", "of": ["weather", "Station"] }, "range": [0, 1] }
        }
      }
    ],
    "theme": { "base": "dark", "vertexRadius": 5, "edge": null, "selected": "#ff8800", "shadow": { "color": "#00000055", "lift": 4 } }
  },
  {
    "space": { "plane": { "grid": { "lines": 1 } } },
    "controls": { "turn": false, "pickRadius": 14 },
    "marks": [
      { "faces": { "of": ["mesh", "Face"], "corners": ["a", "b", "c"], "pick": false, "shadow": true } },
      { "edges": { "of": ["mesh", "Spring"], "ends": ["a", "b"], "color": "#ffffff14" } },
      { "vertices": { "of": ["mesh", "Vertex"], "position": ["x", "y"], "elevation": "z", "select": false, "drag": true } }
    ],
    "theme": { "shading": 0.7, "font": "monospace", "fontSize": 12, "playhead": "#ffe5d4" }
  },
  {
    "space": { "plot": { "x": { "label": "Time (s)" } } },
    "marks": [{ "lines": { "of": ["mesh", "Body"], "trace": "height", "color": "#66c7ff", "width": 2, "flow": 12, "shadow": true } }]
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
          "label": { "text": "name", "size": 11, "priority": "rank", "maxWidth": 120 }
        }
      },
      {
        "vertices": {
          "of": ["grid", "Bus"],
          "marker": { "gauge": { "fill": "load", "shape": "rounded" } },
          "status": { "color": "#ff0000" },
          "label": "name",
          "radius": { "op": "mul", "args": [{ "state": "zoom" }, 2] }
        }
      },
      { "vertices": { "of": ["grid", "Plant"], "marker": { "pie": { "slices": ["coal", "gas"], "colors": ["#333333", "#88aaff"], "hole": 0.4 } } } },
      { "vertices": { "of": ["grid", "Icon"], "marker": { "icon": { "images": [{ "size": [1, 1], "rgba": [255, 0, 0, 255] }], "index": 0 } } } },
      { "vertices": { "of": ["grid", "Custom"], "marker": { "wgsl": { "source": "fn marker(f: MarkerFragment) -> MarkerColor { return MarkerColor(f.color, 0.0); }", "inputs": ["load"] } } } },
      { "edges": { "of": ["grid", "Branch"], "ends": ["from", "to"], "shadow": true } }
    ],
    "theme": { "edgeSpacing": 5, "arrow": 8, "halo": 2, "shadow": { "light": [-1, 1, 2], "softness": 0.2 } }
  },
  {
    "space": "diagram",
    "layout": { "stress": { "gap": 50 } },
    "controls": { "connect": true, "delete": true },
    "marks": [
      { "vertices": { "of": ["plant", "Area"], "contains": ["Device", "area"], "label": "name" } },
      { "edges": { "of": ["plant", "Wire"], "ends": ["from", "to"], "bends": "path", "arrows": true } },
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
    "theme": { "groupPadding": 16 }
  }
];
