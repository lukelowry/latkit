import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SHADE_WGSL } from '../src/shade.js';
import { PASSES, passSource, type PassName } from '../src/webgpu/renderer.js';

/*
 * Static checks over the WGSL every pass compiles from, standing in for the compiler the test
 * environment lacks: each assembled module (common + shade prelude + default shade + pass) declares
 * everything it names, balances its brackets, keeps integers flat across stages, reads instance
 * buffers only where group 1 is visible, and differentiates only in uniform control flow. The
 * modules were also validated with naga while they were written. The constants' values against
 * the TypeScript side are held by uniforms.unit.test.ts.
 */

const read = (name: string): string =>
  readFileSync(new URL(`../src/webgpu/shaders/${name}.wgsl`, import.meta.url), 'utf8');

const common = read('common');
const prelude = read('shade');

/** A word list written as prose, one set. */
function words(...lines: string[]): Set<string> {
  return new Set(lines.join(' ').split(/\s+/));
}

/** WGSL builtin functions and value constructors the passes may call. */
const BUILTINS = words(
  'abs acos all any arrayLength asin atan atan2 bitcast ceil clamp cos cosh countOneBits cross',
  'degrees distance dot dpdx dpdy exp exp2 extractBits floor fma fract fwidth insertBits',
  'inverseSqrt length log log2 max min mix normalize pow radians reflect round saturate select',
  'sign sin sinh smoothstep sqrt step tan tanh textureDimensions textureLoad textureSample',
  'textureSampleLevel trunc array bool f32 i32 u32 vec2 vec3 vec4 vec2f vec3f vec4f vec2u vec3u',
  'vec4u vec2i vec3i vec4i mat2x2f mat3x3f mat4x4f',
);

/** Keywords a call-shaped match may start with. */
const KEYWORDS = words('if for while switch return loop else case fn');

/** WGSL keywords and the reserved words a declaration could plausibly collide with. */
const RESERVED = words(
  'NULL Self abstract active as async attribute auto await become cast catch class common compile',
  'debugger delete demote do enum explicit export extends extern external filter final finally',
  'friend from get goto handle highp impl implements import inline interface layout lowp macro',
  'match mediump meta mod module move mut mutable namespace new nil noexcept noinline null',
  'nullptr of operator package partition pass patch precise precision priv protected pub public',
  'readonly ref register require resource restrict self set shared sizeof smooth snorm static std',
  'subroutine super target template this throw trait try type typedef typeid typename typeof',
  'union unless unorm unsafe unsized use using varying virtual volatile wgsl where with writeonly',
  'yield alias break case const continue continuing default diagnostic discard else enable false',
  'fn for if let loop override requires return struct switch true var while',
);

