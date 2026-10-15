import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent-tools/coordination/escalations', () => ({ openEscalation: vi.fn(async () => ({ msg_id: 'esc' })) }));

import { MODEL_WINDOW_1M, MODEL_WINDOW_DEFAULT } from '../agent-config-constants';
import type { GatewayServedRoute } from '../compaction-usage';
import {
  compareVersionsDesc,
  evaluateCanaryProbe,
  parseCliProbeOutput,
  readSavedModelSetting,
  resetClaudeUpdateCanaryForTests,
  resolveActiveClaudeBuild,
  runClaudeUpdateCanaryOnce,
  type CliProbeResult,
} from './claude-update-canary';

const T0 = 1_000_000;
const okCli: CliProbeResult = { ok: true, models: [{ id: 'claude-opus-5-5', contextWindow: 1_000_000 }] };

function route(over: Partial<GatewayServedRoute> = {}): GatewayServedRoute {
  return {
    account: 'acct',
    model: 'claude-opus-5-5',
    context1m: true,
    nativeSessionId: null,
    usage: { inputTotal: 8_016, observedInputFloor: 8_016, observations: 1, at: T0 + 5 },
    at: T0 + 5,
    ...over,
  } as GatewayServedRoute;
}

describe('parseCliProbeOutput', () => {
  it('reads per-model context windows from `-p --output-format json` (shape measured on 2.1.289)', () => {
    const out = parseCliProbeOutput(
      JSON.stringify({ is_error: false, result: 'OK', modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000, inputTokens: 2 } } }),
    );
    expect(out).toEqual({ ok: true, models: [{ id: 'claude-opus-5-5', contextWindow: 1_000_000 }] });
  });

  it('reports unusable output and CLI errors as not ok', () => {
    expect(parseCliProbeOutput('not json').ok).toBe(false);
    const err = parseCliProbeOutput(JSON.stringify({ is_error: true, result: 'API Error: 401' }));
    expect(err.ok).toBe(false);
    expect(err.error).toContain('401');
  });
});

describe('evaluateCanaryProbe', () => {
  const probe = (r: GatewayServedRoute | null, cli: CliProbeResult = okCli) =>
    evaluateCanaryProbe({ variant: 'default', modelSetting: null, startedAt: T0, cli, route: r });

  it('passes a 1M-default family served at 1M, and reports the 1M-sized seeded limit', () => {
    const v = probe(route());
    expect(v.verdict).toBe('pass');
    expect(v.servedWindow).toBe(MODEL_WINDOW_1M);
    expect(v.seededLimit).toBeGreaterThanOrEqual(400_000);
  });

  it('FAILS the WI-10006049 shape: a 1M-default family forwarded without the 1M beta', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-1']) {
      const v = probe(route({ model, context1m: false }));
      expect(v.verdict).toBe('fail');
      expect(v.servedWindow).toBe(MODEL_WINDOW_DEFAULT);
      expect(v.problems[0]).toContain(model);
    }
  });

  it('passes a genuine 200k family at 200k (falsifier: the rule is per family, not "anything under 1M")', () => {
    expect(probe(route({ model: 'claude-haiku-4-5', context1m: false })).verdict).toBe('pass');
  });

  it('never reads a failed measurement as clean', () => {
    expect(probe(route(), { ok: false, error: 'boom', models: [] }).verdict).toBe('not-measured');
    expect(probe(null).verdict).toBe('not-measured');
    expect(probe(route({ at: T0 - 1 })).verdict).toBe('not-measured'); // route from an earlier request
    expect(probe(route({ context1m: null })).verdict).toBe('not-measured');
  });
});

describe('compareVersionsDesc', () => {
  it('orders dotted versions numerically, newest first', () => {
    expect(['2.1.84', '2.1.289', '2.1.280', '2.0.999'].sort(compareVersionsDesc)).toEqual(['2.1.289', '2.1.280', '2.1.84', '2.0.999']);
  });
});

