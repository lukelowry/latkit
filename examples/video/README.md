# Video example

Export a network to MP4 and a monitor to WebM in a worker, then decode each result.

```sh
pnpm install
pnpm --filter @latkit/video-example dev
```

Open http://127.0.0.1:5194. The dev command builds the packages first. `/check.html` runs real
codec, cancellation, and scaling checks.
