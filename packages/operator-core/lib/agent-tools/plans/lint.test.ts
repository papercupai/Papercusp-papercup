import { describe, it, expect } from 'vitest';
import { itemIndexDivergence, lintParsed, summarizeLintReports, type PlanLintReport } from './lint';
import { evaluateSetContent } from './set-content';
import { parsePlan } from './parser';

/**
 * P-002 (promote-spawn-child-harness): `plans:lint` emits a soft WARNING (never
 * an error) when a `## Promote` wave declares `spawn_child`, and a sharper
 * warning when the child's target tree is ambiguous (no repo + no template).
 *
 * `lintParsed` also runs a PG-backed `## Promoted`-block check, but it fails
 * open to 0 when PG is unreachable, so these stay pure unit tests (no DB).
 */

const planWith = (promoteSection: string) =>
  `---\n` +
  `title: T\n` +
  `slug: spawn-lint-test\n` +
  `status: active\n` +
  `created: 2026-06-05\n` +
  `---\n\n` +
  `# T\n\n` +
  `## Now\n\n**State:** x\n\n**Next:** y\n\n` +
  `## Phase 1\n\n- **P-001** \`todo\` do a thing\n\n` +
  `${promoteSection}\n\n` +
  `## Decisions\n\n### D-001 — a decision\nBody.\n`;

const promoteYaml = (wavesBody: string, target = 'target_harness: restart\n') =>
  '## Promote\n\n```yaml\n' + target + 'waves:\n' + wavesBody + '```';

const lint = async (raw: string) => {
  const parsed = parsePlan(raw);
  return lintParsed(parsed, 'spawn-lint-test', false);
};

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('plans:lint — misplaced canonical item lines', () => {
  const misplaced = (placement: 'before-title' | 'now' | 'decisions') => {
    const item = '- **P-010** `todo` prerequisite';
    const base = planWith('').replace('do a thing', 'do a thing blocked-by: P-010');
    if (placement === 'before-title') return base.replace('# T\n', `${item}\n\n# T\n`);
    if (placement === 'now') return base.replace('**Next:** y\n', `**Next:** y\n\n${item}\n`);
    return base.replace('## Decisions\n', `## Decisions\n\n${item}\n`);
  };

  it.each(['before-title', 'now', 'decisions'] as const)('rejects a canonical item in %s', async (placement) => {
    const raw = misplaced(placement);
    expect(parsePlan(raw).items.map((item) => item.id)).toEqual(['P-001']);
    const report = await lint(raw);
    expect(codes(report.errors)).toContain('unparsed_canonical_item');
    expect(report.errors.find((finding) => finding.code === 'unparsed_canonical_item')?.message).toContain('P-010');
  });

  it('rejects a raw plan rewrite that introduces a hidden item', async () => {
    const current = planWith('');
    const proposed = current.replace('## Decisions\n', '## Decisions\n\n- **P-010** `todo` hidden item\n');
    const result = await evaluateSetContent(current, proposed, 'spawn-lint-test', undefined);
    expect(result.newBody).toBeNull();
    expect(result.value).toMatchObject({ ok: false, code: 'lint_failed' });
    if (!result.value.ok && result.value.code === 'lint_failed') {
      expect(codes(result.value.errors)).toContain('unparsed_canonical_item');
    }
  });

  it('reports a stored index that contains items absent from the parsed body', () => {
    const parsed = parsePlan(planWith(''));
    expect(itemIndexDivergence([{ id: 'P-001' }, { id: 'P-010' }], parsed)).toBe('2 indexed item(s), 1 parsed item(s)');
    expect(itemIndexDivergence([{ id: 'P-001' }], parsed)).toBeNull();
  });
});

describe('plans:lint — spawn_child waves (P-002)', () => {
  it('warns (never errors) on a spawn_child wave, sharper warning when no repo/template', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: tier1\n' +
          '    spawn_child:\n' +
          '      slug: my-child\n' +
          '    features:\n' +
          '      - title: "Child work"\n',
      ),
    );
    const report = await lint(raw);

    // Both spawn_child findings are WARNINGS — nothing escalates to error.
    expect(codes(report.warnings)).toContain('spawn_child_wave');
    expect(codes(report.warnings)).toContain('spawn_child_ambiguous_target');
    expect(codes(report.errors).filter((c) => c.startsWith('spawn_child'))).toEqual([]);

    const w = report.warnings.find((f) => f.code === 'spawn_child_wave')!;
    expect(w.message).toMatch(/my-child/);
    expect(w.message).toMatch(/D-001/);
  });

  it('a spawn_child wave WITH a template → boundary warning but NOT the ambiguous-target one', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: tier1\n' +
          '    spawn_child:\n' +
          '      slug: my-child\n' +
          '      template: coding\n' +
          '    features:\n' +
          '      - title: "Child work"\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings)).toContain('spawn_child_wave');
    expect(codes(report.warnings)).not.toContain('spawn_child_ambiguous_target');
  });

  it('a spawn_child wave WITH a repo → boundary warning but NOT the ambiguous-target one', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: tier1\n' +
          '    spawn_child:\n' +
          '      slug: my-child\n' +
          '      repo: https://github.com/acme/widget\n' +
          '    features:\n' +
          '      - title: "Child work"\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings)).toContain('spawn_child_wave');
    expect(codes(report.warnings)).not.toContain('spawn_child_ambiguous_target');
  });

  it('one warning per spawn_child wave', async () => {
    const raw = planWith(
      promoteYaml(
        '  - id: a\n' +
          '    spawn_child: {slug: child-a, template: coding}\n' +
          '    features: [{title: x}]\n' +
          '  - id: b\n' +
          '    spawn_child: {slug: child-b, template: coding}\n' +
          '    features: [{title: y}]\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings).filter((c) => c === 'spawn_child_wave')).toHaveLength(2);
  });

  it('a plain promote wave (no spawn_child) → no spawn_child findings', async () => {
    const raw = planWith(
      promoteYaml('  - id: tier1\n    features:\n      - title: "Ordinary"\n'),
    );
    const report = await lint(raw);
    expect(codes(report.warnings).some((c) => c.startsWith('spawn_child'))).toBe(false);
    expect(codes(report.errors).some((c) => c.startsWith('spawn_child'))).toBe(false);
  });

  it('a plan with NO ## Promote section → no spawn_child findings, no crash', async () => {
    const raw = planWith('## Background\n\nnothing to promote');
    const report = await lint(raw);
    expect(codes(report.warnings).some((c) => c.startsWith('spawn_child'))).toBe(false);
  });

  it('a MALFORMED promote block (null policy) → no spawn_child findings, no crash', async () => {
    // duplicate spawn_child slug → policy fails to parse → null → lint stays quiet
    const raw = planWith(
      promoteYaml(
        '  - id: a\n    spawn_child: {slug: dupe}\n    features: [{title: x}]\n' +
          '  - id: b\n    spawn_child: {slug: dupe}\n    features: [{title: y}]\n',
      ),
    );
    const report = await lint(raw);
    expect(codes(report.warnings).some((c) => c.startsWith('spawn_child'))).toBe(false);
  });
});

