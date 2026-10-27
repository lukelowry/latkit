/**
 * Writes the reference pages in `docs/reference`: the JavaScript API from the package's shipped
 * declarations, the scene and result types from the types the schema writes, and the command
 * reference from the command tree the CLI's test writes to `cli.json`. Each entry has a heading,
 * its declaration, and its documentation, then its members or a union's forms: each a signature
 * and its definition, with an anchor of its own. Types in signatures, and code spans in the
 * documentation that name an entry or a member, link to it. With `--check`, asserts that the
 * checked-in pages are current instead. The pages are checked in so Read the Docs can build them
 * with Python alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import prettier from 'prettier';

const root = path.resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');
const prettierConfig = await prettier.resolveConfig(path.join(root, 'npm/src/index.ts'));

// Reading declarations

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

/** `text` with every comment blanked out and positions kept, so code read from it has none. */
function uncommented(text) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  let out = '';
  let at = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const [start, end] = [scanner.getTokenStart(), scanner.getTokenEnd()];
      out += text.slice(at, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
      at = end;
    }
  }
  return out + text.slice(at);
}

/**
 * The doc comment just before position `pos` of `text`, as Markdown; '' when there is none. It may
 * sit on the line before, or on the same line, as before a union member: `| /** … *\/ { … }`.
 */
function docBefore(text, pos) {
  const ranges = [
    ...(ts.getTrailingCommentRanges(text, pos) ?? []),
    ...(ts.getLeadingCommentRanges(text, pos) ?? []),
  ];
  const comment = ranges.filter((range) => text.startsWith('/**', range.pos)).at(-1);
  if (!comment) return '';
  return text
    .slice(comment.pos + 3, comment.end - 2)
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim();
}

const has = (node, kind) => (ts.getModifiers?.(node) ?? []).some((m) => m.kind === kind);

/**
 * The declarations of `file`, by name. Each has a `kind` (function, const, class, interface, or
 * type), its doc, and, by kind: its overloads, its members, or its union's branches.
 */
