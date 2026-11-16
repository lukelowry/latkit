---
'latkit': patch
---

Edges joining the same two vertices no longer rebuild their list on every frame their vertices or the camera move.

- Changed: a mark whose edges bow into lanes lists their pieces again only when its rows or their lanes change. Before, one pair of parallel edges made the whole mark rebuild its list on every frame a vertex moved, and on every frame the camera moved over a tilted plane or the globe. Each such frame also drew the list's whole reserve: 1.8 million instances instead of 200,000 for a graph of 83,000 edges.
- Changed: a family of more than eight parallel edges still follows its ends and the camera, since its list keeps only the lanes the screen shows apart.
- Changed: the list holds room for the rows that bow. Before, it held sixteen pieces for every row of the mark.
- Changed: with `theme.edge.bow` 0, no lanes are derived. Edges joining the same two vertices draw straight, one over another, one instance each, and each is picked as its own row.
