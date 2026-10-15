/**
 * Regression guard for WI-10005960.
 *
 * bake-cloud-images.sh builds into rootful podman storage on the ROOT filesystem and never removed
 * anything: every bake left its image, its superseded tags, its untagged build cache and any orphan
 * anonymous volume behind (measured 107 images / 25 GB + 19 volumes / 7.7 GB), and nothing measured
 * free space before writing tens of GB — the root disk ran down to git-sync's fetch-headroom reserve.
 *
 * bake-storage-hygiene.sh is the bounded fix. These tests drive the REAL helper against a fake
 * podman/df/sudo on PATH and pin both halves of its contract:
 *   - prune removes ONLY what is safe on a shared box (never a kept tag, the newest N, anything young
 *     enough to be a peer's in-flight bake, a named volume, or anything podman refuses to remove),
 *     and never fails the bake;
 *   - precheck refuses a bake the disk cannot hold, and refuses an UNMEASURED disk as well.
 *
 * BAKE_STORAGE_HYGIENE_SUBJECT points the suite at a copy of the helper (mutation probes).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const HELPER =
  process.env.BAKE_STORAGE_HYGIENE_SUBJECT ?? join(ROOT, 'infra/images/bootc/bake-storage-hygiene.sh');

const NOW = 2_000_000_000;
const HOUR = 3600;
const REPO = 'localhost:5000/papercusp/workspace-host';

const FAKE_PODMAN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  images)
    if [ "\${FAKE_IMAGES_FAIL:-0}" = 1 ]; then echo 'Error: storage is locked' >&2; exit 125; fi
    awk -v repo='${REPO}' '{ print ($3 == "" ? repo : $3), $1 }' "$FAKE_IMAGES"
    ;;
  image)
    case "$2" in
      inspect)
        ref="\${@: -1}"; tag="\${ref##*:}"
        awk -v t="$tag" '$1 == t { print $2; found = 1 } END { exit !found }' "$FAKE_IMAGES"
        ;;
      prune) exit "\${FAKE_PRUNE_RC:-0}" ;;
      *) echo "unexpected image subcommand: $*" >&2; exit 99 ;;
    esac
    ;;
  rmi)
    tag="\${2##*:}"
    if grep -qxF -- "$tag" "$FAKE_REFUSE"; then echo 'Error: image is in use by a container' >&2; exit 2; fi
    ;;
  volume)
    case "$2" in
      ls) cat "$FAKE_VOLUMES" ;;
      rm) if grep -qxF -- "$3" "$FAKE_REFUSE"; then exit 2; fi ;;
      *) echo "unexpected volume subcommand: $*" >&2; exit 99 ;;
    esac
    ;;
  info)
    if [ -z "\${FAKE_GRAPHROOT:-}" ]; then echo 'Error: cannot connect to podman' >&2; exit 125; fi
    printf '%s\\n' "$FAKE_GRAPHROOT"
    ;;
  *) echo "unexpected fake podman subcommand: $*" >&2; exit 99 ;;
esac
`;

const FAKE_DF = `#!/usr/bin/env bash
p="\${@: -1}"
printf '%s\\n' "$p" >> "$FAKE_DF_CALLS"
if [ "\${FAKE_DF_FAIL:-0}" = 1 ]; then echo "df: cannot read $p" >&2; exit 1; fi
avail="$(awk -v p="$p" '$1 == p { print $2 }' "$FAKE_DF_MAP")"
[ -n "$avail" ] || avail="\${FAKE_DF_DEFAULT:-500}"
echo 'Filesystem 1073741824-blocks Used Available Capacity Mounted on'
echo "/dev/fake 2000 1 $avail 1% /"
`;

const FAKE_SUDO = `#!/usr/bin/env bash
[ "$1" = -n ] && shift
exec "$@"
`;

interface Fixture {
  /** "tag createdEpoch" rows; `<none>` rows are untagged layers. */
  images?: string[];
  /** tags (or volume names) podman refuses to remove. */
  refuse?: string[];
  volumes?: string[];
  graphroot?: string | null;
  /** path -> free GiB the fake df reports. */
  df?: Record<string, number>;
  env?: Record<string, string>;
}

