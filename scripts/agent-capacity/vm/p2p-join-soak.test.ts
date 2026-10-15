import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the tests at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'p2p-join-soak.sh');

// Fakes on PATH. gcloud records every ssh --command (one per line, newlines flattened) and answers
// the few the driver parses; npx stands in for gcp-rails; node for mcp-call; gh and journalctl
// for the tower side. Nothing reaches GCP, the network or the coordination server.
const FAKE_GCLOUD = String.raw`#!/usr/bin/env bash
cmd=""; for a in "$@"; do case "$a" in --command=*) cmd=$(printf '%s' "$a" | sed '1s/^--command=//') ;; esac; done
if [ "$1 $2" = "compute scp" ]; then echo "scp $*" >> "$FAKE/calls.log"; exit "$((FAKE_SCP_RC + 0))"; fi
echo "ssh $(printf '%s' "$cmd" | tr '\n' ' ')" >> "$FAKE/calls.log"
[ -t 0 ] || cat > /dev/null
case "$cmd" in
  true) exit 0 ;;
  *install-server.sh*)
    printf 'T_APT=3\nSERVER_HEALTH=ok\nSERVER_PORT=4321\nSERVER_CGROUP=/sys/fs/cgroup/fake\n'
    exit "$((FAKE_INSTALL_RC + 0))" ;;
  *"install -y -q gh git"*)
    if [ "$((FAKE_GH_MISSING + 0))" = 1 ]; then printf 'GH_ABSENT\nE: Unable to locate package gh\n'; else echo 'gh version 2.45.0 (fake)'; fi ;;
  *"gh auth login"*) [ "$((FAKE_GH_LOGIN_FAIL + 0))" = 1 ] || echo papercupai ;;
  *join-link*)
    case "$FAKE_JOIN_HTTP" in
      '' | 200) printf '{"pubkeyBase64":"ABCDEFGHIJKL","await_admission_merge":{"ok":true}}\nHTTP=200\n' ;;
      *) printf '{"error":"GitHub authentication required","code":"gh_auth_required"}\nHTTP=%s\n' "$FAKE_JOIN_HTTP" ;;
    esac ;;
  *read-routine-metadata*) printf 'ROUTINE_META slug=hello-world-3-pot routine=git-sync key=worktree_divergence rows=1 value={"paths":["d055-conflict.txt"]}\nJDIVLOG=1\n' ;;
  *"tar -C"*) printf 'TGZ' ;;
  # S8: the joiner's COMMIT of its marker "federates" into the tower's repo when sync works
  # (FAKE_S8_* knobs); FAKE_S8_JOINER_COMMIT_FAIL makes the joiner-side commit itself fail.
  *JOINER_COMMIT_RC*)
    [ "$((FAKE_S8_JOINER_COMMIT_FAIL + 0))" = 1 ] && { echo JOINER_COMMIT_RC=1; exit 0; }
    echo JOINER_COMMIT_RC=0
    f=$(printf '%s' "$cmd" | grep -oE 's8-[A-Za-z0-9_.-]+-joiner-(before|after)-revoke\.txt' | head -1)
    cross=0
    case "$f" in *before-revoke*) [ "$((FAKE_S8_CONTROL_FAIL + 0))" = 1 ] || cross=1 ;; *after-revoke*) cross=$((FAKE_S8_PUSH_AFTER + 0)) ;; esac
    [ "$cross" = 1 ] && (cd "$HIVE" && echo x > "$f" && git add "$f" && git -c user.email=t@t -c user.name=t commit -qm "$f" >/dev/null) ;;
  # The tower's marker reaches the joiner's FETCHED refs, never its worktree HEAD: that is what c1010r
  # measured (refs/hive/staging held it, HEAD did not). So only a read across all refs sees it. Any
  # S8 file NOT of this run (RUN=p2pjoin) is already in the joiner's history, as a real clone that
  # fetched earlier runs' commits is (c1011s, WI-10006907): only run-unique names can tell them apart.
  *"log --all "*"-- s8-p2pjoin-tower-before-revoke.txt"*) [ "$((FAKE_S8_CONTROL_FAIL + 0))" = 1 ] && echo 0 || echo 1 ;;
  *"log --all "*"-- s8-p2pjoin-tower-after-revoke.txt"*) echo "$((FAKE_S8_PULL_AFTER + 0))" ;;
  *"log --all "*"-- s8-"*) echo 1 ;;
esac
exit 0
`;
const FAKE_NPX = String.raw`#!/usr/bin/env bash
echo "npx $*" >> "$FAKE/calls.log"
case "$*" in *" create "*) [ "$((FAKE_CREATE_RC + 0))" -eq 0 ] || { echo "quota exceeded"; exit "$FAKE_CREATE_RC"; } ;; esac
case "$*" in *" teardown "*) echo "deleted 1 instance(s); verified: true" ;; esac
exit 0
`;
const FAKE_NODE = String.raw`#!/usr/bin/env bash
echo "node $*" >> "$FAKE/calls.log"
case "$*" in
  *revoke_contributor*) out=$FAKE_REVOKE_OUT; [ -n "$out" ] || out='{"ok": true, "live": false}'; echo "$out" ;;
  *) echo '{"status": "held"}' ;;
esac
`;
const FAKE_GH = String.raw`#!/usr/bin/env bash
case "$*" in "api user"*) [ "$((FAKE_GH_NO_ID + 0))" = 1 ] && echo "" || echo 279242982 ;; *) echo fake-token ;; esac
`;
const FAKE_JOURNALCTL = '#!/usr/bin/env bash\nexit 0\n';

