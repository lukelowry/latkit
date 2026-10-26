/**
 * Writes the JavaScript reference pages in `docs/reference` from the package's declarations, or
 * with `--check` asserts that the checked-in pages are current. The pages are checked in so Read
 * the Docs can build with Python alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

/**
 * `text` with its first comment blanked out. Every module opens with a comment about itself, and
 * where the declarations drop the imports below it, it would read as the first declaration's doc.
 */
function withoutModuleDoc(text) {
  const comments = ts.getLeadingCommentRanges(text, 0) ?? [];
  const first = comments.find((range) => !text.startsWith('///', range.pos));
  if (!first) return text;
  return text.slice(0, first.pos) + ' '.repeat(first.end - first.pos) + text.slice(first.end);
}

/** Maps each top-level declaration of `file` by name to its printed signature. */
function declarations(file) {
  const text = withoutModuleDoc(fs.readFileSync(path.join(root, file), 'utf8'));
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
    // An overloaded function keeps every signature, in order.
    found.set(name, found.has(name) ? `${found.get(name)}\n${signature}` : signature);
  }
  return found;
}

/**
 * Builds a reference page of the declarations in `files`: `head`, then each section of `sections`
 * as `[title, description, names]`, with its declarations in the order listed. Throws if a
 * declaration is in no section or a section names a declaration that does not exist.
 */
function page(head, files, sections) {
  const all = new Map(files.flatMap((file) => [...declarations(file)]));
  const listed = sections.flatMap(([, , names]) => names);
  const unlisted = [...all.keys()].filter((name) => !listed.includes(name));
  const missing = listed.filter((name) => !all.has(name));
  assert.deepEqual(unlisted, [], `npm/docs.mjs lists no section for ${unlisted.join(', ')}`);
  assert.deepEqual(missing, [], `npm/docs.mjs lists undeclared names: ${missing.join(', ')}`);
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
    '# JavaScript API\n\nGenerated from the shipped declarations. `load()` loads the WebAssembly that datasets, views,\nand pictures need. Scenes, expressions, and patches do not need it. Options use the [scene and\nresult types](types.md).\n\n',
    ['load', 'internal', 'data', 'patch', 'scene', 'colormap', 'gpu', 'view', 'canvas', 'shot'].map(
      (name) => `npm/dist/${name}.d.ts`,
    ),
    [
      [
        'Loading and waiting',
        'Load the WebAssembly once per page. A wait ends when its signal aborts (30 s by default).',
        ['load', 'LoadOptions', 'Wait', 'LatkitError'],
      ],
      [
        'Data and patches',
        'Datasets of named tables, the patches that change them (written without WebAssembly), and the sources views draw.',
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
        'Builders for the per-row expressions and colors that scene options take.',
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
        'A scene: its space, how it responds to input, and how it is laid out.',
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
        'The marks that draw the tables of a scene.',
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
        'Expressions as JSON: a constant, a field, or one of these nodes. Colors take CSS strings where values take field names.',
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
        'Identifying rows, framing them, and querying them.',
        ['Id', 'Ids', 'Row', 'Rows', 'Camera', 'Fit', 'Query', 'EnvelopeRequest'],
      ],
      [
        'Results',
        'View events and hits, dataset descriptions and values, and frame statistics.',
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
  // The reference must use npm's names. No line may contain a Rust path (`::`), and types.md,
  // which the schema writes from Rust's documentation, may not contain a Rust call (`name()`).
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
