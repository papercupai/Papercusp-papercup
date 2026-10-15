/**
 * WI-10006308 — pc-estate-mirror must fetch only the snapshots retention will KEEP.
 *
 * Measured 2026-10-06 from mirror.log: every daily run re-downloaded, verified and
 * sealed every bucket snapshot older than the newest KEEP=14 per host, and retention
 * then deleted them minutes later — "+45 new … 45 pruned" on 2026-10-03 (~38min,
 * ~50GB of GCS egress), growing by two snapshots a day toward the unit's
 * TimeoutStartSec. The fix walks each host newest-first and stops once KEEP are held.
 *
 * Also pins the companion wiring: the unit now runs the script through
 * papercusp-script-snapshot.sh (EI-22458080342999427), whose private copy holds only
 * *.sh/*.mjs siblings — so the restore runbook source must come from
 * PC_ESTATE_MIRROR_TOOLS_SRC, or tools/ silently falls back to the bucket's copy.
 *
 * Hermetic: the REAL script (and, for the launcher case, the REAL launcher) runs under
 * a tmp PC_ESTATE_MIRROR_ROOT with a gcloud shim that serves a fake bucket listing
 * and materialises verifiable snapshots on `storage cp`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ESTATE_DIR = resolve(__dirname, '../../../infra/estate-backup');
// Overridable so falsifiability can be proven against a pre-fix COPY outside the tree.
const SCRIPT = process.env.ESTATE_MIRROR_SCRIPT ?? join(ESTATE_DIR, 'pc-estate-mirror.sh');
const LAUNCHER = resolve(__dirname, '../scripts/systemd/papercusp-script-snapshot.sh');
const BUCKET = 'gs://fake-estate-bucket';

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function shim(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, '#!/usr/bin/env bash\n' + body + '\n');
  chmodSync(p, 0o755);
}

/** `daily/<date>/<host>/<ts>/MANIFEST.json` for a ts like 20260901T033000Z. */
function manifestUrl(host: string, ts: string): string {
  const d = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  return `${BUCKET}/daily/${d}/${host}/${ts}/MANIFEST.json`;
}

function day(n: number): string {
  return `202609${String(n).padStart(2, '0')}T033000Z`;
}

interface Opts {
  bucket: Array<[host: string, ts: string]>;
  held?: Array<[host: string, ts: string]>;
  /** snapshots whose bucket copy is missing an artifact (source_incomplete) */
  incomplete?: string[];
  keep: number;
  viaLauncher?: boolean;
  toolsSrc?: 'repo' | 'unset';
}

