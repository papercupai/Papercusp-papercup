import { describe, expect, it } from 'vitest';
import { activityMode, summarizeActivityMix, unwrapActivityRow } from './mix';

const row = (ts: number, tool_name: string, args_json: unknown = {}) => ({ ts, tool_name, args_json });

/**
 * EI-21847759967934033. This tool measures ONE owner from `tool_invocations`, which records MCP
 * calls only — native Bash/Read/Grep/Edit produce no row. Percentages make that worse than a raw
 * count does, because they normalize the missing half away: an owner whose real work was shell
 * reads as a confident mix of the little it happened to do over MCP, and "mostly orienting" is the
 * reading that gets a working peer woken and accused.
 */
describe('activity:mix declares its own blind spot', () => {
  it('carries the marker on an ordinary, healthy mix — not only on an empty one', () => {
    const result = summarizeActivityMix([
      row(0, 'dev:pg_query'),
      row(5, 'work_items:get', { id: 'WI-1' }),
      row(40, 'capability:edit', { file_path: 'src/a.ts' }),
    ]);

    // Unconditional by design: a marker that appears only when rows are sparse teaches the reader
    // that its ABSENCE means the data is complete, which is the same wrong inference one step over.
    expect(result.bursts).toBeGreaterThan(0);
    expect(result.nativeToolCallsNotRecorded).toContain('records MCP calls ONLY');
    expect(result.nativeToolCallsNotRecorded).toContain('Bash');
  });

  it('states the rule and refuses to invert the error onto the store it recommends', () => {
    const marker = summarizeActivityMix([]).nativeToolCallsNotRecorded;

    // The instrument-independent rule — the only claim that stays true whichever store you read.
    expect(marker).toContain('Positive rows prove activity');
    expect(marker).toContain('proves nothing about idleness');
    // Names where native calls CAN be seen...
    expect(marker).toContain('activity:tool-log');
    // ...and immediately bounds it: agent_activity was empty for ~45% of agents (24h: 182 of 333),
    // so recommending it without this caveat would relocate the identical directional error.
    expect(marker).toMatch(/empty for ~45% of agents/);
    expect(marker).toMatch(/empty tool-log is equally not evidence/);
  });
});

