import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { runHookProcess } from './spawn-hook';

const hooks = join(__dirname, '..');
const owner = 'operation-hook-owner';
const authority = 'prepared-test-authority';
let session: string;
let root: string, home: string, cache: string, ws: string, repo: string, origin: string;
let server: Server;
let requests: Array<{ name: string; args: any; url: string }>;
let mutations: Map<string, { state: string; paths: string[] }>;
let grants: Set<string>, explicit: Set<string>, proofs: Map<string, any>;
let loseAcquire: boolean, unknownFinish: boolean, terminalWithoutRelease: boolean, legacy: boolean;
let lateAcquire: (() => void) | undefined;
let persistedBeforeHttp: boolean;
let schemaQualified: boolean, rejectOperation: boolean, listRequests: string[];
let schemaBySession: Map<string, boolean>;

beforeEach(async () => {
  session = 'native-operation-session';
  root = fs.mkdtempSync(join(os.tmpdir(), 'operation-hook-'));
  home = join(root, 'home'); cache = join(root, 'cache'); ws = join(root, 'workspace');
  repo = join(ws, 'papercusp');
  for (const dir of [join(home, '.papercusp'), cache, join(repo, '.git'), join(repo, 'sub')])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(repo, '.git/HEAD'), 'ref: refs/heads/staging\n');
  fs.writeFileSync(join(home, '.papercusp/superuser-token'), 'fixture-bearer');
  fs.writeFileSync(join(home, '.papercusp/su-agent-id'), 'fixture-agent');
  requests = []; mutations = new Map(); grants = new Set(); explicit = new Set(); proofs = new Map();
  loseAcquire = false; unknownFinish = false; terminalWithoutRelease = false; legacy = false; lateAcquire = undefined;
  persistedBeforeHttp = true;
  schemaQualified = true; rejectOperation = false; listRequests = []; schemaBySession = new Map();
  server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const message = JSON.parse(body);
      if (message.method === 'tools/list') {
        listRequests.push(req.url ?? '');
        const requestedSession = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('native_session');
        const qualified = requestedSession && schemaBySession.has(requestedSession)
          ? schemaBySession.get(requestedSession)!
          : schemaQualified;
        const tools = ['locks:acquire', 'locks:release', 'locks:cancel_wait'].map(tool => ({ name: tool,
          inputSchema: { type: 'object', additionalProperties: false,
            properties: qualified ? { paths: {}, hook_operation: {} } : { paths: {} } } }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } }));
        return;
      }
      const { name, arguments: args } = message.params;
      requests.push({ name, args, url: req.url ?? '' });
      const op = args.hook_operation;
      let result: any = name === 'locks:acquire' && !op
        ? { ok: true, lock_id: 'legacy-lock', held: args.paths, newly_held: args.paths }
        : { ok: true };
      if (op && rejectOperation) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602,
          message: "invalid_args: unrecognized key 'hook_operation' beside coordination_domain" } }));
        return;
      }
      let empty = false;
      if (op) {
        const records = fs.readdirSync(cache).filter(p => p.endsWith('.operation.json'))
          .map(p => JSON.parse(fs.readFileSync(join(cache, p), 'utf8')));
        const saved = records.find(r => r.operation.id === op.id);
        persistedBeforeHttp &&= !!saved && saved.operation.deadline === op.deadline
          && saved.owner === owner && saved.session_id === session
          && (!op.authority || saved.operation.authority === op.authority);
        const paths = args.paths ?? op.paths;
        if (name === 'locks:acquire' && !op.authority) {
          result = legacy ? { ok: true, lock_id: 'legacy-grant' }
            : { ok: false, reason: 'operation_authority_required', operation_authority: authority };
        } else if (name === 'locks:acquire') {
          const acquire = () => {
            const existing = mutations.get(op.id);
            if (existing && ['cancelled', 'completed'].includes(existing.state)) return false;
            const newly = paths.filter((p: string) => !explicit.has(p));
            for (const path of newly) grants.add(path);
            mutations.set(op.id, { state: 'granted', paths: newly });
            return true;
          };
          if (loseAcquire) { lateAcquire = acquire; empty = true; }
          else result = acquire()
            ? { ok: true, lock_id: 'correlated-grant', operation_id: op.id,
                held: paths, newly_held: paths.filter((p: string) => !explicit.has(p)) }
            : { ok: false, reason: 'operation_finished', operation_id: op.id };
        } else if (unknownFinish) {
          result = { ok: false, reason: 'operation_authority_unknown', operation_id: op.id };
        } else if (terminalWithoutRelease) {
          const held = mutations.get(op.id)?.paths ?? [];
          const state = name === 'locks:release' ? 'completed' : 'cancelled';
          mutations.set(op.id, { state, paths: held });
          if (args.native_edit_proof) proofs.set(op.id, args.native_edit_proof);
          result = { ok: true, operation_id: op.id, state, released: [] };
        } else {
          const held = mutations.get(op.id)?.paths ?? [];
          for (const path of held) grants.delete(path);
          const state = name === 'locks:release' ? 'completed' : 'cancelled';
          mutations.set(op.id, { state, paths: held });
          if (args.native_edit_proof) proofs.set(op.id, args.native_edit_proof);
          result = { ok: true, operation_id: op.id, state, released: held };
        }
      } else if (name === 'locks:release' && args.lock_id) {
        const paths = Array.isArray(args.paths) ? args.paths : [];
        const released = paths.filter((path: string) => grants.has(path));
        for (const path of released) grants.delete(path);
        result = { ok: true, released, held_before: released.length };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
        content: empty ? [] : [{ type: 'text', text: JSON.stringify(result) }],
      } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

