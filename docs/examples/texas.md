# Map generation by bus

```{image} ../images/texas.png
:alt: Amber disks show generation at buses on the ACTIVSg2000 network in Texas.
:class: picture
```

Disk area represents total active power generation at each bus (MW). Labels identify buses at or above the tenth-highest bus total. Line color and width show voltage class. Moving marks highlight lines at 345 kV and above, all at the same animation speed.

```sh
node docs/gallery/render.ts texas
```

```{literalinclude} ../gallery/texas.ts
:language: typescript
```