/**
 * EI-154: a plan that records its own supersession (via `superseded-by:`
 * frontmatter or a "superseded by [[X]]" Now note) but whose status is not
 * `superseded` is flagged — the fleet-federation-reanchor trap where a stale
 * `ready` plan's rejected design misleads the next agent.
 */
describe('plans:lint — superseded_status_mismatch (EI-154)', () => {
  const planDoc = (opts: { status?: string; supersededBy?: string; nowState?: string }) => {
    const fm = [
      'title: T',
      'slug: supersede-lint-test',
      `status: ${opts.status ?? 'active'}`,
      'created: 2026-06-05',
      ...(opts.supersededBy ? [`superseded-by: ${opts.supersededBy}`] : []),
    ].join('\n');
    return (
      `---\n${fm}\n---\n\n` +
      `# T\n\n` +
      `## Now\n\n**State:** ${opts.nowState ?? 'building'}\n\n**Next:** y\n\n` +
      `## Phase 1\n\n- **P-001** \`todo\` do a thing\n\n` +
      `## Decisions\n\n### D-001 — a decision\nBody.\n`
    );
  };
  const lintDoc = async (raw: string) => lintParsed(parsePlan(raw), 'supersede-lint-test', false);
  const has = (r: { warnings: { code: string }[] }) =>
    codes(r.warnings).includes('superseded_status_mismatch');

  it('warns when the Now block says "**SUPERSEDED** by [[X]]" but status is active', async () => {
    const r = await lintDoc(
      planDoc({ status: 'active', nowState: 'This is **SUPERSEDED** by [[newer-plan-2026-06-08]] — see D-009.' }),
    );
    expect(has(r)).toBe(true);
    expect(codes(r.errors)).not.toContain('superseded_status_mismatch'); // warning, never error
    const w = r.warnings.find((f) => f.code === 'superseded_status_mismatch')!;
    expect(w.message).toMatch(/newer-plan-2026-06-08/);
    expect(w.message).toMatch(/'active'/);
  });

  it('warns when `superseded-by:` frontmatter is set but status is ready', async () => {
    const r = await lintDoc(
      planDoc({ status: 'ready', supersededBy: 'newer-plan-2026-06-08', nowState: 'still going' }),
    );
    expect(has(r)).toBe(true);
    expect(r.warnings.find((f) => f.code === 'superseded_status_mismatch')!.message).toMatch(/frontmatter/);
  });

  it('does NOT warn when status IS superseded (the correct, consistent state)', async () => {
    const r = await lintDoc(
      planDoc({ status: 'superseded', nowState: '**SUPERSEDED** by [[newer-plan-2026-06-08]].' }),
    );
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on the SUPERSEDING plan (active voice "supersedes [[X]]")', async () => {
    const r = await lintDoc(
      planDoc({ status: 'active', nowState: 'This plan supersedes [[older-plan-2026-01-01]] and is canonical.' }),
    );
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on a narrative "superseded by" with no wikilink (false-positive guard)', async () => {
    const r = await lintDoc(
      planDoc({ status: 'active', nowState: 'The old approach was superseded by a better one we built here.' }),
    );
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on an ordinary active plan', async () => {
    const r = await lintDoc(planDoc({ status: 'active', nowState: 'building phase 2' }));
    expect(has(r)).toBe(false);
  });
});

