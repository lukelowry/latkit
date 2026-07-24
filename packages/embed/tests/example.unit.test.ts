// @vitest-environment jsdom

import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from 'vitest';

import { parseNetwork } from '../src/index.js';

const TEST_CWD = cwd();
const WORKSPACE_ROOT =
  basename(dirname(TEST_CWD)) === 'packages' ? resolve(TEST_CWD, '../..') : TEST_CWD;
const EXAMPLE = resolve(WORKSPACE_ROOT, 'examples/embed');

describe('embed contract example', () => {
  it('demonstrates the complete declarative contract with useful data and fallback', async () => {
    const page = new DOMParser().parseFromString(
      await readFile(resolve(EXAMPLE, 'index.html'), 'utf8'),
      'text/html',
    );
    const element = page.querySelector('latkit-network');
    if (!element) throw new Error('example is missing its latkit-network element');

    expect(element.getAttribute('controls')).toBe(
      'caption projection navigation colormap channels legends',
    );
    expect(element.getAttribute('projection')).toBe('tilt');
    expect(element.getAttribute('border-source')).toBe('natural-earth');
    for (const attribute of [
      'poles',
      'borders',
      'graticule',
      'earth-axis',
      'daylight',
      'focus-enabled',
    ]) {
      expect(element.hasAttribute(attribute), attribute).toBe(true);
    }

    for (const attribute of [
      'base-color',
      'graticule-color',
      'surface-color',
      'border-color',
      'hover-color',
      'selected-color',
    ]) {
      const channels = element.getAttribute(attribute)?.trim().split(/\s+/).map(Number);
      expect(channels, attribute).toHaveLength(4);
      expect(
        channels?.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1),
      ).toBe(true);
    }
    for (const attribute of ['night-floor', 'surface-night-floor', 'terminator-width']) {
      expect(Number.isFinite(Number(element.getAttribute(attribute))), attribute).toBe(true);
    }

    const inline = element.querySelector<HTMLScriptElement>('script[type="application/json"]');
    if (!inline?.textContent) throw new Error('example is missing inline network JSON');
    const data = parseNetwork(JSON.parse(inline.textContent));
    const coordinates = data.topology.vertexCoords;
    if (!coordinates) throw new Error('example topology is missing geographic coordinates');

    expect(data.topology.vertexCount).toBeGreaterThan(2);
    expect(coordinates).toHaveLength(data.topology.vertexCount * 2);
    expect(data.topology.edges.length / 2).toBeGreaterThan(2);
    for (let index = 0; index < coordinates.length; index += 2) {
      expect(coordinates[index]).toBeGreaterThanOrEqual(-180);
      expect(coordinates[index]).toBeLessThanOrEqual(180);
      expect(coordinates[index + 1]).toBeGreaterThanOrEqual(-90);
      expect(coordinates[index + 1]).toBeLessThanOrEqual(90);
    }

    const fields = data.fields ?? [];
    expect(fields.filter((field) => field.scope === 'vertex').length).toBeGreaterThanOrEqual(2);
    expect(fields.filter((field) => field.scope === 'edge').length).toBeGreaterThanOrEqual(2);
    const fieldsById = new Map(fields.map((field) => [field.id, field]));
    for (const [attribute, id, scope] of [
      ['vertex-color', 'voltage', 'vertex'],
      ['vertex-height', 'generation', 'vertex'],
      ['vertex-size', 'capacity', 'vertex'],
      ['edge-color', 'flow', 'edge'],
      ['edge-dash', 'in-service', 'edge'],
    ] as const) {
      expect(element.getAttribute(attribute), attribute).toBe(id);
      const field = fieldsById.get(id);
      expect(field?.scope, id).toBe(scope);
      expect(field?.values, id).toHaveLength(
        scope === 'vertex' ? data.topology.vertexCount : data.topology.edges.length / 2,
      );
    }

    expect(element.querySelector('.fallback')?.textContent?.trim()).toContain('WebGPU');
    expect(element.querySelectorAll('button, select, fieldset, output')).toHaveLength(0);

    const recipes = [...page.querySelectorAll('pre code')].map((node) => node.textContent ?? '');
    expect(recipes.some((recipe) => recipe.includes('controls="none"'))).toBe(true);
    expect(
      recipes.some((recipe) =>
        recipe.includes(
          'controls="caption projection vertex-color edge-color vertex-color-legend"',
        ),
      ),
    ).toBe(true);
  });

  it('uses JavaScript only for registration and readiness status', async () => {
    const source = await readFile(resolve(EXAMPLE, 'src/main.ts'), 'utf8');

    expect(source).toContain("import '@latkit/embed/register';");
    expect(source).not.toContain('@latkit/network');
    expect(source).not.toMatch(/\bcreateNetwork\b|\.shadowRoot\b/);
    expect(
      new Set([...source.matchAll(/\belement\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1])),
    ).toEqual(new Set(['ready']));
  });
});