function read(file) {
  const raw = withoutModuleDoc(fs.readFileSync(path.join(root, file), 'utf8'));
  const source = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const code = uncommented(raw);
  /** The node's code, without comments, on one line. */
  const text = (node) => code.slice(node.getStart(source), node.end).replace(/\s+/g, ' ').trim();
  const doc = (node) => docBefore(raw, node.pos);
  /** A declaration's type parameters, in full or (`names`) by name only, as `<…>`. */
  const generics = (node, names = false) =>
    node.typeParameters
      ? `<${node.typeParameters.map((p) => (names ? p.name.getText(source) : text(p))).join(', ')}>`
      : '';

  /**
   * The fields of a function's options: the members of each parameter typed as an object type, or
   * as an intersection with one, such as `{ radius?: number } & Wait`.
   */
  const optionsOf = (node) =>
    node.parameters.flatMap((p) => {
      const types = p.type && ts.isIntersectionTypeNode(p.type) ? p.type.types : [p.type];
      return types.filter((t) => t && ts.isTypeLiteralNode(t)).flatMap((t) => members(t));
    });

  /**
   * The members of a class, an interface, or an object type, in order. A getter and its setter are
   * one property, and a method's overloads one method. A property of an object type lists that
   * type's members as its `fields`, and a method its options' members. `Symbol.dispose` is left to
   * `Handle`'s documentation.
   */
  const members = (node) => {
    const out = [];
    const byName = new Map();
    for (const m of node.members) {
      if (has(m, ts.SyntaxKind.PrivateKeyword) || has(m, ts.SyntaxKind.ProtectedKeyword)) continue;
      if (m.name && ts.isPrivateIdentifier(m.name)) continue;
      if (m.name && ts.isComputedPropertyName(m.name)) continue;
      const about = doc(m);
      if (/^@internal\b/.test(about)) continue;
      const isStatic = has(m, ts.SyntaxKind.StaticKeyword);
      const name = m.name ? m.name.getText(source) : 'new';
      if (ts.isGetAccessor(m) || ts.isSetAccessor(m)) {
        let entry = byName.get(name);
        if (!entry) {
          entry = { kind: 'property', name, doc: '', type: '', readonly: true, static: isStatic };
          byName.set(name, entry);
          out.push(entry);
        }
        if (ts.isGetAccessor(m)) entry.type = text(m.type);
        else {
          entry.readonly = false;
          entry.type ||= text(m.parameters[0].type);
        }
        entry.doc ||= about;
      } else if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
        out.push({
          kind: 'property',
          name,
          doc: about,
          type: m.type ? text(m.type) : 'unknown',
          optional: Boolean(m.questionToken),
          readonly: has(m, ts.SyntaxKind.ReadonlyKeyword),
          static: isStatic,
          fields: m.type && ts.isTypeLiteralNode(m.type) ? members(m.type) : [],
        });
      } else if (
        ts.isConstructorDeclaration(m) ||
        ts.isMethodDeclaration(m) ||
        ts.isMethodSignature(m)
      ) {
        const overload = { code: text(m), doc: about, options: optionsOf(m) };
        const known = byName.get(`${name}()`);
        if (known) {
          known.overloads.push(overload);
          known.doc ||= about;
          continue;
        }
        const kind = ts.isConstructorDeclaration(m) ? 'constructor' : 'method';
        const entry = { kind, name, doc: about, overloads: [overload], static: isStatic };
        byName.set(`${name}()`, entry);
        out.push(entry);
      } else assert.fail(`${file}: ${text(m)} is a kind of member the reference cannot show`);
    }
    return out;
  };

  /**
   * A union's branches, each with its doc, or the one type of a type that is no union. The first
   * branch's doc may come before the union's leading `|`.
   */
  const branches = (node) =>
    (ts.isUnionTypeNode(node) ? node.types : [node]).map((t, i) => {
      const branch = { text: text(t), doc: doc(t) || (i === 0 ? doc(node) : '') };
      if (ts.isLiteralTypeNode(t)) return { ...branch, kind: 'literal' };
      if (ts.isTypeReferenceNode(t) && !t.typeArguments)
        return { ...branch, kind: 'named', name: t.typeName.getText(source) };
      if (ts.isTypeLiteralNode(t)) return { ...branch, kind: 'object', members: members(t) };
      return { ...branch, kind: 'other' };
    });

  const found = new Map();
  for (const node of source.statements) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isEmptyStatement(node))
      continue;
    const about = doc(node);
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name.getText(source);
      const code = text(node).replace(/^export (declare )?/, '');
      const overload = { code, doc: about, options: optionsOf(node) };
      const known = found.get(name);
      if (known) {
        known.overloads.push(overload);
        known.doc ||= about;
      } else found.set(name, { kind: 'function', name, doc: about, overloads: [overload] });
    } else if (ts.isVariableStatement(node)) {
      // A constant holding a function reads as a function.
      const variable = node.declarationList.declarations[0];
      const name = variable.name.getText(source);
      const type = variable.type;
      const callable = Boolean(type && ts.isFunctionTypeNode(type));
      const declaration = callable
        ? `function ${name}${generics(type)}(${type.parameters.map(text).join(', ')}): ${text(type.type)}`
        : `const ${name}: ${type ? text(type) : 'unknown'}`;
      found.set(name, {
        kind: callable ? 'function' : 'const',
        name,
        doc: about,
        overloads: [{ code: declaration, doc: about }],
      });
    } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText(source);
      found.set(name, {
        kind: ts.isClassDeclaration(node) ? 'class' : 'interface',
        abstract: has(node, ts.SyntaxKind.AbstractKeyword),
        name,
        generics: generics(node),
        parameters: generics(node, true),
        doc: about,
        heritage: (node.heritageClauses ?? []).map(text),
        members: members(node),
      });
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText(source);
      found.set(name, {
        kind: 'type',
        name,
        generics: generics(node),
        parameters: generics(node, true),
        doc: about,
        type: text(node.type),
        branches: branches(node.type),
      });
    }
  }
  return found;
}

// Anchors and links

/** An anchor for a reference entry or one of its members: lowercase words joined by hyphens. */
const anchor = (...parts) =>
  parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * What each documented name links to: its anchor, how a link to it reads, and its doc. Anchors are
 * labels for the whole site, so a link needs no page.
 */
