/**
 * EI-7 — the deploy gate's JUDGMENT half must not silently degrade.
 *
 * The deploy mechanics are tested elsewhere (deploy*.test.ts); this covers the
 * release-manager *role* itself — the brain the `system:release-trigger` action
 * dispatches to make the go/no-go call:
 *
 *   1. MODEL PIN — `release-manager` has a COMMITTED model default
 *      (`opus:xhigh`), so on a host with no `AGENT_MODELS` env it still runs at
 *      the intended high tier instead of falling back to the CLI default. The
 *      env STILL overrides (covered exhaustively in operator-core's
 *      harness-invoke-once.test.ts); here we assert the committed floor + that
 *      the real spawn-command resolver applies it with the env UNSET.
 *
 *   2. INSTRUCTIONS — the role has a non-empty in-tree playbook. For a
 *      pipeline/dispatched role that file is the harness-side base role library
 *      `packages/harness/blueprints/base/prompts/<role>.md` (the universal home
 *      every role's persona lives in, and what `resolvePromptFile` loads at spawn) —
 *      NOT an `apps/operator/prompts/<role>.persona.md`, which is loaded only for the
 *      operator/oracle CHAT surfaces (see prompt-assembly.ts `loadRolePersona`).
 *      (Phase 5: the global harness prompts/ dir was deleted; base is canonical.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROLE_MODEL_DEFAULTS, roleModelDefault } from '@papercusp/orchestrator/role-models';
import { applyRoleModel } from '@papercusp/operator-core/lib/harness-invoke-once';

const REPO = resolve(__dirname, '../../../../');
const PERSONA = resolve(REPO, 'libs/papercusp/packages/harness/blueprints/base/prompts/release-manager.md');

afterEach(() => vi.unstubAllEnvs());

describe('EI-7 — release-manager committed model pin', () => {
  it('has a committed high-tier default of opus:xhigh (not env-only)', () => {
    expect(ROLE_MODEL_DEFAULTS['release-manager']).toBe('opus:xhigh');
    expect(roleModelDefault('release-manager')).toBe('opus:xhigh');
  });

  it('maps the committed xhigh floor to Claude Opus 5 max even with AGENT_MODELS UNSET', () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model opus[1m] --effort max');
  });

  it('an explicit AGENT_MODELS entry still OVERRIDES the committed default', () => {
    vi.stubEnv('AGENT_MODELS', JSON.stringify({ 'release-manager': 'claude-opus-4-8:max' }));
    expect(applyRoleModel('claude -p', 'release-manager')).toBe('claude -p --model claude-opus-4-8[1m] --effort max');
  });
});

describe('EI-7 — release-manager has an in-tree instructions playbook', () => {
  it('the role playbook file exists and is non-empty', () => {
    expect(existsSync(PERSONA)).toBe(true);
    const md = readFileSync(PERSONA, 'utf8');
    expect(md.trim().length).toBeGreaterThan(200);
  });

  it('the playbook describes the deploy gate it must judge (go/no-go + the chokepoint)', () => {
    const md = readFileSync(PERSONA, 'utf8').toLowerCase();
    expect(md).toContain('release manager');
    // it must teach the actual gate decision + the deploy entrypoint it drives
    expect(md).toMatch(/go\s*\/\s*no-go|go\/no-go|no-go/);
    expect(md).toContain('deploy-cli.ts');
  });
});
