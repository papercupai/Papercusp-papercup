import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(resolve(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
// Execute the maintained parent loop itself; replace only the clock/process
// fixtures so a 600-second bound is exercised without sleeping or booting PG.
const start = source.indexOf('  ISOLATED_PG_ELAPSED=0\n');
const end = source.indexOf('  ISOLATED_PG_READY_LINE=', start);
if (start < 0 || end < 0) throw new Error('Isolated PG readiness loop was not found');
const loop = source.slice(start, end);
const bootScript = source.match(/<<'PGBOOT'\n([\s\S]*?)\nPGBOOT/)?.[1];
const stageReporter = bootScript?.match(
  /function classifyStartupStage\(message\) \{[\s\S]*?\n\}[\s\S]*?\nfunction reportStartupStage\(message, observedStages[^)]*\) \{[\s\S]*?\n\}/,
)?.[0];
if (!stageReporter) throw new Error('Isolated PG startup stage reporter was not found');

function run(mode: string, window = 2) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tauri-pg-readiness-'));
  try {
    return execFileSync('bash', ['-c', `
set -euo pipefail
ISOLATED_PG_LOG="$FIXTURE_DIR/pg.log"
ISOLATED_PG_PID=$$
ISOLATED_PG_TIMEOUT="$FIXTURE_WINDOW"
: > "$ISOLATED_PG_LOG"
ticks=0
isolated_pg_elapsed() { printf '%s\\n' "$ticks"; }
log() { echo "$*"; }
kill() { return 0; }
sleep() {
  ticks=$((ticks + 1))
  case "$FIXTURE_MODE" in
    advancing-ready)
      echo "PG_PROGRESS migration=$ticks.sql" >> "$ISOLATED_PG_LOG"
      if [ "$ticks" -eq 5 ]; then echo 'PG_READY port=1234' >> "$ISOLATED_PG_LOG"; fi
      ;;
    stalled) if [ "$ticks" -eq 1 ]; then echo 'PG_PROGRESS migration=first.sql' >> "$ISOLATED_PG_LOG"; fi ;;
    notices) echo 'NOTICE index renamed' >> "$ISOLATED_PG_LOG" ;;
    endless) echo "PG_PROGRESS migration=$ticks.sql" >> "$ISOLATED_PG_LOG" ;;
  esac
}
${loop}
echo 'READY_VERIFIED'
`], { env: { ...process.env, REPO_DIR: repo, FIXTURE_DIR: dir, FIXTURE_MODE: mode,
      FIXTURE_WINDOW: String(window) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { status: failure.status, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? '') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('native isolated PG readiness parent', () => {
  it('retains bounded startup-stage breadcrumbs without copying raw Postgres logs', () => {
    const lines: string[] = [];
    const report = runInNewContext(
      `(() => { ${stageReporter}; return reportStartupStage; })()`,
      { console: { log: (line: string) => lines.push(String(line)) } },
    ) as (message: string, observedStages: Set<string>) => void;
    const observed = new Set<string>();
    report('preload: (none)', observed);
    report('initialising data dir at /private/run', observed);
    report('initialising data dir at /private/run', observed);
    report('starting postgres on localhost:1234', observed);
    report('pg: database system is ready to accept connections', observed);
    report('creating database papercusp', observed);
    report('apply 000-baseline.sql', observed);
    report('pg: /private/path should not be copied', observed);

    expect(lines).toEqual([
      'PG_STAGE stage=preload-ready',
      'PG_STAGE stage=initdb',
      'PG_STAGE stage=postmaster-start',
      'PG_STAGE stage=postmaster-ready',
      'PG_STAGE stage=database-create',
    ]);
    expect(bootScript).toContain('console.log(`PG_PROGRESS migration=${message.slice(6)}`)');
  });

  it('counts distinct completed initdb steps even when stdout arrives in split chunks', () => {
    const lines: string[] = [];
    const report = runInNewContext(
      `(() => { ${stageReporter}; return reportStartupStage; })()`,
      { console: { log: (line: string) => lines.push(String(line)) } },
    ) as (message: string, observedStages: Set<string>, log: { pending: string }) => void;
    const observed = new Set<string>();
    const log = { pending: '' };
    report('initialising data dir at /private/run', observed, log);
    report('pg: creating subdirect', observed, log);
    report('pg: ories ... ok\ncreating configuration files ... ok\n', observed, log);
    report('pg: creating subdirectories ... ok\nNOTICE private SQL must not count\n', observed, log);
    report('pg: running bootstrap script ... ok\nperforming post-bootstrap initialization ... ok\n', observed, log);
    report('pg: syncing data to disk ... ok\n', observed, log);
    report('starting postgres on localhost:1234', observed, log);
    report('pg: creating configuration files ... ok\n', observed, log);

    expect(lines.filter((line) => line.startsWith('PG_PROGRESS '))).toEqual([
      'PG_PROGRESS startup=initdb-subdirectories',
      'PG_PROGRESS startup=initdb-configuration',
      'PG_PROGRESS startup=initdb-bootstrap',
      'PG_PROGRESS startup=initdb-post-bootstrap',
      'PG_PROGRESS startup=initdb-sync',
    ]);
    expect(lines.join('\n')).not.toMatch(/private|NOTICE|creating subdirectories/);
  });

  it('retains bounded private startup output outside the disposable data directory', () => {
    const writerSource = bootScript?.match(/function createStartupDiagnosticWriter\([^\n]*\) \{[\s\S]*?\n\}/)?.[0];
    expect(writerSource, 'startup output must survive the filtering reporter').toBeDefined();
    const createWriter = runInNewContext(
      `(() => { ${writerSource}; return createStartupDiagnosticWriter; })()`,
      { appendFileSync, writeFileSync, Buffer },
    ) as (file: string, maxBytes: number) => (message: string) => void;
    const dir = mkdtempSync(resolve(tmpdir(), 'tauri-pg-startup-log-'));
    try {
      const file = resolve(dir, 'isolated-pgdata.startup.log');
      const retain = createWriter(file, 64);
      retain('before-initdb');
      retain('x'.repeat(100));
      retain('must not grow after the bound');
      expect(readFileSync(file, 'utf8')).toBe('before-initdb\n' + 'x'.repeat(50));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(bootScript).toContain('createStartupDiagnosticWriter(`${dataDir}.startup.log`)');
      expect(bootScript).toContain('retainStartupDiagnostic(message)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures only the owned PG session process state before teardown removes it', () => {
    const capture = source.match(/capture_isolated_pg_diagnostics\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(capture).toBeDefined();
    const dir = mkdtempSync(resolve(tmpdir(), 'tauri-pg-process-log-'));
    try {
      execFileSync('bash', ['-c', `
set -euo pipefail
ISOLATED_PG_PID=123
ps() { printf '%s\\n' "$*" > "$WORK/ps-args"; printf '123 120 S 42 wait initdb\\n'; }
${capture}
capture_isolated_pg_diagnostics
`], { env: { ...process.env, WORK: dir } });
      const file = resolve(dir, 'isolated-pg-processes.log');
      expect(readFileSync(file, 'utf8')).toContain('123 120 S 42 wait initdb');
      expect(readFileSync(resolve(dir, 'ps-args'), 'utf8')).toBe('--sid 123 -o pid,ppid,stat,etimes,wchan:32,comm\n');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(source).toContain('capture_isolated_pg_diagnostics\n  write_stop_script');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps an advancing migration boot alive past the initial deadline, then accepts ready', () => {
    const result = run('advancing-ready');
    expect(result).toEqual(expect.stringContaining('READY_VERIFIED'));
    expect(result).toEqual(expect.stringContaining('PG_BOOT_PROGRESS elapsed=2s progress_steps=2'));
  });

  it('rejects a migration boot that stopped advancing', () => {
    expect(run('stalled')).toMatchObject({ status: 1, stderr: expect.stringContaining('progress-stalled after 4s') });
  });

  it('does not interpret harmless notices as forward progress', () => {
    expect(run('notices')).toMatchObject({ status: 1, stderr: expect.stringContaining('progress-unknown after 2s') });
  });

  it('enforces the absolute ceiling even while progress keeps arriving', () => {
    expect(run('endless', 300)).toMatchObject({ status: 1, stderr: expect.stringContaining('absolute-ceiling after 600s') });
  });
});