function run(args: string[], fixture: Fixture = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wi-10005960-hygiene-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['podman', FAKE_PODMAN], ['df', FAKE_DF], ['sudo', FAKE_SUDO]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const files = {
    calls: join(dir, 'podman-calls'),
    dfCalls: join(dir, 'df-calls'),
    images: join(dir, 'images'),
    refuse: join(dir, 'refuse'),
    volumes: join(dir, 'volumes'),
    dfMap: join(dir, 'df-map'),
  };
  writeFileSync(files.calls, '');
  writeFileSync(files.dfCalls, '');
  writeFileSync(files.images, (fixture.images ?? []).map((row) => `${row}\n`).join(''));
  writeFileSync(files.refuse, (fixture.refuse ?? []).map((row) => `${row}\n`).join(''));
  writeFileSync(files.volumes, (fixture.volumes ?? []).map((row) => `${row}\n`).join(''));
  writeFileSync(
    files.dfMap,
    Object.entries(fixture.df ?? {}).map(([path, gib]) => `${path} ${gib}\n`).join(''),
  );
  const graphroot = fixture.graphroot === undefined ? join(dir, 'graphroot') : fixture.graphroot;
  if (graphroot) mkdirSync(graphroot, { recursive: true });

  const result = spawnSync('bash', [HELPER, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: dir,
      FAKE_CALLS: files.calls,
      FAKE_DF_CALLS: files.dfCalls,
      FAKE_IMAGES: files.images,
      FAKE_REFUSE: files.refuse,
      FAKE_VOLUMES: files.volumes,
      FAKE_DF_MAP: files.dfMap,
      FAKE_GRAPHROOT: graphroot ?? '',
      BAKE_STORAGE_HYGIENE_NOW: String(NOW),
      ...fixture.env,
    },
  });
  const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const calls = lines(files.calls);
  return {
    dir,
    graphroot,
    status: result.status,
    stdout: result.stdout,
    output: `${result.stdout}${result.stderr}`,
    calls,
    removedTags: calls.filter((c) => c.startsWith('rmi ')).map((c) => c.slice(`rmi ${REPO}:`.length)),
    removedVolumes: calls.filter((c) => c.startsWith('volume rm ')).map((c) => c.slice('volume rm '.length)),
    dfCalls: lines(files.dfCalls),
  };
}

const ago = (hours: number) => NOW - hours * HOUR;
const VOL_A = 'a'.repeat(64);
const VOL_B = '0123456789abcdef'.repeat(4);

describe('bake-storage-hygiene.sh prune (WI-10005960)', () => {
  it('ignores foreign aliases returned for a matching image', () => {
    const r = run(['prune', '--repo', REPO], {
      images: [`old ${ago(40)}`, `608f229a006e ${ago(40)} localhost/control`],
      env: { BAKE_KEEP_RECENT: '0' },
    });
    expect(r.removedTags).toEqual(['old']);
    expect(r.calls.some((call) => call.includes(`${REPO}:608f229a006e`))).toBe(false);
    expect(r.stdout).not.toContain('could not read the creation time');
  });
  it('removes only superseded tags: keeps every --keep-tag, the newest N and anything young', () => {
    const r = run(['prune', '--repo', REPO, '--keep-tag', 'this-bake', '--keep-tag', 'reused-source'], {
      images: [
        `old-2 ${ago(40)}`,
        `this-bake ${ago(100)}`, // kept: the bake's own tag, however old
        `recent-1 ${ago(10)}`,
        `<none> 0`,
        `reused-source ${ago(200)}`, // kept: the local source image this bake reuses
        `young ${ago(1)}`, // kept: inside the protection window (a peer's in-flight bake)
        `old-1 ${ago(30)}`,
        `recent-2 ${ago(20)}`,
      ],
    });
    expect(r.status, r.output).toBe(0);
    expect(r.removedTags.sort()).toEqual(['old-1', 'old-2']);
    expect(r.calls.some((c) => c.includes('<none>'))).toBe(false);
    expect(r.stdout).toContain(
      `BAKE_STORAGE_PRUNE repo=${REPO} keepTag=this-bake,reused-source removedTags=2 keptTags=5 refusedTags=0`,
    );
  });

  it('honours BAKE_KEEP_RECENT and BAKE_PROTECT_MIN, and prunes dangling layers older than the window', () => {
    const r = run(['prune', '--repo', REPO], {
      images: [`a ${ago(1)}`, `b ${ago(2)}`, `c ${ago(3)}`],
      env: { BAKE_KEEP_RECENT: '0', BAKE_PROTECT_MIN: '90' },
    });
    expect(r.status, r.output).toBe(0);
    expect(r.removedTags.sort()).toEqual(['b', 'c']);
    expect(r.calls).toContain('image prune -f --filter until=90m');
    expect(r.stdout).toContain('keepTag=none removedTags=2 keptTags=1');
  });

  it('keeps an image podman refuses to remove, warns, and still exits 0', () => {
    const r = run(['prune', '--repo', REPO], {
      images: [`r1 ${ago(10)}`, `r2 ${ago(11)}`, `in-use ${ago(50)}`, `gone ${ago(60)}`],
      refuse: ['in-use'],
    });
    expect(r.status, r.output).toBe(0);
    expect(r.stdout).toContain(`BAKE_STORAGE_PRUNE_WARN podman refused to remove ${REPO}:in-use`);
    expect(r.stdout).toContain('removedTags=1 keptTags=2 refusedTags=1');
    // never forced: a refusal is podman protecting a container's image
    expect(r.calls.filter((c) => c.startsWith('rmi ')).every((c) => !/(^| )(-f|--force)( |$)/.test(c))).toBe(true);
  });

  it('keeps a tag whose creation time cannot be read', () => {
    const r = run(['prune', '--repo', REPO], { images: [`r1 ${ago(10)}`, `r2 ${ago(11)}`, `opaque not-a-time`, `old ${ago(90)}`] });
    expect(r.status, r.output).toBe(0);
    expect(r.removedTags).toEqual(['old']);
    expect(r.stdout).toContain(`BAKE_STORAGE_PRUNE_WARN could not read the creation time of ${REPO}:opaque (kept)`);
  });

  it('removes only anonymous (64-hex) dangling volumes, never a named one', () => {
    const r = run(['prune', '--repo', REPO], {
      volumes: [VOL_A, 'pgdata', 'abc123', VOL_B, `${VOL_A}0`, 'refused-by-podman'],
      refuse: [VOL_B],
    });
    expect(r.status, r.output).toBe(0);
    expect(r.removedVolumes).toEqual([VOL_A, VOL_B]);
    expect(r.calls).toContain('volume ls --filter dangling=true --format {{.Name}}');
    expect(r.stdout).toContain('removedVolumes=1 refusedVolumes=1');
  });

  it('never fails the bake: a listing failure, a failed image prune and a missing --repo all exit 0', () => {
    const failing = run(['prune', '--repo', REPO], { env: { FAKE_IMAGES_FAIL: '1', FAKE_PRUNE_RC: '1' } });
    expect(failing.status, failing.output).toBe(0);
    expect(failing.stdout).toContain(`BAKE_STORAGE_PRUNE_WARN could not list ${REPO} images`);
    expect(failing.stdout).toContain('BAKE_STORAGE_PRUNE_WARN podman image prune failed');
    expect(failing.removedTags).toEqual([]);

    const noRepo = run(['prune', '--keep-tag', 'x'], { images: [`old ${ago(90)}`] });
    expect(noRepo.status, noRepo.output).toBe(0);
    expect(noRepo.stdout).toContain('BAKE_STORAGE_PRUNE_WARN --repo is required (prune skipped)');
    expect(noRepo.calls).toEqual([]);
  });
});

