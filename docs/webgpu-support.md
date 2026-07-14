# WebGPU support

_Updated 2026-07-13._

Vendor WebGPU availability and Latkit verification are different claims. A
browser may implement WebGPU while `navigator.gpu` is unavailable or
`requestAdapter()` returns `null` on a particular machine because of the browser
version, operating system, secure-context requirement, graphics settings, GPU,
driver, blocklist, or repeated GPU-process failures. A row is a Latkit support
claim only when its final column is `✅`.

## Status legend

- `✅ Hardware verified` — the current Latkit browser suite passed in the named
  stable, branded browser and exact hardware configuration without unsafe or
  experimental flags, with revision-bound evidence archived.
- `🧪 Engine verified` — the suite passed only in a Playwright browser build,
  software adapter, or forced/flagged configuration. This proves renderer
  correctness, not end-user hardware support.
- `❌ Unsupported` — the configuration cannot meet a required Latkit capability
  or Latkit deliberately does not provide that backend.
- `— Not verified` — no qualifying Latkit run is recorded. This makes no support
  claim, even when the browser vendor ships WebGPU.

## Tested configurations

The checks below cover `@latkit/network`, `@latkit/monitor`, pointer interaction,
one device shared by all three views, borrower teardown, device loss, and clean
reacquisition. Chrome and Edge passed both headed and new-headless runs. Headed
browser probes identified the NVIDIA/Turing adapter; Chromium's GPU-process
report identified the same renderer and reported WebGPU enabled. All Core probes
reported a non-fallback adapter and `maxStorageBuffersInVertexStage = 8`.
Component checkmarks below are local observations. Because this working tree is
not committed and its report is not in an immutable archive, Chrome and Edge
remain `—` as formal Latkit support claims until the same run is repeated against
the committed revision.

| Browser                           | Operating system                 | GPU and driver                              | Network | Monitor | Shared device and recovery | Evidence                       | Status |
| --------------------------------- | -------------------------------- | ------------------------------------------- | :-----: | :-----: | :------------------------: | ------------------------------ | :----: |
| Google Chrome 150.0.7871.115      | Windows 11 Enterprise 10.0.26200 | NVIDIA GeForce RTX 2080 SUPER, 32.0.15.9186 |   ✅    |   ✅    |             ✅             | Local working tree, 2026-07-13 |   —    |
| Microsoft Edge 150.0.4078.65      | Windows 11 Enterprise 10.0.26200 | NVIDIA GeForce RTX 2080 SUPER, 32.0.15.9186 |   ✅    |   ✅    |             ✅             | Local working tree, 2026-07-13 |   —    |
| Playwright Chromium 149.0.7827.55 | Windows 11 Enterprise 10.0.26200 | NVIDIA GeForce RTX 2080 SUPER, 32.0.15.9186 |   🧪    |   🧪    |             🧪             | Local working tree, 2026-07-13 |   🧪   |

These observations cover only the exact configurations shown; they do not imply
that every Windows GPU or driver works.

## Availability and verification backlog

The version in the middle column is a vendor implementation baseline, not a
Latkit minimum-version promise.

| Browser or platform                                        | Vendor-documented WebGPU availability                                                                                                              | Latkit status |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | :-----------: |
| Other Chrome configurations on Windows, macOS, or ChromeOS | Chrome 113 shipped WebGPU on Windows/D3D12, macOS, and ChromeOS/Vulkan. Per-machine blocklists still apply.                                        |       —       |
| Other Edge configurations                                  | Edge follows Chromium's WebGPU implementation, but browser policy, GPU, driver, settings, and blocklists remain machine-specific.                  |       —       |
| Chrome on Android                                          | Chrome 121 initially enabled Android 12+ devices with Qualcomm or Arm GPUs; availability remains device-dependent.                                 |       —       |
| Chrome on Linux, Intel                                     | Chrome 144 began a Vulkan rollout for Intel Gen12+ GPUs.                                                                                           |       —       |
| Chrome on Linux, NVIDIA                                    | Chrome 147–148 expanded the rollout to Wayland systems with modern NVIDIA drivers.                                                                 |       —       |
| Chrome on Linux, AMD                                       | The Chrome 144 announcement described AMD support as planned rather than shipped.                                                                  |       —       |
| Firefox on Windows                                         | WebGPU shipped in Firefox 141.                                                                                                                     |       —       |
| Firefox on Apple Silicon macOS                             | WebGPU shipped in Firefox 147.                                                                                                                     |       —       |
| Firefox on Linux, Intel macOS, or Android                  | Linux and Intel macOS remain Nightly-only; Mozilla has not shipped Android support.                                                                |       —       |
| Safari on Apple platforms                                  | Safari 26 shipped WebGPU on macOS, iOS, iPadOS, and visionOS.                                                                                      |       —       |
| Electron and VS Code webviews                              | Availability depends on the embedded Chromium build and the host's GPU, driver, settings, and blocklists. It is not inherited from desktop Chrome. |       —       |

