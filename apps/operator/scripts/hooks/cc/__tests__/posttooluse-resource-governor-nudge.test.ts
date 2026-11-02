/**
 * posttooluse-resource-governor-nudge — the recurrence guard for WI-10007553: an edit that
 * makes scripts/check-resource-governor-enforcement.mjs fail must be told so at the edit,
 * not ~an hour later by the fleet green-checkpoint (WI-10007542 measured four such breaks
 * in one day, each red for every lane).
 *
 * Two layers, same reasoning as the registry-census-drift sibling's test:
 *  1. `--self-test` is spawned so its embedded cases run on the affected-suite leg the gate
 *     runs. A hook-only guard otherwise rots: nothing on a blocking path runs it.
 *  2. The behavioural cases run against the REAL detector and the REAL BYPASS_REGISTRY,
 *     loaded through the hook's own repo-root resolution. Only file I/O is injected
 *     (`readFile` / `showHead` / `exists` for a fixture that does not exist on disk), so a
 *     change to the guard's registry or finding shapes breaks these cases, not just the
 *     fake-detector self-test. Snapshot tests use a private temp directory and never mutate
 *     the repo tree.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-resource-governor-nudge.mjs');

type NudgeDeps = {
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  sizeOf?: (p: string) => number;
  showHead?: (root: string, rel: string) => string | null;
  beforeFindings?: string[];
  beforeRelPath?: string;
  snapshotRoot?: string;
};

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    isCandidateFile: (p: string) => boolean;
    nudgeFor: (p: string, deps?: NudgeDeps) => Promise<string | null>;
    capturePreEditBaseline: (
      p: string,
      deps?: NudgeDeps,
    ) => Promise<{ filePath: string; relPath: string; findings: string[] } | null>;
    recordPreEditSnapshot: (payload: any, deps?: NudgeDeps) => Promise<boolean>;
    consumePreEditSnapshot: (
      payload: any,
      deps?: NudgeDeps,
    ) => { filePath: string; relPath: string; findings: string[] } | null;
  };
}

/** A path that does not exist on disk but must look like it does to the hook. */
const FIXTURE_MARK = 'zz-resource-governor-nudge-fixture.';
const existsWithFixture = (p: string) => p.includes(FIXTURE_MARK) || existsSync(p);
const real = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

async function nudge(rel: string, before: string | null, after: string) {
  const { nudgeFor } = await loadHook();
  return nudgeFor(resolve(ROOT, rel), {
    exists: existsWithFixture,
    sizeOf: () => after.length,
    showHead: () => before,
    readFile: () => after,
  });
}

// A reviewed BYPASS_REGISTRY row whose pin is `resourceStartCallCount(source) === 1`.
const REVIEWED = 'packages/operator-core/lib/agent-tools/plans/committed-tree-reader.ts';
const AGENT_FIXTURE = `packages/operator-core/lib/agent-tools/${FIXTURE_MARK}ts`;
const SCRIPT_FIXTURE = `scripts/${FIXTURE_MARK}mjs`;
const RAW_SPAWN = "import { spawn } from 'node:child_process';\nexport const go = () => spawn('ls', []);\n";

