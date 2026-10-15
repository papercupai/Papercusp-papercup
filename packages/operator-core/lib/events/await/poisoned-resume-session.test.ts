import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  quarantineRepeatedClaudeToolReferenceFailures,
  quarantineRepeatedCodexContextOverflow,
  type PoisonedResumeDeps,
} from './poisoned-resume-session';
import type { ResumeTurnContext } from './resume-turn-outcome';

const context = (transcriptPath: string): ResumeTurnContext => ({
  advSessionId: 77,
  ownerId: 'su-poisoned',
  sessionId: 'native-77',
  startedAt: '2026-09-24T10:00:00.123Z',
  workspaceId: 'papercusp-workspace',
  agent: 'claude',
  transcriptPath,
});

// The real record shape Claude writes for a provider rejection (measured on live
// transcripts, WI-10003466): a SYNTHETIC assistant entry, not model prose.
const failure = (tool = 'mcp__papercusp-su__plans_audit') => JSON.stringify({
  type: 'assistant',
  error: 'unknown',
  isApiErrorMessage: true,
  apiErrorStatus: 400,
  message: {
    role: 'assistant',
    model: '<synthetic>',
    content: [{ type: 'text', text: `API Error: 400 Tool reference '${tool}' not found in available tools` }],
  },
});

afterEach(() => vi.restoreAllMocks());

