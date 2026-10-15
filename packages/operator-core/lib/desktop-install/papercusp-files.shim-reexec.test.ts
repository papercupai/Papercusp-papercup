/**
 * WI-38292: the psu shim's host-code re-exec loop.
 *
 * psu-launcher.mjs IS the long-lived host process, and it imports
 * psu-pty-host.mjs exactly ONCE — `recycleChild` only ever replaces the CLI
 * child inside that same process. So a host fix committed after a session
 * booted is inert for that session's entire life (the live reproduction:
 * continuation fix d351ee3084 landed at 14:02 EDT, a host that started at 13:08
 * kept executing the pre-fix path, and the owner had to type a turn by hand).
 *
 * Node has no execve, and the host cannot spawn-a-successor-then-exit either:
 * the shim `exec`s node, so node is the interactive shell's direct child and
 * holds the terminal's FOREGROUND process group. Exiting hands the terminal back
 * to the shell and strands the successor in a background pgid. The swap has to
 * come from the PARENT — bash stays alive across it, so the foreground pgid it
 * owns survives and the successor is just the loop's next child.
 *
 * These tests EXECUTE the generated shim rather than reading it, because the
 * claim is behavioural: does a launcher that asks to be re-run actually get
 * re-run, from disk, and does a launcher that does not ask exit cleanly?
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PSU_REEXEC_EXIT_CODE,
  PSU_REEXEC_MAX,
  shimRuntimeOptions,
  writeShim,
} from './papercusp-files';

const run = promisify(execFile);

let tmp: string;
let shimPath: string;
let launcherPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-reexec-'));
  shimPath = path.join(tmp, 'psu');
  launcherPath = path.join(tmp, 'psu-launcher.mjs');
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Write the psu shim (the ONLY shim that opts into the loop). */
async function writePsuShim(): Promise<void> {
  await writeShim(shimPath, launcherPath, 'superuser launcher (psu)', {
    ...shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER'),
    reexecExitCode: PSU_REEXEC_EXIT_CODE,
  });
}

/** Write a shim WITHOUT the opt-in — ptool/onboard's shape, and the control for
 *  every behavioural claim below. */
async function writePlainShim(): Promise<void> {
  await writeShim(
    shimPath,
    launcherPath,
    'defineTool CLI (ptool)',
    shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER'),
  );
}

/** Run the shim to completion. Never throws on a non-zero exit — the exit code
 *  IS the subject of most of these tests. */
