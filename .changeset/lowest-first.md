---
'latkit': patch
---

Where rows stand at different heights, a near line or marker thinner than a pixel shows over the rows behind it.

- Fixed: where depth varies, the pixels a line or marker covers only in part blended in table order, so a row behind could draw over a nearer one, and a raised line passing in front of many lower ones looked dotted. A mark whose rows stand at different heights now draws them lowest first, which is farthest first wherever they overlap, from any camera. A line sorts by its middle.
- Changed: rows at one height keep their table order, so tilting the camera changes only where rows appear. Moving the camera sorts nothing. Rows sort again only when their heights or the rows change.
- Changed: when the pointer is as near several rows of a mark, hover picks the one drawn on top.