function payload(id = 'edit-one', paths = ['sub/one.ts']) {
  return { tool_name: 'apply_patch', tool_use_id: id, session_id: session, cwd: repo,
    tool_input: `*** Begin Patch\n${paths.map(p => `*** Update File: ${join(repo, p)}\n@@\n-a\n+b`).join('\n')}\n*** End Patch` };
}

async function hook(file: string, input: object, expectOperation = true, hookDirectory = hooks) {
  const result = await runHookProcess('bash', [join(hookDirectory, file)], {
    input: JSON.stringify(input), env: {
      ...process.env, HOME: home, PAPERCUSP_LOCKS_CACHE_DIR: cache, PAPERCUSP_WORKSPACE_ROOT: ws,
      PAPERCUSP_CANONICAL_TREE: repo, PAPERCUSP_OPERATOR_URL: origin,
      PAPERCUSP_LOCKS_RELEASE_FALLBACK_URL: origin, PAPERCUSP_SID: owner, PAPERCUSP_LOCK_SID: owner,
      PAPERCUSP_NATIVE_SESSION_ID: session, CODEX_HOME: undefined,
      PAPERCUSP_LIFECYCLE_REPLAY_TRACE: join(root, 'lifecycle-replays'),
      PAPERCUSP_LIFECYCLE_RELEASE_HOOK: join(hooks, 'posttooluse-locks-release.sh'),
    },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('Traceback');
  if (expectOperation && file === 'pretooluse-locks-acquire.sh' && !result.stdout.trim()) {
    // Detect a skipped guard path at the harness boundary, before a case can
    // mistake no acquire for successful recovery.
    expect(fs.readdirSync(cache).some(p => p.endsWith('.operation.json'))).toBe(true);
  }
  return result;
}

function record(id = 'edit-one') { return JSON.parse(fs.readFileSync(join(cache, id + '.operation.json'), 'utf8')); }

function tracedLifecycle() {
  const directory = join(root, 'lifecycle-hooks');
  // Keep sibling imports intact: fail-open import failures must not look like
  // a lifecycle fast path. The pending-operation controls exercise this copy.
  fs.cpSync(hooks, directory, { recursive: true });
  fs.writeFileSync(join(directory, 'posttooluse-locks-release.sh'), [
    '#!/usr/bin/env bash',
    'printf "replay\\n" >> "$PAPERCUSP_LIFECYCLE_REPLAY_TRACE"',
    'exec bash "$PAPERCUSP_LIFECYCLE_RELEASE_HOOK" "$@"',
    '',
  ].join('\n'));
  return { directory, trace: join(root, 'lifecycle-replays') };
}

// D-005: a record shaped like the pre-fix replays (EI-25871003145591038) —
// never pinned, admission deadline long past, scope unrelated to the new call.
function inertRecord(id = 'edit-one') {
  const operation = { id: '00000000-0000-4000-8000-000000000001',
    deadline: new Date(Date.now() - 3_600_000).toISOString().replace('Z', '+00:00') };
  fs.writeFileSync(join(cache, id + '.operation.json'), JSON.stringify({ version: 1, owner, session_id: session,
    tool_id: id, paths: ['sub/stale.ts'], intent: 'PreToolUse:Edit', ttl_sec: 1200, operation }));
  return operation.id;
}
function success(id = 'edit-one', paths = ['sub/one.ts']) {
  return { ...payload(id, paths), tool_response: { success: true, output: 'Success. Updated the following files.' } };
}

function nestedGitfileSubmodule() {
  const gitdir = join(repo, '.git', 'modules', 'sub');
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/staging\n');
  fs.writeFileSync(join(repo, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
}

function parent(response: unknown, paths = ['sub/one.ts']) {
  const input = payload('parent', paths);
  return { ...input, tool_name: 'functions.exec',
    tool_input: `await tools.apply_patch(${JSON.stringify(input.tool_input)});`, tool_response: response };
}

async function acquireBatch() {
  const transcript = join(root, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'batch-one', name: 'Edit', input: { file_path: join(repo, 'sub/one.ts') } },
    { type: 'tool_use', id: 'batch-two', name: 'Write', input: { file_path: join(repo, 'sub/two.ts') } },
  ] } }) + '\n');
  for (const [id, tool, path] of [['batch-one', 'Edit', 'sub/one.ts'], ['batch-two', 'Write', 'sub/two.ts']]) {
    await hook('pretooluse-locks-acquire.sh', { tool_name: tool, tool_use_id: id,
      tool_input: { file_path: join(repo, path) }, session_id: session, cwd: repo, transcript_path: transcript });
  }
  return fs.readdirSync(cache).find(p => p.startsWith('batch-') && p.endsWith('.operation.json'))!;
}

