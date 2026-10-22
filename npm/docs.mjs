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
      .replace(/^\s*(?:#private;|private .*;)\s*$/gm, '');
    found.set(name, signature.trim());
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
    '# JavaScript API\n\nGenerated from the shipped declarations. `loadLatkit()` returns `Data`, `Gpu`, `Shot`, and\n`colormapCss`; builders and patches need no WebAssembly. Options take the [scene and result\ntypes](types.md).\n\n',
    ['load', 'patch', 'scene', 'runtime'].map((name) => `npm/dist/${name}.d.ts`),
    [
      [
        'Loading',
        'Load the runtime once a page.',
        ['loadLatkit', 'LoadOptions', 'Latkit', 'LatkitError'],
      ],
      [
        'Data and patches',
        'Datasets of named tables, changed by patches written without WebAssembly.',
        [
          'Data',
          'Table',
          'Envelope',
          'Patch',
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
        'What varies by row: builders writing the expressions scenes take.',
        [
          'Expr',
          'ExprInput',
          'Color',
          'field',
          'color',
          'missing',
          'when',
          'When',
          'Then',
          'Mapped',
          'units',
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
        ['Gpu', 'View', 'ViewEvents', 'Canvas', 'Panel'],
      ],
      [
        'Pictures and video',
        'Shots draw views into images and video.',
        ['Shot', 'Image', 'ImageFormat', 'Video'],
      ],
    ],
  ),
  'types.md': page(
    '# Scene and result types\n\nGenerated from the same schema as the package types. Each field documents its meaning and defaults.\n\n',
    ['inputs', 'outputs'].map((name) => `npm/src/${name}.ts`),
    [
      [
        'Scenes',
        'A scene: its space, its marks, and how it looks and answers input.',
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
          'Theme',
          'Flow',
          'Shadow',
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
          'End',
          'Route',
          'Interpolation',
          'Label',
          'Size',
          'Units',
        ],
      ],
      [
        'Expressions',
        'Expressions as JSON: a constant, a field, or a node of these kinds.',
        [
          'ExprNode',
          'FieldNode',
          'ColorNode',
          'StateNode',
          'MissingNode',
          'UnaryNode',
          'BinaryNode',
          'WhenNode',
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
        ['Id', 'Ids', 'Row', 'Rows', 'Camera', 'Fit', 'Query'],
      ],
      [
        'Results',
        'What views tell: events, hits, descriptions, and what frames cost.',
        [
          'ViewEvent',
          'Hit',
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
