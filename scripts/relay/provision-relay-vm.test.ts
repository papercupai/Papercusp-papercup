/**
 * provision-relay-vm.sh `up` idempotency (WI-10004956): only gcloud's "was not
 * found" may read as "absent". A transient describe failure once made `up` try to
 * re-create an existing network; it must now retry and then fail loudly instead.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, 'provision-relay-vm.sh');
const dir = mkdtempSync(join(tmpdir(), 'relay-provision-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake gcloud that answers each call from a queue of [exitCode, stderr] lines. */
/**
 * `rc` is gc_exists' RETURN code, echoed by the caller. It is null when the function
 * killed the shell (die → exit), which by exit status alone looks the same as "absent".
 */
function runGcExists(answers: Array<[number, string]>): { rc: number | null; calls: number; stderr: string } {
  const queue = join(dir, `queue-${Math.random().toString(36).slice(2)}`);
  const counter = `${queue}.n`;
  writeFileSync(queue, answers.map(([code, err]) => `${code}\t${err}`).join('\n') + '\n');
  writeFileSync(counter, '0');
  const fake = join(dir, 'fake-gcloud');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
n=$(( $(cat "$COUNTER") + 1 )); echo "$n" > "$COUNTER"
line=$(sed -n "\${n}p" "$QUEUE"); code=\${line%%$'\\t'*}; err=\${line#*$'\\t'}
[ -n "$err" ] && echo "$err" >&2
exit "\${code:-0}"
`,
  );
  chmodSync(fake, 0o755);
  // sleep is stubbed so the retry path costs nothing.
  const r = spawnSync(
    'bash',
    [
      '-c',
      `source "$SCRIPT"; GC=("$FAKE"); sleep() { :; }
       if gc_exists compute networks describe pc-blind-relay-net; then echo "rc=0"; else echo "rc=$?"; fi`,
    ],
    { env: { ...process.env, SCRIPT, FAKE: fake, QUEUE: queue, COUNTER: counter }, encoding: 'utf8' },
  );
  const calls = Number(spawnSync('cat', [counter], { encoding: 'utf8' }).stdout.trim());
  const m = /rc=(\d+)/.exec(r.stdout);
  return { rc: m ? Number(m[1]) : null, calls, stderr: r.stderr };
}

describe('provision-relay-vm.sh gc_exists', () => {
  it('reports an existing resource as present', () => {
    expect(runGcExists([[0, '']])).toMatchObject({ rc: 0, calls: 1 });
  });
  it('reports absent only on a gcloud "was not found"', () => {
    const notFound = "ERROR: (gcloud.compute.networks.describe) Could not fetch resource: - The resource 'projects/p/global/networks/x' was not found";
    expect(runGcExists([[1, notFound]])).toMatchObject({ rc: 1, calls: 1 });
  });
  it('retries a transient failure instead of reading it as absent', () => {
    expect(runGcExists([[1, 'ERROR: There was a problem refreshing your current auth tokens'], [0, '']])).toMatchObject({
      rc: 0,
      calls: 2,
    });
  });
  it('dies (never returns "absent") when every attempt errors for another reason', () => {
    const r = runGcExists([
      [1, 'ERROR: 503 backend error'],
      [1, 'ERROR: 503 backend error'],
      [1, 'ERROR: 503 backend error'],
    ]);
    expect(r.calls).toBe(3);
    expect(r.rc).toBeNull();
    expect(r.stderr).toMatch(/cannot tell whether it exists/);
  });
  it('sourcing the script runs no subcommand', () => {
    const r = spawnSync('bash', ['-c', `source "$SCRIPT"; echo loaded`], { env: { ...process.env, SCRIPT }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('loaded');
  });
});
