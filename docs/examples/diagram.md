# Diagram

```{image} ../images/diagram.png
:alt: A microgrid controller as blocks in nested groups, wired port to port with routed wires and a feedback loop
:class: picture
```

Blocks in nested groups, placed in layers by latkit's layered layout, with wires routed at right angles between their ports, a feedback loop, and a status ring.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. `node docs/gallery/render.ts diagram` draws it again.

```{literalinclude} ../gallery/diagram.ts
:language: typescript
```
