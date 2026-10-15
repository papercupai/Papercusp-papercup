#!/usr/bin/env node
// WI-10007029: request/response controls for the existing isolated Tauri verifier.
// Responses may contain credentials. Log labels/statuses only; keep the QR private.
import { readFileSync, existsSync, lstatSync, realpathSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

/** @typedef {Record<string, string | undefined>} ReviewerEnvironment */
/**
 * @typedef {{ qrPayload: { workspaceId: string, server: string, pairToken: string }, expiresAt: string }} PairingPayload
 * @typedef {(url: string, options: RequestInit) => Promise<Response>} ReviewerFetch
 * @typedef {(args: string[], input?: string) => string} NativeRunner
 * @typedef {{ passedTests?: unknown, failedTests?: unknown, skippedTests?: unknown }} PairedSummary
 */

/** @param {ReviewerEnvironment} env */
export function reviewerContext(env) {
  const workspaceId = env.PAPERCUSP_WORKSPACE_ID;
  if (env.PAPERCUSP_VERIFY_TAURI_ISOLATED !== '1' ||
      !/^verify-tauri-isolated-\d+$/.test(workspaceId ?? '') ||
      env.PAPERCUSP_WORKSPACE !== workspaceId) {
    throw new Error('Reviewer controls require the verified disposable workspace');
  }
  const port = Number(env.VERIFY_TAURI_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Reviewer controls require the isolated operator port');
  }
  const publicUrl = new URL(env.MOBILE_DESKTOP_PUBLIC_URL);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
      publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('Reviewer controls require a credential-free HTTPS origin');
  }
  return { workspaceId, local: `http://127.0.0.1:${port}`, publicOrigin: publicUrl.origin,
    mintBody: JSON.stringify({ workspaceId }) };
}

/**
 * @param {{ env: ReviewerEnvironment, fetchImpl?: ReviewerFetch, log?: (message: string) => void, now?: number }} options
 * @returns {Promise<PairingPayload>}
 */
export async function runPairingControls({ env, fetchImpl = fetch, log = console.log, now = Date.now() }) {
  const ctx = reviewerContext(env);
  const request = async (label, origin, path, expected, body) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body } : {}),
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`${label}: transport failed`);
    }
    log(`REVIEWER: ${label} status=${response.status} expected=${expected}`);
    if (response.status !== expected) throw new Error(`${label}: unexpected HTTP status`);
    return response;
  };
  await request('local health', ctx.local, '/api/health', 200);
  // A schema-valid local mint proves that the exact payload reaches the handler
  // and names a real isolated workspace BEFORE remote refusal is measured.
  const mint = await request('local mint preflight', ctx.local,
    '/api/device/desktop/mint-pair-token', 200, ctx.mintBody);
  let payload;
  try { payload = await mint.json(); } catch { throw new Error('Local mint returned invalid JSON'); }
  if (payload?.qrPayload?.workspaceId !== ctx.workspaceId ||
      payload?.qrPayload?.server !== ctx.publicOrigin ||
      typeof payload?.qrPayload?.pairToken !== 'string' || !payload.qrPayload.pairToken ||
      !Number.isFinite(Date.parse(payload?.expiresAt)) || Date.parse(payload.expiresAt) <= now) {
    throw new Error('Local mint returned an invalid isolated pairing payload');
  }
  await request('local admin preflight', ctx.local, '/api/admin/tasks/inventory', 200);
  await request('tunnel health', ctx.publicOrigin, '/api/health', 200);
  await request('tunnel device without token', ctx.publicOrigin, '/api/device/operator/cards', 401);
  await request('tunnel mint refusal', ctx.publicOrigin,
    '/api/device/desktop/mint-pair-token', 403, ctx.mintBody);
  await request('tunnel admin refusal', ctx.publicOrigin, '/api/admin/tasks/inventory', 403);
  return payload;
}

