/** Checked-in reference snapshots let Read the Docs build with Python alone. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

function declarations(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return source.statements
    .filter(
      (node) =>
        !ts.isImportDeclaration(node) &&
        !ts.isExportDeclaration(node) &&
        !ts.isEmptyStatement(node),
    )
    .map((node) => {
      const name =
        node.name?.getText(source) ??
        (ts.isVariableStatement(node)
          ? node.declarationList.declarations[0].name.getText(source)
          : undefined);
      if (!name) return '';
      const signature = printer
        .printNode(ts.EmitHint.Unspecified, node, source)
        .replace(/\bexport declare /g, '')
        .replace(/\bexport /g, '')
        .replace(/^\s*(?:#private;|private .*;)\s*$/gm, '');
      return `## ${name}\n\n\`\`\`ts\n${signature.trim()}\n\`\`\`\n`;
    })
    .join('\n');
}

const pages = {
  'api.md':
    '# JavaScript API\n\nGenerated from the shipped declarations. Builders are available from `latkit/core`;\n`loadLatkit()` returns `Data`, `Gpu`, `Shot`, and `colormapCss`.\nSee the guides for workflows and the [scene and result types](types.md) for option shapes.\n\n' +
    ['load', 'patch', 'scene', 'runtime']
      .map((name) => declarations(`npm/dist/${name}.d.ts`))
      .join('\n'),
  'types.md':
    '# Scene and result types\n\nGenerated from the same schema as the package types. Each field documents its meaning and defaults.\n\n' +
    ['inputs', 'outputs'].map((name) => declarations(`npm/src/${name}.ts`)).join('\n'),
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
