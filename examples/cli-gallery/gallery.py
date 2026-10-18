"""Write the CLI gallery's datasets and scenes as latkit JSON, and render each with the CLI.

    python examples/cli-gallery/gallery.py --cli target/cli/latkit

Every picture is drawn by latkit, titles included, with no postprocessing. The data is synthetic.
"""

import argparse
import json
import math
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
TAU = 2 * math.pi
# Every picture frames the same box, whatever its geometry.
FRAME = {"bounds": {"min": [-760, -460, 0], "max": [760, 460, 0]}}


def rounded(values, digits=3):
    return [round(v, digits) for v in values]


def put(table, ids, fields):
    return {"put": {"table": table, "ids": ids, "fields": fields}}


def scene(title, subtitle, marks):
    return {
        "space": {"plane": {"grid": "off"}}, "ease": 0,
        "theme": {"background": "#080f1c", "text": "#c7d5e4", "font": "sans-serif", "fontSize": 13,
                  "halo": 0, "flow": "#d9fff0a0", "flowSpacing": 100},
        "title": title, "subtitle": subtitle, "marks": marks,
    }


def helios():
    x, y, heat, radius, names, start, end = [], [], [], [], [], [], []
    for ring in range(5):
        for node in range(96):
            angle = node * TAU / 96 + ring * 0.075
            r = 92 + ring * 55 + 8 * math.sin(angle * 6)
            x.append(190 + r * math.cos(angle))
            y.append(-35 + r * math.sin(angle))
            heat.append(0.25 + 0.7 * math.sin(angle * 0.5 + ring * 0.3) ** 2)
            radius.append(5 if node % 12 == 0 else 2.3)
            names.append(f"S{node // 12 + 1:02}" if ring == 4 and node % 12 == 0 else "")
            here = ring * 96 + node
            start.append(here)
            end.append(ring * 96 + (node + 1) % 96)
            if ring > 0:
                start.append(here)
                end.append((ring - 1) * 96 + (node + 3) % 96)
            if ring == 0 and node % 3 == 0:
                start.append(here)
                end.append((node + 37) % 96)
    notes = ["480 BUSES", "896 BRANCHES", "Five concentric regions", "One connected system", "Synthetic topology / 01"]
    data = [
        put("Bus", len(x), {"x": rounded(x), "y": rounded(y), "heat": rounded(heat), "radius": radius, "name": names}),
        put("Branch", len(start), {"from": {"reference": "Bus", "ids": start}, "to": {"reference": "Bus", "ids": end}}),
        put("Note", len(notes), {"x": [-660] * 5, "y": [200, 155, 80, 35, -40], "text": notes}),
    ]
    marks = [
        {"edges": {"of": ["art", "Branch"], "ends": ["from", "to"], "width": 0.85, "flow": 18}},
        {"vertices": {"of": ["art", "Bus"], "position": ["x", "y"], "radius": "radius",
                      "color": {"colormap": "heat", "map": "viridis", "domain": [0, 1]},
                      "label": {"text": "name", "size": 13, "color": "#c0e5dd"}}},
        {"vertices": {"of": ["art", "Note"], "position": ["x", "y"], "radius": 0, "color": "#00000000",
                      "label": {"text": "text", "size": 17, "color": "#9dcabf"}}},
    ]
    return data, scene("01 / HELIOS", "Flow through a synthetic transmission network", marks)


def interference():
    x, y, heat, radius = [], [], [], []
    for row in range(140):
        for column in range(240):
            px = column / 239 * 1280 - 640
            py = row / 139 * 560 - 315
            a = math.sin(math.hypot(px + 260, py + 20) * 0.035)
            b = math.cos(math.hypot(px - 240, py - 10) * 0.045)
            value = (a + b + 2) * 0.25
            x.append(px + 9 * math.sin(py * 0.022))
            y.append(py + 13 * math.sin(px * 0.016 + py * 0.01))
            heat.append(0.18 + value * 0.82)
            radius.append(0.8 + value * 1.7)
    data = [put("Particle", len(x), {"x": rounded(x, 2), "y": rounded(y, 2), "heat": rounded(heat), "radius": rounded(radius)})]
    marks = [{"vertices": {"of": ["art", "Particle"], "position": ["x", "y"], "radius": "radius",
                           "color": {"colormap": "heat", "map": "magma", "domain": [0, 1]}}}]
    return data, scene("02 / INTERFERENCE", "33,600 particles / two wave sources / one interference field", marks)


def tides():
    paths, levels = [], []
    for contour in range(100):
        level = contour / 99
        r = 55 + 250 * level
        path = []
        for step in range(481):
            a = step / 480 * TAU
            ripple = 1 + 0.12 * math.sin(a * 3 + level * 5) + 0.07 * math.cos(a * 7 - level * 4)
            path.append([round(95 + 1.65 * r * ripple * math.cos(a), 2), round(-35 + 0.83 * r * ripple * math.sin(a), 2)])
        paths.append(path)
        levels.append(round(level, 4))
    data = [put("Contour", len(paths), {"geometry": paths, "level": levels})]
    marks = [{"lines": {"of": ["art", "Contour"], "width": 1.15,
                        "color": {"colormap": "level", "map": "turbo", "domain": [0, 1]}}}]
    return data, scene("03 / TIDAL FORMS", "100 closed contours / 48,100 coordinates / harmonic geometry", marks)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cli", default="latkit", help="the latkit executable")
    parser.add_argument("--font", help="a font file for every text; system fonts otherwise")
    args = parser.parse_args()
    for name, make in (("helios", helios), ("interference", interference), ("tides", tides)):
        patch, picture = make()
        data, scene_path, image = HERE / f"{name}.data.json", HERE / f"{name}.json", HERE / f"{name}.png"
        document = json.dumps({"name": "art", "patch": patch}, separators=(",", ":"))
        data.write_text(document + "\n", encoding="utf-8", newline="\n")
        scene_path.write_text(json.dumps(picture, indent=2) + "\n", encoding="utf-8", newline="\n")
        command = [args.cli, "render", str(scene_path), "--data", str(data), "--output", str(image),
                   "--size", "1600x1000", "--elapsed", "1.25", "--fit", json.dumps(FRAME)]
        if args.font:
            command += ["--font", args.font]
        subprocess.run(command, check=True)
        print(image.relative_to(HERE.parents[1]).as_posix())


if __name__ == "__main__":
    main()
