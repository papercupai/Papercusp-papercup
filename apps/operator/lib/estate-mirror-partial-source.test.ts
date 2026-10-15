/**
 * WI-10006330 — a source backup that recorded producer failures must not be mirrored
 * SILENTLY.
 *
 * Measured 2026-10-05: hetzner-restore-mesh's pc-estate-backup.sh recorded
 * "failures": 1 (posthog.sharded_query_log_archive hit SOCKET_TIMEOUT) and uploaded
 * 108/109 artifacts. The mirror verified every DECLARED artifact, published the
 * snapshot, and raised nothing — and nothing on the source VMs alerts either, so the
 * gap was found only by reading MANIFEST.json by hand.
 *
 * The fix announces it ONCE, when the snapshot is first published, through a
 * dedicated --partial-source alert mode that writes no latch: the mirror is not
 * failing and its probe is not degraded, so neither marker's claim would be true,
 * and the 6-hourly health probe must not re-raise a known fault (WI-10001692).
 *
 * Hermetic: the REAL pc-estate-mirror.sh runs in `mirror` mode under a tmp
 * PC_ESTATE_MIRROR_ROOT with a gcloud shim that materialises verifiable snapshots
 * (same approach as estate-mirror-keep-window.test.ts) and PC_ESTATE_MIRROR_ALERT
 * pointed at a recording stub. The REAL alert script is then driven directly with a
 * recording `node` shim standing in for scripts/mcp-call.mjs.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ESTATE_DIR = resolve(__dirname, '../../../infra/estate-backup');
// PROBE_* let scripts/mutation-probe.sh point the suite at a historical copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? join(ESTATE_DIR, 'pc-estate-mirror.sh');
const ALERT_SCRIPT = process.env.PROBE_ALERT_SCRIPT ?? join(ESTATE_DIR, 'pc-estate-mirror-alert.sh');
const BUCKET = 'gs://shim-estate-bucket';
const HOST = 'hetzner-restore-mesh';

type Failures = number | string[];

function shim(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, '#!/usr/bin/env bash\n' + body + '\n');
  chmodSync(p, 0o755);
}

function manifestUrl(ts: string): string {
  const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  return `${BUCKET}/daily/${d}/${HOST}/${ts}/MANIFEST.json`;
}

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function newRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Run the real mirror against a fake bucket. Re-usable on the same root. */
function runMirror(root: string, snaps: Record<string, Failures>) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const listing = join(root, 'listing.txt');
  const failuresDir = join(root, 'source-failures');
  const alertCalls = join(root, 'alert-calls.log');
  mkdirSync(failuresDir, { recursive: true });
  writeFileSync(listing, Object.keys(snaps).map(manifestUrl).join('\n') + '\n');
  for (const [ts, f] of Object.entries(snaps)) writeFileSync(join(failuresDir, ts), JSON.stringify(f));

  shim(bin, 'ip', 'echo "default via 192.0.2.1 dev shim0"');
  shim(bin, 'getent', 'exit 0');
  shim(bin, 'systemctl', 'exit 0');
  shim(bin, 'chattr', 'exit 1');
  shim(bin, 'sudo', 'exit 1');
  shim(bin, 'notify-send', 'exit 0');
  shim(
    bin,
    'gcloud',
    `
if [ "$1 $2" = "storage ls" ]; then
  case "$3" in *MANIFEST.json) cat '${listing}' ;; esac
  exit 0
fi
if [ "$1 $2" = "storage cp" ]; then
  src="$4"; dest="$5"
  case "$src" in *"/tools/"*) mkdir -p "$dest" && echo bucket-runbook >"$dest/RESTORE-RUNBOOK.md"; exit 0 ;; esac
  ts="\${src##*/}"
  mkdir -p "$dest/$ts" || exit 1
  printf 'abc' >"$dest/$ts/a.bin"
  printf '{"artifacts":[{"path":"a.bin","bytes":3}],"failures":%s}' "$(cat '${failuresDir}'/"$ts")" >"$dest/$ts/MANIFEST.json"
  exit 0
fi
exit 0`,
  );
  // Records one line per alert invocation: its arguments, tab-separated.
  shim(bin, 'alert-stub', `printf '%s\\t' "$@" >>'${alertCalls}'; echo >>'${alertCalls}'; exit 0`);

  const run = spawnSync('bash', [SCRIPT, 'mirror'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: root,
      PC_ESTATE_BUCKET: BUCKET,
      PC_ESTATE_MIRROR_ROOT: root,
      PC_ESTATE_MIRROR_ALERT: join(bin, 'alert-stub'),
      PC_ESTATE_MIRROR_KEEP: '14',
      PC_ESTATE_MIRROR_MIN_FREE_GB: '0',
      PC_ESTATE_MIRROR_NET_WAIT_SEC: '0',
      PC_ESTATE_MIRROR_PROBE_RETRY_SEC: '0',
      PC_ESTATE_MIRROR_SEAL: '0',
      PC_ESTATE_MIRROR_TOOLS_SRC: ESTATE_DIR,
    },
  });
  const calls = existsSync(alertCalls) ? readFileSync(alertCalls, 'utf8').split('\n').filter(Boolean) : [];
  const statePath = join(root, 'MIRROR-STATE.json');
  return {
    status: run.status,
    log: existsSync(join(root, 'mirror.log')) ? readFileSync(join(root, 'mirror.log'), 'utf8') : '',
    state: existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { ok?: boolean }) : null,
    partial: calls.filter((l) => l.startsWith('--partial-source\t')),
    other: calls.filter((l) => !l.startsWith('--partial-source\t')),
    published: (ts: string) => existsSync(join(root, 'snapshots', HOST, ts, 'MIRROR-META.json')),
  };
}