const targets = new Map();

/** The Markdown link to `name`, an entry or `Owner.member`; undefined if the reference lacks it. */
function link(name, label) {
  const target = targets.get(name);
  return target && `[${label ?? `\`${target.label}\``}](#${target.anchor})`;
}

/**
 * The entry or member a code span names, if the reference documents it: `Name`, `Name.member`,
 * `instance.member` for a class's `Name.member`, or a call of one of these or of a function,
 * `name()`.
 */
function named(span) {
  const call = span.endsWith('()');
  const bare = call ? span.slice(0, -2) : span;
  if (!/^[A-Za-z]\w*(\.\w+)?$/.test(bare)) return undefined;
  const [owner, member] = bare.split('.');
  if (!member) return /^[A-Z]/.test(owner) || call ? owner : undefined;
  return `${owner[0].toUpperCase()}${owner.slice(1)}.${member}`;
}

/**
 * `doc` with each `{@link Name}` made a link, and the first code span that names an entry or a
 * member other than `self` made one too. Fenced code is left as it is. Throws for a `{@link}` to
 * an unknown name.
 */
function linked(doc, self) {
  const done = new Set([self]);
  const prose = (text) =>
    text
      .replace(/\{@link\s+([\w.$]+)(?:\s*\|\s*|\s+)?([^}]*)\}/g, (_, name, label) => {
        const made = link(name, label.trim() || undefined);
        assert(made, `{@link ${name}} names nothing the reference documents`);
        done.add(name);
        return made;
      })
      .replace(/(?<!\[)`([^`\n]+)`(?!\]\()/g, (span, code) => {
        const name = named(code);
        if (!name || done.has(name) || !targets.has(name)) return span;
        done.add(name);
        return link(name, span);
      });
  return doc
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 ? part : prose(part)))
    .join('');
}

/** What lacks documentation, reported together once the pages are written. */
const undocumented = [];

/** Notes `what` as undocumented unless `doc` says something. */
const documented = (doc, what) => doc || undocumented.push(what);

// Signatures

/**
 * `code` on one line, as Prettier formats it, without a final semicolon. `code` is a declaration;
 * with `as` set to `member`, a member of a class or an interface, and to `type`, a type.
 */
async function oneLine(code, as = 'declaration') {
  const [before, after] = {
    declaration: ['declare ', ''],
    member: ['declare class Members {\n', '\n}'],
    type: ['type Type = ', ''],
  }[as];
  const out = await prettier.format(`${before}${code}${after}`, {
    ...prettierConfig,
    parser: 'typescript',
    printWidth: 100_000,
  });
  const lines = out.trim().split('\n');
  const body = as === 'member' ? lines.slice(1, -1) : lines;
  assert.equal(body.length, 1, `${code} prints on more than one line`);
  const line = body[0].trim().replace(/;$/, '');
  return as === 'member' ? line : line.slice(before.length);
}

/**
 * A code span of `text`, with the spaces at its ends outside it: Markdown would trim a span that
 * starts and ends with a space.
 */
function codeSpan(text) {
  const [, lead, inner, trail] = text.match(/^( *)(.*?)( *)$/);
  if (!inner) return text;
  const ticks = '`'.repeat(Math.max(0, ...(inner.match(/`+/g) ?? []).map((t) => t.length)) + 1);
  const pad = /^`|`$/.test(inner) ? ' ' : '';
  return `${lead}${ticks}${pad}${inner}${pad}${ticks}${trail}`;
}

/** `code` as code spans, with each documented type other than `self` a link. */
function linkedCode(code, self) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    code,
  );
  const out = [];
  let at = 0;
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const word = scanner.getTokenText();
    if (kind !== ts.SyntaxKind.Identifier || !/^[A-Z]/.test(word) || word === self) continue;
    const made = link(word, `\`${word}\``);
    if (!made) continue;
    out.push(codeSpan(code.slice(at, scanner.getTokenStart())), made);
    at = scanner.getTokenEnd();
  }
  out.push(codeSpan(code.slice(at)));
  return out.join('');
}

/**
 * A signature as Markdown: `code`, a one-line declaration, with each documented type other than
 * `self` a link, and the name it declares, `code.slice(...name)`, in bold.
 */
