import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git','node_modules','data','qa','graphify-out'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (extname(path) === '.md') files.push(path);
  }
  return files;
}
let checked = 0; const broken = [];
for (const file of await walk(root)) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^(?:[a-z]+:|#|\/\/)/i.test(target)) continue;
    const local = decodeURIComponent(target.split('#')[0]);
    if (!local) continue;
    checked++;
    try { await access(resolve(dirname(file), local)); }
    catch { broken.push(`${file.slice(root.length+1)} -> ${target}`); }
  }
}
if (broken.length) { console.error('Broken local documentation links:\n' + broken.join('\n')); process.exitCode = 1; }
else console.log(`Documentation links: ${checked} local targets verified`);
