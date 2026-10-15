// Phone units' boot self-report into the runtime-vintage ledger (WI-10006790).
// The Phone acceptance rubric's live BARs declare
// runtime-vintage:<ws>/papercusp-phone-{sidecar,worker}.service@<host> as their evidence
// runtime, which only resolves when these units actually write that row on every start.
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVintageReport,
  parseArgs,
  postVintage,
  readCheckout,
} from '../../../../infra/phone-app/report-runtime-vintage.mjs';

const execFileAsync = promisify(execFile);
const phoneDir = resolve(import.meta.dirname, '../../../../infra/phone-app');
const script = resolve(phoneDir, 'report-runtime-vintage.mjs');

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function sink(respond: (body: unknown) => { status: number; json: unknown }) {
  const received: Array<{ url: string | undefined; body: unknown }> = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ url: req.url, body });
    const out = respond(body);
    res.writeHead(out.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out.json));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no sink port');
  return { origin: `http://127.0.0.1:${address.port}`, received };
}

describe('report-runtime-vintage', () => {
  it('takes the pid from systemd $MAINPID and defaults origins to the release then staging operator', () => {
    const args = parseArgs(['--unit', 'papercusp-phone-sidecar.service'], { MAINPID: '4242' });
    expect(args).toMatchObject({ unit: 'papercusp-phone-sidecar.service', pid: 4242,
      origins: ['http://127.0.0.1:3070', 'http://127.0.0.1:3170'], workspace: 'papercusp-workspace' });
    expect(parseArgs(['--unit', 'u'], { MAINPID: 'garbage' }).pid).toBeNull();
    expect(() => parseArgs([], {})).toThrow(/--unit is required/);
  });

  it('requires a process for executable identity and never substitutes checkout HEAD', async () => {
    expect(() => parseArgs(['--unit', 'native', '--executable'], {})).toThrow(/requires a positive/);
    expect(parseArgs(['--unit', 'native', '--executable'], { MAINPID: '4242' }))
      .toMatchObject({ executable: true, pid: 4242 });
    const accepting = await sink(() => ({ status: 200, json: { ok: true } }));
    const { stdout } = await execFileAsync(process.execPath, [script, '--unit', 'native', '--executable',
      '--pid', String(process.pid), '--origin', accepting.origin], { cwd: phoneDir, timeout: 20_000 });
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true, treeSha: null });
    expect(accepting.received[0].body).toMatchObject({ treeSha: null, pid: process.pid,
      bundleVersion: expect.stringMatching(/^executable-sha256:[a-f0-9]{64}$/),
      extra: { identitySource: 'kernel-loaded-executable', uncommittedTrackedPaths: null } });
  });

  it('keeps a Node entry digest distinct from the interpreter executable and source HEAD', () => {
    expect(() => parseArgs(['--unit', 'bundle', '--node-entry'], {})).toThrow(/requires a positive/);
    expect(() => parseArgs(['--unit', 'bundle', '--node-entry', '--executable', '--pid', '7'], {}))
      .toThrow(/Choose/);
    const report = buildVintageReport({ unit: 'bundle', workspace: 'ws', pid: 7,
      dir: '/old-checkout', treeSha: 'a'.repeat(40), dirty: null, nodeEntryDigest: 'b'.repeat(64) });
    expect(report).toMatchObject({ treeSha: null, bundleVersion: `node-entry-sha256:${'b'.repeat(64)}`,
      extra: { identitySource: 'kernel-selected-node-entry' } });
  });

  it('builds exactly the body the loopback sink accepts, with the checkout sha and dirtiness', () => {
    const report = buildVintageReport({ unit: 'papercusp-phone-worker.service', workspace: 'ws',
      pid: 7, dir: '/x/worker', treeSha: 'a'.repeat(40), dirty: 2, now: new Date('2026-10-06T17:00:00Z') });
    expect(report).toEqual({
      unit: 'papercusp-phone-worker.service', workspaceId: 'ws', treeSha: 'a'.repeat(40),
      buildTime: '2026-10-06T17:00:00.000Z', bundleVersion: null, pid: 7,
      extra: { reporter: 'infra/phone-app/report-runtime-vintage.mjs', checkout: '/x/worker',
        uncommittedTrackedPaths: 2 },
    });
  });

  it('reads HEAD and counts tracked edits, and reports nulls instead of throwing outside a checkout', () => {
    const calls: string[][] = [];
    const fake = (args: string[]) => {
      calls.push(args);
      return args[0] === 'rev-parse' ? 'b'.repeat(40) + '\n' : ' M a.ts\n M b.ts\n';
    };
    expect(readCheckout('/repo', fake)).toEqual({ treeSha: 'b'.repeat(40), dirty: 2 });
    expect(calls[1]).toEqual(['status', '--porcelain', '--untracked-files=no']);
    expect(readCheckout('/nowhere', () => { throw new Error('not a git repository'); }))
      .toEqual({ treeSha: null, dirty: null });
  });

  it('falls through a refusing origin and records the row on the next one', async () => {
    const refusing = await sink(() => ({ status: 200, json: { ok: false, error: 'store down' } }));
    const accepting = await sink(() => ({ status: 200, json: { ok: true } }));
    const report = buildVintageReport({ unit: 'u', workspace: 'ws', pid: 1, dir: '/d', treeSha: 'c', dirty: 0 });
    const result = await postVintage(report, [refusing.origin, accepting.origin], 2000);
    expect(result).toMatchObject({ ok: true, origin: accepting.origin });
    expect(result.attempts[0]).toMatchObject({ ok: false, error: 'store down' });
    expect(accepting.received).toEqual([{ url: '/api/internal/runtime-vintage', body: report }]);
  });

  it('never fails the unit: exit 0 and ok:false when no operator answers', async () => {
    const { stdout } = await execFileAsync(process.execPath, [script, '--unit', 'u', '--pid', '9',
      '--origin', 'http://127.0.0.1:9', '--timeout-ms', '500'], { cwd: phoneDir, timeout: 20_000 });
    const out = JSON.parse(stdout.trim());
    expect(out).toMatchObject({ ok: false, unit: 'u', pid: 9 });
    expect(out.treeSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('never fails the unit on bad arguments either', async () => {
    const { stdout } = await execFileAsync(process.execPath, [script, '--bogus'], { timeout: 20_000 });
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: false });
  });

  it('is wired into both Phone unit templates as a non-fatal post-start step, and deploy.sh renders + pins it', async () => {
    for (const unit of ['papercusp-phone-sidecar.service', 'papercusp-phone-worker.service']) {
      const tmpl = await readFile(resolve(phoneDir, 'systemd', `${unit}.tmpl`), 'utf8');
      expect(tmpl).toContain(`ExecStartPost=-\${PHONE_NODE_BIN} \${PHONE_VINTAGE_SCRIPT} --unit ${unit}`);
    }
    const deploy = await readFile(resolve(phoneDir, 'deploy.sh'), 'utf8');
    expect(deploy).toContain(`content="\${content//'\${PHONE_VINTAGE_SCRIPT}'/$HERE/report-runtime-vintage.mjs}"`);
    expect(deploy).toMatch(/ARTIFACT_FILES=\([\s\S]*"\$HERE\/report-runtime-vintage\.mjs"/);
  });

  it('takes the first deploy-time backup only after the restarted sidecar rewrote its database discovery file', async () => {
    const deploy = await readFile(resolve(phoneDir, 'deploy.sh'), 'utf8');
    const marker = deploy.indexOf('restart_marker="$(date +%s)"');
    const restart = deploy.indexOf('systemctl --user restart "$u"');
    const wait = deploy.indexOf('(( $(stat -c %Y "$phone_discovery") >= restart_marker ))');
    const backup = deploy.indexOf('systemctl --user start papercusp-phone-backup.service');
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(restart);
    expect(wait).toBeGreaterThan(restart);
    expect(wait).toBeLessThan(backup);
    expect(deploy).toContain('phone_discovery="${PHONE_HOME:-$HOME/.papercusp-phone}/postgres.json"');
  });
});