function signature(code, self, name) {
  if (!name) return linkedCode(code, self);
  const [start, end] = name;
  return [
    linkedCode(code.slice(0, start), self),
    `**${codeSpan(code.slice(start, end))}**`,
    linkedCode(code.slice(end), self),
  ].join('');
}

/** Where the name begins in a member's one-line declaration: after its modifiers. */
const nameAt = (code) => code.match(/^((static|readonly|abstract|override|async) )*/)[0].length;

/**
 * A union as its declaration shows it, on one line, its forms' details left to the items below
 * it: an object of more than two keys reads `{ … }`, and so does an object type within a form.
 */
async function unionDeclaration(entry) {
  const shown = entry.branches.map((b) => {
    if (b.kind !== 'object') return b.text;
    if (b.members.length > 2) return 'Hidden';
    const keys = b.members.map((m) => {
      const type = m.fields?.length ? 'Hidden' : m.type;
      return `${m.name}${m.optional ? '?' : ''}: ${type}`;
    });
    return `{ ${keys.join('; ')} }`;
  });
  const line = await oneLine(`type ${entry.name}${entry.generics} = ${shown.join(' | ')}`);
  return line.replace(/\bHidden\b/g, '{ … }');
}

// Rendering

/** Every anchor the pages define, to check that each is defined once. */
const anchors = [];

/**
 * One item of a definition list: `term`, its permalink, and `definition`. An item with an anchor
 * is a target for links. Lines after the first are indented to stay in the definition.
 */
function item(id, term, definition) {
  if (id) anchors.push(id);
  const attributes = id ? `{#${id} .member}` : '{.member}';
  const permalink = id ? ` [¶](#${id}){.headerlink}` : '';
  const lines = definition.trim().split('\n');
  const indented = [lines[0], ...lines.slice(1).map((l) => (l ? `  ${l}` : ''))].join('\n');
  return `${attributes}\n${term}${permalink}\n: ${indented}`;
}

/**
 * The items of `member` of entry `owner`, at `path` below it: one for each overload of a method,
 * the first with the member's anchor, and one for a property, with an item for each of its fields
 * in its definition.
 */
async function memberItems(owner, member, path = []) {
  const id = anchor(owner, ...path, member.name);
  const self = [owner, ...path, member.name].join('.');
  documented(member.doc, `${self} has no documentation`);
  if (member.kind === 'property') {
    const modifiers = `${member.static ? 'static ' : ''}${member.readonly ? 'readonly ' : ''}`;
    const optional = member.optional ? '?' : '';
    const code = await oneLine(`${modifiers}${member.name}${optional}: ${member.type}`, 'member');
    const at = nameAt(code);
    const fields = [];
    for (const field of member.fields ?? [])
      fields.push(...(await memberItems(owner, field, [...path, member.name])));
    const term = signature(code, owner, [at, at + member.name.length]);
    return [item(id, term, [linked(member.doc, self), ...fields].join('\n\n'))];
  }
  const items = [];
  for (const [i, overload] of member.overloads.entries()) {
    let code = await oneLine(overload.code, 'member');
    let name = [nameAt(code), nameAt(code) + member.name.length];
    if (member.kind === 'constructor') {
      code = code.replace(/^constructor/, `new ${owner}`);
      name = [0, `new ${owner}`.length];
    }
    const term = signature(code, owner, name);
    const options = await optionItems(owner, [...path, member.name], overload.options);
    const about = linked(overload.doc || member.doc, self);
    items.push(item(i === 0 ? id : undefined, term, [about, ...options].join('\n\n')));
  }
  return items;
}

/** The items of a function's or a method's options, at `path` below entry `owner`. */
async function optionItems(owner, path, options = []) {
  const items = [];
  for (const option of options) items.push(...(await memberItems(owner, option, path)));
  return items;
}

