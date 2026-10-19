/**
 * npm's input types, written from `schema.json`, the JSON Schema of what latkit reads: each
 * definition reachable from the roots becomes a type, documented as its form is. A schema's
 * `tsType` names the hand-written type that stands for it, such as `ExprInput`.
 */
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';

/** The types npm takes as plain data; everything they are built of comes with them. */
const ROOTS = ['Scene', 'Query', 'Camera', 'Fit', 'Budget', 'ColormapKind'];

/** The hand-written types a `tsType` names, and the module that declares them. */
const IMPORTS = { './scene.js': ['Color', 'ExprInput', 'Size'] };

/** The TypeScript of `schema.json` at `file`, formatted as the repository's other sources are. */
export async function typescript(file) {
  const { $defs: defs } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ref = (schema) => schema.$ref?.replace('#/$defs/', '');
  const reached = new Set();
  const reach = (schema) => {
    if (schema === null || typeof schema !== 'object') return;
    const name = ref(schema);
    if (name !== undefined && !reached.has(name)) {
      reached.add(name);
      reach(defs[name]);
    }
    for (const value of Object.values(schema)) reach(value);
  };
  for (const root of ROOTS) reach({ $ref: `#/$defs/${root}` });

  const type = (schema) => {
    if (schema === true || schema === undefined || Object.keys(schema).length === 0)
      return 'unknown';
    // An optional value that `null` also sets takes the null its schema allows.
    if (schema.tsType)
      return [schema.type].flat().includes('null') ? `${schema.tsType} | null` : schema.tsType;
    const name = ref(schema);
    if (name !== undefined) return defs[name].tsType ?? name;
    if ('const' in schema) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
    const union = schema.anyOf ?? schema.oneOf;
    if (union) return members(union);
    if (Array.isArray(schema.type)) {
      return members(schema.type.map((t) => ({ ...schema, type: t, description: undefined })));
    }
    switch (schema.type) {
      case 'null':
        return 'null';
      case 'boolean':
        return 'boolean';
      case 'number':
      case 'integer':
        return 'number';
      case 'string':
        return 'string';
      case 'array':
        return array(schema);
      case 'object':
        return object(schema);
      default:
        return 'unknown';
    }
  };
  // A member's documentation moves onto the one key of a tagged variant; elsewhere TypeScript would
  // show it nowhere.
  const members = (schemas) => {
    const parts = schemas.map((s) => {
      const keys = Object.keys(s.properties ?? {});
      if (!s.description || keys.length !== 1 || s.properties[keys[0]].description) return type(s);
      return type({
        ...s,
        properties: { [keys[0]]: { ...s.properties[keys[0]], description: s.description } },
      });
    });
    return [...new Set(parts)].join(' | ');
  };
  const array = (schema) => {
    if (schema.prefixItems) {
      const items = schema.prefixItems.map(type);
      const extra = (schema.maxItems ?? items.length) - items.length;
      for (let i = 0; i < extra; i++) items.push(`${type(schema.items)}?`);
      return `[${items.join(', ')}]`;
    }
    const item = type(schema.items);
    if (
      schema.minItems !== undefined &&
      schema.minItems === schema.maxItems &&
      schema.maxItems <= 4
    ) {
      return `[${Array(schema.maxItems).fill(item).join(', ')}]`;
    }
    return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
  };
  const object = (schema) => {
    const required = new Set(schema.required ?? []);
    const lines = Object.entries(schema.properties ?? {}).map(
      ([key, value]) =>
        `${value.description ? doc(value.description) : ''}${key}${required.has(key) ? '' : '?'}: ${type(value)};`,
    );
    const rest = schema.additionalProperties;
    if (rest && typeof rest === 'object') lines.push(`[name: string]: ${type(rest)};`);
    return `{ ${lines.join('\n')} }`;
  };
  // Documentation as the forms write it, wrapped anew: paragraphs kept, lines at most 96 wide.
  const doc = (text) => {
    const lines = [];
    for (const paragraph of text.replace(/\*\//g, '*\\/').split('\n\n')) {
      if (lines.length) lines.push('');
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        if (line && line.length + word.length + 1 > 96) {
          lines.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
    }
    return lines.length === 1
      ? `/** ${lines[0]} */\n`
      : `/**\n${lines.map((l) => ` * ${l}`.trimEnd()).join('\n')}\n */\n`;
  };

  const declarations = [...reached]
    .filter((name) => !defs[name].tsType)
    .sort()
    .map((name) => {
      const schema = defs[name];
      const body = type({ ...schema, description: undefined, tsType: undefined });
      const comment = schema.description ? doc(schema.description) : '';
      return schema.type === 'object' && schema.properties
        ? `${comment}export interface ${name} ${body}`
        : `${comment}export type ${name} = ${body};`;
    });
  const imports = Object.entries(IMPORTS).map(
    ([module, names]) => `import type { ${names.join(', ')} } from '${module}';`,
  );
  const source = [
    '/** Written by `node npm/build.mjs schema` from `npm/schema.json`, the forms latkit reads: do not edit. */',
    '',
    ...imports,
    '',
    declarations.join('\n\n'),
    '',
  ].join('\n');
  const config = await prettier.resolveConfig(path.join(path.dirname(file), 'src/forms.ts'));
  return prettier.format(source, { ...config, parser: 'typescript' });
}
