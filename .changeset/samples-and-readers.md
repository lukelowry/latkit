---
'latkit': patch
---

A write read through a join or a reference evaluates only the rows reading it in tables of any size, and only scenes with areas multisample.

- Changed: a write to a table that a mark reads through `from` or `of` evaluates the pages of rows reading the rows written, also when the mark's table is drawn in pages. Before, a paged table evaluated every row it drew, and a table drawn whole evaluated the readers of every row in the written row's page of 4,096.
- Changed: frames take four samples a pixel only when the scene draws areas, and only on screens below a pixel ratio of 1.75. Vertices, edges, lines, text, and the backdrop antialias in their shaders, so any other scene draws one sample a pixel, keeps no multisampled targets, and reads the depth under the pointer without drawing it again.
- Changed: a scene with areas draws depth a second time only around the pointer on frames that answer a hover. Before, it drew the whole frame's depth again.
