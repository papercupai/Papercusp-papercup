import { describe, expect, it, vi } from 'vitest';
import {
  describeDependencyPrediction,
  isDependencyInputPath,
  parseDependencyGenerationPrediction,
  predictDependencyGeneration,
  type PredictionCommand,
} from './dependency-admission-prediction';

const REF = 'a'.repeat(40);
const INPUT = '1'.repeat(64);
const LIVE = '2'.repeat(64);
const line = (verdict: string, links = 0, ref = REF) =>
  `DEPENDENCY_GENERATION_PREDICTION schema=1 ref=${ref} input=${INPUT} live=${LIVE} verdict=${verdict} links=${links}`;

describe('WI-10004151: dependency-input path filter mirrors the shell manifest', () => {
  it('uses maintained tooling while predicting the exact foreign target ref', async () => {
    const command = vi.fn<PredictionCommand>().mockResolvedValue({ code: 0, stdout: `${line('live-match')}\n`, stderr: '' });
    const out = await predictDependencyGeneration({
      integrationRoot: '/app', toolingRoot: '/operator', ref: REF,
      paths: ['package-lock.json'], run: command,
    });
    expect(command).toHaveBeenCalledWith('bash', [
      '/operator/apps/operator/bin/release/dependency-generation.sh',
      '--integration', '/app', '--predict-ref', REF,
    ], expect.objectContaining({ cwd: '/app' }));
    expect(out).toMatchObject({ verdict: 'live-match', ref: REF });
  });

  it.each([
    ['package-lock.json', true],
    ['libs/papercusp/package-lock.json', true],
    ['./npm-shrinkwrap.json', true],
    ['patches/vitest+4.0.0.patch', true],
    ['libs/x/patches/foo+1.0.0.patch', true],
    ['patches/nested/foo.patch', true],
    ['package.json', false],
    ['lib/package-lock.json.bak', false],
    ['docs/foo.patch', false],
    ['node_modules/pkg/package-lock.json', false],
    ['.papercusp/scratch/package-lock.json', false],
    ['libs/a/node_modules/b/patches/c.patch', false],
  ])('%s -> %s', (rel, expected) => {
    expect(isDependencyInputPath(rel)).toBe(expected);
  });
});

describe('parseDependencyGenerationPrediction', () => {
  it('parses a verdict and keeps reasons only for refused', () => {
    expect(parseDependencyGenerationPrediction(`noise\n${line('buildable', 3)}\n`, REF)).toEqual({
      verdict: 'buildable',
      inputFingerprint: INPUT,
      liveFingerprint: LIVE,
      droppedLinks: 3,
      reasons: [],
    });
    const refused = parseDependencyGenerationPrediction(
      `${line('refused')}\nDEPENDENCY_GENERATION_PREDICTION_REASON node_modules/pkg: version "1" (ref) vs "2" (live)\n`,
      REF,
    );
    expect(refused?.reasons).toEqual(['node_modules/pkg: version "1" (ref) vs "2" (live)']);
  });

  it('refuses a line for a different ref, an unknown verdict, or no line at all', () => {
    expect(parseDependencyGenerationPrediction(line('buildable', 0, 'b'.repeat(40)), REF)).toBeNull();
    expect(parseDependencyGenerationPrediction(line('maybe'), REF)).toBeNull();
    expect(parseDependencyGenerationPrediction('', REF)).toBeNull();
  });
});

describe('predictDependencyGeneration', () => {
  const run = (result: Awaited<ReturnType<PredictionCommand>>) => vi.fn<PredictionCommand>().mockResolvedValue(result);

  it('invokes --predict-ref on the canonical root script and returns the parsed verdict', async () => {
    const command = run({ code: 0, stdout: `${line('live-match')}\n`, stderr: '' });
    const out = await predictDependencyGeneration({ integrationRoot: '/root', ref: REF, paths: ['package-lock.json'], run: command });
    expect(command).toHaveBeenCalledWith(
      'bash',
      ['/root/apps/operator/bin/release/dependency-generation.sh', '--integration', '/root', '--predict-ref', REF],
      expect.objectContaining({ cwd: '/root', timeoutMs: expect.any(Number) }),
    );
    expect(out).toMatchObject({ verdict: 'live-match', ref: REF, paths: ['package-lock.json'], inputFingerprint: INPUT });
  });

  it.each([
    ['a non-zero exit', { code: 2, stdout: '', stderr: '[dependency-generation] unknown arg: --predict-ref' }, 'exited 2'],
    ['a timeout', { code: null, stdout: '', stderr: '', error: 'timed out after 30000ms' }, 'timed out after 30000ms'],
    ['exit 0 with no prediction line', { code: 0, stdout: 'hello', stderr: '' }, 'printed no prediction'],
  ])('is unknown (never buildable, never refused) on %s', async (_label, result, phrase) => {
    const out = await predictDependencyGeneration({ integrationRoot: '/root', ref: REF, paths: ['package-lock.json'], run: run(result) });
    expect(out.verdict).toBe('unknown');
    expect(out.detail).toContain(phrase);
  });

  it('is unknown when the runner itself throws', async () => {
    const command = vi.fn<PredictionCommand>().mockRejectedValue(new Error('spawn bash ENOENT'));
    const out = await predictDependencyGeneration({ integrationRoot: '/root', ref: REF, paths: [], run: command });
    expect(out).toMatchObject({ verdict: 'unknown', detail: 'spawn bash ENOENT' });
  });
});

describe('describeDependencyPrediction', () => {
  const base = {
    ref: REF,
    paths: ['package-lock.json'],
    inputFingerprint: INPUT,
    liveFingerprint: LIVE,
    droppedLinks: 1,
    reasons: [] as string[],
    durationMs: 1,
  };
  it('is silent when nothing needs building', () => {
    expect(describeDependencyPrediction({ ...base, verdict: 'prewarmed' })).toBeNull();
    expect(describeDependencyPrediction({ ...base, verdict: 'live-match' })).toBeNull();
  });
  it('names the reasons for a refusal, capped at five', () => {
    const reasons = Array.from({ length: 7 }, (_, i) => `reason-${i}`);
    const text = describeDependencyPrediction({ ...base, verdict: 'refused', reasons })!;
    expect(text).toContain('NO installed tree can produce');
    expect(text).toContain('reason-4');
    expect(text).not.toContain('reason-5');
    expect(text).toContain('(+2 more)');
  });
});