describe('posttooluse-resource-governor-nudge', () => {
  it('--self-test passes (the embedded fake-detector cases)', () => {
    const out = execFileSync(process.execPath, [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });

  it('fires on an unreviewed resource start in an enforced lane, with remedy and a template row', async () => {
    const msg = await nudge(AGENT_FIXTURE, null, RAW_SPAWN);
    expect(msg).toBeTruthy();
    expect(msg).toContain('resource-start-outside-admission — no reviewed row covers it');
    expect(msg).toContain('runGovernedOperation');
    expect(msg).toContain('BYPASS_REGISTRY tail');
    expect(msg).toMatch(/nearest existing row to copy: packages\/operator-core\/lib\/agent-tools\/\S+::resource-start-outside-admission/);
    expect(msg).toContain('node scripts/check-resource-governor-enforcement.mjs');
  });

  it('directs a P-016-lane row to P016_REVIEWED_DISPOSITIONS (its size is pinned by the guard test)', async () => {
    const msg = await nudge(SCRIPT_FIXTURE, null, "import { execFileSync } from 'node:child_process';\nexecFileSync('ls');\n");
    expect(msg).toContain('P016_REVIEWED_DISPOSITIONS');
    expect(msg).toContain('lane: ci-release-test-workers');
  });

  it('is silent when the start is governed', async () => {
    const governed =
      "import { spawn } from 'node:child_process';\nimport { runGovernedOperation } from '../resource-governor/run';\n" +
      "export const go = () => runGovernedOperation(() => spawn('ls', []));\n";
    expect(await nudge(AGENT_FIXTURE, null, governed)).toBeNull();
  });

  it('is silent on a harmless edit to a reviewed file (its row still clears it)', async () => {
    const src = real(REVIEWED);
    expect(await nudge(REVIEWED, src, `${src}\n// harmless trailing comment\n`)).toBeNull();
  });

  it('reports a PIN BREAK when an edit changes code a reviewed row pins', async () => {
    const src = real(REVIEWED);
    const msg = await nudge(REVIEWED, src, `${src}\nexport const extra = () => spawn('ls', []);\n`);
    expect(msg).toContain('a reviewed row exists, but its matchesSource pin rejects the edited source');
    expect(msg).toContain(`${REVIEWED}::resource-start-outside-admission`);
  });

  it('reports a STALE ROW when an edit removes the finding a reviewed row disposes of', async () => {
    const src = real(REVIEWED);
    const msg = await nudge(REVIEWED, src, src.replaceAll('spawn(', 'spawnDisabled('));
    expect(msg).toContain('the edit REMOVED the finding a reviewed row disposes of (stale row)');
  });

  it('does not re-nudge a finding already present at HEAD', async () => {
    expect(await nudge(AGENT_FIXTURE, RAW_SPAWN, `${RAW_SPAWN}// unrelated tweak\n`)).toBeNull();
  });

  it('compares against the pre-edit dirty worktree and still fires for a new finding', async () => {
    const { recordPreEditSnapshot, consumePreEditSnapshot, nudgeFor } = await loadHook();
    const filePath = resolve(ROOT, REVIEWED);
    const src = real(REVIEWED);
    const dirty = src + "\nexport const extra = () => spawn('ls', []);\n";
    const afterHarmlessEdit = dirty + '\n// harmless follow-up\n';
    const snapshotRoot = mkdtempSync(join(tmpdir(), 'resource-governor-nudge-'));
    const pre = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_use_id: 'dirty-baseline-test',
      session_id: 'resource-governor-test-session',
      tool_input: { file_path: filePath },
    };
    try {
      expect(
        await recordPreEditSnapshot(pre, {
          snapshotRoot,
          exists: existsWithFixture,
          sizeOf: () => dirty.length,
          readFile: () => dirty,
        }),
      ).toBe(true);

      const sessionDir = join(snapshotRoot, readdirSync(snapshotRoot)[0]);
      const snapshotFile = join(sessionDir, readdirSync(sessionDir)[0]);
      expect(readFileSync(snapshotFile, 'utf8')).not.toContain('export const extra');

      const baseline = consumePreEditSnapshot({ ...pre, hook_event_name: 'PostToolUse' }, { snapshotRoot });
      expect(baseline?.findings.length).toBeGreaterThan(0);
      if (!baseline) throw new Error('pre-edit baseline snapshot was not readable');
      const falseAlarm = await nudgeFor(filePath, {
        exists: existsWithFixture,
        sizeOf: () => afterHarmlessEdit.length,
        readFile: () => afterHarmlessEdit,
        showHead: () => src,
        beforeFindings: baseline.findings,
        beforeRelPath: baseline.relPath,
      });
      expect(falseAlarm).toBeNull();
      expect(consumePreEditSnapshot({ ...pre, hook_event_name: 'PostToolUse' }, { snapshotRoot })).toBeNull();

      const cleanPre = { ...pre, tool_use_id: 'new-finding-test' };
      expect(
        await recordPreEditSnapshot(cleanPre, {
          snapshotRoot,
          exists: existsWithFixture,
          sizeOf: () => src.length,
          readFile: () => src,
        }),
      ).toBe(true);
      const cleanBaseline = consumePreEditSnapshot(
        { ...cleanPre, hook_event_name: 'PostToolUse' },
        { snapshotRoot },
      );
      if (!cleanBaseline) throw new Error('clean pre-edit baseline snapshot was not readable');
      const introduced = await nudgeFor(filePath, {
        exists: existsWithFixture,
        sizeOf: () => dirty.length,
        readFile: () => dirty,
        beforeFindings: cleanBaseline.findings,
        beforeRelPath: cleanBaseline.relPath,
      });
      expect(introduced).toContain('a reviewed row exists, but its matchesSource pin rejects the edited source');
    } finally {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
  });

  it('is silent outside every enforced lane and for files the gate does not scan', async () => {
    const { isCandidateFile } = await loadHook();
    expect(await nudge(`docs/${FIXTURE_MARK}ts`, null, RAW_SPAWN)).toBeNull();
    expect(isCandidateFile(`${AGENT_FIXTURE.replace(/\.ts$/, '.test.ts')}`)).toBe(false);
    expect(isCandidateFile('scripts/check-resource-governor-enforcement.d.mts')).toBe(false);
  });

  it('honours the PostToolUse stdin contract: non-edit tools and non-source paths emit nothing', () => {
    for (const payload of [
      { tool_name: 'Read', tool_input: { file_path: resolve(ROOT, REVIEWED) } },
      { tool_name: 'Edit', tool_input: { file_path: resolve(ROOT, 'CLAUDE.md') } },
      { tool_name: 'Edit', tool_input: {} },
    ]) {
      const out = execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
      expect(out).toBe('');
    }
  });
});