/** @param {{ env: ReviewerEnvironment, invoke: (name: string, args: Record<string, unknown>) => Promise<unknown> }} options */
export async function seedReviewer({ env, invoke }) {
  reviewerContext(env); // Refuse ALL writes before constructing a tool call.
  const content = 'Sanitized demonstration content. No customer data or cloud-availability claim.';
  const calls = [
    ['plans:new', { harness: 'papercusp', workspaceId: env.PAPERCUSP_WORKSPACE_ID,
      slug: 'reviewer-demo', title: 'Plan a small product update',
      status: 'draft', content: `## Now\n${content}\n\n## Background\nReview the draft, implement the update, and verify the result.` }],
    ['work_items:create', { harness: 'papercusp', kind: 'change', state: 'open',
      title: 'Review the next product update', body: content }],
    ['fleet:create', { name: 'Product update team', description: content }],
    ['conversation:append', { role: 'user', source: 'text_typed', text: 'What is ready for my review?' }],
    ['conversation:append', { role: 'assistant', source: 'text_typed',
      text: 'The product update draft is ready. You can review the plan and the work item in your Inbox.' }],
  ];
  for (const [name, args] of calls) await invoke(name, args);
}

/** @param {{ env: ReviewerEnvironment, fetchImpl?: ReviewerFetch, log?: (message: string) => void }} options */
export async function verifyReviewerReadback({ env, fetchImpl = fetch, log = console.log }) {
  const ctx = reviewerContext(env);
  const request = async (label, origin, path, options = {}) => {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        ...options, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new Error(`${label}: transport failed`); }
    log(`REVIEWER: ${label} status=${response.status} expected=200`);
    if (response.status !== 200) throw new Error(`${label}: unexpected HTTP status`);
    try { return await response.json(); }
    catch { throw new Error(`${label}: invalid JSON`); }
  };
  const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
  // Use a DIFFERENT one-use token so readback does not consume the native QR.
  const minted = await request('readback mint', ctx.local,
    '/api/device/desktop/mint-pair-token', post({ workspaceId: ctx.workspaceId }));
  if (minted?.qrPayload?.workspaceId !== ctx.workspaceId ||
      minted?.qrPayload?.server !== ctx.publicOrigin ||
      typeof minted?.qrPayload?.pairToken !== 'string' || !minted.qrPayload.pairToken) {
    throw new Error('Readback mint returned an invalid isolated pairing payload');
  }
  const paired = await request('readback pair', ctx.publicOrigin, '/api/device/pair',
    post({ pairToken: minted.qrPayload.pairToken }));
  if (paired?.workspaceId !== ctx.workspaceId ||
      typeof paired?.deviceToken !== 'string' || !paired.deviceToken) {
    throw new Error('Readback pairing returned an invalid isolated device');
  }
  const auth = { headers: { authorization: `Bearer ${paired.deviceToken}` } };
  const plans = await request('seeded plans readback', ctx.publicOrigin, '/api/device/plans', auth);
  if (!plans?.plans?.some(p => p.slug === 'reviewer-demo' && p.title === 'Plan a small product update')) {
    throw new Error('Seeded plan is absent from the paired device feed');
  }
  const inbox = await request('seeded Inbox readback', ctx.publicOrigin, '/api/device/attention', auth);
  if (!inbox?.workItems?.some(w => w.kind === 'change' && w.state === 'open' &&
      w.title === 'Review the next product update')) {
    throw new Error('Seeded work item is absent from the paired Inbox feed');
  }
  const chat = await request('seeded chat readback', ctx.publicOrigin,
    '/api/device/operator/conversation', auth);
  if (!chat?.turns?.some(t => t.role === 'user' && t.text === 'What is ready for my review?') ||
      !chat?.turns?.some(t => t.role === 'assistant' && t.text ===
        'The product update draft is ready. You can review the plan and the work item in your Inbox.')) {
    throw new Error('Seeded conversation is absent from the paired chat feed');
  }
  log('REVIEWER: sanitized Plans, Inbox and chat readback passed');
}

function invokeIsolated(env, name, args) {
  const ctx = reviewerContext(env);
  if (!env.PAPERCUSP_HOME) throw new Error('Isolated tool call requires its private home');
  const tokenFile = resolve(env.PAPERCUSP_HOME, 'superuser-token');
  // Explicit endpoint/token/workspace prevent the CLI's shared-host recovery
  // and ambient proxy configuration from sending a seed to a live workspace.
  const child = spawnSync('ptool', [`--url=${ctx.local}`, `--token-file=${tokenFile}`,
    `--workspace=${ctx.workspaceId}`, name, '--json', '-'], {
    input: JSON.stringify({ ...args, payloadTier: 'full' }), encoding: 'utf8',
    timeout: 60_000, maxBuffer: 2_000_000,
    env: { ...env, PAPERCUSP_MCP_TOKEN_FILE: tokenFile, PAPERCUSP_OPERATOR_BASE: ctx.local,
      PAPERCUSP_OPERATOR_URL: ctx.local, PAPERCUSP_MCP_PROXY_BASE: '' },
  });
  if (child.error || child.status !== 0) throw new Error(`Isolated seed tool failed: ${name}`);
  let result;
  try { result = JSON.parse(child.stdout); } catch { throw new Error(`Invalid seed receipt: ${name}`); }
  if (result?.ok === false || result?.isError || result?.data?.ok === false) {
    throw new Error(`Isolated seed tool refused: ${name}`);
  }
  console.log(`REVIEWER: sanitized seed accepted tool=${name}`);
}

