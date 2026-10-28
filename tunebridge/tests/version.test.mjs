import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndexHtml } from '../scripts/stamp-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const html = readFileSync(join(root, 'index.html'), 'utf8');

function walk(dir) {
  return readdirSync(dir).sort().flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : entry.endsWith('.js') ? [relative(root, full)] : [];
  });
}

test('index.html is stamped with the package version (run `npm run stamp` after bumping)', () => {
  assert.equal(buildIndexHtml(html), html, 'index.html differs from the stamped output');
  for (const file of ['styles.css', 'config.js', 'app.js']) assert.ok(html.includes(`${file}?v=${version}"`), `${file} is pinned to ${version}`);
});

test('the import map pins every module under js/ and nothing else', () => {
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  const files = walk(join(root, 'js'));
  assert.deepEqual(Object.keys(map.imports).sort(), files.map((f) => `./${f}`).sort());
  for (const [key, value] of Object.entries(map.imports)) assert.equal(value, `${key}?v=${version}`);
  const mapIndex = html.indexOf('<script type="importmap">');
  const appIndex = html.indexOf('<script type="module"');
  assert.ok(mapIndex > -1 && mapIndex < appIndex, 'import map must come before the module script');
});

test('every relative import in the code base points at a file the import map knows', () => {
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  const known = new Set(Object.keys(map.imports).map((k) => k.slice(2)));
  const files = ['app.js', ...walk(join(root, 'js'))];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const resolved = relative(root, join(root, dirname(file), match[1])).split('\\').join('/');
      assert.ok(known.has(resolved), `${file} imports ${match[1]} → ${resolved} which is not in the import map`);
    }
  }
});