/** The items of a class's or an interface's members: properties, then methods, each under a rubric. */
async function membersOf(entry) {
  const groups = [
    ['Constructor', entry.members.filter((m) => m.kind === 'constructor')],
    ['Properties', entry.members.filter((m) => m.kind === 'property')],
    ['Methods', entry.members.filter((m) => m.kind === 'method')],
  ].filter(([, members]) => members.length);
  const out = [];
  for (const [title, members] of groups) {
    if (groups.length > 1 || entry.kind === 'class') out.push(`\`\`\`{rubric} ${title}\n\`\`\``);
    for (const member of members) out.push(...(await memberItems(entry.name, member)));
  }
  return out;
}

/**
 * The key an event union's branches share, as `type` in `{ type: 'name'; detail: … }`: every
 * branch is an object with this literal key and at most one other. Undefined for other unions.
 */
function eventKey(entry) {
  const objects = entry.branches.filter((b) => b.kind === 'object');
  if (objects.length !== entry.branches.length || objects.length < 2) return undefined;
  const literal = (type) => /^(['"]).*\1$/.test(type);
  return objects[0].members.find((m) =>
    objects.every(
      (b) => b.members.length <= 2 && b.members.some((o) => o.name === m.name && literal(o.type)),
    ),
  )?.name;
}

/**
 * The items of a union's branches: each documented value or named type, and each form. A named
 * type without a doc of its own needs no item: the declaration links it. An event,
 * `{ type: 'name'; detail: … }`, is one item named by its tag, its detail's fields in its
 * definition. A tagged form, `{ key: options }`, is one item, its fields in its definition. Any
 * other form lists its keys, after its doc when the union has several such forms.
 */
async function branchesOf(entry) {
  const owner = entry.name;
  const key = eventKey(entry);
  const forms = entry.branches.filter((b) => b.kind === 'object' && !key && b.members.length > 1);
  const out = [];
  for (const branch of entry.branches) {
    if (branch.kind === 'literal' && branch.doc) {
      const term = signature(branch.text, owner, [0, branch.text.length]);
      out.push(item(anchor(owner, branch.text), term, linked(branch.doc, owner)));
    } else if (branch.kind === 'named' && branch.doc && targets.has(branch.name)) {
      out.push(item(anchor(owner, branch.name), link(branch.name), linked(branch.doc, owner)));
    } else if (branch.kind === 'object' && (key || branch.members.length === 1)) {
      const tag = key ? branch.members.find((m) => m.name === key).type : branch.members[0].name;
      const payload = key ? branch.members.find((m) => m.name !== key) : branch.members[0];
      const name = key ? tag.slice(1, -1) : tag;
      const about = branch.doc || (key ? '' : payload.doc);
      documented(about, `${owner} ${tag} has no documentation`);
      const fields = [];
      for (const field of payload?.fields ?? [])
        fields.push(...(await memberItems(owner, field, [name])));
      let term;
      if (key) {
        // An event reads as its tag, and the type of a detail that has no fields of its own.
        const detail = payload && !payload.fields?.length ? `: ${payload.type}` : '';
        term = `**${codeSpan(tag)}**${detail && linkedCode(detail, owner)}`;
      } else {
        const code = await oneLine(branch.text, 'type');
        const at = code.indexOf(tag);
        term = signature(code, owner, [at, at + tag.length]);
      }
      out.push(item(anchor(owner, name), term, [linked(about, owner), ...fields].join('\n\n')));
    } else if (branch.kind === 'object') {
      if (forms.length > 1) {
        documented(branch.doc, `a form of ${owner} has no documentation`);
        out.push(linked(branch.doc, owner));
      }
      for (const member of branch.members) out.push(...(await memberItems(owner, member)));
    }
  }
  return out;
}

/**
 * An entry's heading text: a function's name with parentheses, any other name with its type
 * parameters' names.
 */
const heading = (entry) =>
  entry.kind === 'function' ? `${entry.name}()` : `${entry.name}${entry.parameters ?? ''}`;

/** An entry's declaration: a line for each overload of a function, else one line. */
async function declaration(entry) {
  if (entry.overloads) return Promise.all(entry.overloads.map((o) => oneLine(o.code)));
  if (entry.kind === 'type') {
    if (entry.branches.length > 1) return [await unionDeclaration(entry)];
    return [await oneLine(`type ${entry.name}${entry.generics} = ${entry.type}`)];
  }
  const kind = `${entry.abstract ? 'abstract ' : ''}${entry.kind}`;
  return [[`${kind} ${entry.name}${entry.generics}`, ...entry.heritage].join(' ')];
}

/** An entry, as its page shows it. */
async function render(entry) {
  anchors.push(entry.anchor);
  const lines = (await declaration(entry)).map((line) => signature(line, entry.name));
  documented(entry.doc, `${entry.name} has no documentation`);
  const parts = [
    `(${entry.anchor})=`,
    `### \`${heading(entry)}\``,
    ...lines.map((line) => `{.signature}\n${line}`),
    linked(entry.doc, entry.name),
  ];
  const options = (entry.overloads ?? []).find((o) => o.options?.length)?.options;
  parts.push(...(await optionItems(entry.name, [], options)));
  if (entry.members) parts.push(...(await membersOf(entry)));
  if (entry.branches && entry.branches.length > 1) parts.push(...(await branchesOf(entry)));
  return parts.join('\n\n');
}

/**
 * A reference page: `head`, then each section of `sections` as `[title, description, names]`, its
 * entries in the order listed.
 */
async function page(head, entries, sections) {
  const out = [linked(head)];
  for (const [title, about, names] of sections) {
    out.push(`## ${title}`, linked(about));
    for (const name of names) out.push(await render(entries.get(name)));
  }
  return `${out.join('\n\n')}\n`;
}

// The command reference

/**
 * The command reference, from the command tree the CLI's test writes to `cli.json`: each command's
 * usage and description, then its arguments and options, each a term over its definition with an
 * anchor of its own. Code spans that name a command or an option link to it. A command that takes
 * `render`'s arguments says so instead of listing them again.
 */
function cliPage() {
  const commands = JSON.parse(fs.readFileSync(path.join(root, 'docs/reference/cli.json'), 'utf8'));
  const anchorOf = (command) => `cli-${command.name.split(' ')[1] ?? 'latkit'}`;
  const idOf = (command, arg) => `${anchorOf(command)}-${arg.long ?? arg.id}`;
  // What code spans link to: each command, and each option, first in its own command.
  const links = new Map(commands.map((command) => [command.name, anchorOf(command)]));
  for (const command of commands)
    for (const arg of command.args)
      if (arg.long && !links.has(`--${arg.long}`)) links.set(`--${arg.long}`, idOf(command, arg));
  const sentence = (help) => {
    const text = help.trim();
    return !text || text.endsWith('.') ? text : `${text}.`;
  };
  const term = (arg) => {
    if (arg.positional) {
      const value = arg.required ? `<${arg.value}>` : `[${arg.value}]`;
      return `**\`${value}${arg.many ? '...' : ''}\`**`;
    }
    const short = arg.short ? `\`-${arg.short},\` ` : '';
    return `${short}**\`--${arg.long}\`**${arg.value ? ` \`<${arg.value}>\`` : ''}`;
  };
  const render = commands.find((command) => command.name === 'latkit render');
  const out = [
    '# Command reference',
    "Every command and option of the `latkit` command line, written from its help. The [command-line guide](../cli.md) shows them at work. `--help` prints a command's help in the terminal, and `latkit --version` prints the version.",
  ];
  for (const command of commands) {
    const top = command.name === 'latkit';
    const anchor = anchorOf(command);
    anchors.push(anchor);
    const local = new Map(links);
    for (const arg of command.args) if (arg.long) local.set(`--${arg.long}`, idOf(command, arg));
    const linked = (text) =>
      text.replace(/`([^`\n]+)`/g, (span, code) =>
        local.has(code) ? `[${span}](#${local.get(code)})` : span,
      );
    out.push(
      `(${anchor})=`,
      `## \`${command.name}\``,
      `{.signature}\n\`${command.usage}\``,
      linked(sentence(command.about)),
    );
    if (top) {
      out.push('```{rubric} Commands\n```');
      for (const sub of commands.slice(1))
        out.push(
          item(undefined, `[\`${sub.name}\`](#${anchorOf(sub)})`, linked(sentence(sub.about))),
        );
    }
    if (
      !top &&
      command !== render &&
      JSON.stringify(command.args) === JSON.stringify(render.args)
    ) {
      out.push(`Takes ${linked('`latkit render`')}'s arguments and options.`);
      continue;
    }
    for (const [title, positional] of [
      ['Arguments', true],
      ['Options', false],
    ]) {
      const args = command.args.filter((arg) => arg.positional === positional);
      if (!args.length) continue;
      out.push(`\`\`\`{rubric} ${title}\n\`\`\``);
      for (const arg of args) {
        const id = idOf(command, arg);
        let about = sentence(arg.help);
        if (arg.defaults.length)
          about += ` Defaults to ${arg.defaults.map((v) => `\`${v}\``).join(', ')}.`;
        if (top && arg.global) about += ' Every command takes it.';
        const values = arg.values.map((value) => {
          assert(value.help, `${command.name} ${id}: value ${value.name} has no help`);
          return item(`${id}-${value.name}`, `**\`${value.name}\`**`, linked(sentence(value.help)));
        });
        out.push(item(id, term(arg), [linked(about), ...values].join('\n\n')));
      }
    }
  }
  return `${out.join('\n\n')}\n`;
}

