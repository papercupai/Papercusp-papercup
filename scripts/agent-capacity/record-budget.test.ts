import { createHash, randomUUID } from 'node:crypto';
import { fsyncSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recordingAttemptReserve, recordingBudgetFromArgv, recordingBudgetJournal, recordingProviderBudget, startRecordingBudgetGateway,
  type RecordingBudgetConfig } from './record-budget';
import { processMonotonicClock } from '../../packages/operator-core/lib/process-monotonic-clock';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../../packages/operator-core/lib/inference-gateway/gateway';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const config: RecordingBudgetConfig = { model: 'gpt-6-luna', effort: 'low', accountId: 'recording-account',
  credentialSha256: sha256('Bearer fake-provider-credential'), target: 'https://api.openai.com/v1/responses',
  maxAttempts: 8, maxUsdMicros: 8_000_000 };
const request = { model: config.model, reasoning: { effort: config.effort }, input: 'PRIVATE_TASK_TEXT',
  tools: [{ type: 'function', name: 'local_exec', parameters: { type: 'object' } }] };
// Codex Responses-lite captured against a loopback-only refusal server. Tool
// schemas are local definitions, not message content or hosted provider tools.
const nativeTools = [{ type: 'namespace', name: 'functions', tools: [
  { type: 'custom', name: 'exec', format: { type: 'text' } },
  { type: 'function', name: 'wait', parameters: { type: 'object', properties: {
    cell_id: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
  } } },
] }];
const nativeRequest = { model: config.model, reasoning: { effort: config.effort, context: 'all_turns' },
  stream: true, store: false, input: [
    { type: 'additional_tools', id: 'local-tools', role: 'developer', tools: nativeTools },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'PRIVATE_TASK_TEXT' }] },
  ] };

function attempt(budget: ReturnType<typeof recordingProviderBudget>, overrides: Partial<GatewayCarryTrialAttempt> = {}): GatewayCarryTrialAttempt {
  const body = JSON.stringify(request);
  return { attemptId: randomUUID(), manifestSha256: budget.binding.manifestSha256, armId: budget.binding.armId,
    transport: 'bearer-http', accountId: config.accountId, target: config.target,
    credentialHeader: 'authorization', credentialSha256: config.credentialSha256, body, bodySha256: sha256(body),
    clockId: processMonotonicClock.id, signal: new AbortController().signal, ...overrides };
}

