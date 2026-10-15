import { describe, it, expect } from 'vitest';
import type { ArmSubmission, BenchTask } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';
import {
  makeFrontierSweGrader,
  parseFrontierSweReward,
  parseFrontierSweV2Reward,
  resolveHarborReward,
  frontierSweGraderCorpusVersion,
  frontierSweTaskGraderVersion,
  rewardFromJson,
  type FrontierSweGraderConfig,
  type FrontierSweRawReward,
} from './frontier-swe';

const VERSION = 'frontier-swe@testsha / task-images v4';

function inContainerSub(instanceId: string, prefix = 'seed-0', envRef = `cid-${instanceId}`): ArmSubmission {
  return { modality: 'in-container', instanceId, envRef, prefix };
}

/** A grader whose verifier exec is a no-op (code 0) and whose reward read returns `raw` (or throws). */
function graderWithReward(
  rawByInstance: Record<string, FrontierSweRawReward | (() => never)>,
  cfgOverrides: Partial<FrontierSweGraderConfig> = {},
) {
  const calls: { instanceId: string; envRef: string; oracle?: boolean }[] = [];
  const exec: ProcExec = async () => ({ stdout: '', stderr: '', code: 0 });
  const fs: GraderFs = {
    mkdtemp: async (p) => `${p}tmp`,
    writeFile: async () => {},
    readFile: async () => '',
    rm: async () => {},
  };
  const cfg: FrontierSweGraderConfig = {
    version: VERSION,
    buildVerifierCommand: (ctx) => {
      calls.push(ctx);
      return { cmd: 'docker', args: ['exec', ctx.envRef, 'bash', '/tests/test.sh'] };
    },
    readReward: async ({ instanceId }) => {
      const r = rawByInstance[instanceId];
      if (typeof r === 'function') return r();
      if (!r) throw new Error(`no reward fixture for ${instanceId}`);
      return r;
    },
    ...cfgOverrides,
  };
  return { grader: makeFrontierSweGrader(cfg, { exec, fs }), calls };
}

const V2_COMMIT = 'da83f84f8fbcec3cbf0f2b17c98ebc811355c2df';
const V2_VERIFIER = `us-docker.pkg.dev/proximal-evals-public/t@sha256:${'c'.repeat(64)}`;
const v2Task = (instanceId: string, meta: Record<string, unknown> = {}): BenchTask => ({
  benchmark: 'frontier-swe',
  instanceId,
  problemStatement: 'x',
  graderMeta: {
    corpusVersion: 'v2',
    upstreamCommit: V2_COMMIT,
    verifierEnvironmentMode: 'separate',
    verifierDockerImage: V2_VERIFIER,
    ...meta,
  },
});
const files = (json: string | null, txt: string | null): FrontierSweRawReward => ({ rewardScalar: null, files: { json, txt } });

describe('resolveHarborReward — v2 reward precedence (plan D-003 §3)', () => {
  it('reward.json is PRIMARY whenever it exists, even when reward.txt disagrees', () => {
    expect(resolveHarborReward({ json: '{"reward": 0.25}', txt: '0.9' })).toMatchObject({ ok: true, reward: 0.25, source: 'reward.json', key: 'reward' });
  });
  it('accepts a bare number, the score key, or a sole key — and keeps every named reward', () => {
    expect(resolveHarborReward({ json: '0.5', txt: null })).toMatchObject({ ok: true, reward: 0.5, key: null });
    expect(resolveHarborReward({ json: '{"score": 0.4, "aux": 2}', txt: null })).toMatchObject({ reward: 0.4, key: 'score', rewards: { score: 0.4, aux: 2 } });
    expect(resolveHarborReward({ json: '{"accuracy": 0.7}', txt: null })).toMatchObject({ reward: 0.7, key: 'accuracy' });
  });
  it('a malformed reward.json is an error and NEVER falls back to reward.txt', () => {
    for (const json of ['', '   ', 'not json', '[0.5]', '{}', '{"reward": "0.5"}', '{"reward": 0.5, "note": "x"}', '{"a": 0.1, "b": 0.2}']) {
      const r = resolveHarborReward({ json, txt: '0.9' });
      expect(r.ok, json).toBe(false);
    }
  });
  it('reward.txt is read only when reward.json is ABSENT; empty / non-numeric / inf are errors', () => {
    expect(resolveHarborReward({ json: null, txt: '0.6\n' })).toMatchObject({ ok: true, reward: 0.6, source: 'reward.txt' });
    for (const txt of ['', '\n', 'abc', 'inf', 'nan', '0.5 0.6']) expect(resolveHarborReward({ json: null, txt }).ok, txt).toBe(false);
  });
  it('neither file → error (no verdict)', () => {
    expect(resolveHarborReward({ json: null, txt: null })).toMatchObject({ ok: false, error: expect.stringMatching(/neither/) });
  });
});