describe('plans:lint — completion_status_mismatch (EI-205)', () => {
  const planDoc = (opts: {
    status: string;
    items: Array<[string, string]>;
    nowState?: string;
  }) => {
    const items = opts.items.map(([id, st]) => `- **${id}** \`${st}\` do ${id}`).join('\n');
    return (
      `---\ntitle: T\nslug: completion-lint-test\nstatus: ${opts.status}\ncreated: 2026-06-05\n---\n\n` +
      `# T\n\n## Now\n\n**State:** ${opts.nowState ?? 'building'}\n\n**Next:** y\n\n` +
      `## Phase 1\n\n${items}\n\n## Decisions\n\n### D-001 — a decision\nBody.\n`
    );
  };
  const lintDoc = async (raw: string) => lintParsed(parsePlan(raw), 'completion-lint-test', false);
  const has = (r: { warnings: { code: string }[] }) =>
    codes(r.warnings).includes('completion_status_mismatch');

  it('warns when ALL items are closed but status is ready (structural signal)', async () => {
    const r = await lintDoc(planDoc({ status: 'ready', items: [['P-001', 'done'], ['P-002', 'dropped']] }));
    expect(has(r)).toBe(true);
    expect(codes(r.errors)).not.toContain('completion_status_mismatch'); // warning, never error
    expect(r.warnings.find((f) => f.code === 'completion_status_mismatch')!.message).toMatch(/'ready'/);
  });

  it('warns when the Now state reads "PLAN COMPLETE — nothing outstanding" but status is draft', async () => {
    const r = await lintDoc(
      planDoc({ status: 'draft', items: [['P-001', 'todo']], nowState: 'PLAN COMPLETE — nothing outstanding.' }),
    );
    expect(has(r)).toBe(true);
  });

  it('does NOT warn when status is shipped (terminal — correctly closed out)', async () => {
    const r = await lintDoc(planDoc({ status: 'shipped', items: [['P-001', 'done']], nowState: 'all done' }));
    expect(has(r)).toBe(false);
  });

  it('does NOT warn when items remain open and the Now state is ordinary', async () => {
    const r = await lintDoc(planDoc({ status: 'ready', items: [['P-001', 'done'], ['P-002', 'todo']], nowState: 'building' }));
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on a bare "complete" in prose without a whole-plan completion phrase (FP guard)', async () => {
    const r = await lintDoc(
      planDoc({ status: 'active', items: [['P-001', 'todo']], nowState: 'next we complete the migration' }),
    );
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on a plan with zero items and an ordinary Now', async () => {
    const raw =
      `---\ntitle: T\nslug: completion-lint-test\nstatus: draft\ncreated: 2026-06-05\n---\n\n` +
      `# T\n\n## Now\n\n**State:** scoping\n\n**Next:** y\n\n## Decisions\n\n### D-001 — d\nBody.\n`;
    const r = await lintDoc(raw);
    expect(has(r)).toBe(false);
  });
});

describe('plans:lint — decision_done_items_todo (EI-101)', () => {
  const planDoc = (opts: { itemStatus: string; decisionBody: string }) =>
    `---\ntitle: T\nslug: dec-done-lint-test\nstatus: active\ncreated: 2026-06-05\n---\n\n` +
    `# T\n\n## Now\n\n**State:** building\n\n**Next:** y\n\n` +
    `## Phase 1\n\n- **P-001** \`${opts.itemStatus}\` do P-001\n- **P-002** \`${opts.itemStatus}\` do P-002\n\n` +
    `## Decisions\n\n### D-007 — completion\n${opts.decisionBody}\n`;
  const lintDoc = async (raw: string) => lintParsed(parsePlan(raw), 'dec-done-lint-test', false);
  const has = (r: { warnings: { code: string }[] }) =>
    codes(r.warnings).includes('decision_done_items_todo');

  it('warns when a decision reads "Executed P-001/P-002" but the items are still todo', async () => {
    const r = await lintDoc(planDoc({ itemStatus: 'todo', decisionBody: 'Executed P-001 and P-002 fully.' }));
    expect(has(r)).toBe(true);
    expect(codes(r.errors)).not.toContain('decision_done_items_todo'); // warning, never error
    const w = r.warnings.find((f) => f.code === 'decision_done_items_todo')!;
    expect(w.message).toMatch(/P-001/);
    expect(w.message).toMatch(/D-007/);
  });

  it('does NOT warn when the referenced items are already done', async () => {
    const r = await lintDoc(planDoc({ itemStatus: 'done', decisionBody: 'Shipped P-001 and P-002.' }));
    expect(has(r)).toBe(false);
  });

  it('does NOT warn when the decision body carries no completion verb', async () => {
    const r = await lintDoc(planDoc({ itemStatus: 'todo', decisionBody: 'We will scope P-001 and P-002 next.' }));
    expect(has(r)).toBe(false);
  });

  it('does NOT treat a negated completion phrase as proof that todo items landed', async () => {
    const r = await lintDoc(
      planDoc({
        itemStatus: 'todo',
        decisionBody: 'Partial output is not a completed release; P-001 and P-002 remain todo.',
      }),
    );
    expect(has(r)).toBe(false);
  });

  it('still warns when a negated phrase is followed by an affirmative completion', async () => {
    const r = await lintDoc(
      planDoc({
        itemStatus: 'todo',
        decisionBody: 'P-001 was not completed, but P-002 was executed successfully.',
      }),
    );
    expect(has(r)).toBe(true);
  });
});

/**
 * EI-251: checkbox-style item lines (`- [ ] P-NNN — text`) parse as ZERO
 * items, so plans:set-status fails item_not_found and the items are invisible
 * to plans:items/claims — silently (lint was green on the 81-item audit plan).
 * `checkbox_item_syntax` surfaces them as a WARNING.
 */
