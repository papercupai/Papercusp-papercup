/**
 * identities-v1-2026-08-30 P-012 — the operator side of the stack-mutation primitive:
 * the binding DERIVED from the anchor's route (pinned to the orchestrator's posture ids),
 * the anchor carrying `stack` and stamping `stackBefore`, and the turn-start delivery
 * that turns a transition into `⟦stack⟧` payloads over the REAL su stack.
 */
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as blueprint from '@papercusp/orchestrator/blueprint';
import * as currentStackBindingChannel from './stack-binding-channel';
import { normalizeControlAnchorState, type ControlAnchorState } from './agent-tools/coordination/control-anchor';

// Reuse the standard copy-out probe (scripts/mutation-probe.sh) without mutating the shared subject.
const channel: typeof currentStackBindingChannel = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
  ? await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)
  : currentStackBindingChannel;
const {
  SU_MODE_REFS, SU_POSTURE_REFS, renderStackTransitionContext, renderStackTransitionContextResult,
  stackRefsForModes, stackRefsForRoute, stackRefsForSession,
} = channel;

const here = dirname(fileURLToPath(import.meta.url));
// packages/operator-core/lib → <root>/libs/papercusp/packages/harness
const harnessDir = join(here, '..', '..', '..', 'libs', 'papercusp', 'packages', 'harness');

function state(over: Partial<ControlAnchorState> = {}): ControlAnchorState {
  return {
    modes: ['auto'],
    loop: { active: true, intervalSec: 60 },
    carry: 'warm',
    route: { kind: 'self' },
    scope: { workspace: 'papercusp-workspace', harness: 'papercusp', plan: null, items: [] },
    ...over,
  };
}

describe('stackRefsForRoute (P-012)', () => {
  it('projects the fleet posture from the route and nothing else; the ids are the orchestrator posture layers', () => {
    expect(stackRefsForRoute({ kind: 'self' })).toEqual([]);
    expect(stackRefsForRoute({ kind: 'mug' })).toEqual([]);
    expect(stackRefsForRoute({ kind: 'fleet', fleet: 'alpha', role: null })).toEqual([]);
    expect(stackRefsForRoute({ kind: 'fleet', fleet: 'alpha', role: 'member' })).toEqual([SU_POSTURE_REFS.member]);
    expect(stackRefsForRoute({ kind: 'fleet', fleet: 'alpha', role: 'Leader' })).toEqual([SU_POSTURE_REFS.leader]);
    // The inlined refs are PINNED to the orchestrator's own posture layers (derived-truth rung 2).
    expect(SU_POSTURE_REFS.member).toBe(blueprint.bindingRef(blueprint.suPostureLayer('member')));
    expect(SU_POSTURE_REFS.leader).toBe(blueprint.bindingRef(blueprint.suPostureLayer('leader')));
  });

  it('P-021: every active mode projects its generated definition layer on the correct axis', () => {
    expect(stackRefsForModes([])).toEqual([]);
    expect(stackRefsForModes(['goal', 'grade', 'test', 'potato'])).toEqual([
      'goal:su.mode-goal', 'grade:su.mode-grade', 'test:su.mode-test',
    ]);
    expect(stackRefsForModes(['auto'])).toEqual(['autonomy:su.mode-auto']);
    expect(stackRefsForModes(['cold-auto'])).toEqual(['autonomy:su.mode-auto']);
    expect(stackRefsForModes(['IDEATE', 'auto'])).toEqual(['ideation:su.mode-ideate', 'autonomy:su.mode-auto']);
    expect(stackRefsForModes(['drain', 'auto'])).toEqual(['objective:su.mode-drain', 'autonomy:su.mode-auto']);
    const selected = {
      revision: 'selected',
      entries: [{ id: 'auto', slot: 'autonomy', sourceId: 'su.mode-auto-custom' }],
    } as unknown as blueprint.ModeCatalogSnapshot;
    expect(stackRefsForModes(['auto', 'cold-auto'], selected)).toEqual(['autonomy:su.mode-auto-custom']);
    expect(stackRefsForSession({ route: { kind: 'self' }, modes: ['auto'], modeCatalog: selected }))
      .toEqual(['autonomy:su.mode-auto-custom']);
    for (const [mode, ref] of Object.entries(SU_MODE_REFS)) {
      expect(ref, mode).toBe(blueprint.bindingRef(blueprint.suModeLayer(mode)!));
    }
    // every orchestrator mode identity is reachable from here, and nothing else is
    const orchestrator = blueprint.SU_MODE_DOCUMENTS.flatMap((d) => d.modes.map((m) => [m, blueprint.bindingRef({ slot: d.slot, id: d.id })] as const));
    expect(Object.entries(SU_MODE_REFS).sort()).toEqual([...orchestrator].sort());
    // route + modes compose: a fleet member in AUTO carries both
    expect(stackRefsForSession({ route: { kind: 'fleet', fleet: 'alpha', role: 'member' }, modes: ['auto'] })).toEqual([
      SU_POSTURE_REFS.member,
      'autonomy:su.mode-auto',
    ]);
    expect(stackRefsForSession({ route: { kind: 'self' }, modes: ['auto', 'ideate'] })).toEqual(['autonomy:su.mode-auto', 'ideation:su.mode-ideate']);
    expect(stackRefsForSession({
      route: { kind: 'fleet', fleet: 'alpha', role: 'leader' },
      modes: ['auto'],
      explicit: ['domain:researcher', 'practice:citations', 'autonomy:su.mode-auto'],
    })).toEqual([
      'domain:researcher',
      'practice:citations',
      'autonomy:su.mode-auto',
      SU_POSTURE_REFS.leader,
    ]);
  });

  it('normalizeControlAnchorState carries `stack` only when non-empty, sorted + deduped', () => {
    expect('stack' in normalizeControlAnchorState(state())).toBe(false);
    expect('stack' in normalizeControlAnchorState(state({ stack: [] }))).toBe(false);
    expect(normalizeControlAnchorState(state({ stack: ['practice:b', 'fleet-posture:su.fleet-leader', 'practice:b'] })).stack).toEqual([
      'fleet-posture:su.fleet-leader',
      'practice:b',
    ]);
  });
});