/** Source with comments removed, so prose never reads as code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** The text between the bracket at `open` and its match. */
function enclosed(source: string, open: number): string {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const close = pairs[source[open]!]!;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === source[open]) depth++;
    else if (source[i] === close && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${source[open]} at ${open}`);
}

/** A function: its parameter list and its body between the braces. */
interface WgslFunction {
  readonly params: string;
  readonly body: string;
}

/** Every function declared in a module, by name. */
function functionsOf(source: string): Map<string, WgslFunction> {
  const functions = new Map<string, WgslFunction>();
  for (const match of source.matchAll(/\bfn\s+(\w+)\s*\(/g)) {
    const paren = match.index + match[0].length - 1;
    const params = enclosed(source, paren);
    const brace = source.indexOf('{', paren + params.length + 2);
    functions.set(match[1]!, { params, body: enclosed(source, brace) });
  }
  return functions;
}

/** Module-scope names a module declares, with repeats. */
function declarations(source: string): string[] {
  const names: string[] = [];
  const patterns = [
    /^fn\s+(\w+)/gm,
    /^const\s+(\w+)/gm,
    /^struct\s+(\w+)/gm,
    /^(?:@\w+(?:\([^)]*\))?\s*)*var(?:<[^>]*>)?\s+(\w+)/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.push(match[1]!);
  }
  return names;
}

/** Names a call-shaped expression starts with: functions, constructors, and conversions. */
function callees(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/(?<![@\w.])([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(/g)) {
    if (!KEYWORDS.has(match[1]!)) names.add(match[1]!);
  }
  return names;
}

/** One struct member with the attributes before it. */
interface Member {
  readonly attributes: string;
  readonly name: string;
  readonly type: string;
}

/** The members of a struct. */
function membersOf(source: string, struct: string): Member[] {
  const start = source.search(new RegExp(`\\bstruct\\s+${struct}\\s*\\{`));
  if (start < 0) throw new Error(`no struct ${struct}`);
  const body = enclosed(source, source.indexOf('{', start));
  const pattern = /((?:@\w+(?:\([^)]*\))?\s*)*)(\w+)\s*:\s*([\w<>, ]+?)\s*(?:,|$)/g;
  return [...body.matchAll(pattern)].map(([, attributes, name, type]) => ({
    attributes: attributes!,
    name: name!,
    type: type!.trim(),
  }));
}

/** Top-level arguments of the call whose open paren is at `open`. */
function argumentCount(source: string, open: number): number {
  const inner = enclosed(source, open).trim().replace(/,$/, '');
  let depth = 0;
  let count = inner ? 1 : 0;
  for (const char of inner) {
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) count++;
  }
  return count;
}

/** The functions `from` reaches through calls, itself included. */
function reachable(functions: Map<string, WgslFunction>, from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name) || !functions.has(name)) continue;
    seen.add(name);
    for (const callee of callees(functions.get(name)!.body)) queue.push(callee);
  }
  return seen;
}

/** Calls a module makes that it neither declares nor WGSL provides. */
function undeclaredCalls(module: string): string[] {
  const declared = new Set(declarations(module));
  return [...callees(module)].filter((name) => !declared.has(name) && !BUILTINS.has(name));
}

/** Integer varyings of `VOut` interpolated without `@interpolate(flat)`. */
function smoothIntegers(module: string): string[] {
  return membersOf(module, 'VOut')
    .filter((member) => member.attributes.includes('@location'))
    .filter((member) => /^(u32|i32|vec\du|vec\di|vec\d<[ui]32>)$/.test(member.type))
    .filter((member) => !member.attributes.includes('@interpolate(flat)'))
    .map((member) => member.name);
}

/** Functions that differentiate other than at the top of `fs`, before anything can branch. */
function nonUniformDerivatives(module: string): string[] {
  const offenders: string[] = [];
  for (const [name, { body }] of functionsOf(module)) {
    const at = body.search(/\b(fwidth|dpdx|dpdy|textureSample)\s*\(/);
    if (at < 0) continue;
    const branches = /\b(if|return|switch|for|while|loop)\b/.test(body.slice(0, at));
    if (name !== 'fs' || branches) offenders.push(name);
  }
  return offenders;
}

/** Functions reachable from `fs` that read the group 1 instance buffer, which only `vs` sees. */
function fragmentInstanceReads(module: string): string[] {
  const instance = /@group\(1\)\s*@binding\(0\)\s*var<storage,\s*read>\s*(\w+)/.exec(module)?.[1];
  if (!instance) return [];
  const functions = functionsOf(module);
  const pattern = new RegExp(`\\b${instance}\\b`);
  return [...reachable(functions, 'fs')].filter((name) => pattern.test(functions.get(name)!.body));
}

const assembled = PASSES.map((pass) => ({
  pass,
  file: code(read(pass.name)),
  module: code(passSource(pass.name, DEFAULT_SHADE_WGSL)),
}));

describe('pass files', () => {
  it.each(assembled)('$pass.name declares one vertex vs and one fragment fs', ({ file }) => {
    expect(file.match(/@vertex\s+fn\s+vs\s*\(/g)).toHaveLength(1);
    expect(file.match(/@fragment\s+fn\s+fs\s*\(/g)).toHaveLength(1);
    expect(file.match(/@(vertex|fragment|compute)\b/g)).toHaveLength(2);
    // One fragment output: location 0, a vec4f.
    const fs = /@fragment\s+fn\s+fs\s*\(([^)]*)\)\s*->\s*([^{]+)\{/.exec(file)!;
    expect(fs[2]!.replace(/\s+/g, ' ').trim()).toBe('@location(0) vec4f');
  });

  it.each(assembled)('$pass.name balances its brackets', ({ file, module }) => {
    for (const source of [file, module]) {
      for (const pair of ['{}', '()', '[]']) {
        let depth = 0;
        let lowest = 0;
        for (const char of source) {
          if (char === pair[0]) depth++;
          if (char === pair[1]) lowest = Math.min(lowest, --depth);
        }
        expect([pair, depth, lowest]).toEqual([pair, 0, 0]);
      }
    }
  });

  it.each(assembled)('$pass.name binds group 1 exactly when it has instances', ({ pass, file }) => {
    const pattern =
      /@group\((\d+)\)\s*@binding\((\d+)\)\s*var<storage,\s*read>\s*\w+\s*:\s*array<u32>;/g;
    const bindings = [...file.matchAll(pattern)];
    expect(file.match(/@group\(/g)?.length ?? 0).toBe(bindings.length);
    expect(bindings.map(([, group, binding]) => [group, binding])).toEqual(
      pass.instances ? [['1', '0']] : [],
    );
  });

  it('are shaded exactly as the renderer builds them', () => {
    for (const { pass, module } of assembled) {
      const shades = /\bshade\s*\(/.test(functionsOf(module).get('fs')!.body);
      expect([pass.name, shades, module.includes('struct Fragment')]).toEqual([
        pass.name,
        pass.shaded,
        pass.shaded,
      ]);
    }
  });
});

describe('assembled pass modules', () => {
  const uniformMembers = new Set(membersOf(code(common), 'Uniforms').map((member) => member.name));

  it.each(assembled)('$pass.name declares every module-scope name once', ({ module }) => {
    const names = declarations(module);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
    expect(names.filter((name) => RESERVED.has(name))).toEqual([]);
  });

  it.each(assembled)('$pass.name calls only what it declares or WGSL provides', ({ module }) => {
    expect(undeclaredCalls(module)).toEqual([]);
  });

  it.each(assembled)('$pass.name names only declared constants and members', ({ module }) => {
    const constants = new Set([...module.matchAll(/^const\s+(\w+)/gm)].map((match) => match[1]!));
    const screaming = [...module.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z]{2,}\b/g)];
    expect(screaming.map((m) => m[0]).filter((name) => !constants.has(name))).toEqual([]);
    const members = [...module.matchAll(/\bu\.(\w+)/g)].map((match) => match[1]!);
    expect(members.filter((name) => !uniformMembers.has(name))).toEqual([]);
  });

  it.each(assembled)('$pass.name names no local or parameter a reserved word', ({ module }) => {
    const names = new Set<string>();
    for (const match of module.matchAll(/\b(?:let|var)\s+(\w+)/g)) names.add(match[1]!);
    for (const { params } of functionsOf(module).values()) {
      for (const match of params.matchAll(/(\w+)\s*:/g)) names.add(match[1]!);
    }
    for (const match of module.matchAll(/^struct\s+(\w+)/gm)) {
      for (const member of membersOf(module, match[1]!)) names.add(member.name);
    }
    expect([...names].filter((name) => RESERVED.has(name))).toEqual([]);
  });

  it.each(assembled)('$pass.name interpolates integer varyings flat', ({ module }) => {
    expect(smoothIntegers(module)).toEqual([]);
    const locations = membersOf(module, 'VOut')
      .map((member) => /@location\((\d+)\)/.exec(member.attributes)?.[1])
      .filter((location) => location !== undefined);
    expect(new Set(locations).size).toBe(locations.length);
    // Core WebGPU guarantees 16 inter-stage variables; keep one spare.
    expect(locations.length).toBeLessThanOrEqual(15);
  });

  it.each(assembled)('$pass.name reads its instance buffer only in vs', ({ pass, module }) => {
    expect(fragmentInstanceReads(module)).toEqual([]);
    if (pass.instances) {
      const name = /@group\(1\)\s*@binding\(0\)\s*var<storage,\s*read>\s*(\w+)/.exec(module)![1]!;
      expect(functionsOf(module).get('vs')!.body).toContain(name);
    }
  });

  it.each(assembled)('$pass.name differentiates only at the top of fs', ({ module }) => {
    expect(nonUniformDerivatives(module)).toEqual([]);
  });

  it.each(assembled)('$pass.name builds every Fragment in field order', ({ pass, module }) => {
    const fields = membersOf(code(prelude), 'Fragment').map((member) => member.name);
    expect(fields).toEqual(['color', 'part', 'index', 'point', 'focus', 'value', 'along', 'time']);
    // `fn shade(f: Fragment)` names the type; only a construction is followed by a paren.
    const constructions = [...module.matchAll(/\bFragment\s*\(/g)];
    expect(constructions.length > 0).toBe(pass.shaded);
    for (const match of constructions) {
      expect(argumentCount(module, match.index + match[0].length - 1)).toBe(fields.length);
    }
  });
});

describe('host shades', () => {
  const uniformMembers = new Set(membersOf(code(common), 'Uniforms').map((member) => member.name));

  it('read the pointer, the host block, and the grid pitch by their unit names', () => {
    const shade = [
      'fn shade(f: Fragment) -> vec4f {',
      '  let d = distance(to_screen(f.point), u.pointer_px);',
      '  return f.color * exp(-d / max(u.host[0].x, u.grid_pitch));',
      '}',
    ].join('\n');
    for (const pass of PASSES.filter((entry) => entry.shaded)) {
      const module = code(passSource(pass.name, shade));
      expect(undeclaredCalls(module)).toEqual([]);
      const members = [...module.matchAll(/\bu\.(\w+)/g)].map((match) => match[1]!);
      expect(members.filter((name) => !uniformMembers.has(name))).toEqual([]);
    }
    // CSS pixels carry `_px`; the pitch is in diagram units and carries none.
    expect(uniformMembers).toContain('pointer_px');
    expect(uniformMembers).toContain('grid_pitch');
    expect(uniformMembers).not.toContain('pointer');
    expect(uniformMembers).not.toContain('grid');
  });
});

describe('pass geometry', () => {
  /** The block that follows the first `{` after `marker` in a function body. */
  const branch = (body: string, marker: string): string => {
    const at = body.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    return enclosed(body, body.indexOf('{', at));
  };

  it('keeps reduced-motion chevrons within their segment', () => {
    const fs = functionsOf(code(read('wire'))).get('fs')!.body;
    const reduced = branch(fs, 'display(DISPLAY_REDUCED)');
    expect(reduced).toMatch(/\bchevron_distance\(/);
    // Past either end `along` stops, so a chevron not cut at the span streaks on beyond the bend.
    expect(reduced).toMatch(/\bv\.span\b/);
  });

  it('dashes a wire preview along the whole preview rather than per leg', () => {
    const functions = functionsOf(code(read('overlay')));
    expect(functions.get('vs')!.body).toMatch(/overlay_buf\[at \+ OVERLAY_ALONG\]/);
    const preview = branch(functions.get('fs')!.body, 'v.kind == OVERLAY_PREVIEW');
    expect(preview).toMatch(/dash_distance\(px\(v\.along \+ s\)/);
  });
});

describe('the checks', () => {
  it('catch what they look for', () => {
    const broken = code(`
      @group(1) @binding(0) var<storage, read> things: array<u32>;
      struct VOut {
        @builtin(position) pos: vec4f,
        @location(0) index: u32,
        @location(1) @interpolate(flat) kind: u32,
      }
      fn peek(i: u32) -> u32 { return things[i]; }
      @fragment
      fn fs(v: VOut) -> @location(0) vec4f {
        if (v.index > 2u) { return vec4f(0.0); }
        let w = fwidth(f32(peek(v.index)));
        return vec4f(missing(w));
      }
    `).replace(/^[ \t]+(?=fn |@|struct |\})/gm, '');
    expect(undeclaredCalls(broken)).toEqual(['missing']);
    expect(smoothIntegers(broken)).toEqual(['index']);
    expect(nonUniformDerivatives(broken)).toEqual(['fs']);
    expect(fragmentInstanceReads(broken).sort()).toEqual(['peek']);
  });
});

describe('passSource', () => {
  it('splices the prelude, the shade, and the pass in order', () => {
    const shade = 'fn shade(f: Fragment) -> vec4f { return vec4f(1.0); }';
    const source = passSource('wire', shade);
    const at = (text: string) => source.indexOf(text);
    expect(at('struct Uniforms')).toBeLessThan(at('struct Fragment'));
    expect(at('struct Fragment')).toBeLessThan(at(shade));
    expect(at(shade)).toBeLessThan(at('wire_buf'));
    expect(passSource('glyph', shade)).not.toContain(shade);
    expect(passSource('glyph', shade)).not.toContain('struct Fragment');
    expect(() => passSource('nope' as PassName)).toThrow(RangeError);
  });
});
