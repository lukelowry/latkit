# Performance

Each row shows the largest size tested in one Chrome benchmark on an NVIDIA GeForce RTX 2080 SUPER,
using WebGL2 through ANGLE on Direct3D 11. Times are in milliseconds.

- **Open** measures time from view creation to the first complete frame.
- **Frame** and **GPU** give median CPU and GPU time per frame. Each column reports the highest
  median across the measured drawing phases. GPU time excludes waits between commands.
- **Pick** reports the slower of the measured pick and hover times.

```{csv-table}
:file: _static/performance.csv
:header-rows: 1
:class: numbers
```

For workloads, hardware baselines, and instructions for reproducing the measurements, see
the [benchmark notes](https://github.com/lukelowry/latkit/tree/main/benchmark).
