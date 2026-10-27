/**
 * Unit tests for the shared su persona RENDER
 * (stale-prompt-render-in-live-sessions-2026-08-02 P-002).
 *
 * These cover the pure half — overlay composition, launch-spec narrowing, and the
 * refresh path's separation from the launch render. The point of the module is that
 * ONE assembly serves both the launch and the respawn, so what is asserted here is
 * the contract both paths depend on.
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  applySuPromptOverlays,
  buildSuInstructionRuntime,
  parseSuLaunchSpecRecord,
  pinnedSuRecoveryPrompt,
  suPersonaRefreshPathFor,
  type SuLaunchSpecRecord,
} from './su-persona-render';
import { launchContextDir, launchContextPathFor } from './su-launch-context';
import { PSU_CACHE_BOUNDARY } from './inference-gateway/cache-policy';
import { compileLaunchSpecificationArtifact } from './role-launch-spec';

const runtime = buildSuInstructionRuntime({
  ownerId: 'su-test',
  autoMode: false,
  drainMode: false,
  fleet: null,
  workspaceId: 'ws',
  harnessSlug: 'papercusp',
  planSlug: null,
});

describe('applySuPromptOverlays — the one canonical overlay order', () => {
  it('appends provenance, then the mode section, then instruction precedence', async () => {
    const { promptText } = await applySuPromptOverlays({
      basePromptText: '# BASE PLAYBOOK\n',
      agent: 'claude',
      launchedBy: 'su-launcher-1',
      modeSection: '---\n## AUTO mode\n\nACT DO NOT ASK\n',
      instructionRuntime: runtime,
    });
    const iBase = promptText.indexOf('# BASE PLAYBOOK');
    const iProv = promptText.indexOf('## Provenance — who launched this session');
    const iMode = promptText.indexOf('## AUTO mode');
    const iPrec = promptText.indexOf('## Effective instruction precedence');
    for (const i of [iBase, iProv, iMode, iPrec]) expect(i).toBeGreaterThanOrEqual(0);
    // Order is load-bearing: it is exactly what a refreshed render must reproduce,
    // so a reordering here is a silent divergence between launch and respawn.
    expect(iBase).toBeLessThan(iProv);
    expect(iProv).toBeLessThan(iMode);
    expect(iMode).toBeLessThan(iPrec);
    expect(promptText).toContain('su-launcher-1');
    expect(promptText).toContain('to: ["human"] to reach the owner');
  });

  it('teaches the live fleet-leader fallback when the launcher session ends', async () => {
    const fleetRuntime = buildSuInstructionRuntime({
      ownerId: 'su-member',
      autoMode: true,
      drainMode: false,
      fleet: { slug: 'drain-crew', role: 'member' },
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      planSlug: 'drain-plan',
    });
    const { promptText } = await applySuPromptOverlays({
      basePromptText: '# BASE\n',
      agent: 'claude',
      launchedBy: 'su-ended-launcher',
      modeSection: '',
      instructionRuntime: fleetRuntime,
    });

    expect(promptText).toContain(
      'For live fleet coordination, report milestones, blockers, and anomalies with coord:send to ["@fleet-leader:drain-crew"]',
    );
    expect(promptText).toContain('Treat the launcher ID above as attribution only, not as the live fleet recipient');
    expect(promptText).not.toContain(
      'report milestones, blockers, and anomalies to them (coord:send) while live',
    );
    expect(promptText).toContain(
      'If that session ends, use coord:send with to: ["@fleet-leader:drain-crew"] to reach the current fleet leader',
    );
    expect(promptText).toContain('this selector survives session retirement and leadership rotation');
    expect(promptText).not.toContain('to: ["human"]');
  });

  it('omits provenance and the mode section when the session has neither', async () => {
    const { promptText } = await applySuPromptOverlays({
      basePromptText: '# BASE\n',
      agent: 'claude',
      launchedBy: null,
      modeSection: '',
      instructionRuntime: runtime,
    });
    expect(promptText).not.toContain('## Provenance');
    expect(promptText).not.toContain('## AUTO mode');
    // The precedence trace is unconditional — it is how an agent learns which
    // generic playbook clauses are suppressed RIGHT NOW.
    expect(promptText).toContain('## Effective instruction precedence');
  });

  it('renders byte-identical text for one runtime — no per-call variance (WI-7185)', async () => {
    // This is the property P-003 rests on: "a respawn's render equals a fresh render"
    // is only checkable if the assembly has NO hidden per-call variance.
    //
    // It did, briefly, and it cost the fleet a gate. `buildInstructionPrecedenceTrace`
    // falls back to `new Date()` when the runtime carries no `observedAt`
    // (instruction-lint.ts:337), so two renders differed whenever they straddled a
    // millisecond boundary. The first version of this test asserted exact equality
    // against that and red-pinned the green-checkpoint on 2026-08-02, with a diff whose
    // entire content was `…32.967Z` vs `…32.968Z` — then PASSED on the gate's isolation
    // re-run, which is the worst shape of flake: intermittent, and indistinguishable
    // from an infra wobble.
    //
    // The fix was at the source, not here: buildSuInstructionRuntime now stamps
    // `observedAt` ONCE at runtime construction, which is also the more truthful
    // reading of a field describing when the runtime was observed. So exact equality
    // is asserted DELIBERATELY — it is what pins that stamp in place. If someone drops
    // it and restores the per-render fallback, this test must fail rather than quietly
    // normalize the timestamp away and let the flake back onto the gate.
    const args = {
      basePromptText: '# BASE\n',
      agent: 'claude',
      launchedBy: 'su-x',
      modeSection: '---\n## DRAIN mode\n\nDRAIN\n',
      instructionRuntime: runtime,
    } as const;
    const a = await applySuPromptOverlays({ ...args });
    const b = await applySuPromptOverlays({ ...args });
    expect(a.promptText).toBe(b.promptText);
    expect(runtime.observedAt).toBeTruthy(); // the stamp this relies on
  });

  // token-efficiency-prompts-cache-and-behavior-2026-10-11 P-006 / R-2 / R-4.
  it('puts exactly one PSU_CACHE_BOUNDARY before every per-session section', async () => {
    const { promptText } = await applySuPromptOverlays({
      basePromptText: '# BASE PLAYBOOK\n',
      agent: 'claude',
      launchedBy: 'su-launcher-1',
      modeSection: '---\n## AUTO mode\n\nACT DO NOT ASK\n',
      instructionRuntime: runtime,
    });
    const iBoundary = promptText.indexOf(PSU_CACHE_BOUNDARY);
    expect(iBoundary).toBeGreaterThan(promptText.indexOf('# BASE PLAYBOOK'));
    expect(promptText.split(PSU_CACHE_BOUNDARY)).toHaveLength(2);
    for (const marker of ['## Provenance', '## AUTO mode', '## Effective instruction precedence']) {
      expect(promptText.indexOf(marker)).toBeGreaterThan(iBoundary);
    }
  });

  it('keeps an existing boundary (launch-context seam) and does not add a second', async () => {
    const base = `# BASE\n\n${PSU_CACHE_BOUNDARY}\n\n## Launch context\nplan x\n`;
    const { promptText } = await applySuPromptOverlays({
      basePromptText: base,
      agent: 'claude',
      launchedBy: 'su-l',
      modeSection: '',
      instructionRuntime: runtime,
    });
    expect(promptText.startsWith(base.replace(/\n+$/, ''))).toBe(true);
    expect(promptText.split(PSU_CACHE_BOUNDARY)).toHaveLength(2);
  });

  it('gives two owners a byte-identical stable prefix (cache-shareable)', async () => {
    const other = buildSuInstructionRuntime({
      ownerId: 'su-other-owner',
      autoMode: true,
      drainMode: false,
      fleet: null,
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      planSlug: 'p',
    });
    const render = (rt: typeof runtime, by: string) =>
      applySuPromptOverlays({ basePromptText: '# SAME PLAYBOOK\n', agent: 'claude', launchedBy: by, modeSection: '', instructionRuntime: rt });
    const [a, b] = await Promise.all([render(runtime, 'su-a'), render(other, 'su-b')]);
    const stable = (t: string) => t.slice(0, t.indexOf(PSU_CACHE_BOUNDARY));
    expect(stable(a.promptText)).toBe(stable(b.promptText));
    expect(a.promptText).not.toBe(b.promptText);
  });

  it('emits no boundary when PAPERCUSP_CACHE_SPLIT_BOUNDARY=0 (reversible cutover)', async () => {
    const prev = process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY;
    process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY = '0';
    try {
      const { promptText } = await applySuPromptOverlays({
        basePromptText: '# BASE\n',
        agent: 'claude',
        launchedBy: null,
        modeSection: '',
        instructionRuntime: runtime,
      });
      expect(promptText).not.toContain(PSU_CACHE_BOUNDARY);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY;
      else process.env.PAPERCUSP_CACHE_SPLIT_BOUNDARY = prev;
    }
  });

  it('lints the FINAL text, not the base playbook', async () => {
    // The overlays are exactly where generated-rule conflicts get introduced, so a
    // lint over spec.promptText alone would look clean while the shipped prompt is
    // not. Assert the report describes the composed document.
    const { instructionLint } = await applySuPromptOverlays({
      basePromptText: '# BASE\n',
      agent: 'claude',
      launchedBy: null,
      modeSection: '',
      instructionRuntime: runtime,
    });
    expect(instructionLint).toBeTruthy();
    expect(Array.isArray(instructionLint.conflicts)).toBe(true);
  });
});

describe('buildSuInstructionRuntime', () => {
  it('routes to the fleet and carries both AUTO and DRAIN when draining', () => {
    const r = buildSuInstructionRuntime({
      ownerId: 'su-1',
      autoMode: true,
      drainMode: true,
      fleet: { slug: 'ops', role: 'leader' },
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      planSlug: 'p',
    });
    expect(r.modes).toEqual(['auto', 'drain']);
    expect(r.route).toEqual({ kind: 'fleet', fleet: 'ops', role: 'leader' });
    expect(r.scope).toEqual({ workspace: 'ws', harness: 'papercusp', plan: 'p', items: [] });
  });

  it('treats fleet membership itself as AUTO, and a solo non-auto launch as neither', () => {
    // A fleet member has no human at its keyboard — that is why membership alone
    // implies AUTO, independent of the --auto flag.
    expect(
      buildSuInstructionRuntime({
        ownerId: 'su-1', autoMode: false, drainMode: false,
        fleet: { slug: 'ops', role: 'member' },
        workspaceId: 'ws', harnessSlug: null, planSlug: null,
      }).modes,
    ).toEqual(['auto']);
    const solo = buildSuInstructionRuntime({
      ownerId: 'su-1', autoMode: false, drainMode: false, fleet: null,
      workspaceId: 'ws', harnessSlug: null, planSlug: null,
    });
    expect(solo.modes).toEqual([]);
    expect(solo.route).toEqual({ kind: 'self' });
  });

  it('lets a live registry mode override the launch snapshot', () => {
    const live = buildSuInstructionRuntime({
      ownerId: 'su-1', autoMode: false, drainMode: false,
      fleet: null, workspaceId: 'ws', harnessSlug: null, planSlug: null,
      activeModes: ['auto'], modeResolution: 'registry',
    });
    expect(live.modes).toEqual(['auto']);
    expect(live.modeResolution).toBe('registry');
  });

  it('preserves an unavailable registry state instead of presenting it as empty', () => {
    const unavailable = buildSuInstructionRuntime({
      ownerId: 'su-1', autoMode: false, drainMode: false,
      fleet: null, workspaceId: 'ws', harnessSlug: null, planSlug: null,
      modeResolution: 'unavailable',
    });
    expect(unavailable.modeResolution).toBe('unavailable');
  });
});

describe('parseSuLaunchSpecRecord', () => {
  const good: SuLaunchSpecRecord = {
    v: 1,
    agent: 'claude',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    profile: 'engineer',
    contextSize: 'trimmed',
    personaTier: 'full',
    model: null,
    planSlug: 'plan-x',
    launchedBy: null,
    autoMode: true,
    drainMode: false,
    loopArmed: true,
    headless: true,
    fleet: { slug: 'ops', role: 'member' },
    stack: [],
  };

  it('round-trips a well-formed record through JSON (how it actually arrives)', () => {
    expect(parseSuLaunchSpecRecord(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it('retains the Codex SQLite receipt through persona parsing and refresh', () => {
    const record = { ...good, agent: 'codex', codexSqliteHome: '/launch-state/session-123' };
    expect(parseSuLaunchSpecRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('retains the launch-selected provenance directory without inventing a legacy binding', () => {
    const record = { ...good, turnProvenanceDir: '/launch-state/workspace-a/turn-provenance' };
    expect(parseSuLaunchSpecRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(parseSuLaunchSpecRecord(good)).not.toHaveProperty('turnProvenanceDir');
  });

  it('retains an exact named selection pin and rejects malformed pins', () => {
    const selectedIdentity = { ref: 'composition:review-suite', sourceRevision: 'a'.repeat(64) };
    expect(parseSuLaunchSpecRecord({ ...good, stack: ['domain:review-domain'], selectedIdentity }))
      .toMatchObject({ selectedIdentity });
    expect(parseSuLaunchSpecRecord({ ...good, selectedIdentity: {
      ref: 'composition:review-suite', sourceRevision: 'stale',
    } })).toBeNull();
  });

  it('retains the authenticated principal and only an artifact matching its declared revision', () => {
    const revision = 'a'.repeat(64);
    const artifact = { schemaVersion: 1, specificationRevision: revision } as never;
    expect(parseSuLaunchSpecRecord({
      ...good, principalId: 'system:operator', specificationRevision: revision,
      stateRevision: 'state-1', specificationArtifact: artifact,
    })).toMatchObject({ principalId: 'system:operator', specificationArtifact: artifact });
    expect(parseSuLaunchSpecRecord({
      ...good, specificationRevision: revision,
      specificationArtifact: { specificationRevision: 'b'.repeat(64) },
    })).not.toHaveProperty('specificationArtifact');
  });

  it('refuses anything it cannot vouch for rather than half-reading it', () => {
    // Every rejection below fail-softs the caller to the inherited render — the
    // right outcome. Guessing at an unrecognised shape would ship a prompt built
    // from misread inputs into a live session, which is worse than staleness.
    expect(parseSuLaunchSpecRecord(null)).toBeNull();
    expect(parseSuLaunchSpecRecord('nope')).toBeNull();
    expect(parseSuLaunchSpecRecord({})).toBeNull();
    expect(parseSuLaunchSpecRecord({ ...good, v: 2 })).toBeNull();
    expect(parseSuLaunchSpecRecord({ ...good, agent: '' })).toBeNull();
    expect(parseSuLaunchSpecRecord({ ...good, workspaceId: undefined })).toBeNull();
  });

  it('defaults the booleans to FALSE rather than truthy, and profile to engineer', () => {
    // A missing autoMode must not accidentally bake an AUTO directive into a
    // session that never asked for one.
    const bare = parseSuLaunchSpecRecord({ v: 1, agent: 'claude', workspaceId: 'ws' });
    expect(bare).toMatchObject({
      autoMode: false, drainMode: false, loopArmed: false,
      profile: 'engineer', fleet: null, planSlug: null, harnessSlug: null,
    });
    expect(bare).not.toHaveProperty('headless');
  });
});

describe('pinnedSuRecoveryPrompt', () => {
  it('replays the exact prior instruction bytes and refuses a tampered artifact', async () => {
    const launch = await compileLaunchSpecificationArtifact({
      promptText: 'PINNED V1 INSTRUCTIONS', cwd: '/tmp', role: 'su',
      stack: [], state: { schemaVersion: 1 },
    });
    const record = parseSuLaunchSpecRecord({
      v: 1, agent: 'codex', workspaceId: 'ws',
      selectedIdentity: { ref: 'domain:research', sourceRevision: 'a'.repeat(64) },
      specificationRevision: launch.specificationRevision,
      specificationArtifact: launch.specificationArtifact,
    });
    expect(record).not.toBeNull();
    expect(pinnedSuRecoveryPrompt(record!)).toEqual({
      promptText: 'PINNED V1 INSTRUCTIONS', specificationRevision: launch.specificationRevision,
    });
    const ordinary = { ...record!, selectedIdentity: undefined };
    expect(pinnedSuRecoveryPrompt(ordinary)).toBeNull();
    expect(pinnedSuRecoveryPrompt(ordinary, { allowUnselected: true })).toEqual({
      promptText: 'PINNED V1 INSTRUCTIONS', specificationRevision: launch.specificationRevision,
    });
    expect(pinnedSuRecoveryPrompt({ ...ordinary, specificationArtifact: undefined },
      { allowUnselected: true })).toBeNull();
    expect(() => pinnedSuRecoveryPrompt({ ...ordinary, specificationRevision: 'b'.repeat(64) },
      { allowUnselected: true })).toThrow('does not match the launch receipt');
    expect(() => pinnedSuRecoveryPrompt({
      ...record!, specificationArtifact: {
        ...launch.specificationArtifact,
        inputs: [...launch.specificationArtifact.inputs, { kind: 'unknown' }],
      } as never,
    })).toThrow();
  });
});

describe('suPersonaRefreshPathFor', () => {
  it('is NEVER the launch render path — the fail-soft fallback must stay intact', () => {
    // This is the structural reason the refresh writes somewhere new: on any
    // failure the respawn keeps the inherited --system-prompt-file, so that file
    // has to remain known-good. Rewriting it in place would destroy the fallback at
    // exactly the moment a bad render made the fallback necessary.
    const owner = 'su-0228816f-1d81-45fd-8832-71c771fecc99';
    expect(suPersonaRefreshPathFor(owner)).not.toBe(launchContextPathFor(owner));
    expect(suPersonaRefreshPathFor(owner)).not.toBe(launchContextPathFor('14416'));
  });

  it('is deterministic per owner, so respawns overwrite instead of accumulating files', () => {
    const owner = 'su-abc';
    expect(suPersonaRefreshPathFor(owner)).toBe(suPersonaRefreshPathFor(owner));
    expect(suPersonaRefreshPathFor(owner)).toBe(join(launchContextDir(), 'session-refresh-su-abc.md'));
  });

  it('sanitizes an owner id into a safe single filename', () => {
    const p = suPersonaRefreshPathFor('su/../../etc/passwd');
    expect(p.startsWith(launchContextDir())).toBe(true);
    expect(p).toBe(join(launchContextDir(), 'session-refresh-su_.._.._etc_passwd.md'));
  });
});
