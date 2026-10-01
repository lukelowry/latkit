# Video example

Run `pnpm --filter @latkit/video-example dev` and open http://localhost:5194.
The main page exports network, monitor, and a shared GPU composition. Each output
is decoded at three times to check dimensions, duration, visible content, and animation.
Downloads and playback use an OPFS-backed file; output bytes are not accumulated in RAM.
The worker, GPU, retained sources, and destination belong to this application.

Open `/check.html` for the real WebCodecs/WebGPU correctness and scaling fixture.
It verifies MP4/WebM pixels, progressive completion, fractional final frames,
composition ownership, slow output, cancellation, encoder cleanup, and 1080p
exports at two durations. The detailed workload changes every pixel block each
frame. GPU statistics measure Latkit-owned resources, not total browser/codec memory.

WebGPU and the selected browser encoders are required. Unsupported encoding
configurations fail before the exporter acquires a destination or capture target.
