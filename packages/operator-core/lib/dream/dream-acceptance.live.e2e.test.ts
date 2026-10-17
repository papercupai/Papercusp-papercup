/** Read-only Dream BAR probes with the native e2e reporter's runtime witnesses.
 * The profile supplies selectors, never observed results or fingerprints.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');
const enabled = process.env.PAPERCUSP_DREAM_ACCEPTANCE_LIVE === '1';
type Assertion = { id: string; passed: boolean; evidence: string };
type Profile = {
  origin: string;
  runtimeUnits: string[];
  rubricRef: string;
  rubricRevision: number;
};

describe.skipIf(!enabled)('Dream live acceptance contracts', () => {
  let assertions: Assertion[];

  beforeAll(() => {
    const profilePath = process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE;
    expect(profilePath, 'native runtime reporting requires the selected live profile').toBeTruthy();
    const profile = JSON.parse(readFileSync(resolve(root, profilePath!), 'utf8')) as Profile;
    expect(profile.origin).toBe('http://127.0.0.1:3170');
    expect(profile.runtimeUnits).toEqual(['postgres:5432']);
    expect(profile.rubricRef).toBe('acceptance-dream-performance-grading-papercusp-2026-10-07');
    expect(profile.rubricRevision).toBe(7);
    expect(process.env.PAPERCUSP_SID, 'preserve the authenticated execution identity').toBeTruthy();

    // Run the immutable authored checks through the maintained authenticated
    // dispatcher. Return only observations, so large rubric bodies stay remote.
    const script = `
      const response = await tools.rubrics.get({rubricRef:${JSON.stringify(profile.rubricRef)},
        revision:${profile.rubricRevision},detail:'full'});
      if (!response.ok || !response.results[0]?.ok) throw new Error('rubric unavailable');
      const rubric = response.results[0].rubric;
      const criteria = rubric.criteria.filter(c => ['r-1','r-2'].includes(c.key));
      if (criteria.length !== 2) throw new Error('incomplete Dream criterion population');
      const assertions = [];
      for (const criterion of criteria) {
        if (criterion.check?.kind !== 'probe' || !criterion.check.all?.length)
          throw new Error('Dream criterion has no executable probes');
        let index = 0;
        for (const probe of criterion.check.all) {
          if (probe.expect.op !== 'eq') throw new Error('unsupported Dream expectation');
          if (probe.kind !== 'sql' && probe.kind !== 'tool') throw new Error('unsupported Dream probe');
          const result = probe.kind === 'sql'
            ? await tools.tools.invoke({name:'dev:pg_query',args:{sql:probe.sql,
                allowUnscoped:probe.allowUnscoped,maxRows:probe.maxRows}})
            : await tools.tools.invoke({name:probe.tool,args:probe.args});
          const body = result.result ?? result;
          let actual = body;
          const path = probe.expect.path.replace(/^\\$\\./,'').replace(/\\[(\\d+)\\]/g,'.$1');
          for (const part of path.split('.')) actual = actual?.[part];
          assertions.push({id:criterion.barKey+'-'+(++index),passed:actual === probe.expect.value,
            evidence:JSON.stringify({path:probe.expect.path,expected:probe.expect.value,actual})});
        }
      }
      return {rubricRevision:rubric.revision,assertions};
    `;
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/mcp-call.mjs'),
      'code:run', '--port', '3170', '--workspace', 'papercusp-workspace',
      '--harness', 'papercusp', '--client', process.env.PAPERCUSP_SID!, '--json', '-'], {
      cwd: root, env: process.env, encoding: 'utf8', timeout: 90_000,
      maxBuffer: 256 * 1024, input: JSON.stringify({ script }),
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.summary.rubricRevision).toBe(profile.rubricRevision);
    assertions = body.summary.assertions;
    expect(assertions.map(row => row.id).sort()).toEqual([
      'R-1-1', 'R-1-2', 'R-2-1', 'R-2-2', 'R-2-3', 'R-2-4', 'R-2-5', 'R-2-6',
    ]);
  }, 100_000);

  it.each(['R-1-1', 'R-1-2', 'R-2-1', 'R-2-2', 'R-2-3', 'R-2-4', 'R-2-5', 'R-2-6'])(
    '%s matches the immutable authored live contract', id => {
      const observation = assertions.find(row => row.id === id);
      expect(observation, `missing ${id}`).toBeDefined();
      expect(observation!.passed, observation!.evidence).toBe(true);
    },
  );
});
