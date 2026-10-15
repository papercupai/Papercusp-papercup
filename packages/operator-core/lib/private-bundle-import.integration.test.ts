/** Opt-in diagnosis of a retained bundle, without evaluating its host code. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const candidate = process.env.PAPERCUSP_PRIVATE_IMPORT_CANDIDATE;

// Observe after the existing source guard and optional tsx loader. Waiting at
// this boundary prevents evaluation, linking dependencies, and host startup;
// it never changes the source returned by an earlier loader.
const observer = `
  let candidate, port;
  export function initialize(data) { ({ candidate, port } = data); }
  export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    if (url === candidate) {
      port.postMessage({ format: result.format, bytes: Buffer.byteLength(result.source) });
      await new Promise(() => {});
    }
    return result;
  }
`;
const entry = `
  import { register } from 'node:module';
  import { MessageChannel } from 'node:worker_threads';
  const candidate = process.argv[1];
  const { port1, port2 } = new MessageChannel();
  port1.on('message', receipt => console.log('PRIVATE_IMPORT_LOADED ' + JSON.stringify(receipt)));
  register(process.argv[2], { data: { candidate, port: port2 }, transferList: [port2] });
  await import(candidate);
  throw new Error('observer failed to stop host evaluation');
`;

it.skipIf(!candidate)('compares plain Node and tsx loading of the identical retained private bundle', async () => {
  const bytes = await readFile(candidate!);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const privateHome = await mkdtemp(join(tmpdir(), 'private-bundle-import-'));
  const observations = [];
  try {
    for (const tsx of [false, true]) {
      const started = Date.now();
      const child = spawn(process.execPath, ['--input-type=module', '-e', entry,
        pathToFileURL(candidate!).href, 'data:text/javascript,' + encodeURIComponent(observer)], {
        cwd: root, env: { ...process.env, HOME: privateHome,
          // Match the failed fixture's ordinary V8 limit. The source guard is
          // present in BOTH arms; no source-fence or provider forwarding bypass.
          NODE_OPTIONS: '--import=' + join(root, 'scripts/lib/committed-source-loader.mjs')
            + (tsx ? ' --import=tsx' : '') }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let loaded: unknown;
      child.stdout.on('data', chunk => {
        output += String(chunk);
        const receipt = output.match(/^PRIVATE_IMPORT_LOADED (.+)$/m)?.[1];
        if (receipt && !loaded) { loaded = JSON.parse(receipt); child.kill('SIGTERM'); }
      });
      child.stderr.on('data', chunk => { output += String(chunk); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 100_000);
      const terminal = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => done({ code, signal }));
      }).finally(() => clearTimeout(timer));
      observations.push({ tsx, sha256, inputBytes: bytes.length, elapsedMs: Date.now() - started,
        loaded, ...terminal, fatal: output.match(/FATAL ERROR: [^\n]+/)?.[0], tail: output.slice(-1400) });
      console.info('PRIVATE_IMPORT_OBSERVATION ' + JSON.stringify(observations.at(-1)));
    }
    expect(observations[0].loaded).toMatchObject({ format: 'module', bytes: bytes.length });
    expect(observations[1].loaded).toBeUndefined();
    expect(observations[1].signal).toMatch(/^SIG(?:ABRT|KILL)$/);
  } finally { await rm(privateHome, { recursive: true, force: true }); }
}, 210_000);
