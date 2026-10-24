/** Checked-in reference snapshots let Read the Docs build with Python alone. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

/** Each declaration of `file` by name, as its signature. */
function declarations(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Map();
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isEmptyStatement(node))
      continue;
    const name =
      node.name?.getText(source) ??
      (ts.isVariableStatement(node)
        ? node.declarationList.declarations[0].name.getText(source)
        : undefined);
    if (!name) continue;
    const signature = printer
      .printNode(ts.EmitHint.Unspecified, node, source)
      .replace(/\bexport declare /g, '')
      .replace(/\bexport /g, '')
      .replace(/^declare /gm, '')
      .replace(/^\s*(?:#private;|private .*;)\s*$/gm, '')
      .trim();
    // An overloaded function's signatures, each in turn.
    found.set(name, found.has(name) ? `${found.get(name)}\n${signature}` : signature);
  }
  return found;
}

/**
 * A page of `files`' declarations under `head`, in `sections`: each a heading, what it holds, and
 * its declarations in reading order. Every declaration is in one section, so none goes unlisted.
 */
function page(head, files, sections) {
  const all = new Map(files.flatMap((file) => [...declarations(file)]));
  const listed = sections.flatMap(([, , names]) => names);
  const unlisted = [...all.keys()].filter((name) => !listed.includes(name));
  const missing = listed.filter((name) => !all.has(name));
  assert.deepEqual(unlisted, [], `npm/docs.mjs lists no section for ${unlisted.join(', ')}`);
  assert.deepEqual(missing, [], `npm/docs.mjs lists what the package lacks: ${missing.join(', ')}`);
  return (
    head +
    sections
      .map(
        ([title, about, names]) =>
          `## ${title}\n\n${about}\n\n` +
          names.map((name) => `### ${name}\n\n\`\`\`ts\n${all.get(name)}\n\`\`\`\n`).join('\n'),
      )
      .join('\n')
  );
}