describe('parseFrontierSweV2Reward', () => {
  it('FSWE-P003-REWARD: a v2 verifier that writes reward.json → that value IS the task score', () => {
    const g = parseFrontierSweV2Reward(files('{"reward": 0.42, "latency_ms": 12}', '0.99'), 'astronomy-toolkit', 's', 'frontier-swe@v2+x');
    expect(g.graderError).toBeUndefined();
    expect(g.score).toBe(0.42);
    expect(g.rawGraderOutput).toMatchObject({ source: 'reward.json', rewards: { reward: 0.42, latency_ms: 12 }, clamped: false });
  });
  it('a real 0 COUNTS; an invalid reward is a graderError with score null (never 0)', () => {
    expect(parseFrontierSweV2Reward(files('{"reward": 0}', null), 'x', 's', 'v').score).toBe(0);
    const bad = parseFrontierSweV2Reward(files('', '0.8'), 'x', 's', 'v');
    expect(bad.score).toBeNull();
    expect(bad.graderError).toMatch(/reward.json exists but is empty/);
  });
  it('a reader that returned no raw files cannot be graded under Harbor precedence', () => {
    expect(parseFrontierSweV2Reward({ rewardScalar: 0.5 }, 'x', 's', 'v').graderError).toMatch(/no raw reward files/);
  });
});

describe('per-task grader version (plan R-1: v1 and v2 never mix)', () => {
  it('v2 pins the corpus commit + digest-pinned verifier image; v1 pins the configured version', () => {
    const v2 = frontierSweTaskGraderVersion(v2Task('t'), undefined);
    expect(v2).toEqual({ ok: true, version: `frontier-swe@v2+da83f84f8fbc verifier=${V2_VERIFIER}`, corpusVersion: 'v2' });
    expect(frontierSweTaskGraderVersion(undefined, VERSION)).toEqual({ ok: true, version: `frontier-swe@v1 ${VERSION}`, corpusVersion: 'v1' });
    expect(frontierSweGraderCorpusVersion(v2.version)).toBe('v2');
    expect(frontierSweGraderCorpusVersion(`frontier-swe@v1 ${VERSION}`)).toBe('v1');
    expect(frontierSweGraderCorpusVersion(VERSION)).toBe('v1'); // an untagged legacy row is v1 history
  });
  it('refuses an unpinnable row instead of guessing', () => {
    expect(frontierSweTaskGraderVersion(v2Task('t', { verifierDockerImage: 'img:latest' }), VERSION)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/digest-pinned/),
    });
    expect(frontierSweTaskGraderVersion(v2Task('t', { upstreamCommit: 'abc' }), VERSION)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/commit/),
    });
    expect(frontierSweTaskGraderVersion(undefined, undefined)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/PAPERCUSP_FRONTIER_SWE_VERSION/),
    });
  });
});

