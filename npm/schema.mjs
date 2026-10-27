/**
 * Generates npm's types from `schema.json`. The types latkit reads (`$defs`) become `inputs.ts`,
 * and the types it writes (`outputs`) become `outputs.ts`. Each definition reachable from the roots
 * becomes a type, documented with its schema description; one that extends shared options becomes
 * an interface extending them. An output that an input already declares uses that input's type. A
 * schema's `tsType` names a hand-written type to use instead, such as `ExprInput`.
 */
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';

/** Root types npm takes as plain data. Every type they are built from is generated too. */
const INPUTS = ['Scene', 'Query', 'EnvelopeRequest', 'Camera', 'Fit', 'Budget', 'ColormapKind'];

/** Root types npm reads back from latkit. */
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

/** Hand-written types that a `tsType` names, keyed by the module that declares them. */
const IMPORTS = { './scene.js': ['Color', 'ExprInput'] };

/** Returns the sources of `inputs.ts` and `outputs.ts` for the schema at `file`, formatted with the
 * repository's Prettier config. */
export async function typescript(file) {
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  const inputs = declare(schema.$defs, '#/$defs/', INPUTS, new Set());
  const outputs = declare(schema.outputs, '#/outputs/', OUTPUTS, new Set(inputs.names));
  const config = await prettier.resolveConfig(path.join(path.dirname(file), 'src/inputs.ts'));
  const format = (source) => prettier.format(source, { ...config, parser: 'typescript' });
  const header = (types) =>
    `/** ${types}, written by \`node npm/build.mjs schema\` from \`npm/schema.json\`. Do not edit. */`;
  const imports = (modules) =>
    Object.entries(modules)
      .filter(([, names]) => names.length)
      .map(([module, names]) => `import type { ${names.sort().join(', ')} } from '${module}';`);
  return {
    inputs: await format(
      [header('The types latkit reads'), '', ...imports(IMPORTS), '', inputs.source, ''].join('\n'),
    ),
    outputs: await format(
      [
        header('The types latkit writes'),
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
 * Declares the definitions in `defs` that `roots` reach, where refs to them start with `prefix`.
 * Names in `declared` are declared by another module. They are not declared again, and those used
 * are returned as `borrowed` for import.
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
    // A `tsType` whose schema also allows null accepts null too.
    if (schema.tsType)
      return [schema.type].flat().includes('null') ? `${schema.tsType} | null` : schema.tsType;
    const name = ref(schema);
    if (name !== undefined) return defs[name]?.tsType ?? name;
    if ('const' in schema) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
    if (schema.allOf) return schema.allOf.map(type).join(' & ');
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
  // A union member's description moves onto the single key of a tagged variant, where editors show
  // it. Any other member keeps its description as a doc comment before it, which the reference
  // pages read: what each value of an enumeration means, and each form of a type with several.
  const members = (schemas) => {
    const parts = schemas.map((s) => {
      const keys = Object.keys(s.properties ?? {});
      if (!s.description) return type(s);
      if (keys.length === 1 && !s.properties[keys[0]].description) {
        return type({
          ...s,
          properties: { [keys[0]]: { ...s.properties[keys[0]], description: s.description } },
        });
      }
      return `${doc(s.description).trimEnd()} ${type({ ...s, description: undefined })}`;
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
  // latkit omits absent values from its output rather than writing null, so optional output
  // fields drop their null.
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

  // An object that extends shared options, `allOf` references and its own object, is an interface
  // extending theirs.
  const extending = (schema) => {
    const parts = schema.allOf ?? [];
    const own = parts.filter((p) => ref(p) === undefined);
    return own.length === 1 && own[0].type === 'object'
      ? { bases: parts.map(ref).filter((n) => n !== undefined), own: own[0] }
      : undefined;
  };
  const names = [...reached].filter((name) => !declared.has(name) && !defs[name].tsType).sort();
  const source = names
    .map((name) => {
      const schema = defs[name];
      const comment = schema.description ? doc(schema.description) : '';
      const extended = extending(schema);
      if (extended)
        return `${comment}export interface ${name} extends ${extended.bases.join(', ')} ${object(extended.own)}`;
      const body = type({ ...schema, description: undefined, tsType: undefined });
      return schema.type === 'object' && schema.properties
        ? `${comment}export interface ${name} ${body}`
        : `${comment}export type ${name} = ${body};`;
    })
    .join('\n\n');
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '');
  const used = (name) => new RegExp(`\\b${name}\\b`).test(code);
  return { names, source, borrowed: [...reached].filter((n) => declared.has(n) && used(n)) };
}

/** Rust names that npm spells differently. */
const RENAMED = { 'View::events': 'view.on' };

/**
 * Rewrites a code span from Rust's documentation with npm's names. An event becomes the event npm
 * emits (`Event::Connect` becomes a `'connect'` event). A lowercase member becomes an instance
 * member in camelCase (`View::complete` becomes `view.complete`), and any other member stays on its
 * type (`Space::Diagram` becomes `Space.Diagram`). A call drops its parentheses (`hovered()`
 * becomes `hovered`).
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
 * Converts a schema description into a doc comment. It keeps paragraphs, rewraps lines to at most
 * 96 columns, turns Rust's intra-doc links into plain code spans, renames Rust names to npm's,
 * writes `None` as `null` (as JSON does), and drops code blocks, which are Rust examples.
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
    // Each code span stays on one line, as TSDoc requires.
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
