import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { git } from '../src/runner-process.mjs';
import { openStore } from '../src/store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(root, 'data/demo-repository');
await mkdir(source, { recursive: true });
let exists = false; try { await access(resolve(source, '.git')); exists = true; } catch {}
if (!exists) {
  await writeFile(resolve(source, 'hello.mjs'), 'export const greeting = "helo";\n');
  await writeFile(resolve(source, 'package.json'), '{"name":"forge-runner-demo","private":true}\n');
  await writeFile(resolve(source, 'README.md'), '# Local runner fixture\n\nA disposable demonstration repository.\n');
  await git(['init','--quiet','-b','main'], { cwd: source });
  await git(['add','--all'], { cwd: source });
  await git(['-c','user.name=Forge Demo','-c','user.email=demo@localhost','commit','--quiet','-m','Runner fixture'], { cwd: source });
}
const store = openStore(resolve(root, process.env.FORGE_DB || 'data/forge.sqlite'));
store.connect({ id: -1, full_name: 'local/runner-demo', html_url: '', source_kind: 'local',
  description: 'Local Git fixture for scoped-edit runner acceptance. Not a GitHub repository.', default_branch: 'main', private: false });
store.close();
console.log('Demo source ready. Create a task for local/runner-demo, approve its plan, then run:');
console.log(JSON.stringify([{ path: 'hello.mjs', before: '"helo"', after: '"hello"' }], null, 2));
if (!process.argv.includes('--setup-only')) {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, FORGE_LOCAL_REPOSITORIES: JSON.stringify({ 'local/runner-demo': source }) } });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
