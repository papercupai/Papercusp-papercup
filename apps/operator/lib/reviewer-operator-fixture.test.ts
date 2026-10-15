import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { reviewerContext, runPairingControls, seedReviewer, captureNative,
  nativeCapturePreflight, validatePairedSummary, verifyNativeArtifact,
  verifyReviewerReadback } from '../../../scripts/reviewer-operator-assert.mjs';

const env = { PAPERCUSP_VERIFY_TAURI_ISOLATED: '1', PAPERCUSP_WORKSPACE_ID: 'verify-tauri-isolated-123',
  PAPERCUSP_WORKSPACE: 'verify-tauri-isolated-123', VERIFY_TAURI_PORT: '33710',
  MOBILE_DESKTOP_PUBLIC_URL: 'https://sanitized.trycloudflare.com' };
const payload = { qrPayload: { workspaceId: env.PAPERCUSP_WORKSPACE_ID,
  server: env.MOBILE_DESKTOP_PUBLIC_URL, pairToken: 'SECRET-MUST-NOT-BE-LOGGED' }, expiresAt: '2099-01-01T00:00:00Z' };

function fixture(statuses = [200, 200, 200, 200, 401, 403, 403], minted = payload) {
  const calls: { url: string; options: RequestInit }[] = [];
  const logs: string[] = [];
  const fetchImpl = async (url: string, options: RequestInit) => {
    const status = statuses[calls.length];
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('mint-pair-token') ? minted : {}), { status });
  };
  return { calls, logs, run: () => runPairingControls({ env, fetchImpl, log: (s: string) => logs.push(s) }) };
}