// Adapt the maintained executor, including its shared state lock, rather than
// duplicating its build/test/signing pipeline. The QR travels only on stdin.
const NATIVE_BRIDGE = `import contextlib, datetime, importlib.util, json, os, sys, tempfile, uuid
from pathlib import Path
request = json.load(sys.stdin)
root = Path(request['root']).resolve()
state = Path(os.environ.get('PAPERCUP_IOS_CI_STATE', str(Path.home() / '.local/state/papercusp/ios-ci'))).resolve()
os.umask(0o077)
state.mkdir(parents=True, exist_ok=True)
log = state / ('reviewer-' + uuid.uuid4().hex + '.log')
pair_path = None
reply = {'status': 'failed', 'log': str(log)}
try:
    if state.is_relative_to(root):
        raise ValueError('Native evidence state must be outside source')
    spec = importlib.util.spec_from_file_location('reviewer_ios_ci', root / 'tools/ios-ci.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    source = runner.source_identity(root)
    if source['commit'] != request['sha'] or source['dirty']:
        raise ValueError('Native source is not the exact clean candidate')
    started = datetime.datetime.now(datetime.timezone.utc)
    sys.argv = [str(root / 'tools/ios-ci.py'), '--mode', 'check', '--force']
    if request['preflight']:
        sys.argv += ['--preflight']
    else:
        with tempfile.NamedTemporaryFile(mode='w', dir=state, prefix='reviewer-pair-', delete=False) as private:
            pair_path = Path(private.name)
            json.dump(request['payload'], private)
        sys.argv += ['--paired-ui', '--pair-payload-file', str(pair_path)]
    with log.open('x') as stream, contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
        code = runner.main()
    proof = json.loads((state / 'latest.json').read_text())
    expected = 'preflight' if request['preflight'] else 'passed'
    if (code != 0 or proof['status'] != expected or proof['source'] != source
            or datetime.datetime.fromisoformat(proof['startedAt']) < started):
        raise ValueError('Native runner did not produce fresh accepted evidence')
    reply.update({key: proof[key] for key in ('status', 'source', 'toolchain', 'attempt', 'executor', 'mode', 'pairedUI')})
except Exception:
    reply['status'] = 'failed'
finally:
    if pair_path is not None:
        pair_path.unlink(missing_ok=True)
    reply['pairPayloadRemoved'] = pair_path is None or not pair_path.exists()
print(json.dumps(reply))
`;

function nativeChecked(args, input) {
  const child = spawnSync(args[0], args.slice(1), { input, encoding: 'utf8', maxBuffer: 2_000_000,
    timeout: 65 * 60_000 });
  // Native failures can include credentials. Retain the runner's private log,
  // but never copy arbitrary stdout/stderr into an error or terminal message.
  if (child.error || child.status !== 0) throw new Error(`Native capture transport failed: ${args[0]}`);
  return child.stdout;
}

function nativeConfig(env) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(env.REVIEWER_NATIVE_HOST ?? '') ||
      !env.REVIEWER_MOBILE_ROOT || !isAbsolute(env.REVIEWER_MOBILE_ROOT) ||
      !/^[a-f0-9]{40}$/.test(env.REVIEWER_MOBILE_SHA ?? '')) {
    throw new Error('Native capture requires an explicit SSH host, absolute mobile root and exact candidate SHA');
  }
  return { host: env.REVIEWER_NATIVE_HOST, root: env.REVIEWER_MOBILE_ROOT, sha: env.REVIEWER_MOBILE_SHA };
}

