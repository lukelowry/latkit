"""A close orbit of the saved line-opening recording, rendered by the Latkit CLI.

Reuses the original example's data preparation without modifying it. Edit
camera.json to change the path; Python's standard library is sufficient.
"""

import argparse
import bisect
import importlib.util
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parent
ROOT = EXAMPLE.parent.parent
BASE = EXAMPLE.parent / "branch-opening"


def load_recipe():
    # Loading the shared recipe should not create files in the original example.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("branch_opening", BASE / "render.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def interpolate(times, values, at):
    """Monotone cubic Hermite: continuous velocity, no overshoot, soft endpoints."""
    i = min(max(bisect.bisect_right(times, at) - 1, 0), len(times) - 2)
    h = times[i + 1] - times[i]
    u = min(1, max(0, (at - times[i]) / h))

    def slope(k):
        if k == 0 or k == len(times) - 1:
            return 0.0
        before, after = times[k] - times[k - 1], times[k + 1] - times[k]
        a = (values[k] - values[k - 1]) / before
        b = (values[k + 1] - values[k]) / after
        if a * b <= 0:
            return 0.0
        w1, w2 = 2 * after + before, after + 2 * before
        return (w1 + w2) / (w1 / a + w2 / b)

    return ((2 * u**3 - 3 * u**2 + 1) * values[i]
            + (u**3 - 2 * u**2 + u) * h * slope(i)
            + (-2 * u**3 + 3 * u**2) * values[i + 1]
            + (u**3 - u**2) * h * slope(i + 1))


def camera_at(path, at):
    keys = path["keyframes"]
    times = [k["at"] for k in keys]
    sample = lambda values: interpolate(times, values, at)
    return {"center": [sample([k["center"][axis] for k in keys]) for axis in range(2)],
            "zoom": sample([math.log2(k["scale"]) for k in keys]),
            "pitch": sample([k["pitch"] for k in keys]),
            "bearing": sample([k["bearing"] for k in keys])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "target/branch-opening")
    parser.add_argument("--work", type=Path, default=ROOT / "target/branch-opening-orbit", help="generated CLI inputs")
    parser.add_argument("--output", type=Path, default=EXAMPLE, help="defaults to this example directory")
    parser.add_argument("--cli", default="latkit")
    parser.add_argument("--font", type=Path)
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--at", type=float, default=1.3, help="preview time in simulation seconds")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")

    recipe = load_recipe()
    path = recipe.read(EXAMPLE / "camera.json")
    keys = path["keyframes"]
    if len(keys) < 2 or any(b["at"] <= a["at"] for a, b in zip(keys, keys[1:])):
        parser.error("camera keyframes must have strictly increasing times")
    if any(k["scale"] <= 0 or not 0 <= k["pitch"] < 90 for k in keys):
        parser.error("camera scale must be positive, and pitch must be in [0, 90)")
    frames = [args.at] if args.preview else recipe.playback_times()
    if args.limit is not None:
        frames = frames[:args.limit]
    if frames[0] < keys[0]["at"] or frames[-1] > keys[-1]["at"]:
        parser.error("the camera path does not cover the requested simulation time")
    job = args.work.resolve()
    output = args.output.resolve()
    started = time.perf_counter()
    metadata = recipe.prepare(args.source.resolve(), job, frames)

    scene = recipe.read(job / "map.json")
    scene["title"] = f"ACTIVSg70k / {path['title']}"
    recipe.write(job / "map.json", scene)
    recipe.write(job / "map-camera.json", camera_at(path, frames[0]))
    sequence = [json.loads(line) for line in (job / "frames.jsonl").read_text().splitlines()]
    with (job / "frames.jsonl").open("w", encoding="utf-8", newline="\n") as stream:
        for frame in sequence:
            frame["camera"] = camera_at(path, frame["at"])
            stream.write(json.dumps(frame, allow_nan=False) + "\n")

    metadata.update({"shot": "orbit", "camera_path": path,
                     "camera_bearings_degrees": [k["bearing"] for k in keys],
                     "camera_start": camera_at(path, frames[0]), "camera_end": camera_at(path, frames[-1]),
                     "camera_interpolation": "monotone cubic Hermite; zoom interpolated logarithmically"})
    output.mkdir(parents=True, exist_ok=True)
    result = output / ("preview.png" if args.preview else "animation.mp4")
    inputs = [str(job / "map.json"), "--data", str(job / "grid.json"),
              "--data", f"states={BASE / 'states.geojson'}", "--camera", str(job / "map-camera.json"),
              "--deadline", "120"]
    inputs.extend(["--at", str(args.at)] if args.preview else ["--frames", str(job / "frames.jsonl")])
    font = args.font or (Path("C:/Windows/Fonts/segoeui.ttf") if os.name == "nt" else None)
    if font:
        inputs.extend(["--font", str(font)])
    render = [args.cli, "render", *inputs, "--size", f"{recipe.W}x{recipe.H}",
              "--fps", str(recipe.FPS), "--bitrate", "16000000", "--output", str(result)]
    print(subprocess.list2cmdline(render), flush=True)
    if args.prepare_only:
        return
    subprocess.run([args.cli, "validate", *inputs], check=True)
    render_started = time.perf_counter()
    subprocess.run(render, check=True)
    metadata.update({"render_seconds": time.perf_counter() - render_started,
                     "total_seconds": time.perf_counter() - started, "output_bytes": result.stat().st_size,
                     "command": [part.replace(str(ROOT), "<repo>").replace(os.sep, "/") for part in render]})
    recipe.write(output / ("preview.json" if args.preview else "animation.json"), metadata)
    print(f"Saved {result} ({metadata['output_bytes'] / 1e6:.2f} MB; {metadata['render_seconds']:.1f} s rendering)", flush=True)


if __name__ == "__main__":
    main()
