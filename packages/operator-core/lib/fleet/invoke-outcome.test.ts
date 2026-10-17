import { describe, it, expect } from 'vitest';
import { agentProducedTurn } from './invoke-outcome';

describe('agentProducedTurn — the shared no-turn rule (docs-audit #1)', () => {
  it('ran=true when ok:true and agentOutput is non-empty', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: true, agentOutput: 'NEXT_WORKER chunk-1' }), 'h/worker');
    expect(r.ran).toBe(true);
    expect(r.detail).toBe('');
  });

  it('ran=false when ok:false (the agent reported failure)', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: false, exitCode: 1, agentOutput: '' }), 'h/queen');
    expect(r.ran).toBe(false);
    expect(r.detail).toContain('produced no turn');
    expect(r.detail).toContain('h/queen');
  });

  it('makes a timed-out no-turn actionable without guessing whether the launcher or gateway caused it', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 143,
        timedOut: true,
        agentOutput: '',
        rawStdoutTail:
          '[08:01:19 prompt-budget role=release-fixer total=63586 substrate=3572 history=0 playbook=0]\n' +
          '[08:16:17 invoke-once received termination signal — aborting agent',
      }),
      'papercusp/release-fixer',
    );
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('infra_loss');
    expect(r.detail).toContain('timed out before producing a turn');
    expect(r.detail).toContain('prompt-budget role=release-fixer total=63586');
    expect(r.detail).toContain('launcher termination record');
    expect(r.detail).toContain('account/gateway telemetry');
    expect(r.detail).not.toContain('more often');
    expect(r.detail).not.toContain('gateway stall/429 storm');
  });

  it('distinguishes a bounded first-turn timeout from the full invoke deadline', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 143,
        timedOut: true,
        firstTurnTimedOut: true,
        agentOutput: '',
        rawStdoutTail: '[08:15:34 prompt-budget role=release-fixer total=63586',
      }),
      'papercusp/release-fixer',
    );
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('infra_loss');
    expect(r.detail).toContain('bounded first-turn silence guard');
    expect(r.detail).toContain('before producing a turn');
    expect(r.detail).toContain('full invoke deadline');
  });

  it('includes bounded raw stdout tail when a no-turn child left CLI diagnostics', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '',
        agentOutput: '',
        rawStdoutTail: '[2026-06-25T07:31:00.000Z] booting\nAPI Error: invalid_api_key',
      }),
      'h/queen',
    );
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('auth_error');
    expect(r.detail).toContain('rawStdoutTail=');
    expect(r.detail).toContain('invalid_api_key');
  });

  it('classifies invalid API-key no-turn diagnostics as auth_error, not infra_loss', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '',
        agentOutput: '',
        rawStdoutTail:
          'unexpected status 401 Unauthorized: Incorrect API key provided: sk-ant-a***. auth error code: invalid_api_key',
      }),
      'papercusp/queen',
    );
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('auth_error');
    expect(r.detail).toContain('papercusp/queen');
    expect(r.detail).toContain('account routing');
    expect(r.detail).toContain('invalid_api_key');
  });

  it('classifies native Codex usage limits as usage_limit, not infra_loss', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '',
        agentOutput: '',
        rawStdoutTail: "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
      }),
      'papercusp/queen',
    );
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('usage_limit');
    expect(r.detail).toContain('usage_limit');
    expect(r.detail).toContain('different healthy account');
  });

  it('ran=false when ok:true but output is EMPTY (0-token wake) — the silent-swallow case', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: true, agentOutput: '   ' }), 'h/doc-steward');
    expect(r.ran).toBe(false);
    expect(r.detail).toContain('h/doc-steward');
    expect(r.detail).toContain('outLen=0');
  });

  it('falls back to stdout when agentOutput is absent', () => {
    expect(agentProducedTurn(JSON.stringify({ ok: true, stdout: 'done' }), 'h/r').ran).toBe(true);
    expect(agentProducedTurn(JSON.stringify({ ok: true, stdout: '' }), 'h/r').ran).toBe(false);
  });

  // Never flip a spawn to failed on uncertainty — the most load-bearing path.
  it('ran=true (assume done) on an unreadable/empty body', () => {
    expect(agentProducedTurn('', 'h/r').ran).toBe(true);
  });

  it('ran=true (assume done) on an unparseable body', () => {
    expect(agentProducedTurn('not json {{{', 'h/r').ran).toBe(true);
  });

  it('ran=true (assume done) on a non-invoke-result body (no boolean ok)', () => {
    expect(agentProducedTurn(JSON.stringify({ message: 'queued' }), 'h/r').ran).toBe(true);
  });

  it('ran=true leaves failureClass undefined', () => {
    const r = agentProducedTurn(JSON.stringify({ ok: true, agentOutput: 'NEXT_WORKER' }), 'h/w');
    expect(r.ran).toBe(true);
    expect(r.failureClass).toBeUndefined();
  });
});

