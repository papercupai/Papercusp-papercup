import { describe, it, expect } from 'vitest';
import { scanProcesses, scanProcessesAsync, deriveUserManagerRoot, defaultForeignSignature } from './scan';
import type { CgroupFs } from './cgroup-read';
import { isTerminalWindowScope } from './scope-class';

const ROOT = '/sys/fs/cgroup';
const MGR = '/user.slice/user-1000.slice/user@1000.service';
const OURS = `${MGR}/papercusp.slice`;

/** Build a fake /sys + /proc for one scan. */
function box(opts: {
  /** kernel-relative cgroup dir -> pids */
  cgroups: Record<string, number[]>;
  cmdlines?: Record<number, string>;
  /** pid -> ppid. Defaults to 1 (orphaned), which is what a CLOSED window leaves. */
  ppids?: Record<number, number>;
  selfCgroup?: string;
  bootId?: string | null;
}): CgroupFs {
  const files: Record<string, string> = {};
  const dirs = new Set<string>([ROOT]);

  for (const [rel, pids] of Object.entries(opts.cgroups)) {
    const abs = `${ROOT}${rel}`;
    // register every ancestor directory
    let acc = ROOT;
    for (const seg of rel.split('/').filter(Boolean)) {
      acc = `${acc}/${seg}`;
      dirs.add(acc);
    }
    files[`${abs}/cgroup.procs`] = pids.join('\n');
    for (const pid of pids) {
      files[`/proc/${pid}/cgroup`] = `0::${rel}\n`;
      files[`/proc/${pid}/stat`] =
        `${pid} (node) S ${opts.ppids?.[pid] ?? 1} 1 1 0 -1 0 0 0 0 0 1 2 0 0 20 0 1 0 ${1000 + pid} 0 0`;
      files[`/proc/${pid}/cmdline`] = (opts.cmdlines?.[pid] ?? `proc-${pid}`).split(' ').join('\0');
    }
  }
  if (opts.bootId !== null) files['/proc/sys/kernel/random/boot_id'] = opts.bootId ?? 'BOOTID';
  files['/proc/999/cgroup'] = `0::${opts.selfCgroup ?? `${MGR}/papercup-dev-api.service`}\n`;

  return {
    readFile: (p) => files[p] ?? null,
    isDir: (p) => dirs.has(p),
    readDir: (p) => {
      const out = new Set<string>();
      for (const d of dirs) {
        if (d.startsWith(`${p}/`)) out.add(d.slice(p.length + 1).split('/')[0]!);
      }
      return [...out];
    },
  };
}

describe('deriveUserManagerRoot', () => {
  it('derives the manager root from our own cgroup rather than assuming it', () => {
    expect(deriveUserManagerRoot(`${MGR}/papercup-dev-api.service`)).toBe(MGR);
  });

  it('returns null for a shape it does not recognise — degrade, never guess', () => {
    expect(deriveUserManagerRoot('/system.slice/papercup.service')).toBeNull();
    expect(deriveUserManagerRoot(null)).toBeNull();
  });
});