describe('plans:lint — checkbox-style item lines (EI-251)', () => {
  const checkboxPlan = (phaseBody: string) =>
    `---\n` +
    `title: T\n` +
    `slug: spawn-lint-test\n` +
    `status: active\n` +
    `created: 2026-06-10\n` +
    `---\n\n` +
    `# T\n\n` +
    `## Now\n\n**State:** x\n\n**Next:** y\n\n` +
    `## Phase 1\n\n${phaseBody}\n\n` +
    `## Decisions\n\n### D-001 — a decision\nBody.\n`;

  it('warns on checkbox item lines the parser cannot see, naming the ids', async () => {
    const report = await lint(
      checkboxPlan('- [ ] P-058 — migrate the pollers\n- [x] P-059 — remove the dead form'),
    );
    const w = report.warnings.find((f) => f.code === 'checkbox_item_syntax');
    expect(w).toBeTruthy();
    expect(w!.message).toMatch(/P-058/);
    expect(w!.message).toMatch(/P-059/);
    expect(w!.message).toMatch(/2 checkbox-style/);
    // Advisory only — never an error.
    expect(codes(report.errors)).not.toContain('checkbox_item_syntax');
  });

  it('does NOT warn on canonical item lines', async () => {
    const report = await lint(checkboxPlan('- **P-001** `todo` do a thing'));
    expect(codes(report.warnings)).not.toContain('checkbox_item_syntax');
  });

  it('does NOT flag a checkbox line whose id is ALSO parsed canonically (mid-conversion duplicate)', async () => {
    const report = await lint(
      checkboxPlan('- **P-001** `todo` do a thing\n- [ ] P-001 — stale duplicate of the same id'),
    );
    expect(codes(report.warnings)).not.toContain('checkbox_item_syntax');
  });

  it('summarises long ghost lists with a +N more suffix', async () => {
    const lines = Array.from({ length: 7 }, (_, i) => `- [ ] P-10${i} — thing ${i}`).join('\n');
    const report = await lint(checkboxPlan(lines));
    const w = report.warnings.find((f) => f.code === 'checkbox_item_syntax');
    expect(w).toBeTruthy();
    expect(w!.message).toMatch(/\+2 more/);
  });

  it('does NOT fire on a plain prose mention of an item id', async () => {
    const report = await lint(
      checkboxPlan('- **P-001** `todo` see P-002 of the other plan for context'),
    );
    expect(codes(report.warnings)).not.toContain('checkbox_item_syntax');
  });
});

/**
 * EI-480: a bold `- **P-NNN**` item line that is missing the required
 * `status` backtick token (e.g. `- **P-001** some text` with no `` `todo` ``)
 * parses as ZERO items — same silent-invisibility class as the checkbox form
 * (EI-251) — but `plans:lint` previously had NO warning for it at all: the
 * plan linted clean while every "item" silently vanished. `unparsed_item_line`
 * reuses the write-time detector (item-parse-feedback.ts) so lint catches it
 * too, however the plan was written.
 */
describe('plans:lint — item lines missing the status token (EI-480)', () => {
  const phasePlan = (phaseBody: string) =>
    `---\n` +
    `title: T\n` +
    `slug: spawn-lint-test\n` +
    `status: active\n` +
    `created: 2026-06-10\n` +
    `---\n\n` +
    `# T\n\n` +
    `## Now\n\n**State:** x\n\n**Next:** y\n\n` +
    `## Phase 1\n\n${phaseBody}\n\n` +
    `## Decisions\n\n### D-001 — a decision\nBody.\n`;

  it('warns on a bold P-NNN item line with no status token', async () => {
    const report = await lint(phasePlan('- **P-001** some text importance: normal'));
    const w = report.warnings.find((f) => f.code === 'unparsed_item_line');
    expect(w).toBeTruthy();
    expect(w!.message).toMatch(/P-001/);
    expect(w!.message).toMatch(/1 line/);
    // Advisory only — never an error.
    expect(codes(report.errors)).not.toContain('unparsed_item_line');
  });

  it('does NOT warn on canonical item lines', async () => {
    const report = await lint(phasePlan('- **P-001** `todo` do a thing'));
    expect(codes(report.warnings)).not.toContain('unparsed_item_line');
  });

  it('does NOT double-report a checkbox-style line already covered by checkbox_item_syntax', async () => {
    const report = await lint(phasePlan('- [ ] P-058 — migrate the pollers'));
    expect(codes(report.warnings)).toContain('checkbox_item_syntax');
    expect(codes(report.warnings)).not.toContain('unparsed_item_line');
  });

  it('does NOT fire on a plain prose mention of an item id', async () => {
    const report = await lint(phasePlan('- **P-001** `todo` see P-002 of the other plan for context'));
    expect(codes(report.warnings)).not.toContain('unparsed_item_line');
  });
});

describe('plans:lint — wrapper corruption diagnostics', () => {
  const phasePlan = (phaseBody: string) =>
    `---\n` +
    `title: T\n` +
    `slug: wrapper-corruption-lint-test\n` +
    `status: active\n` +
    `created: 2026-09-05\n` +
    `---\n\n` +
    `# T\n\n` +
    `## Now\n\n**State:** x\n\n**Next:** y\n\n` +
    `## Phase 1\n\n${phaseBody}\n\n` +
    `## Decisions\n\n### D-001 — a decision\nBody.\n`;

  it('turns detached item markers into errors and mid-word breaks into warnings', async () => {
    const report = await lintParsed(
      parsePlan(
        phasePlan(
          '- **P-001** `todo` provenance, maintainer review, publish/y\n' +
            'ank/revoke, and audit. blocked-by: P-006 importance: high',
        ),
      ),
      'wrapper-corruption-lint-test',
      false,
    );

    const parseError = report.errors.find((finding) => finding.code === 'parse_warning');
    expect(parseError).toBeTruthy();
    expect(parseError?.message).toMatch(/orphan item marker/i);
    expect(parseError?.message).toMatch(/blocked-by:/i);

    const parseNotice = report.warnings.find((finding) => finding.code === 'parse_notice');
    expect(parseNotice).toBeTruthy();
    expect(parseNotice?.message).toMatch(/mid-word hard line break/i);
    expect(codes(report.errors)).not.toContain('unknown_blocked_by');
  });

  it('does not warn about valid indented marker continuations', async () => {
    const report = await lintParsed(
      parsePlan(
        phasePlan(
          '- **P-001** `todo` a long item whose keywords wrapped onto the next\n' +
            '  line entirely blocked-by: P-002 importance: high\n' +
            '- **P-002** `done` prerequisite',
        ),
      ),
      'wrapper-corruption-lint-test',
      false,
    );

    expect(codes(report.errors)).not.toContain('parse_warning');
    expect(codes(report.warnings)).not.toContain('parse_notice');
    expect(codes(report.warnings)).not.toContain('unknown_blocked_by');
  });
});

