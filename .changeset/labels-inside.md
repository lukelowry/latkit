---
'latkit': minor
---

A label too large for its marker shows beside it, and text inside a shape or block reads on its color.

- Fixed: a label on a block, or on a marker with a width and height, vanished when its text did not fit inside. It now shows beside the marker and competes for room like a point's label.
- Changed: text inside a shape or block keeps a 4.5:1 contrast with the row's color, lighter or darker as it needs, and its halo is that color.
- Fixed: where markers holding labels overlapped, every label inside them showed, over each other and over the markers drawn above. A label inside a marker now takes the marker's room, so only the top one's label shows.
