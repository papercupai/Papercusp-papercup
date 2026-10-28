/**
 * Regression coverage for the Claude native edit-batch lock lifecycle.
 *
 * PreToolUse writes one batch state plus one marker per native edit. PostToolUse
 * must leave those artifacts alone while the batch is in flight; PostToolBatch
 * is the only hook allowed to release the union, and only after it sees every
 * expected edit in a terminal granted state.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { runHookProcess } from './spawn-hook';

const BATCH_HOOK = join(__dirname, '..', 'posttoolbatch-locks-release.sh');
const POST_HOOK = join(__dirname, '..', 'posttooluse-locks-release.sh');

let home: string;
let cache: string;
let repo: string;
let regenMarker: string;
let server: Server;
let operatorUrl: string;
let releaseRequests: Array<Record<string, any>> = [];
let releaseObservedAfterRegen: boolean[] = [];
let primaryNoText = false;
// WI-10006900: a retain (attestation) request answers with this body; null
// echoes the proof paths as attributed, like an operator that knows `retain`.
let attestResponse: Record<string, unknown> | null = null;

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'posttoolbatch-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'test-agent\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'posttoolbatch-cache-'));
  repo = fs.mkdtempSync(join(os.tmpdir(), 'posttoolbatch-repo-'));
  regenMarker = join(repo, 'regen-marker.json');
  fs.mkdirSync(join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(join(repo, 'scripts', 'input.mjs'), 'export const input = true;\n');
  fs.writeFileSync(join(repo, 'scripts', 'other.mjs'), 'export const other = true;\n');
  fs.writeFileSync(join(repo, 'scripts', 'gen-declarations.ts'), '// helper presence marker\n');
  fs.writeFileSync(
    join(repo, 'tsconfig.declarations.json'),
    JSON.stringify({ files: ['scripts/input.mjs', 'scripts/other.mjs'] }),
  );
  fs.writeFileSync(
    join(repo, 'scripts', 'fake-gen.mjs'),
    "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync(process.env.PAPERCUSP_REGEN_TEST_MARKER, JSON.stringify(process.argv.slice(2)));\n" +
      "if (process.env.PAPERCUSP_REGEN_TEST_FAIL === '1') process.exit(17);\n",
  );
  fs.writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { 'gen:declarations': 'node scripts/fake-gen.mjs' } }),
  );

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, any>;
      releaseRequests.push(parsed);
      if (parsed.params?.name === 'locks:release') {
        releaseObservedAfterRegen.push(fs.existsSync(regenMarker));
      }
      const args = parsed.params?.arguments ?? {};
      const result = args.retain
        ? (attestResponse ?? {
            ok: true,
            retained: args.native_edit_proof?.paths ?? [],
            released: [],
            attributed: args.native_edit_proof?.paths ?? [],
          })
        : { ok: true };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: primaryNoText ? [] : [{ type: 'text', text: JSON.stringify(result) }],
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  operatorUrl = `http://127.0.0.1:${(address as { port: number }).port}`;
});

afterEach(() => {
  releaseRequests = [];
  releaseObservedAfterRegen = [];
  primaryNoText = false;
  attestResponse = null;
  fs.rmSync(regenMarker, { force: true });
  for (const name of fs.readdirSync(cache)) fs.rmSync(join(cache, name), { force: true });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

function runHook(
  script: string,
  input: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
) {
  return runHookProcess('bash', [script], {
    input: JSON.stringify(input),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_OPERATOR_URL: operatorUrl,
      PAPERCUSP_REGEN_TEST_MARKER: regenMarker,
      http_proxy: undefined,
      https_proxy: undefined,
      ...extraEnv,
    },
  });
}

function writeBatch(
  batchId: string,
  status: string,
  toolUseIds: string[],
  options: {
    markerStatuses?: Record<string, string>;
    owner?: string;
    paths?: string[];
    releasePaths?: string[];
    attestPaths?: string[];
    coordinationDomain?: string;
  } = {},
) {
  const owner = options.owner ?? 'batch-owner';
  fs.writeFileSync(
    join(cache, `batch-${batchId}.state.json`),
    JSON.stringify({
      version: 1,
      batch_id: batchId,
      status,
      transcript_path: '/tmp/claude-transcript.jsonl',
      tool_use_ids: toolUseIds,
      paths: options.paths ?? ['src/first.ts', 'src/second.ts'],
      owner,
      lock_id: 'batch-lock',
      release_paths: options.releasePaths ?? options.paths ?? ['src/first.ts', 'src/second.ts'],
      ...(options.attestPaths ? { attest_paths: options.attestPaths } : {}),
      coordination_domain: options.coordinationDomain ?? '/repo',
    }),
  );
  for (const toolUseId of toolUseIds) {
    fs.writeFileSync(
      join(cache, `${toolUseId}.batch`),
      JSON.stringify({
        batch_id: batchId,
        tool_use_id: toolUseId,
        status: options.markerStatuses?.[toolUseId] ?? status,
        owner,
      }),
    );
  }
  fs.writeFileSync(join(cache, `batch-${batchId}.leader`), '{}');
}

function batchInput(toolUseIds: string[], owner = 'batch-owner') {
  return {
    hook_event_name: 'PostToolBatch',
    session_id: owner,
    tool_calls: toolUseIds.map((tool_use_id) => ({
      tool_use_id,
      tool_name: 'Edit',
      tool_response: { ok: true },
    })),
  };
}

function expectClean(batchId: string, toolUseIds: string[]) {
  expect(fs.existsSync(join(cache, `batch-${batchId}.state.json`))).toBe(false);
  expect(fs.existsSync(join(cache, `batch-${batchId}.state.json.processing`))).toBe(false);
  expect(fs.existsSync(join(cache, `batch-${batchId}.leader`))).toBe(false);
  for (const toolUseId of toolUseIds)
    expect(fs.existsSync(join(cache, `${toolUseId}.batch`))).toBe(false);
}

describe('posttoolbatch-locks-release.sh', () => {
  it('releases exactly once for a complete granted batch and cleans its artifacts', async () => {
    writeBatch('complete', 'granted', ['tu-first', 'tu-second']);

    const out = await runHook(BATCH_HOOK, batchInput(['tu-first', 'tu-second', 'tu-read']));

    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(releaseRequests).toHaveLength(1);
    expect(releaseRequests[0]?.params).toMatchObject({
      name: 'locks:release',
      arguments: {
        lock_id: 'batch-lock',
        paths: ['src/first.ts', 'src/second.ts'],
        coordination_domain: '/repo',
        native_edit_proof: {
          success: true,
          source: 'claude',
          tools: ['Edit', 'Edit'],
          paths: ['src/first.ts', 'src/second.ts'],
        },
      },
    });
    expectClean('complete', ['tu-first', 'tu-second']);
  });

  it('uses the stable authority and confirms the release when the primary response has no text', async () => {
    const batchId = 'batch-empty-primary';
    const toolUseId = 'tu-batch-empty-primary';
    const fallbackRequests: Array<Record<string, any>> = [];
    const fallbackServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        fallbackRequests.push(JSON.parse(body) as Record<string, any>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                released: ['src/first.ts', 'src/second.ts'],
              }),
            }],
          },
        }));
      });
    });
    await new Promise<void>((resolve) => fallbackServer.listen(0, '127.0.0.1', resolve));
    const address = fallbackServer.address();
    if (!address || typeof address === 'string') throw new Error('fallback server did not bind');

    writeBatch(batchId, 'granted', [toolUseId]);
    primaryNoText = true;

    try {
      const out = await runHook(BATCH_HOOK, {
        ...batchInput([toolUseId]),
        tool_calls: [{
          tool_use_id: toolUseId,
          tool_name: 'Edit',
          tool_response: { success: true },
        }],
      }, {
        PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL: 'http://127.0.0.1:' + address.port,
      });

      expect(out.status).toBe(0);
      expect(releaseRequests).toHaveLength(1);
      expect(fallbackRequests).toHaveLength(1);
      expect(fallbackRequests[0]?.params?.arguments).toMatchObject({
        lock_id: 'batch-lock',
        paths: ['src/first.ts', 'src/second.ts'],
        coordination_domain: '/repo',
        native_edit_proof: {
          success: true,
          source: 'claude',
          tools: ['Edit'],
          paths: ['src/first.ts', 'src/second.ts'],
        },
      });
      expectClean(batchId, [toolUseId]);
      expect(fs.existsSync(join(cache, 'owner-batch-owner-last-success.json'))).toBe(true);
      expect(fs.existsSync(join(cache, 'last-error.json'))).toBe(false);
    } finally {
      primaryNoText = false;
      await new Promise<void>((resolve) => fallbackServer.close(() => resolve()));
    }
  });

  it('regenerates only an enrolled edited source before releasing the batch union', async () => {
    writeBatch('declaration', 'granted', ['tu-declaration'], {
      paths: ['scripts/input.mjs', 'src/not-enrolled.mjs'],
      releasePaths: ['scripts/input.mjs', 'src/not-enrolled.mjs'],
      coordinationDomain: repo,
    });

    const out = await runHook(BATCH_HOOK, batchInput(['tu-declaration']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(1);
    expect(releaseObservedAfterRegen).toEqual([true]);
    expect(JSON.parse(fs.readFileSync(regenMarker, 'utf8'))).toEqual([
      '--files=scripts/input.mjs',
    ]);
  });

  it('records a generator failure but still releases the batch union', async () => {
    writeBatch('declaration-fail', 'granted', ['tu-declaration-fail'], {
      paths: ['scripts/input.mjs'],
      coordinationDomain: repo,
    });

    const out = await runHook(
      BATCH_HOOK,
      batchInput(['tu-declaration-fail']),
      { PAPERCUSP_REGEN_TEST_FAIL: '1' },
    );

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(join(cache, 'last-error.json'), 'utf8'))).toMatchObject({
      handler: 'posttoolbatch',
      phase: 'declaration-regeneration',
    });
  });

  it.each(['allowed', 'denied'])('does not release a terminal %s batch but cleans it', async (status) => {
    writeBatch(status, status, ['tu-one', 'tu-two']);

    const out = await runHook(BATCH_HOOK, batchInput(['tu-one', 'tu-two']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean(status, ['tu-one', 'tu-two']);
  });

  it('does not release a partial payload, even when the stored state is granted, and cleans it', async () => {
    writeBatch('partial', 'granted', ['tu-one', 'tu-two']);

    const out = await runHook(BATCH_HOOK, batchInput(['tu-one']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean('partial', ['tu-one', 'tu-two']);
  });

  it('does not release when one marker is not granted, and still cleans the batch', async () => {
    writeBatch('marker-denied', 'granted', ['tu-one', 'tu-two'], {
      markerStatuses: { 'tu-two': 'denied' },
    });

    const out = await runHook(BATCH_HOOK, batchInput(['tu-one', 'tu-two']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean('marker-denied', ['tu-one', 'tu-two']);
  });

  it('does not release a complete granted batch when one native result fails', async () => {
    writeBatch('result-failed', 'granted', ['tu-one', 'tu-two']);

    const out = await runHook(BATCH_HOOK, {
      ...batchInput(['tu-one', 'tu-two']),
      tool_calls: [
        { tool_use_id: 'tu-one', tool_name: 'Edit', tool_response: { ok: true } },
        { tool_use_id: 'tu-two', tool_name: 'Edit', tool_response: { is_error: true, error: 'not applied' } },
      ],
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean('result-failed', ['tu-one', 'tu-two']);
  });

  it('does not release a complete granted batch when a result tool is not a native edit', async () => {
    writeBatch('unknown-tool', 'granted', ['tu-one', 'tu-two']);

    const out = await runHook(BATCH_HOOK, {
      ...batchInput(['tu-one', 'tu-two']),
      tool_calls: [
        { tool_use_id: 'tu-one', tool_name: 'Edit', tool_response: { ok: true } },
        { tool_use_id: 'tu-two', tool_name: 'Read', tool_response: { ok: true } },
      ],
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean('unknown-tool', ['tu-one', 'tu-two']);
  });

  it('does not attach proof for a textual native failure result', async () => {
    const toolUseId = 'tu-proof-text-failed';
    fs.writeFileSync(join(cache, toolUseId + '.lock'), 'single-lock');
    fs.writeFileSync(join(cache, toolUseId + '.paths'), JSON.stringify(['src/first.ts']));

    const out = await runHook(POST_HOOK, {
      tool_name: 'Write',
      tool_use_id: toolUseId,
      session_id: 'single-owner',
      tool_response: 'Permission denied: edit refused',
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(1);
    expect(releaseRequests[0]?.params?.arguments).not.toHaveProperty('native_edit_proof');
  });
});

describe('posttoolbatch already-held attestation (WI-10006900)', () => {
  const readAttest = () =>
    JSON.parse(fs.readFileSync(join(cache, 'last-attest.json'), 'utf8')) as Record<string, any>;

  it('attests a fully already-held batch with retain and proof-only paths, releasing nothing', async () => {
    writeBatch('held', 'granted', ['tu-first', 'tu-second'], {
      releasePaths: [],
      attestPaths: ['src/first.ts', 'src/second.ts'],
    });

    const out = await runHook(BATCH_HOOK, batchInput(['tu-first', 'tu-second']));

    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(releaseRequests).toHaveLength(1);
    const args = releaseRequests[0]?.params?.arguments;
    expect(releaseRequests[0]?.params?.name).toBe('locks:release');
    expect(args).toEqual({
      retain: true,
      coordination_domain: '/repo',
      native_edit_proof: {
        success: true,
        source: 'claude',
        tools: ['Edit', 'Edit'],
        paths: ['src/first.ts', 'src/second.ts'],
        sessionId: 'batch-owner',
      },
    });
    expect(readAttest()).toMatchObject({
      handler: 'posttoolbatch',
      attributed: true,
      paths: ['src/first.ts', 'src/second.ts'],
    });
    expectClean('held', ['tu-first', 'tu-second']);
  });

  it('releases the newly held subset and attests the already-held subset separately', async () => {
    writeBatch('mixed', 'granted', ['tu-first', 'tu-second'], {
      releasePaths: ['src/first.ts'],
      attestPaths: ['src/second.ts'],
    });

    const out = await runHook(BATCH_HOOK, batchInput(['tu-first', 'tu-second']));

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(2);
    const [release, attest] = releaseRequests.map((r) => r.params?.arguments);
    expect(release).toMatchObject({
      lock_id: 'batch-lock',
      paths: ['src/first.ts'],
      native_edit_proof: { paths: ['src/first.ts'] },
    });
    expect(release).not.toHaveProperty('retain');
    expect(attest).toMatchObject({ retain: true, native_edit_proof: { paths: ['src/second.ts'] } });
    expect(attest).not.toHaveProperty('lock_id');
    expect(attest).not.toHaveProperty('paths');
    expect(readAttest().attributed).toBe(true);
    expectClean('mixed', ['tu-first', 'tu-second']);
  });

  it('attests nothing when one batch member failed', async () => {
    writeBatch('held-failed', 'granted', ['tu-one', 'tu-two'], {
      releasePaths: [],
      attestPaths: ['src/first.ts', 'src/second.ts'],
    });

    const out = await runHook(BATCH_HOOK, {
      ...batchInput(['tu-one', 'tu-two']),
      tool_calls: [
        { tool_use_id: 'tu-one', tool_name: 'Edit', tool_response: { ok: true } },
        { tool_use_id: 'tu-two', tool_name: 'Edit', tool_response: { is_error: true, error: 'not applied' } },
      ],
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expect(fs.existsSync(join(cache, 'last-attest.json'))).toBe(false);
    expectClean('held-failed', ['tu-one', 'tu-two']);
  });

  it('records an unconfirmed attestation when the operator refuses retain', async () => {
    attestResponse = { ok: false, error: 'invalid_args: no selector' };
    writeBatch('held-refused', 'granted', ['tu-first'], {
      paths: ['src/first.ts'],
      releasePaths: [],
      attestPaths: ['src/first.ts'],
    });

    const out = await runHook(BATCH_HOOK, batchInput(['tu-first']));

    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(releaseRequests).toHaveLength(1);
    const marker = readAttest();
    expect(marker.attributed).toBe(false);
    expect(String(marker.detail)).toContain('no selector');
    expectClean('held-refused', ['tu-first']);
  });
});

describe('posttooluse-locks-release.sh batch deferral', () => {
  it('leaves the per-tool release token untouched while a batch marker exists', async () => {
    const toolUseId = 'tu-deferred';
    writeBatch('deferred', 'granted', [toolUseId]);
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), 'per-tool-lock');
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(['src/first.ts']));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), '/repo');

    const out = await runHook(POST_HOOK, { tool_use_id: toolUseId, session_id: 'batch-owner' });

    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('');
    expect(releaseRequests).toHaveLength(0);
    expect(fs.readFileSync(join(cache, `${toolUseId}.lock`), 'utf8')).toBe('per-tool-lock');
    expect(fs.existsSync(join(cache, `${toolUseId}.paths`))).toBe(true);
    expect(fs.existsSync(join(cache, `${toolUseId}.domain`))).toBe(true);
  });

  it('forwards positive proof only for a successful recognized native result', async () => {
    const toolUseId = 'tu-proof';
    writeBatch('not-a-batch', 'allowed', []);
    fs.rmSync(join(cache, 'batch-not-a-batch.state.json'), { force: true });
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), 'single-lock');
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(['src/first.ts']));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), '/repo');

    const out = await runHook(POST_HOOK, {
      tool_name: 'Edit',
      tool_use_id: toolUseId,
      session_id: 'single-owner',
      tool_response: { ok: true },
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(1);
    expect(releaseRequests[0]?.params?.arguments).toMatchObject({
      lock_id: 'single-lock',
      paths: ['src/first.ts'],
      coordination_domain: '/repo',
      native_edit_proof: {
        success: true,
        source: 'claude',
        tool: 'Edit',
        paths: ['src/first.ts'],
      },
    });
  });

  it('regenerates a successful Codex apply_patch before releasing its source lock', async () => {
    const toolUseId = 'tu-codex-declaration';
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), 'codex-lock');
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(['scripts/input.mjs']));
    fs.writeFileSync(join(cache, `${toolUseId}.domain`), repo);

    const out = await runHook(POST_HOOK, {
      tool_name: 'apply_patch',
      tool_use_id: toolUseId,
      session_id: 'codex-owner',
      cwd: repo,
      tool_input: '*** Begin Patch\n*** Update File: scripts/input.mjs\n*** End Patch',
      tool_response: { success: true },
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(1);
    expect(releaseObservedAfterRegen).toEqual([true]);
    expect(releaseRequests[0]?.params?.arguments).toMatchObject({
      native_edit_proof: {
        success: true,
        source: 'codex',
        tool: 'apply_patch',
        paths: ['scripts/input.mjs'],
      },
    });
    expect(JSON.parse(fs.readFileSync(regenMarker, 'utf8'))).toEqual([
      '--files=scripts/input.mjs',
    ]);
  });

  it('uses the stable release authority when the primary MCP response has no text result', async () => {
    const toolUseId = 'tu-empty-primary';
    const fallbackRequests: Array<Record<string, any>> = [];
    const fallbackServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        fallbackRequests.push(JSON.parse(body) as Record<string, any>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({ ok: true, released: ['src/first.ts'] }),
            }],
          },
        }));
      });
    });
    await new Promise<void>((resolve) => fallbackServer.listen(0, '127.0.0.1', resolve));
    const address = fallbackServer.address();
    if (!address || typeof address === 'string') throw new Error('fallback server did not bind');

    primaryNoText = true;
    fs.writeFileSync(join(cache, toolUseId + '.lock'), 'primary-lock');
    fs.writeFileSync(join(cache, toolUseId + '.paths'), JSON.stringify(['src/first.ts']));
    fs.writeFileSync(join(cache, toolUseId + '.domain'), '/repo');

    try {
      const out = await runHook(POST_HOOK, {
        tool_name: 'apply_patch',
        tool_use_id: toolUseId,
        session_id: 'codex-owner',
        tool_response: { success: true },
      }, {
        PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL: 'http://127.0.0.1:' + address.port,
      });

      expect(out.status).toBe(0);
      expect(releaseRequests).toHaveLength(1);
      expect(fallbackRequests).toHaveLength(1);
      expect(fallbackRequests[0]?.params?.arguments).toMatchObject({
        lock_id: 'primary-lock',
        paths: ['src/first.ts'],
        coordination_domain: '/repo',
        native_edit_proof: {
          success: true,
          source: 'codex',
          tool: 'apply_patch',
          paths: ['src/first.ts'],
        },
      });
      expect(fs.existsSync(join(cache, toolUseId + '.lock'))).toBe(false);
      expect(fs.existsSync(join(cache, toolUseId + '.paths'))).toBe(false);
      expect(fs.existsSync(join(cache, toolUseId + '.domain'))).toBe(false);
      expect(fs.existsSync(join(cache, 'owner-codex-owner-last-success.json'))).toBe(true);
      expect(fs.existsSync(join(cache, 'last-error.json'))).toBe(false);
    } finally {
      primaryNoText = false;
      await new Promise<void>((resolve) => fallbackServer.close(() => resolve()));
    }
  });

  it('injects a manual lock-mode update when a Codex release cannot be confirmed', async () => {
    const toolUseId = 'tu-unconfirmed-release';
    primaryNoText = true;
    fs.writeFileSync(join(cache, toolUseId + '.lock'), 'unconfirmed-lock');
    fs.writeFileSync(join(cache, toolUseId + '.paths'), JSON.stringify(['src/first.ts']));
    fs.writeFileSync(join(cache, toolUseId + '.domain'), '/repo');

    const out = await runHook(POST_HOOK, {
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_use_id: toolUseId,
      session_id: 'codex-owner',
      tool_response: { success: true },
    }, {
      PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL: operatorUrl,
    });

    expect(out.status).toBe(0);
    const hookOutput = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hookOutput.hookEventName).toBe('PostToolUse');
    expect(hookOutput.additionalContext).toContain('LOCK MODE UPDATE');
    expect(hookOutput.additionalContext).toContain('manual');
    expect(hookOutput.additionalContext).toContain('src/first.ts');
    expect(fs.existsSync(join(cache, toolUseId + '.lock'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(join(cache, 'last-error.json'), 'utf8'))).toMatchObject({
      handler: 'posttooluse',
      phase: 'release',
      detail: 'response: no-text',
    });
  });

  it('injects a manual lock-mode update when a Claude batch release cannot be confirmed', async () => {
    const batchId = 'batch-unconfirmed-release';
    const toolUseId = 'tu-batch-unconfirmed-release';
    writeBatch(batchId, 'granted', [toolUseId]);
    primaryNoText = true;

    const out = await runHook(BATCH_HOOK, {
      ...batchInput([toolUseId]),
      tool_calls: [{
        tool_use_id: toolUseId,
        tool_name: 'Edit',
        tool_response: { success: true },
      }],
    }, {
      PAPERCUSP_LOCKS_FALLBACK_OPERATOR_URL: operatorUrl,
    });

    expect(out.status).toBe(0);
    const hookOutput = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hookOutput.hookEventName).toBe('PostToolBatch');
    expect(hookOutput.additionalContext).toContain('LOCK MODE UPDATE');
    expect(hookOutput.additionalContext).toContain('manual');
    expect(hookOutput.additionalContext).toContain('src/first.ts');
    expect(JSON.parse(fs.readFileSync(join(cache, 'last-error.json'), 'utf8'))).toMatchObject({
      handler: 'posttoolbatch',
      phase: 'release',
      detail: 'response: no-text',
    });
    expectClean(batchId, [toolUseId]);
  });

  it('keeps PostToolBatch attribution Claude-only when a Codex edit appears', async () => {
    writeBatch('codex-batch', 'granted', ['tu-codex']);

    const out = await runHook(BATCH_HOOK, {
      ...batchInput(['tu-codex']),
      tool_calls: [{ tool_use_id: 'tu-codex', tool_name: 'apply_patch', tool_response: { success: true } }],
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(0);
    expectClean('codex-batch', ['tu-codex']);
  });

  it('does not attach proof for a failed native result', async () => {
    const toolUseId = 'tu-proof-failed';
    fs.writeFileSync(join(cache, `${toolUseId}.lock`), 'single-lock');
    fs.writeFileSync(join(cache, `${toolUseId}.paths`), JSON.stringify(['src/first.ts']));

    const out = await runHook(POST_HOOK, {
      tool_name: 'Edit',
      tool_use_id: toolUseId,
      session_id: 'single-owner',
      tool_response: { is_error: true, error: 'edit failed' },
    });

    expect(out.status).toBe(0);
    expect(releaseRequests).toHaveLength(1);
    expect(releaseRequests[0]?.params?.arguments).not.toHaveProperty('native_edit_proof');
  });
});