/**
 * EI-44: owner-gated asks written as `## Now` PROSE ("Owner: decide D-002",
 * "human greenlights a phase", "Owner: provide creds") are invisible to every
 * inbox surface — only a `needs-human` ITEM is queryable. `owner_ask_not_needs_human`
 * warns when the Now block phrases an owner/human action-gate but no
 * `needs-human` item encodes it.
 */
describe('plans:lint — owner_ask_not_needs_human (EI-44)', () => {
  const planDoc = (opts: { nowState?: string; nowNext?: string; itemStatus?: string }) =>
    `---\n` +
    `title: T\n` +
    `slug: owner-ask-lint-test\n` +
    `status: active\n` +
    `created: 2026-06-11\n` +
    `---\n\n` +
    `# T\n\n` +
    `## Now\n\n**State:** ${opts.nowState ?? 'building'}\n\n**Next:** ${opts.nowNext ?? 'do y'}\n\n` +
    `## Phase 1\n\n- **P-001** \`${opts.itemStatus ?? 'todo'}\` do a thing\n\n` +
    `## Decisions\n\n### D-001 — a decision\nBody.\n`;
  const lintDoc = async (raw: string) => lintParsed(parsePlan(raw), 'owner-ask-lint-test', false);
  const has = (r: { warnings: { code: string }[] }) =>
    codes(r.warnings).includes('owner_ask_not_needs_human');

  it('warns on the "Owner:" label form with no needs-human item', async () => {
    const r = await lintDoc(planDoc({ nowState: 'Blocked. Owner: decide D-002 before phase 3.' }));
    expect(has(r)).toBe(true);
    expect(codes(r.errors)).not.toContain('owner_ask_not_needs_human'); // warning, never error
  });

  it('warns on the verb idiom "human greenlights a phase" (no colon)', async () => {
    const r = await lintDoc(planDoc({ nowNext: 'wait until a human greenlights a phase, then ship.' }));
    expect(has(r)).toBe(true);
  });

  it('warns on "Owner: provide … creds"', async () => {
    const r = await lintDoc(planDoc({ nowState: 'Owner: provide FCM/APNS creds to unblock push.' }));
    expect(has(r)).toBe(true);
  });

  it('matches "**Owner:**" with markdown emphasis (stripped first)', async () => {
    const r = await lintDoc(planDoc({ nowState: '**Owner:** sign-off needed before deploy.' }));
    expect(has(r)).toBe(true);
  });

  it('warns on "blocked on the owner"', async () => {
    const r = await lintDoc(planDoc({ nowState: 'Everything else is done; blocked on the owner.' }));
    expect(has(r)).toBe(true);
  });

  it('does NOT warn when a needs-human item already encodes the ask', async () => {
    const r = await lintDoc(
      planDoc({ nowState: 'Owner: decide D-002 before phase 3.', itemStatus: 'needs-human' }),
    );
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on a generic mention of the owner with no action gate', async () => {
    const r = await lintDoc(
      planDoc({ nowState: 'The owner only discovers these by reading every Now line, which is slow.' }),
    );
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on a generic mention of a human reading the plan', async () => {
    const r = await lintDoc(planDoc({ nowState: 'A human reads the Now line first on cold resume.' }));
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on an ordinary Now block with no owner/human mention', async () => {
    const r = await lintDoc(planDoc({ nowState: 'building phase 2', nowNext: 'wire the resolver' }));
    expect(has(r)).toBe(false);
  });
});

describe('plans:lint — stored_blocked_with_blocked_by escalates when every blocker is resolved (EI-19397307303043951)', () => {
  const planDoc = (opts: {
    blockerStatus: string;
    dependentBlockedBy?: string;
  }) => {
    const blockedByLine = opts.dependentBlockedBy ?? 'blocked-by: P-001';
    return (
      `---\n` +
      `title: T\n` +
      `slug: stale-blocked-lint-test\n` +
      `status: active\n` +
      `created: 2026-08-03\n` +
      `---\n\n` +
      `# T\n\n` +
      `## Now\n\n**State:** building\n\n**Next:** y\n\n` +
      `## Phase 1\n\n` +
      `- **P-001** \`${opts.blockerStatus}\` the dependency\n` +
      `- **P-002** \`blocked\` the dependent ${blockedByLine}\n\n` +
      `## Decisions\n\n### D-001 — a decision\nBody.\n`
    );
  };
  const lintDoc = async (raw: string) =>
    lintParsed(parsePlan(raw), 'stale-blocked-lint-test', false);
  const has = (r: { warnings: { code: string }[] }) =>
    codes(r.warnings).includes('stored_blocked_with_blocked_by');
  const warning = (r: { warnings: { code: string; message: string }[] }) =>
    r.warnings.find((f) => f.code === 'stored_blocked_with_blocked_by')!;

  it('still fires the mild, generic message while the blocker is unresolved', async () => {
    const r = await lintDoc(planDoc({ blockerStatus: 'todo' }));
    expect(has(r)).toBe(true);
    const w = warning(r);
    expect(w.message).toMatch(/should be 'todo'/);
    // The escalated "stuck RIGHT NOW" language must NOT fire while the
    // dependency is still open — that would be a false alarm.
    expect(w.message).not.toMatch(/RIGHT NOW/);
  });

  it('escalates to the stuck-RIGHT-NOW message once the blocker resolves to done', async () => {
    const r = await lintDoc(planDoc({ blockerStatus: 'done' }));
    expect(has(r)).toBe(true);
    const w = warning(r);
    expect(w.message).toMatch(/stuck 'blocked' RIGHT NOW/);
    expect(w.message).toMatch(/hiding claimable work from scheduler:get_next/);
  });

  it('escalates the same way when the blocker resolves to dropped (D-005 anti-stale-blocked rule)', async () => {
    const r = await lintDoc(planDoc({ blockerStatus: 'dropped' }));
    expect(has(r)).toBe(true);
    expect(warning(r).message).toMatch(/stuck 'blocked' RIGHT NOW/);
  });

  it('does NOT fire at all for a stored-blocked item with no blocked-by (the legitimate external-block case)', async () => {
    const raw =
      `---\ntitle: T\nslug: stale-blocked-lint-test\nstatus: active\ncreated: 2026-08-03\n---\n\n` +
      `# T\n\n## Now\n\n**State:** building\n\n**Next:** y\n\n` +
      `## Phase 1\n\n- **P-001** \`blocked\` awaiting a vendor response\n\n` +
      `## Decisions\n\n### D-001 — a decision\nBody.\n`;
    const r = await lintDoc(raw);
    expect(has(r)).toBe(false);
  });
});

