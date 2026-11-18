---
'latkit': patch
---

A path draws as one stroke: curved edges and other paths of several pieces no longer show a bead where two pieces meet.

- Fixed: both pieces of a path drew the pixels around the point where they met, so a translucent stroke darkened there. The beads showed along edges through bends and along great circles, and on lines and traces. They showed under a hover or selection glow, on rows a selection dims, on translucent colors, and faintly along thin strokes, whose antialiased edges are translucent. Comets brightened as they passed each point.
- Changed: where a path runs on through a point, the two pieces split its pixels along the line that halves the angle between them, and each draws only its side. Their quads no longer overlap there, so a curved edge and its glow shade fewer pixels. A turn too sharp for the pieces' lengths, as at a dense trace's spikes, keeps both pieces' round ends. An arrowhead is drawn whole.
