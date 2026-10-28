// Trusted, fixed worker: repository files are data, never imported or evaluated.
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isUtf8 } from 'node:buffer';

export function editPath(value) {
  if (typeof value !== 'string' || value.length > 240 || !value || value.includes('\\') ||
      value.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') ||
      /[\x00-\x1f<>:"|?*]/.test(value) || value.startsWith('/') ||
      value.split('/').some(p => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || /[. ]$/.test(p)))
    throw new Error('Invalid or reserved relative file path');
  return value;
}
export function validateEdits(edits) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 20) throw new Error('Provide 1–20 file edits');
  const seen = new Set();
  let bytes = 0;
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') throw new Error('Invalid file edit');
    editPath(edit.path);
    const key = edit.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate edit path');
    seen.add(key);
    if ((edit.before !== null && (typeof edit.before !== 'string' || !edit.before)) ||
        typeof edit.after !== 'string' || edit.after.includes('\0') || edit.before === edit.after)
      throw new Error('Each edit needs a unique nonempty before string (or null for a new file) and different after text');
    bytes += Buffer.byteLength(edit.after) + Buffer.byteLength(edit.before ?? '');
  }
  if (bytes > 256 * 1024) throw new Error('Edits exceed 256 KiB');
  return edits.map(({ path, before, after }) => ({ path, before, after }));
}

export function applyEdits(root, edits) {
  const checks = [];
  // Validate every edit before any write, so a stale replacement is atomic at this stage.
  const prepared = validateEdits(edits).map(edit => {
    const target = resolve(root, edit.path);
    const rel = relative(root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('File escaped workspace');
    let parent = target;
    while (parent !== root) {
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('Symbolic links are not supported');
      parent = dirname(parent);
    }
    const exists = existsSync(target);
    if (edit.before === null && exists) throw new Error(`New file already exists: ${edit.path}`);
    if (edit.before !== null && !exists) throw new Error(`Source file is missing: ${edit.path}`);
    const bytes = exists ? readFileSync(target) : Buffer.alloc(0);
    if (!isUtf8(bytes)) throw new Error('Only UTF-8 text files can be edited');
    const original = bytes.toString('utf8');
    if (original.includes('\0')) throw new Error('Binary file edits are not supported');
    if (edit.before !== null && (original.split(edit.before).length !== 2))
      throw new Error(`Before text must match exactly once: ${edit.path}`);
    const content = edit.before === null ? edit.after : original.replace(edit.before, () => edit.after);
    return { target, path: edit.path, content };
  });
  for (const file of prepared) {
    mkdirSync(dirname(file.target), { recursive: true }); writeFileSync(file.target, file.content);
    checks.push({ name: `edit:${file.path}`, status: 'passed', detail: `sha256:${createHash('sha256').update(file.content).digest('hex')}` });
    if (/^(<{7}|={7}|>{7})(?: |$)/m.test(file.content)) checks.push({ name: `conflicts:${file.path}`, status: 'failed', detail: 'Unresolved conflict marker' });
    else checks.push({ name: `conflicts:${file.path}`, status: 'passed', detail: 'No conflict markers' });
    if (file.path.endsWith('.json')) {
      try { JSON.parse(file.content); checks.push({ name: `json:${file.path}`, status: 'passed', detail: 'Valid JSON' }); }
      catch { checks.push({ name: `json:${file.path}`, status: 'failed', detail: 'Invalid JSON' }); }
    }
  }
  return { checks, files: prepared.map(f => f.path) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 600000) throw new Error('Worker input too large'); chunks.push(chunk); }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(JSON.stringify(applyEdits(resolve(input.root), input.edits)));
  } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}
