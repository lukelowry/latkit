---
'latkit': patch
---

Views show only their own pixels, and arrowheads point somewhere.

- Fixed: where the browser gave the shared canvas a smaller drawing buffer than it asked for, as Chrome does on large high-density screens, the bottom rows of each view showed another view's pixels. The shared canvas now starts at the screen's size rather than the next power of two, and takes the size of the buffer it gets.
- Fixed: an arrowhead on an edge between two vertices at one place drew as a translucent square around them. An edge with no length on screen now has no head.