describe('activity:mix pure attribution', () => {
  it('drops automatic telemetry before it can create a burst', () => {
    const result = summarizeActivityMix([
      row(0, 'activity:report'),
      row(1, 'dev:pg_query'),
      row(40, 'work_items:get'),
    ]);

    expect(result.telemetryDropped).toBe(1);
    expect(result.bursts).toBe(2);
    expect(result.byMode.map(([mode]) => mode)).toEqual(['investigate', 'record-durably']);
  });

  it('unwraps tools:invoke and code:run instead of attributing the wrapper', () => {
    const invoke = unwrapActivityRow(row(1, 'tools:invoke', { name: 'work_items:get', args: { id: 'WI-1' } }));
    const code = unwrapActivityRow(row(2, 'code:run', { script: "await tools.capability.edit({ file_path: 'src/a.ts' });" }));

    expect(invoke).toMatchObject({ unwrapped: true, calls: [{ tool: 'work_items:get' }] });
    expect(code).toMatchObject({ unwrapped: true, calls: [{ tool: 'capability:edit' }] });
    expect(activityMode(invoke.calls[0])).toBe('record-durably');
    expect(activityMode(code.calls[0])).toBe('implement');
  });

  it('uses the explicit recipient, not a body mention, for owner-comms', () => {
    expect(activityMode({ ts: 1, tool: 'coord:send', args: { to: ['su-peer'], body: 'human review noted' } })).toBe('supervise');
    expect(activityMode({ ts: 2, tool: 'coord:send', args: { to: ['human'], body: 'status report' } })).toBe('owner-comms');
  });

  it('counts delegated agent launch as supervision without weakening implementation detection', () => {
    expect(activityMode({ ts: 1, tool: 'capability:launch-agent', args: {} })).toBe('supervise');
    expect(activityMode({ ts: 2, tool: 'capability:edit', args: { file_path: 'src/a.ts' } })).toBe('implement');
  });

  /**
   * EI-23749240882032210. A holder that wrote no code scored implement=1.9% because the bucket
   * was a blanket `capability:*` prefix. Measured: su-6aab097a, 2026-09-19T23:59Z–2026-09-20T03:04Z —
   * all 14 agent-origin capability:bash calls were read-only. The commands below are copied from
   * that ledger (harness_shared.tool_invocations), not invented, so this pins the SHAPES the real
   * holder used rather than shapes chosen to pass.
   */
  describe('capability:bash is implement only when it can change something (EI-23749240882032210)', () => {
    const bash = (cmd: string) => activityMode({ ts: 1, tool: 'capability:bash', args: { cmd } });

    it('read-only shell the dispatcher classifier accepts is investigation, not implementation', () => {
      for (const cmd of [
        "sed -n '200,235p' packages/operator-core/lib/goals/kickoff-evidence.ts",
        'ls -la packages',
        'cat a.ts | head -20',
      ]) {
        expect(bash(cmd), cmd).toBe('investigate');
      }
    });

    /**
     * The MEASURED case. Reusing classifyCapabilityBashEffect alone did NOT fix it: these are the
     * holder's real shapes (su-6aab097a) and that classifier is a REPLAY-SAFETY allowlist — `grep`
     * and `cd` are not in its read-only set and any `<`/`>` (even 2>/dev/null) makes its splitter
     * bail out. activity/bash-mutation.ts is the attribution-purpose layer that covers them.
     */
    it('the real holder shapes (grep / cd / 2>/dev/null / sed -n) are investigation', () => {
      for (const cmd of [
        "grep -rn 'unknown filter op' --include=*.ts libs packages apps 2>/dev/null | head -5",
        "cd /work/repo && grep -rln 'goal_kickoff_incomplete' --include=*.ts --exclude-dir=node_modules --exclude-dir=dist . | head -20",
        "cd /work/repo && echo '=== kickoff-evidence.ts 200-235 ==='; sed -n '200,235p' packages/operator-core/lib/goals/kickoff-evidence.ts",
      ]) {
        expect(bash(cmd), cmd).toBe('investigate');
      }
    });

    it('end to end on the measured holder shapes (incl. $(…)+$VAR and xargs): no implement share', () => {
      const result = summarizeActivityMix([
        row(0, 'capability:bash', { command: 'cd packages/x/lib && grep -n "a\\|b\\|Scope(" w.ts | head -40' }),
        row(40, 'capability:bash', {
          command:
            'cd /work/repo && f=$(ls a.ts b/index.ts 2>/dev/null | head -1); echo "FILE=$f"; grep -n \'export function\\|REQUIRED\' "$f" | head -50',
        }),
        row(80, 'capability:bash', {
          command: "grep -rln 'x' --include=*.ts libs 2>/dev/null | head -3 | xargs -r grep -n 'allOf\\|clauses' | head -20",
        }),
      ]);
      expect(result.byMode.map(([mode]) => mode)).not.toContain('implement');
    });

    it('the same shapes with ONE write appended stay implement', () => {
      for (const cmd of [
        "grep -rn 'x' packages 2>/dev/null > out.txt",
        "cd /work/repo && grep -rln 'x' . | tee found.txt",
        "cd /work/repo && sed -n '1,5p' a.ts; rm -rf dist",
      ]) {
        expect(bash(cmd), cmd).toBe('implement');
      }
    });

    it('a real WRITE stays implement — the narrowing may never hide a mutation', () => {
      for (const cmd of [
        "sed -i 's/a/b/' src/a.ts",
        'echo hi > src/a.ts',
        'rm -rf dist',
        'git commit -am x',
        'npm install left-pad',
      ]) {
        expect(bash(cmd), cmd).toBe('implement');
      }
    });

    it('unknown / compound / substituted shell fails CLOSED to implement', () => {
      expect(bash('grep -n x $(rm files.txt)')).toBe('implement');
      expect(bash('grep -n x `cat files.txt`')).toBe('implement');
      expect(bash('')).toBe('implement');
      expect(activityMode({ ts: 1, tool: 'capability:bash', args: {} })).toBe('implement');
    });

    it('accepts the `command` spelling as well as `cmd` (both are real capability:bash args)', () => {
      expect(activityMode({ ts: 1, tool: 'capability:bash', args: { command: "sed -n '1,5p' a.ts" } })).toBe('investigate');
    });

    it('capability:read is investigation; edit/write-class capability tools are unchanged', () => {
      expect(activityMode({ ts: 1, tool: 'capability:read', args: { file_path: 'a.ts' } })).toBe('investigate');
      expect(activityMode({ ts: 2, tool: 'capability:edit', args: { file_path: 'a.ts' } })).toBe('implement');
      expect(activityMode({ ts: 3, tool: 'capability:write', args: { file_path: 'a.ts' } })).toBe('implement');
    });

    it('RESIDUAL (documented, not fixed): a bash call inside a code:run script is opaque, so it fails closed to implement', () => {
      const code = unwrapActivityRow(row(1, 'code:run', { script: "await tools.capability.bash({ cmd: 'ls' });" }));
      expect(code.calls[0].tool).toBe('capability:bash');
      // callsInScript hands the WHOLE script string as args, so no command is recoverable.
      expect(activityMode(code.calls[0])).toBe('implement');
    });

    it('end to end: a holder whose shell is classifier-readable and who made no edits scores no implement', () => {
      const result = summarizeActivityMix([
        row(0, 'tools:invoke', { name: 'work_items:get', args: { id: 'WI-1' } }),
        row(40, 'capability:bash', { cmd: 'ls -la packages' }),
        row(80, 'capability:bash', { cmd: "sed -n '200,235p' a.ts" }),
        row(120, 'dev:pg_query', { sql: 'select 1' }),
      ]);
      expect(result.byMode.map(([mode]) => mode)).not.toContain('implement');
    });
  });

  it('classifies rubric reads as investigation instead of an unscoped other bucket', () => {
    for (const tool of ['rubrics:get', 'rubrics:list', 'rubrics:search', 'rubrics:trend']) {
      expect(activityMode({ ts: 1, tool, args: {} })).toBe('investigate');
    }
  });

  it('splits a burst that mentions multiple portfolio responsibilities', () => {
    const result = summarizeActivityMix([
      row(0, 'dev:pg_query', { sql: 'inspect qemu Windows incident and Linux dpkg packaging' }),
      row(5, 'work_items:get', { id: 'WI-1' }),
      row(40, 'coord:send', { to: ['human'] }),
    ]);

    const responsibilities = new Map(result.byResponsibility.map(([name, percentage]) => [name, percentage]));
    expect(responsibilities.get('windows leg / VM incident')).toBe(
      responsibilities.get('linux leg'),
    );
    expect(Number(responsibilities.get('windows leg / VM incident')?.replace('%', ''))).toBeGreaterThan(0);
    expect(result.responsibilitySwitches).toBe(1);
  });

  it('caps long idle gaps and marks a bounded fetch as truncated', () => {
    const result = summarizeActivityMix([row(0, 'dev:pg_query'), row(1000, 'dev:pg_query')], 3);

    expect(result.truncated).toBe(true);
    expect(result.idleTrimmedMin).toBeGreaterThan(0);
    expect(result.attributedMin).toBeGreaterThan(0);
  });
});
