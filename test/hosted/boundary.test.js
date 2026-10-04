/** Hosted mode runs from the stdio install: no src/http/, no optional dependencies. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../../src/hosted/', import.meta.url);
const optional = Object.keys(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).optionalDependencies);

it('src/hosted imports nothing from src/http or optional dependencies', () => {
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map(m => m[1]);
    for (const spec of specifiers) {
      assert.ok(!spec.includes('/http/') && !spec.startsWith('../http'), `${file} imports ${spec}`);
      assert.ok(!optional.includes(spec.split('/')[0]), `${file} imports optional dependency ${spec}`);
    }
  }
});