// The pages

const API = [
  'load',
  'internal',
  'data',
  'patch',
  'scene',
  'colormap',
  'gpu',
  'view',
  'canvas',
  'shot',
];
const TYPES = ['inputs', 'outputs'];

const sections = {
  'api.md': [
    [
      'Loading, errors, and lifetimes',
      'What every part of the package shares.',
      ['load', 'LatkitError', 'Wait', 'Handle'],
    ],
    [
      'Data and patches',
      'Datasets of named tables, the patches that change them, written without WebAssembly, and the sources views draw.',
      [
        'Dataset',
        'Data',
        'Snapshot',
        'Tiles',
        'Source',
        'QueryResult',
        'Envelope',
        'Patch',
        'ByteSource',
        'ReadableBytes',
        'RowIds',
        'Values',
        'Geometry',
        'Reference',
        'reference',
        'Fields',
      ],
    ],
    [
      'Expressions',
      'Builders for the per-row expressions that scene options take, colors among them.',
      [
        'Expr',
        'ExprInput',
        'Mapped',
        'Color',
        'field',
        'when',
        'When',
        'Then',
        'Next',
        'px',
        'units',
        'selected',
        'hovered',
        'pointer',
        'zoom',
        'elapsed',
        'icon',
        'RgbaImage',
        'colormaps',
        'colormapCss',
      ],
    ],
    [
      'Views',
      'A GPU makes views, and canvases that show them.',
      ['Gpu', 'View', 'ViewEvents', 'Insets', 'Point', 'Position', 'Canvas', 'Panel', 'Rect'],
    ],
    [
      'Pictures and video',
      'Shots draw views into images and video.',
      ['Shot', 'ShotOptions', 'Image', 'ImageFormat', 'Video'],
    ],
  ],
  'types.md': [
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
      'How a scene looks: a group for each kind of thing it draws, and the lengths its options take.',
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
        'MarkOptions',
        'StrokeOptions',
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
      'Expressions as JSON: a number, a boolean, `null`, a field as `"$name"`, a CSS color, or one of these nodes.',
      [
        'ExprNode',
        'FieldNode',
        'StateNode',
        'CallNode',
        'WhenNode',
        'ScaleNode',
        'ColormapNode',
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
};

const heads = {
  'api.md': `# JavaScript API

Every class, function, and type the \`latkit\` package exports. Scenes and their options take the
[scene and result types](types.md). Four rules hold throughout, so the entries below leave them
out:

- **Loading.** Scenes, expressions, and patches are plain data. Datasets, views, pictures, and the
  colormap functions need latkit's WebAssembly: until \`load()\` finishes, they throw an
  \`unloaded\` error. \`Gpu.create()\`, \`Data.read()\`, and \`Patch.read()\` of JSON load it
  themselves.
- **Errors.** Everything latkit throws or rejects with is a \`LatkitError\`. Input it cannot use
  fails with an \`invalid\` error whose \`path\` names the part, such as
  \`marks[2].vertices.color\`, and changes nothing.
- **Waits.** Every promise waits within its \`Wait\`: until its \`signal\` aborts, or 30 seconds.
- **Lifetimes.** A \`Handle\` holds memory until \`destroy()\`, or a \`using\` declaration, frees it.`,
  'types.md': `# Scene and result types

The types of the scenes latkit draws and of what it reports, written from the same schema as the
package's types. Each property gives its meaning and default.`,
};

/** The declarations of every file in `files`, read from `dir`. */
const readAll = (files, dir, ext) => new Map(files.flatMap((f) => [...read(`${dir}/${f}${ext}`)]));
const entries = {
  'api.md': readAll(API, 'npm/dist', '.d.ts'),
  'types.md': readAll(TYPES, 'npm/src', '.ts'),
};

// Anchors ignore case, so a builder named like a type on either page, such as `zoom()` beside
// `Zoom`, takes `-function` after its name.
const types = new Set(
  Object.values(entries)
    .flatMap((all) => [...all.values()])
    .filter((e) => e.kind !== 'function')
    .map((e) => anchor(e.name)),
);
// Every declaration is listed in exactly one section, and documented on exactly one page.
for (const [name, all] of Object.entries(entries)) {
  const listed = sections[name].flatMap(([, , names]) => names);
  const unlisted = [...all.keys()].filter((n) => !listed.includes(n));
  const missing = listed.filter((n) => !all.has(n));
  assert.deepEqual(unlisted, [], `npm/docs.mjs lists no section for ${unlisted.join(', ')}`);
  assert.deepEqual(missing, [], `npm/docs.mjs lists undeclared names: ${missing.join(', ')}`);
  for (const entry of all.values()) {
    assert(!targets.has(entry.name), `${entry.name} is documented twice`);
    const collides = entry.kind === 'function' && types.has(anchor(entry.name));
    entry.anchor = collides ? anchor(entry.name, 'function') : anchor(entry.name);
    const label = heading(entry).replace(/<.*>$/, '');
    targets.set(entry.name, { anchor: entry.anchor, label, doc: entry.doc });
    for (const member of entry.members ?? []) {
      const prefix = entry.kind === 'class' ? `${entry.name}.` : '';
      const call = member.kind === 'method' ? '()' : '';
      targets.set(`${entry.name}.${member.name}`, {
        anchor: anchor(entry.name, member.name),
        label: `${prefix}${member.name}${call}`,
        doc: member.doc,
      });
    }
    // A union's forms list their keys as members do, except an event's, which nest in the event.
    const forms = entry.branches && !eventKey(entry) ? entry.branches : [];
    for (const member of forms.flatMap((b) => (b.kind === 'object' ? b.members : []))) {
      targets.set(`${entry.name}.${member.name}`, {
        anchor: anchor(entry.name, member.name),
        label: member.name,
        doc: member.doc,
      });
    }
  }
}

const written = new Map();
for (const name of Object.keys(entries)) {
  const file = path.join(root, 'docs/reference', name);
  const content = await page(heads[name], entries[name], sections[name]);
  // The reference must use npm's names. No line may contain a Rust path (`::`), and types.md,
  // which the schema writes from Rust's documentation, may not contain a Rust call (`name()`).
  const rust = name === 'types.md' ? /::|\w\(\)/ : /::/;
  const leftover = content.split('\n').filter((line) => rust.test(line));
  assert.deepEqual(leftover, [], `${file}: Rust's names in the TypeScript reference`);
  assert(!content.includes('{@link'), `${file}: a link left unresolved`);
  written.set(file, content);
}
written.set(path.join(root, 'docs/reference/cli.md'), cliPage());

// Anchors are labels for the whole site, so each must be unique, and none may be a heading's slug.
const slugs = [
  ...Object.values(heads),
  ...Object.values(sections)
    .flat()
    .map(([title]) => title),
].map((text) => anchor(text.split('\n')[0].replace(/^# /, '')));
const twice = anchors.filter((a, i) => anchors.indexOf(a) !== i || slugs.includes(a));
assert.deepEqual(twice, [], 'anchors used twice');
assert.deepEqual(undocumented, [], 'every entry, member, and form documents itself');
for (const [file, content] of written) {
  if (check)
    assert.equal(
      fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'),
      content,
      `${file}: run node npm/docs.mjs after building the package`,
    );
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}