describe('summarizeLintReports — bounded all-plans output (F-FIX-034 overflow regression)', () => {
  // Mirror the real bug input: many plans, a few errors, hundreds of verbose
  // warnings. The full reports were 170KB+ in one line → exceeded the agent
  // result-size cap → unusable blob. The summary must stay well under it.
  const longMsg = (code: string, i: number) =>
    `${code}: a verbose advisory sentence that explains the finding in detail for plan index ${i}, ` +
    'padded to resemble the real ~250-char lint warning messages that dominate the output bytes.';
  const reports: PlanLintReport[] = [];
  for (let i = 0; i < 484; i++) {
    const errors =
      i < 17
        ? [{ level: 'error' as const, code: 'missing_now_section', message: longMsg('missing_now_section', i) }]
        : [];
    const warnings = Array.from({ length: i % 5 === 0 ? 3 : 1 }, (_, k) => ({
      level: 'warning' as const,
      code: k === 0 ? 'unphased_item' : 'owner_ask_not_needs_human',
      message: longMsg('warn', i),
    }));
    reports.push({ slug: `plan-${i}`, archived: false, legacy: false, exempt: false, errors, warnings });
  }

  it('preserves error totals + inlines error findings, collapses warnings to counts', () => {
    const s = summarizeLintReports(reports);
    expect(s.mode).toBe('summary');
    expect(s.ok).toBe(false); // 17 plans carry an error
    expect(s.totalErrors).toBe(17);
    expect(s.planCount).toBe(484);
    expect(s.errorsByCode.missing_now_section).toBe(17);
    expect(s.warningsByCode.unphased_item).toBeGreaterThan(0);
    // every error finding is inlined (CI-gating signal kept in full)
    const inlinedErrors = s.plans.reduce((n, p) => n + (p.errors?.length ?? 0), 0);
    expect(inlinedErrors).toBe(17);
    // warnings are NOT inlined anywhere — only counted
    expect(s.plans.every((p) => p.warningCount >= 0 && !('warnings' in p))).toBe(true);
  });

  it('omits clean plans and stays far under the ~80KB result-size cap', () => {
    const s = summarizeLintReports(reports);
    // only plans with ≥1 finding appear
    expect(s.plans.every((p) => p.errorCount > 0 || p.warningCount > 0)).toBe(true);
    const summaryBytes = JSON.stringify(s).length;
    const fullBytes = JSON.stringify({ reports }).length;
    expect(summaryBytes).toBeLessThan(60_000);
    expect(summaryBytes).toBeLessThan(fullBytes / 2);
  });

  it('reports ok:true with no errors (warnings alone do not gate)', () => {
    const warnOnly: PlanLintReport[] = [
      { slug: 'p1', archived: false, legacy: false, exempt: false, errors: [], warnings: [{ level: 'warning', code: 'unphased_item', message: 'x' }] },
      { slug: 'p2', archived: false, legacy: false, exempt: false, errors: [], warnings: [] },
    ];
    const s = summarizeLintReports(warnOnly);
    expect(s.ok).toBe(true);
    expect(s.totalWarnings).toBe(1);
    expect(s.plans.map((p) => p.slug)).toEqual(['p1']); // p2 (clean) omitted
  });
});

// ─── EI-12150 (rubric-system-hardening P-005): the derived-verdict guard ────────────
// A GREEN/GO claim in ## Now is prose that never re-derives; when the plan references
// a release-gating rubric, the claim must agree with that rubric's newest COMPLETE
// scorecard. Pure decider + claim detector tested here (the PG gather fails open).
import { evaluateDerivedVerdict, hasReleaseClaim, type GatingRubricScorecardSummary } from './lint';

describe('hasReleaseClaim (EI-12150)', () => {
  it('matches uppercase verdict tokens and release-ready phrases', () => {
    expect(hasReleaseClaim('**State:** Verdict: GO — all six criteria pass')).toBe(true);
    expect(hasReleaseClaim('PUBLIC RELEASE GREEN as of 14:00')).toBe(true);
    expect(hasReleaseClaim('we are release-ready pending docs')).toBe(true);
    expect(hasReleaseClaim('Ready for public release')).toBe(true);
  });
  it('does NOT match everyday lowercase prose or a NO-GO', () => {
    expect(hasReleaseClaim('go to the settings page and pick the green button')).toBe(false);
    expect(hasReleaseClaim('Verdict: NO-GO — cycle-error-rate red')).toBe(false);
    expect(hasReleaseClaim('NO GO until the drill passes')).toBe(false);
  });
});

