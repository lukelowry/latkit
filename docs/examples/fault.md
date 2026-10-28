# ACTIVSg25k fault

```{image} ../images/fault.png
:alt: The ACTIVSg25k grid as a dim web, half a second into a fault at a red bus near New York. Corridors of branches spreading southwest from it glow amber and white where their flow changed most
:class: picture
```

Half a second after a fault at bus 69645, cleared at 1.15 s, ACTIVSg25k swings as it recovers.
Each branch whose real power changed lights up by how much, as the simulation recorded it, with
comets running the way the change runs.

<video class="picture" src="../_static/videos/fault.mp4" controls loop muted playsinline preload="metadata"></video>

The film plays the simulation's first ten seconds at half speed.

The `latkit` command line drew this picture and film from a simulation recording too large for
the repository.
