/** Compiles the generated GLSL ES 3.00 raster shaders in WebGL2 with WebGPU disabled, then
 * executes integer scans against a CPU reference. This checks the actual translated source,
 * including unsigned overflow, tails, recursive totals, and exact 32-bit texture reads. */
import fs from 'node:fs';
import path from 'node:path';
import { deadline, launch, STEP } from './browser.ts';

interface Binding {
  name: string;
  group: number;
  binding: number;
}
interface Entry {
  file: string;
  entry: string;
  stage: 'Vertex' | 'Fragment';
  textures: Binding[];
  uniforms: Binding[];
  code: string;
}
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node gate/webgl2.ts <generated shader directory>');
const modules: Record<string, Entry[]> = {};
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'shaders.json'), 'utf8')) as {
  file: string;
}[];
const filter = process.argv.find((arg) => arg.startsWith('--filter='))?.slice('--filter='.length);
const integer = process.argv.includes('--integer');
for (const file of manifest
  .map(({ file }) => file + '.glsl.json')
  .filter((name) => !filter || name.includes(filter))
  .filter((name) => !integer || /^raster\.(words|order)\./.test(name))) {
  const entries = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as Entry[];
  modules[file] = entries.map((entry) => ({
    ...entry,
    code: fs.readFileSync(path.join(directory, entry.file), 'utf8'),
  }));
}
if (!Object.keys(modules).length) throw new Error('No translated WebGL2 shaders found');
const constants = fs.readFileSync(path.join(directory, 'shaders.rs'), 'utf8');
const dimension = (name: string) => {
  const value = constants.match(new RegExp(`const ${name}: u32 = (0x[0-9a-f]+);`))?.[1];
  if (!value) throw new Error(`Missing generated ${name}`);
  return Number(value);
};
const dimensions = [dimension('WORD_WIDTH'), dimension('WORD_HEIGHT')];
const chrome = await launch(['--disable-webgpu'], process.argv.includes('--software') || undefined);
try {
  const page = await chrome.browser.newPage();
  page.on('console', (message) => console.log(message.text()));
  const result = await deadline(
    page.evaluate(
      ({ modules, dimensions }) => {
        const gl = document.createElement('canvas').getContext('webgl2', { antialias: false });
        if (!gl) throw new Error('WebGL2 context creation failed');
        const context = gl;
        const programs = new Map<string, WebGLProgram>();
        const compile = (entry: Entry) => {
          const shader = context.createShader(
            entry.stage === 'Vertex' ? context.VERTEX_SHADER : context.FRAGMENT_SHADER,
          )!;
          context.shaderSource(shader, entry.code);
          context.compileShader(shader);
          if (!context.getShaderParameter(shader, context.COMPILE_STATUS))
            throw new Error(`${entry.file}: ${context.getShaderInfoLog(shader)}`);
          return shader;
        };
        for (const [name, entries] of Object.entries(modules)) {
          const vertex = entries.find((entry) => entry.stage === 'Vertex');
          if (!vertex) throw new Error(`${name} has no vertex entry`);
          const vs = compile(vertex);
          for (const entry of entries.filter((entry) => entry.stage === 'Fragment')) {
            const started = performance.now();
            console.log(`Compiling ${entry.file}`);
            const fs = compile(entry);
            const program = gl.createProgram()!;
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS))
              throw new Error(`${entry.file}: ${gl.getProgramInfoLog(program)}`);
            gl.useProgram(program);
            const locations = (bindings: Binding[]) =>
              [...new Set(bindings.map((b) => `${b.group}:${b.binding}`))].sort();
            const textures = [...vertex.textures, ...entry.textures];
            const units = locations(textures);
            for (const binding of textures)
              gl.uniform1i(
                gl.getUniformLocation(program, binding.name),
                units.indexOf(`${binding.group}:${binding.binding}`),
              );
            const uniforms = [...vertex.uniforms, ...entry.uniforms];
            const slots = locations(uniforms);
            for (const binding of uniforms) {
              const index = gl.getUniformBlockIndex(program, binding.name);
              if (index !== gl.INVALID_INDEX)
                gl.uniformBlockBinding(
                  program,
                  index,
                  slots.indexOf(`${binding.group}:${binding.binding}`),
                );
            }
            programs.set(`${name}:${entry.entry}`, program);
            console.log(`Compiled ${entry.file} in ${(performance.now() - started).toFixed(1)}ms`);
            gl.deleteShader(fs);
          }
          gl.deleteShader(vs);
        }
        if (!programs.has('raster.words.main.wgsl.glsl.json:scan'))
          return { programs: programs.size };
        const [WIDTH, HEIGHT] = dimensions as [number, number];
        const ROW = WIDTH * 4,
          LAYER = ROW * HEIGHT;
        interface Words {
          texture: WebGLTexture;
          width: number;
          height: number;
          layers: number;
        }
        const allocated: WebGLTexture[] = [];
        function words(count: number, data?: Uint32Array): Words {
          const rows = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(count / ROW))));
          const height = Math.min(rows, HEIGHT),
            layers = Math.max(2, Math.ceil(rows / HEIGHT));
          const texture = context.createTexture()!;
          allocated.push(texture);
          context.bindTexture(context.TEXTURE_2D_ARRAY, texture);
          context.texStorage3D(
            context.TEXTURE_2D_ARRAY,
            1,
            context.RGBA32UI,
            WIDTH,
            height,
            layers,
          );
          context.texParameteri(
            context.TEXTURE_2D_ARRAY,
            context.TEXTURE_MIN_FILTER,
            context.NEAREST,
          );
          context.texParameteri(
            context.TEXTURE_2D_ARRAY,
            context.TEXTURE_MAG_FILTER,
            context.NEAREST,
          );
          if (data) {
            const padded = new Uint32Array(WIDTH * height * layers * 4);
            padded.set(data);
            context.texSubImage3D(
              context.TEXTURE_2D_ARRAY,
              0,
              0,
              0,
              0,
              WIDTH,
              height,
              layers,
              context.RGBA_INTEGER,
              context.UNSIGNED_INT,
              padded,
            );
          }
          return { texture, width: WIDTH, height, layers };
        }
        const frame = gl.createFramebuffer()!;
        const uniform = gl.createBuffer()!;
        gl.bindBuffer(gl.UNIFORM_BUFFER, uniform);
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, uniform);
        gl.enable(gl.SCISSOR_TEST);
        const group = 'raster.words.main.wgsl.glsl.json';
        function run(
          entry: string,
          source: Words,
          other: Words,
          output: Words,
          count: number,
          written: number,
          value = 0,
        ) {
          if (source.texture === output.texture || other.texture === output.texture)
            throw new Error('sample/attachment alias');
          const module = ['histogram', 'by_digit', 'rank'].includes(entry)
            ? 'raster.order.main.wgsl.glsl.json'
            : entry === 'scatter'
              ? 'raster.order.scatter.wgsl.glsl.json'
              : group;
          const program = programs.get(`${module}:${entry}`);
          if (!program) throw new Error(`Missing ${entry}`);
          context.useProgram(program);
          for (const [unit, input] of [source, other].entries()) {
            context.activeTexture(context.TEXTURE0 + unit);
            context.bindTexture(context.TEXTURE_2D_ARRAY, input.texture);
          }
          context.bindFramebuffer(context.FRAMEBUFFER, frame);
          for (let at = 0; at < written;) {
            const layer = Math.floor(at / LAYER),
              y = Math.floor(at / ROW) % HEIGHT,
              x = (at / 4) % WIDTH;
            const left = written - at;
            const n =
              x === 0 && left >= ROW
                ? Math.min(Math.floor(left / ROW) * ROW, LAYER - (at % LAYER))
                : Math.min(left, ROW - (at % ROW));
            context.framebufferTextureLayer(
              context.FRAMEBUFFER,
              context.COLOR_ATTACHMENT0,
              output.texture,
              0,
              layer,
            );
            if (
              context.checkFramebufferStatus(context.FRAMEBUFFER) !== context.FRAMEBUFFER_COMPLETE
            )
              throw new Error('Integer render target is incomplete');
            context.viewport(0, 0, WIDTH, output.height);
            if (entry === 'scatter') context.scissor(0, 0, WIDTH, output.height);
            else context.scissor(x, y, Math.min(n / 4, WIDTH), Math.ceil(n / ROW));
            context.bindBuffer(context.UNIFORM_BUFFER, uniform);
            context.bufferData(
              context.UNIFORM_BUFFER,
              new Uint32Array([0, 0, 0, count, layer, value, WIDTH, output.height]),
              context.STREAM_DRAW,
            );
            if (entry === 'scatter') {
              context.drawArraysInstanced(context.POINTS, 0, 1, count);
              at = (layer + 1) * LAYER;
            } else {
              context.drawArrays(context.TRIANGLES, 0, 3);
              at += n;
            }
          }
        }
        const aligned = (n: number) => Math.ceil(n / 4) * 4;
        function scan(input: Words, n: number): Words {
          const output = words(aligned(n + 1));
          let prefix = input;
          if (n > 64) {
            const blocks = Math.ceil(n / 64);
            const totals = words(aligned(blocks));
            run('scan_totals', input, input, totals, n, aligned(blocks));
            prefix = scan(totals, blocks);
          }
          run('scan', input, prefix, output, n, aligned(n + 1), Number(n > 64));
          return output;
        }
        function read(words: Words, count: number): Uint32Array {
          const result = new Uint32Array(count);
          context.bindFramebuffer(context.FRAMEBUFFER, frame);
          for (let layer = 0, at = 0; at < count; layer++, at += LAYER) {
            const pixels = new Uint32Array(ROW * words.height);
            context.framebufferTextureLayer(
              context.FRAMEBUFFER,
              context.COLOR_ATTACHMENT0,
              words.texture,
              0,
              layer,
            );
            context.readPixels(
              0,
              0,
              WIDTH,
              words.height,
              context.RGBA_INTEGER,
              context.UNSIGNED_INT,
              pixels,
            );
            result.set(pixels.subarray(0, Math.min(pixels.length, count - at)), at);
          }
          return result;
        }
        const sizes = [0, 1, 3, 4, 63, 64, 65, 1023, 1024, 4096, 8193, 1_000_003];
        for (const n of sizes) {
          const data = Uint32Array.from(
            { length: n },
            (_, i) => Math.imul(i, 0x9e3779b9) ^ 0x80000017,
          );
          const output = scan(words(Math.max(4, n), data), n);
          const actual = read(output, n + 1);
          let sum = 0;
          for (let i = 0; i <= n; i++) {
            if (actual[i] !== sum) throw new Error(`scan ${n} at ${i}: ${actual[i]} != ${sum}`);
            if (i < n) sum = (sum + data[i]!) >>> 0;
          }
          if (gl.getError() !== gl.NO_ERROR) throw new Error(`WebGL error after scan ${n}`);
          for (const texture of allocated.splice(0)) gl.deleteTexture(texture);
        }
        const orders = [1, 15, 16, 17, 1003, 65539, 600003];
        for (const n of orders) {
          const data = new Uint32Array(n * 4);
          for (let i = 0; i < n; i++)
            data.set(
              [
                i % 7 === 0
                  ? 0
                  : i % 7 === 1
                    ? 0xffffffff
                    : i % 7 === 2
                      ? 17
                      : Math.imul(i, 0x9e3779b9) >>> 0,
                i,
                i ^ 0xff800001,
                ~i,
              ],
              i * 4,
            );
          const expected = Array.from({ length: n }, (_, i) => i).sort(
            (a, b) => data[a * 4]! - data[b * 4]!,
          );
          let source = words(n * 4, data);
          const sides = [words(n * 4), words(n * 4)];
          const bins = Math.ceil(n / 16) * 16;
          const [blocks, counts, ranks] = [words(bins), words(bins), words(aligned(n))];
          for (let digit = 0; digit < 8; digit++) {
            run('histogram', source, source, blocks, n, bins, digit * 4);
            run('by_digit', blocks, blocks, counts, n, bins, digit * 4);
            const offsets = scan(counts, bins);
            run('rank', source, offsets, ranks, n, aligned(n), digit * 4);
            const destination = sides[digit % 2]!;
            run('scatter', source, ranks, destination, n, n * 4, digit * 4);
            source = destination;
          }
          const actual = read(source, n * 4);
          for (let i = 0; i < n; i++)
            for (let word = 0; word < 4; word++) {
              const wanted = data[expected[i]! * 4 + word];
              if (actual[i * 4 + word] !== wanted)
                throw new Error(
                  `radix ${n}, row ${i}, word ${word}: ${actual[i * 4 + word]} != ${wanted}`,
                );
            }
          if (gl.getError() !== gl.NO_ERROR) throw new Error(`WebGL error after radix ${n}`);
          for (const texture of allocated.splice(0)) gl.deleteTexture(texture);
        }
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          renderer: String(
            debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          ),
          programs: programs.size,
          scans: sizes.length,
          orders: orders.length,
          webgl: String(gl.getParameter(gl.VERSION)),
        };
      },
      { modules, dimensions },
    ),
    STEP,
    'WebGL2 raster validation',
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await chrome.close();
}
