/**
 * npm's types, written from `schema.json`: what latkit reads (`$defs`) becomes `inputs.ts`, and what
 * it writes (`outputs`) becomes `outputs.ts`. Each definition reachable from the roots becomes a type,
 * documented as its form is; an output an input already declares is that input's type. A schema's
 * `tsType` names the hand-written type that stands for it, such as `ExprInput`.
 */
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';

/** The types npm takes as plain data; everything they are built of comes with them. */
const INPUTS = ['Scene', 'Query', 'EnvelopeRequest', 'Camera', 'Fit', 'Budget', 'ColormapKind'];

/** The types npm reads back. */
const OUTPUTS = [
  'ViewEvent',
  'Stats',
  'Work',
  'Description',
  'Rows',
  'Camera',
  'Budget',
  'Value',
  'Failure',
];

/** The hand-written types a `tsType` names, and the module that declares them. */
const IMPORTS = { './scene.js': ['Color', 'ExprInput', 'PaintInput'] };

/** `inputs.ts` and `outputs.ts` of `schema.json` at `file`, formatted as the repository's sources are. */
export async function typescript(file) {
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  const inputs = declare(schema.$defs, '#/$defs/', INPUTS, new Set());
  const outputs = declare(schema.outputs, '#/outputs/', OUTPUTS, new Set(inputs.names));
  const config = await prettier.resolveConfig(path.join(path.dirname(file), 'src/inputs.ts'));
  const format = (source) => prettier.format(source, { ...config, parser: 'typescript' });
  const header = (from) =>
    `/** Written by \`node npm/build.mjs schema\` from \`npm/schema.json\`, ${from}: do not edit. */`;
  const imports = (modules) =>
    Object.entries(modules)
      .filter(([, names]) => names.length)
      .map(([module, names]) => `import type { ${names.sort().join(', ')} } from '${module}';`);
  return {
    inputs: await format(
      [header('what latkit reads'), '', ...imports(IMPORTS), '', inputs.source, ''].join('\n'),
    ),
    outputs: await format(
      [
        header('what latkit writes'),
        '',
        ...imports({ './inputs.js': outputs.borrowed }),
        '',
        outputs.source,
        '',
      ].join('\n'),
    ),
  };
}

/**
 * The declarations of the definitions `defs` that `roots` reach, refs to them starting `prefix`;
 * `declared` names those another module declares, which these borrow.
 */
function declare(defs, prefix, roots, declared) {
  const output = prefix === '#/outputs/';
  const ref = (schema) =>
    schema.$ref?.startsWith(prefix) ? schema.$ref.slice(prefix.length) : undefined;
  const reached = new Set();
  const reach = (schema) => {
    if (schema === null || typeof schema !== 'object') return;
    const name = ref(schema);
    if (name !== undefined && !reached.has(name)) {
      reached.add(name);
      if (!declared.has(name)) reach(defs[name]);
    }
    for (const value of Object.values(schema)) reach(value);
  };
  for (const root of roots) reach({ $ref: `${prefix}${root}` });

  const type = (schema) => {
    if (schema === true || schema === undefined || Object.keys(schema).length === 0)
      return 'unknown';
    // An optional value that `null` also sets takes the null its schema allows.
    if (schema.tsType)
      return [schema.type].flat().includes('null') ? `${schema.tsType} | null` : schema.tsType;
    const name = ref(schema);
    if (name !== undefined) return defs[name]?.tsType ?? name;
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
  // What latkit writes leaves an absent value out rather than writing null.
  const absent = (schema) => {
    if (Array.isArray(schema.type))
      return { ...schema, type: schema.type.filter((t) => t !== 'null') };
    const union = schema.anyOf ?? schema.oneOf;
    if (union) {
      const kept = union.filter((s) => s.type !== 'null');
      return kept.length === 1
        ? { ...kept[0], description: schema.description }
        : { ...schema, anyOf: kept, oneOf: undefined };
    }
    return schema;
  };
  const object = (schema) => {
    const required = new Set(schema.required ?? []);
    const lines = Object.entries(schema.properties ?? {}).map(([key, value]) => {
      const optional = !required.has(key);
      const shown = output && optional ? absent(value) : value;
      return `${value.description ? doc(value.description) : ''}${key}${optional ? '?' : ''}: ${type(shown)};`;
    });
    const rest = schema.additionalProperties;
    if (rest && typeof rest === 'object') lines.push(`[name: string]: ${type(rest)};`);
    return `{ ${lines.join('\n')} }`;
  };

  const names = [...reached].filter((name) => !declared.has(name) && !defs[name].tsType).sort();
  const source = names
    .map((name) => {
      const schema = defs[name];
      const body = type({ ...schema, description: undefined, tsType: undefined });
      const comment = schema.description ? doc(schema.description) : '';
      return schema.type === 'object' && schema.properties
        ? `${comment}export interface ${name} ${body}`
        : `${comment}export type ${name} = ${body};`;
    })
    .join('\n\n');
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '');
  const used = (name) => new RegExp(`\\b${name}\\b`).test(code);
  return { names, source, borrowed: [...reached].filter((n) => declared.has(n) && used(n)) };
}

/** Rust's names npm calls otherwise. */
const RENAMED = { 'View::events': 'view.on' };

/**
 * A code span of Rust's documentation as npm names what it names: an event as the event npm tells
 * (`Event::Connect` a `'connect'` event), a member as one of an instance where it starts lowercase
 * (`View::complete` `view.complete`, `Controls::connect` `controls.connect`) and of its type else, a
 * call as what it calls (`hovered()` `hovered`).
 */
function named(code) {
  const camel = (name) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  const lower = (name) => name[0].toLowerCase() + name.slice(1);
  if (RENAMED[code]) return `\`${RENAMED[code]}\``;
  const event = code.match(/^Event::(\w+)$/);
  if (event) return `a \`'${lower(event[1])}'\` event`;
  const span = code
    .replace(/\b([A-Z]\w*)::([a-z]\w*)/g, (_, owner, member) => `${lower(owner)}.${camel(member)}`)
    .replace(/\b([A-Z]\w*)::(\w+)/g, '$1.$2')
    .replace(/\(\)/g, '');
  return `\`${span}\``;
}

/**
 * Documentation as the forms write it, wrapped anew: paragraphs kept, lines at most 96 wide, Rust's
 * links to its own items as plain code, its names as npm's, its `None` as the `null` JSON writes,
 * and its examples, which are Rust, left out.
 */
function doc(text) {
  const lines = [];
  const plain = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\*\//g, '*\\/')
    .replace(/\[(`[^`]*`)\]\([^)]*\)/g, '$1')
    .replaceAll('`None`', '`null`')
    .replace(/`([^`]*)`/g, (_, code) => named(code));
  for (const paragraph of plain.split('\n\n').filter((p) => p.trim())) {
    if (lines.length) lines.push('');
    let line = '';
    // A code span stays on one line, as TSDoc reads them.
    const words = (paragraph.match(/(?:`[^`]*`|[^\s`])+/g) ?? []).map((w) =>
      w.replace(/\s+/g, ' '),
    );
    for (const word of words) {
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
}
