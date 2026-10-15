/**
 * role-launch — the one answer to "what will this role launch as?"
 *
 * Plan role-model-one-answer-2026-09-03 P-007. Covers the three properties the
 * plan exists to guarantee, each pinned to the failure it prevents:
 *
 *   1. EXPLICIT-WINS (P-002/D-001) — `models[role]` beats the tier menu.
 *      The gap it closes: the launch path consulted only the tier menu, so a
 *      correctly-set per-role model was inert and nine release-fixers (2026-09-03
 *      00:32Z→01:27Z) spawned onto a usage-walled codex account.
 *   2. BACKEND-RIDES-WITH-THE-MODEL (P-003) — the CLI comes from the model
 *      catalog / the tier row, and `roleBackends` is the fallback for when no
 *      per-role model is set.
 *   3. CONTRADICTION IS REPORTED (P-005) — a `roleBackends` entry the model
 *      overrules is neither silently applied nor silently dropped.
 *
 * Plus P-006's per-key ceiling merge, which is the same silent-write class.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendForModelSpec } from '../agent-config-constants';
import { effectiveTierConfig } from './model-tiers';
import { resolveRoleLaunch, resolveRoleLaunchLive, type RoleLaunchConfig, type RoleLaunchDeclaration } from './role-launch';
import { roleLaunchVerdict } from '../agent-tools/config/role-launch';

const { readConfigMock } = vi.hoisted(() => ({ readConfigMock: vi.fn<() => Promise<RoleLaunchConfig>>(async () => ({})) }));
vi.mock('../agent-config', async (original) => ({
  ...await original<typeof import('../agent-config')>(), readAgentConfig: readConfigMock,
}));
vi.mock('../owner-steering', () => ({ getOwnerSteering: vi.fn(async () => null) }));
afterEach(() => { vi.unstubAllEnvs(); readConfigMock.mockResolvedValue({}); });

describe('R-3 declared routing through the live role resolver', () => {
  const backups: RoleLaunchDeclaration['backups'] = [
    { backend: 'claude-code', model: 'sonnet', effort: 'medium', account: 'default' },
    { backend: 'claude-code', model: 'haiku', effort: 'high', account: 'pin:fixture-account' },
  ];
  const declaration: RoleLaunchDeclaration = { id: 'r3-custom', reactive: false, account: 'auto', backups };

  it('declared route and ordered backups survive live resolution', async () => {
    const fromBlueprint = await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration });
    expect(fromBlueprint.account).toBe('auto');
    expect(fromBlueprint.backups).toEqual(backups);
    readConfigMock.mockResolvedValue({ roleAccounts: { 'r3-custom': 'pin:workspace-account' }, roleBackups: { 'r3-custom': [...backups].reverse() } });
    const fromConfig = await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration });
    expect(fromConfig.account).toBe('pin:workspace-account');
    expect(fromConfig.backups).toEqual([...backups].reverse());
    expect(fromConfig.backups).not.toBe(backups);
  });

  it('undeclared role preserves host command inheritance', async () => {
    vi.stubEnv('AGENT_CMD', 'omp -p');
    vi.stubEnv('PAPERCUSP_ACCOUNT', 'pin:host-account');
    const result = await resolveRoleLaunchLive('r3-external');
    expect(result.backend).toBeNull();
    expect(result.backendSource).toBe('inherit');
    expect(result.spawnModel).toBeNull();
    expect(result.account).toBeNull();
    expect(result.backups).toEqual([]);
    expect(process.env.AGENT_CMD).toBe('omp -p');
  });

  it('release fixer defaults to auto route and claude backup', async () => {
    const result = await resolveRoleLaunchLive('release-fixer');
    expect(result.account).toBe('auto');
    expect(result.backups).toEqual([{ backend: 'claude-code', model: 'opus', effort: 'max', account: 'auto' }]);
    for (const role of ['merge-resolver', 'content-fixer', 'doc-steward']) expect((await resolveRoleLaunchLive(role)).account, role).toBe('auto');
  });

  it('caller account override precedes role route then ambient inheritance', async () => {
    vi.stubEnv('PAPERCUSP_ACCOUNT', 'pin:host-account');
    vi.stubEnv('PAPERCUSP_CODEX_GATEWAY', '0');
    expect((await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration, account: 'default' })).account).toBe('default');
    expect((await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration, account: 'pin:caller-account' })).account).toBe('pin:caller-account');
    expect((await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration })).account).toBe('auto');
    readConfigMock.mockResolvedValue({ roleAccounts: { 'r3-custom': 'default' } });
    expect((await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration })).account).toBe('default');
    expect((await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration, account: 'auto' })).account).toBe('auto');
    expect((await resolveRoleLaunchLive('r3-custom', { blueprintRole: declaration, account: null })).account).toBeNull();
    readConfigMock.mockResolvedValue({});
    expect((await resolveRoleLaunchLive('r3-external')).account).toBeNull();
  });
});

describe('backendForModelSpec — the CLI rides with the model', () => {
  it('reads Anthropic versioned ids as claude-code (the id an owner actually types)', () => {
    // The exact spec from the incident. `launchAgentBackendForModel` returns null
    // for it (not a bare menu alias), which is why the wider derivation exists.
    expect(backendForModelSpec('claude-opus-5:xhigh')).toEqual({
      backend: 'claude-code',
      evidence: 'model-shape',
    });
  });

  it('reads bare menu aliases from the catalog, effort and [1m] marker included', () => {
    expect(backendForModelSpec('opus[1m]:high')).toEqual({
      backend: 'claude-code',
      evidence: 'model-catalog',
    });
    expect(backendForModelSpec('sol:xhigh')).toEqual({ backend: 'codex', evidence: 'model-catalog' });
  });

  it('reads codex shapes as codex — including openai-codex/, which LOOKS like an OMP selector', () => {
    // Ordering guard: `openai-codex/<id>` contains a slash, so a provider/id-first
    // rule would call it OMP and pair a Codex model with the wrong binary.
    expect(backendForModelSpec('openai-codex/gpt-5.6')?.backend).toBe('codex');
    expect(backendForModelSpec('gpt-5.6-luna:high')?.backend).toBe('codex');
    expect(backendForModelSpec('chatgpt:5.5')?.backend).toBe('codex');
  });

  it('reads a provider-qualified selector as OMP', () => {
    expect(backendForModelSpec('anthropic/claude-opus-4-7')).toEqual({
      backend: 'omp',
      evidence: 'model-catalog',
    });
  });

  it('returns null for an unrecognized id instead of guessing a CLI', () => {
    // A guess here pairs a model with a binary that cannot run it — fatal at launch
    // and near-silent in the logs. Null makes the caller fall back to configuration.
    expect(backendForModelSpec('some-unknown-model:high')).toBeNull();
    expect(backendForModelSpec('')).toBeNull();
    expect(backendForModelSpec(undefined)).toBeNull();
  });
});

describe('resolveRoleLaunch — explicit per-role model wins', () => {
  it('prefers models[role] over the tier menu, and reports which rule won', () => {
    const r = resolveRoleLaunch('mug', {
      cfg: {
        models: { mug: 'claude-opus-5:xhigh' },
        // A ceiling that would otherwise steer the role somewhere else entirely.
        tierCeilings: { mug: 'luna' },
      },
    });
    expect(r.spawnModel).toBe('claude-opus-5:xhigh');
    expect(r.model).toBe('claude-opus-5:xhigh');
    expect(r.source).toBe('per-role');
    expect(r.backend).toBe('claude-code');
    expect(r.why).toContain("models['mug']");
  });

  it('THE INCIDENT: release-fixer resolves to the configured Claude pair, not codex', () => {
    const r = resolveRoleLaunch('release-fixer', {
      cfg: {
        models: { 'release-fixer': 'claude-opus-5:xhigh' },
        roleBackends: { 'release-fixer': 'claude-code' },
      },
    });
    expect(r.model).toBe('claude-opus-5:xhigh');
    expect(r.backend).toBe('claude-code');
    expect(r.source).toBe('per-role');
    // Model and configured backend AGREE, so there is nothing to report.
    expect(r.conflict).toBeNull();
  });

  it('falls to the tier menu when no per-role model is set', () => {
    const r = resolveRoleLaunch('mug', { cfg: { tierCeilings: { mug: 'luna' } } });
    expect(r.source).toBe('tier-menu');
    expect(r.spawnModel).toBe('gpt-5.6-luna:high');
    // P-003: the winning TIER ROW declares its own backend, which is the most
    // direct statement available — no shape-matching required.
    expect(r.backend).toBe('codex');
    expect(r.backendSource).toBe('tier-row');
  });

  it('leaves an unconfigured role on its committed default with NO spawn override', () => {
    const r = resolveRoleLaunch('mug', { cfg: {} });
    // The invariant that keeps un-steered launches byte-identical to before.
    expect(r.spawnModel).toBeNull();
    expect(r.source).toBe('committed-default');
    expect(r.model).toBe('opus:xhigh');
    // AND the backend is NOT pinned from that committed default: the host's own
    // AGENT_CMD outranks a code-level floor. Pinning it here would silently overrule
    // an operator running `AGENT_CMD='omp -p'` for every role with a committed spec.
    expect(r.backend).toBeNull();
    expect(r.backendSource).toBe('inherit');
  });

  it('but a Codex-only COMMITTED default still forces codex — nothing else can run it', () => {
    // The single exception (WI-4640, kettle 2026-07-16): a claude binary handed
    // `--model gpt-5.6-luna` dies at launch, near-silently.
    const r = resolveRoleLaunch('codex-floored-role', { cfg: {} });
    expect(r.backend).toBeNull(); // no committed default at all for this made-up role
    const forced = resolveRoleLaunch('x', { cfg: { models: { x: 'gpt-5.6-luna:high' } } });
    expect(forced.backend).toBe('codex');
  });

  it('reports no model at all for a role with no committed default', () => {
    const r = resolveRoleLaunch('operator', { cfg: {} });
    expect(r.spawnModel).toBeNull();
    expect(r.model).toBe('');
    expect(r.backend).toBeNull();
    expect(r.backendSource).toBe('inherit');
  });
});

describe('resolveRoleLaunch — roleBackends is the FALLBACK, not a competitor', () => {
  it('uses roleBackends when no per-role model carries a backend', () => {
    const r = resolveRoleLaunch('release-fixer', { cfg: { roleBackends: { 'release-fixer': 'omp' } } });
    expect(r.source).toBe('committed-default');
    expect(r.backend).toBe('omp');
    expect(r.backendSource).toBe('role-backends');
    expect(r.conflict).toBeNull();
  });

  it('lets the model overrule a disagreeing roleBackends AND says so', () => {
    const r = resolveRoleLaunch('release-fixer', {
      cfg: {
        models: { 'release-fixer': 'sol:xhigh' },
        roleBackends: { 'release-fixer': 'claude-code' },
      },
    });
    expect(r.backend).toBe('codex');
    expect(r.conflict).toEqual({
      configured: 'claude-code',
      effective: 'codex',
      note: expect.stringContaining('IGNORED'),
    });
  });

  it('a Codex-only committed default forces codex even over an explicit roleBackends', () => {
    // WI-4640 / kettle 2026-07-16: honouring a claude preference against a
    // Codex-only spec hard-downed the role at launch. The exception is deliberate.
    const r = resolveRoleLaunch('legacy-codex-role', {
      cfg: { models: { 'legacy-codex-role': 'gpt-5.6-luna:high' }, roleBackends: { 'legacy-codex-role': 'claude-code' } },
    });
    expect(r.backend).toBe('codex');
    expect(r.conflict?.configured).toBe('claude-code');
  });
});

describe('roleLaunchVerdict', () => {
  // A coherent baseline: an explicit per-role model, whose backend rides in with it.
  const row = (over: Partial<ReturnType<typeof resolveRoleLaunch>>) =>
    ({
      ...resolveRoleLaunch('mug', { cfg: { models: { mug: 'claude-opus-5:xhigh' } } }),
      ...over,
    }) as ReturnType<typeof resolveRoleLaunch>;

  it('is consistent when every role resolves coherently', () => {
    expect(roleLaunchVerdict([row({})])).toBe('consistent');
  });

  it('reports conflicted ahead of undetermined — a wrong CLI outranks an inherited one', () => {
    const conflicted = row({
      conflict: { configured: 'omp', effective: 'codex', note: 'x' },
    });
    const undetermined = row({ backend: null });
    expect(roleLaunchVerdict([undetermined, conflicted])).toBe('conflicted');
    expect(roleLaunchVerdict([undetermined])).toBe('undetermined');
  });
});

describe('effectiveTierConfig — P-006, ceilings merge per key', () => {
  it('keeps workspace ceilings a session override does not name', () => {
    // The old whole-object replace erased every standing cap the moment a session
    // override named ONE role — capping `mug` silently RAISED `cup`.
    const eff = effectiveTierConfig(
      { tierCeilings: { mug: 'standard', cup: 'quick' } },
      { tierCeilings: { mug: 'deep' } },
    );
    expect(eff.tierCeilings).toEqual({ mug: 'deep', cup: 'quick' });
  });

  it('still lets the session win for the roles it names, and passes each side through alone', () => {
    expect(effectiveTierConfig({ tierCeilings: { mug: 'quick' } }, null).tierCeilings).toEqual({ mug: 'quick' });
    expect(effectiveTierConfig(null, { tierCeilings: { mug: 'deep' } }).tierCeilings).toEqual({ mug: 'deep' });
    expect(effectiveTierConfig(null, null).tierCeilings).toBeUndefined();
  });

  it('REPLACES the tier menu wholesale — an ordered ranking cannot be merged', () => {
    const workspace = { tiers: [{ name: 'a', spec: 'haiku' }, { name: 'b', spec: 'sonnet' }] };
    const session = { modelTiers: [{ name: 'c', spec: 'opus' }] };
    expect(effectiveTierConfig(workspace, session).tiers).toEqual(session.modelTiers);
  });
});
