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
  import { Data, View, load, reference } from './node_modules/latkit/dist/index.js';

  await load();
  const grid = new Data('grid')
    .replace('Bus', {
      name: ['A', 'B', 'C', 'D', 'E', 'F'],
      x: [-160, -65, -65, 65, 65, 160], y: [0, 58, -58, 58, -58, 0],
    })
    .replace('Line', {
      from: reference('Bus', [0, 0, 1, 2, 2, 3, 4]),
      to:   reference('Bus', [1, 2, 3, 3, 4, 5, 5]),
    });

  await View.create(document.querySelector('#grid'), {
    space: { plane: { grid: 'off' } },
    theme: { flow: { color: '#ffce8b', width: 7 } },
    marks: [
      { edges: grid.table('Line'), ends: ['from', 'to'], color: '#527589', width: 2, flow: 64 },
      { vertices: grid.table('Bus'), position: ['$x', '$y'], radius: 8, color: '#65d6bb', label: '$name' },
    ],
  });
</script>
```

Start the local server. It opens the animated network in your browser.

```sh
npx --yes http-server . -a 127.0.0.1 -o
```