describe('makeFrontierSweGrader — v2 separate verifier', () => {
  function v2Grader(raw: FrontierSweRawReward, opts: { prepareFails?: boolean; releaseFails?: boolean; noHook?: boolean } = {}) {
    const events: string[] = [];
    const { grader, calls } = graderWithReward(
      { t: raw },
      {
        version: undefined,
        prepareVerifierEnv: opts.noHook
          ? undefined
          : async ({ envRef }) => {
              events.push(`prepare:${envRef}`);
              if (opts.prepareFails) throw new Error('image pull failed');
              return {
                verifierRef: 'verifier-1',
                release: async () => {
                  events.push('release');
                  if (opts.releaseFails) throw new Error('rm failed');
                },
              };
            },
        readReward: async ({ verifierRef }) => {
          events.push(`read:${verifierRef}`);
          return raw;
        },
      },
    );
    return { grader, calls, events };
  }

  it('prepares the separate env, verifies + reads THERE, scores reward.json, releases, stamps the v2 version', async () => {
    const { grader, calls, events } = v2Grader(files('{"reward": 0.61}', null));
    const [g] = await grader.grade([inContainerSub('t', 's', 'arm-1')], [v2Task('t')]);
    expect(g.score).toBe(0.61);
    expect(g.graderVersion).toBe(`frontier-swe@v2+da83f84f8fbc verifier=${V2_VERIFIER}`);
    expect(calls[0]).toMatchObject({ envRef: 'arm-1', verifierRef: 'verifier-1' });
    expect(events).toEqual(['prepare:arm-1', 'read:verifier-1', 'release']);
  });

  it('no prepareVerifierEnv hook → graderError (a v2 task cannot be graded in the arm container)', async () => {
    const { grader } = v2Grader(files('{"reward": 1}', null), { noHook: true });
    const [g] = await grader.grade([inContainerSub('t')], [v2Task('t')]);
    expect(g.score).toBeNull();
    expect(g.graderError).toMatch(/SEPARATE verifier environment/);
  });

  it('a failed prepare is a graderError; a failed release is recorded but keeps the verdict', async () => {
    const prep = v2Grader(files('{"reward": 1}', null), { prepareFails: true });
    expect((await prep.grader.grade([inContainerSub('t')], [v2Task('t')]))[0].graderError).toMatch(/image pull failed/);
    const rel = v2Grader(files('{"reward": 0.5}', null), { releaseFails: true });
    const [g] = await rel.grader.grade([inContainerSub('t')], [v2Task('t')]);
    expect(g.score).toBe(0.5);
    expect(g.rawGraderOutput).toMatchObject({ verifierReleaseError: 'rm failed' });
  });

  it('releases even when the reward read throws', async () => {
    const events: string[] = [];
    const { grader } = graderWithReward(
      { t: () => { throw new Error('container vanished'); } },
      { prepareVerifierEnv: async () => ({ verifierRef: 'v', release: async () => void events.push('release') }) },
    );
    const [g] = await grader.grade([inContainerSub('t')], [v2Task('t')]);
    expect(g.graderError).toMatch(/container vanished/);
    expect(events).toEqual(['release']);
  });

  it('a v1 task graded with no version pin is an error row; with the pin it is stamped frontier-swe@v1', async () => {
    const bare = graderWithReward({ x: { rewardScalar: 0.3 } }, { version: undefined });
    expect((await bare.grader.grade([inContainerSub('x')], []))[0].graderError).toMatch(/no version pin/);
    const pinned = graderWithReward({ x: { rewardScalar: 0.3 } });
    const [g] = await pinned.grader.grade([inContainerSub('x')], []);
    expect(g.score).toBe(0.3);
    expect(g.graderVersion).toBe(`frontier-swe@v1 ${VERSION}`);
  });
});

describe('rewardFromJson', () => {
  it('reads a bare number', () => expect(rewardFromJson(0.42)).toBe(0.42));
  it('prefers the `reward` key', () => expect(rewardFromJson({ reward: 0.7, score: 0.1 })).toBe(0.7));
  it('falls back to the `score` key', () => expect(rewardFromJson({ score: 0.33 })).toBe(0.33));
  it('returns null for a non-numeric / shapeless value', () => {
    expect(rewardFromJson({ foo: 'bar' })).toBeNull();
    expect(rewardFromJson(null)).toBeNull();
    expect(rewardFromJson('0.5')).toBeNull();
    expect(rewardFromJson(Number.NaN)).toBeNull();
  });
});

