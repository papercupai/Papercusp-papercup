import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { gitGrepSymbolResolver } from './code-subject-resolution';

it('resolves a real symbol with a bounded worker budget despite a larger inherited Git setting', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'code-subject-worker-budget-'));
  const trace = join(repo, 'git-trace.json');
  try {
    writeFileSync(join(repo, 'subject.ts'), 'export function routeThing() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', 'subject.ts'], { cwd: repo });
    execFileSync('git', ['config', 'grep.threads', '32'], { cwd: repo });
    vi.stubEnv('GIT_TRACE2_EVENT', trace);
    vi.stubEnv('GIT_TRACE2_CONFIG_PARAMS', 'grep.threads');

    const result = await gitGrepSymbolResolver({ cwd: repo })(['routeThing']);
    expect(result.get('routeThing')).toEqual(['subject.ts']);

    // Observe Git's own configuration events, rather than inspecting the
    // resolver's argv or relying on a timing threshold on this tiny fixture.
    const settings = readFileSync(trace, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { event?: string; param?: string; scope?: string; value?: string })
      .filter((event) => event.event === 'def_param' && event.param === 'grep.threads');
    expect(settings.some((event) => event.scope === 'local' && event.value === '32')).toBe(true);
    const effectiveWorkers = Number(settings.at(-1)?.value);
    expect(effectiveWorkers).toBeGreaterThan(0);
    expect(effectiveWorkers).toBeLessThanOrEqual(8);
  } finally {
    vi.unstubAllEnvs();
    rmSync(repo, { recursive: true, force: true });
  }
});