describe('build + saved-model discovery (real temp home)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'cc-canary-home-'));
    await mkdir(path.join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
    await mkdir(path.join(home, '.local', 'bin'), { recursive: true });
    await mkdir(path.join(home, '.claude'), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prefers the symlinked ACTIVE build over a newer installed one, and falls back to the newest', async () => {
    const vdir = path.join(home, '.local', 'share', 'claude', 'versions');
    for (const v of ['2.1.284', '2.1.289']) await writeFile(path.join(vdir, v), '');
    expect((await resolveActiveClaudeBuild(home))?.version).toBe('2.1.289');
    await symlink(path.join(vdir, '2.1.284'), path.join(home, '.local', 'bin', 'claude'));
    expect(await resolveActiveClaudeBuild(home)).toEqual({ version: '2.1.284', binary: path.join(vdir, '2.1.284') });
  });

  it('returns null when nothing is installed, and reads the saved /model pick', async () => {
    expect(await resolveActiveClaudeBuild(home)).toBeNull();
    expect(await readSavedModelSetting(home)).toBeNull();
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus[1m]' }));
    expect(await readSavedModelSetting(home)).toBe('opus[1m]');
  });
});

describe('runClaudeUpdateCanaryOnce', () => {
  const build = { version: '2.1.289', binary: '/x/2.1.289' };
  beforeEach(() => resetClaudeUpdateCanaryForTests());

  function deps(over: Record<string, unknown> = {}) {
    const escalate = vi.fn(async () => {});
    const probe = vi.fn(async () => okCli);
    return {
      escalate,
      probe,
      d: {
        resolveBuild: async () => build,
        readSavedModel: async () => 'opus[1m]',
        probe,
        readRoute: async () => route(),
        escalate,
        now: () => T0,
        ...over,
      },
    };
  }

  it('probes the default AND the saved-model variant through distinct owners, once per build', async () => {
    const { d, probe, escalate } = deps();
    const first = await runClaudeUpdateCanaryOnce(d);
    expect(first.verdict).toBe('pass');
    expect(probe.mock.calls.map((c) => (c as unknown as [{ probeOwner: string; modelSetting: string | null }])[0])).toEqual([
      { binary: '/x/2.1.289', probeOwner: 'claude-update-canary:2.1.289:default', modelSetting: null },
      { binary: '/x/2.1.289', probeOwner: 'claude-update-canary:2.1.289:saved', modelSetting: 'opus[1m]' },
    ]);
    expect(escalate).not.toHaveBeenCalled();
    expect((await runClaudeUpdateCanaryOnce(d)).verdict).toBe('skipped');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('re-probes when a NEW build becomes active', async () => {
    const { d, probe } = deps();
    await runClaudeUpdateCanaryOnce(d);
    await runClaudeUpdateCanaryOnce({ ...d, resolveBuild: async () => ({ version: '2.1.290', binary: '/x/2.1.290' }) });
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('escalates a FAIL naming the build when the gateway serves a 1M family at 200k', async () => {
    const { d, escalate } = deps({ readRoute: async () => route({ context1m: false }) });
    const out = await runClaudeUpdateCanaryOnce(d);
    expect(out.verdict).toBe('fail');
    expect(escalate).toHaveBeenCalledTimes(1);
    const arg = (escalate.mock.calls[0] as unknown as [{ kind: string; build: { version: string } }])[0];
    expect(arg.kind).toBe('fail');
    expect(arg.build.version).toBe('2.1.289');
  });

  it('escalates NOT MEASURED when the CLI fails or no build is installed, and retries after a failed escalation', async () => {
    const failing = deps({ probe: vi.fn(async () => ({ ok: false, error: 'spawn ENOENT', models: [] })) });
    expect((await runClaudeUpdateCanaryOnce(failing.d)).verdict).toBe('not-measured');
    expect((failing.escalate.mock.calls[0] as unknown as [{ kind: string }])[0].kind).toBe('not-measured');

    resetClaudeUpdateCanaryForTests();
    const none = deps({ resolveBuild: async () => null });
    expect((await runClaudeUpdateCanaryOnce(none.d)).verdict).toBe('not-measured');
    expect(none.escalate).toHaveBeenCalledTimes(1);

    resetClaudeUpdateCanaryForTests();
    const flaky = deps({ readRoute: async () => route({ context1m: false }) });
    flaky.escalate.mockRejectedValueOnce(new Error('pg down'));
    await expect(runClaudeUpdateCanaryOnce(flaky.d)).rejects.toThrow('pg down');
    expect((await runClaudeUpdateCanaryOnce(flaky.d)).verdict).toBe('fail'); // not 'skipped'
    expect(flaky.escalate).toHaveBeenCalledTimes(2);
  });
});