describe('pc-estate-mirror.sh announces a partial SOURCE backup once (WI-10006330)', () => {
  it('calibration: clean snapshots (integer 0 and empty list) are published with no partial-source alert', () => {
    const r = runMirror(newRoot('estate-mirror-partial-'), { '20261004T033120Z': 0, '20261006T033311Z': [] });
    // Positive control: both snapshots really went through publish, so the absence
    // of an alert below is a measurement, not a run that never reached the hook.
    expect(r.published('20261004T033120Z')).toBe(true);
    expect(r.published('20261006T033311Z')).toBe(true);
    expect(r.partial).toEqual([]);
    expect(r.log).not.toContain('PARTIAL SOURCE BACKUP');
  });

  it('a snapshot whose MANIFEST records producer failures raises exactly one partial-source alert naming it', () => {
    const r = runMirror(newRoot('estate-mirror-partial-'), { '20261005T033115Z': 1, '20261006T033311Z': 0 });
    expect(r.published('20261005T033115Z')).toBe(true);
    expect(r.partial).toHaveLength(1);
    expect(r.partial[0]).toContain(`${HOST}/20261005T033115Z`);
    expect(r.partial[0]).toContain('1 artifact failure(s)');
    expect(r.log).toContain(`PARTIAL SOURCE BACKUP ${HOST}/20261005T033115Z`);
    // Not a mirror fault: no FAILING alarm, no degraded alert, and the run is ok.
    expect(r.other).toEqual([]);
    expect(r.state?.ok).toBe(true);
  });

  it('a list-form failures field is counted by length, never read as zero', () => {
    const r = runMirror(newRoot('estate-mirror-partial-'), { '20261005T033115Z': ['a', 'b'] });
    expect(r.partial).toHaveLength(1);
    expect(r.partial[0]).toContain('2 artifact failure(s)');
  });

  it('is one-shot: a later run that already holds the snapshot does not re-announce it', () => {
    const root = newRoot('estate-mirror-partial-');
    const first = runMirror(root, { '20261005T033115Z': 1 });
    expect(first.partial).toHaveLength(1);
    const second = runMirror(root, { '20261005T033115Z': 1 });
    expect(second.published('20261005T033115Z')).toBe(true);
    // The alert log is cumulative, so still exactly one line means no second call.
    expect(second.partial).toHaveLength(1);
  });
});

describe('pc-estate-mirror-alert.sh --partial-source (WI-10006330)', () => {
  function runAlert() {
    const root = newRoot('estate-alert-partial-');
    const bin = join(root, 'bin');
    const repo = join(root, 'repo');
    mkdirSync(bin);
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'mcp-call.mjs'), '// presence only; node is shimmed\n');
    const sent = join(root, 'node-argv.log');
    shim(bin, 'node', `printf '%s\\n' "$@" >>'${sent}'; exit 0`);
    shim(bin, 'notify-send', 'exit 0');
    const run = spawnSync('bash', [ALERT_SCRIPT, '--partial-source', `${HOST}/20261005T033115Z: 1 failure`], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, PC_ESTATE_MIRROR_ROOT: root, PC_REPO: repo },
    });
    return {
      status: run.status,
      stderr: run.stderr ?? '',
      argv: existsSync(sent) ? readFileSync(sent, 'utf8').split('\n') : [],
      marker: (name: string) => existsSync(join(root, name)),
    };
  }

  it('sends one expects:"action" message that says the mirror is healthy, and latches no marker', () => {
    const r = runAlert();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('SOURCE BACKUP PARTIAL:');
    expect(r.marker('ALERT-MIRROR-FAILING')).toBe(false);
    expect(r.marker('ALERT-MIRROR-DEGRADED')).toBe(false);
    expect(r.argv).toContain('coord:send');
    const payload = r.argv.find((l) => l.startsWith('{'));
    expect(payload).toBeDefined();
    const msg = JSON.parse(payload as string) as { expects: string; summary: string };
    expect(msg.expects).toBe('action');
    expect(msg.summary).toContain('SOURCE ESTATE BACKUP PARTIAL (off-GCP mirror is healthy)');
    expect(msg.summary).toContain(`${HOST}/20261005T033115Z`);
    expect(msg.summary).not.toContain('MIRROR FAILING');
  });
});