// P-006/H13 — a mid-turn capacity shed (the all-accounts gateway 429 storm) was being
// mislabeled infra_loss / "host dead/unstable", sending debuggers hunting a phantom host
// bug. It is now classified capacity_shed (retryable) iff BOTH the clean-mid-turn-exit
// fingerprint AND the live gateway-throttled corroboration hold.
describe('agentProducedTurn — capacity_shed vs infra_loss classification (P-006/H13)', () => {
  // The death fingerprint: exit 1, empty stderr, no timeout (1st gateway call produced
  // output, the 2nd hit the storm and the process exited 1 cleanly).
  const shedBody = JSON.stringify({ ok: false, exitCode: 1, timedOut: false, stderr: '', agentOutput: 'I will check…' });

  it('capacity_shed when the fingerprint holds AND the gateway was wholesale-throttled', () => {
    const r = agentProducedTurn(shedBody, 'h/queen', { gatewayThrottled: true });
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('capacity_shed');
    expect(r.detail).toContain('capacity_shed');
    expect(r.detail).toContain('RETRYABLE');
    expect(r.detail).not.toContain('host dead');
    expect(r.detail).toContain('h/queen');
  });

  it('infra_loss (legacy) when the fingerprint holds but the gateway was NOT throttled', () => {
    const r = agentProducedTurn(shedBody, 'h/queen', { gatewayThrottled: false });
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('infra_loss');
    expect(r.detail).toContain('produced no turn');
  });

  it('infra_loss when gatewayThrottled is omitted (conservative default — never flip on uncertainty)', () => {
    const r = agentProducedTurn(shedBody, 'h/queen');
    expect(r.failureClass).toBe('infra_loss');
  });

  it('infra_loss when the gateway was throttled but stderr is NON-empty (a real crash trail)', () => {
    const body = JSON.stringify({ ok: false, exitCode: 1, timedOut: false, stderr: 'Segmentation fault', agentOutput: '' });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('infra_loss');
  });

  it('infra_loss when the gateway was throttled but the run TIMED OUT (not a clean mid-turn exit)', () => {
    const body = JSON.stringify({ ok: false, exitCode: 1, timedOut: true, stderr: '', agentOutput: '' });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('infra_loss');
  });

  it('infra_loss when the gateway was throttled but exitCode is not 1 (signal kill / null)', () => {
    const body = JSON.stringify({ ok: false, exitCode: null, timedOut: false, stderr: '', agentOutput: '' });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('infra_loss');
  });

  // EI-16502: the outer-process activity-heartbeat marker (invoke.ts
  // `echoActivityToOuterProcess`, WI-3302) is echoed to the SAME stderr the
  // capacity_shed fingerprint inspects. Before the fix, ANY stderr consisting
  // only of that marker defeated `stderr === ''` and silently forced a genuine
  // capacity-shed death to misclassify as infra_loss.
  it('capacity_shed still fires when stderr is ONLY repeated activity-heartbeat marker lines', () => {
    const body = JSON.stringify({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stderr: '[papercusp:activity]\n'.repeat(50),
      agentOutput: 'I will check…',
    });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('capacity_shed');
    expect(r.detail).toContain('RETRYABLE');
  });

  it('infra_loss (real crash) still wins when stderr has heartbeat noise PLUS a real trail', () => {
    const body = JSON.stringify({
      ok: false,
      exitCode: 1,
      timedOut: false,
      stderr: '[papercusp:activity]\n[papercusp:activity]\nSegmentation fault\n[papercusp:activity]\n',
      agentOutput: '',
    });
    const r = agentProducedTurn(body, 'h/queen', { gatewayThrottled: true });
    expect(r.failureClass).toBe('infra_loss');
  });
});

