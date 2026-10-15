/**
 * P-030 (b): a failed reaction is RECORDED and, when an owner can act on it,
 * SURFACED.
 *
 * The behaviour under test is the one the plan item assumed already existed. It
 * did not: nothing wrote a failure row on the live route, so there was never
 * anything to alert from. These pin both halves — the write, and the debounce
 * that keeps a hot-looping rule from turning one broken install into thousands
 * of notifications.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ReactionFailure } from '@papercusp/event-reaction';
import {
  classifyReactionFailure,
  formatReactionFailureAlert,
  shouldAlertOwner,
  surfaceReactionFailure,
  REACTION_FAILURE_ALERT_WINDOW_MINUTES,
} from './reaction-failure-surface';
import type { ToolInvocationEvent } from './types';
import type { countRecentReactionFailures, recordReactionFailure } from './reaction-dedup';

function failure(over: {
  error: string;
  ruleId?: string;
  source?: string;
  capability?: string;
  workspaceId?: string | null;
}): ReactionFailure<ToolInvocationEvent, string> {
  return {
    rule: {
      id: over.ruleId ?? 'r1',
      on: 'demo:tool',
      fire: 'sink:tool',
      ...(over.source ? { source: over.source } : {}),
      ...(over.capability ? { capability: over.capability } : {}),
    },
    fire: 'sink:tool',
    event: {
      tool: 'demo:tool',
      args: {},
      result: { ok: true },
      ctx: { workspaceId: over.workspaceId === undefined ? 'ws-1' : over.workspaceId },
    } as unknown as ToolInvocationEvent,
    cause: { depth: 1, chain: ['r1'], ruleId: over.ruleId ?? 'r1', rootRunId: 'run-1' },
    dedupId: `reaction:run-1:${over.ruleId ?? 'r1'}`,
    error: over.error,
    stage: 'dispatch',
  };
}

function deps(over: { prior?: number } = {}) {
  return {
    record: vi.fn<typeof recordReactionFailure>(async () => {}),
    countRecent: vi.fn<typeof countRecentReactionFailures>(async () => over.prior ?? 0),
    alert: vi.fn<(workspaceId: string, summary: string) => Promise<void>>(async () => {}),
    log: vi.fn<(msg: string) => void>(),
  };
}

describe('classifyReactionFailure', () => {
  it('reads a capability denial off the CODE prefix and names the rule’s own scope', () => {
    // The capability comes from the rule, not from the message: the message is
    // the dispatcher's prose and is not a contract.
    const c = classifyReactionFailure('missing_capability: principal lacks [sink.write]', {
      capability: 'sink.write',
    });
    expect(c).toEqual({ kind: 'capability', capability: 'sink.write' });
  });

  it('treats capability_denied the same way', () => {
    expect(classifyReactionFailure('capability_denied: nope', { capability: 'c' }).kind).toBe('capability');
  });

  it('does not misread a tool error that merely MENTIONS a capability', () => {
    // Only the code prefix decides. A tool whose own message talks about
    // capabilities is an ordinary runtime failure, not an install mistake.
    const c = classifyReactionFailure('db_error: could not load missing_capability rows', { capability: 'x' });
    expect(c.kind).toBe('other');
  });

  it('recognises an unbound provider class', () => {
    expect(
      classifyReactionFailure(
        'reaction fires "class:foo#bar" but harness "h" resolves to no pot, so no provider binding can be resolved',
        {},
      ).kind,
    ).toBe('unresolved-provider');
  });

  it('recognises a nonexistent fire target', () => {
    expect(classifyReactionFailure('unknown reaction tool "nope:verb"', {}).kind).toBe('unknown-tool');
    expect(classifyReactionFailure('capability class "c" verb "v" resolves to "x", which is not a registered tool', {}).kind).toBe(
      'unknown-tool',
    );
  });
});

describe('shouldAlertOwner', () => {
  it('alerts for install-time mistakes an owner can fix', () => {
    expect(shouldAlertOwner('capability')).toBe(true);
    expect(shouldAlertOwner('unresolved-provider')).toBe(true);
    expect(shouldAlertOwner('unknown-tool')).toBe(true);
  });

  it('stays quiet for an ordinary runtime error — recorded, not notified', () => {
    expect(shouldAlertOwner('other')).toBe(false);
  });
});

describe('formatReactionFailureAlert', () => {
  it('names the rule, the contributor and the capability it needs', () => {
    const msg = formatReactionFailureAlert({
      ruleId: 'acme.on-handoff',
      fire: 'coord:send',
      contributor: 'plugin:acme',
      classification: { kind: 'capability', capability: 'coord.send' },
      error: 'missing_capability: …',
      windowMinutes: 60,
    });
    expect(msg).toContain('acme.on-handoff');
    expect(msg).toContain('plugin:acme');
    expect(msg).toContain('coord.send');
    expect(msg).toContain('coord:send');
  });
});

describe('surfaceReactionFailure', () => {
  it('records EVERY failure, including ones it will not alert on', async () => {
    const d = deps();
    await surfaceReactionFailure(failure({ error: 'db_error: transient blip' }), d);
    expect(d.record).toHaveBeenCalledOnce();
    expect(d.record.mock.calls[0][0]).toMatchObject({
      dedupId: 'reaction:run-1:r1',
      workspaceId: 'ws-1',
      ruleId: 'r1',
      fire: 'sink:tool',
      error: 'db_error: transient blip',
      triggerTool: 'demo:tool',
      causeRootRunId: 'run-1',
      depth: 1,
    });
    expect(d.alert).not.toHaveBeenCalled();
  });

  it('attributes the row to the rule’s contributor', async () => {
    const d = deps();
    // Contributed = capability-scoped, as every plugin/standalone install registers it.
    await surfaceReactionFailure(failure({ error: 'x: y', source: 'plugin:acme', capability: 'plugin:acme' }), d);
    expect(d.record.mock.calls[0][0].contributor).toBe('plugin:acme');
  });

  // WI-10005204: a first-party rule's `source` is a provenance label, not a
  // contributor. Recording it as one put first-party failures in a contributor's
  // bucket and named a built-in "contributed by events-file" to the owner.
  it('records a first-party rule that carries a provenance source with a null contributor', async () => {
    const d = deps();
    await surfaceReactionFailure(failure({ error: 'x: y', source: 'lifecycle-rules' }), d);
    expect(d.record.mock.calls[0][0].contributor).toBeNull();
  });

  it('records a first-party rule with a null contributor, not a fabricated one', async () => {
    const d = deps();
    await surfaceReactionFailure(failure({ error: 'x: y' }), d);
    expect(d.record.mock.calls[0][0].contributor).toBeNull();
  });

  it('alerts the owner on a capability denial', async () => {
    const d = deps();
    await surfaceReactionFailure(
      failure({ error: 'missing_capability: principal lacks [sink.write]', capability: 'sink.write', source: 'plugin:acme' }),
      d,
    );
    expect(d.alert).toHaveBeenCalledOnce();
    const [ws, summary] = d.alert.mock.calls[0];
    expect(ws).toBe('ws-1');
    expect(summary).toContain('sink.write');
    expect(summary).toContain('plugin:acme');
  });

  it('DEBOUNCES: a rule already alerted this window stays quiet but is still recorded', async () => {
    const d = deps({ prior: 4 });
    await surfaceReactionFailure(failure({ error: 'missing_capability: nope', capability: 'c' }), d);
    expect(d.record).toHaveBeenCalledOnce();
    expect(d.alert).not.toHaveBeenCalled();
    expect(d.countRecent.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1',
      ruleId: 'r1',
      windowMinutes: REACTION_FAILURE_ALERT_WINDOW_MINUTES,
      // The row this call just wrote must not count as a PRIOR failure, or the
      // very first failure would debounce itself and nobody would ever be told.
      excludeDedupId: 'reaction:run-1:r1',
    });
  });

  it('still alerts when the durable write fails — an unrecorded failure is worth telling someone about', async () => {
    const d = deps();
    d.record.mockRejectedValueOnce(new Error('pg down'));
    await surfaceReactionFailure(failure({ error: 'missing_capability: nope', capability: 'c' }), d);
    expect(d.alert).toHaveBeenCalledOnce();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('pg down'));
  });

  it('never throws when alerting itself fails', async () => {
    const d = deps();
    d.alert.mockRejectedValueOnce(new Error('inbox down'));
    await expect(
      surfaceReactionFailure(failure({ error: 'missing_capability: nope', capability: 'c' }), d),
    ).resolves.toBeUndefined();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('inbox down'));
  });

  it('with no workspace, logs and writes nothing — a row needs a tenant', async () => {
    const d = deps();
    await surfaceReactionFailure(failure({ error: 'missing_capability: nope', workspaceId: null }), d);
    expect(d.record).not.toHaveBeenCalled();
    expect(d.alert).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('no workspace'));
  });
});
