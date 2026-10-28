#!/usr/bin/env node
// Pins every static asset to the version in package.json so browsers can never mix files from
// two releases (GitHub Pages caches each file for 10 minutes; browsers cache heuristically).
//
//   node scripts/stamp-version.mjs          # rewrite index.html
//   node scripts/stamp-version.mjs --check  # exit 1 when index.html is out of date (used by tests/CI)
//
// What it does:
//   • styles.css?v=, config.js?v=, app.js?v=  → current version
//   • <script type="importmap"> between the importmap markers lists every js/**/*.js file with ?v=,
//     so nested `import './x.js'` statements resolve to versioned URLs as well.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function listModules(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listModules(full));
    else if (entry.endsWith('.js')) out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

export function buildIndexHtml(html, { modules = listModules(join(root, 'js')), version: v = version } = {}) {
  const imports = Object.fromEntries(modules.map((file) => [`./${file}`, `./${file}?v=${v}`]));
  const map = `<script type="importmap">${JSON.stringify({ imports }, null, 2)}</script>`;
  const start = '<!-- importmap:start';
  const end = '<!-- importmap:end -->';
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error('index.html is missing the importmap markers');
  const openTagEnd = html.indexOf('-->', a) + 3;
  const head = html.slice(0, openTagEnd);
  let out = `${head}\n  ${map}\n  ${html.slice(b)}`;
  out = out.replace(/(href|src)="(styles\.css|config\.js|app\.js)(\?v=[^"]*)?"/g, (_, attr, file) => `${attr}="${file}?v=${v}"`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const indexPath = join(root, 'index.html');
  const current = readFileSync(indexPath, 'utf8');
  const next = buildIndexHtml(current);
  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error(`index.html is not stamped for version ${version} — run: npm run stamp`);
      process.exit(1);
    }
    console.log(`index.html is stamped for ${version}`);
  } else if (next !== current) {
    writeFileSync(indexPath, next);
    console.log(`index.html stamped for ${version} (${Object.keys(JSON.parse(next.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports).length} modules pinned)`);
  } else console.log(`index.html already stamped for ${version}`);
}
