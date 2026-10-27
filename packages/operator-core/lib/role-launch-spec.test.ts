/**
 * Unit tests for buildRoleLaunchSpec (agent-launch-unification P-003).
 * Mocks the two shared leaves (assembleRolePrompt + signSpawnParams) so
 * the test asserts the COMPOSITION + the role-scoped signed-URL shape,
 * not the leaves' internals (those have their own tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionConfinementResolver } from './capability-envelope/session-confinement-port';

const assembleRolePromptMock = vi.fn();
const tagTurnForInjectionMock = vi.fn(({ text, sid, origin }: { text: string; sid: string; origin: string }) => ({
  taggedText: text,
  envelope: `⟦turn-origin:${origin} nonce:testnonce12345678⟧`,
  nonce: 'testnonce12345678',
  origin,
  ledgerWritten: true,
}));
const resolvePromptFileMock = vi.fn((_ctx: unknown, role: string): string | null =>
  role === 'planner' ? '/h/prompts/planner.md' : null,
);
const resolvePromptFilesMock = vi.fn((_ctx: unknown, role: string): string[] => {
  const file = resolvePromptFileMock(_ctx, role);
  return file ? [file] : [];
});

vi.mock('@papercusp/orchestrator/role-prompt', () => ({
  assembleRolePrompt: (...args: unknown[]) => assembleRolePromptMock(...args),
  resolvePromptFile: (...args: unknown[]) => resolvePromptFileMock(...(args as [unknown, string])),
  resolvePromptFiles: (...args: unknown[]) => resolvePromptFilesMock(...(args as [unknown, string])),
}));
// Partial mock: pin `harnessRoot` and keep every other export real — the module graph under
// test reaches the blueprint loader (`harnessRootCandidates`, `harnessPath`) through the
// orchestrator's prompt-resolve → render-stack seam (identities-v1 P-003), and a full
// replacement mock would fail collection on the first export it did not list.
vi.mock('@papercusp/harness/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/harness/paths')>()),
  harnessRoot: vi.fn(() => '/h'),
}));
// The chat-surface prompts dir for the workspace-level (harness-less) role
// branch — pointed at a temp dir each test writes persona files into.
let promptsDirValue = '/nonexistent-prompts';
vi.mock('./prompt-assembly', async (importOriginal) => ({
  // P-022: the addressed-guide composer runs the REAL budget seam (projectGuideAtBudget)
  // through this module; only promptsDir is stubbed.
  ...(await importOriginal<typeof import('./prompt-assembly')>()),
  promptsDir: () => promptsDirValue,
}));
// Deterministic signer: append a fixed exp+sig so the URL is assertable.
vi.mock('./spawn-signing', () => ({
  signSpawnParams: vi.fn(async (params: URLSearchParams) => {
    params.set('exp', '9999999999');
    params.set('sig', 'TESTSIG');
    return { exp: 9999999999, sig: 'TESTSIG' };
  }),
}));
vi.mock('./turn-provenance/turn-provenance', () => ({
  tagTurnForInjection: (...args: unknown[]) => tagTurnForInjectionMock(...(args as [{ text: string; sid: string; origin: string }])),
}));
vi.mock('./spawn-config', () => ({
  resolveProjectDir: vi.fn(async (slug: string) => `/registry/${slug}`),
}));
// su-branch leaves: the playbook renderer, the token reader, and the
// workspace-root resolver. Mocked so the su tests assert the COMPOSITION
// (cwd + launch-context append + superuser MCP shape), not the leaves —
// renderSuPlaybook's real splice has its own coverage in papercusp-files.test.ts.
const renderSuPlaybookMock = vi.fn(async (..._args: unknown[]) => ({
  text: 'SU PLAYBOOK BODY',
  baseSource: '/prompts/papercusp-su-engineer.tools.md',
  overlaySource: '/prompts/papercusp-su.claude.md',
}));
vi.mock('./desktop-install/papercusp-files', () => ({
  renderSuPlaybook: (...args: unknown[]) => renderSuPlaybookMock(...args),
}));
vi.mock('./superuser-token', () => ({
  readSuperuserToken: vi.fn(() => 'TESTTOKEN'),
}));
// Workspace-scoped root resolver: echo the workspace id so the test asserts
// cwd is derived from the SELECTED workspace, not a global value.
vi.mock('./papercusp-root', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./papercusp-root')>()),
  papercuspPathForWorkspace: vi.fn((ws: string) => `/ws-root/${ws}`),
}));

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildRoleLaunchSpec,
  mintRoleLaunchIdentity,
  buildLaunchSpec,
  compileLaunchSpecificationArtifact,
  resolveLaunchIdentityModelDefault,
  SU_EXTRA_MCP_TOOL_NAMES,
  stewardSeedToolNames,
  SuInstancePromptDriftError,
  reconcilePapercuspSuInstanceOverride,
  verifyPapercuspSuInstanceOverride,
} from './role-launch-spec';

// WI-2140338: switchable partial mock of the projected-tool registry read, so the
// steward-seed tests are deterministic regardless of what this test process has
// registered. `listings: null` ⇒ passthrough to the real registry.
const stewardMockState = vi.hoisted(() => ({ listings: null as null | { name: string }[] }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const realList = real.listMcpProjections as (...a: unknown[]) => { name: string }[];
  return {
    ...real,
    listMcpProjections: (...args: unknown[]) => stewardMockState.listings ?? realList(...args),
  };
});

describe('Papercusp su instance override source guard', () => {
  it('accepts the decoded tenant-scoped store value and rejects JSON-encoded or stale text', () => {
    const root = mkdtempSync(join(tmpdir(), 'su-instance-override-'));
    try {
      const sourcePath = join(root, 'pot-instances', 'papercup-pot.su.md');
      const source = 'Papercusp su override\nUnicode → and a "quote".\n';
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, source);
      const input = {
        workspaceId: 'papercusp-workspace',
        potSlug: 'papercusp',
        promptsDirectory: root,
        storedOverride: source,
      };

      expect(() => verifyPapercuspSuInstanceOverride(input)).not.toThrow();
      expect(() => verifyPapercuspSuInstanceOverride({ ...input, storedOverride: JSON.stringify(source) })).toThrow(
        SuInstancePromptDriftError,
      );
      expect(() => verifyPapercuspSuInstanceOverride({ ...input, storedOverride: 'stale' })).toThrow(
        /re-seed promptOverride\.su/,
      );
      expect(() => verifyPapercuspSuInstanceOverride({ ...input, storedOverride: null })).toThrow(
        SuInstancePromptDriftError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not compare another tenant or pot against Papercusp source', () => {
    const input = {
      workspaceId: 'another-workspace',
      potSlug: 'papercusp',
      promptsDirectory: undefined,
      storedOverride: null,
    };
    expect(() => verifyPapercuspSuInstanceOverride(input)).not.toThrow();
    expect(() =>
      verifyPapercuspSuInstanceOverride({ ...input, workspaceId: 'papercusp-workspace', potSlug: 'other-pot' }),
    ).not.toThrow();
  });
});

// WI-10005774: the launch must reconcile a store that is merely BEHIND the canonical source
// (the Claude-only edit hook cannot see Codex/OMP/sed/git-merge edits) while every case it
// cannot safely heal still fails closed.
describe('reconcilePapercuspSuInstanceOverride (launch-time self-heal)', () => {
  const SOURCE = 'Papercusp su override\nline two → ok.\n';
  const withSource = async (
    sourceText: string | null,
    run: (promptsDirectory: string) => Promise<void>,
  ): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), 'su-instance-reconcile-'));
    try {
      if (sourceText !== null) {
        const sourcePath = join(root, 'pot-instances', 'papercup-pot.su.md');
        mkdirSync(dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, sourceText);
      }
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const base = { workspaceId: 'papercusp-workspace', potSlug: 'papercusp' };

  it('re-seeds a STALE store from the source, returns the source, and reports the heal', async () => {
    await withSource(SOURCE, async (promptsDirectory) => {
      const reseed = vi.fn(async () => {});
      const onHeal = vi.fn();
      const out = await reconcilePapercuspSuInstanceOverride({
        ...base,
        promptsDirectory,
        storedOverride: 'stale text',
        reseed,
        onHeal,
      });
      expect(out).toBe(SOURCE);
      expect(reseed).toHaveBeenCalledTimes(1);
      expect(reseed).toHaveBeenCalledWith(SOURCE);
      expect(onHeal).toHaveBeenCalledTimes(1);
    });
  });

  it('heals a store that was never seeded (null) the same way', async () => {
    await withSource(SOURCE, async (promptsDirectory) => {
      const reseed = vi.fn(async () => {});
      await expect(
        reconcilePapercuspSuInstanceOverride({ ...base, promptsDirectory, storedOverride: null, reseed }),
      ).resolves.toBe(SOURCE);
      expect(reseed).toHaveBeenCalledWith(SOURCE);
    });
  });

  it('does NOT write when the store already matches the source', async () => {
    await withSource(SOURCE, async (promptsDirectory) => {
      const reseed = vi.fn(async () => {});
      const onHeal = vi.fn();
      const out = await reconcilePapercuspSuInstanceOverride({
        ...base,
        promptsDirectory,
        storedOverride: SOURCE,
        reseed,
        onHeal,
      });
      expect(out).toBe(SOURCE);
      expect(reseed).not.toHaveBeenCalled();
      expect(onHeal).not.toHaveBeenCalled();
    });
  });

  it('stays FAIL-CLOSED when the re-seed itself fails (reason reseed-failed, store untouched)', async () => {
    await withSource(SOURCE, async (promptsDirectory) => {
      const reseed = vi.fn(async () => {
        throw new Error('pg down');
      });
      const err = await reconcilePapercuspSuInstanceOverride({
        ...base,
        promptsDirectory,
        storedOverride: 'stale',
        reseed,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SuInstancePromptDriftError);
      expect((err as SuInstancePromptDriftError).reason).toBe('reseed-failed');
      expect((err as SuInstancePromptDriftError).message).toMatch(/self-heal re-seed FAILED: pg down/);
    });
  });

  it('never CLEARS the override from a blank source — fail-closed, no write', async () => {
    await withSource('  \n', async (promptsDirectory) => {
      const reseed = vi.fn(async () => {});
      await expect(
        reconcilePapercuspSuInstanceOverride({ ...base, promptsDirectory, storedOverride: 'stale', reseed }),
      ).rejects.toBeInstanceOf(SuInstancePromptDriftError);
      expect(reseed).not.toHaveBeenCalled();
    });
  });

  it('stays FAIL-CLOSED with no write when the source is unreadable or the directory is unavailable', async () => {
    await withSource(null, async (promptsDirectory) => {
      const reseed = vi.fn(async () => {});
      const unreadable = await reconcilePapercuspSuInstanceOverride({
        ...base,
        promptsDirectory,
        storedOverride: 'stale',
        reseed,
      }).catch((e: unknown) => e);
      expect(unreadable).toBeInstanceOf(SuInstancePromptDriftError);
      expect((unreadable as SuInstancePromptDriftError).reason).toBe('source-unavailable');
      const noDir = await reconcilePapercuspSuInstanceOverride({
        ...base,
        promptsDirectory: undefined,
        storedOverride: 'stale',
        reseed,
      }).catch((e: unknown) => e);
      expect(noDir).toBeInstanceOf(SuInstancePromptDriftError);
      expect(reseed).not.toHaveBeenCalled();
    });
  });

  it('leaves another tenant / pot untouched (returns the stored value, no write)', async () => {
    const reseed = vi.fn(async () => {});
    await expect(
      reconcilePapercuspSuInstanceOverride({
        workspaceId: 'another-workspace',
        potSlug: 'papercusp',
        promptsDirectory: undefined,
        storedOverride: 'whatever',
        reseed,
      }),
    ).resolves.toBe('whatever');
    expect(reseed).not.toHaveBeenCalled();
  });
});
import { resolveProjectDir } from './spawn-config';
import { readSuperuserToken } from './superuser-token';
// su-context-size-variants (WI-1282): the always-loaded core spine the codex
// 'trimmed' variant advertises via ?tools=. NOT mocked — the test pins the
// URL's tools= param to the REAL exported list so the two can't drift.
import { CORE_MCP_TOOL_NAMES } from '@papercusp/orchestrator';
// The SHARED launch-mechanics keying helper — the SAME module invoke.ts
// (orchestrator launch) + wake-executor (resume) import. Asserting the spec's
// dirs equal these proves "one HOW" across launch paths (P-005). NOT mocked.
import { sessionClaudeConfigDir, sessionMcpDir } from '@papercusp/orchestrator/session-launch-dirs';

beforeEach(() => {
  vi.clearAllMocks();
  assembleRolePromptMock.mockReturnValue({
    text: 'WORKER PROMPT BODY',
    meta: {
      role: 'worker',
      promptFile: '/h/prompts/worker.md',
      projectDir: '/proj/papercup',
      stateDir: '/proj/papercup/.papercusp',
      harnessDir: '/h',
      runId: 'worker-F-001-123',
    },
  });
});

describe('buildRoleLaunchSpec', () => {
  it.each([
    ['direct host', 'http://127.0.0.1:9071', '3070', '3271'],
    ['same-host proxy', 'http://127.0.0.1:9271', '3271', '9271'],
  ])('preserves an explicit spawn-host role route through signed MCP composition (%s)', async (_name, proxy, targetPort, expectedPort) => {
    vi.stubEnv('PAPERCUSP_HONO_PORT', '3271');
    vi.stubEnv('PAPERCUSP_BG_HOST_AGENTS_MCP_BASE', 'http://127.0.0.1:9071');
    vi.stubEnv('PAPERCUSP_MCP_PROXY_BASE', proxy);
    vi.stubEnv('PAPERCUSP_MCP_PROXY_TARGET_PORT', targetPort);
    try {
      const input = { role: 'worker', workspaceId: 'default', harnessSlug: 'papercup',
        operatorBaseUrl: 'http://localhost:3271', featureId: 'F-001' };
      const ordinary = await buildRoleLaunchSpec(input);
      const pinned = await buildRoleLaunchSpec({ ...input, mcpTarget: 'spawn-host' });
      expect(new URL(ordinary.mcpUrl).port).toBe('9071');
      expect(new URL(pinned.mcpUrl).port).toBe(expectedPort);
      expect(pinned.mcpTarget).toBe('spawn-host');
      const url = new URL(pinned.mcpUrl);
      expect(url.searchParams.get('client')).toBe(pinned.sid);
      expect(url.searchParams.get('role')).toBe('worker');
      expect(url.searchParams.get('sig')).toBeTruthy();
      expect(JSON.parse(pinned.mcpJsonContents).mcpServers.papercusp.url).toBe(pinned.mcpUrl);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('composes assembleRolePrompt + a signed role-scoped MCP URL', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      featureId: 'F-001',
    });

    expect(spec.specificationRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.specificationArtifact.specificationRevision).toBe(spec.specificationRevision);
    expect(spec.stateRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(spec.compositionSource).toBe('compatibility');

    // prompt comes from the shared assembler, in chat mode, WITH the
    // in-process workspace-aware projectDir (so the assembler skips its
    // workspace-blind lookupProjectDir / curl-to-:3055 fallback).
    expect(assembleRolePromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'papercup',
        role: 'worker',
        mode: 'chat',
        featureId: 'F-001',
        projectDir: '/registry/papercup',
      }),
    );
    expect(tagTurnForInjectionMock).toHaveBeenCalledWith({
      sid: spec.sid,
      origin: 'role-prompt',
      text: 'WORKER PROMPT BODY',
    });
    expect(spec.promptText).toBe('WORKER PROMPT BODY');
    expect(spec.runId).toBe('worker-F-001-123');
    expect(spec.cwd).toBe('/proj/papercup');

    // The MCP URL is role-scoped (role=worker, NOT ?superuser=1) + signed
    // + carries the feature/harness/workspace the dispatch layer checks.
    const u = new URL(spec.mcpUrl);
    expect(u.pathname).toBe('/api/mcp');
    expect(u.searchParams.get('role')).toBe('worker');
    expect(u.searchParams.get('harness')).toBe('papercup');
    expect(u.searchParams.get('workspace')).toBe('default');
    expect(u.searchParams.get('feature')).toBe('F-001');
    expect(u.searchParams.get('spawn')).toBe(spec.spawnId);
    expect(u.searchParams.get('sig')).toBe('TESTSIG');
    expect(u.searchParams.has('superuser')).toBe(false);
    // WI-6554700010009993: role sessions (judges, workers) ask for the trimmed payload tier.
    // Without it every call resolved to the unshaped 'full' tier.
    expect(u.searchParams.get('ctx_tier')).toBe('trimmed');

    // .mcp.json wraps the same URL.
    const mcp = JSON.parse(spec.mcpJsonContents);
    expect(mcp.mcpServers.papercusp.url).toBe(spec.mcpUrl);
    expect(mcp.mcpServers.papercusp.type).toBe('http');

    // Launch invariants the primitive now produces (unify-launch-mechanics P-002).
    expect(spec.sid).toMatch(/^role-/);
    expect(spec.nativeSessionId).toBeTruthy();
    expect(spec.nativeSessionId).not.toBe(spec.sid);
    // EI-4: the MCP url's client= IS the minted sid (URL owner === PAPERCUSP_SID).
    expect(u.searchParams.get('client')).toBe(spec.sid);
    // Per-session dirs are keyed by the sid via the SHARED helper — byte-for-byte
    // the same path the orchestrator launch (invoke.ts) + the wake-executor resume
    // leg compute for that owner. This is the P-005 "one HOW" guarantee: launch
    // and resume can't drift because they call the same function.
    expect(spec.claudeConfigDir).toBe(sessionClaudeConfigDir(spec.sid));
    expect(spec.sessionMcpDir).toBe(sessionMcpDir(spec.sid));
  });

  it('loads a real blueprint roles[].stack default and lets an explicit stack override it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-launch-blueprint-'));
    const identityDir = join(dir, '.papercusp', 'blueprints', 'fixture-domain');
    const recipeDir = join(dir, 'home', 'recipes', 'launch-recipe');
    mkdirSync(join(identityDir, 'prompts'), { recursive: true });
    mkdirSync(recipeDir, { recursive: true });
    mkdirSync(join(dir, '.papercusp'), { recursive: true });
    vi.stubEnv('PAPERCUSP_HOME', join(dir, 'home'));
    writeFileSync(join(recipeDir, 'recipe.json'), JSON.stringify({
      id: 'launch-recipe', title: 'Launch recipe', script: 'return 1',
    }));
    writeFileSync(join(recipeDir, 'listing.json'), JSON.stringify({ version: '1.0.0' }));
    writeFileSync(
      join(identityDir, 'blueprint.yaml'),
      [
        'id: fixture-domain',
        'version: 1.0.0',
        'description: Fixture domain identity.',
        'slots:',
        '  - slot: domain',
        'bundles:',
        '  - kind: recipe',
        '    ref: launch-recipe',
        '    version: 1.0.0',
        'knobs:',
        '  aiBackend:',
        '    default:',
        '      model: selected-domain-model',
        '',
      ].join('\n'),
    );
    writeFileSync(join(identityDir, 'prompts', 'domain.md'), 'FIXTURE DOMAIN IDENTITY\n');
    writeFileSync(
      join(dir, '.papercusp', 'blueprint.yaml'),
      [
        'id: fixture-pot',
        'extends: base',
        'kind: pot',
        'version: 1.0.0',
        'description: Runnable fixture pot.',
        'workItem:',
        '  kind: feature',
        '  idPrefix: WI',
        'spine:',
        '  decider: worker',
        '  claimModel: self-claim-priority',
        '  default: { to: idle }',
        'roles:',
        '  - id: worker',
        '    description: Fixture worker.',
        '    stack:',
        '      - domain:fixture-domain',
        '',
      ].join('\n'),
    );

    try {
      const fromDefault = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL',
        cwd: dir,
        workspaceId: 'fixture-workspace',
        harnessSlug: 'fixture',
        role: 'worker',
        state: { schemaVersion: 1 },
        renderStack: true,
      });
      expect(await resolveLaunchIdentityModelDefault({ cwd: dir, harnessSlug: 'fixture', role: 'worker' }))
        .toBe('selected-domain-model');
      await expect(compileLaunchSpecificationArtifact({ promptText: 'ROLE KERNEL', cwd: dir,
        workspaceId: 'fixture-workspace', harnessSlug: 'fixture', role: 'worker',
        expectedModelDefault: 'changed-after-preflight', state: { schemaVersion: 1 } }))
        .rejects.toThrow('selected identity model default changed after launch preflight');
      expect(fromDefault.compositionSource).toBe('blueprint');
      expect(fromDefault.stack).toEqual(['domain:fixture-domain']);
      expect(fromDefault.promptText.indexOf('FIXTURE DOMAIN IDENTITY')).toBeLessThan(
        fromDefault.promptText.indexOf('ROLE KERNEL'),
      );
      expect(fromDefault.specificationArtifact.configuration.roles?.[0]?.stack).toEqual([
        'domain:fixture-domain',
      ]);
      expect(fromDefault.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'package', packageKind: 'recipe', ref: 'launch-recipe',
      }));
      expect(fromDefault.specificationArtifact.configuration.knobs?.aiBackend?.default?.model)
        .toBe('selected-domain-model');
      expect(fromDefault.resourceArtifacts).toHaveLength(1);

      const explicitEmpty = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL',
        cwd: dir,
        workspaceId: 'fixture-workspace',
        harnessSlug: 'fixture',
        role: 'worker',
        stack: [],
        state: { schemaVersion: 1 },
        renderStack: true,
      });
      expect(explicitEmpty.compositionSource).toBe('blueprint');
      expect(explicitEmpty.stack).toEqual([]);
      expect(explicitEmpty.promptText).toBe('ROLE KERNEL');
      expect(explicitEmpty.resourceArtifacts).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces an inherited exclusive domain while retaining the pot source and configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-launch-domain-replacement-'));
    const blueprintDir = join(dir, '.papercusp', 'blueprints');
    try {
      mkdirSync(join(blueprintDir, 'first-domain'), { recursive: true });
      mkdirSync(join(blueprintDir, 'second-domain'), { recursive: true });
      writeFileSync(join(blueprintDir, 'first-domain', 'blueprint.yaml'), [
        'id: first-domain', 'extends: base', 'version: 1.0.0',
        'slots:', '  - slot: domain',
        'knobs:', '  aiBackend:', '    default:', '      model: original-model', '',
      ].join('\n'));
      writeFileSync(join(blueprintDir, 'second-domain', 'blueprint.yaml'), [
        'id: second-domain', 'extends: base', 'version: 1.0.0',
        'slots:', '  - slot: domain',
        'knobs:', '  aiBackend:', '    default:', '      model: selected-model', '',
      ].join('\n'));
      mkdirSync(join(dir, '.papercusp'), { recursive: true });
      writeFileSync(join(dir, '.papercusp', 'blueprint.yaml'), [
        'id: fixture-pot', 'extends: first-domain', 'kind: pot', 'version: 1.0.0',
        'workItem:', '  kind: feature', '  idPrefix: WI',
        'spine:', '  decider: su', '  claimModel: self-claim-priority',
        '  default: { to: idle }',
        'roles:', '  - id: su', '    description: Fixture su.', '',
      ].join('\n'));

      const selected = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: dir, workspaceId: 'fixture-workspace',
        harnessSlug: 'fixture', role: 'su', stack: ['domain:second-domain'],
        state: { schemaVersion: 1 },
      });
      expect(selected.specificationArtifact.configuration.workItem?.idPrefix).toBe('WI');
      expect(selected.specificationArtifact.configuration.spine?.decider).toBe('su');
      expect(selected.specificationArtifact.configuration.knobs?.aiBackend?.default?.model)
        .toBe('selected-model');
      expect(selected.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'fixture-pot',
      }));
      expect(selected.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'second-domain',
      }));
      expect(selected.specificationArtifact.inputs).not.toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'first-domain',
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // WI-10004747: a workspace-level su has no materialized blueprint, so it compiles from the
  // compatibility adapter, yet its persona always composes SU_STATIC_LAYERS (the seal names
  // domain:papercusp-engineer). Shadow metering prices identity only from SLOTTED
  // blueprint-layer inputs, so an artifact that omitted them priced ~900 sessions as
  // inferred-profile. The su callers pass impliedStack:'su-static'; whatever the render
  // composes for the domain slot must be recorded, and an implied layer must never displace
  // a slot the source or the explicit stack already holds.
  it('records the su static layers that the source and explicit stack leave empty', async () => {
    const { SU_STATIC_LAYERS } = await import('@papercusp/orchestrator/blueprint');
    const staticDomain = SU_STATIC_LAYERS.find((layer) => layer.slot === 'domain');
    expect(staticDomain, 'the su persona composes a static domain layer').toBeDefined();
    const slotted = (inputs: readonly unknown[]) => inputs.flatMap((raw) => {
      const entry = raw as { kind?: string; ref?: string; document?: { slots?: Array<{ slot: string }> } };
      const slots = entry.document?.slots ?? [];
      return entry.kind === 'blueprint-layer' && slots.length > 0
        ? slots.map((slot) => `${slot.slot}:${String(entry.ref)}`) : [];
    });
    const workspaceDir = mkdtempSync(join(tmpdir(), 'su-implied-workspace-'));
    const potDir = mkdtempSync(join(tmpdir(), 'su-implied-pot-'));
    try {
      const workspaceLevel = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: workspaceDir, workspaceId: 'fixture-workspace',
        harnessSlug: null, role: 'su', stack: [], impliedStack: 'su-static',
        state: { schemaVersion: 1 },
      });
      expect(workspaceLevel.compositionSource).toBe('compatibility');
      expect(workspaceLevel.stack).toEqual([]);
      expect(workspaceLevel.promptText).toBe('SU KERNEL');
      expect(slotted(workspaceLevel.specificationArtifact.inputs))
        .toContain(`domain:${staticDomain!.id}`);
      // Without the implied stack the same launch records no slotted layer (the defect).
      const unmarked = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: workspaceDir, workspaceId: 'fixture-workspace',
        harnessSlug: null, role: 'su', stack: [], state: { schemaVersion: 1 },
      });
      expect(slotted(unmarked.specificationArtifact.inputs)).toEqual([]);
      expect(workspaceLevel.specificationRevision).not.toBe(unmarked.specificationRevision);
      await expect(resolveLaunchIdentityModelDefault({ cwd: workspaceDir, harnessSlug: null,
        role: 'su', stack: [], impliedStack: 'su-static' })).resolves.toBeNull();

      const blueprintDir = join(potDir, '.papercusp', 'blueprints');
      for (const id of ['pot-domain', 'chosen-domain']) {
        mkdirSync(join(blueprintDir, id), { recursive: true });
        writeFileSync(join(blueprintDir, id, 'blueprint.yaml'), [
          `id: ${id}`, 'extends: base', 'version: 1.0.0', 'slots:', '  - slot: domain', '',
        ].join('\n'));
      }
      writeFileSync(join(potDir, '.papercusp', 'blueprint.yaml'), [
        'id: fixture-pot', 'extends: pot-domain', 'kind: pot', 'version: 1.0.0',
        'workItem:', '  kind: feature', '  idPrefix: WI',
        'spine:', '  decider: su', '  claimModel: self-claim-priority',
        '  default: { to: idle }',
        'roles:', '  - id: su', '    description: Fixture su.', '',
      ].join('\n'));
      const potHeld = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: potDir, workspaceId: 'fixture-workspace',
        harnessSlug: 'fixture', role: 'su', stack: [], impliedStack: 'su-static',
        state: { schemaVersion: 1 },
      });
      const potSlots = slotted(potHeld.specificationArtifact.inputs);
      expect(potSlots).toContain('domain:pot-domain');
      expect(potSlots.filter((ref) => ref.startsWith('domain:'))).toEqual(['domain:pot-domain']);
      expect(potHeld.specificationArtifact.configuration.workItem?.idPrefix).toBe('WI');

      const explicitHeld = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: potDir, workspaceId: 'fixture-workspace',
        harnessSlug: 'fixture', role: 'su', stack: ['domain:chosen-domain'], impliedStack: 'su-static',
        state: { schemaVersion: 1 },
      });
      expect(explicitHeld.stack).toEqual(['domain:chosen-domain']);
      expect(slotted(explicitHeld.specificationArtifact.inputs)
        .filter((ref) => ref.startsWith('domain:'))).toEqual(['domain:chosen-domain']);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(potDir, { recursive: true, force: true });
    }
  });

  // WI-10003611: installed identities carry a per-layer attestation (identity-lint requires it).
  // Replacing an inherited exclusive slot peer-assembles the surviving layers; copying a layer's
  // attestation onto the synthesized effective-launch root failed attestation-hash-mismatch, so
  // no attested identity could replace an inherited domain (the papercusp pot's own shape).
  it('replaces an inherited attested domain with an attested installed identity', async () => {
    const { layerContentHash } = await import('@papercusp/orchestrator/blueprint');
    const dir = mkdtempSync(join(tmpdir(), 'role-launch-attested-replacement-'));
    const blueprintDir = join(dir, '.papercusp', 'blueprints');
    const writeAttested = (id: string, model: string) => {
      const layer = {
        id, extends: 'base', version: '1.0.0', slots: [{ slot: 'domain' }],
        knobs: { aiBackend: { default: { model } } },
      };
      mkdirSync(join(blueprintDir, id, 'prompts'), { recursive: true });
      writeFileSync(join(blueprintDir, id, 'blueprint.yaml'), JSON.stringify({
        ...layer, attestation: { contentHash: layerContentHash(layer), signedBy: 'approved-publisher' },
      }));
      writeFileSync(join(blueprintDir, id, 'prompts', 'domain.md'), `${id.toUpperCase()} RULES\n`);
      return layerContentHash(layer);
    };
    try {
      writeAttested('first-attested-domain', 'original-model');
      const selectedHash = writeAttested('second-attested-domain', 'selected-model');
      writeFileSync(join(dir, '.papercusp', 'blueprint.yaml'), [
        'id: fixture-pot', 'extends: first-attested-domain', 'kind: pot', 'version: 1.0.0',
        'workItem:', '  kind: feature', '  idPrefix: WI',
        'spine:', '  decider: su', '  claimModel: self-claim-priority',
        '  default: { to: idle }',
        'roles:', '  - id: su', '    description: Fixture su.', '',
      ].join('\n'));
      const input = { cwd: dir, harnessSlug: 'fixture', role: 'worker', stack: ['domain:second-attested-domain'] };

      await expect(resolveLaunchIdentityModelDefault(input)).resolves.toBe('selected-model');
      const selected = await compileLaunchSpecificationArtifact({
        ...input, promptText: 'ROLE KERNEL', workspaceId: 'fixture-workspace',
        state: { schemaVersion: 1 }, renderStack: true,
      });
      const configuration = selected.specificationArtifact.configuration as Record<string, unknown>;
      expect(configuration).not.toHaveProperty('attestation');
      expect(selected.specificationArtifact.configuration.knobs?.aiBackend?.default?.model).toBe('selected-model');
      expect(selected.promptText).toContain('SECOND-ATTESTED-DOMAIN RULES');
      expect(selected.promptText).not.toContain('FIRST-ATTESTED-DOMAIN RULES');
      // The selected layer's own authored hash stays pinned in the compiler closure.
      expect(selected.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'second-attested-domain', contentHash: selectedHash,
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an existing SU mode producer binding out of the resource artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'su-mode-launch-artifact-'));
    try {
      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: dir, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'su', stack: ['autonomy:su.mode-auto'],
        state: { schemaVersion: 1 },
      });
      expect(launch.specificationArtifact.configuration.mode).toBeUndefined();
      expect(launch.promptText).toBe('SU KERNEL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('launches a prompt-only generic identity without SU assignment or work-item configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-identity-artifact-'));
    const identityDir = join(dir, '.papercusp', 'blueprints', 'plain-domain');
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), [
        'id: plain-domain', 'extends: base', 'version: 1.0.0',
        'slots:', '  - slot: domain', 'grants: {}', '',
      ].join('\n'));
      writeFileSync(join(identityDir, 'prompts', 'domain.md'), 'PLAIN DOMAIN\n');
      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: dir, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: ['domain:plain-domain'],
        state: { schemaVersion: 1 }, renderStack: true,
      });
      expect(launch.promptText).toContain('PLAIN DOMAIN');
      expect(launch.specificationArtifact.configuration).not.toHaveProperty('workItem');
      expect(launch.specificationArtifact.configuration).not.toHaveProperty('spine');
      expect(launch.specificationArtifact.configuration).not.toHaveProperty('fleet');
      expect(launch.specificationArtifact.configuration.roles ?? []).toEqual([]);
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'plain-domain',
      }));

      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      assembleRolePromptMock.mockReturnValueOnce({
        text: 'ROLE KERNEL',
        meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: dir,
          stateDir: join(dir, '.papercusp'), harnessDir: '/h', runId: 'worker-generic-1' },
      });
      const role = await buildRoleLaunchSpec({
        role: 'worker', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        operatorBaseUrl: 'http://localhost:3070', stack: ['domain:plain-domain'],
      });
      const url = new URL(role.mcpUrl);
      expect(url.searchParams.get('role')).toBe('worker');
      expect(url.searchParams.has('superuser')).toBe(false);
      expect(role.promptText).toContain('PLAIN DOMAIN');
      expect(role.specificationArtifact.configuration).not.toHaveProperty('workItem');

      const identityInput = launch.specificationArtifact.inputs.find((entry) =>
        entry.kind === 'blueprint-layer' && entry.ref === 'plain-domain');
      expect(identityInput).toBeDefined();
      if (identityInput?.kind !== 'blueprint-layer') throw new Error('plain-domain source pin missing');
      const acceptedOperation = {
        workItemId: 'WI-1', harnessSlug: 'harness-a', storageHarnessSlug: 'harness-a',
        operationId: 'run', specificationRevision: 'a'.repeat(64),
        pin: { kind: 'blueprint-operation' as const, harnessSlug: 'harness-a', operationId: 'run',
          specificationRevision: 'a'.repeat(64), operationVersion: '1.0.0', input: {} },
        identity: { ref: 'plain-domain', revision: identityInput!.revision,
          contentHash: identityInput!.contentHash },
        stack: ['domain:plain-domain'], requiredTools: ['work_items:get'],
      };
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      assembleRolePromptMock.mockReturnValueOnce({
        text: 'ROLE KERNEL',
        meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: dir,
          stateDir: join(dir, '.papercusp'), harnessDir: '/h', runId: 'worker-WI-1' },
      });
      const launchIdentity = mintRoleLaunchIdentity();
      const accepted = await buildRoleLaunchSpec({
        role: 'worker', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        featureId: 'WI-1', operatorBaseUrl: 'http://localhost:3070', acceptedOperation,
        launchIdentity,
      });
      expect(accepted.sid).toBe(launchIdentity.sid);
      expect(accepted.nativeSessionId).toBe(launchIdentity.nativeSessionId);
      expect(accepted.acceptedOperation).toEqual(acceptedOperation);

      // WI-10006959: the canonical pin carries the identity's DECLARED version, not the
      // compiler's revision label (which defaults to the contentHash). The content identity
      // is ref + contentHash, so a version-pinned worker must bind...
      const versionPinned = { ...acceptedOperation,
        identity: { ...acceptedOperation.identity, revision: '0.1.0' } };
      expect(versionPinned.identity.revision).not.toBe(identityInput!.revision);
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      assembleRolePromptMock.mockReturnValueOnce({
        text: 'ROLE KERNEL',
        meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: dir,
          stateDir: join(dir, '.papercusp'), harnessDir: '/h', runId: 'worker-WI-1-versioned' },
      });
      const versioned = await buildRoleLaunchSpec({
        role: 'worker', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        featureId: 'WI-1', operatorBaseUrl: 'http://localhost:3070', acceptedOperation: versionPinned,
      });
      expect(versioned.acceptedOperation?.identity.revision).toBe('0.1.0');
      // ...while a pin whose content hash no longer matches the composed layer is still refused.
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      assembleRolePromptMock.mockReturnValueOnce({
        text: 'ROLE KERNEL',
        meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: dir,
          stateDir: join(dir, '.papercusp'), harnessDir: '/h', runId: 'worker-WI-1-stale' },
      });
      await expect(buildRoleLaunchSpec({
        role: 'worker', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        featureId: 'WI-1', operatorBaseUrl: 'http://localhost:3070',
        acceptedOperation: { ...acceptedOperation,
          identity: { ...acceptedOperation.identity, contentHash: 'c'.repeat(64) } },
      })).rejects.toThrow(/accepted blueprint worker identity changed during launch composition/);
      expect(accepted.stack).toEqual(['domain:plain-domain']);
      expect(accepted.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'plain-domain', contentHash: identityInput!.contentHash,
      }));

      const otherDir = join(dir, '.papercusp', 'blueprints', 'other-domain');
      mkdirSync(join(otherDir, 'prompts'), { recursive: true });
      writeFileSync(join(otherDir, 'blueprint.yaml'), [
        'id: other-domain', 'extends: base', 'version: 1.0.0',
        'slots:', '  - slot: domain', 'grants: {}', '',
      ].join('\n'));
      writeFileSync(join(otherDir, 'prompts', 'domain.md'), 'OTHER DOMAIN\n');
      const otherCompiled = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: dir, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: ['domain:other-domain'],
        state: { schemaVersion: 1 }, renderStack: true,
      });
      const otherInput = otherCompiled.specificationArtifact.inputs.find((entry) =>
        entry.kind === 'blueprint-layer' && entry.ref === 'other-domain');
      if (otherInput?.kind !== 'blueprint-layer') throw new Error('other-domain source pin missing');
      const otherOperation = {
        workItemId: 'WI-2', harnessSlug: 'harness-a', storageHarnessSlug: 'harness-a',
        operationId: 'read', specificationRevision: 'b'.repeat(64),
        pin: { kind: 'blueprint-operation' as const, harnessSlug: 'harness-a', operationId: 'read',
          specificationRevision: 'b'.repeat(64), operationVersion: '1.0.0', input: {} },
        identity: { ref: 'other-domain', revision: otherInput.revision,
          contentHash: otherInput.contentHash },
        stack: ['domain:other-domain'], requiredTools: ['mail:read'],
      };
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      assembleRolePromptMock.mockReturnValueOnce({
        text: 'ROLE KERNEL',
        meta: { role: 'worker', promptFile: '/h/prompts/worker.md', projectDir: dir,
          stateDir: join(dir, '.papercusp'), harnessDir: '/h', runId: 'worker-WI-2' },
      });
      const other = await buildRoleLaunchSpec({
        role: 'worker', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        featureId: 'WI-2', operatorBaseUrl: 'http://localhost:3070', acceptedOperation: otherOperation,
      });
      expect(accepted.promptText).toContain('PLAIN DOMAIN');
      expect(accepted.promptText).not.toContain('OTHER DOMAIN');
      expect(other.promptText).toContain('OTHER DOMAIN');
      expect(other.promptText).not.toContain('PLAIN DOMAIN');
      expect(accepted.specificationArtifact.inputs).not.toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'other-domain',
      }));
      expect(other.specificationArtifact.inputs).not.toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'plain-domain',
      }));
      expect(other.acceptedOperation?.requiredTools).toEqual(['mail:read']);
      await expect(buildRoleLaunchSpec({
        role: 'worker', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        featureId: 'WI-1', operatorBaseUrl: 'http://localhost:3070',
        acceptedOperation: { ...acceptedOperation, harnessSlug: 'harness-b' },
      })).rejects.toThrow('launch scope');
      await expect(buildRoleLaunchSpec({
        role: 'worker', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        featureId: 'WI-1', operatorBaseUrl: 'http://localhost:3070',
        stack: ['domain:other'], acceptedOperation,
      })).rejects.toThrow('identity stack disagrees');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // identity-system-everything-migration-2026-10-18 SPEC-P-003: a non-su (judge)
  // launch that names an identity stack renders the stack's layers into its
  // prompt, and launches as the judge role rather than as su.
  it('renders a judge launch identity stack into the judge prompt (SPEC-P-003)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-identity-artifact-'));
    const identityDir = join(dir, '.papercusp', 'blueprints', 'judge-lens');
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), [
        'id: judge-lens', 'extends: base', 'version: 1.0.0',
        'slots:', '  - slot: domain', 'grants: {}', '',
      ].join('\n'));
      writeFileSync(join(identityDir, 'prompts', 'domain.md'), 'JUDGE LENS LAYER\n');
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      assembleRolePromptMock.mockReturnValueOnce({
        text: 'JUDGE KERNEL',
        meta: { role: 'judge', promptFile: '/h/prompts/judge.md', projectDir: dir,
          stateDir: join(dir, '.papercusp'), harnessDir: '/h', runId: 'judge-identity-1' },
      });
      const judge = await buildRoleLaunchSpec({
        role: 'judge', workspaceId: 'workspace-a', harnessSlug: 'harness-a',
        operatorBaseUrl: 'http://localhost:3070', stack: ['domain:judge-lens'],
      });
      expect(judge.promptText).toContain('JUDGE KERNEL');
      expect(judge.promptText).toContain('JUDGE LENS LAYER');
      expect(judge.stack).toEqual(['domain:judge-lens']);
      expect(judge.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'judge-lens',
      }));
      const url = new URL(judge.mcpUrl);
      expect(url.searchParams.get('role')).toBe('judge');
      expect(url.searchParams.has('superuser')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins a fixed contribution beside selected configuration without rendering the document twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mixed-fixed-identity-artifact-'));
    const identityDir = join(dir, '.papercusp', 'blueprints', 'mixed-domain');
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), [
        'id: mixed-domain', 'extends: base', 'version: 1.0.0',
        'slots:', '  - slot: domain',
        'knobs:', '  aiBackend:', '    default:', '      model: mixed-model',
        'contributions:',
        '  - id: mixed-rules',
        '    purpose: prompt',
        '    source: fixed',
        '    refresh: source-change',
        '    inputKind: prompt-file',
        '    ref: fixed:domain', '',
      ].join('\n'));
      writeFileSync(join(identityDir, 'prompts', 'domain.md'), 'MIXED DOMAIN RULES\n');
      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: dir, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: ['domain:mixed-domain'],
        state: { schemaVersion: 1 }, renderStack: true,
      });
      expect(launch.specificationArtifact.configuration.knobs?.aiBackend?.default?.model).toBe('mixed-model');
      expect(launch.promptText.match(/MIXED DOMAIN RULES/g)).toHaveLength(1);
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'prompt-file', ref: 'fixed:domain', bytes: 'MIXED DOMAIN RULES\n',
      }));
      expect(launch.specificationArtifact.provenance).toContainEqual(expect.objectContaining({
        path: 'contribution.mixed-rules', decision: 'fixed:source-change',
      }));
      await expect(compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: dir, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: ['domain:mixed-domain'],
        state: { schemaVersion: 1 }, renderStack: false,
      })).rejects.toThrow(/pinned fixed prompt is absent from the delivered prompt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compiles a named composition root with its selected component prompts and source pins', async () => {
    const { saveNamedIdentityComposition, previewNamedIdentityComposition } = await import('./identity-management');
    const { resolveNamedIdentityCompositionSelection, resolvePinnedIdentityLaunchSelection } =
      await import('./agent-identities/source');
    const dir = mkdtempSync(join(tmpdir(), 'named-launch-composition-'));
    try {
      for (const [id, slot, prompt] of [
        ['named-domain', 'domain', 'NAMED DOMAIN RULES'],
        ['named-practice', 'practice', 'NAMED PRACTICE RULES'],
      ]) {
        const componentDir = join(dir, '.papercusp', 'blueprints', id!);
        mkdirSync(join(componentDir, 'prompts'), { recursive: true });
        writeFileSync(join(componentDir, 'blueprint.yaml'),
          `id: ${id}\nextends: base\nversion: 1.0.0\nslots:\n  - slot: ${slot}\n` +
          (slot === 'domain' ? 'knobs:\n  aiBackend:\n    default: { model: named-default }\n    roles:\n      su: { model: named-su }\n' : ''));
        writeFileSync(join(componentDir, 'prompts', `${slot}.md`), `${prompt}\n`);
      }
      const selection = { id: 'named-review', repoDir: dir,
        componentRefs: ['domain:named-domain', 'practice:named-practice'] };
      await previewNamedIdentityComposition(selection);
      await saveNamedIdentityComposition(selection);
      expect(await resolveLaunchIdentityModelDefault({ cwd: dir, role: 'su',
        stack: ['composition:named-review'] })).toBe('named-su');
      expect(await resolveLaunchIdentityModelDefault({ cwd: dir, role: 'worker',
        stack: ['composition:named-review'] })).toBe('named-default');
      const { papercuspPathForWorkspace } = await import('./papercusp-root');
      const flags = await import('@papercusp/flags/server');
      const flagSpy = vi.spyOn(flags, 'getFlag').mockResolvedValueOnce(false);
      vi.mocked(papercuspPathForWorkspace).mockReturnValueOnce(dir);
      await expect(buildLaunchSpec({ kind: 'su', agent: 'claude',
        workspaceId: 'default', operatorBaseUrl: 'http://localhost:3070',
        stack: ['composition:named-review'] })).rejects.toThrow(/requires the SU blueprint persona renderer/);
      flagSpy.mockRestore();
      vi.mocked(papercuspPathForWorkspace).mockReturnValueOnce(dir);
      const suSpec = await buildLaunchSpec({ kind: 'su', agent: 'claude',
        workspaceId: 'default', operatorBaseUrl: 'http://localhost:3070',
        stack: ['composition:named-review'] });
      expect(suSpec.stack).toEqual(selection.componentRefs);
      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: dir, role: 'su', stack: selection.componentRefs,
        compositionRootId: selection.id, state: { schemaVersion: 1 }, renderStack: true,
      });
      expect(launch.promptText).toContain('NAMED DOMAIN RULES');
      expect(launch.promptText).toContain('NAMED PRACTICE RULES');
      const selected = await resolveNamedIdentityCompositionSelection(selection.id, dir);
      await expect(resolvePinnedIdentityLaunchSelection({
        ref: `composition:${selection.id}`, sourceRevision: selected.sourceRevision,
        repoDir: dir, stack: selection.componentRefs,
      })).resolves.toMatchObject({ compositionRootId: selection.id });
      expect(selected.layers.every((layer) => launch.specificationArtifact.inputs.some((entry) =>
        entry.kind === 'blueprint-layer' && entry.ref === layer.id &&
        entry.contentHash === layer.contentHash))).toBe(true);
      for (const id of ['named-review', 'named-domain', 'named-practice']) {
        expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
          kind: 'blueprint-layer', ref: id,
        }));
      }
      await expect(compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: dir, role: 'su', stack: ['practice:named-practice'],
        compositionRootId: selection.id, state: { schemaVersion: 1 }, renderStack: true,
      })).rejects.toThrow(/stack changed/);
      writeFileSync(join(dir, '.papercusp', 'blueprints', 'named-domain', 'blueprint.yaml'),
        'id: named-domain\nextends: base\nversion: 1.0.1\nslots:\n  - slot: domain\n');
      await expect(resolvePinnedIdentityLaunchSelection({
        ref: `composition:${selection.id}`, sourceRevision: selected.sourceRevision,
        repoDir: dir, stack: selection.componentRefs,
      })).rejects.toThrow(/source revision or component stack changed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a GUI-saved workspace composition from a different child checkout', async () => {
    const { saveNamedIdentityComposition } = await import('./identity-management');
    const { getIdentitySource } = await import('./agent-identities/source');
    const dir = mkdtempSync(join(tmpdir(), 'named-launch-state-library-'));
    const home = join(dir, 'state');
    const checkout = join(dir, 'checkout');
    const priorHome = process.env.PAPERCUSP_HOME;
    try {
      mkdirSync(checkout, { recursive: true });
      process.env.PAPERCUSP_HOME = home;
      const componentDir = join(home, '.papercusp', 'blueprints', 'state-domain');
      mkdirSync(join(componentDir, 'prompts'), { recursive: true });
      writeFileSync(join(componentDir, 'blueprint.yaml'),
        'id: state-domain\nextends: base\nversion: 1.0.0\nslots:\n  - slot: domain\n');
      writeFileSync(join(componentDir, 'prompts', 'domain.md'), 'STATE LIBRARY DOMAIN\n');
      await saveNamedIdentityComposition({ id: 'state-named', repoDir: home,
        componentRefs: ['domain:state-domain'] });
      expect((await getIdentitySource('state-named', { repoDir: checkout })).ok).toBe(true);
      const launch = await compileLaunchSpecificationArtifact({
        promptText: 'ROLE KERNEL', cwd: checkout, role: 'su',
        stack: ['domain:state-domain'], compositionRootId: 'state-named',
        renderStack: true, state: { schemaVersion: 1 },
      });
      expect(launch.promptText).toContain('STATE LIBRARY DOMAIN');
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: 'state-named',
      }));
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts exact selected provider setting and prompt receipts and refuses a changed source', async () => {
    const { bindSelectedIdentityOutputArtifact } = await import('./agent-identities/source');
    const dir = mkdtempSync(join(tmpdir(), 'mixed-provider-identity-artifact-'));
    const id = 'provider-domain';
    const identityDir = join(dir, '.papercusp', 'blueprints', id);
    const file = join(identityDir, 'blueprint.yaml');
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      const source = readFileSync(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE ??
        new URL('./agent-identities/fixtures/required-provider-domain.yaml', import.meta.url), 'utf8');
      writeFileSync(file, source);
      writeFileSync(join(identityDir, 'prompts', 'domain.md'), 'PROVIDER DOMAIN\n');
      const bound = await bindSelectedIdentityOutputArtifact({
        identityId: id, repoDir: dir,
        outputs: [
          { contributionId: 'current-brief', value: [{ mode: 'research' }] },
          { contributionId: 'current-guidance', value: 'CURRENT GUIDANCE FROM PRODUCER' },
        ],
        scope: { workspace: 'workspace-a', harness: 'harness-a' },
        observedAt: '2026-09-24T00:00:00.000Z',
      });
      await expect(bindSelectedIdentityOutputArtifact({
        identityId: id, repoDir: dir,
        outputs: [
          { contributionId: 'current-brief', omission: { reason: 'not-requested' } },
          { contributionId: 'current-guidance', value: 'CURRENT GUIDANCE FROM PRODUCER' },
        ],
        scope: { workspace: 'workspace-a', harness: 'harness-a' },
        observedAt: '2026-09-24T00:00:00.000Z',
      })).rejects.toThrow(/declared operational input is absent/);
      await expect(bindSelectedIdentityOutputArtifact({
        identityId: id, repoDir: dir,
        outputs: [{ contributionId: 'current-guidance', value: 'CURRENT GUIDANCE FROM PRODUCER' }],
        scope: { workspace: 'workspace-a', harness: 'harness-a' },
        observedAt: '2026-09-24T00:00:00.000Z',
      })).rejects.toThrow(/declared operational input is absent/);
      const input = {
        promptText: 'ROLE KERNEL', cwd: dir, workspaceId: 'workspace-a',
        harnessSlug: 'harness-a', role: 'worker', stack: [`domain:${id}`],
        state: { schemaVersion: 1 }, renderStack: true,
      } as const;
      await expect(compileLaunchSpecificationArtifact(input))
        .rejects.toThrow(/producer contributions that need binding/);
      const launch = await compileLaunchSpecificationArtifact({ ...input,
        producerBindings: [{ identityId: id, artifact: bound.artifact }],
      });
      expect(launch.specificationArtifact.configuration.knobs?.aiBackend?.default?.model)
        .toBe('selected-provider-model');
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'setting', ref: 'current-brief', value: [{ mode: 'research' }],
        producerRef: 'papercusp.mode-state@1',
      }));
      expect(launch.promptText.match(/CURRENT GUIDANCE FROM PRODUCER/g)).toHaveLength(1);
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'prompt-file', ref: 'current-guidance', bytes: 'CURRENT GUIDANCE FROM PRODUCER',
        producerRef: 'papercusp.turn-start-orientation@1',
      }));
      expect(launch.specificationArtifact.provenance).toContainEqual(expect.objectContaining({
        path: 'contribution.current-brief', decision: 'provider:turn',
        producerRef: 'papercusp.mode-state@1',
      }));
      expect(launch.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'blueprint-layer', ref: id, contentHash: bound.sourceRevision,
      }));
      expect(launch.specificationArtifact.provenance).toContainEqual(expect.objectContaining({
        path: 'contribution.current-guidance', decision: 'provider:launch',
        producerRef: 'papercusp.turn-start-orientation@1',
      }));
      const fresh = await bindSelectedIdentityOutputArtifact({
        identityId: id, repoDir: dir,
        outputs: [
          { contributionId: 'current-brief', value: [{ mode: 'ideate' }] },
          { contributionId: 'current-guidance', value: 'CURRENT GUIDANCE FROM PRODUCER' },
        ],
        scope: { workspace: 'workspace-a', harness: 'harness-a' },
        observedAt: '2026-09-24T00:00:01.000Z',
      });
      const refreshed = await compileLaunchSpecificationArtifact({ ...input,
        producerBindings: [{ identityId: id, artifact: fresh.artifact }],
      });
      expect(fresh.sourceRevision).toBe(bound.sourceRevision);
      expect(refreshed.specificationRevision).not.toBe(launch.specificationRevision);
      expect(refreshed.specificationArtifact.inputs).toContainEqual(
        launch.specificationArtifact.inputs.find((entry) =>
          entry.kind === 'blueprint-layer' && entry.ref === id),
      );
      expect(refreshed.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
        kind: 'setting', ref: 'current-brief', value: [{ mode: 'ideate' }],
        producerRef: 'papercusp.mode-state@1',
      }));
      for (const field of ['workItem', 'spine', 'fleet', 'assignment', 'launchSlot']) {
        expect(refreshed.specificationArtifact.configuration).not.toHaveProperty(field);
      }
      const omitted = await bindSelectedIdentityOutputArtifact({
        identityId: id, repoDir: dir,
        outputs: [
          { contributionId: 'current-brief', value: [{ mode: 'research' }] },
          { contributionId: 'current-guidance', omission: { reason: 'not-requested' } },
        ],
        scope: { workspace: 'workspace-a', harness: 'harness-a' },
        observedAt: '2026-09-24T00:00:01.000Z',
      });
      const withoutGuidance = await compileLaunchSpecificationArtifact({ ...input,
        producerBindings: [{ identityId: id, artifact: omitted.artifact }],
      });
      expect(withoutGuidance.promptText).not.toContain('CURRENT GUIDANCE FROM PRODUCER');
      expect(withoutGuidance.specificationArtifact.provenance).toContainEqual(expect.objectContaining({
        path: 'contribution.current-guidance', decision: 'omitted:not-requested',
      }));
      writeFileSync(file, source.replace('selected-provider-model', 'changed-provider-model'));
      await expect(compileLaunchSpecificationArtifact({ ...input,
        producerBindings: [{ identityId: id, artifact: bound.artifact }],
      })).rejects.toThrow(/source revision changed|does not match selected source/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits the feature param for a no-feature role', async () => {
    assembleRolePromptMock.mockReturnValue({
      text: 'SCOPER PROMPT',
      meta: {
        role: 'scoper',
        promptFile: '/h/prompts/scoper.md',
        projectDir: '/proj/papercup',
        stateDir: '',
        harnessDir: '/h',
        runId: 'scoper-123',
      },
    });
    const spec = await buildRoleLaunchSpec({
      role: 'scoper',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.featureId).toBeNull();
    expect(new URL(spec.mcpUrl).searchParams.has('feature')).toBe(false);
  });

  it('propagates a harness-not-registered throw from assembleRolePrompt', async () => {
    assembleRolePromptMock.mockImplementation(() => {
      throw new Error('assembleRolePrompt: harness "ghost" not registered');
    });
    await expect(
      buildRoleLaunchSpec({
        role: 'worker',
        workspaceId: 'default',
        harnessSlug: 'ghost',
        operatorBaseUrl: 'http://x',
      }),
    ).rejects.toThrow(/not registered/);
  });

  it('throws (before calling the assembler) when the harness is not in the workspace', async () => {
    // resolveProjectDir → null means the harness isn't registered in this
    // workspace; we must surface that in-process, not let the assembler fall
    // back to its workspace-blind lookup.
    vi.mocked(resolveProjectDir).mockResolvedValueOnce(null);
    await expect(
      buildRoleLaunchSpec({
        role: 'scoper',
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercup',
        operatorBaseUrl: 'http://x',
      }),
    ).rejects.toThrow(/not registered in workspace "papercusp-workspace"/);
    expect(assembleRolePromptMock).not.toHaveBeenCalled();
  });
});

describe('buildRoleLaunchSpec — WI-4608 contextSize role-based default (the mug/kettle "Prompt is too long" fix)', () => {
  it('role=mug, contextSize omitted ⇒ auto-selects trimmed and seeds ?tools=CORE_MCP_TOOL_NAMES', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'mug',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.contextSize).toBe('trimmed');
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES]);
  });

  it('role=kettle, contextSize omitted ⇒ auto-selects trimmed too (not just mug)', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'kettle',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(true);
  });

  it('role=queen / role=overwatch (pre-rename spellings) also auto-select trimmed via canonicalCoordRole', async () => {
    const queenSpec = await buildRoleLaunchSpec({
      role: 'queen',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(queenSpec.contextSize).toBe('trimmed');
    const overwatchSpec = await buildRoleLaunchSpec({
      role: 'overwatch',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(overwatchSpec.contextSize).toBe('trimmed');
  });

  it('role=worker, contextSize omitted ⇒ uses the growable trimmed seed too', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(true);
  });

  it('legacy explicit contextSize:"full" normalizes to trimmed', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'mug',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: 'full',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.has('tools')).toBe(true);
  });

  it('role=worker, explicit contextSize:"trimmed" OVERRIDES the (full) role-based default', async () => {
    const spec = await buildRoleLaunchSpec({
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: 'trimmed',
    });
    expect(spec.contextSize).toBe('trimmed');
    expect(new URL(spec.mcpUrl).searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES]);
  });
});

describe('buildRoleLaunchSpec — WORKSPACE-LEVEL (harness-less) role session (hive-agent-tabs P-003)', () => {
  it('operator: chat persona (+tools.md) prompt, workspace-root cwd, MCP URL signed WITHOUT a harness param', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rls-prompts-'));
    writeFileSync(join(dir, 'operator.persona.md'), 'OPERATOR PERSONA');
    writeFileSync(join(dir, 'operator.tools.md'), 'OPERATOR TOOLS PLAYBOOK');
    promptsDirValue = dir;

    const spec = await buildRoleLaunchSpec({
      role: 'operator',
      workspaceId: 'default',
      harnessSlug: null,
      operatorBaseUrl: 'http://localhost:3070',
    });

    // The shared harness assembler is NOT used — no harness to resolve.
    expect(assembleRolePromptMock).not.toHaveBeenCalled();
    expect(resolveProjectDir).not.toHaveBeenCalled();
    expect(spec.harnessSlug).toBeNull();
    // cwd = the SELECTED workspace's root (the buildSuLaunchSpec mirror).
    expect(spec.cwd).toBe('/ws-root/default');
    // The prompt is the chat-surface persona + tools playbook + runtime context
    // telling the session it is unscoped.
    expect(spec.promptText).toContain('OPERATOR PERSONA');
    expect(spec.promptText).toContain('OPERATOR TOOLS PLAYBOOK');
    expect(spec.promptText).toContain('harness_required');
    expect(spec.promptFile).toBe(join(dir, 'operator.persona.md'));
    // Signed role URL with NO harness param — ctx lands as the '*' sentinel.
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.has('harness')).toBe(false);
    expect(u.searchParams.get('role')).toBe('operator');
    expect(u.searchParams.get('workspace')).toBe('default');
    expect(u.searchParams.get('sig')).toBe('TESTSIG');
    expect(u.searchParams.get('client')).toBe(spec.sid);
    rmSync(dir, { recursive: true, force: true });
  });

  // EI-996 note: `psu --role planner` no longer REACHES this builder — the launcher
  // routes su-tier roles (SU_TIER_ROLES) to the su bootstrap instead. This test is
  // still correct and still load-bearing: buildRoleLaunchSpec is unchanged and stays
  // the path for harness-pipeline planner spawns, which do not go through psu.
  it('planner: falls back to the spawn persona (prompts/planner.md) when no chat persona exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rls-prompts-'));
    promptsDirValue = dir; // empty — no planner.persona.md
    const spawnPersona = join(dir, 'planner.md');
    writeFileSync(spawnPersona, 'PLANNER SPAWN PERSONA');
    resolvePromptFileMock.mockReturnValueOnce(spawnPersona);

    const spec = await buildRoleLaunchSpec({
      role: 'planner',
      workspaceId: 'default',
      harnessSlug: null,
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.promptText).toContain('PLANNER SPAWN PERSONA');
    expect(spec.promptFile).toBe(spawnPersona);
    expect(new URL(spec.mcpUrl).searchParams.has('harness')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a blank chat persona even when a tools playbook exists, then recovers after install', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rls-prompts-'));
    promptsDirValue = dir;
    try {
      writeFileSync(join(dir, 'operator.persona.md'), ' \n ');
      writeFileSync(join(dir, 'operator.tools.md'), 'SYNTHETIC TOOLS');
      const opts = { role: 'operator', workspaceId: 'default', harnessSlug: null, operatorBaseUrl: 'http://x' };
      await expect(buildRoleLaunchSpec(opts)).rejects.toMatchObject({ code: 'ROLE_PROMPT_UNAVAILABLE', document: 'workspace-persona' });
      writeFileSync(join(dir, 'operator.persona.md'), 'SYNTHETIC INSTALLED PERSONA');
      expect((await buildRoleLaunchSpec(opts)).promptText).toContain('SYNTHETIC INSTALLED PERSONA');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('throws for a role with no workspace-level persona at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rls-prompts-'));
    promptsDirValue = dir;
    resolvePromptFileMock.mockReturnValueOnce(null);
    await expect(
      buildRoleLaunchSpec({ role: 'worker', workspaceId: 'default', harnessSlug: null, operatorBaseUrl: 'http://x' }),
    ).rejects.toMatchObject({ code: 'ROLE_PROMPT_UNAVAILABLE', role: 'worker', document: 'workspace-persona' });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('buildLaunchSpec — kind dispatch', () => {
  it("kind:'role' delegates to buildRoleLaunchSpec + tags kind, role-scoped (no superuser)", async () => {
    const spec = await buildLaunchSpec({
      kind: 'role',
      role: 'worker',
      workspaceId: 'default',
      harnessSlug: 'papercup',
      operatorBaseUrl: 'http://localhost:3070',
      featureId: 'F-001',
    });
    expect(spec.kind).toBe('role');
    expect(spec.role).toBe('worker');
    expect(spec.promptText).toBe('WORKER PROMPT BODY');
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('role')).toBe('worker');
    expect(u.searchParams.has('superuser')).toBe(false);
    // su leaves untouched on the role path.
    expect(renderSuPlaybookMock).not.toHaveBeenCalled();
  });

  it("kind:'su' workspace-level: playbook prompt, workspace-root cwd, superuser MCP + bearer", async () => {
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
    });
    expect(spec.kind).toBe('su');
    expect(spec.role).toBe('su');
    expect(spec.featureId).toBeNull();
    expect(spec.harnessSlug).toBeNull();
    // workspace-level → papercuspPathForWorkspace(workspaceId) (mocked),
    // scoped to the SELECTED workspace, no resolveProjectDir.
    expect(spec.cwd).toBe('/ws-root/default');
    expect(resolveProjectDir).not.toHaveBeenCalled();
    // playbook rendered for the right client; no launch-context (no harness/plan).
    expect(renderSuPlaybookMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }));
    expect(spec.promptText).toBe('SU PLAYBOOK BODY');
    expect(spec.promptFile).toBe('/prompts/papercusp-su-engineer.tools.md');
    // superuser MCP door (NOT a signed role URL), workspace baked in, bearer set.
    const u = new URL(spec.mcpUrl);
    expect(u.pathname).toBe('/api/mcp');
    expect(u.searchParams.get('superuser')).toBe('1');
    expect(u.searchParams.get('workspace')).toBe('default');
    expect(u.searchParams.has('role')).toBe(false);
    const mcp = JSON.parse(spec.mcpJsonContents);
    expect(mcp.mcpServers.papercusp.url).toBe(spec.mcpUrl);
    expect(mcp.mcpServers.papercusp.headers.Authorization).toBe('Bearer TESTTOKEN');
  });

  it("kind:'su' harness+plan: cwd from registry, launch-context appended to playbook", async () => {
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'omp',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      harnessSlug: 'papercup',
      planSlug: 'my-plan',
      planTitle: 'My Plan',
      planNow: { state: 'doing X', next: 'do Y' },
    });
    expect(spec.harnessSlug).toBe('papercup');
    expect(spec.cwd).toBe('/registry/papercup');
    expect(renderSuPlaybookMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'omp' }));
    // base playbook + the composed scope/plan addendum.
    expect(spec.promptText).toContain('SU PLAYBOOK BODY');
    expect(spec.promptText).toContain('# Operating brief — this launch');
    expect(spec.promptText).toContain('papercup');
    expect(spec.promptText).toContain('my-plan');
    expect(spec.instructionLint).toMatchObject({ markerCount: 4, clean: true });
  });

  it("kind:'su' surfaces a harness that isn't registered in the workspace", async () => {
    vi.mocked(resolveProjectDir).mockResolvedValueOnce(null);
    await expect(
      buildLaunchSpec({
        kind: 'su',
        agent: 'codex',
        workspaceId: 'ws9',
        operatorBaseUrl: 'http://x',
        harnessSlug: 'ghost',
      }),
    ).rejects.toThrow(/not registered in workspace "ws9"/);
  });

  it("kind:'su' with no installed token emits empty headers (bootstrap pending)", async () => {
    vi.mocked(readSuperuserToken).mockReturnValueOnce(null);
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://x',
    });
    const mcp = JSON.parse(spec.mcpJsonContents);
    expect(mcp.mcpServers.papercusp.headers).toEqual({});
  });
});

// dynamic-tool-surface D-010 ("default all to trimmed"): the core-spine `?tools=` SEED
// is baked into the superuser MCP URL BY DEFAULT for EVERY client + tier. It's a
// growable floor (tools:find → notifications/tools/list_changed re-fetch; + tools:invoke
// fallback; + a compact capability map for discoverability), so seeding no longer strands
// the tail — it's a ~165k→~10k token win everywhere.
//
// There is NO opt-out any more (trimmed-only-agent-context-launch-2026-08-27 P-001/P-002).
// contextSize:'full' used to escape into the eager whole-catalog load; it is now only a
// deprecated ALIAS that normalizeSuContextSize maps to 'trimmed' before launch, so the
// `legacy full` cases below assert it produces the IDENTICAL seed rather than merely
// producing some seed — asserting only that `tools` is present would still pass if the
// alias started resolving to a different surface, which is the regression that matters.
describe('buildSuLaunchSpec — contextSize ?tools= seed lever (trimmed-by-default)', () => {
  async function suMcpUrl(
    agent: 'claude' | 'omp' | 'codex',
    opts: { contextSize?: 'full' | 'trimmed' | null; model?: string | null } = {},
  ): Promise<URL> {
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent,
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: opts.contextSize,
      model: opts.model,
    });
    return new URL(spec.mcpUrl);
  }

  const WEAK = 'ollama/maxwell1500/ornith-35b:IQ3_M';
  const FRONTIER = 'anthropic/claude-opus-4-8';

  it('codex + trimmed ⇒ tools= present and EQUALS CORE_MCP_TOOL_NAMES + SU_EXTRA_MCP_TOOL_NAMES (URL-decoded)', async () => {
    const u = await suMcpUrl('codex', { contextSize: 'trimmed' });
    // URLSearchParams.get decodes the %3A/%2C-encoded colon/comma tool names.
    expect(u.searchParams.get('tools')).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
    // …and that round-trips back to the exact list the server allowlist decodes.
    expect(u.searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES]);
    expect(u.searchParams.get('tools')!.split(',')).toContain('coord:declare-intent');
    expect(u.searchParams.get('tools')!.split(',')).toContain('fleet:launch-on-plan');
    // P-010: every su session is seeded with chat:ask_choice too — unconditionally
    // reachable from a live GUI chat (SessionChatModal), unlike a headless role launch.
    expect(u.searchParams.get('tools')!.split(',')).toContain('chat:ask_choice');
    // The superuser door is otherwise unchanged.
    expect(u.searchParams.get('superuser')).toBe('1');
    expect(u.searchParams.get('workspace')).toBe('default');
    // WI-6554700010009993: Codex su homes take this URL verbatim, so the payload tier must be
    // baked here (Claude's user-level entry env-expands it instead).
    expect(u.searchParams.get('ctx_tier')).toBe('trimmed');
  });

  it.each(['claude', 'codex', 'omp'] as const)('%s + trimmed ⇒ seeds the SU-only locks:release cleanup verb', async (agent) => {
    const tools = (await suMcpUrl(agent, { contextSize: 'trimmed' })).searchParams.get('tools')!.split(',');
    expect(tools).toContain('locks:release');
  });

  it('codex + legacy full ⇒ seeds IDENTICALLY to trimmed (alias, not a mode)', async () => {
    const legacy = (await suMcpUrl('codex', { contextSize: 'full' })).searchParams.get('tools');
    const trimmed = (await suMcpUrl('codex', { contextSize: 'trimmed' })).searchParams.get('tools');
    expect(legacy).toBe(trimmed);
    expect(legacy).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
  });

  // dynamic-tool-surface D-004: codex now SEEDS the core spine BY DEFAULT (any tier)
  // for the token-cost win — the seed is a growable floor (tools:find → list_changed
  // re-fetch) + tools:invoke reaches the tail, so nothing is stranded. Nothing opts
  // back into the ~140k-token full catalog: for codex the eager load was not merely
  // expensive but transport-INVALID once the code-mode IPC frame exceeded its limit,
  // which is why 'full' is an alias here rather than a supported escape hatch.
  it('codex + omitted, no model ⇒ tools= present (seed-by-default, D-004 token win)', async () => {
    expect((await suMcpUrl('codex')).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
    expect((await suMcpUrl('codex', { contextSize: null })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  it('codex + FRONTIER model ⇒ tools= present (seed-by-default holds on strong models too)', async () => {
    expect((await suMcpUrl('codex', { model: FRONTIER })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  // weak-model-tool-tier: when contextSize is omitted, the tier is derived from the MODEL.
  it('omp + WEAK model ⇒ tools= present (THE OMP FIX — its native discovery is a no-op)', async () => {
    const u = await suMcpUrl('omp', { model: WEAK });
    expect(u.searchParams.get('tools')).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
  });

  it('omp + FRONTIER model ⇒ tools= present (D-010: trimmed is the default on ALL tiers now)', async () => {
    expect((await suMcpUrl('omp', { model: FRONTIER })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  it('omp + legacy full ⇒ seeds IDENTICALLY to trimmed, even on a FRONTIER model', async () => {
    const legacy = (await suMcpUrl('omp', { model: FRONTIER, contextSize: 'full' })).searchParams.get('tools');
    const trimmed = (await suMcpUrl('omp', { model: FRONTIER, contextSize: 'trimmed' })).searchParams.get('tools');
    expect(legacy).toBe(trimmed);
    // The frontier tier is the case that used to resolve to 'full', so it is the one
    // where a reintroduced tier-derived branch would show up first.
    expect(legacy).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
  });

  it('codex + WEAK model ⇒ tools= present (the tier gates it, not just the manual flag)', async () => {
    expect((await suMcpUrl('codex', { model: WEAK })).searchParams.has('tools')).toBe(true);
  });

  it('omp + FRONTIER model + explicit trimmed ⇒ tools= present (explicit override on any tier)', async () => {
    expect((await suMcpUrl('omp', { model: FRONTIER, contextSize: 'trimmed' })).searchParams.has('tools')).toBe(true);
  });

  it('claude + trimmed ⇒ tools= present and EQUALS CORE_MCP_TOOL_NAMES + SU_EXTRA_MCP_TOOL_NAMES (THE FIX — ToolSearch defers only schemas, not the ~165k of names+descriptions)', async () => {
    const u = await suMcpUrl('claude', { contextSize: 'trimmed' });
    expect(u.searchParams.get('tools')).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
    expect(u.searchParams.get('tools')!.split(',')).toEqual([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES]);
  });

  it('claude + WEAK model ⇒ tools= present (the tier gates the trim for every client)', async () => {
    expect((await suMcpUrl('claude', { model: WEAK })).searchParams.has('tools')).toBe(true);
  });

  it('claude + FRONTIER model, no override ⇒ tools= present (D-010: claude defaults to trimmed too — the ~165k names+descriptions ToolSearch leaves inline are the waste)', async () => {
    expect((await suMcpUrl('claude', { model: FRONTIER })).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
    expect((await suMcpUrl('claude')).searchParams.get('tools')).toBe(
      [...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','),
    );
  });

  it('claude + legacy full ⇒ seeds IDENTICALLY to trimmed', async () => {
    const legacy = (await suMcpUrl('claude', { model: FRONTIER, contextSize: 'full' })).searchParams.get('tools');
    const trimmed = (await suMcpUrl('claude', { model: FRONTIER, contextSize: 'trimmed' })).searchParams.get('tools');
    expect(legacy).toBe(trimmed);
    expect(legacy).toBe([...CORE_MCP_TOOL_NAMES, ...SU_EXTRA_MCP_TOOL_NAMES].join(','));
  });
});

// EI-996 (owner ask 2026-06-17): "planners should be full su agents and get the full su
// prompt, but just a few lines added about their planner role." The mechanism is a
// roleAddendum appended to the rendered playbook — the SU tier (playbook + superuser MCP)
// is what makes it a "full su agent"; the addendum is the "few lines".
describe('buildSuLaunchSpec — roleAddendum (EI-996 su-tier role sessions)', () => {
  const ADDENDUM = '## You are a PLANNER\nOutput is the PLAN, not code.';

  async function suSpec(roleAddendum?: string | null) {
    return buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      ...(roleAddendum === undefined ? {} : { roleAddendum }),
    });
  }

  it('appends the addendum AFTER the playbook body, so the role focus is the final word', async () => {
    const spec = await suSpec(ADDENDUM);
    expect(spec.promptText).toContain('SU PLAYBOOK BODY');
    expect(spec.promptText).toContain(ADDENDUM);
    // Ordering is the point: playbook first, role addendum after it.
    expect(spec.promptText.indexOf(ADDENDUM)).toBeGreaterThan(spec.promptText.indexOf('SU PLAYBOOK BODY'));
  });

  it('keeps the SU tier — an addendum session still gets the superuser MCP door, not a role-scoped one', async () => {
    const spec = await suSpec(ADDENDUM);
    // This is the half of EI-996 that makes it a "full su agent" rather than a reworded role.
    expect(new URL(spec.mcpUrl).searchParams.get('superuser')).toBe('1');
    expect(spec.kind).toBe('su');
    expect(spec.role).toBe('su');
  });

  it('omitted ⇒ byte-identical to a plain su launch (no regression for every existing su session)', async () => {
    const withOut = await suSpec(undefined);
    const explicitNull = await suSpec(null);
    expect(withOut.promptText).not.toContain('You are a PLANNER');
    // The null case must not diverge from the omitted case.
    expect(explicitNull.promptText).toBe(withOut.promptText);
  });

  it('blank / whitespace-only ⇒ treated as absent, with no trailing-newline drift', async () => {
    const baseline = await suSpec(undefined);
    expect((await suSpec('')).promptText).toBe(baseline.promptText);
    expect((await suSpec('   \n\t  ')).promptText).toBe(baseline.promptText);
  });
});

// ── WI-2140338: the 'steward' intermediate tool seed ─────────────────────────
// The steward seed derives exact names from the live projected-tool registry;
// these tests inject listings (pure fn) and switch the module mock (URL path)
// so the semantics are deterministic regardless of what the test process has
// registered.
describe('stewardSeedToolNames + the steward launch seed (WI-2140338)', () => {
  const FAKE_LISTINGS = [
    { name: 'goals:get' },
    { name: 'goals:tripwires' },
    { name: 'blender:grade-idea' },
    { name: 'work_items:checkpoint' },
    { name: 'coord:orient' }, // already in CORE — must dedupe
    { name: 'design-phase:validate_spec' }, // NOT a steward family
    { name: 'templates:list' }, // NOT a steward family
    { name: 'noColon' }, // pathological: no family separator
    { name: ':leadingColon' }, // pathological: empty family
  ];

  beforeEach(() => {
    stewardMockState.listings = null;
  });

  it('expands ONLY steward-family names from the listings, on top of CORE + SU_EXTRA', () => {
    const seed = stewardSeedToolNames(FAKE_LISTINGS);
    for (const included of ['goals:get', 'goals:tripwires', 'blender:grade-idea', 'work_items:checkpoint']) {
      expect(seed).toContain(included);
    }
    for (const excluded of ['design-phase:validate_spec', 'templates:list', 'noColon', ':leadingColon']) {
      expect(seed).not.toContain(excluded);
    }
    // The spine and the su extras ride along in full.
    for (const core of CORE_MCP_TOOL_NAMES) expect(seed).toContain(core);
    for (const extra of SU_EXTRA_MCP_TOOL_NAMES) expect(seed).toContain(extra);
  });

  it('dedupes against the spine and keeps CORE-first ordering', () => {
    const seed = stewardSeedToolNames(FAKE_LISTINGS);
    expect(seed.filter((n) => n === 'coord:orient')).toHaveLength(1);
    expect(seed.slice(0, CORE_MCP_TOOL_NAMES.length)).toEqual([...CORE_MCP_TOOL_NAMES]);
    expect(new Set(seed).size).toBe(seed.length);
  });

  it("su launch with contextSize:'steward' seeds ?tools= with the expanded steward set", async () => {
    stewardMockState.listings = FAKE_LISTINGS;
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'codex',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
      contextSize: 'steward',
    });
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('tools')!.split(',')).toEqual(stewardSeedToolNames(FAKE_LISTINGS));
  });

  it('su launch WITHOUT steward keeps the exact trimmed seed — no drift for existing sessions', async () => {
    stewardMockState.listings = FAKE_LISTINGS; // present, but must not be consulted
    const spec = await buildLaunchSpec({
      kind: 'su',
      agent: 'claude',
      workspaceId: 'default',
      operatorBaseUrl: 'http://localhost:3070',
    });
    const u = new URL(spec.mcpUrl);
    expect(u.searchParams.get('tools')!.split(',')).toEqual([
      ...CORE_MCP_TOOL_NAMES,
      ...SU_EXTRA_MCP_TOOL_NAMES,
    ]);
  });

  it('an explicit steward request against an unpopulated registry REFUSES loudly (never a silent trimmed downgrade)', async () => {
    stewardMockState.listings = [{ name: 'design-phase:validate_spec' }]; // zero steward-family names
    await expect(
      buildLaunchSpec({
        kind: 'su',
        agent: 'codex',
        workspaceId: 'default',
        operatorBaseUrl: 'http://localhost:3070',
        contextSize: 'steward',
      }),
    ).rejects.toThrow(/expanded no steward-family names/);
  });

  it('pipeline roles REFUSE steward — it is an su/goal-holder seed', async () => {
    await expect(
      buildRoleLaunchSpec({
        role: 'worker',
        workspaceId: 'default',
        harnessSlug: 'papercup',
        operatorBaseUrl: 'http://localhost:3070',
        contextSize: 'steward',
      }),
    ).rejects.toThrow(/not a pipeline-role mode/);
  });
});

// identities-v1-2026-08-30 P-022: the Project guide is selected by the WEARER'S STACK.
// buildLaunchSpec threads a composer into renderSuPlaybook; the composer expands the
// session's stack (su static layers + fleet posture + modes) into addressing tokens,
// reads the rows addressed to them, and splices them after the default guide.
// The read is exercised for REAL down to the SQL seam: `getOrgPg()` hands back a stub
// whose `unsafe` records the parameters (workspace, harness, doc, tokens, client axes)
// and returns whatever rows the test queued — so the assertions below are about the
// query the launch actually issues, not about a mocked reader's arguments.
const addressedReadMock = vi.hoisted(() => ({
  fn: vi.fn(async (_params: unknown[]) => [] as unknown[]),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    // The handle shape: `getOrgPg().sql` is the postgres `Sql` the reader calls `unsafe` on.
    getOrgPg: () => ({ sql: { unsafe: (_q: string, params: unknown[]) => addressedReadMock.fn(params) } }),
  };
});

describe('buildSuLaunchSpec — P-022 blueprint-addressable project guide', () => {
  const su = {
    kind: 'su' as const,
    agent: 'claude' as const,
    workspaceId: 'default',
    operatorBaseUrl: 'http://localhost:3070',
    harnessSlug: 'papercup',
  };
  type Composer = (r: { text: string; source: string }) => Promise<{ text: string; addressed: { tokens: string[]; partKeys: string[] } | null }>;
  type ReadInput = { tokens: string[]; harnessSlug: string; client: string };

  function composerFromLastRender(): Composer {
    const call = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { composeProjectGuide?: unknown };
    expect(typeof call.composeProjectGuide).toBe('function');
    return call.composeProjectGuide as Composer;
  }
  const lastRead = (): ReadInput => {
    const params = addressedReadMock.fn.mock.calls.at(-1)?.[0] as [string, string, string, string[], string[]];
    expect(params, 'the composer issued no read').toBeDefined();
    return { harnessSlug: params[1], tokens: params[3], client: params[4][0] };
  };

  describe('frozen native initial context', () => {
    afterEach(() => setSessionConfinementResolver(undefined));

    it('excludes live guides, overrides and plan prose for frozen context', async () => {
      setSessionConfinementResolver(() => {
        return { denyTools: [], denyAmbientContext: true, imposedBy: 'private host', reason: 'frozen context' };
      });
      const spec = await buildLaunchSpec({ ...su, ownerId: 'su-frozen-native', planSlug: 'private-plan',
        planTitle: 'LIVE PLAN SECRET', planNow: { state: 'LIVE SOLUTION', next: 'LIVE ANSWER' } });
      const render = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(render.projectGuideSource).toBe('');
      expect(render.composeProjectGuide).toBeUndefined();
      expect(spec.promptText).toContain('SU PLAYBOOK BODY');
      expect(spec.promptText).not.toMatch(/LIVE PLAN SECRET|LIVE SOLUTION|LIVE ANSWER/);
    });

    it.each(['unavailable', 'missing'])('refuses the native launch when prompt authority is %s', async policy => {
      setSessionConfinementResolver(policy === 'missing' ? undefined : () => { throw new Error('private policy unavailable'); });
      await expect(buildLaunchSpec({ ...su, ownerId: 'su-frozen-native' })).rejects.toThrow(/policy/);
      expect(renderSuPlaybookMock).not.toHaveBeenCalled();
    });

    it('selects the host-owned kernel workflow from exact confinement and refuses unfiltered fallback', async () => {
      const { builtinBlueprintPath } = await import('@papercusp/orchestrator/blueprint');
      setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['coord:whoami'], denyAmbientContext: true,
        denyWorkItemsOutside: { id: 'F-own', harness: 'papercup', checkout: '/proj/papercup' },
        imposedBy: 'private host', reason: 'frozen control arm' }));
      resolvePromptFilesMock.mockReturnValueOnce([join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md')]);
      const spec = await buildLaunchSpec({ ...su, ownerId: 'su-host-owned' });
      const render = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string; projectGuideSource?: string };
      expect(render.baseText).toContain('The host owns this assignment');
      expect(render.baseText).not.toContain('Declare a real intent + claim your lane');
      expect(render.baseText).toContain('File locking is ENFORCED');
      expect(render.projectGuideSource).toBe('');
      expect(new URL(spec.mcpUrl).searchParams.get('superuser')).toBe('1');
      renderSuPlaybookMock.mockClear();
      resolvePromptFilesMock.mockReturnValueOnce([]);
      await expect(buildLaunchSpec({ ...su, ownerId: 'su-host-owned' })).rejects.toThrow(/workflow/);
      expect(renderSuPlaybookMock).not.toHaveBeenCalled();
    });

    it('retains ordinary native guidance when the host proves the session is unconfined', async () => {
      setSessionConfinementResolver(() => null);
      const spec = await buildLaunchSpec({ ...su, ownerId: 'su-ordinary-native', planSlug: 'private-plan',
        planTitle: 'LIVE PLAN TITLE', planNow: { state: 'LIVE STATE', next: 'LIVE NEXT' } });
      expect(spec.promptText).toContain('LIVE PLAN TITLE');
      expect(renderSuPlaybookMock.mock.calls.at(-1)?.[0]).toMatchObject({ composeProjectGuide: expect.any(Function) });
    });
  });

  it('ENGINEER profile: reads with the su static layers + role tokens; no rows ⇒ the default guide byte-identical', async () => {
    addressedReadMock.fn.mockResolvedValueOnce([]);
    await buildLaunchSpec(su);
    const out = await composerFromLastRender()({ text: '# DEFAULT GUIDE\n', source: '/repo/CLAUDE.md' });
    expect(out.text).toBe('# DEFAULT GUIDE\n');
    expect(out.addressed).toBeNull();
    const read = lastRead();
    // The engineer guide is papercusp's own CLAUDE.md, so its parts live under the projector's harness.
    expect(read.harnessSlug).toBe(process.env.PAPERCUSP_HARNESS_SLUG ?? 'papercusp');
    expect(read.client).toBe('claude');
    expect(read.tokens).toEqual(
      expect.arrayContaining(['role:su', 'blueprint:papercusp-engineer', 'slot:domain', 'blueprint:su-collaborator', 'blueprint:su.practice']),
    );
    expect(read.tokens).not.toContain('slot:fleet-posture');
  });

  it('a fleet LEADER launching with AUTO wears su.fleet-leader + su.mode-auto and receives the rows addressed to them', async () => {
    addressedReadMock.fn.mockResolvedValueOnce([
      { part_key: 'lead-1', body: 'LEADER ONLY RULE', ordinal: 1, target_section: 'Fleet', stack_scope: ['blueprint:su.fleet-leader'] },
    ]);
    await buildLaunchSpec({ ...su, fleetRole: 'leader', modes: ['auto'] });
    const out = await composerFromLastRender()({ text: '# DEFAULT GUIDE\n', source: '/repo/CLAUDE.md' });
    expect(lastRead().tokens).toEqual(
      expect.arrayContaining(['blueprint:su.fleet-leader', 'slot:fleet-posture', 'blueprint:su.mode-auto', 'slot:autonomy']),
    );
    expect(out.text.startsWith('# DEFAULT GUIDE\n\n## Addressed guidance')).toBe(true);
    expect(out.text).toContain('LEADER ONLY RULE');
    expect(out.addressed?.partKeys).toEqual(['lead-1']);
  });

  it('renders a selected local domain identity from either supported document on the first SU launch', async () => {
    const { builtinBlueprintPath } = await import('@papercusp/orchestrator/blueprint');
    const dir = mkdtempSync(join(tmpdir(), 'su-selected-domain-'));
    const id = 'fixture-generic-domain';
    const identityDir = join(dir, '.papercusp', 'blueprints', id);
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), [
        `id: ${id}`, 'extends: base', 'version: 1.0.0',
        'description: Generic selected domain.', 'slots:', '  - slot: domain', '',
      ].join('\n'));
      writeFileSync(join(identityDir, 'prompts', 'domain.md'), 'GENERIC SELECTED DOMAIN\n');
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      resolvePromptFilesMock.mockReturnValueOnce([
        join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md'),
      ]);

      const spec = await buildLaunchSpec({ ...su, harnessSlug: 'fixture', stack: [`domain:${id}`] });
      const rendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string };
      expect(rendered.baseText ?? '').toContain('GENERIC SELECTED DOMAIN');
      expect(spec.stack).toEqual([`domain:${id}`]);
      expect(new URL(spec.mcpUrl).searchParams.get('superuser')).toBe('1');

      rmSync(join(identityDir, 'prompts', 'domain.md'));
      writeFileSync(join(identityDir, 'prompts', 'agent-base-overlay.md'), 'CANONICAL DOMAIN OVERLAY\n');
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      resolvePromptFilesMock.mockReturnValueOnce([
        join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md'),
      ]);
      await buildLaunchSpec({ ...su, harnessSlug: 'fixture', stack: [`domain:${id}`] });
      const overlayRendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string };
      expect(overlayRendered.baseText ?? '').toContain('CANONICAL DOMAIN OVERLAY');

      rmSync(join(identityDir, 'prompts', 'agent-base-overlay.md'));
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      resolvePromptFilesMock.mockReturnValueOnce([
        join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md'),
      ]);
      await expect(buildLaunchSpec({ ...su, harnessSlug: 'fixture', stack: [`domain:${id}`] }))
        .rejects.toThrow(/missing domain document/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins the full source chain of rendered provider-only layers without redelivering their providers', async () => {
    const { getIdentitySource } = await import('./agent-identities/source');
    const { replayAgentSpecification } = await import('@papercusp/orchestrator/blueprint');
    const root = mkdtempSync(join(tmpdir(), 'su-provider-source-pins-'));
    const parentDir = join(root, '.papercusp', 'blueprints', 'provider-parent');
    const identityDir = join(root, '.papercusp', 'blueprints', 'provider-practice');
    try {
      mkdirSync(parentDir, { recursive: true });
      mkdirSync(identityDir, { recursive: true });
      const parent = 'id: provider-parent\nextends: base\nversion: 1.0.0\n';
      writeFileSync(join(parentDir, 'blueprint.yaml'), parent);
      writeFileSync(join(identityDir, 'blueprint.yaml'), [
        'id: provider-practice', 'extends: provider-parent', 'version: 1.0.0',
        'slots:', '  - slot: practice', 'contributions:', '  - id: orientation',
        '    purpose: prompt', '    source: provider', '    refresh: turn',
        '    inputKind: prompt-file', '    ref: provider:turn-start-orientation',
        '    producerRef: papercusp.turn-start-orientation@1', '    verb: render',
        '    availability: optional', '',
      ].join('\n'));
      const selected = await getIdentitySource('provider-practice', { repoDir: root });
      if (!selected.ok) throw new Error('provider source fixture refused');
      const compile = () => compileLaunchSpecificationArtifact({
        promptText: 'ALREADY RENDERED SU PROMPT', cwd: root, workspaceId: 'fixture-workspace',
        harnessSlug: null, role: 'su', stack: ['practice:provider-practice'],
        state: { schemaVersion: 1 },
      });
      const first = await compile();
      for (const layer of selected.layers) {
        expect(first.specificationArtifact.inputs).toContainEqual(expect.objectContaining({
          kind: 'blueprint-layer', ref: layer.id, contentHash: layer.contentHash,
          document: expect.objectContaining({ id: layer.id }),
        }));
      }
      expect(first.promptText).toBe('ALREADY RENDERED SU PROMPT');
      expect(replayAgentSpecification(first.specificationArtifact).specificationRevision)
        .toBe(first.specificationRevision);
      writeFileSync(join(parentDir, 'blueprint.yaml'), parent + 'description: Revised provider parent.\n');
      expect((await compile()).specificationRevision).not.toBe(first.specificationRevision);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors the declared fixed prompt of an explicitly selected built-in practice', async () => {
    const { builtinBlueprintPath } = await import('@papercusp/orchestrator/blueprint');
    const baseDir = dirname(builtinBlueprintPath('base'));
    resolvePromptFilesMock.mockReturnValueOnce([join(baseDir, 'prompts', 'su.md')]);
    await buildLaunchSpec({ ...su, stack: ['practice:su.practice'] });
    const rendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string };
    expect(rendered.baseText).toContain(readFileSync(join(baseDir, 'prompts', 'su.practice.md'), 'utf8').trim());
  });

  it('honors a fixed prompt in the selected parent layer instead of a local slot decoy', async () => {
    const { builtinBlueprintPath } = await import('@papercusp/orchestrator/blueprint');
    const root = mkdtempSync(join(tmpdir(), 'su-fixed-parent-'));
    const parentDir = join(root, '.papercusp', 'blueprints', 'fixed-parent');
    const identityDir = join(root, '.papercusp', 'blueprints', 'fixed-child');
    try {
      mkdirSync(join(parentDir, 'prompts'), { recursive: true });
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(parentDir, 'blueprint.yaml'), [
        'id: fixed-parent', 'extends: base', 'version: 1.0.0', 'description: Shared prompt parent.', '',
      ].join('\n'));
      writeFileSync(join(parentDir, 'prompts', 'shared.md'), 'DECLARED PARENT PRACTICE\n');
      writeFileSync(join(identityDir, 'blueprint.yaml'), [
        'id: fixed-child', 'extends: fixed-parent', 'version: 1.0.0', 'description: Selected practice.',
        'slots:', '  - slot: practice', 'contributions:', '  - id: practice-text', '    purpose: prompt',
        '    source: fixed', '    refresh: source-change', '    inputKind: prompt-file',
        '    ref: fixed-parent:shared', '',
      ].join('\n'));
      writeFileSync(join(identityDir, 'prompts', 'practice.md'), 'UNDECLARED LOCAL DECOY\n');
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(root);
      resolvePromptFilesMock.mockReturnValueOnce([join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md')]);
      await buildLaunchSpec({ ...su, harnessSlug: 'fixture', stack: ['practice:fixed-child'] });
      const rendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string };
      expect(rendered.baseText).toContain('DECLARED PARENT PRACTICE');
      expect(rendered.baseText).not.toContain('UNDECLARED LOCAL DECOY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses an explicitly selected local practice document when its id also exists in the built-in SU stack', async () => {
    const { builtinBlueprintPath } = await import('@papercusp/orchestrator/blueprint');
    const dir = mkdtempSync(join(tmpdir(), 'su-selected-practice-'));
    const identityDir = join(dir, '.papercusp', 'blueprints', 'su.practice');
    try {
      mkdirSync(join(identityDir, 'prompts'), { recursive: true });
      writeFileSync(join(identityDir, 'blueprint.yaml'), [
        'id: su.practice', 'extends: base', 'version: 1.0.0',
        'description: Selected local SU practice.', 'slots:', '  - slot: practice', '',
      ].join('\n'));
      writeFileSync(join(identityDir, 'prompts', 'practice.md'), 'SELECTED LOCAL PRACTICE\n');
      vi.mocked(resolveProjectDir).mockResolvedValueOnce(dir);
      resolvePromptFilesMock.mockReturnValueOnce([
        join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md'),
      ]);

      await buildLaunchSpec({ ...su, harnessSlug: 'fixture', stack: ['practice:su.practice'] });
      const rendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string };
      expect(rendered.baseText ?? '').toContain('SELECTED LOCAL PRACTICE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('first render and guide addressing use the selected moderated mode revision', async () => {
    const { parse: parseYaml, stringify: stringifyYaml } = await import('yaml');
    const { blueprintPackageInputs, builtinBlueprintPath, resolveBlueprintSource, resolveBuiltinExtends } =
      await import('@papercusp/orchestrator/blueprint');
    const { buildBlueprintReleaseArchive, commitBlueprintRelease } = await import('./cupboard/blueprint-release');
    const { getSelectedModeCatalog } = await import('./agent-identities/source');
    const root = mkdtempSync(join(tmpdir(), 'launch-mode-selection-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    try {
      process.env.PAPERCUSP_HOME = root;
      const baseline = await getSelectedModeCatalog();
      const id = 'su.mode-auto-launch-variant';
      const sourceDir = join(root, 'source');
      cpSync(dirname(builtinBlueprintPath('su.mode-auto')), sourceDir, { recursive: true });
      const sourceFile = join(sourceDir, 'blueprint.yaml');
      const raw = parseYaml(readFileSync(sourceFile, 'utf8')) as Record<string, unknown>;
      raw.id = id;
      raw.mode = { ...(raw.mode as Record<string, unknown>), title: 'AUTO launch variant',
        replacesRevision: baseline.entries.find((entry) => entry.id === 'auto')!.revision };
      writeFileSync(sourceFile, stringifyYaml(raw));
      writeFileSync(join(sourceDir, 'prompts', 'autonomy.md'), '## AUTO selected from moderated install\n\nFollow the approved variant.\n');
      const resolved = resolveBlueprintSource(raw, { sourcePath: sourceFile, resolve: resolveBuiltinExtends,
        lint: { approvedModePolicyRefs: ['auto'] } });
      const pins = blueprintPackageInputs(resolved, []);
      const hash = buildBlueprintReleaseArchive(pins, id).package.rootHash;
      await commitBlueprintRelease({ installedDir: join(root, 'blueprints'), sourceDir, id,
        version: '1.0.0', source: 'https://github.com/acme/mode', pins,
        modeApproval: { listingId: 'moderated-listing', policyRef: 'auto', approvedArtifactContentHash: hash } });
      resolvePromptFilesMock.mockReturnValueOnce([join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md')]);
      await buildLaunchSpec({ ...su, modes: ['auto'] });
      const rendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string };
      expect(rendered.baseText).toContain('AUTO selected from moderated install');
      expect(rendered.baseText).not.toContain("AUTO mode — the owner's switch");
      await composerFromLastRender()({ text: 'G', source: '/repo/CLAUDE.md' });
      expect(lastRead().tokens).toContain(`blueprint:${id}`);
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  // WI-10004896 (owner #1206): a vm-release workspace host installs EVERY first-party
  // blueprint as a plain, unattested installed-tier copy (offline-content-bundle-install-io,
  // P-309 content roots). The mode catalog treats an exact copy of a built-in mode as that
  // built-in, but the launch re-resolved the id installed-tier first and refused the copy
  // (attestation-missing), so every AUTO launch died at boot with "selected mode identity
  // su.mode-auto is no longer available". The implied su static layers (WI-10004747) were
  // the same trap for EVERY launch. Both must launch from the copies.
  it('launches AUTO when the host content root holds unattested first-party copies', async () => {
    const { SU_STATIC_LAYERS, builtinBlueprintPath } = await import('@papercusp/orchestrator/blueprint');
    const { getIdentitySource } = await import('./agent-identities/source');
    const root = mkdtempSync(join(tmpdir(), 'launch-vm-release-content-'));
    const priorHome = process.env.PAPERCUSP_HOME;
    try {
      process.env.PAPERCUSP_HOME = root;
      const copies = ['base', 'su.mode-auto', ...SU_STATIC_LAYERS.map((layer) => layer.id)];
      for (const id of copies) {
        cpSync(dirname(builtinBlueprintPath(id)), join(root, 'blueprints', id), { recursive: true });
      }
      // The precondition that made the host fail: the copy itself is refused by id.
      const direct = await getIdentitySource('su.mode-auto');
      expect(direct.ok, 'an unattested installed copy is refused when resolved by id').toBe(false);

      resolvePromptFilesMock.mockReturnValueOnce([join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md')]);
      await buildLaunchSpec({ ...su, modes: ['auto'] });
      const rendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string };
      expect(rendered.baseText).toContain("AUTO mode — the owner's switch");

      const workspaceDir = mkdtempSync(join(root, 'workspace-'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const artifact = await compileLaunchSpecificationArtifact({
        promptText: 'SU KERNEL', cwd: workspaceDir, workspaceId: 'fixture-workspace',
        harnessSlug: null, role: 'su', stack: [], impliedStack: 'su-static',
        state: { schemaVersion: 1 },
      });
      expect(artifact.promptText).toBe('SU KERNEL');
      // The unrecorded implied layers are named with the refusal, not swallowed.
      const warned = warn.mock.calls.map((call) => String(call[0]));
      warn.mockRestore();
      expect(warned.some((line) => line.includes('implied domain:') && line.includes('attestation-missing'))).toBe(true);
    } finally {
      if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
      else process.env.PAPERCUSP_HOME = priorHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('WI-6554700010019096: a redirected su.md this build cannot tile renders the serving build su.md instead of refusing a fleet-member AUTO launch', async () => {
    const { builtinBlueprintPath, SU_PREAMBLE_REL, SU_SOURCE_REL } = await import('@papercusp/orchestrator/blueprint');
    const { harnessRoot } = await import('@papercusp/harness/paths');
    const buildSu = join(dirname(builtinBlueprintPath('base')), 'prompts', 'su.md');
    const buildHarness = join(dirname(buildSu), '..', '..', '..');
    const staging = mkdtempSync(join(tmpdir(), 'su-tiling-skew-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The staging tree that D-001 redirects prompt resolution to: its su.md gained a heading
      // this build's SU_TILES do not classify (the 2026-10-21 fleet-launch 400 had three).
      mkdirSync(join(staging, dirname(SU_SOURCE_REL)), { recursive: true });
      writeFileSync(join(staging, SU_SOURCE_REL),
        `${readFileSync(buildSu, 'utf8')}\n## A heading this build has never seen\n\nSTAGING-ONLY TEXT\n`);
      cpSync(join(buildHarness, SU_PREAMBLE_REL), join(staging, SU_PREAMBLE_REL));
      vi.mocked(harnessRoot).mockImplementation(() => buildHarness);
      resolvePromptFilesMock.mockReturnValueOnce([join(staging, SU_SOURCE_REL)]);
      await buildLaunchSpec({ ...su, fleetRole: 'member', modes: ['auto'] });
      const rendered = renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { baseText?: string; baseSource?: string };
      expect(rendered.baseText).toContain("AUTO mode — the owner's switch");
      expect(rendered.baseText).not.toContain('STAGING-ONLY TEXT');
      expect(rendered.baseSource).toBe(join(buildHarness, SU_SOURCE_REL));
      expect(warn.mock.calls.some((call) => String(call[0]).includes('does not tile against this build'))).toBe(true);
    } finally {
      warn.mockRestore();
      vi.mocked(harnessRoot).mockImplementation(() => '/h');
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('two launches in the same pot with different stacks are read with DIFFERENT tokens', async () => {
    await buildLaunchSpec({ ...su, fleetRole: 'leader' });
    await composerFromLastRender()({ text: 'G', source: '/g' });
    const leaderTokens = lastRead().tokens;
    await buildLaunchSpec({ ...su, fleetRole: 'member', modes: ['auto'] });
    await composerFromLastRender()({ text: 'G', source: '/g' });
    const memberTokens = lastRead().tokens;
    expect(leaderTokens).toContain('blueprint:su.fleet-leader');
    expect(memberTokens).toContain('blueprint:su.fleet-member');
    expect(memberTokens).toContain('blueprint:su.mode-auto');
    expect(leaderTokens).not.toContain('blueprint:su.mode-auto');
    expect(leaderTokens).not.toEqual(memberTokens);
  });

  it('GENERIC profile (no repo guide) threads NO composer; POWER reads under the launch harness', async () => {
    await buildLaunchSpec({ ...su, profile: 'generic' });
    expect((renderSuPlaybookMock.mock.calls.at(-1)?.[0] as { composeProjectGuide?: unknown }).composeProjectGuide).toBeUndefined();
    await buildLaunchSpec({ ...su, profile: 'power' });
    await composerFromLastRender()({ text: 'G', source: '/repo/CLAUDE.md' });
    expect(lastRead().harnessSlug).toBe('papercup');
  });
});