describe('bake-storage-hygiene.sh precheck (WI-10005960)', () => {
  it('passes when the graphroot and every extra path have the headroom', () => {
    const out = mkdtempSync(join(tmpdir(), 'wi-10005960-out-'));
    const r = run(['precheck', out], { df: { [out]: 100 }, env: { FAKE_DF_DEFAULT: '200' } });
    expect(r.status, r.output).toBe(0);
    expect(r.stdout).toContain(`BAKE_STORAGE_HEADROOM path=${r.graphroot} freeGiB=200 minGiB=64`);
    expect(r.stdout).toContain(`BAKE_STORAGE_HEADROOM path=${out} freeGiB=100 minGiB=64`);
    expect(r.stdout).not.toContain('BAKE_RESULT=FAILED');
  });

  it('refuses the bake when any target is below BAKE_MIN_FREE_GIB', () => {
    const out = mkdtempSync(join(tmpdir(), 'wi-10005960-out-'));
    const r = run(['precheck', out], { df: { [out]: 10 } });
    expect(r.status, r.output).toBe(1);
    expect(r.stdout).toContain(`BAKE_RESULT=FAILED storage-headroom 10GiB free for ${out}, need >= 64GiB`);

    const graphLow = run(['precheck'], { env: { FAKE_DF_DEFAULT: '63' } });
    expect(graphLow.status, graphLow.output).toBe(1);
    expect(graphLow.stdout).toContain(`63GiB free for ${graphLow.graphroot}`);

    const tunable = run(['precheck'], { env: { FAKE_DF_DEFAULT: '63', BAKE_MIN_FREE_GIB: '10' } });
    expect(tunable.status, tunable.output).toBe(0);
  });

  it('measures a not-yet-created --out where it will be created (its nearest existing ancestor)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'wi-10005960-out-'));
    const r = run(['precheck', join(parent, 'bake-out', 'nested')], { df: { [parent]: 5 } });
    expect(r.status, r.output).toBe(1);
    expect(r.dfCalls).toContain(parent);
  });

  it('treats an unmeasurable disk as a failure, not as room (exit 2)', () => {
    const noPodman = run(['precheck'], { graphroot: null });
    expect(noPodman.status, noPodman.output).toBe(2);
    expect(noPodman.stdout).toContain("BAKE_RESULT=FAILED storage-headroom could not read podman's graphroot");

    const noDf = run(['precheck'], { env: { FAKE_DF_FAIL: '1' } });
    expect(noDf.status, noDf.output).toBe(2);
    expect(noDf.stdout).toContain('BAKE_RESULT=FAILED storage-headroom could not measure free space');
  });

  it('rejects a non-integer tuning value instead of comparing garbage', () => {
    const r = run(['precheck'], { env: { BAKE_MIN_FREE_GIB: '64G' } });
    expect(r.status, r.output).toBe(2);
    expect(r.output).toContain("expected a non-negative integer, got '64G'");
  });
});
