/**
 * idle-loop-recipe-pin.test.ts — the P-006 idle-loop recipe RECURRENCE GUARD
 * (composable-event-awaits-2026-07-11).
 *
 * The recipe (an idle self-puller parks on a standing wake watch over the canonical
 * work-item:claimable key — the P-007 dual-emit that collapses the original
 * work-item:created / claim:released:* / work-item:unblocked:* 3-leaf composed
 * spec — with wake:true/once:false persistence, instead of a ~60s re-poll; the
 * pull stays the authoritative claim) lives on the prompt/code surfaces that
 * drift independently:
 *   1. scheduler:get_next's miss advice (IDLE_PULL_MISS_ADVICE — the point of need),
 *   2. DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE (the loop wake's empty-wake step),
 *   3. the su prompts (papercusp-su-engineer.tools.md / papercusp-su-power.tools.md),
 *      the base su blueprint, and the fleet-member posture.
 * This test PINS all surfaces: a future edit that drops the recipe (or renames an event
 * family out from under it) reds here instead of silently reviving the poll cadence.
 * Marker style over full-text equality: wording may be tightened freely; the recipe's
 * load-bearing parts (the three event families, standing-watch persistence,
 * authoritative-claim rule, and no-timer-poll mandate) must survive.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  SU_ROLES: ['operator'],
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-idle', ownerLabel: 'i', source: 'static-client', workspaceId: 'ws-x', userId: null }),
}));
vi.mock('@papercusp/flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags')>()),
  FLAGS: { SCHEDULER_SPEC_CLAIM: 'scheduler_spec_claim' } }));
// `onFlagChange` is required even though this test never exercises a flag change:
// coordination/log.ts subscribes to it at MODULE SCOPE, so any transitive import of
// the coord module graph explodes at collection time if the mock omits it.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => true), onFlagChange: vi.fn() }));
vi.mock('../../scheduler/claim-spec-store', () => ({
  getNextForBee: vi.fn(async () => null),
  resolveClaimSpecWorkspace: (w: unknown) => w ?? 'default',
  // get_next.ts's capacity-diagnosis leg (~606) runs on the MISS path this test
  // drives and reads BOTH of these. Absent from the mock, the miss throws
  // "No <name> export is defined" before reaching the idle-recipe advice this
  // file pins. Mocked to the "nothing configured" shape that leg already handles
  // for an unspecced caller. Kept in step with get_next.ts's import list from
  // '../../scheduler/claim-spec-store' — adding a call there needs an entry here.
  getClaimSpecRecord: vi.fn(async () => null),
  readClaimConcurrency: vi.fn(async () => null),
}));
// Spread the real module rather than listing exports: get_next's import list grows over time
// (WI-39730 added `releaseWorkItem`), and a bare factory turns every such addition into a
// COLLECTION crash in this file — a failure that reads as "this test is broken" rather than
// "the graph widened". Only the allowlist is actually overridden.
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLAIM_STATES_ALLOWLIST: ['open', 'failing'],
}));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../work-scope-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-scope-policy')>()),
  gateWorkScope: vi.fn(async () => ({ allowed: true })),
}));
// The recipe assertion starts at the post-preflight MISS payload. Pin the
// coordination readers so this unit test does not consult live fleet/lock state
// before it reaches that branch.
vi.mock('../coordination/context-pressure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/context-pressure')>()),
  fetchContextPressure: vi.fn(async () => new Map()),
  resolveContextPressureRecoveryPath: vi.fn(async () => null),
}));
vi.mock('../locks/live-lock-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/live-lock-paths')>()),
  liveLockedPaths: vi.fn(async () => []),
}));
vi.mock('../../scheduler/fleet-scope-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/fleet-scope-admission')>()),
  reconcileFleetScopeClaims: vi.fn(async () => ({ scope: null, quarantinedIds: [] })),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence')>()),
  getPresence: vi.fn(async () => null),
  writePresence: vi.fn(async () => undefined),
}));
// EI-16057: the harness-existence gate (checked on every miss) resolves `harness` against
// the registry — stub it so the miss this test drives falls through to the idle-recipe
// advice path it's actually pinning, not the (also-real) harness_not_found branch.
// Spread the real module for the same reason as ../../work-items above: get_next's transitive
// graph now reaches p2p/revocation-reaper, which imports `deregisterEphemeralForeignHarness`
// from here, and a bare factory omitting it crashes collection.
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'h' }] })),
}));

import getNext, { IDLE_PULL_MISS_ADVICE } from './get_next';
import { DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE } from '../../harness/routines/loop';
import { renderSuPlaybook } from '../../desktop-install/papercusp-files';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../../');
const PROMPTS_DIR = join(REPO, 'apps/operator/prompts');

/** The load-bearing recipe markers a surface must carry to count as teaching it. */
const RECIPE_MARKERS = [
  'work-item:claimable', // the canonical P-007 dual-emit key
  'payload_filter', // the standing watch's filter arg — `when` is leaf-spec-only and silently mis-teaches (P-007 audit)
  'watch:create',
  'wake:true',
  'once:false',
];

