// @ts-check
// Scenes in their JSON form, checked twice: TypeScript checks them against `Scene`, and latkit's
// `tests/scenes.rs` decodes each one. The array below must stay JSON.

/** @type {import('../src/scene.js').Scene[]} */
export default [
  { "space": "plane" },
  { "space": "earth", "ease": 0 },
  { "space": "globe", "theme": "light" },
  { "space": "plot" },
  { "space": { "plane": { "grid": "off" } } },
  { "space": { "plane": { "grid": { "dots": 10, "snap": true } } }, "layout": { "layered": { "flow": "down", "rankGap": 60 } } },
  { "space": { "earth": { "projection": "globe", "surface": "#203040", "graticule": false } }, "layout": "stress" },
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
    "theme": { "base": "dark", "vertexRadius": 5, "edge": null, "selected": "#ff8800", "shadow": "#00000055" }
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
    "marks": [{ "lines": { "of": ["mesh", "Body"], "samples": "height", "color": "#66c7ff", "width": 2 } }]
  }
];