describe('scanProcessesAsync — inventory IO', () => {
  it('matches owned/foreign/window classification while yielding all kernel IO', async () => {
    const fs = box({
      cgroups: {
        [OURS]: [],
        [`${OURS}/pc-aaa111.scope`]: [10],
        [`${MGR}/app.slice/app-gnome-terminal.slice/gnome-terminal-server.service`]: [500],
        [`${MGR}/app.slice/app-gnome-terminal.slice/vte-spawn-0e0e-4a4a.scope`]: [600, 601],
      },
      cmdlines: { 601: 'node /repo/bin/agent', 600: 'bash' },
      ppids: { 600: 500, 601: 600 },
    });
    let syncReads = 0;
    const forbidden: CgroupFs = {
      readFile: () => { syncReads++; throw new Error('sync kernel read'); },
      readDir: () => { syncReads++; throw new Error('sync directory read'); },
      isDir: () => { syncReads++; throw new Error('sync stat'); },
    };
    const directoryChecks: string[] = [];
    const asyncFs = {
      readFile: async (path: string) => fs.readFile(path),
      readDir: async (path: string) => fs.readDir(path),
      readDirEntries: async (path: string) => [
        ...fs.readDir(path).map((name) => {
          const isSymbolicLink = path === `${ROOT}${MGR}` && name === 'app.slice';
          return { name, isDirectory: !isSymbolicLink, isSymbolicLink };
        }),
        { name: 'cgroup.controllers', isDirectory: false, isSymbolicLink: false },
        { name: 'cgroup.events', isDirectory: false, isSymbolicLink: false },
      ],
      isDir: async (path: string) => {
        directoryChecks.push(path);
        return fs.isDir(path);
      },
    };
    const opts = { selfPid: 999, foreignSignature: /repo/, cgroupRoot: ROOT };
    const expected = scanProcesses({ ...opts, fs });
    const actual = await scanProcessesAsync({ ...opts, fs: forbidden, asyncFs });
    expect(actual).toEqual(expected);
    expect(syncReads).toBe(0);
    expect(directoryChecks).toContain(`${ROOT}${MGR}/app.slice`);
    expect(directoryChecks.some((path) => /\/cgroup\.(controllers|events)$/.test(path))).toBe(false);
    expect(actual.processes.find((p) => p.pid === 601)?.exemptReason).toBe('human-terminal');
  });

  it('returns explicitly incomplete coverage when procfs IO never settles', async () => {
    const fs = box({ cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] } });
    const actual = await scanProcessesAsync({
      selfPid: 999,
      asyncIoDeadlineMs: 5,
      asyncFs: {
        readFile: async (path) => {
          if (path === '/proc/10/stat') return new Promise<string | null>(() => {});
          return fs.readFile(path);
        },
        readDir: async (path) => fs.readDir(path),
        isDir: async (path) => fs.isDir(path),
      },
    });

    expect(actual).toMatchObject({
      processes: [],
      ownedRootAbs: `${ROOT}${OURS}`,
      ownedRootExists: true,
      userManagerRoot: MGR,
      ownedTruncated: true,
      foreignTruncated: true,
      scanTimedOut: true,
    });
  });

  it('stops a procfs read when the async deadline returns incomplete coverage', async () => {
    const fs = box({ cgroups: {} });
    let readSignal: AbortSignal | undefined;
    let callerReturned = false;
    let readContinuedAfterReturn = false;
    let resolveReadFinished!: () => void;
    const readFinished = new Promise<void>((resolve) => { resolveReadFinished = resolve; });
    const actual = await scanProcessesAsync({
      selfPid: 999,
      asyncIoDeadlineMs: 10,
      asyncFs: {
        readFile: async (path, signal?: AbortSignal) => {
          if (path === '/proc/999/cgroup') {
            readSignal = signal;
            return new Promise<string | null>((resolve) => {
              const timer = setTimeout(() => {
                if (callerReturned) readContinuedAfterReturn = true;
                resolve(null);
                resolveReadFinished();
              }, 50);
              signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve(null);
                resolveReadFinished();
              }, { once: true });
            });
          }
          return fs.readFile(path);
        },
        readDir: async (path) => fs.readDir(path),
        isDir: async (path) => fs.isDir(path),
      },
    });
    callerReturned = true;
    await readFinished;

    expect(actual.scanTimedOut).toBe(true);
    expect(readSignal?.aborted).toBe(true);
    expect(readContinuedAfterReturn).toBe(false);
  });

  it('leaves root presence unknown when the deadline precedes cgroup discovery', async () => {
    const fs = box({ cgroups: {} });
    const actual = await scanProcessesAsync({
      selfPid: 999,
      asyncIoDeadlineMs: 5,
      asyncFs: {
        readFile: async (path) => {
          if (path === '/proc/999/cgroup') return new Promise<string | null>(() => {});
          return fs.readFile(path);
        },
        readDir: async (path) => fs.readDir(path),
        isDir: async (path) => fs.isDir(path),
      },
    });

    expect(actual).toMatchObject({
      processes: [],
      ownedRootAbs: null,
      ownedRootExists: null,
      userManagerRoot: null,
      ownedTruncated: true,
      foreignTruncated: true,
      scanTimedOut: true,
    });
  });

  it('does not block the event loop while a procfs read is pending', async () => {
    const fs = box({ cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] } });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const scan = scanProcessesAsync({
      selfPid: 999,
      asyncFs: {
        readFile: async (path) => {
          if (path === '/proc/10/stat') await pending;
          return fs.readFile(path);
        },
        readDir: async (path) => fs.readDir(path),
        isDir: async (path) => fs.isDir(path),
      },
    });
    let ticked = false;
    await new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 0));
    expect(ticked).toBe(true);
    release();
    expect((await scan).processes.map((p) => p.pid)).toEqual([10]);
  });
});

