# Browser conformance

| Command                     | Coverage                                           |
| --------------------------- | -------------------------------------------------- |
| `pnpm test:browser`         | Chromium engine and full renderer suite            |
| `pnpm test:browser:engines` | Chromium plus Firefox and WebKit capability probes |
| `pnpm test:browser:chrome`  | Stable Chrome on local hardware                    |
| `pnpm test:browser:edge`    | Stable Edge on local hardware                      |
| `pnpm test:browser:firefox` | Stable Firefox through WebDriver                   |
| `pnpm test:browser:safari`  | Stable Safari through WebDriver                    |

Playwright Firefox and WebKit are engine probes. Stable Firefox and Safari are
the hardware support gates.

The manual `Browser hardware` workflow expects interactive self-hosted runners
with these labels:

| Platform | Labels                                    | Preparation                                                 |
| -------- | ----------------------------------------- | ----------------------------------------------------------- |
| Windows  | `self-hosted`, `Windows`, `X64`, `webgpu` | Install current stable Chrome, Edge, and Firefox            |
| macOS    | `self-hosted`, `macOS`, `ARM64`, `webgpu` | Install current Safari and run `safaridriver --enable` once |

Playwright evidence is written under `output/playwright`; WebDriver evidence is
written under `output/webdriver`.
