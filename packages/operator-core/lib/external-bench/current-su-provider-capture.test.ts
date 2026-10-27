import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentBenchWorkloadProviderInputCapture } from './current-su';
import type { GatewayCarryTrialAttempt } from '../inference-gateway/gateway';

describe('Claude host provider capture', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'claude-provider-capture-')); roots.push(root);
    const captureRoot = join(root, 'host'), candidateCheckoutRoot = join(root, 'candidate');
    mkdirSync(captureRoot, { mode: 0o700 }); mkdirSync(candidateCheckoutRoot);
    const options = { accountingBinding: { workspaceId: 'bench-private', loopId: 'capture-loop', runId: 'capture-run',
      preregHash: 'a'.repeat(64), assignmentId: 'bench-assignment:claude-capture' },
      captureRoot, candidateCheckoutRoot, agent: 'claude' as const, model: 'claude-opus-4-6',
      effort: 'high', accountId: 'private-api-key-account', maxRequests: 2, maxBytes: 16_384 };
    const body = JSON.stringify({ model: options.model, output_config: { effort: options.effort }, max_tokens: 10,
      metadata: { user_id: 'caller-metadata-is-not-native-identity' }, messages: [{ role: 'user', content: 'Exact private input' }] });
    const attempt: GatewayCarryTrialAttempt = { attemptId: randomUUID(), manifestSha256: options.accountingBinding.preregHash,
      armId: options.accountingBinding.assignmentId, transport: 'anthropic-http', target: 'https://api.anthropic.com/v1/messages',
      credentialHeader: 'x-api-key', credentialSha256: 'b'.repeat(64), accountId: options.accountId,
      anthropicVersion: '2023-06-01', anthropicBeta: null, body,
      bodySha256: createHash('sha256').update(body).digest('hex'), clockId: 'private-capture-clock', signal: new AbortController().signal };
    return { options, attempt, capture: currentBenchWorkloadProviderInputCapture(options) };
  }
  it('retains exact request bytes and route headers without inventing native session, turn or message IDs', async () => {
    const f = fixture(); await f.capture.captureProviderInput(f.attempt);
    const receipt = f.capture.readCapture(f.attempt.attemptId)!;
    expect(receipt).toMatchObject({ agent: 'claude', reservationId: f.attempt.attemptId,
      bodySha256: f.attempt.bodySha256, anthropicVersion: '2023-06-01', anthropicBeta: null });
    expect(receipt).not.toHaveProperty('nativeSessionId'); expect(receipt).not.toHaveProperty('nativeTurnId');
    expect(receipt).not.toHaveProperty('nativeMessageId');
    expect(readFileSync(join(f.options.captureRoot, receipt.bodyPath), 'utf8')).toBe(f.attempt.body);
    expect(JSON.stringify(receipt)).not.toMatch(/credential|authorization|signal|caller-metadata/);
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.accountingBinding)).toBe(true);
  });
  it('restores host pins in read-only mode and preserves request allocation bounds across recovery', async () => {
    const f = fixture(); await f.capture.captureProviderInput(f.attempt);
    const recovery = JSON.parse(JSON.stringify(f.capture.recoveryState()));
    const restored = currentBenchWorkloadProviderInputCapture({ ...f.options, recovery });
    expect(restored.readCapture(f.attempt.attemptId)).toEqual(f.capture.readCapture(f.attempt.attemptId));
    const readonly = currentBenchWorkloadProviderInputCapture({ ...f.options, recovery, readOnly: true });
    expect(readonly.readCapture(f.attempt.attemptId)).toEqual(f.capture.readCapture(f.attempt.attemptId));
    await expect(readonly.captureProviderInput({ ...f.attempt, attemptId: randomUUID() })).rejects.toThrow(/Read-only/);
    await restored.captureProviderInput({ ...f.attempt, attemptId: randomUUID() });
    await expect(restored.captureProviderInput({ ...f.attempt, attemptId: randomUUID() })).rejects.toThrow(/exhausted/);
    expect(() => currentBenchWorkloadProviderInputCapture({ ...f.options, agent: undefined, recovery })).toThrow(/recovery/);
  });
  it.each(['session', 'turn', 'transport', 'target', 'header', 'version', 'beta', 'missing-beta', 'account',
    'hash', 'model', 'effort', 'remote-input', 'aborted'])(
    'refuses %s drift before reserving capture space', async fault => {
      const f = fixture(), attempt = { ...f.attempt };
      if (fault === 'session') attempt.nativeSessionId = randomUUID();
      if (fault === 'turn') attempt.nativeTurnId = randomUUID();
      if (fault === 'transport') attempt.transport = 'oauth-http';
      if (fault === 'target') attempt.target += '/foreign';
      if (fault === 'header') attempt.credentialHeader = 'authorization';
      if (fault === 'version') attempt.anthropicVersion = 'foreign';
      if (fault === 'beta') attempt.anthropicBeta = 'context-1m-2025-08-07';
      if (fault === 'missing-beta') delete attempt.anthropicBeta;
      if (fault === 'account') attempt.accountId = 'foreign';
      if (fault === 'hash') attempt.bodySha256 = 'c'.repeat(64);
      if (['model', 'effort', 'remote-input'].includes(fault)) {
        const body = JSON.parse(attempt.body);
        if (fault === 'model') body.model = 'foreign';
        if (fault === 'effort') body.output_config.effort = 'low';
        if (fault === 'remote-input') body.messages[0].content = [{ type: 'image', source: { type: 'url', url: 'https://example.com/image' } }];
        attempt.body = JSON.stringify(body); attempt.bodySha256 = createHash('sha256').update(attempt.body).digest('hex');
      }
      if (fault === 'aborted') { const controller = new AbortController(); controller.abort(); attempt.signal = controller.signal; }
      await expect(f.capture.captureProviderInput(attempt)).rejects.toThrow();
      expect(f.capture.recoveryState().captures).toEqual([]);
      await f.capture.captureProviderInput(f.attempt);
      expect(f.capture.readCapture(f.attempt.attemptId)).not.toBeNull();
    });
  it('refuses altered request bytes during both live reads and pinned recovery', async () => {
    const f = fixture(); await f.capture.captureProviderInput(f.attempt);
    const receipt = f.capture.readCapture(f.attempt.attemptId)!, recovery = f.capture.recoveryState();
    writeFileSync(join(f.options.captureRoot, receipt.bodyPath), f.attempt.body + ' ');
    expect(f.capture.readCapture(f.attempt.attemptId)).toBeNull();
    expect(() => currentBenchWorkloadProviderInputCapture({ ...f.options, recovery })).toThrow(/altered/);
  });
  it('refuses subscription capture under the API-key admission contract', () => {
    const f = fixture();
    expect(() => currentBenchWorkloadProviderInputCapture({ ...f.options, payer: 'subscription' })).toThrow(/bounded/);
  });
});
