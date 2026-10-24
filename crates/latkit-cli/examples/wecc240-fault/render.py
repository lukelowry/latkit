"""Render the saved WECC240 fault with the Latkit CLI, including native H.264 encoding."""

import argparse
import hashlib
import json
import math
import os
import subprocess
import time
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parent
REPO = EXAMPLE.parents[3]
W, H, FPS = 1920, 1080, 60
PANELS = ["0,0,0.68,1", "0.68,0,0.32,0.5", "0.68,0.5,0.32,0.5"]
PALETTE = ["#3972fa", "#52c6ea", "#829aa6", "#ffbd68", "#fc624e"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def op(name, *args):
    return {"op": name, "args": list(args)}


def playback():
    frames = []
    for start, end, speed in [(0, 0.75, 0.5), (0.75, 1.5, 0.1), (1.5, 10, 0.5)]:
        count = round((end - start) * FPS / speed)
        frames.extend(round(start + k * speed / FPS, 12) for k in range(count))
    return frames + [10.0]


def camera(at):
    u = max(0, min(1, at / 10))
    return {
        "center": [-115.6, 40.7], "zoom": math.log2(60), "pitch": 35,
        "bearing": -8 + 16 * u * u * (3 - 2 * u),
    }


def status(at):
    return "PRE-FAULT" if at < 1 else "FAULT ON" if at < 1.15 else "FAULT CLEARED"


def prepare(work, frames):
    work.mkdir(parents=True, exist_ok=True)
    case = read(EXAMPLE / "source.case.json")
    meta = read(EXAMPLE / "recording/metadata.json")
    times, ids = meta["times"], meta["bus_ids"]
    for name, expected in meta["files"].items():
        data = (EXAMPLE / "recording" / name).read_bytes()
        if len(data) != expected["bytes"] or hashlib.sha256(data).hexdigest() != expected["sha256"]:
            raise ValueError(f"The saved recording changed: {name}")
    if not times[0] <= frames[0] <= frames[-1] <= times[-1]:
        raise ValueError("Render times lie outside the simulation")
    by_id = {b["number"]: b for b in case["buses"]}
    buses = [by_id[i] for i in ids]
    branches = [d for d in case["devices"] if d["class"] == "Branch"]
    machines = {d["id"]: d for d in case["devices"] if d["class"] == "Genrou"}
    ordered_machines = [machines[i] for i in meta["machine_ids"]]
    selected = [max(range(len(ordered_machines)), key=lambda i: meta["statistics"]["machine_peak_abs_frequency_hz"][i])]
    rotor_names = [meta["machine_ids"][i].removesuffix("_genrou") for i in selected]
    voltage_ids = [4005]

    def column(name, rows):
        return {
            "file": os.path.relpath(EXAMPLE / "recording" / name, work).replace(os.sep, "/"),
            "dtype": "f32le", "count": len(times) * rows,
        }

    named = {i: by_id[i]["name"].strip() for i in [1001, 2201]}
    named[4005] = f"4005 / {status(frames[0])}"
    patch = [
        {"axis": {"name": "time", "unit": "s"}},
        {"replace": {"table": "Bus", "ids": ids, "fields": {
            "lon": [b["extension"]["longitude"] for b in buses],
            "lat": [b["extension"]["latitude"] for b in buses],
            "label": [named.get(i, "") for i in ids],
            "priority": [1000 if i == 4005 else 1 for i in ids],
            "is_fault": [i == 4005 for i in ids],
            "faulted": [i == 4005 and 1 <= frames[0] < 1.15 for i in ids],
            "voltage_trace": [i in voltage_ids for i in ids],
        }}},
        {"replace": {"table": "Branch", "ids": [b["id"] for b in branches], "fields": {
            "from": {"reference": "Bus", "ids": [b["ports"]["bus1"] for b in branches]},
            "to": {"reference": "Bus", "ids": [b["ports"]["bus2"] for b in branches]},
            "width": [0.8 + min(by_id[b["ports"]["bus1"]]["params"]["kv"], by_id[b["ports"]["bus2"]]["params"]["kv"]) / 500
                      for b in branches],
        }}},
        {"replace": {"table": "Machine", "ids": meta["machine_ids"], "fields": {
            "traced": [i in selected for i in range(len(ordered_machines))],
        }}},
        {"append": {"at": times, "table": "Bus", "fields": {
            "df": column("frequency.f32", len(ids)), "vm": column("voltage.f32", len(ids)),
        }}},
        {"append": {"at": times, "table": "Machine", "fields": {
            "df": column("rotor.f32", len(ordered_machines)),
        }}},
    ]
    write(work / "grid.json", {"name": "grid", "patch": patch})
    # The original samples fit in memory for 243 buses. No interpolated cache is needed:
    # Latkit reads at each frame's time and preserves the duplicate event timestamps.
    x = op("div", op("abs", "df"), 0.01)
    magnitude = op("ln", op("add", x, op("sqrt", op("add", op("mul", x, x), 1))))
    signed = {"when": [[op("lt", "df", 0), op("neg", magnitude)]], "otherwise": magnitude}
    elevation = op("mul", signed, 1.4 / math.asinh(0.1 / 0.01))
    theme = {"background": "#0a111b", "text": {"color": "#d5e1ed", "font": "Segoe UI, sans-serif", "size": 17}}
    map_scene = {
        "space": {"plane": {"grid": "off"}}, "ease": 0,
        "theme": {**theme, "edge": {"color": None, "bow": 0}},
        "title": "WECC 240 / FAULT RESPONSE",
        "subtitle": "JOHN DAY / Bus 4005 / Applied 1.00 s / Cleared 1.15 s",
        "marks": [
            {"lines": {"of": ["states", "polygons"], "color": "#58718b70", "width": 0.9}},
            {"edges": {"of": ["grid", "Branch"], "ends": ["from", "to"], "width": "width"}},
            {"vertices": {
                "of": ["grid", "Bus"], "position": ["lon", "lat"], "elevation": elevation,
                "radius": {"when": [["faulted", 8], ["is_fault", 5]], "otherwise": 2.8},
                "color": {"colormap": {"kind": "diverging", "colors": PALETTE}, "value": "df", "domain": [-0.1, 0.1]},
                "label": {"text": "label", "size": 15, "priority": "priority"},
                "legend": "Bus frequency deviation / Hz",
            }},
        ],
    }

    def plot(title, table, field, visible, color):
        return {
            "space": {"plot": {"x": {"label": "Simulation time / s"},
                               "y": {"label": title, "precision": 3 if field == "df" else 2}}},
            "ease": 0, "theme": {**theme, "background": "#101b28", "text": {**theme["text"], "size": 14},
                                 "plot": {"playhead": "#f3f7fc"}},
            "marks": [{"lines": {
                "of": ["grid", table], "trace": field, "width": 2.0, "visible": visible,
                "color": color,
            }}],
        }

    write(work / "map.json", map_scene)
    write(work / "rotor.json", plot(f"{rotor_names[0]} / Rotor speed deviation / Hz",
                                  "Machine", "df", "traced", "#ffcb72"))
    write(work / "voltage.json", plot("4005 / JOHN DAY / Voltage / p.u.",
                                    "Bus", "vm", "voltage_trace", "#66d6ef"))
    write(work / "map-camera.json", camera(frames[0]))
    write(work / "rotor-camera.json", {"x": [0, 10], "y": [-0.05, 0.12]})
    write(work / "voltage-camera.json", {"x": [0, 10], "y": [0.88, 1.12]})
    previous_status = status(frames[0])
    with (work / "frames.jsonl").open("w", encoding="utf-8", newline="\n") as stream:
        for at in frames:
            frame = {"at": at, "camera": [camera(at), None, None]}
            phase = status(at)
            if phase != previous_status:
                frame["patch"] = {"grid": [{"set": {"table": "Bus", "ids": [4005], "fields": {
                    "label": [f"4005 / {phase}"], "faulted": [phase == "FAULT ON"],
                }}}]}
                previous_status = phase
            stream.write(json.dumps(frame, allow_nan=False) + "\n")
    return {
        "bus_count": len(ids), "branch_count": len(branches), "machine_count": len(ordered_machines),
        "traced_machines": rotor_names, "traced_bus_ids": voltage_ids,
        "events": meta["study"]["events"], "gridkit_image_id": meta["image_id"],
        "recording_hashes": meta["files"], "frames": len(frames), "fps": FPS,
        "resolution": [W, H], "seconds": len(frames) / FPS,
        "simulation_start_s": frames[0], "simulation_end_s": frames[-1],
        "playback": "0.5x before 0.75 s; 0.1x from 0.75 to 1.5 s; 0.5x thereafter",
        "color_domain_hz": [-0.1, 0.1],
        "height": "1.4 * asinh(df / 0.01) / asinh(0.1 / 0.01); exaggerated visual displacement",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_cli = REPO / "target/cli" / ("latkit.exe" if os.name == "nt" else "latkit")
    parser.add_argument("--cli", default=str(default_cli) if default_cli.exists() else "latkit")
    parser.add_argument("--work", type=Path, default=REPO / "target/wecc240-fault/render")
    parser.add_argument("--output", type=Path, default=EXAMPLE)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--at", type=float, default=1.12)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    frames = [args.at] if args.preview else playback()
    if args.limit is not None:
        frames = frames[:args.limit]
    work, output = args.work.resolve(), args.output.resolve()
    metadata = prepare(work, frames)
    output.mkdir(parents=True, exist_ok=True)
    result = output / ("preview.png" if args.preview else "animation.mp4")
    inputs = [str(work / f"{name}.json") for name in ("map", "rotor", "voltage")]
    inputs += ["--data", str(work / "grid.json"), "--data",
               f"states={EXAMPLE.parent / 'branch-opening/states.geojson'}"]
    for panel in PANELS:
        inputs += ["--panel", panel]
    for name in ("map", "rotor", "voltage"):
        inputs += ["--camera", str(work / f"{name}-camera.json")]
    inputs += ["--at", str(args.at)] if args.preview else ["--frames", str(work / "frames.jsonl")]
    inputs += ["--deadline", "120", "--insets", "20,12,12,8"]
    if os.name == "nt":
        inputs += ["--font", "C:/Windows/Fonts/segoeui.ttf"]
    command = [args.cli, "render", *inputs, "--size", f"{W}x{H}", "--fps", str(FPS),
               "--bitrate", "14000000", "--output", str(result)]
    print(subprocess.list2cmdline(command), flush=True)
    if args.prepare_only:
        return
    subprocess.run([args.cli, "validate", *inputs], check=True)
    started = time.perf_counter()
    subprocess.run(command, check=True)
    metadata.update({
        "render_seconds": time.perf_counter() - started, "output_bytes": result.stat().st_size,
        "command": [part.replace(str(REPO), "<repo>").replace(os.sep, "/") for part in command],
        "sha256": hashlib.sha256(result.read_bytes()).hexdigest(),
    })
    write(result.with_suffix(".json"), metadata)
    print(f"Saved {result}: {metadata['output_bytes'] / 1e6:.2f} MB in {metadata['render_seconds']:.2f} s", flush=True)


if __name__ == "__main__":
    main()