function runMirror(opts: Opts) {
  const root = mkdtempSync(join(tmpdir(), 'estate-mirror-keep-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls.log');
  const listing = join(root, 'listing.txt');
  const bad = join(root, 'incomplete.txt');
  writeFileSync(listing, opts.bucket.map(([h, t]) => manifestUrl(h, t)).join('\n') + '\n');
  writeFileSync(bad, (opts.incomplete ?? []).join('\n') + '\n');

  shim(bin, 'ip', 'echo "default via 192.0.2.1 dev shim0"');
  shim(bin, 'getent', 'exit 0');
  shim(bin, 'systemctl', 'exit 0');
  shim(bin, 'chattr', 'exit 1');
  shim(bin, 'sudo', 'exit 1');
  // gcloud storage ls <bucket>/                  -> reachability probe
  // gcloud storage ls <bucket>/daily/**/MANIFEST -> the fake listing
  // gcloud storage cp -r <prefix> <dest>/ --quiet -> a verifiable snapshot (or a
  //   source-incomplete one), recorded so the test can assert WHAT was fetched
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
  echo "cp $src" >>'${calls}'
  case "$src" in *"/tools/"*) mkdir -p "$dest" && echo bucket-runbook >"$dest/RESTORE-RUNBOOK.md"; exit 0 ;; esac
  ts="\${src##*/}"
  mkdir -p "$dest/$ts" || exit 1
  printf 'abc' >"$dest/$ts/a.bin"
  if grep -qx "$ts" '${bad}'; then
    printf '{"artifacts":[{"path":"a.bin","bytes":3},{"path":"b.bin","bytes":3}],"failures":[]}' >"$dest/$ts/MANIFEST.json"
  else
    printf '{"artifacts":[{"path":"a.bin","bytes":3}],"failures":[]}' >"$dest/$ts/MANIFEST.json"
  fi
  exit 0
fi
exit 0`,
  );

  for (const [h, t] of opts.held ?? []) {
    const d = join(root, 'snapshots', h, t);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'MIRROR-META.json'), '{}');
  }

  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    TMPDIR: root,
    PC_ESTATE_BUCKET: BUCKET,
    PC_ESTATE_MIRROR_ROOT: root,
    PC_ESTATE_MIRROR_ALERT: '/bin/true',
    PC_ESTATE_MIRROR_KEEP: String(opts.keep),
    PC_ESTATE_MIRROR_MIN_FREE_GB: '0',
    PC_ESTATE_MIRROR_NET_WAIT_SEC: '0',
    PC_ESTATE_MIRROR_PROBE_RETRY_SEC: '0',
    PC_ESTATE_MIRROR_SEAL: '0',
  };
  if (opts.toolsSrc === 'repo') env.PC_ESTATE_MIRROR_TOOLS_SRC = ESTATE_DIR;
  const argv = opts.viaLauncher ? [LAUNCHER, SCRIPT, 'mirror'] : [SCRIPT, 'mirror'];
  const run = spawnSync('bash', argv, { encoding: 'utf8', env });

  const fetched = existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('cp ') && !l.includes('/tools/'))
        .map((l) => l.replace(/^cp .*\//, ''))
    : [];
  const tsOf = (h: string) => {
    const d = join(root, 'snapshots', h);
    return existsSync(d) ? readdirSync(d).sort() : [];
  };
  const statePath = join(root, 'MIRROR-STATE.json');
  const toolsSource = join(root, 'tools', 'TOOLS-SOURCE.txt');
  return {
    status: run.status,
    stderr: run.stderr,
    log: existsSync(join(root, 'mirror.log')) ? readFileSync(join(root, 'mirror.log'), 'utf8') : '',
    fetched,
    held: tsOf,
    quarantined: (h: string) => {
      const d = join(root, '.quarantine', h);
      return existsSync(d) ? readdirSync(d).sort() : [];
    },
    state: existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null,
    toolsSource: existsSync(toolsSource) ? readFileSync(toolsSource, 'utf8') : '',
    toolsFetchedFromBucket: existsSync(calls) && readFileSync(calls, 'utf8').includes('/tools/'),
  };
}

const A = 'host-a';
const B = 'host-b';

describe('WI-10006308 — the mirror fetches only what retention keeps', () => {
  it('is the right script (guards a vacuous suite)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('beyond_keep');
    expect(src).toContain('PC_ESTATE_MIRROR_TOOLS_SRC');
    expect(existsSync(LAUNCHER)).toBe(true);
  });

  it('cold start: fetches only the newest KEEP per host, newest first, and prunes nothing', () => {
    const r = runMirror({
      keep: 3,
      bucket: [1, 2, 3, 4, 5, 6].map((n) => [A, day(n)] as [string, string]).concat([[B, day(5)], [B, day(6)]]),
    });
    expect(r.status, r.stderr + r.log).toBe(0);
    expect(r.fetched).toHaveLength(5);
    // host-a: only the 3 newest, in newest-first order; never the 3 that retention would prune.
    expect(r.fetched.slice(0, 3)).toEqual([day(6), day(5), day(4)]);
    expect(r.fetched).not.toContain(day(1));
    expect(r.held(A)).toEqual([day(4), day(5), day(6)]);
    expect(r.held(B)).toEqual([day(5), day(6)]);
    expect(r.state).toMatchObject({ ok: true, mirrored: 5, pruned: 0 });
    expect(r.log).toMatch(/not fetched: 3 bucket snapshot\(s\) older than the newest KEEP=3/);
  });

  it('steady state: a new day fetches ONE snapshot, and the oldest held one is pruned', () => {
    const r = runMirror({
      keep: 3,
      bucket: [1, 2, 3, 4, 5, 6, 7].map((n) => [A, day(n)] as [string, string]),
      held: [4, 5, 6].map((n) => [A, day(n)] as [string, string]),
    });
    expect(r.status, r.stderr + r.log).toBe(0);
    expect(r.fetched).toEqual([day(7)]);
    expect(r.held(A)).toEqual([day(5), day(6), day(7)]);
    expect(r.state).toMatchObject({ ok: true, mirrored: 1, already_held: 2, pruned: 1 });
  });

  it('a bad newest snapshot is quarantined and an older good one backfills behind it', () => {
    const r = runMirror({
      keep: 2,
      bucket: [1, 2, 3, 4].map((n) => [A, day(n)] as [string, string]),
      incomplete: [day(4)],
    });
    // A NEW quarantine still alarms (non-zero), exactly as before the change.
    expect(r.status).toBe(1);
    expect(r.fetched).toEqual([day(4), day(3), day(2)]);
    expect(r.quarantined(A)).toEqual([day(4)]);
    expect(r.held(A)).toEqual([day(2), day(3)]);
    expect(r.fetched).not.toContain(day(1));
  });
});

describe('EI-22458080342999427 wiring — run via the per-invocation snapshot launcher', () => {
  it('with PC_ESTATE_MIRROR_TOOLS_SRC the runbook comes from the repo, not the bucket', () => {
    const r = runMirror({ keep: 2, bucket: [[A, day(1)]], viaLauncher: true, toolsSrc: 'repo' });
    expect(r.status, r.stderr + r.log).toBe(0);
    expect(r.toolsSource).toContain(`source=repo:${ESTATE_DIR}`);
    expect(r.toolsFetchedFromBucket).toBe(false);
  });

  it('control: WITHOUT the override the launcher copy has no runbook and tools/ falls back to the bucket', () => {
    const r = runMirror({ keep: 2, bucket: [[A, day(1)]], viaLauncher: true, toolsSrc: 'unset' });
    expect(r.status, r.stderr + r.log).toBe(0);
    expect(r.toolsSource).toContain(`source=bucket:${BUCKET}/tools`);
    expect(r.toolsFetchedFromBucket).toBe(true);
  });

  it('the units actually use the launcher and pin the runbook source', () => {
    const mirror = readFileSync(join(ESTATE_DIR, 'pc-estate-mirror.service'), 'utf8');
    const health = readFileSync(join(ESTATE_DIR, 'pc-estate-mirror-health.service'), 'utf8');
    expect(mirror).toMatch(/^ExecStart=\S*papercusp-script-snapshot\.sh \S*pc-estate-mirror\.sh mirror$/m);
    expect(mirror).toMatch(/^Environment=PC_ESTATE_MIRROR_TOOLS_SRC=\S*infra\/estate-backup$/m);
    expect(health).toMatch(/^ExecStart=\S*papercusp-script-snapshot\.sh \S*pc-estate-mirror\.sh health$/m);
  });
});
