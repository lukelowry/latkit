---
'latkit': patch
---

Videos in a browser take each frame straight from the GPU.

- Changed: the npm package's WebCodecs encoder takes each frame from latkit's GPU canvas as soon as it is drawn, and the browser converts it for the encoder on the GPU. No frame is composed into NV12 or read back, and the first frame waits on no read. An encoder given to `setEncoder` without `encodeCanvas` still gets NV12 pictures.
- Changed: the encoder starts configuring as the video begins, so probing the browser's encoders overlaps drawing the first frame.
