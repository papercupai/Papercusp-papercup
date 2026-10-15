/**
 * plans:new parse admission (EI-22005620513894909).
 *
 * A body with item-looking but non-canonical lines must be rejected before
 * withPlanLock. Otherwise plans:new reports success while plans:start later
 * discovers that zero items were parsed and promoted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WithPlanLockResult } from './with-plan-lock';

vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: vi.fn(() => 'papercusp') }));
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: string | undefined, ctx: unknown) => ctx,
}));
vi.mock('./source', () => ({ listPlanIndexRows: vi.fn(async () => []) }));
vi.mock('./revisions', () => ({
  planRevisionCapture: vi.fn(() => ({ recorded: { current: null }, afterWrite: vi.fn() })),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../../harness/usage-emitters', () => ({ emitPlanAuthored: vi.fn(async () => {}) }));
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: vi.fn(async () => null),
  stampPlanGoalProvenance: vi.fn(async () => null),
}));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => {
    throw new Error('no transport identity in unit test');
  }),
}));

const appliedResult = (): WithPlanLockResult<{ ok: true; slug: string }> => ({
  kind: 'applied',
  value: { ok: true, slug: 'parse-admission-2026-09-05' },
  filePath: 'x',
  version: 1,
  scope: { workspaceId: 'default', harnessSlug: 'papercusp' },
});

vi.mock('./with-plan-lock', () => ({
  withPlanLock: vi.fn(async () => appliedResult()),
}));

const { withPlanLock } = await import('./with-plan-lock');
const withPlanLockM = vi.mocked(withPlanLock);
const tool = (await import('./new')).default;

type Out = { content: { text: string }[]; isError?: boolean };
const call = (content: string, status?: string) =>
  tool.handler(
    {
      harness: 'papercusp',
      slug: 'parse-admission',
      title: 'Parse admission',
      force: true,
      ...(status ? { status } : {}),
      content,
    } as never,
    { metadata: vi.fn() } as never,
  ) as Promise<Out>;

beforeEach(() => {
  vi.clearAllMocks();
  withPlanLockM.mockResolvedValue(appliedResult());
});

describe('plans:new parse admission (EI-22005620513894909)', () => {
  it('rejects malformed item-looking lines before persistence', async () => {
    const out = await call('## Phase 1\n\n- P-001 todo this will not parse\n');

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();

    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      error: 'invalid_plan_content',
      reason: 'unparsed_item_lines',
      itemsParsed: 0,
      unparsedItemLines: 1,
    });
    expect(payload.parseFeedback).toMatchObject({
      itemsParsed: 0,
      unparsedItemLines: 1,
    });
    expect(payload.hint).toContain('plans:set-content');
  });

  it('still writes a canonical item body and returns parse feedback', async () => {
    const out = await call('## Phase 1\n\n- **P-001** `todo` this parses\n');

    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      ok: true,
      itemsParsed: 1,
      items: [{ id: 'P-001', status: 'todo', text: 'this parses' }],
    });
    expect(payload.unparsedItemLines).toBeUndefined();
  });

  it('accepts a ready plan with an already-terminal item graph for post-create reconciliation', async () => {
    const out = await call('## Phase 1\n\n- **P-001** `done` already complete\n', 'ready');

    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      ok: true,
      itemsParsed: 1,
      items: [{ id: 'P-001', status: 'done', text: 'already complete' }],
    });
  });

  it('refuses ordinary Requirements prose without an R-N BAR before persistence', async () => {
    const out = await call([
      '## Requirements',
      '',
      '- Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      'The exporter reads the customer table.',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      error: 'invalid_plan_content',
      reason: 'acceptance_bar_authoring',
    });
    expect(payload.acceptanceBar.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_requirement_parse_failed' })]),
    );
  });

  it('refuses Requirements without the activation BAR map before persistence', async () => {
    const out = await call([
      '## Requirements',
      '',
      '**R-1 — Export data.** Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      'The exporter reads the customer table.',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload).toMatchObject({
      error: 'invalid_plan_content',
      reason: 'acceptance_bar_authoring',
      acceptanceBar: {
        requiredMapHeading: '### Bar-to-work map for this plan',
        requiredColumns: ['bar', 'implementing plan items', 'evidence plane'],
        allowedEvidencePlanes: ['tree', 'deployed', 'live'],
      },
    });
    expect(payload.acceptanceBar.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'bar_mapping_missing' })]),
    );
  });

  it('accepts a complete Requirements + BAR map and persists once', async () => {
    const out = await call([
      '## Requirements',
      '',
      '**R-1 — Export data.** Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      '### Bar-to-work map for this plan',
      '',
      '| bar | implementing plan items | evidence plane |',
      '|---|---|---|',
      '| R-1 | P-001 | tree |',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBeUndefined();
    expect(withPlanLockM).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out.content[0]!.text)).toMatchObject({ ok: true, itemsParsed: 1 });
  });

  it('explains that a title-bearing bar cell must use a bare R-N key', async () => {
    const out = await call([
      '## Requirements',
      '',
      '**R-1 — Export data.** Every matching customer is exported exactly once.',
      '',
      '## Design',
      '',
      '### Bar-to-work map for this plan',
      '',
      '| bar | implementing plan items | evidence plane |',
      '|---|---|---|',
      '| R-1 Export data | P-001 | tree |',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` implement the exporter',
      '',
    ].join('\n'));

    expect(out.isError).toBe(true);
    expect(withPlanLockM).not.toHaveBeenCalled();
    const payload = JSON.parse(out.content[0]!.text) as Record<string, any>;
    expect(payload.acceptanceBar.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bar_mapping_invalid', barKey: 'R-1', detail: expect.stringContaining('bare R-1 key') }),
    ]));
    expect(payload.acceptanceBar.hint).toContain('| R-1 | P-001 | tree |');
  });

  it('documents the plans:start spec-triad prerequisite in guidance', () => {
    const guidance = (tool as { guidance: { when: string; chaining: string } }).guidance;
    expect(guidance.when).toContain('Requirements');
    expect(guidance.when).toContain('Design');
    expect(guidance.when).toContain('Bar-to-work map for this plan');
    expect(guidance.chaining).toContain('Bar-to-work map for this plan');
    expect(guidance.chaining).toContain('P-NNN');
    expect(guidance.chaining).toContain('plans:start');
  });
});
