/** Builds from pinned workspace tools; all release and consumer outputs stay below target/npm. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { build, transform } from 'esbuild';
import { typescript } from './schema.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/npm');
const [mode, directory, version] = process.argv.slice(2);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

if (mode === 'prepare') {
  const stage = path.resolve(root, directory);
  assert.equal(path.dirname(stage), output);
  assert(!fs.existsSync(stage), 'release staging must be fresh');
  const manifest = read(path.join(root, 'npm/package.json'));
  assert.equal(manifest.version, version, 'Rust and npm versions must match');
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(root, 'npm/src'), path.join(stage, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'npm/tsconfig.json'), path.join(stage, 'tsconfig.json'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'npm/README.md'), path.join(stage, 'README.md'));
  delete manifest.scripts;
  delete manifest.devDependencies;
  write(path.join(stage, 'package.json'), manifest);
} else if (mode === 'schema') {
  const types = await typescript(path.join(root, 'npm/schema.json'));
  for (const [name, source] of Object.entries(types)) {
    fs.writeFileSync(path.join(root, `npm/src/${name}.ts`), source);
  }
} else if (mode === 'compile') {
  const stage = path.resolve(root, directory);
  const types = await typescript(path.join(root, 'npm/schema.json'));
  for (const [name, source] of Object.entries(types)) {
    assert.equal(
      fs.readFileSync(path.join(stage, `src/${name}.ts`), 'utf8').replaceAll('\r\n', '\n'),
      source,
      `src/${name}.ts is not what npm/schema.json says: run node npm/build.mjs schema`,
    );
  }
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', stage],
    {
      stdio: 'inherit',
    },
  );
  const dist = path.join(stage, 'dist');
  for (const file of fs.readdirSync(dist).filter((file) => file.endsWith('.js'))) {
    const source = path.join(dist, file);
    const result = await transform(fs.readFileSync(source, 'utf8'), {
      minify: true,
      format: 'esm',
      target: 'es2022',
    });
    fs.writeFileSync(source, result.code);
  }
  await build({
    entryPoints: [path.join(stage, 'src/worker.ts')],
    outfile: path.join(dist, 'worker.js'),
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    // wasm-bindgen's unused async initializer mentions import.meta; initSync doesn't need it.
    logOverride: { 'empty-import-meta': 'silent' },
    logLevel: 'warning',
  });
  const worker = fs.readFileSync(path.join(dist, 'worker.js'), 'utf8');
  assert(!worker.includes('import.meta'), 'standalone worker must not resolve assets or imports');
} else if (mode === 'report') {
  const stage = path.resolve(root, directory);
  const manifest = read(path.join(stage, 'package.json'));
  const tarball = path.join(output, `${manifest.name}-${manifest.version}.tgz`);
  const sizes = {};
  for (const folder of ['dist', 'pkg']) {
    for (const file of fs.readdirSync(path.join(stage, folder)).sort()) {
      if (!/\.(js|wasm)$/.test(file)) continue;
      const bytes = fs.readFileSync(path.join(stage, folder, file));
      sizes[`${folder}/${file}`] = {
        raw: bytes.length,
        gzip: gzipSync(bytes, { level: 9 }).length,
        brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
          .length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }
  }
  const report = {
    version: manifest.version,
    tarball,
    tools: {
      node: process.version,
      rust: execFileSync('rustc', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
      wasmBindgen: execFileSync('wasm-bindgen', ['--version'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      typescript: read(path.join(root, 'node_modules/typescript/package.json')).version,
      esbuild: read(path.join(root, 'node_modules/esbuild/package.json')).version,
    },
    sha256: createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
    sizes,
  };
  write(path.join(output, 'package.json'), report);
  console.log(JSON.stringify(report, null, 2));
} else if (mode === 'consumer') {
  const report = read(path.join(output, 'package.json'));
  assert.equal(
    createHash('sha256').update(fs.readFileSync(report.tarball)).digest('hex'),
    report.sha256,
  );
  const consumer = fs.mkdtempSync(path.join(output, 'consumer-'));
  fs.cpSync(path.join(root, 'npm/test/consumer'), consumer, { recursive: true });
  write(path.join(consumer, 'package.json'), {
    name: 'latkit-package-consumer',
    private: true,
    type: 'module',
  });
  write(path.join(output, 'package.json'), { ...report, consumer });
} else if (mode === 'publish') {
  // The tarball `package` built, published once per version; `changeset tag` then tags it.
  const report = read(path.join(output, 'package.json'));
  const { name, version } = read(path.join(root, 'npm/package.json'));
  assert.equal(report.version, version, 'the tarball must be of the version being released');
  assert.equal(
    createHash('sha256').update(fs.readFileSync(report.tarball)).digest('hex'),
    report.sha256,
  );
  const seen = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
  if (seen.status !== 0 && !seen.stderr?.includes('E404'))
    throw new Error(`npm view ${name}@${version}: ${seen.stderr || seen.error}`);
  if (seen.stdout.trim() === version) {
    console.log(`${name}@${version} is already published`);
  } else {
    execFileSync('npm', ['publish', report.tarball, '--provenance', '--access', 'public'], {
      stdio: 'inherit',
    });
  }
} else {
  throw new Error(`unknown build step: ${mode}`);
}