describe('scanProcesses — the owned pass', () => {
  it('finds every descendant at any depth inside our slice', () => {
    // The inheritance claim, tested: a grandchild that ended up two slices deep
    // is still enumerated by one walk of the root slice.
    const fs = box({
      cgroups: {
        [`${OURS}/papercusp-bash-job.slice/pc-aaa111.scope`]: [10, 11],
        [`${OURS}/papercusp-agent.slice/papercusp-agent-session.slice/pc-bbb222.scope`]: [20],
      },
    });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.ownedRootExists).toBe(true);
    expect(r.processes.map((p) => p.pid).sort((a, b) => a - b)).toEqual([10, 11, 20]);
    expect(r.processes.every((p) => p.owned)).toBe(true);
  });

  it('stamps each process with a kernel identity, not just a pid', () => {
    const fs = box({ cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] } });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.processes[0]!.processIdentity).toBe('linux:BOOTID:1010');
  });

  it('degrades identity to null when boot_id is unreadable, without dropping the row', () => {
    const fs = box({ cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] }, bootId: null });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.processes).toHaveLength(1);
    expect(r.processes[0]!.processIdentity).toBeNull();
  });

  it('reports ownedRootExists:false rather than silently reporting "nothing running"', () => {
    // The difference matters enormously: an empty scan on a misconfigured root
    // would otherwise read as "the box is idle" and strand every live row.
    const fs = box({ cgroups: { [`${MGR}/other.slice`]: [10] } });
    const r = scanProcesses({ fs, selfPid: 999 });
    expect(r.ownedRootExists).toBe(false);
    expect(r.processes).toHaveLength(0);
  });

  it('caps the owned result and says so', () => {
    const cgroups: Record<string, number[]> = {};
    for (let i = 0; i < 20; i++) cgroups[`${OURS}/pc-s${i}0000.scope`] = [100 + i];
    const r = scanProcesses({ fs: box({ cgroups }), selfPid: 999, maxOwnedProcesses: 5 });
    expect(r.processes).toHaveLength(5);
    expect(r.ownedTruncated).toBe(true);
    expect(r.foreignTruncated).toBe(false);
  });

  it('a busy FOREIGN population cannot starve the owned pass', () => {
    // The P-021 live-run bug: with one shared budget, 500+ signature-matching
    // foreign processes consumed the whole allowance, and the resulting
    // `truncated` flag put the reconciler into permanent degraded mode. Two
    // independent budgets, and the foreign one must be the one that gives.
    const cgroups: Record<string, number[]> = {};
    for (let i = 0; i < 50; i++) cgroups[`${MGR}/foreign-${i}.scope`] = [1000 + i];
    for (let i = 0; i < 3; i++) cgroups[`${OURS}/pc-o${i}0000.scope`] = [10 + i];
    const cmdlines: Record<number, string> = {};
    for (let i = 0; i < 50; i++) cmdlines[1000 + i] = '/srv/ws/papercusp/thing';

    const r = scanProcesses({
      fs: box({ cgroups, cmdlines }),
      selfPid: 999,
      foreignSignature: /\/srv\/ws\/papercusp/,
      maxOwnedProcesses: 4000,
      maxForeignProcesses: 5,
    });
    expect(r.processes.filter((p) => p.owned)).toHaveLength(3);
    expect(r.processes.filter((p) => !p.owned)).toHaveLength(5);
    expect(r.foreignTruncated).toBe(true);
    // The load-bearing assertion: the ledger's correctness path stays trustworthy.
    expect(r.ownedTruncated).toBe(false);
  });
});

