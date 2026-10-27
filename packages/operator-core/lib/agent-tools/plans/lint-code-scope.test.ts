import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readPlanBySlug: vi.fn(),
  listPlanFiles: vi.fn(),
  firstPartyCallersOffthread: vi.fn(),
  loadHarnessRegistry: vi.fn(),
  getAllPlanItemCoverage: vi.fn(),
  readQueue: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'workspace-test'),
  readCoChange: vi.fn(),
  coChangeOverlap: vi.fn(),
}));

vi.mock('./source', () => ({ readPlanBySlug: h.readPlanBySlug, listPlanFiles: h.listPlanFiles }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: h.activeWorkspaceId }));
vi.mock('../../harness-registry', () => ({ loadHarnessRegistry: h.loadHarnessRegistry }));
vi.mock('../../plan-item-coverage', () => ({ getAllPlanItemCoverage: h.getAllPlanItemCoverage }));
vi.mock('../../code-intelligence/lsp-adapter', () => ({ LSP_VENDOR_DIR: '/vendor/typescript' }));
vi.mock('../locks/su-lock-store', () => ({ getTxPool: vi.fn(), readQueue: h.readQueue }));
vi.mock('../../code-intelligence/change-history', () => ({
  readCoChange: h.readCoChange,
  coChangeOverlap: h.coChangeOverlap,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const original = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...original, getOrgPg: () => ({ sql: async () => [{ n: 0 }] }) };
});
vi.mock('../../code-intelligence/first-party-callers-offthread', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../code-intelligence/first-party-callers-offthread')>();
  return { ...original, firstPartyCallersOffthread: h.firstPartyCallersOffthread };
});

import lintTool from './lint';
import { parsePlan } from './parser';

const planBody = `---
title: Code scope deadline fixture
slug: code-scope-deadline-fixture
status: active
created: 2026-10-25
---

# Code scope deadline fixture

## Now

**State:** checking the graph query
**Next:** finish the focused check

## Phase 1

- **P-001** \`todo\` Update the producer.

## Decisions

### D-001 — Keep the fixture minimal
Date: 2026-10-25
Use one item so this test isolates the worker deadline.
`;

describe('plans:lint codeScope worker deadline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const parsed = parsePlan(planBody);
    h.readPlanBySlug.mockResolvedValue({
      parsed,
      archived: false,
      row: { items: parsed.items, promotePolicy: null },
    });
    h.firstPartyCallersOffthread.mockResolvedValue({ error: 'synthetic worker failure' });
    h.loadHarnessRegistry.mockResolvedValue({ projects: [{ slug: 'fixture', path: '/repo' }] });
    h.getAllPlanItemCoverage.mockResolvedValue(new Map());
    h.readQueue.mockResolvedValue({ active_locks: [] });
    h.readCoChange.mockResolvedValue([]);
    h.coChangeOverlap.mockReturnValue({});
  });

  it('uses the shared bounded worker deadline instead of a shorter local timeout', async () => {
    const { FIRST_PARTY_CALLERS_BUDGET_MS } = await import('../../code-intelligence/first-party-callers-offthread');
    const response = await lintTool.handler(lintTool.args.parse({
      slug: 'code-scope-deadline-fixture',
      harness: 'fixture',
      codeScope: {
        symbol: 'api', file: 'src/producer.ts', paths: ['src'],
        taskPaths: [{ itemId: 'P-001', paths: ['src/producer.ts'] }],
      },
    }), { harnessSlug: 'fixture', workspaceId: 'workspace-test' } as never);

    expect(FIRST_PARTY_CALLERS_BUDGET_MS).toBe(60_000);
    expect(h.firstPartyCallersOffthread).toHaveBeenCalledTimes(1);
    expect(h.firstPartyCallersOffthread.mock.calls[0]?.[1]).toBeUndefined();
    expect(JSON.stringify(response)).toContain('synthetic worker failure');
  });
});