describe('P-006 idle-loop recipe pin (composable-event-awaits-2026-07-11)', () => {
  it.each(['codex', 'claude'])('delivers the Luna capacity and subscribe/recheck rules in a fresh %s member render', async (agent) => {
    const baseSource = join(REPO, 'libs/papercusp/packages/harness/blueprints/base/prompts/su.md');
    const rendered = await renderSuPlaybook({
      agent,
      profile: 'engineer',
      tier: 'fleet',
      baseSource,
      overlayDir: PROMPTS_DIR,
      projectGuideSource: '',
      renderWireSchemas: () => '',
    });
    expect(rendered.baseSource).toBe(baseSource);
    const member = rendered.text.split('## Working as a fleet MEMBER')[1]?.split('## Git')[0];
    expect(member).toBeDefined();
    expect(member).toContain('eligible work beside an available member requires action or a verified, accountable');
    expect(member).toContain('effective claim limits and counted ids, typed blockers, member-specific');
    expect(member).toContain('a fleet-wide count is not proof');
    expect(member).toContain('Preserve owner-only/held-item-only fences');
    expect(member).toContain('Keep the effective claim cap');
    expect(member).toContain('an event wait alone is not exempt');
    expect(member).toMatch(/then re-run `scheduler:get_next` BEFORE\s+`loop:end`/);
    expect(member).toContain('only a verified miss');
    expect(member).toContain('authoritative claim');
    for (const marker of RECIPE_MARKERS) expect(member).toContain(marker);
  });

  it('IDLE_PULL_MISS_ADVICE carries the full recipe: claimable key, standing watch, hint-not-claim, no timer poll', () => {
    for (const m of RECIPE_MARKERS) expect(IDLE_PULL_MISS_ADVICE).toContain(m);
    expect(IDLE_PULL_MISS_ADVICE).not.toContain('events:await');
    expect(IDLE_PULL_MISS_ADVICE).toContain('re-run scheduler:get_next BEFORE sleeping');
    expect(IDLE_PULL_MISS_ADVICE).toContain('only a verified miss');
    expect(IDLE_PULL_MISS_ADVICE).toContain('AUTHORITATIVE');
    expect(IDLE_PULL_MISS_ADVICE).toContain('remains armed');
    expect(IDLE_PULL_MISS_ADVICE).toContain('goal');
    expect(IDLE_PULL_MISS_ADVICE).toMatch(/do NOT re-poll/i);
    expect(IDLE_PULL_MISS_ADVICE).toContain('END YOUR TURN');
  });

  it('a get_next MISS delivers the recipe as `advice` (the point-of-need surface)', async () => {
    const ctx = { workspaceId: 'ws-x' } as unknown as Parameters<typeof getNext.handler>[1];
    const res = (await getNext.handler({ harness: 'h' } as never, ctx)) as { content: Array<{ text: string }> };
    const out = JSON.parse(res.content[0].text);
    expect(out.ok).toBe(false);
    expect(out.advice, JSON.stringify(out)).toBe(IDLE_PULL_MISS_ADVICE);
  });

  it('the default loop wake template parks an idle self-puller on the standing watch (no empty-wake spinning)', () => {
    for (const m of RECIPE_MARKERS) expect(DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE).toContain(m);
    expect(DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE).toContain('watch:create');
    expect(DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE).not.toContain('timeout_sec: 1800');
    expect(DEFAULT_LOOP_WAKE_PROMPT_TEMPLATE).toContain('authoritative claim');
  });

  for (const file of ['papercusp-su-engineer.tools.md', 'papercusp-su-power.tools.md']) {
    it(`${file} teaches the composed-await idle recipe (the su prompt surface)`, () => {
      const text = readFileSync(join(PROMPTS_DIR, file), 'utf8');
      for (const m of RECIPE_MARKERS) expect(text).toContain(m);
      // The authoritative-claim rule (wake = hint, pull = claim) must survive rewording.
      expect(text).toMatch(/authoritative claim/i);
    });
  }

  // P-007 audit follow-up: the other active claim-spec self-pullers — the base
  // su blueprint and the fleet-member posture — park on the same standing
  // watch when drained. Retired cup/Mug/kettle/blender prompts stay out of this
  // active-agent contract pin.
  const BLUEPRINT_PROMPTS = join(REPO, 'libs/papercusp/packages/harness/blueprints/base/prompts');
  const FLEET_MEMBER_PROMPTS = join(REPO, 'libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts');
  for (const [root, file] of [
    [BLUEPRINT_PROMPTS, 'su.md'],
    [FLEET_MEMBER_PROMPTS, 'fleet-posture.md'],
  ] as const) {
    it(`${file} teaches the idle claimable-watch park (the active self-puller surface)`, () => {
      const text = readFileSync(join(root, file), 'utf8');
      for (const m of RECIPE_MARKERS) expect(text).toContain(m);
      expect(text).toMatch(/authoritative claim/i);
    });
  }
});
