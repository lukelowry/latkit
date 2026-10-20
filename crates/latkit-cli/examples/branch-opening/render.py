"""Render the saved ACTIVSg70k line-opening study using Python and the Latkit CLI.

Python prepares JSON and selects slices of the original float32 recording. Latkit
interpolates the samples, computes elevation, draws the map, and encodes the MP4.
Requires Python 3.10+; no third-party Python packages or external encoder.
"""

import argparse
import bisect
import hashlib
import json
import math
import os
import subprocess
import time
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parent
ROOT = EXAMPLE.parent.parent
W, H, FPS = 1920, 1080, 60
SPEED = 0.4
HEIGHT_GAIN = 0.45
BEARINGS = [-10, 20]
BRANCH = "branch_59757_59774_1"
EVENT = 1.0
BACKGROUND = "#090d12"
PALETTE = ["#1f52f2", "#2ea6f2", "#4d6e7a", "#ffa13b", "#ff3b1c"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n",
                    encoding="utf-8", newline="\n")


def op(name, *args):
    return {"op": name, "args": list(args)}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def playback_times():
    # 0.6--10 s at a constant 0.4x: 1,411 pictures, 23.517 s.
    count = round((10 - 0.6) * FPS / SPEED) + 1
    return [round(0.6 + k * SPEED / FPS, 12) for k in range(count)]


def camera_at(at):
    # A small arc with gentle starts and stops; previews follow the same path.
    u = min(1, max(0, (at - 0.6) / (10 - 0.6)))
    eased = u * u * (3 - 2 * u)
    return {"center": [-92, 36.5], "zoom": math.log2(34), "pitch": 48,
            "bearing": BEARINGS[0] + (BEARINGS[1] - BEARINGS[0]) * eased}


