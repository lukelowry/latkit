# WebGPU compatibility

## Renderer support

| Rendering path            | Network | Monitor |
| ------------------------- | :-----: | :-----: |
| Core WebGPU               |    ✓    |    ✓    |
| WebGPU Compatibility Mode |    ✗    |    ✗    |
| WebGL                     |    ✗    |    ✗    |
| Canvas 2D                 |    ✗    |    ✗    |
| Worker / OffscreenCanvas  |    ✗    |    ✗    |

## Browser and OS verification

| Browser | Windows | macOS | Linux | Android | iOS / iPadOS |
| ------- | :-----: | :---: | :---: | :-----: | :----------: |
| Chrome  |    ✓    |   ✗   |   ✗   |    ✗    |      ✗       |
| Edge    |    ✓    |   ✗   |   ✗   |    ✗    |      ✗       |
| Firefox |    ✗    |   ✗   |   ✗   |    ✗    |      ✗       |
| Safari  |    ✗    |   ✗   |   ✗   |    ✗    |      ✗       |

## Hardware verification

| Hardware                          | Chrome | Edge | Firefox | Safari |
| --------------------------------- | :----: | :--: | :-----: | :----: |
| Windows / NVIDIA RTX 2080 SUPER   |   ✓    |  ✓   |    ✗    |   ✗    |
| Windows / Intel GPU               |   ✗    |  ✗   |    ✗    |   ✗    |
| Windows / AMD GPU                 |   ✗    |  ✗   |    ✗    |   ✗    |
| macOS / Apple Silicon             |   ✗    |  ✗   |    ✗    |   ✗    |
| Android / Qualcomm Adreno         |   ✗    |  ✗   |    ✗    |   ✗    |
| Android / Arm Mali                |   ✗    |  ✗   |    ✗    |   ✗    |
| iPhone / iPad                     |   ✗    |  ✗   |    ✗    |   ✗    |
| Linux / Intel, AMD, or NVIDIA GPU |   ✗    |  ✗   |    ✗    |   ✗    |