describe('scanProcesses — the foreign pass', () => {
  it('includes an out-of-slice process ONLY when it matches the signature', () => {
    const fs = box({
      cgroups: {
        [`${OURS}/pc-aaa111.scope`]: [10],
        [`${MGR}/session-3.scope`]: [20, 21],
      },
      cmdlines: {
        20: 'node /srv/ws/papercusp/bin/thing',
        21: 'firefox',
      },
    });
    const r = scanProcesses({
      fs,
      selfPid: 999,
      foreignSignature: defaultForeignSignature('/srv/ws/papercusp'),
    });
    const foreign = r.processes.filter((p) => !p.owned);
    expect(foreign.map((p) => p.pid)).toEqual([20]);
    // firefox is not ours to look at, let alone control.
    expect(r.processes.map((p) => p.pid)).not.toContain(21);
  });

  it('scans nothing foreign when no signature is supplied', () => {
    const fs = box({
      cgroups: { [`${OURS}/pc-aaa111.scope`]: [10], [`${MGR}/session-3.scope`]: [20] },
      cmdlines: { 20: 'node /repo/thing' },
    });
    expect(scanProcesses({ fs, selfPid: 999 }).processes.map((p) => p.pid)).toEqual([10]);
  });

  it('never double-counts a process that is already owned', () => {
    const fs = box({
      cgroups: { [`${OURS}/pc-aaa111.scope`]: [10] },
      cmdlines: { 10: '/repo/thing' },
    });
    const r = scanProcesses({ fs, selfPid: 999, foreignSignature: /repo/ });
    expect(r.processes).toHaveLength(1);
    expect(r.processes[0]!.owned).toBe(true);
  });
});

