"""Simulate the reference WECC240 fault with GridKit; compact the monitors for Latkit."""

import argparse
import csv
import hashlib
import json
import math
import re
import struct
import subprocess
import time
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parent
REPO = EXAMPLE.parents[3]
IMAGE = "ghcr.io/lukelowry/gridkit:develop-perf"
TAU = 0.02
EVENTS = [
    {"time": 1.0, "type": "fault_on", "bus": 4005, "R": 0.0, "X": 0.01},
    {"time": 1.15, "type": "fault_off", "bus": 4005},
]


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def simulate(work, image):
    work.mkdir(parents=True, exist_ok=True)
    source = EXAMPLE / "source.case.json"
    case = read(source)
    # Only monitor selection and monitor names change; physical inputs remain untouched.
    for bus in case["buses"]:
        bus["name"] = str(bus["number"])
        bus["mon"] = ["Vm", "Va"]
    for device in case["devices"]:
        device.pop("mon", None)
        if device["class"] == "Genrou":
            device["mon"] = ["omega"]
    for signal in case["signals"]:
        signal.pop("mon", None)
    (work / "case.json").write_text(json.dumps(case, separators=(",", ":")), encoding="utf-8")
    study = {
        "system_model_file": "case.json", "output_file": "monitor.csv",
        "dt_monitor": 1 / 240, "tmax": 10.0, "max_steps": 1_000_000,
        "rel_tol": 1e-7, "abs_tol": 1e-9, "events": EVENTS,
    }
    write(work / "study.json", study)
    info = json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]
    command = [
        "docker", "run", "--rm", "--pull=never", "--network=none", "--cpus", "2",
        "--env", "OMP_NUM_THREADS=2", "--env", "OPENBLAS_NUM_THREADS=1",
        "--mount", f"type=bind,source={work},target=/workspace",
        "--workdir", "/workspace", info["Id"], "DynamicSimulation", "study.json",
    ]
    started = time.perf_counter()
    with (work / "solver.log").open("wb") as log:
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    metadata = {
        "image": image, "image_id": info["Id"], "image_labels": info["Config"]["Labels"],
        "source": "ORNL/GridKit/cases/PhasorDynamics/WECC240/WECC240.case.json",
        "source_sha256": sha(source), "prepared_case_sha256": sha(work / "case.json"),
        "study": study, "exit_code": result.returncode,
        "simulation_wall_seconds": time.perf_counter() - started,
    }
    write(work / "simulation.json", metadata)
    if result.returncode:
        raise RuntimeError((work / "solver.log").read_text(errors="replace"))
    return metadata


def compact(work):
    metadata = read(work / "simulation.json")
    if metadata["exit_code"] != 0 or metadata["source_sha256"] != sha(EXAMPLE / "source.case.json"):
        raise ValueError("The saved simulation must match the included case and have completed successfully")
    case = read(EXAMPLE / "source.case.json")
    buses = case["buses"]
    machines = [d for d in case["devices"] if d["class"] == "Genrou"]
    ids = [b["number"] for b in buses]
    destination = EXAMPLE / "recording"
    destination.mkdir(exist_ok=True)
    times, duplicate_times = [], []
    frequency = [0.0] * len(ids)
    previous = None
    peaks = [0.0] * len(ids)
    machine_peaks = [0.0] * len(machines)
    voltage_min = [math.inf] * len(ids)
    pre_event_peak = 0.0
    with (work / "monitor.csv").open(newline="") as stream, \
            (destination / "frequency.f32").open("wb") as frequencies, \
            (destination / "voltage.f32").open("wb") as voltages, \
            (destination / "rotor.f32").open("wb") as rotors:
        rows = csv.reader(stream)
        header = next(rows)
        vm = [header.index(f"Bus_{i}_Vm") for i in ids]
        va = [header.index(f"Bus_{i}_Va") for i in ids]
        omega = [header.index(f"Genrou_{d['id']}_omega") for d in machines]
        for line in rows:
            row = [float(value) for value in line]
            if len(row) != len(header) or not all(math.isfinite(v) for v in row):
                raise ValueError("Malformed or nonfinite monitor row")
            at, theta = row[0], [row[i] for i in va]
            if previous is not None:
                dt = at - times[-1]
                if dt < 0:
                    raise ValueError("Monitor time reversed")
                delta = [(a - b + math.pi) % (2 * math.pi) - math.pi
                         for a, b in zip(theta, previous)]
                if dt == 0:
                    duplicate_times.append(at)
                    frequency = [f + d / (2 * math.pi * TAU) for f, d in zip(frequency, delta)]
                else:
                    decay = math.exp(-dt / TAU)
                    frequency = [decay * f + (1 - decay) * d / (2 * math.pi * dt)
                                 for f, d in zip(frequency, delta)]
            volts = [row[i] for i in vm]
            # GENROU omega is per-unit speed deviation, not absolute speed.
            rotor = [case["params"]["freq_base"] * row[i] for i in omega]
            for values, output in ((frequency, frequencies), (volts, voltages), (rotor, rotors)):
                output.write(struct.pack(f"<{len(values)}f", *values))
            peaks = [max(p, abs(f)) for p, f in zip(peaks, frequency)]
            machine_peaks = [max(p, abs(f)) for p, f in zip(machine_peaks, rotor)]
            voltage_min = [min(a, b) for a, b in zip(voltage_min, volts)]
            if at < 1:
                pre_event_peak = max(pre_event_peak, max(map(abs, frequency)))
            previous = theta
            times.append(at)
    if len(times) != 2403 or times[-1] != 10 or duplicate_times != [1.0, 1.15]:
        raise ValueError("Expected 240 Hz over 0–10 s, retaining both sides of both events")
    if pre_event_peak > 1e-5:
        raise ValueError("The pre-fault state did not remain at equilibrium")
    metadata.update({
        "bus_ids": ids, "machine_ids": [d["id"] for d in machines],
        "machine_bus_ids": [d["ports"]["bus"] for d in machines],
        "times": times, "samples": len(times), "sample_hz": 240,
        "dtype": "f32le", "layout": "frame-major", "duplicate_times": duplicate_times,
        "frequency_estimator": "20 ms causal filtered derivative of unwrapped bus voltage angle; event angle jumps retained",
        "frequency_filter_tau_s": TAU, "frequency_units": "Hz deviation from 60 Hz",
        "rotor_units": "GENROU omega * 60, Hz deviation from synchronous speed",
        "voltage_units": "per unit",
        "statistics": {
            "pre_fault_max_abs_frequency_hz": pre_event_peak,
            "bus_peak_abs_frequency_hz": peaks, "machine_peak_abs_frequency_hz": machine_peaks,
            "bus_min_voltage_pu": voltage_min,
        },
        "files": {name: {"bytes": (destination / name).stat().st_size, "sha256": sha(destination / name)}
                  for name in ("frequency.f32", "voltage.f32", "rotor.f32")},
    })
    write(destination / "metadata.json", metadata)
    log = re.sub(r"\x1b\[[0-9;]*m", "", (work / "solver.log").read_text())
    (EXAMPLE / "solver.txt").write_text(log, encoding="utf-8")
    print(f"Saved {len(times)} samples: {len(ids)} buses, {len(machines)} synchronous machines.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, default=REPO / "target/wecc240-fault")
    parser.add_argument("--image", default=IMAGE)
    parser.add_argument("--reuse", action="store_true", help="compact an existing successful run")
    args = parser.parse_args()
    work = args.work.resolve()
    if not args.reuse:
        simulate(work, args.image)
    compact(work)