describe('isolated reviewer pairing controls', () => {
  it('uses the same real workspace payload locally before testing remote refusal, without logging secrets', async () => {
    const f = fixture();
    expect(await f.run()).toEqual(payload);
    expect(JSON.parse(f.calls[1].options.body as string)).toEqual({ workspaceId: env.PAPERCUSP_WORKSPACE_ID });
    expect(f.calls[5].options.body).toEqual(f.calls[1].options.body);
    expect(f.calls[1].url).toContain('127.0.0.1:33710');
    expect(f.calls[5].url).toContain('sanitized.trycloudflare.com');
    expect(f.logs.join('\n')).not.toContain(payload.qrPayload.pairToken);
    expect(f.calls.every(c => c.options.redirect === 'error')).toBe(true);
  });
  it.each([400, 404, 500])('rejects invalid local mint status %s before any external probe', async status => {
    const f = fixture([200, status]);
    await expect(f.run()).rejects.toThrow('local mint preflight');
    expect(f.calls).toHaveLength(2);
  });
  it.each([400, 404, 500, 200])('rejects tunnel mint status %s as security evidence', async status => {
    await expect(fixture([200, 200, 200, 200, 401, status]).run()).rejects.toThrow('tunnel mint refusal');
  });
  it('requires the local admin route to exist before testing its remote refusal', async () => {
    const f = fixture([200, 200, 404]);
    await expect(f.run()).rejects.toThrow('local admin preflight');
    expect(f.calls).toHaveLength(3);
  });
  it.each([
    { ...payload, qrPayload: { ...payload.qrPayload, workspaceId: 'papercusp-workspace' } },
    { ...payload, qrPayload: { ...payload.qrPayload, server: 'https://another.example' } },
    { ...payload, expiresAt: '2000-01-01T00:00:00Z' },
    { ...payload, qrPayload: { ...payload.qrPayload, pairToken: '' } },
  ])('rejects malformed or non-isolated local mint responses', async minted => {
    const f = fixture(undefined, minted);
    await expect(f.run()).rejects.toThrow('invalid isolated pairing payload');
    expect(f.calls).toHaveLength(2);
  });
  it.each([
    { ...env, PAPERCUSP_VERIFY_TAURI_ISOLATED: '0' },
    { ...env, PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' },
    { ...env, PAPERCUSP_WORKSPACE: 'papercusp-workspace' },
    { ...env, VERIFY_TAURI_PORT: 'invalid' },
    { ...env, MOBILE_DESKTOP_PUBLIC_URL: 'http://example.com' },
    { ...env, MOBILE_DESKTOP_PUBLIC_URL: 'https://secret@example.com' },
  ])('refuses unsafe context before making a request', badEnv => {
    expect(() => reviewerContext(badEnv)).toThrow();
  });
  it('does not echo token-bearing transport errors', async () => {
    await expect(runPairingControls({ env, fetchImpl: async () => {
      throw new Error(payload.qrPayload.pairToken);
    } })).rejects.toThrow('local health: transport failed');
  });
  it('seeds plans, inbox, fleet and the shared chat using existing tools and synthetic content', async () => {
    const calls: { name: string; args: unknown }[] = [];
    await seedReviewer({ env, invoke: async (name: string, args: unknown) => { calls.push({ name, args }); } });
    expect(calls.map(c => c.name)).toEqual(['plans:new', 'work_items:create', 'fleet:create',
      'conversation:append', 'conversation:append']);
    expect(JSON.stringify(calls)).not.toContain(payload.qrPayload.pairToken);
    expect(JSON.stringify(calls)).not.toContain('papercusp-workspace');
    expect(calls[0].args).toMatchObject({ status: 'draft', workspaceId: env.PAPERCUSP_WORKSPACE_ID });
  });
  it('refuses seeding an ambient live workspace before invoking any tool', async () => {
    let called = false;
    await expect(seedReviewer({ env: { ...env, PAPERCUSP_WORKSPACE_ID: 'papercusp-workspace' },
      invoke: async () => { called = true; } })).rejects.toThrow('disposable workspace');
    expect(called).toBe(false);
  });
  const readbackBodies: Record<string, unknown>[] = [
    { ...payload, qrPayload: { ...payload.qrPayload, pairToken: 'READBACK-PAIR-SECRET' } },
    { workspaceId: env.PAPERCUSP_WORKSPACE_ID, deviceToken: 'READBACK-DEVICE-SECRET' },
    { plans: [{ slug: 'reviewer-demo', title: 'Plan a small product update' }] },
    { workItems: [{ kind: 'change', state: 'open', title: 'Review the next product update' }] },
    { turns: [{ role: 'user', text: 'What is ready for my review?' }, { role: 'assistant',
      text: 'The product update draft is ready. You can review the plan and the work item in your Inbox.' }] },
  ];
  function readbackFixture(bodies = readbackBodies, failedAt = -1) {
    const calls: { url: string; options: RequestInit }[] = [];
    const logs: string[] = [];
    return { calls, logs, run: () => verifyReviewerReadback({ env,
      log: (s: string) => logs.push(s), fetchImpl: async (url: string, options: RequestInit) => {
        const index = calls.length;
        calls.push({ url, options });
        return new Response(JSON.stringify(bodies[index]), { status: index === failedAt ? 503 : 200 });
      } }) };
  }
  it('checks actual paired feeds with a separate token and keeps credentials out of logs', async () => {
    const f = readbackFixture();
    await f.run();
    expect(JSON.parse(f.calls[1].options.body as string)).toEqual({ pairToken: 'READBACK-PAIR-SECRET' });
    expect(f.calls.slice(2).every(c =>
      (c.options.headers as Record<string, string>).authorization === 'Bearer READBACK-DEVICE-SECRET')).toBe(true);
    expect(f.calls.slice(1).every(c => c.url.startsWith(env.MOBILE_DESKTOP_PUBLIC_URL))).toBe(true);
    expect(f.logs.join('\n')).not.toMatch(/SECRET/);
    expect(JSON.stringify(f.calls)).not.toContain(payload.qrPayload.pairToken);
  });
  it('refuses a paired device from another workspace before reading any feed', async () => {
    const bodies = [...readbackBodies];
    bodies[1] = { ...bodies[1], workspaceId: 'papercusp-workspace' };
    const f = readbackFixture(bodies);
    await expect(f.run()).rejects.toThrow('invalid isolated device');
    expect(f.calls).toHaveLength(2);
  });
  it.each([2, 3, 4])('refuses success without seeded content at feed %s', async index => {
    const bodies = [...readbackBodies];
    bodies[index] = {};
    await expect(readbackFixture(bodies).run()).rejects.toThrow('absent');
  });
  it('refuses an unavailable Inbox instead of accepting it as an empty success', async () => {
    await expect(readbackFixture(undefined, 3).run()).rejects.toThrow('seeded Inbox readback: unexpected HTTP status');
  });
  it('does not echo device credentials from readback transport failures', async () => {
    await expect(verifyReviewerReadback({ env, fetchImpl: async () => {
      throw new Error('READBACK-DEVICE-SECRET');
    } })).rejects.toThrow('readback mint: transport failed');
  });
  it.each([{ passedTests: 0, failedTests: 0, skippedTests: 1 },
    { passedTests: 1, failedTests: 1, skippedTests: 0 }, {}])('rejects incomplete native evidence', summary => {
    expect(() => validatePairedSummary(summary)).toThrow();
  });
  it('accepts the exact paired UI result required by the maintained native runner', () => {
    expect(() => validatePairedSummary({ passedTests: 1, failedTests: 0, skippedTests: 0 })).not.toThrow();
  });
});

describe('reviewer capture through the maintained non-Actions runner', () => {
  const temporary: string[] = [];
  afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
  const sha = 'a'.repeat(40);
  const source = { commit: sha, fingerprint: 'b'.repeat(64), dirty: false };
  const toolchain = { xcode: 'Xcode 26.2', iosSDK: '26.2' };
  const attempt = join(tmpdir(), 'papercusp-reviewer-attempts', '20261009T140000Z-12345678');
  const nativeEnv = { ...env, REVIEWER_NATIVE_HOST: 'avis-imac',
    REVIEWER_MOBILE_ROOT: join(tmpdir(), 'reviewer mobile checkout'), REVIEWER_MOBILE_SHA: sha };
  function base() { const path = mkdtempSync(join(tmpdir(), 'reviewer-native-test-')); temporary.push(path); return path; }
  function retainedFixture(summary = { passedTests: 1, failedTests: 0, skippedTests: 0 }) {
    const directory = base(), remote = join(directory, 'remote'), output = join(directory, 'output');
    mkdirSync(remote); mkdirSync(output);
    const contents: Record<string, string> = { 'paired-ui-summary.json': JSON.stringify(summary),
      'paired-ui-attachments/Inbox.png': 'candidate screenshot', 'paired-ui.xcresult/Info.plist': 'actual result bundle' };
    for (const [path, body] of Object.entries(contents)) {
      mkdirSync(join(remote, path, '..'), { recursive: true }); writeFileSync(join(remote, path), body);
    }
    const proof = { status: 'passed', executor: 'native-mac', mode: 'check', pairedUI: true,
      source, toolchain, attempt, artifacts: Object.entries(contents).map(([path, body]) => ({ path,
        size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') })),
      phases: ['paired-ui', 'paired-ui-guard', 'paired-ui-screenshots'].map(name => ({ name, exitCode: 0 })) };
    const save = () => writeFileSync(join(remote, 'result.json'), JSON.stringify(proof)); save();
    const calls: { args: string[]; input?: string }[] = [];
    const run = (args: string[], input?: string) => {
      calls.push({ args, input });
      if (args[0] === 'scp') { cpSync(remote, args.at(-1)!, { recursive: true }); return ''; }
      const request = JSON.parse(input!);
      return JSON.stringify({ ...proof, status: request.preflight ? 'preflight' : 'passed', pairPayloadRemoved: true });
    };
    return { remote, output, proof, save, calls, run, env: { ...nativeEnv, REVIEWER_OUTPUT_DIR: output } };
  }
  it.each([
    { REVIEWER_NATIVE_HOST: '-oProxyCommand=echo' }, { REVIEWER_NATIVE_HOST: 'host;echo' },
    { REVIEWER_MOBILE_ROOT: 'relative/path' }, { REVIEWER_MOBILE_SHA: 'staging' },
    { REVIEWER_NATIVE_HOST: '' },
  ])('refuses an ambiguous or unsafe native route before transport: %j', patch => {
    let called = false;
    expect(() => nativeCapturePreflight({ ...nativeEnv, ...patch }, () => { called = true; return ''; })).toThrow('explicit SSH host');
    expect(called).toBe(false);
  });
  it.each([
    { source: { ...source, commit: 'c'.repeat(40) } }, { source: { ...source, dirty: true } },
    { status: 'reused' }, { pairPayloadRemoved: false }, { toolchain: { ...toolchain, iosSDK: '18.2' } },
    { toolchain: { ...toolchain, xcode: 'Xcode 16.2' } }, { executor: 'actions' },
  ])('refuses a moved, dirty, stale or ineligible source receipt: %j', patch => {
    expect(() => nativeCapturePreflight(nativeEnv, () => JSON.stringify({ status: 'preflight',
      source, toolchain, executor: 'native-mac', mode: 'check', pairPayloadRemoved: true, ...patch }))).toThrow('refused');
  });
  it('retains the exact hashed paired bundle and passes its QR only on SSH stdin', async () => {
    const f = retainedFixture();
    await captureNative({ env: f.env, payload, run: f.run });
    expect(f.calls.map(c => c.args[0])).toEqual(['ssh', 'ssh', 'scp']);
    expect(JSON.stringify(f.calls.map(c => c.args))).not.toContain(payload.qrPayload.pairToken);
    expect(JSON.parse(f.calls[0].input!)).not.toHaveProperty('payload');
    expect(JSON.parse(f.calls[1].input!).payload).toEqual(payload.qrPayload);
    expect(f.calls[1].args.at(-1)).toContain('runner.main()');
    const receipt = JSON.parse(readFileSync(join(f.output, 'native-capture-receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ executor: 'native-mac', candidateSha: sha, pairPayloadRemoved: true, pairedSkipped: 0 });
    expect(statSync(join(f.output, 'native-capture-receipt.json')).mode & 0o077).toBe(0);
  });
  it('does not publish acceptance for a changed artifact', async () => {
    const f = retainedFixture(); writeFileSync(join(f.remote, 'paired-ui-attachments/Inbox.png'), 'tampered');
    await expect(captureNative({ env: f.env, payload, run: f.run })).rejects.toThrow('hash mismatch');
    expect(readdirSync(f.output)).not.toContain('native-capture-receipt.json');
  });
  it.each([{ passedTests: 0, failedTests: 0, skippedTests: 0 }, { passedTests: 1, failedTests: 0, skippedTests: 1 }])(
    'refuses paired skipped/empty evidence even with a valid artifact hash: %j', async summary => {
      const f = retainedFixture(summary);
      await expect(captureNative({ env: f.env, payload, run: f.run })).rejects.toThrow('one pass');
      expect(readdirSync(f.output)).not.toContain('native-capture-receipt.json');
    });
  it('requires the paired result bundle and executed screenshot phase', () => {
    const f = retainedFixture(); f.proof.phases.pop(); f.save();
    expect(() => verifyNativeArtifact(f.remote, sha)).toThrow('executed phases');
  });
  it.each(['../outside', '/etc/passwd'])('refuses artifact path escape %s', path => {
    const f = retainedFixture(); f.proof.artifacts[0].path = path; f.save();
    expect(() => verifyNativeArtifact(f.remote, sha)).toThrow('artifact path');
  });
  it('refuses an artifact directory symlink that reaches outside the receipt', () => {
    const f = retainedFixture(), outside = join(base(), 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, 'Inbox.png'), 'candidate screenshot');
    rmSync(join(f.remote, 'paired-ui-attachments'), { recursive: true });
    symlinkSync(outside, join(f.remote, 'paired-ui-attachments'));
    expect(() => verifyNativeArtifact(f.remote, sha)).toThrow('hash mismatch');
  });
  it('executes the actual quoted bridge and deletes private QR input after a failed runner', async () => {
    const directory = base(), root = join(directory, "mobile ' quoted"), state = join(directory, 'state');
    mkdirSync(join(root, 'tools'), { recursive: true }); mkdirSync(state);
    writeFileSync(join(root, 'tools/ios-ci.py'), `import json, os, sys
from pathlib import Path
def source_identity(root):
    return {'commit': '${sha}', 'fingerprint': '${source.fingerprint}', 'dirty': False}
def main():
    state = Path(os.environ['PAPERCUP_IOS_CI_STATE'])
    if '--pair-payload-file' in sys.argv:
        pair = Path(sys.argv[sys.argv.index('--pair-payload-file') + 1])
        assert pair.stat().st_mode & 0o077 == 0
        assert not pair.is_relative_to(Path(__file__).resolve().parents[1])
        raise RuntimeError('fixture failure')
    import datetime
    proof = {'status': 'preflight', 'source': source_identity(None), 'toolchain': {'xcode': 'Xcode 26.2', 'iosSDK': '26.2'}, 'executor': 'native-mac', 'mode': 'check', 'pairedUI': False, 'attempt': str(state / 'attempt'), 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (state / 'latest.json').write_text(json.dumps(proof))
    return 0
`);
    const calls: { args: string[]; input?: string }[] = [];
    const run = (args: string[], input?: string) => {
      calls.push({ args, input });
      const child = spawnSync('bash', ['-c', args.at(-1)!], { input, encoding: 'utf8',
        env: { ...process.env, PAPERCUP_IOS_CI_STATE: state } });
      expect(child.status).toBe(0);
      return child.stdout;
    };
    await expect(captureNative({ env: { ...nativeEnv, REVIEWER_MOBILE_ROOT: root,
      REVIEWER_OUTPUT_DIR: join(directory, 'output') }, payload, run })).rejects.toThrow('refused');
    expect(calls).toHaveLength(2);
    expect(readdirSync(state).some(name => name.startsWith('reviewer-pair-'))).toBe(false);
    expect(JSON.stringify(calls.map(c => c.args))).not.toContain(payload.qrPayload.pairToken);
  });
});
