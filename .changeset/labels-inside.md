---
'latkit': minor
---

A label too large for its block shows beside it, and text inside a marker reads on the marker's color.

- Fixed: a label on a block, or on a marker with a width and height, vanished without a word when its text did not fit inside. It now shows beside the marker, as a point's label does, and competes for room like one.
- Fixed: text inside a dark marker was hard to read, drawn in the theme's text color with a halo of the background. Text inside a marker now keeps a 4.5:1 contrast with the marker's color, made lighter or darker as it needs, and its halo is that color.
