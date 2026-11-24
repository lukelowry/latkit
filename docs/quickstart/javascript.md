# JavaScript

Animate six buses and seven lines in a browser with WebGL2. Gold comets follow each line from its first bus to its second.

```{image} ../images/six-bus-flow.png
:alt: Six buses joined by seven lines. Gold comets travel from bus A through the network toward bus F.
:class: picture
```

In an empty folder, install latkit with npm.

```sh
npm install latkit
```

Save this as `index.html` in that folder.

```{code-block} html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Six-bus network</title>
<canvas id="grid" width="720" height="360" style="max-width:100%">Six buses connected by seven lines</canvas>
<script type="module">
  import { View, load } from './node_modules/latkit/dist/index.js';

  await load();
  await View.create(document.querySelector('#grid'), {
    space: { plane: { grid: 'off' } },
    tables: {
      Bus: { fields: {
        name: ['A', 'B', 'C', 'D', 'E', 'F'],
        x: [-160, -65, -65, 65, 65, 160], y: [0, 58, -58, 58, -58, 0],
      } },
      Line: { fields: {
        from: { reference: 'Bus', ids: [0, 0, 1, 2, 2, 3, 4] },
        to:   { reference: 'Bus', ids: [1, 2, 3, 3, 4, 5, 5] },
      } },
    },
    theme: { flow: { color: '#ffce8b', width: 7 } },
    marks: [
      { edges: 'Line', ends: ['from', 'to'], color: '#527589', width: 2, flow: 64 },
      { vertices: 'Bus', position: ['$x', '$y'], radius: 8, color: '#65d6bb', label: '$name' },
    ],
  });
</script>
```

Start the local server. It opens the animated network in your browser.

```sh
npx --yes http-server . -a 127.0.0.1 -o
```