def prepare(source, job, frames):
    recording = source / "runs/little-rock-60hz"
    meta = read(recording / "frequency_metadata.json")
    ids, times = meta["bus_ids"], meta["times"]
    frequency = recording / "frequency.f32"
    n = len(ids)
    if (n != 70000 or len(set(ids)) != n or meta["dtype"] != "f32le"
            or meta["layout"] != "frame-major"
            or frequency.stat().st_size != n * len(times) * 4
            or any(b < a for a, b in zip(times, times[1:]))):
        raise ValueError("Unexpected recording dimensions, format, or sample order")
    if not times[0] <= min(frames) <= max(frames) <= times[-1]:
        raise ValueError("Requested frames lie outside the recording")
    job.mkdir(parents=True, exist_ok=True)

    def bracket(at):
        # Match Latkit's exact <= comparison. An epsilon here can select a sample
        # just AFTER `at`, then `forget` removes the last sample Latkit can read.
        lower = bisect.bisect_right(times, at) - 1
        upper = min(lower + 1, len(times) - 1)
        assert times[lower] <= at <= times[upper]
        return lower, upper

    def append(start, end):
        return {"append": {"at": times[start:end + 1], "table": "Bus", "fields": {
            "df": {"file": os.path.relpath(frequency, job).replace(os.sep, "/"),
                   "dtype": "f32le", "offset": start * n * 4, "count": (end - start + 1) * n}
        }}}

    buses = {b["bus_id"]: b for b in read(source / "buses.json")}
    ordered = [buses[i] for i in ids]
    lon = [b["longitude"] for b in ordered]
    lat = [b["latitude"] for b in ordered]
    branches = read(source / "topology.json")
    selected = [e for e in branches if e["id"] == BRANCH]
    if len(selected) != 1 or (selected[0]["bus1"], selected[0]["bus2"]) != (59757, 59774):
        raise ValueError("The selected branch does not match the saved topology")
    widths = [0.7 + min(1, max(0, (min(buses[e["bus1"]]["kv"], buses[e["bus2"]]["kv"]) - 69) / 696))
              for e in branches]
    opened = frames[0] >= EVENT
    lower, loaded = bracket(frames[0])
    write(job / "grid.json", {"name": "grid", "patch": [
        {"axis": {"name": "time", "unit": "s"}},
        {"replace": {"table": "Bus", "ids": ids, "fields": {
            "lon": lon, "lat": lat,
            "label": [{59757: "Little Rock", 59774: "Newark"}.get(i, "") for i in ids],
        }}},
        {"replace": {"table": "Branch", "ids": [e["id"] for e in branches], "fields": {
            "width": widths, "in_service": [not (opened and e["id"] == BRANCH) for e in branches],
            "from": {"reference": "Bus", "ids": [e["bus1"] for e in branches]},
            "to": {"reference": "Bus", "ids": [e["bus2"] for e in branches]},
        }}},
        {"replace": {"table": "Outage", "ids": [BRANCH], "fields": {
            "from": {"reference": "Bus", "ids": [59757]},
            "to": {"reference": "Bus", "ids": [59774]},
            "opened": [opened], "status": ["765 kV / OPEN" if opened else "765 kV / CLOSED"],
        }}},
        append(lower, loaded),
    ]})

    # asinh(df / 0.02), expressed with the CLI's ordinary GPU expression operators.
    # Use abs/sign to avoid cancellation in ln(x + sqrt(x*x+1)) for negative x.
    x = op("div", op("abs", "df"), 0.02)
    magnitude = op("ln", op("add", x, op("sqrt", op("add", op("mul", x, x), 1))))
    signed = {"when": [[op("lt", "df", 0), op("neg", magnitude)]], "otherwise": magnitude}
    height_scale = HEIGHT_GAIN * 1.7 * 0.15 * max(max(lon) - min(lon), max(lat) - min(lat))
    elevation = op("mul", signed, height_scale / math.asinh(0.35 / 0.02))
    theme = {"background": BACKGROUND, "text": "#c9d4dc", "font": "Segoe UI, sans-serif", "fontSize": 15}
    scenes = {
        "map.json": {
            "space": {"plane": {"grid": "off"}}, "ease": 0,
            "theme": {**theme, "edge": None, "laneBow": 0},
            "title": "ACTIVSg70k / Line opening",
            "subtitle": f"Little Rock - Newark, 765 kV / Opens at 1 s / Constant {SPEED:g}x speed",
            "marks": [
                {"lines": {"of": ["states", "polygons"], "color": "#5c7a8f6b", "width": 0.75,
                           "visible": op("not", op("or", {"is": ["name", "Alaska"]},
                                                   {"is": ["name", "Hawaii"]}))}},
                {"edges": {"of": ["grid", "Branch"], "ends": ["from", "to"], "width": "width", "visible": "in_service"}},
                {"edges": {"of": ["grid", "Outage"], "ends": ["from", "to"], "width": 2.5,
                           "color": "#ffde86", "dash": "opened",
                           "label": {"text": "status", "size": 13, "priority": 100}}},
                {"vertices": {"of": ["grid", "Bus"], "position": ["lon", "lat"], "radius": 0.8,
                              "elevation": elevation,
                              "color": {"colormap": {"kind": "diverging", "colors": PALETTE},
                                        "value": "df", "domain": [-0.2, 0.2]},
                              "label": {"text": "label", "size": 14, "priority": 101},
                              "legend": "Bus frequency deviation / Hz"}},
            ],
        },
        "map-camera.json": camera_at(frames[0]),
    }
    for name, scene in scenes.items():
        write(job / name, scene)

    with (job / "frames.jsonl").open("w", encoding="utf-8", newline="\n") as stream:
        for at in frames:
            lower, upper = bracket(at)
            patch = []
            if upper > loaded:
                # At t < 1, only the pre-switch sample at 1 s has been appended.
                # Append the second side only at/after the event, preventing anticipation.
                patch.append(append(loaded + 1, upper))
                patch.append({"forget": {"before": times[lower]}})
                loaded = upper
            if not opened and at >= EVENT:
                patch.extend([
                    {"set": {"table": "Branch", "ids": [BRANCH], "fields": {"in_service": [False]}}},
                    {"set": {"table": "Outage", "ids": [BRANCH], "fields": {"opened": [True], "status": ["765 kV / OPEN"]}}},
                ])
                opened = True
            frame = {"at": at, "camera": camera_at(at)}
            if patch:
                frame["patch"] = {"grid": patch}
            stream.write(json.dumps(frame, allow_nan=False) + "\n")
    return {"buses": n, "branches": len(branches),
            "event": {"branch": BRANCH, "action": "open", "at_s": EVENT},
            "frames": len(frames), "fps": FPS, "resolution": [W, H], "seconds": len(frames) / FPS,
            "playback_speed": SPEED,
            "simulation_start_s": frames[0], "simulation_end_s": frames[-1],
            "source_samples": len(times), "source_sample_hz": meta["nominal_sample_hz"],
            "frequency_sha256": sha256(frequency), "source_statistics": meta["statistics"],
            "estimator": meta["estimator"], "height_scale": height_scale,
            "height_gain": HEIGHT_GAIN, "camera_bearings_degrees": BEARINGS,
            "camera_start": camera_at(frames[0]), "camera_end": camera_at(frames[-1]),
            "height_formula": "height_scale * asinh(df / 0.02) / asinh(0.35 / 0.02)",
            "color_domain_hz": [-0.2, 0.2]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, default=ROOT / "target/branch-opening")
    parser.add_argument("--work", type=Path, default=ROOT / "target/branch-opening/render")
    parser.add_argument("--output", type=Path, default=EXAMPLE)
    parser.add_argument("--cli", default="latkit")
    parser.add_argument("--font", type=Path, help="TTF/OTF fallback; defaults to Segoe UI on Windows")
    parser.add_argument("--preview", action="store_true", help="render one PNG instead of the movie")
    parser.add_argument("--at", type=float, default=1.3, help="preview simulation time, seconds")
    parser.add_argument("--prepare-only", action="store_true", help="write CLI inputs and print the command")
    parser.add_argument("--limit", type=int, help="render the first N movie frames for a quick check")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    frames = [args.at] if args.preview else playback_times()
    if args.limit is not None:
        frames = frames[:args.limit]
    job, output = args.work.resolve(), args.output.resolve()
    started = time.perf_counter()
    metadata = prepare(args.source.resolve(), job, frames)
    output.mkdir(parents=True, exist_ok=True)
    result = output / ("preview.png" if args.preview else "animation.mp4")
    inputs = [str(job / "map.json"), "--data", str(job / "grid.json"),
              "--data", f"states={EXAMPLE / 'states.geojson'}",
              "--camera", str(job / "map-camera.json")]
    inputs.extend(["--at", str(args.at)] if args.preview else ["--frames", str(job / "frames.jsonl")])
    inputs.extend(["--deadline", "120"])
    font = args.font or (Path("C:/Windows/Fonts/segoeui.ttf") if os.name == "nt" else None)
    if font:
        inputs.extend(["--font", str(font)])
    render = [args.cli, "render", *inputs, "--size", f"{W}x{H}", "--fps", str(FPS),
              "--bitrate", "16000000", "--output", str(result)]
    print(subprocess.list2cmdline(render), flush=True)
    if args.prepare_only:
        return
    subprocess.run([args.cli, "validate", *inputs], check=True)
    render_started = time.perf_counter()
    subprocess.run(render, check=True)
    metadata.update({"render_seconds": time.perf_counter() - render_started,
                     "total_seconds": time.perf_counter() - started, "output_bytes": result.stat().st_size,
                     "command": [part.replace(str(ROOT), "<repo>").replace(os.sep, "/") for part in render]})
    write(output / ("preview.json" if args.preview else "animation.json"), metadata)
    print(f"Saved {result} ({metadata['output_bytes'] / 1e6:.2f} MB; {metadata['render_seconds']:.1f} s rendering)", flush=True)


if __name__ == "__main__":
    main()
