"""Reproduce the 70k-bus fault recording with Python and the latkit CLI.

Python writes latkit's JSON documents: the grid, whose frame columns are slices of the saved float32
caches, a frame per output frame that appends them, and a few buses' traces for a plot. latkit
reads the states' GeoJSON itself, draws the map with its title and legend over the plot, and
encodes the MP4. No Rust, browser, NumPy, Pillow, or FFmpeg is used.
"""

import argparse
import json
import math
import os
import struct
import subprocess
import time
from pathlib import Path

W, H, FPS = 1920, 1080, 60
PALETTE = ["#1f52f2", "#2ea6f2", "#4d6e7a", "#ffa13b", "#ff3b1c"]
FAULT = 56923
BACKGROUND = "#090d12"


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8", newline="\n")


def relative(path):
    """`path` from the working directory when it lies under it."""
    path = Path(path).resolve()
    return path.relative_to(Path.cwd()).as_posix() if path.is_relative_to(Path.cwd()) else path.as_posix()


def prepare(source, job, indices):
    meta = read(source / "depth-metadata.json")
    ids, times = meta["bus_ids"], meta["simulation_times"]
    n = len(ids)
    assert n == 70_000 and len(set(ids)) == n and len(times) == 997 and meta["fps"] == FPS
    for name in ("depth-frequency.f32", "depth-height.f32"):
        assert (source / name).stat().st_size == n * len(times) * 4
    job.mkdir(parents=True, exist_ok=True)

    def frame(k):
        """Frame k of the saved caches: one value per bus, in the metadata's order."""
        return {
            field: {"file": str(source / name), "dtype": "f32le", "offset": k * n * 4, "count": n}
            for field, name in (("df", "depth-frequency.f32"), ("height", "depth-height.f32"))
        }

    buses = {b["bus_id"]: b for b in read(source / "buses.json")}
    ordered = [buses[i] for i in ids]
    lon = [b["longitude"] for b in ordered]
    lat = [b["latitude"] for b in ordered]
    edges = read(source / "topology.json")
    kv = lambda e: min(buses[e["bus1"]]["kv"], buses[e["bus2"]]["kv"])
    widths = [0.7 + min(1, max(0, (kv(e) - 69) / 696)) for e in edges]
    first = indices[0]
    write(job / "grid.json", {"name": "grid", "patch": [
        {"axis": {"name": "time", "unit": "s"}},
        {"replace": {"table": "Bus", "ids": ids, "fields": {"lon": lon, "lat": lat}}},
        {"replace": {"table": "Branch", "ids": {"count": len(edges)}, "fields": {
            "width": widths,
            "from": {"reference": "Bus", "ids": [e["bus1"] for e in edges]},
            "to": {"reference": "Bus", "ids": [e["bus2"] for e in edges]},
        }}},
        {"append": {"at": times[first], "table": "Bus", "fields": frame(first)}},
    ]})

    # The fault bus and five across the grid, west to east, traced over the whole recording.
    west_to_east = sorted(range(n), key=lambda i: lon[i])
    traced = [ids.index(FAULT)] + [west_to_east[round(q * (n - 1))] for q in (0.05, 0.3, 0.5, 0.7, 0.95)]
    values = []
    with (source / "depth-frequency.f32").open("rb") as f:
        for k in range(len(times)):
            for i in traced:
                f.seek((k * n + i) * 4)
                values.append(struct.unpack("<f", f.read(4))[0])
    write(job / "trace.json", {"name": "trace", "patch": [
        {"axis": {"name": "time", "unit": "s"}},
        {"replace": {"table": "Bus", "ids": [ids[i] for i in traced], "fields": {"group": list(range(len(traced)))}}},
        {"append": {"at": times, "table": "Bus", "fields": {"df": values}}},
    ]})

    height_scale = 1.7 * 0.15 * max(max(lon) - min(lon), max(lat) - min(lat))
    theme = {"background": BACKGROUND, "text": "#c9d4dc", "font": "Segoe UI, sans-serif", "fontSize": 15}
    scenes = {
        "map.json": {
            "space": {"plane": {"grid": "off"}}, "ease": 0,
            "theme": {**theme, "edge": None, "laneBow": 0},
            "title": "ACTIVSg70k",
            "subtitle": f"A fault on bus {FAULT} at 1 s, cleared at 1.15 s",
            "marks": [
                {"lines": {"of": ["states", "polygons"], "color": "#5c7a8f6b", "width": 0.75}},
                {"edges": {"of": ["grid", "Branch"], "ends": ["from", "to"], "width": "width"}},
                {"vertices": {
                    "of": ["grid", "Bus"], "position": ["lon", "lat"], "radius": 0.8,
                    "elevation": {"op": "mul", "args": ["height", height_scale]},
                    "color": {"colormap": {"kind": "diverging", "colors": PALETTE},
                              "value": "df", "domain": [-0.05, 0.05]},
                    "legend": "Bus frequency deviation · Hz",
                }},
            ],
        },
        "plot.json": {
            "space": {"plot": {"x": {"label": "Simulation time · s"}, "y": {"label": "Δf · Hz", "precision": 2}}},
            "ease": 0,
            "theme": {**theme, "fontSize": 13, "playhead": "#eff5f8"},
            "marks": [{"lines": {"of": ["trace", "Bus"], "trace": "df", "width": 1.4,
                                 "color": {"colormap": "tableau10", "value": "group"}}}],
        },
        "map-camera.json": {"center": [-87.8, 35], "zoom": math.log2(40), "pitch": 55, "bearing": 8},
        "plot-camera.json": {"x": [times[0], times[-1]], "y": [-0.05, 0.05]},
    }
    # Keep camera and style edits when rerunning the recipe.
    for name, value in scenes.items():
        if not (job / name).exists():
            write(job / name, value)

    with (job / "frames.jsonl").open("w", encoding="utf-8") as lines:
        for k in indices:
            patch = [{"append": {"at": times[k], "table": "Bus", "fields": frame(k)}}, {"forget": {"before": times[k]}}]
            lines.write(json.dumps({"at": times[k], "patch": {"grid": patch}}, allow_nan=False) + "\n")
    return {"buses": n, "branches": len(edges), "traced": [ids[i] for i in traced], "frames": len(indices),
            "fps": FPS, "simulation_start_s": times[indices[0]], "simulation_end_s": times[indices[-1]],
            "height_scale": height_scale}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="the saved recording's outputs directory")
    parser.add_argument("--work", type=Path, default=Path("target/bus-fault"))
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--cli", default="latkit")
    parser.add_argument("--font", type=Path, default=Path("C:/Windows/Fonts/segoeui.ttf"))
    parser.add_argument("--preview", action="store_true", help="render one frame, at 1.3 s, as a PNG")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--limit", type=int, help="render the first N frames")
    args = parser.parse_args()
    source, job, output = args.source.resolve(), args.work.resolve(), args.output.resolve()
    times = read(source / "depth-metadata.json")["simulation_times"]
    indices = [min(range(len(times)), key=lambda k: abs(times[k] - 1.3))] if args.preview else list(range(len(times)))
    if args.limit is not None:
        if args.limit < 1:
            parser.error("--limit must be positive")
        indices = indices[:args.limit]
    started = time.perf_counter()
    metadata = prepare(source, job, indices)
    output.mkdir(parents=True, exist_ok=True)
    result = output / ("preview.png" if args.preview else "animation.mp4")
    inputs = [args.cli, str(job / "map.json"), str(job / "plot.json"),
              "--data", str(job / "grid.json"), "--data", str(job / "trace.json"),
              "--data", f"states={source / 'usa-states.geojson'}",
              "--panel", "0,0,1,0.84", "--panel", "0,0.84,1,0.16",
              "--camera", str(job / "map-camera.json"), "--camera", str(job / "plot-camera.json"),
              "--frames", str(job / "frames.jsonl"), "--font", str(args.font)]
    render = [inputs[0], "render", *inputs[1:], "--size", f"{W}x{H}", "--fps", str(FPS), "--output", str(result)]
    print(subprocess.list2cmdline(render), flush=True)
    if args.prepare_only:
        return
    subprocess.run([inputs[0], "validate", *inputs[1:]], check=True)
    render_started = time.perf_counter()
    subprocess.run(render, check=True)
    # The record names the source as <source> and other files from the working directory.
    command = [relative(part) if os.path.isabs(part) else part for part in
               (part.replace(str(source), "<source>").replace(os.sep, "/") for part in render)]
    metadata.update({"resolution": [W, H], "seconds": len(indices) / FPS,
                     "render_seconds": time.perf_counter() - render_started,
                     "total_seconds": time.perf_counter() - started, "command": command})
    write(output / ("preview.json" if args.preview else "animation.json"), metadata)
    print(f"Saved {relative(result)} ({metadata['render_seconds']:.1f} s rendering)", flush=True)


if __name__ == "__main__":
    main()