describe('vm/p2p-join-soak.sh (faked gcloud, gcp-rails, mcp-call)', () => {
  let root: string;
  const hive = () => path.join(root, 'hive');
  const out = () => path.join(root, 'out');
  const calls = () => (existsSync(path.join(root, 'calls.log')) ? readFileSync(path.join(root, 'calls.log'), 'utf8') : '');
  const ssh = () => calls().split('\n').filter((l) => l.startsWith('ssh '));

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'p2p-join-soak-'));
    mkdirSync(path.join(root, 'scripts/agent-capacity/vm'), { recursive: true });
    copyFileSync(SCRIPT, path.join(root, 'scripts/agent-capacity/vm/p2p-join-soak.sh'));
    mkdirSync(path.join(root, 'bin'));
    for (const [name, body] of [
      ['gcloud', FAKE_GCLOUD], ['npx', FAKE_NPX], ['node', FAKE_NODE], ['gh', FAKE_GH], ['journalctl', FAKE_JOURNALCTL],
    ] as const) {
      writeFileSync(path.join(root, 'bin', name), body);
      chmodSync(path.join(root, 'bin', name), 0o755);
    }
    mkdirSync(hive());
    spawnSync('git', ['init', '-q', hive()]);
    writeFileSync(path.join(root, 'join-body.json'), '{"link":"fake"}');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [path.join(root, 'scripts/agent-capacity/vm/p2p-join-soak.sh')], {
      env: {
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: root,
        FAKE: root,
        DEB: 'gs://bucket/fake.deb',
        SHA: 'f'.repeat(64),
        JOIN_BODY: path.join(root, 'join-body.json'),
        HIVE: hive(),
        AGENT_CAPACITY_OUT: out(),
        OBSERVE_SEC: '3600',
        OBS_INTERVAL_SEC: '0',
        OBS_LIMIT: '6',
        SSH_RETRY_SLEEP: '0',
        SU: 'su-test',
        // The VM service user's home; overridden so no test literal names a real home directory.
        JHOME: '/srv/joiner',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('creates, installs, joins, observes OBS_LIMIT times, then pulls the logs and tears down', () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/CREATE_RC=0/);
    expect(r.out).toMatch(/JOIN_END T_JOIN=[0-9.]+ HTTP=200/);
    expect(r.out).toMatch(/JOINER_DEVICE prefix=ABCDEFGH/);
    expect(r.out.match(/^OBS n=/gm)).toHaveLength(6);
    expect(r.out).toMatch(/OBSERVE_DONE observations=6/);
    // The S6 fixes: apt waits for the dpkg lock; teardown pulls ~/.papercusp/logs before deleting.
    expect(ssh().some((c) => c.includes('apt-get -o DPkg::Lock::Timeout='))).toBe(true);
    const lines = calls().split('\n');
    const tar = lines.findIndex((l) => l.includes('tar -C /srv/joiner/.papercusp -czf - logs'));
    const teardown = lines.findIndex((l) => l.startsWith('npx tsx scripts/agent-capacity/gcp-rails.ts teardown --run=p2pjoin'));
    expect(tar).toBeGreaterThan(-1);
    expect(teardown).toBeGreaterThan(tar);
    expect(readFileSync(path.join(out(), 'joiner-logs.tgz'), 'utf8')).toBe('TGZ');
    // The joiner's convergence lines come from serve.log, not the launcher-only journal.
    expect(ssh().some((c) => c.includes('tail -n 20000 /srv/joiner/.papercusp/logs/serve.log'))).toBe(true);
  });

  it("heartbeats each side into its OWN file, never a shared one (S6's self-made conflict)", () => {
    run();
    const tower = readFileSync(path.join(hive(), 'soak-heartbeat-tower.txt'), 'utf8').trim().split('\n');
    expect(tower).toHaveLength(3); // observations 2, 4, 6
    expect(existsSync(path.join(hive(), 'soak-heartbeat.txt'))).toBe(false);
    const joiner = ssh().filter((c) => c.includes('heartbeat'));
    expect(joiner).toHaveLength(1); // observation 6
    expect(joiner[0]).toMatch(/tee -a \/srv\/joiner\/\.papercusp-workspaces\/clones\/hello-world-3-pot\/soak-heartbeat-joiner\.txt/);
  });

  it('CONFLICT_AT_OBS writes the same file with different content on both sides, then reads the joiner divergence', () => {
    const r = run({ CONFLICT_AT_OBS: '2', OBS_LIMIT: '3' });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(hive(), 'd055-conflict.txt'), 'utf8')).toMatch(/^p2pjoin tower side of the D-055 conflict /);
    const jw = ssh().filter((c) => c.includes('d055-conflict.txt') && c.includes('tee '));
    expect(jw).toHaveLength(1);
    expect(jw[0]).toMatch(/echo 'p2pjoin joiner side of the D-055 conflict .*' \| sudo -u pcsrv tee \/srv\/joiner\/\.papercusp-workspaces\/clones\/hello-world-3-pot\/d055-conflict\.txt/);
    expect(r.out).toMatch(/CONFLICT_INJECTED file=d055-conflict\.txt n=2/);
    const obs = r.out.split('\n').filter((l) => l.startsWith('OBS n='));
    expect(obs[0]).toMatch(/joinerDivergence=\[\]/); // before the conflict: not read
    expect(obs[1]).toMatch(/joinerDivergence=\[ROUTINE_META .*rows=1 value=\{"paths":\["d055-conflict\.txt"\]\} JDIVLOG=1/);
    expect(obs[2]).toMatch(/JDIVLOG=1/);
    // read under the .deb's own node, on the embedded PG port found by ss
    expect(ssh().some((c) => c.includes("sudo '/usr/lib/Papercusp Server/sidecar/bin/node' /tmp/read-routine-metadata.mjs"))).toBe(true);
  });

  it('heartbeats a held rig lock on observation 1 and releases it at teardown', () => {
    run({ RIG_LOCK: 'lock-123', OBS_LIMIT: '2' });
    const node = calls().split('\n').filter((l) => l.startsWith('node '));
    expect(node[0]).toMatch(/scripts\/mcp-call\.mjs locks:heartbeat_resource \{"lock_id":"lock-123","ttl_sec":3600\} --client su-test/);
    expect(node[node.length - 1]).toMatch(/locks:release_resource \{"lock_id":"lock-123"\}/);
  });

  it('a STOP file ends the observation early with the normal teardown', () => {
    mkdirSync(out(), { recursive: true });
    writeFileSync(path.join(out(), 'STOP'), 'rig handover to P-521');
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/EARLY_STOP n=1 reason=\[rig handover to P-521\]/);
    expect(r.out).not.toMatch(/^OBS n=/m);
    expect(r.out).toMatch(/OBSERVE_DONE observations=0/);
    expect(calls()).toMatch(/gcp-rails\.ts teardown/);
  });

  it('a failed create exits 3 and STILL runs teardown (a half-created VM bills)', () => {
    const r = run({ FAKE_CREATE_RC: '1' });
    expect(r.code).toBe(3);
    expect(calls()).toMatch(/gcp-rails\.ts teardown --run=p2pjoin/);
    expect(calls()).not.toMatch(/install-server/);
  });

  it('a failed install exits 5 after tearing down', () => {
    const r = run({ FAKE_INSTALL_RC: '7' });
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/INSTALL_RC=7/);
    expect(calls()).toMatch(/gcp-rails\.ts teardown/);
    expect(calls()).not.toMatch(/join-link/);
  });

  it('installs gh only after install-server.sh (apt lists fresh, dpkg idle) and logs its version', () => {
    const r = run({ OBS_LIMIT: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^GH gh version 2\.45\.0 \(fake\)/m);
    expect(r.out).toMatch(/^GH_LOGIN papercupai /m);
    const s = ssh();
    const server = s.findIndex((c) => c.includes('install-server.sh'));
    const gh = s.findIndex((c) => c.includes('install -y -q gh git'));
    expect(server).toBeGreaterThan(-1);
    expect(gh).toBeGreaterThan(server);
    // retried, with the package lists refreshed between attempts
    expect(s[gh]).toMatch(/for i in \$\(seq 1 12\).*sleep 10; sudo apt-get update -qq/);
  });

  // c1006j (2026-10-06): gh never landed on the VM, the join answered 401 gh_auth_required, and the
  // soak went on observing a VM with no clone. Each of these must stop BEFORE the observation loop.
  it('gh missing on the VM exits 5 with the apt error, never joins, and tears down', () => {
    const r = run({ FAKE_GH_MISSING: '1', RIG_LOCK: 'lock-9' });
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/GH_INSTALL_FAILED \[GH_ABSENT E: Unable to locate package gh/);
    expect(calls()).not.toMatch(/join-link/);
    expect(r.out).not.toMatch(/^OBS n=/m);
    expect(calls()).toMatch(/gcp-rails\.ts teardown --run=p2pjoin/);
    expect(calls()).toMatch(/locks:release_resource \{"lock_id":"lock-9"\}/);
  });

  it('a gh login that prints no login exits 6 before the join', () => {
    const r = run({ FAKE_GH_LOGIN_FAIL: '1' });
    expect(r.code).toBe(6);
    expect(r.out).toMatch(/GH_LOGIN_FAILED/);
    expect(calls()).not.toMatch(/join-link/);
    expect(calls()).toMatch(/gcp-rails\.ts teardown/);
  });

  it('a refused join (HTTP 401) exits 6 with the reply body instead of observing an empty VM', () => {
    const r = run({ FAKE_JOIN_HTTP: '401', RIG_LOCK: 'lock-9' });
    expect(r.code).toBe(6);
    expect(r.out).toMatch(/JOIN_END T_JOIN=[0-9.]+ HTTP=401/);
    expect(r.out).toMatch(/JOIN_FAILED HTTP=401 body=\[\{"error":"GitHub authentication required","code":"gh_auth_required"\}/);
    expect(r.out).not.toMatch(/^OBS n=/m);
    expect(r.out).not.toMatch(/OBSERVE_DONE/);
    expect(calls()).toMatch(/gcp-rails\.ts teardown --run=p2pjoin/);
    expect(calls()).toMatch(/locks:release_resource \{"lock_id":"lock-9"\}/);
  });

  it('refuses missing inputs (exit 2) before touching GCP', () => {
    expect(run({ DEB: '' }).code).toBe(2);
    expect(run({ JOIN_BODY: path.join(root, 'nope.json') }).code).toBe(2);
    expect(run({ HIVE: path.join(root, 'not-a-repo') }).code).toBe(2);
    expect(run({ CONFLICT_AT_OBS: 'soon' }).code).toBe(2);
    expect(run({ REVOKE: 'yes' }).code).toBe(2);
    // An unresolved D-055 conflict parks the joiner, which would read as a successful revoke.
    expect(run({ REVOKE: '1', CONFLICT_AT_OBS: '2' }).code).toBe(2);
    expect(calls()).toBe('');
  });

  // S8 (WI-10004393): revoke ONLY the joiner's device, then prove it can no longer push or pull.
  describe('REVOKE=1 (S8)', () => {
    const s8 = (env: Record<string, string> = {}) =>
      run({ REVOKE: '1', OBS_LIMIT: '1', REVOKE_WAIT_SEC: '1', S8_POLL_SEC: '0', S8_COMMIT_RETRY_SEC: '0', ...env });
    const nodeCalls = () => calls().split('\n').filter((l) => l.startsWith('node '));
    const commitInHive = (file: string) => {
      writeFileSync(path.join(hive(), file), 'earlier run\n');
      spawnSync('git', ['-C', hive(), 'add', file]);
      spawnSync('git', ['-C', hive(), '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', file]);
    };
    const hiveHas = (file: string) =>
      spawnSync('git', ['-C', hive(), 'log', '--oneline', '-1', '--', file], { encoding: 'utf8' }).stdout.trim() !== '';

    it('control crosses, the joiner device alone is revoked on the given operator, nothing crosses after: revoked', () => {
      const r = s8();
      expect(r.code).toBe(0);
      // Both sides COMMIT their own run-unique file before the crossing window opens.
      expect(r.out).toMatch(/S8_COMMITTED tag=before-revoke tower=1 joiner=1/);
      expect(hiveHas('s8-p2pjoin-tower-before-revoke.txt')).toBe(true);
      expect(ssh().some((l) => l.includes('commit -qm') && l.includes('s8-p2pjoin-joiner-before-revoke.txt'))).toBe(true);
      expect(r.out).toMatch(/S8_EXCHANGE tag=before-revoke waited=0s joinerPushed=1 joinerPulled=1/);
      const revoke = nodeCalls().filter((l) => l.includes('revoke_contributor'));
      expect(revoke).toHaveLength(1);
      // --harness <pot> is load-bearing: without it the operator refuses the call with
      // harness_forbidden (the pot is outside the calling session's own hive), measured live
      // 2026-10-06 against :3170.
      expect(revoke[0]).toContain(
        'scripts/mcp-call.mjs substrate:revoke_contributor {"workspaceId":"papercusp-workspace","potSlug":"hello-world-3-pot","githubUserId":279242982,"devicePubkey":"ABCDEFGHIJKL"} --client su-test --harness hello-world-3-pot --port 3170',
      );
      expect(r.out).toMatch(/S8_REVOKE rc=0 device=ABCDEFGH "ok":true "live":false/);
      expect(r.out).toMatch(/S8_EXCHANGE tag=after-revoke waited=0s joinerPushed=0 joinerPulled=0/);
      expect(r.out).toMatch(/S8_RESULT verdict=revoked control=ok pushBlocked=1 pullBlocked=1/);
      // The S8 phase runs before teardown deletes the VM.
      const lines = calls().split('\n');
      const rev = lines.findIndex((l) => l.includes('revoke_contributor'));
      expect(rev).toBeGreaterThan(-1);
      expect(lines.findIndex((l) => l.includes('gcp-rails.ts teardown'))).toBeGreaterThan(rev);
    });

    it('a joiner commit still reaching the tower after the revoke is NOT-REVOKED (push not blocked)', () => {
      const r = s8({ FAKE_S8_PUSH_AFTER: '1' });
      expect(r.out).toMatch(/S8_RESULT verdict=NOT-REVOKED control=ok pushBlocked=0 pullBlocked=1/);
    });

    it('a tower commit still reaching the joiner after the revoke is NOT-REVOKED (pull not blocked)', () => {
      const r = s8({ FAKE_S8_PULL_AFTER: '1' });
      expect(r.out).toMatch(/S8_RESULT verdict=NOT-REVOKED control=ok pushBlocked=1 pullBlocked=0/);
    });

    it('when the before-revoke markers do not cross, the result is inconclusive, never revoked', () => {
      const r = s8({ FAKE_S8_CONTROL_FAIL: '1' });
      expect(r.out).toMatch(/S8_EXCHANGE tag=before-revoke waited=0s joinerPushed=0 joinerPulled=0/);
      expect(r.out).toMatch(/S8_RESULT verdict=inconclusive control=failed/);
      expect(r.out).not.toMatch(/verdict=revoked/);
    });

    it("an EARLIER run's S8 files in both histories never count as a crossing (c1011s, WI-10006907)", () => {
      // The tower hive holds the fixed-name and another run's files, as it did after c1010r; the
      // fake joiner holds every non-p2pjoin S8 path in its fetched history. Nothing of THIS run
      // crosses, so the only honest verdict is inconclusive, never revoked or NOT-REVOKED.
      for (const f of ['s8-joiner-before-revoke.txt', 's8-joiner-after-revoke.txt', 's8-c1010r-joiner-before-revoke.txt']) {
        commitInHive(f);
      }
      const r = s8({ FAKE_S8_CONTROL_FAIL: '1' });
      expect(r.out).toMatch(/S8_EXCHANGE tag=before-revoke waited=0s joinerPushed=0 joinerPulled=0/);
      expect(r.out).toMatch(/S8_RESULT verdict=inconclusive control=failed pushBlocked=1 pullBlocked=1/);
    });

    it('a joiner-side commit that fails is not measured: inconclusive control=not-committed', () => {
      const r = s8({ FAKE_S8_JOINER_COMMIT_FAIL: '1' });
      expect(r.out).toMatch(/S8_COMMITTED tag=before-revoke tower=1 joiner=0/);
      expect(r.out).toMatch(/S8_EXCHANGE tag=before-revoke waited=0s joinerPushed=0 joinerPulled=0 not-measured=commit-failed/);
      expect(r.out).toMatch(/S8_RESULT verdict=inconclusive control=not-committed/);
      expect(r.out).not.toMatch(/verdict=(revoked|NOT-REVOKED)/);
    });

    it('a reused RUN name is refused before anything is revoked', () => {
      commitInHive('s8-p2pjoin-tower-before-revoke.txt');
      const r = s8();
      expect(r.out).toMatch(/S8_RESULT verdict=not-run reason=run-name-reused/);
      expect(nodeCalls().some((l) => l.includes('revoke_contributor'))).toBe(false);
      expect(calls()).toMatch(/gcp-rails\.ts teardown/);
    });

    it('a refused revoke stops S8 before the after-revoke exchange', () => {
      const r = s8({ FAKE_REVOKE_OUT: '{"ok": false, "code": "self_device"}' });
      expect(r.out).toMatch(/S8_REVOKE rc=0 device=ABCDEFGH "ok":false "code":"self_device"/);
      expect(r.out).toMatch(/S8_RESULT verdict=revoke-failed control=ok/);
      expect(r.out).not.toMatch(/tag=after-revoke/);
      expect(calls()).toMatch(/gcp-rails\.ts teardown/);
    });

    it('no numeric GitHub id: the revoke is not sent', () => {
      const r = s8({ FAKE_GH_NO_ID: '1' });
      expect(r.out).toMatch(/S8_RESULT verdict=revoke-failed control=ok reason=no-numeric-gh-id/);
      expect(nodeCalls().some((l) => l.includes('revoke_contributor'))).toBe(false);
    });

    it('without REVOKE nothing is revoked and no S8 lines are written', () => {
      const r = run({ OBS_LIMIT: '1' });
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/S8_/);
      expect(nodeCalls().some((l) => l.includes('revoke_contributor'))).toBe(false);
    });
  });
});
