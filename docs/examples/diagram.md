# Diagram

```{image} ../images/diagram.png
:alt: A microgrid controller as blocks in nested groups, wired port to port with routed wires and a feedback loop
:class: picture
```

Blocks in nested groups, placed in layers by latkit's own layout, wires routed at right angles between their ports, a feedback loop, and a status ring.

The picture is drawn by the `latkit` command line from this module, which writes its data with
`Patch` and its scene as a typed `Scene`; `node docs/gallery/render.ts diagram` draws it again.

```{literalinclude} ../gallery/diagram.ts
:language: typescript
```
