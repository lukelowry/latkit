# Diagram

```{image} ../images/diagram.png
:alt: A microgrid controller as blocks in nested groups, with wires routed port to port and a feedback loop
:class: picture
```

Blocks in nested groups, placed by latkit's layered layout. Wires run at right angles between their ports, with a feedback loop and a status ring.

The `latkit` command line draws this picture from the module below, which builds its datasets
with `Data` and returns its scene. Run `node docs/gallery/render.ts diagram` to draw it again.

```{literalinclude} ../gallery/diagram.ts
:language: typescript
```