describe('defaultForeignSignature', () => {
  it('anchors on the repo PATH, not a binary name', () => {
    // Matching a bare binary name is exactly the `pkill -f` mistake: it matches
    // the owner's desktop window and every peer's test instance.
    const sig = defaultForeignSignature('/srv/ws/papercusp');
    expect(sig.test('node /srv/ws/papercusp/bin/dev')).toBe(true);
    expect(sig.test('/usr/bin/papercusp-desktop')).toBe(false);
  });

  it('escapes regex metacharacters in the path', () => {
    // `+` and `.` unescaped would make this signature match paths it must not.
    const sig = defaultForeignSignature('/srv/a+b/c.d');
    expect(sig.test('/srv/a+b/c.d/x')).toBe(true);
    expect(sig.test('/srv/aab/cXd/x')).toBe(false);
  });

  it('matches a SIBLING checkout of the same workspace (EI-20476751101455367)', () => {
    // We run several checkouts side by side and REPO_ROOT names only the one the
    // operator happens to be serving from. Anchoring on that single checkout made
    // the other two structurally invisible to the foreign pass: measured on this
    // box, three idle vitest processes from `papercusp-checkpoint` holding 3,121 MB
    // while `processes:list { live:true }` reported `unaccounted: 0`.
    const sig = defaultForeignSignature('/home/u/ws/papercup-release');
    expect(sig.test('node /home/u/ws/papercusp-checkpoint/node_modules/vitest/x.mjs')).toBe(true);
    expect(sig.test('node /home/u/ws/papercusp/bin/dev')).toBe(true);
    // ...and the checkout it was handed still matches, which is the pre-existing
    // behaviour this must not regress.
    expect(sig.test('node /home/u/ws/papercup-release/apps/operator/host.mjs')).toBe(true);
  });

  it('still refuses a bare binary NAME and an unrelated workspace', () => {
    // The property that mattered is untouched: this is a PATH anchor, so widening
    // it to the workspace must not turn it into the `pkill -f` name match.
    const sig = defaultForeignSignature('/home/u/ws/papercup-release');
    expect(sig.test('/usr/bin/papercusp-desktop')).toBe(false);
    expect(sig.test('node /home/u/other-ws/papercusp/bin/dev')).toBe(false);
    // A prefix-sharing SIBLING OF THE WORKSPACE must not match either — the anchor
    // ends in `/`, so `/home/u/ws-backup/...` is outside it.
    expect(sig.test('node /home/u/ws-backup/papercusp/bin/dev')).toBe(false);
  });

  it('CONTROL: the old repo-root anchor is what this test would catch', () => {
    // A guard that has never failed is a guard nobody has tested. Rather than
    // mutating the shared tree to prove it (a sweep can commit the mutant — see
    // CLAUDE.md "Proving a guard is falsifiable"), the superseded implementation
    // lives here permanently as a control: if `defaultForeignSignature` ever
    // regresses to anchoring on the checkout, the sibling assertions above fail.
    const oldRepoRootAnchor = (repoRoot: string) =>
      new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    const old = oldRepoRootAnchor('/home/u/ws/papercup-release');
    const sibling = 'node /home/u/ws/papercusp-checkpoint/node_modules/vitest/x.mjs';
    // This FALSE is the whole bug: the gate's own leftovers could not match.
    expect(old.test(sibling)).toBe(false);
    expect(defaultForeignSignature('/home/u/ws/papercup-release').test(sibling)).toBe(true);

    // Calibration — the control is not vacuous: it still matches its OWN checkout,
    // so its `false` above is about the sibling, not a broken regex.
    expect(old.test('node /home/u/ws/papercup-release/apps/operator/host.mjs')).toBe(true);
  });

  it('falls back to the checkout when there is no containing workspace', () => {
    // Anchoring on "" or "/" would match every process on the box — the exact
    // opposite of this function's job.
    const sig = defaultForeignSignature('/papercusp');
    expect(sig.test('node /papercusp/bin/dev')).toBe(true);
    expect(sig.test('/usr/bin/node')).toBe(false);
  });
});

