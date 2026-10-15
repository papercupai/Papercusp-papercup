/**
 * WI-6554700010009529 — pins the Codex half of the RTK hook-nag suppression to
 * its single source, RTK_SESSION_ENV.
 *
 * The Codex PreToolUse hook rewrites shell commands to RTK. RTK otherwise prints
 * `[rtk] /!\ No hook installed — run `rtk init -g`` into the tool output, telling
 * the agent to install a second, competing hook. Every managed CODEX_HOME gets
 * the suppression through `[shell_environment_policy.set]`, emitted by the
 * orchestrator's codexManagedFeaturesToml (shared by the psu role-codex-home
 * writer and the spawned-agent writer). The orchestrator cannot import
 * operator-core, so it carries a literal; this test fails if the two drift.
 */
import { parse as parseToml } from '@iarna/toml';
import { codexManagedFeaturesToml } from '@papercusp/orchestrator/codex-gateway-config';
import { describe, expect, it } from 'vitest';
import { RTK_SESSION_ENV } from './agent-tools/capability/rtk-rewrite';

const VARIANTS = [{}, { headless: true }, { disableMemories: false }] as const;

describe('managed CODEX_HOME carries RTK_SESSION_ENV', () => {
  it.each(VARIANTS)('codexManagedFeaturesToml(%o) sets every RTK_SESSION_ENV key in shell_environment_policy.set', (opts) => {
    // A real TOML parse: a misplaced key or duplicate table fails here, as Codex would.
    const parsed = parseToml(codexManagedFeaturesToml(opts).join('\n')) as {
      shell_environment_policy?: { set?: Record<string, unknown> };
      features?: Record<string, unknown>;
    };
    expect(parsed.shell_environment_policy?.set).toEqual({ ...RTK_SESSION_ENV });
    // The new table must not swallow the feature flags it sits next to.
    expect(parsed.features?.remote_compaction_v2).toBe(false);
  });

  it('keeps [features] as the last table, so callers that append feature keys still land in it', () => {
    const lines = codexManagedFeaturesToml();
    const tables = lines.filter((l) => /^\[.+\]$/.test(l.trim()));
    expect(tables[tables.length - 1]).toBe('[features]');
    expect(lines.indexOf('[shell_environment_policy.set]')).toBeLessThan(lines.indexOf('[features]'));
  });
});
