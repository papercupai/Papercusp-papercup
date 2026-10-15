// docs-build-singleflight (EI-11539) — the docs analog of operator-vite's
// vite-build-singleflight (EI-9836). Two agents running the documented
// post-MDX-edit refresh (`cd apps/operator-docs && npm run build`) at the same
// time used to interleave create/delete on the SAME dist/.prerender chunks and
// BOTH died with ERR_MODULE_NOT_FOUND on a random chunk — masquerading as a
// flaky build. The wrapper serializes every build through one bounded lock.
//
// Exercised through the DOCS_BUILD_CMD seam (a shell stand-in for the real
// pipeline) + DOCS_BUILD_LOCK (lock in a tmp dir): the stand-in flags OVERLAP
// if it ever starts while a peer is mid-"build". The test lives here (not in
// apps/operator-docs) because operator-docs has no vitest infra — this
// directory already hosts the repo-script tests.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../../operator-docs/scripts/docs-build-singleflight');
const DOCS_PACKAGE = resolve(__dirname, '../../../operator-docs/package.json');

let tmp: string;
const children: ChildProcess[] = [];

function launch(cmd: string, env: Record<string, string> = {}, args: string[] = []): ChildProcess {
  const child = spawn('bash', [SCRIPT, ...args], {
    env: {
      ...process.env,
      DOCS_BUILD_LOCK: join(tmp, 'build.lock'),
      DOCS_BUILD_CMD: cmd,
      DOCS_BUILD_WAIT_SECS: '30',
      DOCS_BUILD_SOURCE_ROOT: join(tmp, 'source'),
      RUN_DIR: tmp, // referenced by the stand-in cmds below
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

const exited = (c: ChildProcess) => new Promise<number | null>((r) => c.on('exit', (code) => r(code)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dbs-'));
  mkdirSync(join(tmp, 'source'));
});

afterEach(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  children.length = 0;
  rmSync(tmp, { recursive: true, force: true });
});

describe('docs-build-singleflight (EI-11539)', () => {
  it('holds the lock across PG materialization and the inner docs build', async () => {
    const docsPackage = JSON.parse(readFileSync(DOCS_PACKAGE, 'utf8')) as { scripts: Record<string, string> };
    expect(docsPackage.scripts['build:from-pg']).toBe('bash scripts/docs-build-singleflight --from-pg');

    const materialize =
      'if [ -e "$RUN_DIR/running" ]; then echo overlap >> "$RUN_DIR/violations"; fi; ' +
      'touch "$RUN_DIR/running" "$RUN_DIR/materializing"; sleep 0.4; ' +
      'echo materialize >> "$RUN_DIR/order"; rm -f "$RUN_DIR/running"';
    const pgBuild =
      'if [ -e "$RUN_DIR/running" ]; then echo overlap >> "$RUN_DIR/violations"; fi; ' +
      'touch "$RUN_DIR/running"; sleep 0.1; echo pg-build >> "$RUN_DIR/order"; rm -f "$RUN_DIR/running"';
    const normalBuild =
      'if [ -e "$RUN_DIR/running" ]; then echo overlap >> "$RUN_DIR/violations"; fi; ' +
      'touch "$RUN_DIR/running"; sleep 0.1; echo normal-build >> "$RUN_DIR/order"; rm -f "$RUN_DIR/running"';

    const pg = launch(pgBuild, { DOCS_BUILD_PRE_CMD: materialize }, ['--from-pg']);
    const deadline = Date.now() + 1000;
    while (!existsSync(join(tmp, 'materializing')) && Date.now() < deadline) await sleep(10);
    expect(existsSync(join(tmp, 'materializing'))).toBe(true);
    const normal = launch(normalBuild);

    const [pgCode, normalCode] = await Promise.all([exited(pg), exited(normal)]);
    expect(pgCode).toBe(0);
    expect(normalCode).toBe(0);
    expect(existsSync(join(tmp, 'violations'))).toBe(false);
    const order = readFileSync(join(tmp, 'order'), 'utf8').trim().split('\n');
    expect(order).toHaveLength(3);
    expect(order.indexOf('materialize')).toBeLessThan(order.indexOf('pg-build'));
  });

  it('serializes two concurrent builds — the second QUEUES; they never overlap, and both run', async () => {
    const cmd =
      'if [ -e "$RUN_DIR/running" ]; then echo overlap >> "$RUN_DIR/violations"; fi; ' +
      'touch "$RUN_DIR/running"; sleep 0.4; rm -f "$RUN_DIR/running"; echo done >> "$RUN_DIR/order"';
    const a = launch(cmd);
    await sleep(100); // let A take the lock first
    const b = launch(cmd);
    const [ca, cb] = await Promise.all([exited(a), exited(b)]);
    expect(ca).toBe(0);
    expect(cb).toBe(0);
    // Never ran concurrently…
    expect(existsSync(join(tmp, 'violations'))).toBe(false);
    // …but both DID run (a queued build still deserves to run — it picks up
    // the second agent's edits; refusing outright would silently drop them).
    expect(readFileSync(join(tmp, 'order'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it("propagates the inner build's failure exit code (a red build stays loud)", async () => {
    const c = launch('exit 7');
    expect(await exited(c)).toBe(7);
  });

  it('rebuilds a page added during compilation instead of keeping the moving-census failure', async () => {
    const cmd = 'echo attempt >> "$RUN_DIR/order"; ' +
      'if [ ! -e "$RUN_DIR/source/new.mdx" ]; then ' +
      'echo new > "$RUN_DIR/source/new.mdx"; exit 1; fi; ' +
      'cp "$RUN_DIR/source/new.mdx" "$RUN_DIR/rendered"';
    expect(await exited(launch(cmd))).toBe(0);
    expect(readFileSync(join(tmp, 'order'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(readFileSync(join(tmp, 'rendered'), 'utf8')).toBe('new\n');
  });

  it('rebuilds changed bytes even when both existing twins let the first build exit zero', async () => {
    writeFileSync(join(tmp, 'source/page.mdx'), 'old');
    const cmd = 'cp "$RUN_DIR/source/page.mdx" "$RUN_DIR/rendered"; ' +
      'if [ ! -e "$RUN_DIR/changed" ]; then ' +
      'printf new > "$RUN_DIR/source/page.mdx"; touch "$RUN_DIR/changed"; fi';
    expect(await exited(launch(cmd))).toBe(0);
    expect(readFileSync(join(tmp, 'rendered'), 'utf8')).toBe('new');
  });

  it('bounds changing inputs to two attempts and refuses a false current verdict', async () => {
    const cmd = 'echo changed >> "$RUN_DIR/source/page.mdx"; echo attempt >> "$RUN_DIR/order"';
    const child = launch(cmd);
    let err = '';
    child.stderr?.setEncoding('utf8').on('data', (data: string) => { err += data; });
    expect(await exited(child)).toBe(1);
    expect(readFileSync(join(tmp, 'order'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(err).toContain('mirror is not verified current');
  });

  it('times out LOUDLY (bounded wait) instead of queuing forever behind a wedged holder', async () => {
    const holder = launch('sleep 30');
    await sleep(200); // holder owns the lock
    const waiter = launch('echo ran >> "$RUN_DIR/order"', { DOCS_BUILD_WAIT_SECS: '1' });
    let err = '';
    waiter.stderr?.on('data', (d) => {
      err += String(d);
    });
    expect(await exited(waiter)).toBe(1);
    expect(err).toContain('TIMED OUT');
    expect(existsSync(join(tmp, 'order'))).toBe(false); // the inner cmd never ran
    holder.kill('SIGKILL');
  });
});