describe('parseFrontierSweReward — the pure scoring map', () => {
  it('scores a partial reward.txt scalar (resolved false — the common FrontierSWE case)', () => {
    const g = parseFrontierSweReward({ rewardScalar: 0.6 }, 'cranelift-codegen-opt', 'seed-0', VERSION);
    expect(g.score).toBe(0.6);
    expect(g.resolved).toBe(false);
    expect(g.graderError).toBeUndefined();
    expect(g.graderFamily).toBe('frontier-swe');
    expect(g.graderVersion).toBe(VERSION);
  });

  it('resolved=true only when score reaches 1', () => {
    expect(parseFrontierSweReward({ rewardScalar: 1 }, 'git-to-zig', 's', VERSION).resolved).toBe(true);
    expect(parseFrontierSweReward({ rewardScalar: 0.999 }, 'git-to-zig', 's', VERSION).resolved).toBe(false);
  });

  it('a real 0 reward COUNTS (score 0, resolved false, NO graderError) — empty/no-progress is a capability fail', () => {
    const g = parseFrontierSweReward({ rewardScalar: 0 }, 'lua-native-compiler', 's', VERSION);
    expect(g.score).toBe(0);
    expect(g.resolved).toBe(false);
    expect(g.graderError).toBeUndefined();
  });

  it('falls back to reward.json when reward.txt scalar is absent', () => {
    expect(parseFrontierSweReward({ rewardScalar: null, rewardJson: { reward: 0.4 } }, 'x', 's', VERSION).score).toBe(0.4);
    expect(parseFrontierSweReward({ rewardScalar: null, rewardJson: { score: 0.25 } }, 'x', 's', VERSION).score).toBe(0.25);
  });

  it('clamps out-of-range rewards into [0,1]', () => {
    expect(parseFrontierSweReward({ rewardScalar: 1.5 }, 'x', 's', VERSION).score).toBe(1);
    expect(parseFrontierSweReward({ rewardScalar: 1.5 }, 'x', 's', VERSION).resolved).toBe(true);
    expect(parseFrontierSweReward({ rewardScalar: -0.3 }, 'x', 's', VERSION).score).toBe(0);
  });

  it('an ABSENT reward (no scalar, no json) is a graderError — surfaced + excluded, score null (NOT a silent 0)', () => {
    const g = parseFrontierSweReward({ rewardScalar: null, rewardJson: null }, 'x', 's', VERSION);
    expect(g.score).toBeNull();
    expect(g.resolved).toBe(false);
    expect(g.graderError).toBeTruthy();
  });

  it('null/undefined raw → graderError', () => {
    expect(parseFrontierSweReward(null, 'x', 's', VERSION).graderError).toBeTruthy();
    expect(parseFrontierSweReward(undefined, 'x', 's', VERSION).score).toBeNull();
  });
});

describe('makeFrontierSweGrader — in-container batch', () => {
  const tasks: BenchTask[] = [];

  it('grades each in-container submission via its own verifier → continuous score', async () => {
    const { grader, calls } = graderWithReward({
      'cranelift-codegen-opt': { rewardScalar: 0.73 },
      'git-to-zig': { rewardScalar: 0.0 },
    });
    const subs = [inContainerSub('cranelift-codegen-opt'), inContainerSub('git-to-zig')];
    const results = await grader.grade(subs, tasks);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.instanceId === 'cranelift-codegen-opt')?.score).toBe(0.73);
    expect(results.find((r) => r.instanceId === 'git-to-zig')?.score).toBe(0);
    expect(results.every((r) => r.graderError === undefined)).toBe(true);
    expect(calls.map((c) => c.instanceId).sort()).toEqual(['cranelift-codegen-opt', 'git-to-zig']);
  });

  it('family + modality are frontier-swe / in-container', () => {
    const { grader } = graderWithReward({});
    expect(grader.family).toBe('frontier-swe');
    expect(grader.modality).toBe('in-container');
  });

  it('ignores non-in-container submissions (FrontierSWE is in-container only)', async () => {
    const { grader } = graderWithReward({});
    const diffSub: ArmSubmission = { modality: 'diff', instanceId: 'x', patch: '', prefix: 's' };
    expect(await grader.grade([diffSub], tasks)).toEqual([]);
  });

  it('a reward-read failure becomes a graderError (surfaced, never a silent fail)', async () => {
    const { grader } = graderWithReward({
      broken: () => {
        throw new Error('docker cp: no such file /logs/verifier/reward.txt');
      },
    });
    const [r] = await grader.grade([inContainerSub('broken')], tasks);
    expect(r.score).toBeNull();
    expect(r.resolved).toBe(false);
    expect(r.graderError).toContain('could not read FrontierSWE reward');
  });

  it('a verifier exec that throws (spawn failure) becomes a graderError, not a crash', async () => {
    const exec: ProcExec = async () => {
      throw new Error('spawn docker ENOENT');
    };
    const fs: GraderFs = { mkdtemp: async (p) => p, writeFile: async () => {}, readFile: async () => '', rm: async () => {} };
    const grader = makeFrontierSweGrader(
      {
        version: VERSION,
        buildVerifierCommand: (ctx) => ({ cmd: 'docker', args: ['exec', ctx.envRef] }),
        readReward: async () => ({ rewardScalar: 1 }),
      },
      { exec, fs },
    );
    const [r] = await grader.grade([inContainerSub('boom')], tasks);
    expect(r.graderError).toContain('verifier exec failed');
    expect(r.score).toBeNull();
  });
});