function batchResults(failed = false) {
  return { session_id: session, tool_results: [
    { tool_use_id: 'batch-one', tool_name: 'Edit', tool_response: { success: !failed } },
    { tool_use_id: 'batch-two', tool_name: 'Write', tool_response: { success: true } },
  ] };
}

describe('native hook operation fence', () => {
  const protocolCache = () => fs.readdirSync(cache).filter(p => p.startsWith('operation-protocol-'));
  const acquires = () => requests.filter(r => r.name === 'locks:acquire');

  it('qualifies the native operation protocol through the authenticated session route', async () => {
    schemaQualified = false;
    schemaBySession.set(session, true);
    await hook('pretooluse-locks-acquire.sh', payload('edit-session-qualified'));

    expect(listRequests).toHaveLength(1);
    expect(new URL(listRequests[0], origin).searchParams.get('native_session')).toBe(session);
    expect(acquires().some(r => r.args.hook_operation)).toBe(true);
    expect(fs.existsSync(join(cache, 'edit-session-qualified.operation.json'))).toBe(true);
  });

  it('does not reuse a protocol verdict across authenticated native sessions', async () => {
    schemaBySession.set(session, true);
    await hook('pretooluse-locks-acquire.sh', payload('edit-first-session'));

    session = 'native-operation-session-second';
    schemaBySession.set(session, false);
    rejectOperation = true;
    const result = await hook('pretooluse-locks-acquire.sh', payload('edit-second-session'), false);

    expect(result.stdout.trim()).toBe('');
    expect(listRequests).toHaveLength(2);
    expect(new URL(listRequests[0], origin).searchParams.get('native_session')).toBe('native-operation-session');
    expect(new URL(listRequests[1], origin).searchParams.get('native_session')).toBe(session);
    expect(acquires().at(-1)!.args.hook_operation).toBeUndefined();
    expect(fs.existsSync(join(cache, 'edit-second-session.operation.json'))).toBe(false);
    expect(fs.existsSync(join(cache, 'edit-second-session.lock'))).toBe(true);
  });

  it('an unqualified origin gets the legacy acquire, no operation record, and a cached verdict', async () => {
    schemaQualified = false;
    const first = await hook('pretooluse-locks-acquire.sh', payload('edit-legacy'), false);
    expect(first.stdout.trim()).toBe('');
    expect(fs.existsSync(join(cache, 'edit-legacy.operation.json'))).toBe(false);
    expect(acquires()).toHaveLength(1);
    expect(acquires()[0].args.hook_operation).toBeUndefined();
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]).toContain('tools=locks');
    const [verdictFile] = protocolCache();
    const verdict = JSON.parse(fs.readFileSync(join(cache, verdictFile), 'utf8'));
    expect(verdict.qualified).toBe(false);
    await hook('pretooluse-locks-acquire.sh', payload('edit-legacy-2', ['sub/two.ts']), false);
    expect(listRequests).toHaveLength(1);
    fs.writeFileSync(join(cache, verdictFile), JSON.stringify({ ...verdict, checked_at: verdict.checked_at - 61 }));
    schemaQualified = true;
    await hook('pretooluse-locks-acquire.sh', payload('edit-three', ['sub/three.ts']));
    expect(listRequests).toHaveLength(2);
    expect(acquires().at(-1)!.args.hook_operation.id).toBe(record('edit-three').operation.id);
  });

  it('an existing operation record is never stripped when the origin later reads unqualified', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const id = record().operation.id;
    schemaQualified = false;
    for (const name of protocolCache()) fs.rmSync(join(cache, name));
    await hook('pretooluse-locks-acquire.sh', payload());
    expect(listRequests).toHaveLength(1);
    expect(acquires().length).toBeGreaterThanOrEqual(2);
    expect(acquires().every(r => r.args.hook_operation?.id === id)).toBe(true);
  });

  it('an inert record (never pinned, past its deadline) is retired, never replayed or denied', async () => {
    const staleId = inertRecord();
    schemaQualified = false;
    const result = await hook('pretooluse-locks-acquire.sh', payload(), false);
    expect(result.stdout.trim()).toBe('');
    expect(acquires()).toHaveLength(1);
    expect(acquires()[0].args.hook_operation).toBeUndefined();
    expect(fs.existsSync(join(cache, 'edit-one.operation.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(join(cache, 'edit-one.operation.json.expired'), 'utf8')).operation.id).toBe(staleId);
  });

  it('a qualified origin gives a recurring tool id a fresh operation instead of the inert one', async () => {
    const staleId = inertRecord();
    await hook('pretooluse-locks-acquire.sh', payload());
    expect(record().operation.id).not.toBe(staleId);
    expect(acquires().every(r => r.args.hook_operation?.id === record().operation.id)).toBe(true);
  });

  it('a pinned record past its deadline is never retired or stripped', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const pinned = record();
    expect(pinned.operation.authority).toBeTruthy();
    pinned.operation.deadline = new Date(Date.now() - 3_600_000).toISOString().replace('Z', '+00:00');
    fs.writeFileSync(join(cache, 'edit-one.operation.json'), JSON.stringify(pinned));
    schemaQualified = false;
    for (const name of protocolCache()) fs.rmSync(join(cache, name));
    await hook('pretooluse-locks-acquire.sh', payload());
    expect(fs.existsSync(join(cache, 'edit-one.operation.json.expired'))).toBe(false);
    expect(acquires().every(r => r.args.hook_operation?.id === pinned.operation.id)).toBe(true);
  });

  it('a recurring tool id with a different scope is denied, never replayed onto the earlier paths', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const first = record();
    expect(first.operation.authority).toBeTruthy();
    const sent = acquires().length;
    const result = await hook('pretooluse-locks-acquire.sh', payload('edit-one', ['sub/two.ts']));
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toContain('native edit operation');
    expect(acquires()).toHaveLength(sent);
    expect(record()).toEqual(first);
  });

  it('settling an inert record at Stop sends no doomed preparation acquire and retires it', async () => {
    inertRecord();
    await hook('lifecycle-report.sh', { hook_event_name: 'Stop', session_id: session });
    expect(requests.filter(r => r.name.startsWith('locks:'))).toEqual([]);
    expect(fs.existsSync(join(cache, 'edit-one.operation.json'))).toBe(false);
    expect(fs.existsSync(join(cache, 'edit-one.operation.json.expired'))).toBe(true);
  });

  it('an origin that rejects the operation scope denies the edit and forgets its qualification', async () => {
    rejectOperation = true;
    const result = await hook('pretooluse-locks-acquire.sh', payload());
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toContain('rejected the native operation scope before authority was prepared');
    expect(protocolCache()).toEqual([]);
    expect(acquires().length).toBeGreaterThan(0);
    expect(acquires().every(r => r.args.hook_operation)).toBe(true);
  });

  it('persists exact native identity and authority before acquire, then finishes with native proof', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    expect(saved).toMatchObject({ owner, session_id: session, tool_id: 'edit-one', paths: ['sub/one.ts'], coordination_domain: repo });
    expect(saved.operation.authority).toBe(authority);
    expect(persistedBeforeHttp).toBe(true);
    expect(requests.filter(r => r.name === 'locks:acquire')).toHaveLength(2);
    await hook('posttooluse-locks-release.sh', success());
    expect(grants.size).toBe(0);
    expect(proofs.get(saved.operation.id)).toEqual({ success: true, source: 'codex', tool: 'apply_patch', paths: ['sub/one.ts'], sessionId: 'native-operation-session' });
    expect(requests.at(-1)?.url).toContain(`native_session=${session}`);
    expect(record().terminal).toBe('completed');
  });

  it('settles an empty Codex apply_patch result for a multi-file nested submodule edit', async () => {
    nestedGitfileSubmodule();
    const paths = ['sub/test-coverage-map.ts', 'sub/test-coverage-provider.ts'];
    const input = payload('edit-submodule', paths);
    const submoduleDomain = join(repo, 'sub');
    const relativePaths = ['test-coverage-map.ts', 'test-coverage-provider.ts'];

    await hook('pretooluse-locks-acquire.sh', input);

    const saved = record('edit-submodule');
    expect(saved).toMatchObject({ coordination_domain: submoduleDomain, paths: relativePaths });
    expect(acquires().at(-1)?.args).toMatchObject({
      coordination_domain: submoduleDomain,
      paths: relativePaths,
    });

    await hook('posttooluse-locks-release.sh', { ...input, tool_response: {} });

    expect(requests.filter(r => r.name === 'locks:release')).toHaveLength(1);
    expect(requests.at(-1)?.args).toMatchObject({
      coordination_domain: submoduleDomain,
      hook_operation: {
        id: saved.operation.id,
        paths: relativePaths,
      },
    });
    expect(mutations.get(saved.operation.id)?.state).toBe('completed');
    expect(grants.size).toBe(0);
    expect(proofs.get(saved.operation.id)).toEqual({
      success: true,
      source: 'codex',
      tool: 'apply_patch',
      paths: relativePaths,
      sessionId: 'native-operation-session',
    });
    expect(record('edit-submodule').terminal).toBe('completed');
  });

  it('uses the cached exact lock scope when a terminal operation reply omits released paths', async () => {
    const paths = ['sub/one.ts'];
    const response = { status: 'completed', tool_results: [{
      tool_name: 'apply_patch', result: { ok: true, content: [{ type: 'text', text: 'Updated sub/one.ts' }] },
    }] };
    const input = parent(response, paths);
    await hook('pretooluse-locks-acquire.sh', input);
    expect(grants.has('sub/one.ts')).toBe(true);
    expect(JSON.parse(fs.readFileSync(join(cache, 'parent.paths'), 'utf8'))).toEqual(paths);

    terminalWithoutRelease = true;
    await hook('posttooluse-locks-release.sh', input);

    const operationFinish = requests.find(r => r.name === 'locks:release' && r.args.hook_operation);
    expect(operationFinish?.args.native_edit_proof).toMatchObject({
      success: true, source: 'codex', tool: 'apply_patch', paths,
    });
    const exactFallback = requests.find(r => r.name === 'locks:release' && !r.args.hook_operation);
    expect(exactFallback?.args).toMatchObject({
      lock_id: 'correlated-grant', paths, coordination_domain: repo,
    });
    expect(grants.size).toBe(0);
    expect(record('parent').terminal).toBe('completed');
    expect(fs.existsSync(join(cache, 'parent.paths'))).toBe(false);
  });

  it('keeps a nested functions.exec operation locked across a yielded PostToolUse result', async () => {
    const response = { status: 'completed', tool_results: [{
      tool_name: 'apply_patch', result: { ok: true, content: [{ type: 'text', text: 'Updated sub/one.ts' }] },
    }] };
    const input = parent(response);
    await hook('pretooluse-locks-acquire.sh', input);
    const saved = record('parent');
    expect(grants.has('sub/one.ts')).toBe(true);

    await hook('posttooluse-locks-release.sh', parent({ session_id: 73, output: '' }));

    expect(record('parent').operation).toEqual(saved.operation);
    expect(record('parent')).not.toHaveProperty('terminal');
    expect(grants.has('sub/one.ts')).toBe(true);
    expect(requests.some(r => r.name === 'locks:release' || r.name === 'locks:cancel_wait')).toBe(false);

    await hook('posttooluse-locks-release.sh', input);
    expect(record('parent').terminal).toBe('completed');
    expect(grants.size).toBe(0);
  });

  it('a lost acquire reply completes without a lock token and fences the delayed grant', async () => {
    loseAcquire = true;
    await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    expect(fs.existsSync(join(cache, 'edit-one.lock'))).toBe(false);
    await hook('posttooluse-locks-release.sh', success());
    lateAcquire?.();
    expect(mutations.get(saved.operation.id)?.state).toBe('completed');
    expect(grants.size).toBe(0);
    expect(proofs.size).toBe(1);
    expect(requests.some(r => r.name === 'locks:queue')).toBe(false);
  });

  it('failed native completion cancels before a delayed acquire, without edit attribution', async () => {
    loseAcquire = true;
    await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    await hook('posttooluse-locks-release.sh', { ...payload(), tool_response: { success: false } });
    lateAcquire?.();
    expect(mutations.get(saved.operation.id)?.state).toBe('cancelled');
    expect(grants.size).toBe(0); expect(proofs.size).toBe(0);
    expect(requests.at(-1)?.name).toBe('locks:cancel_wait');
  });

  it('duplicate acquire reuses UUID, fixed deadline and pin; duplicate completion sends no second proof', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const first = record();
    await hook('pretooluse-locks-acquire.sh', payload());
    expect(record().operation).toEqual(first.operation);
    await hook('posttooluse-locks-release.sh', success());
    await hook('posttooluse-locks-release.sh', success());
    expect(requests.filter(r => r.name === 'locks:release')).toHaveLength(1);
  });

  it('completed native tool identity cannot create another operation or reacquire after finish', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    await hook('posttooluse-locks-release.sh', success());
    const before = requests.length;
    const result = await hook('pretooluse-locks-acquire.sh', payload());
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(requests).toHaveLength(before);
    expect(record().operation).toEqual(saved.operation);
    expect(grants.size).toBe(0);
  });

  it('unknown finish retains all recovery state and never strips operation metadata', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record(); unknownFinish = true;
    await hook('posttooluse-locks-release.sh', success());
    expect(record().operation).toEqual(saved.operation);
    expect(grants.has('sub/one.ts')).toBe(true);
    expect(requests.filter(r => r.name === 'locks:release').every(r => r.args.hook_operation.authority === authority)).toBe(true);
    unknownFinish = false;
    await hook('posttooluse-locks-release.sh', success());
    expect(grants.size).toBe(0);
  });

  it('explicit and foreign holds survive finish while proof covers the whole requested scope', async () => {
    explicit.add('sub/one.ts'); grants.add('sub/foreign.ts');
    await hook('pretooluse-locks-acquire.sh', payload('edit-one', ['sub/one.ts', 'sub/new.ts']));
    const saved = record();
    await hook('posttooluse-locks-release.sh', success('edit-one', ['sub/one.ts', 'sub/new.ts']));
    expect(explicit.has('sub/one.ts')).toBe(true); expect(grants.has('sub/foreign.ts')).toBe(true);
    expect(grants.has('sub/new.ts')).toBe(false);
    expect(proofs.get(saved.operation.id).paths).toEqual(['sub/one.ts', 'sub/new.ts']);
    expect(requests.at(-1)?.args).not.toHaveProperty('lock_id');
  });

  it.each([{ session_id: 73, output: '', }, 'Script running with cell ID 77'])('a yielded parent keeps the nested operation live: %j', async response => {
    loseAcquire = true; await hook('pretooluse-locks-acquire.sh', payload());
    await hook('posttooluse-locks-release.sh', parent(response));
    expect(fs.existsSync(join(cache, 'edit-one.operation.json'))).toBe(true);
    expect(requests.filter(r => r.name === 'locks:cancel_wait')).toHaveLength(0);
  });

  it('a terminal parent cancels its lost-reply operation by exact patch scope', async () => {
    loseAcquire = true; await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    await hook('posttooluse-locks-release.sh', parent({ exit_code: 1, output: 'patch failed' }));
    lateAcquire?.();
    expect(mutations.get(saved.operation.id)?.state).toBe('cancelled');
    expect(proofs.size).toBe(0); expect(grants.size).toBe(0);
  });

  it.each(['exec', 'functions.exec', 'functions__exec'])('failed Codex %s text-block result cancels only its granted patch scope', async toolName => {
    await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    await hook('pretooluse-locks-acquire.sh', payload('unrelated', ['sub/unrelated.ts']));
    const unrelated = record('unrelated');
    explicit.add('sub/explicit.ts');
    // Native code-mode failures return text blocks, without an exit_code field.
    // This is the shape retained for the failed 2026-10-14 baseline patch.
    const response = [
      { type: 'input_text', text: 'Script failed\nWall time 2.9 seconds\nOutput:\n' },
      { type: 'input_text', text: 'Script error:\napply_patch verification failed: Failed to find expected lines' },
    ];
    await hook('posttooluse-locks-release.sh', { ...parent(response), tool_name: toolName });
    expect(mutations.get(saved.operation.id)?.state).toBe('cancelled');
    expect(grants.has('sub/one.ts')).toBe(false);
    expect(proofs.size).toBe(0);
    expect(grants.has('sub/unrelated.ts')).toBe(true);
    expect(record('unrelated').operation).toEqual(unrelated.operation);
    expect(record('unrelated')).not.toHaveProperty('terminal');
    expect(explicit.has('sub/explicit.ts')).toBe(true);
  });

  it('foreign native continuation cannot finish a cached operation', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    await hook('posttooluse-locks-release.sh', { ...success(), session_id: 'foreign-native-session' });
    expect(grants.has('sub/one.ts')).toBe(true); expect(proofs.size).toBe(0);
    expect(fs.existsSync(join(cache, 'edit-one.operation.json'))).toBe(true);
  });

  it('a legacy answer never admits an uncorrelated acquire retry', async () => {
    legacy = true;
    const result = await hook('pretooluse-locks-acquire.sh', payload());
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(requests.filter(r => r.name === 'locks:acquire').every(r => !!r.args.hook_operation)).toBe(true);
    expect(fs.existsSync(join(cache, 'edit-one.operation.json'))).toBe(true);
  });

  it('Stop cancellation works without grant sidecars and fences a later acquire', async () => {
    loseAcquire = true; await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    await hook('posttooluse-locks-release.sh', { hook_event_name: 'Stop', tool_use_id: 'edit-one', session_id: session });
    lateAcquire?.();
    expect(mutations.get(saved.operation.id)?.state).toBe('cancelled');
    expect(grants.size).toBe(0);
  });

  it('lifecycle Stop finds a lost-reply operation by native session without a lock token', async () => {
    loseAcquire = true; await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    await hook('lifecycle-report.sh', { hook_event_name: 'Stop', session_id: session });
    lateAcquire?.();
    expect(mutations.get(saved.operation.id)?.state).toBe('cancelled');
    expect(grants.size).toBe(0); expect(proofs.size).toBe(0);
  });

  it.each([
    ['Stop', 'completed'], ['Stop', 'cancelled'],
    ['SessionEnd', 'completed'], ['SessionEnd', 'cancelled'],
  ] as const)('lifecycle %s skips terminal replay child for %s tombstone', async (event, terminal) => {
    await hook('pretooluse-locks-acquire.sh', payload());
    await hook('posttooluse-locks-release.sh', terminal === 'completed'
      ? success() : { ...payload(), tool_response: { success: false } });
    expect(record().terminal).toBe(terminal);
    const tombstone = fs.readFileSync(join(cache, 'edit-one.operation.json'), 'utf8');
    const sent = requests.filter(r => r.name.startsWith('locks:')).length;
    const replay = tracedLifecycle();

    await hook('lifecycle-report.sh', { hook_event_name: event, session_id: session }, true, replay.directory);

    expect(fs.existsSync(replay.trace)).toBe(false);
    expect(fs.readFileSync(join(cache, 'edit-one.operation.json'), 'utf8')).toBe(tombstone);
    expect(requests.filter(r => r.name.startsWith('locks:'))).toHaveLength(sent);
  });

  it.each(['Stop', 'SessionEnd'])('lifecycle %s invokes the pending replay child and fences a lost reply', async (event) => {
    loseAcquire = true;
    await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    expect(saved.terminal).toBeUndefined();
    const replay = tracedLifecycle();

    await hook('lifecycle-report.sh', { hook_event_name: event, session_id: session }, true, replay.directory);
    lateAcquire?.();

    expect(fs.readFileSync(replay.trace, 'utf8')).toBe('replay\n');
    expect(record()).toMatchObject({ terminal: 'cancelled', operation: saved.operation });
    expect(mutations.get(saved.operation.id)?.state).toBe('cancelled');
    expect(grants.size).toBe(0);
    expect(proofs.size).toBe(0);
  });

  it('lifecycle terminal fast path preserves later positive native proof enrichment', async () => {
    await hook('pretooluse-locks-acquire.sh', payload());
    await hook('posttooluse-locks-release.sh', { ...payload(), tool_response: { success: false } });
    const saved = record();
    const replay = tracedLifecycle();
    await hook('lifecycle-report.sh', { hook_event_name: 'Stop', session_id: session }, true, replay.directory);
    expect(fs.existsSync(replay.trace)).toBe(false);

    await hook('posttooluse-locks-release.sh', success());

    expect(record()).toMatchObject({ terminal: 'completed', operation: saved.operation });
    expect(proofs.get(saved.operation.id)?.paths).toEqual(['sub/one.ts']);
    expect(requests.filter(r => r.name === 'locks:release')).toHaveLength(1);
  });

  it('successful retry finishes the earlier exact-scope operation but keeps an unrelated operation', async () => {
    loseAcquire = true; await hook('pretooluse-locks-acquire.sh', payload());
    const saved = record();
    await hook('pretooluse-locks-acquire.sh', payload('unrelated', ['sub/unrelated.ts']));
    const unrelated = record('unrelated');
    loseAcquire = false; await hook('pretooluse-locks-acquire.sh', payload('retry'));
    await hook('posttooluse-locks-release.sh', success('retry'));
    expect(record().terminal).toBe('completed');
    expect(mutations.get(saved.operation.id)?.state).toBe('completed');
    expect(record('unrelated').operation).toEqual(unrelated.operation);
    expect(record('unrelated')).not.toHaveProperty('terminal');
    expect(proofs.get(saved.operation.id)?.paths).toEqual(['sub/one.ts']);
  });

  it('batch union finishes once after every sibling completes; partial and per-tool hooks retain it', async () => {
    const filename = await acquireBatch();
    expect(requests.filter(r => r.name === 'locks:acquire')).toHaveLength(2);
    await hook('posttooluse-locks-release.sh', { ...success('batch-one'), tool_name: 'Edit' });
    const result = batchResults();
    await hook('posttoolbatch-locks-release.sh', { ...result, tool_results: [result.tool_results[0]] });
    expect(grants.size).toBe(2); expect(fs.existsSync(join(cache, filename))).toBe(true);
    await hook('posttoolbatch-locks-release.sh', result);
    expect(grants.size).toBe(0);
    expect([...proofs.values()]).toEqual([{ success: true, source: 'claude', tools: ['Edit', 'Write'], paths: ['sub/one.ts', 'sub/two.ts'], sessionId: 'native-operation-session' }]);
    await hook('posttoolbatch-locks-release.sh', result);
    expect(requests.filter(r => r.name === 'locks:release')).toHaveLength(1);
  });

  it('batch unknown finish retains election and markers for a later confirmed retry', async () => {
    const filename = await acquireBatch(); unknownFinish = true;
    await hook('posttoolbatch-locks-release.sh', batchResults());
    expect(fs.existsSync(join(cache, filename))).toBe(true);
    expect(fs.existsSync(join(cache, 'batch-one.batch'))).toBe(true);
    unknownFinish = false;
    await hook('posttoolbatch-locks-release.sh', batchResults());
    expect(grants.size).toBe(0); expect(proofs.size).toBe(1);
  });

  it('batch lost reply is fenced by completion, while a fully failed batch cancels without proof', async () => {
    loseAcquire = true;
    const filename = await acquireBatch();
    const saved = JSON.parse(fs.readFileSync(join(cache, filename), 'utf8'));
    await hook('posttoolbatch-locks-release.sh', batchResults(true));
    lateAcquire?.();
    expect(mutations.get(saved.operation.id)?.state).toBe('cancelled');
    expect(grants.size).toBe(0); expect(proofs.size).toBe(0);
  });
});