describe('recording provider budget', () => {
  it('reserves full intrinsic input/output with canonical cache, long-context, Fast and regional rates', () => {
    expect(recordingAttemptReserve()).toMatchObject({ inputTokens: 922_000, outputTokens: 128_000,
      usdMicros: 718_300, costSource: 'estimated-upper-bound' });
  });

  it('shares one final-send counter across concurrent workers and recovery passes beyond six attempts', async () => {
    const persist = vi.fn();
    const budget = recordingProviderBudget(config, persist);
    const receipts = await Promise.all(Array.from({ length: 14 }, () => budget.binding.authorizeAttempt(attempt(budget))));
    let sends = 0;
    for (const receipt of receipts) {
      try { receipt!.validateAuthorization!(); sends++; } catch { /* Denied writes never reach the provider. */ }
    }
    expect(sends).toBe(8);
    expect(budget.snapshot()).toMatchObject({ admitted: 8, denied: 6, reservedUsdMicros: 8 * 718_300 });
    expect(persist).toHaveBeenCalledTimes(15);
  });

  it('enforces the USD boundary even when the attempt allowance is higher', async () => {
    const budget = recordingProviderBudget({ ...config, maxUsdMicros: 2 * 718_300 }, () => {});
    for (let i = 0; i < 2; i++) (await budget.binding.authorizeAttempt(attempt(budget)))!.validateAuthorization!();
    const denied = await budget.binding.authorizeAttempt(attempt(budget));
    expect(() => denied!.validateAuthorization!()).toThrow(/exhausted/);
    expect(budget.snapshot().reservedUsdMicros).toBe(1_436_600);
  });

  it.each(['inline', 'top-level'] as const)('admits native local tool namespaces (%s) without treating JSON schemas as content', async form => {
    const budget = recordingProviderBudget(config, () => {});
    const body = JSON.stringify(form === 'inline' ? nativeRequest : { ...request, tools: nativeTools });
    const receipt = await budget.binding.authorizeAttempt(attempt(budget, { body, bodySha256: sha256(body) }));
    expect(receipt).not.toBeNull();
    receipt!.validateAuthorization!();
    expect(budget.snapshot()).toMatchObject({ admitted: 1, reservedUsdMicros: 718_300 });
  });

  it.each(['hosted', 'nested-namespace', 'missing-name', 'missing-tools', 'empty', 'user-role', 'extra-image'] as const)(
    'refuses invalid native inline tool declarations (%s) before reserving', async changed => {
      const budget = recordingProviderBudget(config, () => {});
      const value = structuredClone(nativeRequest);
      const entry = value.input[0] as Record<string, any>;
      const namespace = entry.tools[0];
      if (changed === 'hosted') namespace.tools = [{ type: 'web_search' }];
      if (changed === 'nested-namespace') namespace.tools = [{ type: 'namespace', name: 'nested', tools: [] }];
      if (changed === 'missing-name') delete namespace.name;
      if (changed === 'missing-tools') delete namespace.tools;
      if (changed === 'empty') namespace.tools = [];
      if (changed === 'user-role') entry.role = 'user';
      if (changed === 'extra-image') entry.content = [{ type: 'input_image', image_url: 'https://remote/image' }];
      const body = JSON.stringify(value);
      expect(await budget.binding.authorizeAttempt(attempt(budget, { body, bodySha256: sha256(body) }))).toBeNull();
      expect(budget.snapshot()).toMatchObject({ admitted: 0, reservedUsdMicros: 0, refusalReasons: { 'request-shape': 1 } });
    });

  it('records safe refusal categories that distinguish request shape from provider credentials', async () => {
    const budget = recordingProviderBudget(config, () => {});
    const body = JSON.stringify({ ...request, input: [{ type: 'input_image', image_url: 'PRIVATE_TASK_TEXT' }] });
    await budget.binding.authorizeAttempt(attempt(budget, { body, bodySha256: sha256(body) }));
    await budget.binding.authorizeAttempt(attempt(budget, { credentialSha256: sha256('changed credential') }));
    expect(budget.snapshot()).toMatchObject({ admitted: 0, denied: 2,
      refusalReasons: { 'request-shape': 1, credential: 1 } });
    expect(JSON.stringify(budget.snapshot())).not.toContain('PRIVATE_TASK_TEXT');
    expect(JSON.stringify(budget.snapshot())).not.toContain('changed credential');
  });

  it('refuses malformed request JSON even when its digest and provider binding match', async () => {
    const budget = recordingProviderBudget(config, () => {});
    const body = '{invalid';
    expect(await budget.binding.authorizeAttempt(attempt(budget, { body, bodySha256: sha256(body) }))).toBeNull();
    expect(budget.snapshot()).toMatchObject({ admitted: 0, reservedUsdMicros: 0,
      refusalReasons: { 'malformed-request': 1 } });
  });

  it('retains full reservations after fetch failure and successful usage reports', async () => {
    const budget = recordingProviderBudget(config, () => {});
    const first = attempt(budget);
    const receipt = (await budget.binding.authorizeAttempt(first))!;
    receipt.validateAuthorization!();
    const { body: _body, signal: _signal, ...identity } = first;
    await receipt.observeAttemptResult!({ ...identity, reservationRef: receipt.reservationRef,
      outcome: 'fetch-failed', responseStatus: null, costUsdMeasurementMissing: true });
    expect(budget.snapshot().attempts[0].outcome).toBe('fetch-failed');
    const completed: GatewayCarryTrialAttemptResult = { ...identity, reservationRef: receipt.reservationRef,
      outcome: 'response-completed', responseStatus: 200, costUsdMeasurementMissing: true,
      responseSha256: sha256('response'), responseBytes: 8, providerCompletion: { responseId: 'response-id',
        model: config.model, providerEffort: 'low', usage: { inputTokens: 10, inputTokenBasis: 'inclusive',
          outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 } } };
    await receipt.observeAttemptCompletion!(completed);
    expect(budget.snapshot()).toMatchObject({ reservedUsdMicros: 718_300, measuredInvoiceUsd: null,
      attempts: [{ outcome: 'response-completed', usage: { responseId: 'response-id' } }] });
    expect(JSON.stringify(budget.snapshot())).not.toContain('PRIVATE_TASK_TEXT');
    expect(JSON.stringify(budget.snapshot())).not.toContain('fake-provider-credential');
  });

  it.each([
    { accountId: 'other-account' }, { credentialSha256: sha256('changed credential') },
    { target: 'https://api.openai.com/v1/responses?other=1' }, { transport: 'oauth-http' as const },
    { bodySha256: sha256('different body') }, { clockId: 'other-clock' },
  ])('refuses mismatched actual selected-provider identity %j before reserving', async overrides => {
    const budget = recordingProviderBudget(config, () => {});
    expect(await budget.binding.authorizeAttempt(attempt(budget, overrides))).toBeNull();
    expect(budget.snapshot()).toMatchObject({ admitted: 0, reservedUsdMicros: 0, denied: 1 });
  });

  it.each([
    { model: 'gpt-6-sol' }, { reasoning: { effort: 'high' } }, { previous_response_id: 'remote-id' },
    { conversation: 'remote-id' }, { background: true }, { tools: [{ type: 'web_search' }] },
    { prompt: { id: 'stored-remote-prompt' } }, { context_management: [{ type: 'compaction' }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://remote/image' }] }] },
    { input: [{ type: 'item_reference', id: 'remote-item' }] },
  ])('refuses unpriced or remote-context request shapes %j', async overrides => {
    const budget = recordingProviderBudget(config, () => {});
    const body = JSON.stringify({ ...request, ...overrides });
    expect(await budget.binding.authorizeAttempt(attempt(budget, { body, bodySha256: sha256(body) }))).toBeNull();
    expect(budget.snapshot().admitted).toBe(0);
  });

  it('revokes outstanding receipts on abort/stop and refuses duplicate sends', async () => {
    const budget = recordingProviderBudget(config, () => {});
    const signal = new AbortController();
    const aborted = (await budget.binding.authorizeAttempt(attempt(budget, { signal: signal.signal })))!;
    signal.abort();
    expect(() => aborted.validateAuthorization!()).toThrow();
    const sent = (await budget.binding.authorizeAttempt(attempt(budget)))!;
    sent.validateAuthorization!();
    expect(() => sent.validateAuthorization!()).toThrow();
    const outstanding = (await budget.binding.authorizeAttempt(attempt(budget)))!;
    budget.stop();
    expect(() => outstanding.validateAuthorization!()).toThrow();
    expect(budget.snapshot()).toMatchObject({ admitted: 1, reservedUsdMicros: 718_300, stopped: true });
  });

  it('refuses a provider write when its write-ahead reservation cannot be saved', async () => {
    let writes = 0;
    const budget = recordingProviderBudget(config, () => { if (++writes > 1) throw new Error('disk failed'); });
    const receipt = (await budget.binding.authorizeAttempt(attempt(budget)))!;
    expect(() => receipt.validateAuthorization!()).toThrow('disk failed');
    expect(budget.snapshot().reservedUsdMicros).toBe(718_300);
  });

  it('wires a private binding into the real gateway and bounds actual provider fetches', async () => {
    const { createInferenceGateway } = await import('../../packages/operator-core/lib/inference-gateway/gateway');
    const { createFailoverPool } = await import('../../packages/operator-core/lib/inference-gateway/account-failover');
    const fetchProvider = vi.fn(async () => new Response(JSON.stringify({ id: 'test-response', model: config.model,
      status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }), { headers: { 'content-type': 'application/json' } }));
    const service = await startRecordingBudgetGateway({ ...config, maxAttempts: 1 }, () => {}, async binding => {
      const gateway = createInferenceGateway({ accountId: 'unused', token: async () => 'unused',
        codexPool: createFailoverPool([{ accountId: config.accountId, token: async () => 'fake-provider-credential' }]),
        carryTrial: binding, requestAbsorbMs: 0, selfHeal: { enabled: false }, fetchImpl: fetchProvider });
      return { port: await gateway.listen(0), stop: () => gateway.close() };
    });
    try {
      const send = async () => {
        const response = await fetch(service.upstream + '/v1/responses', { method: 'POST',
          headers: { ...service.headers, originator: 'codex_cli_rs', 'content-type': 'application/json' }, body: JSON.stringify(nativeRequest) });
        await response.text(); return response.status;
      };
      expect(await send()).toBe(200);
      expect(await send()).toBe(403);
      expect(fetchProvider).toHaveBeenCalledTimes(1);
      expect(service.snapshot()).toMatchObject({ admitted: 1, reservedUsdMicros: 718_300 });
    } finally { await service.stop(); }
  });
});

describe('recording budget journal', () => {
  it('permanently refuses sends after a reservation fsync fails, without erasing earlier evidence', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'capacity-budget-'));
    const file = path.join(directory, 'recording-budget.jsonl');
    const journal = recordingBudgetJournal(file);
    try {
      const budget = recordingProviderBudget(config, journal.persist);
      const receipt = (await budget.binding.authorizeAttempt(attempt(budget)))!;
      vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error('fsync failed'); });
      expect(() => receipt.validateAuthorization!()).toThrow('fsync failed');
      const retry = (await budget.binding.authorizeAttempt(attempt(budget)))!;
      expect(() => retry.validateAuthorization!()).toThrow(/failed/);
      expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).reservedUsdMicros).toBe(0);
    } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('exclusively owns its batch, preserves all write-ahead reservations and refuses reuse after close', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'capacity-budget-'));
    const file = path.join(directory, 'recording-budget.jsonl');
    const journal = recordingBudgetJournal(file);
    try {
      const budget = recordingProviderBudget(config, journal.persist);
      for (let i = 0; i < 2; i++) (await budget.binding.authorizeAttempt(attempt(budget)))!.validateAuthorization!();
      expect(() => recordingBudgetJournal(file)).toThrow(/EEXIST/);
      const snapshots = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(snapshots.map(snapshot => snapshot.reservedUsdMicros)).toEqual([0, 718_300, 1_436_600]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      journal.close();
      expect(() => journal.persist({})).toThrow(/closed/);
      expect(() => recordingBudgetJournal(file)).toThrow(/EEXIST/);
    } finally { journal.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses symlink destinations without changing their target', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'capacity-budget-'));
    const target = path.join(directory, 'target');
    const journal = recordingBudgetJournal(target);
    journal.persist({ preserved: true });
    journal.close();
    const before = readFileSync(target, 'utf8');
    try {
      const link = path.join(directory, 'link');
      symlinkSync(target, link);
      expect(() => recordingBudgetJournal(link)).toThrow(/EEXIST/);
      expect(readFileSync(target, 'utf8')).toBe(before);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('recording provider budget arguments', () => {
  const selection = { model: config.model, effort: config.effort };
  const argv = ['--max-model-usd', '1.4366', '--max-provider-attempts', '2', '--provider-account', config.accountId,
    '--provider-credential-sha256', config.credentialSha256, '--provider-target', config.target];
  it('preserves absence and parses USD as integer micros', () => {
    expect(recordingBudgetFromArgv([], selection)).toBeUndefined();
    expect(recordingBudgetFromArgv(argv, selection)).toEqual({ ...config, maxAttempts: 2, maxUsdMicros: 1_436_600 });
  });
  it.each(['0', '-1', 'Infinity', '1e2', '0.0000001', '9007199254740992'])('rejects invalid USD %s', usd => {
    expect(() => recordingBudgetFromArgv(argv.map((value, i) => i === 1 ? usd : value), selection)).toThrow();
  });
  it('requires all route identity and explicit model settings', () => {
    expect(() => recordingBudgetFromArgv(argv.slice(0, 4), selection)).toThrow();
    expect(() => recordingBudgetFromArgv(argv)).toThrow();
    expect(() => recordingBudgetFromArgv([...argv, '--max-model-usd', '2'], selection)).toThrow();
  });
});
