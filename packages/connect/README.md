# @latkit/connect

Carry a model across a WebSocket. One side offers a `Model` with `connectModel`, the other accepts
it with `acceptModel`, and either side may dial.

```sh
npm install @latkit/connect @latkit/model
```

```ts
import { connectModel } from '@latkit/connect';
import { selectBatches } from '@latkit/model';

let data = initialData;

const connection = await connectModel(
  {
    name: 'grid',
    schema: data.schema,
    monitor: (fields, { signal, maxBlockBytes }) =>
      selectBatches(data, fields, { signal, maxBlockBytes }),
    commands: {
      scale: {
        parameters: { multiplier: { type: 'number', min: 0, default: 1 } },
        run: ({ multiplier }) => {
          data = scaled(data, multiplier);
          return { multiplier };
        },
      },
    },
  },
  { url: 'ws://localhost:3000/grid' },
);
await connection.closed;
```

The accepting side, here on a socket a server accepted:

```ts
import { acceptModel } from '@latkit/connect';

const model = await acceptModel({ socket });
for await (const publication of model.monitor?.([{ from: 'Bus', select: ['load'] }]) ?? [])
  console.log(publication); // readonly DataBatch[]
await model.commands.scale.run({ multiplier: 2 });
await model.close();
```

[Guide](https://latkit.readthedocs.io/en/latest/ports-and-protocols.html) ·
[Wire format](PROTOCOL.md) ·
[API](https://latkit.readthedocs.io/en/latest/api/reference/connect/index.html)