describe('evaluateDerivedVerdict (EI-12150)', () => {
  const gating = (
    ratings: Record<string, { rating: string }> | null,
  ): GatingRubricScorecardSummary[] => [
    {
      rubricRef: 'blender-release-readiness',
      newestComplete: ratings
        ? { issueId: 'EI-12107', createdAt: '2026-07-14T20:00:00.000Z', ratings }
        : null,
    },
  ];
  const planRaw = '# P\n\n## Now\n\n**State:** GO — graded against blender-release-readiness.\n';

  it('silent when the newest complete scorecard is all-pass (pass/healthy vocabularies)', () => {
    expect(
      evaluateDerivedVerdict(planRaw, gating({ a: { rating: 'pass' }, b: { rating: 'healthy' } })),
    ).toEqual([]);
  });

  it('WARNS (never errors) when the newest complete scorecard is not all-pass, naming the failing keys', () => {
    const findings = evaluateDerivedVerdict(
      planRaw,
      gating({ 'cycle-error-rate': { rating: 'fail' }, 'e2e-drill': { rating: 'pass' }, x: { rating: 'unknown' } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'warning', code: 'derived_verdict_mismatch' });
    expect(findings[0]!.message).toContain('cycle-error-rate=fail');
    expect(findings[0]!.message).toContain('x=unknown');
    expect(findings[0]!.message).toContain('EI-12107');
  });

  it('an UNVERIFIED claim (no complete scorecard at all) is its own distinct warning', () => {
    const findings = evaluateDerivedVerdict(planRaw, gating(null));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: 'warning', code: 'derived_verdict_unverified' });
  });

  it('ignores gating rubrics the plan never references — a plan answers only for ITS rubric', () => {
    const findings = evaluateDerivedVerdict(
      '# P\n\n## Now\n\n**State:** GO — unrelated to any rubric.\n',
      gating({ a: { rating: 'fail' } }),
    );
    expect(findings).toEqual([]);
  });
});

describe('plans:lint — unknown_decision_ref (EI-522)', () => {
  it('does not flag a cross-plan D-NNN cited only in a set-status-injected note\'s free prose', async () => {
    const raw = planWith('') /* no Promote section needed */ .replace(
      '- **P-001** `todo` do a thing',
      '- **P-001** `done` do a thing — note: back-refs added to other-plan D-025, another-plan D-011',
    );
    const report = await lint(raw);
    expect(codes(report.warnings)).not.toContain('unknown_decision_ref');
  });

  it('still flags a GENUINE unknown local decision ref (not inside a note)', async () => {
    const raw = planWith('').replace(
      '- **P-001** `todo` do a thing',
      '- **P-001** `todo` do a thing → D-099',
    );
    const report = await lint(raw);
    expect(codes(report.warnings)).toContain('unknown_decision_ref');
  });
});

describe('plans:lint — terminal_status_stale_now (WI-38303)', () => {
  // The MIRROR of completion_status_mismatch: that one catches a done-reading Now
  // under a live status, this one catches a live-reading Now under a terminal
  // status. Measured cost of the gap: 277 papercusp plans, and two agents sent to
  // redo finished work in one session.
  const planDoc = (opts: { status: string; nowState?: string; nowNext: string }) =>
    `---\ntitle: T\nslug: terminal-now-lint-test\nstatus: ${opts.status}\ncreated: 2026-08-12\n---\n\n` +
    `# T\n\n## Now\n\n**State:** ${opts.nowState ?? 'shipped it'}\n\n**Next:** ${opts.nowNext}\n\n` +
    `## Phase 1\n\n- **P-001** \`done\` do a thing\n\n## Decisions\n`;
  const lintDoc = async (raw: string) => lintParsed(parsePlan(raw), 'terminal-now-lint-test', false);
  const has = (r: { warnings: { code: string }[] }) =>
    codes(r.warnings).includes('terminal_status_stale_now');

  it('warns when a SHIPPED plan still tells the reader to do something', async () => {
    const r = await lintDoc(planDoc({ status: 'shipped', nowNext: 'Grade the rubric, then flip the plan to shipped.' }));
    expect(has(r)).toBe(true);
    expect(codes(r.errors)).not.toContain('terminal_status_stale_now'); // warning, never error
    expect(r.warnings.find((f) => f.code === 'terminal_status_stale_now')!.message).toMatch(/'shipped'/);
  });

  it('warns on a SUPERSEDED plan too', async () => {
    const r = await lintDoc(planDoc({ status: 'superseded', nowNext: 'Rebuild the adapter against the new API.' }));
    expect(has(r)).toBe(true);
  });

  it('does NOT warn on a live status — that direction is completion_status_mismatch', async () => {
    for (const status of ['draft', 'ready', 'active']) {
      expect(has(await lintDoc(planDoc({ status, nowNext: 'Grade the rubric.' })))).toBe(false);
    }
  });

  it('does NOT warn when the Next already reads as closed', async () => {
    for (const next of ['none', 'Nothing outstanding.', 'n/a', '—', 'none — the plan is shipped.']) {
      expect(has(await lintDoc(planDoc({ status: 'shipped', nowNext: next })))).toBe(false);
    }
  });

  it('is SILENCED by a legacy terminal stamp (plans stamped before P-006 retired it)', async () => {
    // derived-status P-006 retired the WI-38303 stamp writer; plans stamped
    // before then still carry its mark in their Now, and it still means "closed".
    const stamped = planDoc({
      status: 'shipped',
      nowState: '⛔ PLAN CLOSED — SHIPPED 2026-08-12. shipped it',
      nowNext: 'Grade the rubric, then flip the plan to shipped.',
    });
    expect(has(await lintDoc(stamped))).toBe(false);
  });

  it('points the author at plans:set-now, not at a stamp the status verb no longer writes', async () => {
    const r = await lintDoc(planDoc({ status: 'shipped', nowNext: 'Grade the rubric, then flip the plan to shipped.' }));
    const message = r.warnings.find((f) => f.code === 'terminal_status_stale_now')!.message;
    expect(message).toContain('plans:set-now');
    expect(message).not.toMatch(/stamps the block/);
  });

  it('CONTROL: the same doc unstamped DOES warn', async () => {
    // Calibration for the test above — proves the silence came from the stamp.
    const r = await lintDoc(planDoc({ status: 'shipped', nowNext: 'Grade the rubric, then flip the plan to shipped.' }));
    expect(has(r)).toBe(true);
  });
});