function invokeNative(env, run, preflight, payload = undefined) {
  const config = nativeConfig(env);
  // SSH joins remote argv through a shell; quote the static Python program.
  const quoted = "'" + NATIVE_BRIDGE.replaceAll("'", "'\\''") + "'";
  const raw = run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '--', config.host,
    `python3 -c ${quoted}`], JSON.stringify({ root: config.root, sha: config.sha, preflight, payload }));
  let proof;
  try { proof = JSON.parse(raw); } catch { throw new Error('Invalid native capture receipt'); }
  if (proof?.status !== (preflight ? 'preflight' : 'passed') || proof?.executor !== 'native-mac' ||
      proof?.mode !== 'check' || proof?.source?.commit !== config.sha || proof?.source?.dirty !== false ||
      !/^[a-f0-9]{64}$/.test(proof?.source?.fingerprint ?? '') || proof?.pairPayloadRemoved !== true ||
      !/^\d+(?:\.\d+)*$/.test(proof?.toolchain?.iosSDK ?? '') ||
      Number.parseInt(proof?.toolchain?.iosSDK ?? '', 10) < 26 ||
      !/^Xcode (?:2[6-9]|[3-9]\d)\./.test(proof?.toolchain?.xcode ?? '') ||
      (!preflight && proof?.pairedUI !== true)) {
    throw new Error('Native capture refused the exact clean candidate or its fresh paired evidence');
  }
  return proof;
}

/** @param {ReviewerEnvironment} env @param {NativeRunner} [run] */
export function nativeCapturePreflight(env, run = nativeChecked) {
  invokeNative(env, run, true);
  return env.REVIEWER_MOBILE_SHA;
}

/** @param {PairedSummary | null | undefined} summary */
export function validatePairedSummary(summary) {
  if (summary?.passedTests !== 1 || summary?.failedTests !== 0 || summary?.skippedTests !== 0) {
    throw new Error('Paired native evidence requires one pass, zero failures and zero skips');
  }
}

/** @param {string} root @param {string} sha */
export function verifyNativeArtifact(root, sha) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() ||
      !lstatSync(resolve(root, 'result.json')).isFile() || lstatSync(resolve(root, 'result.json')).isSymbolicLink()) {
    throw new Error('Native receipt must be a regular file in its own artifact directory');
  }
  const canonicalRoot = realpathSync(root);
  const proof = JSON.parse(readFileSync(resolve(root, 'result.json'), 'utf8'));
  if (proof?.status !== 'passed' || proof?.executor !== 'native-mac' || proof?.mode !== 'check' ||
      proof?.pairedUI !== true || proof?.source?.commit !== sha || proof?.source?.dirty !== false ||
      !Array.isArray(proof?.artifacts) || !Array.isArray(proof?.phases)) {
    throw new Error('Downloaded native receipt does not identify the admitted paired candidate');
  }
  const paths = new Set();
  for (const entry of proof.artifacts) {
    if (typeof entry.path !== 'string' || isAbsolute(entry.path) ||
        entry.path.split('/').some(part => part === '..' || !part) || paths.has(entry.path)) {
      throw new Error('Invalid native artifact path');
    }
    paths.add(entry.path);
    const path = resolve(root, entry.path);
    const stat = lstatSync(path);
    const resolved = relative(canonicalRoot, realpathSync(path));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size ||
        resolved.startsWith('..') || isAbsolute(resolved)) {
      throw new Error('Native artifact size or hash mismatch');
    }
    // Archives can exceed Node's whole-file buffer ceiling. Hash bounded chunks.
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    const fd = openSync(path, 'r');
    try {
      let length;
      while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    } finally { closeSync(fd); }
    if (hash.digest('hex') !== entry.sha256) throw new Error('Native artifact size or hash mismatch');
  }
  if (!paths.has('paired-ui-summary.json') ||
      ![...paths].some(path => path.startsWith('paired-ui-attachments/') && path.endsWith('.png')) ||
      ![...paths].some(path => path.startsWith('paired-ui.xcresult/')) ||
      ['paired-ui', 'paired-ui-guard', 'paired-ui-screenshots'].some(name =>
        !proof.phases.some(phase => phase.name === name && phase.exitCode === 0))) {
    throw new Error('Native paired result, executed phases or screenshots are absent');
  }
  validatePairedSummary(JSON.parse(readFileSync(resolve(root, 'paired-ui-summary.json'), 'utf8')));
  return proof;
}

/**
 * @param {{ env: ReviewerEnvironment, payload: PairingPayload, run?: NativeRunner }} options
 */
