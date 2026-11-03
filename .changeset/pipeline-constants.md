---
'latkit': patch
---

Every pipeline builds in Safari and other WebKit browsers, and a pipeline a browser refuses to build is an error instead of a blank view.

- Changed: pipelines pass no pipeline constants. Each pipeline's shader declares the values it is built for as constants in its own code. WebKit, which every iPad and iPhone browser uses, refused pipelines given constants their stages don't read, so views there drew only their background.
- Changed: when a browser refuses to build a pipeline a view needs, the view reports an `unsupported` error that names the pipeline and gives the browser's reason. It draws nothing, so the other views keep drawing, and `done()` and pictures of it fail with that error.