async function runShim(
  extraEnv: Record<string, string> = {},
  argv: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('bash', [shimPath, ...argv], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: tmp,
        PAPERCUSP_PSU_LAUNCHER: launcherPath,
        RUN_LOG: path.join(tmp, 'runs.log'),
        ...extraEnv,
      },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** How many times did a launcher actually execute? */
async function runCount(): Promise<number> {
  const log = await fs.readFile(path.join(tmp, 'runs.log'), 'utf8').catch(() => '');
  return log.split('\n').filter(Boolean).length;
}

/** A launcher that appends `tag` to the run log, then exits with `code`. */
function launcherSource(tag: string, code: number, extra = ''): string {
  return [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(process.env.RUN_LOG, ${JSON.stringify(tag)} + '\\n');`,
    extra,
    `process.exit(${code});`,
    '',
  ].join('\n');
}

describe('psu shim re-exec loop (WI-38292)', () => {
  it('re-runs the launcher when it exits with the sentinel, and stops on the next ordinary exit', async () => {
    await writePsuShim();
    // Exit 87 for the first two runs, then 0 — the shape of a host that adopted
    // fresh code and no longer has anything to adopt.
    await fs.writeFile(
      launcherPath,
      [
        "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
        "const counter = process.env.RUN_LOG + '.n';",
        "let n = 0; try { n = Number(readFileSync(counter, 'utf8')); } catch {}",
        'n += 1; writeFileSync(counter, String(n));',
        "appendFileSync(process.env.RUN_LOG, JSON.stringify({ run: n, reexecCount: process.env.PAPERCUSP_PSU_REEXEC_COUNT }) + '\\n');",
        `process.exit(n <= 2 ? ${PSU_REEXEC_EXIT_CODE} : 0);`,
        '',
      ].join('\n'),
    );

    const { code } = await runShim({ PAPERCUSP_PSU_REEXEC_COUNT: '99' });
    expect(code).toBe(0);
    expect(await runCount()).toBe(3);
    const rows = (await fs.readFile(path.join(tmp, 'runs.log'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toEqual([
      { run: 1, reexecCount: '0' },
      { run: 2, reexecCount: '1' },
      { run: 3, reexecCount: '2' },
    ]);
  });

  it('consumes kickoff env + argv before a host-code re-exec, while preserving ordinary launch args', async () => {
    await writePsuShim();
    await fs.writeFile(
      launcherPath,
      [
        "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
        "const counter = process.env.RUN_LOG + '.n';",
        "let n = 0; try { n = Number(readFileSync(counter, 'utf8')); } catch {}",
        'n += 1; writeFileSync(counter, String(n));',
        "appendFileSync(process.env.RUN_LOG, JSON.stringify({ n, kickoffEnv: process.env.PAPERCUSP_KICKOFF_PROMPT ?? null, argv: process.argv.slice(2) }) + '\\n');",
        `process.exit(n === 1 ? ${PSU_REEXEC_EXIT_CODE} : 0);`,
        '',
      ].join('\n'),
    );

    const { code } = await runShim(
      { PAPERCUSP_KICKOFF_PROMPT: 'env kickoff' },
      ['--resume=session-1', '--kickoff=flag kickoff', '--no-kickoff', '--model=gpt-5.6-sol'],
    );

    expect(code).toBe(0);
    const rows = (await fs.readFile(path.join(tmp, 'runs.log'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { n: number; kickoffEnv: string | null; argv: string[] });
    expect(rows).toEqual([
      {
        n: 1,
        kickoffEnv: 'env kickoff',
        argv: ['--resume=session-1', '--kickoff=flag kickoff', '--no-kickoff', '--model=gpt-5.6-sol'],
      },
      {
        n: 2,
        kickoffEnv: null,
        argv: ['--resume=session-1', '--no-kickoff', '--model=gpt-5.6-sol'],
      },
    ]);
  });

  it('ADOPTS code written to disk after it started — the bug this exists to fix', async () => {
    await writePsuShim();
    // Run 1 rewrites the launcher ON DISK and asks to be re-run. If the loop
    // merely repeated the in-memory program (or never looped at all), run 2
    // could not possibly log the successor's tag. This is the whole mechanism:
    // a FRESH node process re-imports the host module from disk.
    const successor = launcherSource('successor', 0);
    await fs.writeFile(
      launcherPath,
      launcherSource(
        'predecessor',
        PSU_REEXEC_EXIT_CODE,
        `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(
          launcherPath,
        )}, ${JSON.stringify(successor)});`,
      ),
    );

    const { code } = await runShim();
    expect(code).toBe(0);
    const log = await fs.readFile(path.join(tmp, 'runs.log'), 'utf8');
    expect(log.split('\n').filter(Boolean)).toEqual(['predecessor', 'successor']);
  });

  it('advertises PAPERCUSP_PSU_REEXEC to the launcher — the capability handshake the host gates on', async () => {
    await writePsuShim();
    await fs.writeFile(
      launcherPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.RUN_LOG, 'saw=' + (process.env.PAPERCUSP_PSU_REEXEC ?? 'unset') + '\\n');",
        'process.exit(0);',
        '',
      ].join('\n'),
    );

    const { code } = await runShim();
    expect(code).toBe(0);
    expect(await fs.readFile(path.join(tmp, 'runs.log'), 'utf8')).toBe(
      `saw=${PSU_REEXEC_EXIT_CODE}\n`,
    );
  });

  it('advertises the LOOP\'S OWN pid as the launcher\'s parent, so an inherited promise is distinguishable', async () => {
    // The launcher only honours an advertisement whose PPID is its actual parent.
    // That check is worth nothing unless the shim really does publish the pid of
    // the process that will re-run it — which requires bash to still be there,
    // i.e. the loop must not have `exec`ed itself away. Asserting node's real
    // ppid against the advertised value proves both halves at once.
    await writePsuShim();
    await fs.writeFile(
      launcherPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.RUN_LOG, 'advertised=' + (process.env.PAPERCUSP_PSU_REEXEC_PPID ?? 'unset') + ' actual=' + process.ppid + '\\n');",
        'process.exit(0);',
        '',
      ].join('\n'),
    );

    const { code } = await runShim();
    expect(code).toBe(0);
    const line = (await fs.readFile(path.join(tmp, 'runs.log'), 'utf8')).trim();
    const [, advertised, actual] = /advertised=(\d+) actual=(\d+)/.exec(line) ?? [];
    expect(advertised, `expected a numeric advertised ppid in: ${line}`).toBeDefined();
    expect(advertised).toBe(actual);
  });

  it('CONTROL: a shim without the opt-in neither advertises nor loops — so a launcher under it must never take the exiting path', async () => {
    await writePlainShim();
    // Same launcher as the loop test: it asks to be re-run. Under a shim with no
    // loop, that request is simply an exit code — which is exactly why the host
    // must refuse to use it unless the handshake is present.
    await fs.writeFile(
      launcherPath,
      [
        "import { appendFileSync } from 'node:fs';",
        "appendFileSync(process.env.RUN_LOG, 'saw=' + (process.env.PAPERCUSP_PSU_REEXEC ?? 'unset') + '\\n');",
        `process.exit(${PSU_REEXEC_EXIT_CODE});`,
        '',
      ].join('\n'),
    );

    const { code } = await runShim();
    expect(code).toBe(PSU_REEXEC_EXIT_CODE);
    expect(await runCount()).toBe(1);
    expect(await fs.readFile(path.join(tmp, 'runs.log'), 'utf8')).toBe('saw=unset\n');
  });

  it('passes an ordinary exit code through untouched and does not re-run', async () => {
    await writePsuShim();
    await fs.writeFile(launcherPath, launcherSource('once', 3));

    const { code } = await runShim();
    expect(code).toBe(3);
    expect(await runCount()).toBe(1);
  });

  it('caps a non-converging loop instead of respawning the session forever', async () => {
    await writePsuShim();
    // A launcher that ALWAYS asks to be re-run — the case that does not reach a
    // fixed point (a file rewritten under a running loop). Without the cap this
    // test would not finish; with it, the shim gives up and surfaces why.
    await fs.writeFile(launcherPath, launcherSource('always', PSU_REEXEC_EXIT_CODE));

    const { code, stderr } = await runShim();
    expect(code).toBe(PSU_REEXEC_EXIT_CODE);
    expect(await runCount()).toBe(PSU_REEXEC_MAX + 1);
    expect(stderr).toContain('refusing to loop again');
  });

  it('WI-10005351: re-execs spaced a window apart never reach the cap — a long-lived session adopting all day is not a loop', async () => {
    await writePsuShim();
    // Asks for a re-exec on every pass until it has run PSU_REEXEC_MAX + 4
    // times, then ends the session normally. Under the lifetime cap the shim
    // refused at pass PSU_REEXEC_MAX + 1 and the session went dark (measured:
    // 6 of 7 owners whose event log reached a 17th adoption got no prompt
    // successor kickoff on it). Window 0 makes every re-exec a new burst, which
    // is exactly the spacing of real adoptions (one per carry-respawn, minutes apart).
    const passes = PSU_REEXEC_MAX + 5;
    await fs.writeFile(
      launcherPath,
      [
        "import { appendFileSync, readFileSync } from 'node:fs';",
        "appendFileSync(process.env.RUN_LOG, 'pass\\n');",
        "const n = readFileSync(process.env.RUN_LOG, 'utf8').split('\\n').filter(Boolean).length;",
        `process.exit(n < ${passes} ? ${PSU_REEXEC_EXIT_CODE} : 0);`,
        '',
      ].join('\n'),
    );

    const { code, stderr } = await runShim({ PAPERCUSP_PSU_REEXEC_WINDOW_SEC: '0' });
    expect(stderr).not.toContain('refusing to loop again');
    expect(code).toBe(0);
    expect(await runCount()).toBe(passes);
  });

  it('WI-10005351: a malformed window override falls back to the default burst window, so a real loop is still capped', async () => {
    await writePsuShim();
    await fs.writeFile(launcherPath, launcherSource('always', PSU_REEXEC_EXIT_CODE));

    const { code, stderr } = await runShim({ PAPERCUSP_PSU_REEXEC_WINDOW_SEC: 'soon' });
    expect(code).toBe(PSU_REEXEC_EXIT_CODE);
    expect(await runCount()).toBe(PSU_REEXEC_MAX + 1);
    expect(stderr).toContain('refusing to loop again');
  });

  it('does not `exec` the launcher — bash must survive the swap or the terminal foreground pgid dies with it', async () => {
    await writePsuShim();
    const body = await fs.readFile(shimPath, 'utf8');
    // `exec node …` would replace bash with node, which is precisely what makes
    // the swap impossible: there would be no parent left to run the successor.
    expect(body).not.toMatch(/^\s*exec\s/m);
    expect(body).toContain('while :; do');

    // The control shim keeps `exec` — it has no successor to run and the extra
    // process would be pure overhead.
    await writePlainShim();
    expect(await fs.readFile(shimPath, 'utf8')).toMatch(/^exec\s/m);
  });

  it('re-resolves the launcher path on every pass, so a moved release/integration root is picked up', async () => {
    await writePsuShim();
    const body = await fs.readFile(shimPath, 'utf8');
    const loopIdx = body.indexOf('while :; do');
    expect(loopIdx).toBeGreaterThan(-1);
    // A resolve_launcher call must appear INSIDE the loop body, not only in the
    // one-shot preamble — otherwise the successor re-runs the predecessor's path
    // after a deploy moved the tree out from under it.
    expect(body.indexOf('resolve_launcher', loopIdx)).toBeGreaterThan(loopIdx);
  });
});