describe('terminal window liveness, end to end through the scan', () => {
  const TERM = `${MGR}/app.slice/app-org.gnome.Terminal.slice`;
  const SERVER = 500;
  const REPO = '/srv/ws/papercusp';
  // Hex-and-dashes, because that is what the real classifier accepts. A friendlier
  // name like `vte-spawn-closed.scope` is rejected by the regex, which silently
  // turns every assertion below into a test of the non-terminal path instead — two
  // of these read green that way before this guard existed.
  const OPEN = 'vte-spawn-0e0e-4a4a.scope';
  const CLOSED = 'vte-spawn-0d0d-4b4b.scope';

  it('uses fixture names the classifier actually recognises as windows', () => {
    expect(isTerminalWindowScope(OPEN)).toBe(true);
    expect(isTerminalWindowScope(CLOSED)).toBe(true);
  });

  /**
   * Two windows, identical in shape and both holding an agent process the foreign
   * signature matches. The ONLY difference is whether their shell is still a child
   * of the terminal application.
   */
  function twoWindows(): CgroupFs {
    return box({
      cgroups: {
        [OURS]: [],
        [`${TERM}/gnome-terminal-server.service`]: [SERVER],
        [`${TERM}/vte-spawn-0e0e-4a4a.scope`]: [600, 601],
        [`${TERM}/vte-spawn-0d0d-4b4b.scope`]: [700, 701],
      },
      cmdlines: {
        // The window shells — a bare `bash`, which the repo signature does NOT match.
        600: 'bash',
        700: 'bash',
        // The agent processes left running inside each window.
        601: `node ${REPO}/bin/agent`,
        701: `node ${REPO}/bin/agent`,
      },
      ppids: { 600: SERVER, 601: 600, 700: 1, 701: 700 },
    });
  }

  const scan = () =>
    scanProcesses({
      fs: twoWindows(),
      foreignSignature: defaultForeignSignature(REPO),
      selfPid: 999,
    });

  it('probes an owned VTE scope against the actual terminal app slice', () => {
    const ownedVteScope =
      OURS + '/papercusp-agent.slice/papercusp-agent-session.slice/vte-spawn-0e0e-4a4a.scope';
    const fs = box({
      cgroups: {
        [OURS]: [],
        [TERM + '/gnome-terminal-server.service']: [SERVER],
        [ownedVteScope]: [620],
      },
      cmdlines: { 620: 'bash --noprofile --rcfile /dev/fd/63 -i' },
      ppids: { 620: SERVER },
    });

    const shell = scanProcesses({
      fs,
      foreignSignature: defaultForeignSignature(REPO),
      selfPid: 999,
    }).processes.find((p) => p.pid === 620)!;

    expect(shell.scope).toBe('owned');
    expect(shell.terminalWindowAlive).toBe(true);
  });

  it('keeps an OPEN window exempt even though its shell is invisible to the signature', () => {
    // THE REGRESSION GUARD. The cheap-looking implementation — reuse the ppids the
    // scan already collected — cannot see pid 600 at all, because a bare `bash` does
    // not match the repo signature and so is never scanned. It would conclude the
    // window has no application child and downgrade every live window on the box.
    // Measured: 82 of 86 real window shells are exactly this bare `bash`.
    const p = scan().processes.find((x) => x.pid === 601)!;
    expect(p.scope).toBe('exempt');
    expect(p.exemptReason).toBe('human-terminal');
  });

  it('reports what a CLOSED window is still holding', () => {
    const p = scan().processes.find((x) => x.pid === 701)!;
    // P-008/D-018: its own class, so the pane can say "a window closed but these
    // kept running" rather than either "exempt" or "an escape".
    expect(p.scope).toBe('abandoned-window');
    expect(p.exemptReason).toBeNull();
  });

  it('leaves the terminal application’s own unit alone', () => {
    // It is not a window, so it is never probed and never downgraded.
    const r = scanProcesses({ fs: twoWindows(), foreignSignature: /.*/, selfPid: 999 });
    const server = r.processes.find((x) => x.pid === SERVER)!;
    expect(server.scope).toBe('exempt');
    expect(server.exemptReason).toBe('human-terminal');
  });

  it('reports a CLOSED window whose residue does not match the repo signature at all (EI-19398679054297365)', () => {
    // THE BUG. Every process in this window is a bare `bash` / `vim` — neither
    // matches the repo signature — so the signature filter used to skip both
    // pids before `classifyScope` ever ran, and a scope holding real residue
    // scanned as if it did not exist. This is the population that dominated the
    // real box: 50 of 59 processes across 14 dead-window scopes.
    const fs = box({
      cgroups: {
        [OURS]: [],
        [`${TERM}/gnome-terminal-server.service`]: [SERVER],
        [`${TERM}/vte-spawn-1a1a-2b2b.scope`]: [800, 801],
      },
      cmdlines: { 800: 'bash', 801: 'vim notes.txt' },
      // Neither pid's ppid is SERVER — the link to the terminal app is gone,
      // which is exactly what `terminalWindowAlive` reads as CLOSED.
      ppids: { 800: 1, 801: 800 },
    });
    const r = scanProcesses({ fs, foreignSignature: defaultForeignSignature(REPO), selfPid: 999 });
    const shell = r.processes.find((x) => x.pid === 800);
    const child = r.processes.find((x) => x.pid === 801);
    expect(shell?.scope).toBe('abandoned-window');
    expect(child?.scope).toBe('abandoned-window');
  });

  it('still applies the signature filter to a LIVE window with no matching process (does not flood the foreign pass)', () => {
    // The other side of the same change: an OPEN window's non-matching bash
    // shell must stay invisible to the foreign pass, exactly as before — only a
    // CONFIRMED-dead window bypasses the signature.
    const fs = box({
      cgroups: {
        [OURS]: [],
        [`${TERM}/gnome-terminal-server.service`]: [SERVER],
        [`${TERM}/vte-spawn-3c3c-4d4d.scope`]: [900],
      },
      cmdlines: { 900: 'bash' },
      ppids: { 900: SERVER },
    });
    const r = scanProcesses({ fs, foreignSignature: defaultForeignSignature(REPO), selfPid: 999 });
    expect(r.processes.find((x) => x.pid === 900)).toBeUndefined();
  });

  it('cannot tell, so stays exempt, when the application unit is unreadable', () => {
    // No identifiable application => UNKNOWN => the exemption survives. A probe
    // failure must never present the owner's live terminal as residue.
    const fs = box({
      cgroups: {
        [OURS]: [],
        [`${TERM}/vte-spawn-0d0d-4b4b.scope`]: [700, 701],
      },
      cmdlines: { 700: 'bash', 701: `node ${REPO}/bin/agent` },
      ppids: { 700: 1, 701: 700 },
    });
    const p = scanProcesses({
      fs,
      foreignSignature: defaultForeignSignature(REPO),
      selfPid: 999,
    }).processes.find((x) => x.pid === 701)!;
    expect(p.scope).toBe('exempt');
  });
});