export async function captureNative({ env, payload, run = nativeChecked }) {
  const ctx = reviewerContext(env);
  if (payload?.qrPayload?.workspaceId !== ctx.workspaceId || payload?.qrPayload?.server !== ctx.publicOrigin ||
      !payload?.qrPayload?.pairToken || Date.parse(payload?.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(payload?.expiresAt))) throw new Error('Capture payload is outside the isolated workspace or expired');
  const output = env.REVIEWER_OUTPUT_DIR;
  if (!output || !isAbsolute(output)) throw new Error('Native capture requires its private evidence directory');
  const artifactRoot = resolve(output, 'native');
  if (existsSync(artifactRoot) || existsSync(resolve(output, 'native-capture-receipt.json'))) {
    throw new Error('Native capture refuses to overwrite an existing attempt');
  }
  const sha = nativeCapturePreflight(env, run);
  const proof = invokeNative(env, run, false, payload.qrPayload);
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(proof.attempt ?? '') ||
      proof.attempt.split('/').includes('..')) {
    throw new Error('Invalid remote native evidence path');
  }
  run(['scp', '-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '--',
    `${nativeConfig(env).host}:${proof.attempt}`, artifactRoot]);
  const downloaded = verifyNativeArtifact(artifactRoot, sha);
  if (downloaded.attempt !== proof.attempt || downloaded.source.fingerprint !== proof.source.fingerprint) {
    throw new Error('Downloaded native source receipt differs from this attempt');
  }
  writeFileSync(resolve(output, 'native-capture-receipt.json'), JSON.stringify({ executor: 'native-mac',
    host: nativeConfig(env).host, attempt: proof.attempt, candidateSha: sha,
    sourceFingerprint: proof.source.fingerprint, pairedPassed: 1, pairedFailed: 0, pairedSkipped: 0,
    pairPayloadRemoved: true, artifactRoot: relative(output, artifactRoot) }), { mode: 0o600, flag: 'wx' });
}

async function main() {
  const ctx = reviewerContext(process.env);
  const relayPort = Number(process.env.PROTO_RELAY_PORT);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error('Reviewer controls require the reserved relay port');
  }
  const relay = spawn('socat', [`TCP-LISTEN:${relayPort},bind=127.0.0.1,fork,reuseaddr`,
    `TCP:127.0.0.1:${new URL(ctx.local).port}`], { stdio: 'ignore' });
  let spawnFailed = false;
  relay.on('error', () => { spawnFailed = true; });
  const stop = () => relay.kill('SIGTERM');
  process.once('SIGTERM', () => { stop(); process.exit(143); });
  process.once('SIGINT', () => { stop(); process.exit(130); });
  try {
    const deadline = Date.now() + 5000;
    let listening = false;
    while (!listening && Date.now() < deadline && !spawnFailed && relay.exitCode === null) {
      listening = await new Promise(ok => {
        const socket = createConnection({ host: '127.0.0.1', port: relayPort });
        socket.once('connect', () => { socket.destroy(); ok(true); });
        socket.once('error', () => { socket.destroy(); ok(false); });
      });
      if (!listening) await new Promise(ok => setTimeout(ok, 100));
    }
    if (!listening) throw new Error('Reviewer relay did not become ready');
    if (process.env.REVIEWER_SEED_CONTENT === '1') {
      await seedReviewer({ env: process.env, invoke: (name, args) => invokeIsolated(process.env, name, args) });
    }
    const payload = await runPairingControls({ env: process.env });
    if (process.env.REVIEWER_SEED_CONTENT === '1') {
      await verifyReviewerReadback({ env: process.env });
    }
    if (!process.env.REVIEWER_PAIR_PAYLOAD_PATH) throw new Error('Private output path is required');
    writeFileSync(process.env.REVIEWER_PAIR_PAYLOAD_PATH, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
    console.log('REVIEWER: pairing controls passed; private payload saved');
    if (process.env.REVIEWER_CAPTURE_NATIVE === '1') {
      await captureNative({ env: process.env, payload });
      console.log('REVIEWER: native paired capture accepted');
    }
  } finally { stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => process.argv.includes('--native-preflight')
    ? nativeCapturePreflight(process.env) : main())
    .catch(error => { console.error(`REVIEWER_FAILED: ${error.message}`); process.exitCode = 1; });
}
