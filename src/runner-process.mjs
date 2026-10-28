import { spawn } from 'node:child_process';
import { join } from 'node:path';

// Deliberately omit NODE_OPTIONS, credentials and user Git configuration.
export function processEnvironment() {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP, TMP: process.env.TEMP } : {}),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C'
  };
}

export function command(executable, args, { cwd, signal, input, maxBytes = 2 * 1024 * 1024, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: processEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe','pipe','pipe'] });
    const stdout = []; const stderr = []; let size = 0; let reason; let killing;
    const stop = error => {
      if (reason) return;
      reason = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        killing = new Promise(done => {
          const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          killer.on('error', () => { child.kill('SIGKILL'); done(); });
          killer.on('close', code => { if (code) child.kill('SIGKILL'); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => stop(Object.assign(new Error('Run cancelled'), { code: 'ABORT_ERR' }));
    const timer = setTimeout(() => stop(Object.assign(new Error('Command timed out'), { code: 'TIMEOUT' })), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', error => { reason ??= error; });
    for (const [stream, chunks] of [[child.stdout,stdout], [child.stderr,stderr]]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) stop(new Error('Command output exceeded its limit'));
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (killing) await killing;
      if (reason) reject(reason);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export async function git(args, options) {
  const result = await command('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','credential.helper=','-c','protocol.ext.allow=never', ...args], options);
  if (result.code !== 0) throw new Error(`Git operation failed: ${args[0]}`);
  return result.stdout;
}
