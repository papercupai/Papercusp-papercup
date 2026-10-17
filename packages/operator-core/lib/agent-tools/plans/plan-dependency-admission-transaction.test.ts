import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { stampForcedPastWaiver } from './forced-past-stamp';
import { withPlanDependencyAdmissionTransaction } from './plan-dependency-admission-transaction';

const plan = (status: string, itemStatus: string, detail = 'item'): string =>
  [
    '---',
    'slug: p1',
    `status: ${status}`,
    '---',
    '',
    '# Plan',
    '',
    '## Phase 1',
    '',
    `- **P-001** \`${itemStatus}\` ${detail}`,
    '',
  ].join('\n');

function sqlFor(content: string | null, status: string | null): Sql {
  return (async (strings: TemplateStringsArray) => {
    const statement = strings.join(' ').replace(/\s+/g, ' ').trim();
    if (statement.includes('SELECT p.content')) {
      return content === null ? [] : [{ content, status, op_status: null }];
    }
    return [];
  }) as unknown as Sql;
}

async function admit(args: {
  beforeContent: string | null;
  beforeStatus: string | null;
  candidateContent: string;
  candidateStatus: string;
}) {
  let wrote = false;
  const result = await withPlanDependencyAdmissionTransaction(
    {
      sql: sqlFor(args.beforeContent, args.beforeStatus),
      workspaceId: 'ws',
      harnessSlug: 'h',
      planSlug: 'p1',
      candidateContent: args.candidateContent,
      candidateStatus: args.candidateStatus,
    },
    async () => {
      wrote = true;
      return 'written';
    },
  );
  return { result, wrote };
}

describe('raw plan write lifecycle admission', () => {
  it('rejects a transition to shipped with unfinished items before the raw writer runs', async () => {
    const { result, wrote } = await admit({
      beforeContent: plan('active', 'todo'),
      beforeStatus: 'active',
      candidateContent: plan('shipped', 'todo'),
      candidateStatus: 'shipped',
    });

    expect(result).toMatchObject({
      admitted: false,
      rejection: { code: 'plan_items_unfinished', itemIds: ['P-001'] },
    });
    expect(wrote).toBe(false);
  });

  it('accepts the same terminal shape only when the candidate carries the explicit unfinished-items waiver', async () => {
    const shipped = plan('shipped', 'todo');
    const waived = stampForcedPastWaiver(
      shipped,
      {
        reason: 'explicitly accept the unfinished item',
        checks: ['plan_items_unfinished'],
        forcedAt: '2026-10-16T00:00:00.000Z',
        forcedBy: { ownerId: 'test-agent', ownerLabel: 'Test agent' },
      },
      new Date('2026-10-16T00:00:00.000Z'),
    );
    expect(waived).not.toBeNull();

    const { result, wrote } = await admit({
      beforeContent: plan('active', 'todo'),
      beforeStatus: 'active',
      candidateContent: waived!,
      candidateStatus: 'shipped',
    });

    expect(result).toMatchObject({ admitted: true, value: 'written' });
    expect(wrote).toBe(true);
  });

  it('rejects reopening a finished child beneath an already terminal parent', async () => {
    const { result, wrote } = await admit({
      beforeContent: plan('shipped', 'done'),
      beforeStatus: 'shipped',
      candidateContent: plan('shipped', 'todo'),
      candidateStatus: 'shipped',
    });

    expect(result).toMatchObject({
      admitted: false,
      rejection: { code: 'terminal_parent_child_mutation', itemIds: ['P-001'] },
    });
    expect(wrote).toBe(false);
  });

  it('allows an unrelated edit to a legacy terminal plan with an unchanged live child', async () => {
    const { result, wrote } = await admit({
      beforeContent: plan('shipped', 'todo', 'old item'),
      beforeStatus: 'shipped',
      candidateContent: `${plan('shipped', 'todo', 'old item')}\n## Background\n\nUpdated note.\n`,
      candidateStatus: 'shipped',
    });

    expect(result).toMatchObject({ admitted: true, value: 'written' });
    expect(wrote).toBe(true);
  });
});