Primary implementation sources: [WebGPU implementation
status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), [Chrome
113 launch](https://developer.chrome.com/blog/webgpu-release), [Chrome 121 on
Android](https://developer.chrome.com/blog/new-in-webgpu-121), [Chrome 144 on
Linux](https://developer.chrome.com/blog/new-in-webgpu-144), [Chrome 147–148 on
Linux](https://developer.chrome.com/blog/new-in-webgpu-147-148), [Firefox 141
release notes](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141),
[Firefox's current platform
status](https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features),
and [Safari 26 WebGPU](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

## Requirements and deliberate exclusions

Latkit requires a secure browser context, DOM canvas rendering, and **Core
WebGPU**. The [WebGPU specification](https://gpuweb.github.io/gpuweb/) gives
Compatibility Mode a default `maxStorageBuffersInVertexStage` limit of `0`.
Network needs at least `3`; Monitor needs at least `2`.

| Capability or backend                         |  Network   |  Monitor   |                    Status                    |
| --------------------------------------------- | :--------: | :--------: | :------------------------------------------: |
| Core `GPUDevice` supplied by the application  |     ✅     |     ✅     |                Supported API                 |
| Core vertex-stage storage buffers             | At least 3 | At least 2 |                   Required                   |
| WebGPU Compatibility Mode without Core limits |     ❌     |     ❌     |                 Unsupported                  |
| WebGL2 renderer                               |     ❌     |     ❌     |               Not implemented                |
| Canvas 2D renderer                            |     ❌     |     ❌     |               Not implemented                |
| Worker or `OffscreenCanvas` target            |     ❌     |     ❌     | Public factories require `HTMLCanvasElement` |
| Automatic renderer fallback                   |     ❌     |     ❌     |          Application responsibility          |

Checking only `navigator.gpu` is insufficient. Support requires successful Core
adapter and device acquisition plus a rendered result.

## What the browser suite proves

[`sharing.webgpu.spec.ts`](https://github.com/lukelowry/latkit/blob/main/tests/browser/sharing.webgpu.spec.ts)
is the support gate. It fails instead of skipping when Core WebGPU is
unavailable and verifies:

1. Core API, adapter, and device acquisition.
2. Relevant feature and limit reporting.
3. Meaningful non-background pixels from Network and two Monitors.
4. Network selection and Monitor picking through real pointer input.
5. One native device shared by every renderer.
6. Destroying one Monitor preserves its caller-owned canvas and leaves Network
   and the sibling Monitor rendering.
7. Device loss reaches every live borrower exactly once.
8. A fresh device remounts and renders every view.
9. No uncaptured WebGPU validation errors.

The test attaches the user agent, platform, features and limits from the exact
`GPUDevice` used by the renderers, fallback status, project/channel/headless
mode/launch flags, Git commit and local diff, Chromium GPU inventory and feature
status, screenshots, and pixel histograms. Each run starts a fresh fixture
server. Both local and CI runs retain the attachments in the Playwright HTML
report under `output/playwright`.
Semantic pixel invariants are used instead of exact golden images because
[Playwright documents](https://playwright.dev/docs/test-snapshots)
that screenshots vary across operating systems, browsers, hardware, power
settings, and headless mode.

The complete test strategy has three deliberately different layers:

| Layer                                                | What it proves                                                                                                               | Release use                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Vitest with recording GPU doubles                    | Acquisition failures, exact request options, transactional cleanup, borrowed ownership, multiple borrowers, and loss fan-out | Required on every change                  |
| Full Playwright Chromium with Linux WebGPU flags     | Real WGSL compilation, resource binding, pixels, interaction, sharing, and recovery on an engine/software lane               | Required, but earns only `🧪`             |
| Unflagged stable branded browser on labeled hardware | The exact browser/OS/GPU/driver row works                                                                                    | Required before adding or refreshing `✅` |

Run the lanes with:

```sh
pnpm exec playwright install chromium
pnpm test:browser
pnpm test:browser:chrome
pnpm test:browser:edge
pnpm exec playwright test --project=chrome-hardware --project=edge-hardware --headed
```

`test:browser` uses Playwright's full Chromium browser in new headless mode. On
Linux CI it adds [Chrome's documented Vulkan/headless
flags](https://developer.chrome.com/blog/supercharge-web-ai-testing). That lane
may use SwiftShader and bypasses the adapter blocklist, so it can earn only
`🧪`.
`test:browser:chrome` and `test:browser:edge` launch installed stable branded
browsers without WebGPU flags. Those projects require a non-fallback adapter and
may earn `✅` when their artifacts identify a hardware-backed run.

## How to add a supported platform

Use a labeled physical or self-hosted machine. [Standard GitHub-hosted runner
specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
do not promise a browser-accessible GPU, so their passing result cannot earn
`✅`.

For each candidate row:

1. Use the stable branded browser with no unsafe, compatibility, or blocklist-
   bypass flags.
2. Record the Latkit commit, date, browser version, OS version, GPU, driver,
   WebGPU backend when the browser exposes it, launch flags, adapter fallback
   status, relevant limits, and archived Playwright report. A local uncommitted
   verification must be refreshed after the evidence-bearing commit before
   publication.
3. Run the complete suite. An absent or null Core adapter is a failed row, not a
   skipped test.
4. Repeat after renderer or shader changes and on each browser major version
   retained in the table.
5. Change `—` to `✅` only after that evidence is reviewed.

Playwright can run branded Chrome and Edge. Its Firefox build is patched and is
not branded Firefox; its WebKit build tracks WebKit main and is not Safari.
[Playwright documents these
distinctions](https://playwright.dev/docs/browsers). Use Mozilla WebDriver or
Marionette for exact Firefox rows and `safaridriver` on physical Apple hardware
for Safari. Android verification must use a real supported device rather than
desktop device emulation. Electron and VS Code must run the same assertions in
their actual webview because the embedded Chromium and GPU policy are separate.

The [WebGPU CTS](https://gpuweb.github.io/cts/) is valuable for diagnosing a
browser implementation, but it does not prove that Latkit's shaders, resources,
interactions, or ownership lifecycle work and cannot replace this suite.
