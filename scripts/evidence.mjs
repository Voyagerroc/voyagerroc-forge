// npm run evidence:export -- --run <id> [--db <path>] [--out <file>]
// npm run evidence:verify -- <file> --repo <path to a local Git repository> [--json]
// Exit codes: 0 every verifiable claim matches, 1 at least one mismatch, 2 unusable input.
import { openStore } from '../src/store.mjs';
import { exportEvidence, parseBundle, verifyEvidence, formatReport, EvidenceInputError, MAX_BUNDLE_BYTES } from '../src/evidence.mjs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const USAGE = `Usage:
  npm run evidence:export -- --run <run id> [--db <database file>] [--out <file>]
  npm run evidence:verify -- <bundle file> --repo <path to a local Git repository> [--json]
`;
const unusable = message => { process.stderr.write(`${message}\n`); process.exitCode = 2; };

function options(args, flags, booleans = []) {
  const values = {}; const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (booleans.includes(arg)) values[arg] = true;
    else if (flags.includes(arg)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new EvidenceInputError(`${arg} needs a value.\n${USAGE}`);
      values[arg] = args[++i];
    } else if (arg.startsWith('--')) throw new EvidenceInputError(`Unknown option ${arg}.\n${USAGE}`);
    else positional.push(arg);
  }
  return { values, positional };
}

async function exportCommand(args) {
  const { values, positional } = options(args, ['--run', '--db', '--out']);
  if (positional.length || !values['--run']) throw new EvidenceInputError(`--run <run id> is required.\n${USAGE}`);
  const database = values['--db'] ?? process.env.FORGE_DB ?? 'data/forge.sqlite';
  if (!existsSync(database)) throw new EvidenceInputError(`Database ${database} does not exist.`);
  const out = values['--out'];
  if (out && existsSync(out)) throw new EvidenceInputError(`${out} already exists; it is not overwritten.`);
  const store = openStore(database, { readOnly: true });
  let text;
  try { text = exportEvidence(store, values['--run']); }
  catch (error) { throw error.status ? new EvidenceInputError(error.message) : error; }
  finally { store.close(); }
  if (out) { await writeFile(out, text, { flag: 'wx' }); process.stderr.write(`Evidence for run ${values['--run']} written to ${out}\n`); }
  else process.stdout.write(text);
}

async function verifyCommand(args) {
  const { values, positional } = options(args, ['--repo'], ['--json']);
  if (positional.length !== 1) throw new EvidenceInputError(`Give exactly one bundle file.\n${USAGE}`);
  if (!values['--repo']) throw new EvidenceInputError(`--repo <path to a local Git repository> is required.\n${USAGE}`);
  let info;
  try { info = await stat(positional[0]); } catch { throw new EvidenceInputError(`${positional[0]} cannot be read.`); }
  if (!info.isFile()) throw new EvidenceInputError(`${positional[0]} is not a file.`);
  if (info.size > MAX_BUNDLE_BYTES) throw new EvidenceInputError(`${positional[0]} is larger than ${MAX_BUNDLE_BYTES / (1024 * 1024)} MiB, which is more than a Forge bundle can be.`);
  const bundle = parseBundle(await readFile(positional[0]));
  const result = await verifyEvidence(bundle, values['--repo']);
  process.stdout.write(values['--json'] ? `${JSON.stringify(result, null, 2)}\n` : formatReport(result));
  process.exitCode = result.exitCode;
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'export') await exportCommand(rest);
  else if (command === 'verify') await verifyCommand(rest);
  else throw new EvidenceInputError(`Unknown or missing command.\n${USAGE}`);
} catch (error) {
  // Plain message, no stack: input problems are expected, and anything else is reported without internals.
  unusable(error instanceof EvidenceInputError ? error.message : `Could not complete: ${String(error.message).split('\n')[0]}`);
}