describe('quarantineRepeatedClaudeToolReferenceFailures', () => {
  it('marks the exact adv-session incarnation ended after three trailing failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poisoned-resume-'));
    try {
      const transcriptPath = join(root, 'session.jsonl');
      writeFileSync(transcriptPath, [failure(), failure(), failure()].join('\n'));
      const writes: unknown[][] = [];
      const deps: PoisonedResumeDeps = {
        markBrief: vi.fn(async (...args) => { writes.push(args); return true; }),
        markEnded: vi.fn(async (...args) => { writes.push(args); return true; }),
        now: () => new Date('2026-09-24T10:05:00.000Z'),
      };

      const result = await quarantineRepeatedClaudeToolReferenceFailures(
        context(transcriptPath),
        `API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools`,
        deps,
      );

      expect(result).toMatchObject({ poisoned: true, turns: 3, ended: true });
      expect(deps.markBrief).toHaveBeenCalledWith('su-poisoned', 'papercusp-workspace', expect.objectContaining({
        advSessionId: 77,
        startedAt: '2026-09-24T10:00:00.123Z',
        by: 'resume-turn-detector',
      }));
      expect(deps.markEnded).toHaveBeenCalledWith(77, null, 'reconciler', {
        observedAt: new Date('2026-09-24T10:05:00.000Z'),
      });
      expect(writes[0]?.[0]).toBe('su-poisoned'); // durable wake gate precedes the end write
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not quarantine fewer than three failures or a streak reset by normal assistant work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poisoned-resume-'));
    try {
      const transcriptPath = join(root, 'session.jsonl');
      writeFileSync(transcriptPath, [
        failure(),
        failure(),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered.' }] } }),
        failure(),
      ].join('\n'));
      const deps: PoisonedResumeDeps = {
        markBrief: vi.fn(async () => true),
        markEnded: vi.fn(async () => true),
      };

      await expect(quarantineRepeatedClaudeToolReferenceFailures(
        context(transcriptPath),
        failure(),
        deps,
      )).resolves.toMatchObject({ poisoned: false, turns: 1 });
      expect(deps.markBrief).not.toHaveBeenCalled();
      expect(deps.markEnded).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the durable poison marker cannot be written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'poisoned-resume-'));
    try {
      const transcriptPath = join(root, 'session.jsonl');
      writeFileSync(transcriptPath, [failure(), failure(), failure()].join('\n'));
      const deps: PoisonedResumeDeps = {
        markBrief: vi.fn(async () => false),
        markEnded: vi.fn(async () => true),
      };
      await expect(quarantineRepeatedClaudeToolReferenceFailures(
        context(transcriptPath),
        failure(),
        deps,
      )).resolves.toMatchObject({ poisoned: false, reason: expect.stringContaining('marker write failed') });
      expect(deps.markEnded).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('quarantineRepeatedCodexContextOverflow (WI-6554700010008894)', () => {
  // Real captured over-window rollout tail: three refused turns, one context-window
  // overflow, one remote-compaction usage-limit failure.
  const captured = readFileSync(join(__dirname, '__fixtures__', 'codex-rollout-over-window.tail.jsonl'), 'utf8');
  const capturedLines = captured.trim().split('\n');
  const overflowTurn = capturedLines.slice(15, 19).join('\n');
  const overflowError = capturedLines[18];
  const codexContext = (transcriptPath: string | null): ResumeTurnContext => ({
    advSessionId: 33944,
    ownerId: 'su-overflowed',
    sessionId: '01a10080-4435-7822-8b4f-d82fc7e81227',
    startedAt: '2026-10-12T11:26:21.000Z',
    workspaceId: 'papercusp-workspace',
    agent: 'codex',
    transcriptPath,
  });
  const recordingDeps = (): PoisonedResumeDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      markBrief: vi.fn(async () => { calls.push('brief'); return true; }),
      markEnded: vi.fn(async () => { calls.push('ended'); return true; }),
      now: () => new Date('2026-10-12T11:40:00.000Z'),
    };
  };

  it('ends the incarnation once the rollout records two consecutive overflowed turns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-overflow-'));
    try {
      const rollout = join(root, 'rollout.jsonl');
      writeFileSync(rollout, `${captured.trim()}\n${overflowTurn}\n`);
      const deps = recordingDeps();
      const result = await quarantineRepeatedCodexContextOverflow(codexContext(rollout), overflowError, deps);
      expect(result).toMatchObject({ poisoned: true, turns: 2, ended: true });
      expect(deps.markBrief).toHaveBeenCalledWith('su-overflowed', 'papercusp-workspace', expect.objectContaining({
        advSessionId: 33944,
        startedAt: '2026-10-12T11:26:21.000Z',
        by: 'resume-turn-detector',
        reason: expect.stringContaining('exceeded the model context window of 828400 tokens'),
      }));
      expect(deps.markEnded).toHaveBeenCalledWith(33944, null, 'reconciler', {
        observedAt: new Date('2026-10-12T11:40:00.000Z'),
      });
      expect(deps.calls).toEqual(['brief', 'ended']); // durable wake gate precedes the end write
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves the thread retryable after a single overflow (the captured state)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-overflow-'));
    try {
      const rollout = join(root, 'rollout.jsonl');
      writeFileSync(rollout, captured);
      const deps = recordingDeps();
      await expect(quarantineRepeatedCodexContextOverflow(codexContext(rollout), overflowError, deps))
        .resolves.toEqual({ poisoned: false, turns: 1 });
      expect(deps.markBrief).not.toHaveBeenCalled();
      expect(deps.markEnded).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a non-codex context or a missing rollout without touching durable state', async () => {
    const deps = recordingDeps();
    await expect(quarantineRepeatedCodexContextOverflow({ ...codexContext('/x'), agent: 'claude' }, overflowError, deps))
      .resolves.toMatchObject({ poisoned: false, reason: expect.stringContaining('unavailable') });
    await expect(quarantineRepeatedCodexContextOverflow(codexContext(null), overflowError, deps))
      .resolves.toMatchObject({ poisoned: false, reason: expect.stringContaining('unavailable') });
    await expect(quarantineRepeatedCodexContextOverflow(codexContext('/nonexistent/rollout.jsonl'), overflowError, deps))
      .resolves.toMatchObject({ poisoned: false, reason: 'Codex rollout could not be read' });
    expect(deps.markBrief).not.toHaveBeenCalled();
    expect(deps.markEnded).not.toHaveBeenCalled();
  });
});