describe('renderStackTransitionContext (P-012)', () => {
  const opts = { harnessDir, blueprint, warn: () => {} };

  it('delivers nothing when the stack did not move, or when a full-resync has nothing bound', async () => {
    expect(await renderStackTransitionContext({ state: state(), stackBefore: [] }, opts)).toBe('');
    expect(await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.member] }), stackBefore: [SU_POSTURE_REFS.member] }, opts)).toBe('');
    const emptyResync = await renderStackTransitionContext({ state: state() }, opts);
    expect(emptyResync).toContain('no runtime stack layers remain');
    expect(emptyResync).toContain('treat it as VOID from this turn on');
  });

  it('a fleet join attaches the member posture: a ⟦stack⟧ payload carrying the real posture text, no seal', async () => {
    const out = await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.member] }), stackBefore: [] }, opts);
    expect(out.startsWith(`${blueprint.STACK_INJECTION_STAMP} {"op":"attach","slot":"fleet-posture","id":"su.fleet-member"`)).toBe(true);
    expect(out).toContain('## Working as a fleet MEMBER');
    expect(out).toContain('sits ABOVE the kernel seal');
    expect(out).not.toContain(blueprint.KERNEL_SEAL_MARKER);
  });

  it('take-leadership is ONE swap payload that names the replaced member posture; leaving the fleet voids it', async () => {
    const led = await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.leader] }), stackBefore: [SU_POSTURE_REFS.member] }, opts);
    expect(led.split(blueprint.STACK_INJECTION_STAMP).length).toBe(2);
    expect(led).toContain('"replaced":"su.fleet-member"');
    expect(led).toContain('It REPLACES `su.fleet-member` on the exclusive `fleet-posture` slot');
    const left = await renderStackTransitionContext({ state: state(), stackBefore: [SU_POSTURE_REFS.leader] }, opts);
    expect(left).toContain('"op":"detach"');
    expect(left).toContain('NO LONGER APPLIES');
  });

  it('a full-resync (no stackBefore) re-delivers every bound layer; a broken render degrades to an empty block, never a throw', async () => {
    const out = await renderStackTransitionContext({ state: state({ stack: [SU_POSTURE_REFS.leader] }) }, opts);
    expect(out).toContain('"id":"su.fleet-leader"');
    const warnings: string[] = [];
    const broken = await renderStackTransitionContext(
      { state: state({ stack: ['practice:no-such-document'] }), stackBefore: [] },
      { ...opts, warn: (m) => warnings.push(m) },
    );
    expect(broken).toBe('');
    expect(warnings[0]).toMatch(/stack transition not delivered/);
  });

  // WI-10004896: a vm-release host's content root holds unattested first-party copies of
  // every blueprint. Attaching AUTO mid-session must deliver the catalog-selected built-in
  // definition, not refuse the installed copy the id would re-resolve to.
  it('attaches AUTO from the selected catalog source when the content root holds an unattested copy', async () => {
    const { cpSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'stack-channel-vm-release-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    try {
      process.env.PAPERCUSP_HOME = root;
      for (const id of ['base', 'su.mode-auto']) {
        cpSync(dirname(blueprint.builtinBlueprintPath(id)), join(root, 'blueprints', id), { recursive: true });
      }
      const warnings: string[] = [];
      const out = await renderStackTransitionContext(
        { state: state({ stack: ['autonomy:su.mode-auto'] }), stackBefore: [] },
        { ...opts, warn: (m) => warnings.push(m) },
      );
      expect(warnings).toEqual([]);
      expect(out).toContain('"id":"su.mode-auto"');
      expect(out).toContain("AUTO mode — the owner's switch");
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks domain/client mutations fresh-context so the old host cannot acknowledge them', async () => {
    const result = await renderStackTransitionContextResult(
      {
        state: state({ stack: ['domain:research-steward'] }),
        stackBefore: [],
      },
      opts,
    );
    expect(result.rendered).toBe(true);
    expect(result.requiresFreshContext).toBe(true);
    expect(result.text).toContain('relaunch-with-carry');
  });

  // portable-identity P-003 (EI-24345639608517597): the addressed Project-guide parts a
  // stack change reaches ride the SAME transition. Real-PG + real take-leadership proof:
  // doc-projection/wearer-transition.integration.test.ts.
  it('P-003: take-leadership also delivers the guide parts addressed to the leader — layer payloads unchanged; a failed read is VISIBLE, never silent', async () => {
    const delivery = { state: state({ stack: [SU_POSTURE_REFS.leader] }), stackBefore: [SU_POSTURE_REFS.member] };
    const rows = [
      { part_key: 'lead', body: 'LEADER RULE.', ordinal: 1, target_section: 'Fleet', stack_scope: ['blueprint:su.fleet-leader'] },
      { part_key: 'member', body: 'MEMBER RULE.', ordinal: 2, target_section: 'Fleet', stack_scope: ['blueprint:su.fleet-member'] },
    ];
    const sql = {
      unsafe: async (_q: string, params: unknown[]) => rows.filter((r) => r.stack_scope.some((t) => (params[3] as string[]).includes(t))),
    } as never;
    const layersOnly = await renderStackTransitionContextResult(delivery, opts);
    const withGuide = await renderStackTransitionContextResult(delivery, { ...opts, guide: { workspaceId: 'ws', harnessSlug: 'papercusp', client: 'claude', sql } });
    // Producer behaviour is unchanged: same layer text first, same flags.
    expect(withGuide.text.startsWith(layersOnly.text)).toBe(true);
    expect(withGuide.rendered).toBe(layersOnly.rendered);
    expect(withGuide.requiresFreshContext).toBe(layersOnly.requiresFreshContext);
    const guideText = withGuide.text.slice(layersOnly.text.length);
    expect(guideText).toContain('## Addressed guidance — now applies');
    expect(guideText).toContain('LEADER RULE.');
    expect(guideText).toContain('`member`');
    expect(guideText).not.toContain('MEMBER RULE.');

    const warnings: string[] = [];
    const failed = await renderStackTransitionContextResult(delivery, {
      ...opts,
      warn: (m) => warnings.push(m),
      guide: { workspaceId: 'ws', harnessSlug: 'papercusp', client: 'claude', sql: { unsafe: async () => { throw new Error('relation missing'); } } as never },
    });
    expect(failed.rendered).toBe(true);
    expect(failed.text.startsWith(layersOnly.text)).toBe(true);
    expect(failed.text).toContain('## Addressed guidance — could not be read');
    expect(failed.text).toContain('relation missing');
    expect(warnings.some((w) => w.includes('addressed guide not read'))).toBe(true);
  });

  it('P-003: an empty full-resync replaces previously addressed guide parts with the empty set', async () => {
    const rows = [
      { part_key: 'member', body: 'MEMBER RULE.', ordinal: 1, target_section: 'Fleet', stack_scope: ['blueprint:su.fleet-member'] },
    ];
    const sql = {
      unsafe: async (q: string, params: unknown[]) => q.includes('SELECT 1 AS present')
        ? [{ present: 1 }]
        : rows.filter((r) => r.stack_scope.some((t) => (params[3] as string[]).includes(t))),
    } as never;
    const result = await renderStackTransitionContextResult({ state: state() }, {
      ...opts,
      guide: { workspaceId: 'ws', harnessSlug: 'papercusp', client: 'claude', sql },
    });
    expect(result.rendered).toBe(true);
    expect(result.text).toContain('Addressed guidance — none for this session’s stack');
    expect(result.text).toContain('no longer applies');
    expect(result.text).not.toContain('MEMBER RULE.');
  });

  // portable-identity P-009 / D-022: a wearer's pack-doc keys move on a pack upgrade even
  // when no layer ref does, so the channel keys delivery on them too. Real-PG half:
  // blueprint/package-doc-resources.integration.test.ts.
  describe('P-009: package doc keys ride the same transition', () => {
    const KEY_1 = '1'.repeat(64);
    const KEY_2 = '2'.repeat(64);
    const rows = [
      { part_key: 'pack:procedures@1.0.0:first', body: 'V1 PROCEDURE.', ordinal: 100_000, target_section: 'Workflow', stack_scope: [`package:${KEY_1}`] },
      { part_key: 'pack:procedures@2.0.0:first', body: 'V2 PROCEDURE.', ordinal: 100_000, target_section: 'Workflow', stack_scope: [`package:${KEY_2}`] },
    ];
    const reads: unknown[][] = [];
    const guide = {
      workspaceId: 'ws', harnessSlug: 'papercusp', client: 'claude',
      sql: {
        unsafe: async (q: string, params: unknown[]) => {
          if (q.includes('SELECT 1 AS present')) return [{ present: 1 }];
          reads.push(params);
          const tokens = [...(params[3] as string[]), ...(params[5] as string[])];
          return rows.filter((r) => r.stack_scope.some((t) => tokens.includes(t)));
        },
      } as never,
    };
    const unmoved = { state: state({ stack: [SU_POSTURE_REFS.member] }), stackBefore: [SU_POSTURE_REFS.member] };

    it('an upgrade with NO layer move still delivers: the new version attaches, the old one is named', async () => {
      const out = await renderStackTransitionContextResult(unmoved, {
        ...opts, guide, packageResources: async () => ({ before: [KEY_1], after: [KEY_2] }),
      });
      expect(out.rendered).toBe(true);
      expect(out.text).not.toContain(blueprint.STACK_INJECTION_STAMP);
      expect(out.text).toContain('V2 PROCEDURE.');
      expect(out.text).not.toContain('V1 PROCEDURE.');
      expect(out.text).toContain('`pack:procedures@1.0.0:first`');
    });

    it('unchanged keys and an unmoved stack deliver nothing; no guide target means keys are never resolved', async () => {
      expect((await renderStackTransitionContextResult(unmoved, {
        ...opts, guide, packageResources: async () => ({ before: [KEY_1], after: [KEY_1] }),
      })).text).toBe('');
      let resolved = 0;
      expect((await renderStackTransitionContextResult(unmoved, {
        ...opts, packageResources: async () => { resolved += 1; return { before: [], after: [KEY_1] }; },
      })).text).toBe('');
      expect(resolved).toBe(0);
    });

    it('FULL-RESYNC with nothing bound still delivers a held package part — the same set a launch composes', async () => {
      reads.length = 0;
      const out = await renderStackTransitionContextResult({ state: state() }, {
        ...opts, guide, packageResources: async () => ({ before: [], after: [KEY_1] }),
      });
      expect(out.text).toContain('## Addressed guidance — the complete set');
      expect(out.text).toContain('V1 PROCEDURE.');
      expect(out.text).not.toContain('V2 PROCEDURE.');
      expect(reads.at(-1)![5]).toEqual([`package:${KEY_1}`]);
    });

    it('a key-resolution failure is VISIBLE in the delivered text, never a silent miss', async () => {
      const warnings: string[] = [];
      const out = await renderStackTransitionContextResult(unmoved, {
        ...opts, warn: (m) => warnings.push(m), guide,
        packageResources: async () => { throw new Error('installation read failed'); },
      });
      expect(out.rendered).toBe(true);
      expect(out.text).toContain('## Addressed guidance — could not be read');
      expect(out.text).toContain('package doc keys unavailable: installation read failed');
      expect(warnings.some((w) => w.includes('addressed guide not read'))).toBe(true);
    });
  });
});