// WI-10005782: the foreign display filter used to make an enrolled UNCONFINED task
// invisible to the reconciler. A wake executor's `claude -p --resume` turn lives
// in the operator's service cgroup and its argv carries no repo path.
describe('scanProcesses — identities the foreign pass read but did not list', () => {
  const REPO = '/srv/ws/papercusp';
  const SERVICE = `${MGR}/app.slice/papercup-dev-api.service`;
  const headlessArgv = 'claude --settings x --resume 354371bb -p --dangerously-skip-permissions';

  it('keeps an unlisted process out of the pane but records its pid → identity', () => {
    const fs = box({
      cgroups: { [SERVICE]: [810, 811] },
      cmdlines: { 810: headlessArgv, 811: `node ${REPO}/bin/hono-host.mjs` },
    });
    const r = scanProcesses({ fs, foreignSignature: defaultForeignSignature(REPO), selfPid: 999 });
    // Visibility is unchanged: the repo-less argv is still not displayed …
    expect(r.processes.map((p) => p.pid)).toEqual([811]);
    // … but the kernel fact survives for the reconciler.
    expect(r.unlistedIdentityByPid.get(810)).toBe('linux:BOOTID:1810');
    // A LISTED process is never duplicated into the unlisted map.
    expect(r.unlistedIdentityByPid.has(811)).toBe(false);
  });

  it('records nothing for an owned-slice process or our own pid', () => {
    const fs = box({
      cgroups: { [`${OURS}/pc-aaa111.scope`]: [10], [SERVICE]: [999] },
      cmdlines: { 10: headlessArgv, 999: headlessArgv },
    });
    const r = scanProcesses({ fs, foreignSignature: defaultForeignSignature(REPO), selfPid: 999 });
    expect([...r.unlistedIdentityByPid.keys()]).toEqual([]);
    expect(r.processes.map((p) => p.pid)).toEqual([10]);
  });

  it('the async scanner reports the same map as the sync one', async () => {
    const fs = box({
      cgroups: { [SERVICE]: [810, 811] },
      cmdlines: { 810: headlessArgv, 811: `node ${REPO}/bin/hono-host.mjs` },
    });
    const opts = { selfPid: 999, foreignSignature: defaultForeignSignature(REPO), cgroupRoot: ROOT };
    const asyncFs = {
      readFile: async (path: string) => fs.readFile(path),
      readDir: async (path: string) => fs.readDir(path),
      isDir: async (path: string) => fs.isDir(path),
    };
    const actual = await scanProcessesAsync({ ...opts, asyncFs });
    expect(actual.unlistedIdentityByPid.get(810)).toBe('linux:BOOTID:1810');
    expect(actual.unlistedIdentityByPid).toEqual(scanProcesses({ ...opts, fs }).unlistedIdentityByPid);
  });
});