describe('plans:lint — terminal_status_open_items (EI-21843057910518424)', () => {
  // The plan-level lifecycle label vs. the child-item graph: a terminal
  // status (shipped/superseded) with non-terminal items left behind. Measured
  // live: 15+ papercusp plans, several with EVERY item still open despite a
  // terminal label — a daily-digest census found a dozen-plus independently
  // filed reports all naming this same mechanism.
  const planDoc = (opts: { status: string; items: string }) =>
    `---\ntitle: T\nslug: terminal-open-items-lint-test\nstatus: ${opts.status}\ncreated: 2026-08-30\n---\n\n` +
    `# T\n\n## Now\n\n**State:** done\n\n**Next:** none\n\n## Phase 1\n\n${opts.items}\n\n## Decisions\n`;
  const lintDoc = async (raw: string) => lintParsed(parsePlan(raw), 'terminal-open-items-lint-test', false);
  const has = (r: { warnings: { code: string }[] }) =>
    codes(r.warnings).includes('terminal_status_open_items');

  it('warns when a SHIPPED plan still carries a todo item', async () => {
    const r = await lintDoc(
      planDoc({ status: 'shipped', items: '- **P-001** `done` build it\n- **P-002** `todo` write the last test' }),
    );
    expect(has(r)).toBe(true);
    expect(codes(r.errors)).not.toContain('terminal_status_open_items'); // warning, never error
    const msg = r.warnings.find((f) => f.code === 'terminal_status_open_items')!.message;
    expect(msg).toMatch(/'shipped'/);
    expect(msg).toMatch(/P-002/);
  });

  it('warns on a SUPERSEDED plan with blocked/wip/needs-human items too', async () => {
    const r = await lintDoc(
      planDoc({
        status: 'superseded',
        items: '- **P-001** `wip` in progress\n- **P-002** `blocked` waiting\n- **P-003** `needs-human` ask owner',
      }),
    );
    expect(has(r)).toBe(true);
    const msg = r.warnings.find((f) => f.code === 'terminal_status_open_items')!.message;
    expect(msg).toMatch(/3 of its 3/);
  });

  it('does NOT warn when every item is done/dropped', async () => {
    const r = await lintDoc(
      planDoc({ status: 'shipped', items: '- **P-001** `done` built it\n- **P-002** `dropped` not needed' }),
    );
    expect(has(r)).toBe(false);
  });

  it('does NOT warn on a live status — draft/ready/active plans are allowed open items', async () => {
    for (const status of ['draft', 'ready', 'active']) {
      expect(has(await lintDoc(planDoc({ status, items: '- **P-001** `todo` do a thing' })))).toBe(false);
    }
  });

  it('does NOT warn on a terminal plan with no items at all', async () => {
    const r = await lintDoc(planDoc({ status: 'shipped', items: '' }));
    expect(has(r)).toBe(false);
  });
});

describe('plans:lint — DAG parallelism diagnostics (WI-40832)', () => {
  const planDoc = (phases: string) =>
    `---\ntitle: DAG lint\nslug: dag-lint-test\nstatus: active\ncreated: 2026-08-23\n---\n\n` +
    `# DAG lint\n\n## Now\n\n**State:** building\n\n**Next:** execute the ready frontier\n\n` +
    `${phases}\n\n## Decisions\n\n### D-001 — graph\nKeep independent work parallel.\n`;

  it('warns when a remaining DAG is needlessly serial', async () => {
    const report = await lintParsed(parsePlan(planDoc(
      `## Phase 1\n\n- **P-001** \`todo\` Build core\n\n` +
      `## Phase 2\n\n- **P-002** \`todo\` Build adapter blocked-by: P-001\n\n` +
      `## Phase 3\n\n- **P-003** \`todo\` Integrate adapter blocked-by: P-002`,
    )), 'dag-lint-test', false);

    const finding = report.warnings.find((entry) => entry.code === 'narrow-or-deep-topology');
    expect(finding?.dependencyFinding?.evidence).toMatchObject({
      topologyMetrics: { readyWidth: 1, criticalPathDepth: 3 },
      path: ['P-001', 'P-002', 'P-003'],
    });
  });

  it('reports exact fan-in, phase-inversion, and release-gate edges', async () => {
    const report = await lintParsed(parsePlan(planDoc(
      `## Phase 1\n\n` +
      `- **P-001** \`todo\` Implement provider foundation blocked-by: P-003\n` +
      `- **P-002** \`todo\` Build storage adapter\n\n` +
      `## Phase 2\n\n- **P-004** \`todo\` Integrate providers blocked-by: P-001, P-002\n\n` +
      `## Phase 4\n\n- **P-003** \`todo\` Beta distribution release gate`,
    )), 'dag-lint-test', false);

    // Two blockers are an explicitly healthy shape; high-degree begins at four.
    expect(report.warnings.find((entry) => entry.code === 'high-degree-node')).toBeUndefined();
    expect(report.warnings.find((entry) => entry.code === 'phase-inversion')?.dependencyFinding?.edges)
      .toEqual([{ subject: 'P-001', dependency: 'P-003' }]);
    expect(report.warnings.find((entry) => entry.code === 'gate-foundation-inversion')?.dependencyFinding?.nodes)
      .toEqual(['P-001', 'P-003']);
  });
});
