/**
 * set-content.test.ts — evaluateSetContent guards.
 *
 * EI-1812: a PG-canonical plan keeps its frontmatter in PG COLUMNS, so a raw-body
 * edit (e.g. the body from plans:get(mode:full), handed back) legitimately omits the
 * leading `---…---` block. The would_orphan_frontmatter guard must NOT reject that —
 * the canonical frontmatter survives in the columns and is re-attached for the
 * shrink/legacy/lint guards + the stored body. A body that carries its OWN frontmatter
 * is an intentional rewrite and is left untouched.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { argsSchema, evaluateSetContent } from './set-content';
import { hashPlanContent } from './content-hash';

const FRONTMATTER = `---
title: EI-1812 Test
slug: ei-1812-test
created: 2026-06-20
updated: 2026-06-20
status: draft
owner: test@papercusp.dev
---
`;

const BODY = `
# EI-1812 Test

## Now
Where it stands now. The single next concrete action and who does it.

## Phase 1 — Work
- [ ] P-001 First item

## Decisions
`;

const CURRENT = FRONTMATTER + BODY;

describe('evaluateSetContent — requirement BAR write guard', () => {
  const valid = CURRENT.replace('## Decisions', `## Requirements

**R-3 — Deliberate scope.** The retained live acceptance duties remain explicit.

**R-4 — Immutable publication.** The published bytes match the approved identity.

## Decisions`);
  const manualSections = {
    intent: { request: 'The reviewed publication has explicit retention terms.' },
    acceptance: {
      condition: 'The publication shows its retention terms to the reviewer.',
      falsifier: 'The retention terms are missing.',
      requiredTestLayers: [],
    },
    verification: {
      method: 'Read the published terms and retain the review receipt.',
      check: { kind: 'instrument' as const, instrumentKey: 'none' },
    },
  };
  const manualRequirement = [
    '**R-4 — Immutable publication.**',
    '```requirement',
    JSON.stringify(manualSections),
    '```',
  ].join('\n');
  const validManual = valid.replace(
    '**R-4 — Immutable publication.** The published bytes match the approved identity.',
    manualRequirement,
  );
  const malformed = valid.replace(
    '**R-3 — Deliberate scope.** The retained live acceptance duties remain explicit.',
    '**R-3 — Deliberate scope.**',
  ).replace(
    '**R-4 — Immutable publication.** The published bytes match the approved identity.',
    '**R-4 — Immutable publication.**\n\n```requirement\n{}\n```**',
  );

  it('rejects a newly nested and malformed requirement insertion on the shared raw-write path', async () => {
    const result = await evaluateSetContent(valid, malformed, 'ei-1812-test', undefined);
    expect(result.newBody).toBeNull();
    expect(result.value).toMatchObject({
      ok: false,
      code: 'lint_failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'bar_requirement_parse_failed' }),
      ]),
    });
  });

  it('permits a repair of an already malformed requirements section', async () => {
    const result = await evaluateSetContent(malformed, valid, 'ei-1812-test', undefined);
    expect(result.value.ok).toBe(true);
    expect(result.newBody).toBe(valid);
  });

  it('accepts explicit empty layers only for an explicit manual check on the raw-write path', async () => {
    const proposed = validManual.replace(
      'Where it stands now. The single next concrete action and who does it.',
      'Where it stands now. The next action keeps the recorded manual-review method.',
    );
    const accepted = await evaluateSetContent(validManual, proposed, 'ei-1812-test', undefined);
    expect(accepted.value.ok).toBe(true);
    expect(accepted.newBody).toBe(proposed);

    const automatedEmpty = validManual.replace(
      JSON.stringify(manualSections),
      JSON.stringify({ ...manualSections, verification: { method: manualSections.verification.method } }),
    );
    const refused = await evaluateSetContent(validManual, automatedEmpty, 'ei-1812-test', undefined);
    expect(refused.newBody).toBeNull();
    expect(refused.value).toMatchObject({
      ok: false,
      code: 'lint_failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ code: 'bar_requirement_parse_failed' }),
      ]),
    });
  });
});

describe('plans:set-content expectedVersion args (EI-21189868558705461)', () => {
  const base = { slug: 'ei-1812-test', content: CURRENT };

  it('accepts the decimal string returned by dev:pg_query and normalizes it to a number', () => {
    const parsed = argsSchema.safeParse({ ...base, expectedVersion: '97' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.expectedVersion).toBe(97);
  });

  it('keeps numeric versions working', () => {
    const parsed = argsSchema.safeParse({ ...base, expectedVersion: 97 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.expectedVersion).toBe(97);
  });

  it('rejects non-decimal, negative, fractional, and unsafe versions', () => {
    for (const expectedVersion of ['1.5', '-1', ' 97', '1e2', ''] as unknown[]) {
      expect(argsSchema.safeParse({ ...base, expectedVersion }).success).toBe(false);
    }
    expect(argsSchema.safeParse({ ...base, expectedVersion: -1 }).success).toBe(false);
    expect(argsSchema.safeParse({ ...base, expectedVersion: 1.5 }).success).toBe(false);
    expect(argsSchema.safeParse({ ...base, expectedVersion: '9007199254740992' }).success).toBe(false);
    expect(argsSchema.safeParse({ ...base, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it('publishes expectedVersion as an integer JSON-schema property', () => {
    const json = z.toJSONSchema(argsSchema) as {
      properties?: Record<string, { type?: string; minimum?: number; maximum?: number }>;
    };
    expect(json.properties?.expectedVersion?.type).toBe('integer');
    expect(json.properties?.expectedVersion?.minimum).toBe(0);
    expect(json.properties?.expectedVersion?.maximum).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts the explicit decision-deletion override', () => {
    expect(argsSchema.safeParse({ ...base, allowDecisionDrop: true }).success).toBe(true);
  });
});

describe('evaluateSetContent — decision deletion guard', () => {
  const itemRows = Array.from({ length: 6 }, (_, index) =>
    `- **P-${String(index + 1).padStart(3, '0')}** \`todo\` Existing item ${index + 1}`,
  ).join('\n');
  const decisionRows = Array.from({ length: 4 }, (_, index) =>
    `### D-${String(index + 1).padStart(3, '0')} — Decision ${index + 1}\nThe recorded decision remains authoritative.`,
  ).join('\n\n');
  const current = CURRENT
    .replace('- [ ] P-001 First item', itemRows)
    .replace('## Decisions', `## Decisions\n\n${decisionRows}`);
  const proposed = current.replace(/\n## Decisions[\s\S]*$/, '\n');

  it('refuses to erase existing decision IDs even when the broad structural threshold would pass', async () => {
    const result = await evaluateSetContent(current, proposed, 'ei-1812-test', undefined);

    expect(result.newBody).toBeNull();
    expect(result.value).toMatchObject({
      ok: false,
      code: 'decisions_would_be_dropped',
      droppedDecisionIds: ['D-001', 'D-002', 'D-003', 'D-004'],
    });
  });

  it('permits an intentional decision removal only with the dedicated override', async () => {
    const result = await evaluateSetContent(current, proposed, 'ei-1812-test', undefined, {
      allowDecisionDrop: true,
    });

    expect(result.value.ok).toBe(true);
    expect(result.newBody).toBe(proposed);
  });
});

describe('evaluateSetContent — EI-1812 frontmatter re-attach', () => {
  it('a PG-canonical body that OMITS the leading frontmatter re-attaches it instead of rejecting would_orphan_frontmatter', async () => {
    // The filer's repro: a full body WITHOUT a leading ---…--- block.
    const proposed = `# EI-1812 Test

## Now
Updated state. The next concrete action, restated.

## Phase 1 — Work
- [ ] P-001 First item

## Decisions
`;
    const { newBody, value } = await evaluateSetContent(CURRENT, proposed, 'ei-1812-test', undefined, {
      allowShrink: true,
    });
    // The specific EI-1812 regression: a frontmatter-less PG-canonical body must NOT be
    // rejected as orphaning (the frontmatter survives in the columns + is re-attached).
    expect(value).not.toMatchObject({ code: 'would_orphan_frontmatter' });
    expect(value.ok).toBe(true);
    // The stored body carries the preserved frontmatter (re-attached).
    expect(newBody).not.toBeNull();
    expect(newBody!.startsWith('---')).toBe(true);
    expect(newBody!).toContain('title: EI-1812 Test');
    expect(newBody!).toContain('Updated state.');
  });

  it('a body that carries its OWN frontmatter is left untouched (no double-attach)', async () => {
    const proposedWithFm = CURRENT.replace('Where it stands now.', 'Edited in place.');
    const { newBody, value } = await evaluateSetContent(CURRENT, proposedWithFm, 'ei-1812-test', undefined, {
      allowShrink: true,
    });
    expect(value.ok).toBe(true);
    expect(newBody).toBe(proposedWithFm); // written as-is, frontmatter not doubled
    expect((newBody!.match(/^---\r?$/gm) ?? []).length).toBe(2); // exactly one block (open+close)
  });
});

describe('evaluateSetContent — plan lifecycle status writer guard (WI-10002607)', () => {
  it('refuses a raw content transition to shipped and routes it to plans:set-plan-status', async () => {
    const proposed = CURRENT.replace('status: draft', 'status: shipped');
    const { newBody, value } = await evaluateSetContent(CURRENT, proposed, 'ei-1812-test', undefined, {
      allowShrink: true,
    });

    expect(newBody).toBeNull();
    expect(value).toMatchObject({
      ok: false,
      code: 'plan_status_change_requires_lifecycle_writer',
      currentStatus: 'draft',
      proposedStatus: 'shipped',
      writer: 'plans:set-plan-status',
    });
  });

  it('refuses a stale markdown status that disagrees with the locked canonical plan row', async () => {
    const staleCurrent = CURRENT.replace('status: draft', 'status: ready');
    const proposed = staleCurrent.replace(
      'Where it stands now.',
      'The current state and next action remain recorded.',
    );
    const { newBody, value } = await evaluateSetContent(staleCurrent, proposed, 'ei-1812-test', undefined, {
      expectedVersion: 22,
      meta: {
        version: 22,
        contentHash: hashPlanContent(staleCurrent),
        planStatus: 'active',
      },
      allowShrink: true,
    });

    expect(newBody).toBeNull();
    expect(value).toMatchObject({
      ok: false,
      code: 'plan_status_change_requires_lifecycle_writer',
      currentStatus: 'active',
      proposedStatus: 'ready',
      writer: 'plans:set-plan-status',
      message: expect.stringContaining('disagrees with the current markdown status'),
    });
  });

  it('uses markdown status when the nullable derived status column is NULL', async () => {
    const current = CURRENT.replace('status: draft', 'status: active');
    const proposed = current.replace(
      'Where it stands now.',
      'The current state and next action remain recorded.',
    );
    const { newBody, value } = await evaluateSetContent(current, proposed, 'ei-1812-test', undefined, {
      expectedVersion: 22,
      meta: {
        version: 22,
        contentHash: hashPlanContent(current),
        planStatus: null,
      },
      allowShrink: true,
    });

    expect(newBody).toBe(proposed);
    expect(value).toMatchObject({ ok: true });
  });

  it('routes legacy conversion through set-frontmatter', async () => {
    const legacy = CURRENT.replace(/^---\n[\s\S]*?\n---\n/, '');
    const { newBody, value } = await evaluateSetContent(legacy, CURRENT, 'ei-1812-test', undefined, {
      allowShrink: true,
    });

    expect(newBody).toBeNull();
    expect(value).toMatchObject({
      ok: false,
      code: 'plan_status_change_requires_lifecycle_writer',
      writer: 'plans:set-frontmatter',
    });
  });

  it('also blocks the chunked whole-document writer from changing lifecycle status', async () => {
    const proposed = CURRENT.replace('status: draft', 'status: shipped');
    const { newBody, value } = await evaluateSetContent(CURRENT, proposed, 'ei-1812-test', undefined, {
      allowShrink: true,
      wholeDocumentRewrite: true,
    });

    expect(newBody).toBeNull();
    expect(value).toMatchObject({
      ok: false,
      code: 'plan_status_change_requires_lifecycle_writer',
      writer: 'plans:set-plan-status',
    });
  });
});

describe('evaluateSetContent — no terminal Now stamp (derived-status P-006)', () => {
  // P-006 retired the WI-38303 stamp: a rewrite of a shipped plan is stored
  // exactly as the caller authored it; nothing is prepended to its Now.
  it('stores a prose rewrite of a shipped plan verbatim', async () => {
    const terminal = CURRENT.replace('status: draft', 'status: shipped');
    const proposed = terminal.replace('Where it stands now.', 'The shipped state remains recorded.');
    const { newBody, value } = await evaluateSetContent(terminal, proposed, 'ei-1812-test', undefined, {
      allowShrink: true,
    });

    expect(value.ok).toBe(true);
    if (!value.ok) return;
    expect(value).not.toHaveProperty('nowStamped');
    expect(newBody).toBe(proposed);
    expect(newBody).not.toContain('PLAN CLOSED');
  });
});

describe('evaluateSetContent — plan-drain transition detection (EI-24932476076513699)', () => {
  const readyWithLiveItem = FRONTMATTER
    .replace('status: draft', 'status: ready')
    .concat(BODY.replace('- [ ] P-001 First item', '- **P-001** `todo` First item'));

  it('signals when a content rewrite drains the last live item', async () => {
    const drained = readyWithLiveItem.replace('`todo`', '`done`');
    const result = await evaluateSetContent(readyWithLiveItem, drained, 'ei-1812-test', undefined, {
      allowShrink: true,
      wholeDocumentRewrite: true,
    });

    expect(result.value).toMatchObject({ ok: true, planDrainTransitionChanged: true });
  });

  it('signals when a content rewrite reopens an awaiting plan', async () => {
    const awaiting = readyWithLiveItem
      .replace('status: ready', 'status: awaiting-acceptance')
      .replace('`todo`', '`done`');
    const reopened = awaiting.replace('`done`', '`blocked`');
    const result = await evaluateSetContent(awaiting, reopened, 'ei-1812-test', hashPlanContent(awaiting), {
      allowShrink: true,
      wholeDocumentRewrite: true,
    });

    expect(result.value).toMatchObject({ ok: true, planDrainTransitionChanged: true });
  });

  it('does not signal live-to-live item changes or prose edits', async () => {
    const liveToLive = readyWithLiveItem.replace('`todo`', '`wip`');
    const result = await evaluateSetContent(readyWithLiveItem, liveToLive, 'ei-1812-test', undefined, {
      allowShrink: true,
      wholeDocumentRewrite: true,
    });
    expect(result.value.ok).toBe(true);
    if (result.value.ok) expect(result.value.planDrainTransitionChanged).toBeUndefined();

    const prose = readyWithLiveItem.replace('Where it stands now.', 'A revised status note.');
    const proseResult = await evaluateSetContent(readyWithLiveItem, prose, 'ei-1812-test', undefined, {
      allowShrink: true,
      wholeDocumentRewrite: true,
    });
    expect(proseResult.value.ok).toBe(true);
    if (proseResult.value.ok) expect(proseResult.value.planDrainTransitionChanged).toBeUndefined();
  });
});

describe('evaluateSetContent — terminal parent child mutations', () => {
  const tick = String.fromCharCode(96);
  const terminalParent = FRONTMATTER
    .replace('status: draft', 'status: shipped')
    .concat(BODY.replace('- [ ] P-001 First item', '- **P-001** ' + tick + 'done' + tick + ' First item'));
  const evaluate = (current: string, proposed: string) =>
    evaluateSetContent(current, proposed, 'ei-1812-test', hashPlanContent(current), {
      allowShrink: true,
      wholeDocumentRewrite: true,
    });

  it('rejects a new nonterminal child and points to the explicit parent lifecycle writer', async () => {
    const nl = String.fromCharCode(10);
    const proposed = terminalParent.replace(
      '## Decisions',
      '- **P-002** ' + tick + 'todo' + tick + ' New live work' + nl + nl + '## Decisions',
    );
    const result = await evaluate(terminalParent, proposed);

    expect(result.newBody).toBeNull();
    expect(result.value).toMatchObject({
      ok: false,
      code: 'terminal_parent_child_mutation',
      parentStatus: 'shipped',
      changes: [{ itemId: 'P-002', kind: 'added', from: null, to: 'todo' }],
      message: expect.stringContaining('plans:set-plan-status'),
    });
  });

  it('rejects reopening a finished child even with a fresh CAS baseline', async () => {
    const proposed = terminalParent.replace(
      tick + 'done' + tick + ' First item',
      tick + 'wip' + tick + ' First item',
    );
    const result = await evaluate(terminalParent, proposed);

    expect(result.newBody).toBeNull();
    expect(result.value).toMatchObject({
      ok: false,
      code: 'terminal_parent_child_mutation',
      parentStatus: 'shipped',
      changes: [{ itemId: 'P-001', kind: 'reopened', from: 'done', to: 'wip' }],
    });
  });

  it('allows terminal-child reclassification and updates to an already-live historical child', async () => {
    const terminalReclassification = terminalParent.replace(
      tick + 'done' + tick + ' First item',
      tick + 'dropped' + tick + ' First item',
    );
    const terminalResult = await evaluate(terminalParent, terminalReclassification);
    expect(terminalResult.value.ok).toBe(true);

    const nl = String.fromCharCode(10);
    const parentWithExistingLiveChild = terminalParent.replace(
      '## Decisions',
      '- **P-002** ' + tick + 'todo' + tick + ' Existing live child' + nl + nl + '## Decisions',
    );
    const liveToLive = parentWithExistingLiveChild.replace(
      tick + 'todo' + tick + ' Existing live child',
      tick + 'wip' + tick + ' Existing live child',
    );
    const liveResult = await evaluate(parentWithExistingLiveChild, liveToLive);
    expect(liveResult.value.ok).toBe(true);
  });

  it('allows appending a terminal historical row', async () => {
    const nl = String.fromCharCode(10);
    const proposed = terminalParent.replace(
      '## Decisions',
      '- **P-002** ' + tick + 'done' + tick + ' Historical completion' + nl + nl + '## Decisions',
    );
    const result = await evaluate(terminalParent, proposed);
    expect(result.value.ok).toBe(true);
  });
});
