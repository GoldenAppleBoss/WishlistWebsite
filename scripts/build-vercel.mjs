import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imagePaths, pagePaths } from '../lib/catalogue.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const output = join(dist, 'vercel');
for (const directory of [dist, output]) {
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new Error('Build output must be a local directory: ' + directory);
  }
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const html = readFileSync(join(root, 'index.html'), 'utf8').replace('</head>',
  '  <meta name="wishlist-hosted" content="vercel">\n</head>');
for (const path of pagePaths) {
  const file = join(output, path === '/' ? 'index.html' : path.slice(1) + '.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

for (const name of ['style.css', 'wishlist.js', 'favicon.svg', ...[...imagePaths].map(path => path.slice(1))]) {
  const destination = join(output, name);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, name), destination);
}