// B3 / autonomous-loop-hardening F1 — a "Prompt is too long" death (B1: overwatch launched
// with the unscoped full-catalog MCP surface on a small-context model) was being misattributed
// to a "gateway stall / 429 storm" infra_loss, sending debuggers hunting phantom gateway
// capacity for hours. It is now classified `context_overflow` (a LAUNCH-CONFIG bug),
// detected BEFORE the capacity_shed/infra_loss fallthrough.
describe('agentProducedTurn — context_overflow (prompt-too-long) classification (B3/F1)', () => {
  it('classifies the exact overwatch "Prompt is too long" death as context_overflow, not infra_loss', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '',
        agentOutput: '',
        rawStdoutTail:
          'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long: 210000 tokens > 200000 maximum"}}',
      }),
      'papercusp/overwatch',
    );
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('context_overflow');
    expect(r.detail).toContain('papercusp/overwatch');
    expect(r.detail).toContain('context_overflow');
    expect(r.detail).toContain('LAUNCH-CONFIG');
    // The regression: must NOT read as an infra_loss / gateway-stall phantom host death.
    expect(r.detail).not.toContain('produced no turn');
    expect(r.detail).toContain('Prompt is too long');
  });

  it('classifies an OpenAI-style "maximum context length" death as context_overflow', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '',
        agentOutput: '',
        rawStdoutTail:
          "This model's maximum context length is 200000 tokens, however you requested 260000 tokens. Please reduce the length of the messages.",
      }),
      'papercusp/queen',
    );
    expect(r.ran).toBe(false);
    expect(r.failureClass).toBe('context_overflow');
  });

  it('context_overflow WINS over capacity_shed — a prompt-too-long tail is not a retryable throttle', () => {
    // The clean-mid-turn-exit fingerprint holds AND the gateway is throttled, which would
    // otherwise classify capacity_shed (retryable). But the prompt is too long — retrying
    // will just fail again — so context_overflow must take precedence.
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '',
        agentOutput: '',
        rawStdoutTail: 'Prompt is too long',
      }),
      'papercusp/overwatch',
      { gatewayThrottled: true },
    );
    expect(r.failureClass).toBe('context_overflow');
  });

  it('leaves a genuine no-turn death (no prompt-length signature) classified infra_loss', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '',
        agentOutput: '',
        rawStdoutTail: '[2026-07-01T06:39:00.000Z] booting\n[2026-07-01T06:39:03.000Z] tool: coord.orient',
      }),
      'papercusp/overwatch',
    );
    expect(r.failureClass).toBe('infra_loss');
  });

  // EI-16502: a real diagnostic (auth/usage/context signature) landing in
  // rawStdoutTail must still classify correctly even when stderr is nothing
  // but the activity-heartbeat marker — the marker must not crowd it out nor
  // itself get matched as "content".
  it('a real auth_error signature in rawStdoutTail is not masked by heartbeat-only stderr', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '[papercusp:activity]\n[papercusp:activity]\n',
        agentOutput: '',
        rawStdoutTail: 'unexpected status 401 Unauthorized: auth error code: invalid_api_key',
      }),
      'papercusp/queen',
    );
    expect(r.failureClass).toBe('auth_error');
  });

  // Marker-only stderr AND rawStdoutTail, with no other diagnostic at all — the
  // genuinely-silent-death case must fall through cleanly to infra_loss (not
  // 'other'/misclassified), with the persisted detail carrying no marker noise.
  it('falls through cleanly to infra_loss when BOTH stderr and rawStdoutTail are heartbeat-only noise', () => {
    const r = agentProducedTurn(
      JSON.stringify({
        ok: false,
        exitCode: 1,
        timedOut: false,
        stderr: '[papercusp:activity]\n'.repeat(20),
        agentOutput: '',
        rawStdoutTail: '[papercusp:activity]\n'.repeat(20),
      }),
      'papercusp/cup',
    );
    expect(r.failureClass).toBe('infra_loss');
    expect(r.detail).not.toContain('papercusp:activity');
  });
});