const pages = {
  'api.md': page(
    '# JavaScript API\n\nGenerated from the shipped declarations. `load()` loads the WebAssembly that datasets, views,\nand pictures are made with; scenes, expressions, and patches need none. Options take the [scene\nand result types](types.md).\n\n',
    ['load', 'internal', 'data', 'patch', 'scene', 'colormap', 'gpu', 'view', 'canvas', 'shot'].map(
      (name) => `npm/dist/${name}.d.ts`,
    ),
    [
      [
        'Loading and waiting',
        'Load the WebAssembly once a page; every wait ends at its signal.',
        ['load', 'LoadOptions', 'Wait', 'LatkitError'],
      ],
      [
        'Data and patches',
        'Datasets of named tables, changed by patches written without WebAssembly, and what views draw them from.',
        [
          'Data',
          'Snapshot',
          'Tiles',
          'Source',
          'DataSource',
          'QueryResult',
          'Envelope',
          'Patch',
          'PatchSource',
          'RowIds',
          'Values',
          'Geometry',
          'Reference',
          'reference',
          'Fields',
          'ReadableBytes',
        ],
      ],
      [
        'Expressions',
        'What varies by row: builders writing the expressions and colors scenes take.',
        [
          'Expr',
          'ExprInput',
          'Mapped',
          'Missing',
          'Paint',
          'PaintInput',
          'Colormapped',
          'Color',
          'field',
          'color',
          'missing',
          'when',
          'When',
          'Then',
          'Next',
          'InputOf',
          'px',
          'units',
          'Within',
          'selected',
          'hovered',
          'pointer',
          'zoom',
          'elapsed',
          'icon',
          'RgbaImage',
          'colormapCss',
        ],
      ],
      [
        'Views',
        'A GPU makes views, and canvases that show them.',
        [
          'Gpu',
          'View',
          'ViewOptions',
          'ViewEvents',
          'Insets',
          'Point',
          'Position',
          'Canvas',
          'CanvasOptions',
          'Panel',
          'Rect',
        ],
      ],
      [
        'Pictures and video',
        'Shots draw views into images and video.',
        ['Shot', 'ShotOptions', 'Image', 'ImageFormat', 'Video'],
      ],
    ],
  ),
  'types.md': page(
    '# Scene and result types\n\nGenerated from the same schema as the package types. Each field documents its meaning and defaults.\n\n',
    ['inputs', 'outputs'].map((name) => `npm/src/${name}.ts`),
    [
      [
        'Scenes',
        'A scene: its space, how it answers input, and how it is laid out.',
        [
          'Scene',
          'Space',
          'Plane',
          'Earth',
          'Projection',
          'Diagram',
          'Plot',
          'Axis',
          'Tick',
          'Format',
          'Grid',
          'Controls',
          'Motion',
          'Zoom',
          'Layout',
          'Layered',
          'Stress',
          'Direction',
          'Order',
          'Budget',
        ],
      ],
      [
        'Themes',
        'How a scene looks, a group for each kind of thing it draws, and the lengths its options take.',
        [
          'Theme',
          'TextTheme',
          'VertexTheme',
          'EdgeTheme',
          'LineTheme',
          'AreaTheme',
          'FlowTheme',
          'FocusTheme',
          'DiagramTheme',
          'ShadowTheme',
          'EarthTheme',
          'PlotTheme',
          'Length',
        ],
      ],
      [
        'Marks',
        'What a scene draws each table as.',
        [
          'Mark',
          'Vertices',
          'Edges',
          'Lines',
          'Areas',
          'Faces',
          'Marker',
          'Shape',
          'Bitmap',
          'Port',
          'Side',
          'Route',
          'Interpolation',
          'Label',
          'Size',
          'Px',
          'Units',
        ],
      ],
      [
        'Expressions',
        'Expressions as JSON: a constant, a field, or a node of these kinds; and colors, which take CSS strings where values take field names.',
        [
          'ExprNode',
          'PaintNode',
          'FieldNode',
          'ColorNode',
          'StateNode',
          'MissingNode',
          'UnaryNode',
          'BinaryNode',
          'WhenNode',
          'WhenPaintNode',
          'IsNode',
          'ContainsNode',
          'ScaleNode',
          'ColormapNode',
          'Unary',
          'Binary',
          'State',
          'Colormap',
          'ColormapName',
          'ColormapKind',
          'CustomColormap',
        ],
      ],
      [
        'Rows, cameras, and queries',
        'Naming rows, framing them, and asking for them.',
        ['Id', 'Ids', 'Row', 'Rows', 'Camera', 'Fit', 'Query', 'EnvelopeRequest'],
      ],
      [
        'Results',
        'What views tell: events, hits, descriptions, and what frames cost.',
        [
          'ViewEvent',
          'Hit',
          'End',
          'Failure',
          'Phase',
          'Trigger',
          'Device',
          'Modifiers',
          'Description',
          'TableDescription',
          'FieldDescription',
          'Kind',
          'Value',
          'Sample',
          'Stats',
          'Waiting',
          'Work',
        ],
      ],
    ],
  ),
};

for (const [name, content] of Object.entries(pages)) {
  const file = path.join(root, 'docs/reference', name);
  const formatted = await prettier.format(content, {
    ...(await prettier.resolveConfig(file)),
    parser: 'markdown',
  });
  // The reference names things as npm does: no path of Rust's, and in the types the schema writes
  // from Rust's documentation, no call of Rust's.
  const rust = name === 'types.md' ? /::|\w\(\)/ : /::/;
  const leftover = formatted.split('\n').filter((line) => rust.test(line));
  assert.deepEqual(leftover, [], `${file}: Rust's names in the TypeScript reference`);
  if (check)
    assert.equal(
      fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'),
      formatted,
      `${file}: run node npm/docs.mjs after building the package`,
    );
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatted);
  }
}
