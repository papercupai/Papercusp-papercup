/**
 * backend-bin-resolve.test.ts — WI-37920, plan
 * agent-launch-verification-and-spawn-env-2026-08-11 (P-001, P-005).
 *
 * THE CLASS THIS PINS: "a backend CLI that IS installed cannot be launched, but
 * only from inside a desktop-spawned terminal".
 *
 * The trap this suite is shaped around: DETECTION and EXECUTION are separate
 * layers, and the detection-only test passes while the window is dead. `omp` ships
 * as `#!/usr/bin/env bun`, so finding `omp` proves nothing — the kernel then runs
 * `/usr/bin/env bun`, which searches the SPAWNED PATH, which is exactly the PATH
 * missing `~/.bun/bin`. That is why the last case here EXECUTES the emitted PATH
 * line under a stripped environment instead of asserting on strings.
 *
 * Run: npm run test:file -- packages/operator-core/lib/backend-bin-resolve.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';

import {
  backendBinOverrideEnvKey,
  backendSearchDirs,
  decodeSpawnPathDirs,
  encodeSpawnPathDirs,
  executableNames,
  preflightBackendLaunch,
  readShebangInterpreter,
  resolveBackendLaunch,
  resolveOnPath,
  resolveSpawnPathDirs,
  wellKnownBackendBin,
} from './backend-bin-resolve.mjs';
import { buildPathExport } from './console-spawn';

/**
 * A desktop-session PATH, verbatim in shape: what gnome-terminal-server actually
 * hands a command. No ~/.bun, no ~/.local/bin, no brew — the whole point.
 */
const DESKTOP_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

let home: string;
const made: string[] = [];

/** Create an executable at ~/<rel>, with optional shebang. Returns its abs path. */
function installBin(rel: string, body = '#!/bin/sh\nexit 0\n'): string {
  const p = join(home, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, { mode: 0o755 });
  made.push(p);
  return p;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'backend-bin-resolve-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// ── P-005: the per-platform install-location table ──────────────────────────
//
// Every row is a place a backend legitimately lands that a login-but-NON-interactive
// shell cannot be relied on to have on PATH (the rc-file early-return, or a desktop
// session env that never sourced anything). Adding a backend or an installer means
// adding a row — that is the point of the table.
const INSTALL_LOCATIONS: ReadonlyArray<{
  agent: string;
  installer: string;
  rel: string;
  platform: NodeJS.Platform;
}> = [
  { agent: 'omp', installer: 'bun add -g', rel: '.bun/bin/omp', platform: 'linux' },
  { agent: 'omp', installer: 'papercusp setup', rel: '.papercusp/bin/omp', platform: 'linux' },
  { agent: 'omp', installer: 'cargo install', rel: '.cargo/bin/omp', platform: 'linux' },
  { agent: 'claude', installer: 'native installer', rel: '.local/bin/claude', platform: 'linux' },
  { agent: 'claude', installer: 'claude migrate-installer', rel: '.claude/bin/claude', platform: 'linux' },
  { agent: 'codex', installer: 'npm -g', rel: '.npm-global/bin/codex', platform: 'linux' },
  { agent: 'codex', installer: 'yarn global', rel: '.yarn/bin/codex', platform: 'linux' },
  { agent: 'codex', installer: 'volta install', rel: '.volta/bin/codex', platform: 'linux' },
  { agent: 'codex', installer: 'deno install', rel: '.deno/bin/codex', platform: 'linux' },
  { agent: 'claude', installer: 'papercusp runtime', rel: '.papercusp/runtime/node_modules/.bin/claude', platform: 'linux' },
  // nvm/fnm: `npm i -g` lands in a VERSION dir, and the PATH entry exposing it is
  // added by the same rc-file block the non-interactive early-return skips.
  { agent: 'codex', installer: 'npm -g under nvm', rel: '.nvm/versions/node/v22.11.0/bin/codex', platform: 'linux' },
  { agent: 'codex', installer: 'npm -g under fnm', rel: '.local/share/fnm/node-versions/v20.9.0/installation/bin/codex', platform: 'linux' },
  // macOS: a login shell that never ran `brew shellenv` has no /opt/homebrew/bin —
  // the Apple-Silicon twin of the ~/.bun/bin miss.
  { agent: 'omp', installer: 'bun add -g (macOS)', rel: '.bun/bin/omp', platform: 'darwin' },
  // Windows: %USERPROFILE%-rooted, resolved via the same well-known list.
  { agent: 'omp', installer: 'bun add -g (Windows)', rel: '.bun/bin/omp.exe', platform: 'win32' },
  { agent: 'claude', installer: 'papercusp setup (Windows)', rel: '.papercusp/bin/claude.cmd', platform: 'win32' },
];

describe('wellKnownBackendBin — PATH-independent detection, every platform (P-005)', () => {
  it.each(INSTALL_LOCATIONS)(
    'finds $agent installed by "$installer" at ~/$rel on $platform with a desktop PATH',
    ({ agent, rel, platform }) => {
      // A FRESH home per row. Sharing one would let an earlier row's install
      // satisfy a later row via a higher-precedence root — every case would pass
      // while proving only that the FIRST location works.
      const rowHome = mkdtempSync(join(tmpdir(), 'backend-row-'));
      try {
        const bin = join(rowHome, rel);
        mkdirSync(dirname(bin), { recursive: true });
        writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const env =
          platform === 'win32'
            ? { PATH: 'C:\\Windows\\system32', USERPROFILE: rowHome, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
            : { PATH: DESKTOP_PATH };

        const found = wellKnownBackendBin(agent, { home: rowHome, env, platform });

        expect(
          found,
          `${agent} installed at ~/${rel} must be detectable without PATH — otherwise psu ` +
            `aborts with "the ${agent} backend is not installed" inside every desktop-spawned ` +
            `terminal, while the same binary works fine in the user's interactive shell.`,
        ).toBe(bin);
      } finally {
        rmSync(rowHome, { recursive: true, force: true });
      }
    },
  );

  it('returns null for a backend that genuinely is not installed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'backend-bin-resolve-empty-'));
    try {
      // win32 so the search set is %USERPROFILE%-rooted only: the POSIX list ends
      // in real system-wide prefixes (/usr/local/bin, brew) that exist on the CI
      // box, so a "nothing is installed" case can never be staged there. Asserting
      // an empty result on linux would be asserting the CI box's contents.
      expect(wellKnownBackendBin('omp', { home: empty, env: { USERPROFILE: empty }, platform: 'win32' })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('lists /opt/homebrew/bin on darwin and NOT on linux (Apple-Silicon prefix)', () => {
    expect(backendSearchDirs({ home, env: {}, platform: 'darwin' })).toContain('/opt/homebrew/bin');
    expect(backendSearchDirs({ home, env: {}, platform: 'linux' })).not.toContain('/opt/homebrew/bin');
  });

  it('roots the Windows list at %USERPROFILE%, not at a POSIX home', () => {
    const dirs = backendSearchDirs({
      home: '/should/not/be/used',
      env: { USERPROFILE: 'C:\\Users\\avi', APPDATA: 'C:\\Users\\avi\\AppData\\Roaming' },
      platform: 'win32',
    });
    expect(dirs.some((d) => d.includes('Users'))).toBe(true);
    expect(dirs.some((d) => d.startsWith('/should/not/be/used'))).toBe(false);
    expect(dirs).toContain(join('C:\\Users\\avi\\AppData\\Roaming', 'npm'));
  });

  it('never lists /usr/bin — every login shell already has it, so listing it is only noise', () => {
    expect(backendSearchDirs({ home, env: {}, platform: 'linux' })).not.toContain('/usr/bin');
  });
});

describe('executableNames — win32 needs PATHEXT, POSIX does not (P-005)', () => {
  it('is the bare name on POSIX', () => {
    expect(executableNames('omp', { env: {}, platform: 'linux' })).toEqual(['omp']);
  });

  it('honors PATHEXT on win32, both cases, bare name first', () => {
    const names = executableNames('omp', { env: { PATHEXT: '.EXE;.CMD' }, platform: 'win32' });
    expect(names[0]).toBe('omp');
    expect(names).toContain('omp.exe');
    expect(names).toContain('omp.EXE');
    expect(names).toContain('omp.cmd');
    expect(new Set(names).size).toBe(names.length); // deduped
  });
});

describe('native backends skip psu entrypoints', () => {
  it.each(['claude', 'codex', 'omp'])('executes the native %s behind a packaged launcher on PATH', (agent) => {
    const root = mkdtempSync(join(tmpdir(), 'backend-launcher-'));
    try {
      const wrapperDir = join(root, 'sidecar', 'bin');
      const nativeDir = join(root, 'native');
      mkdirSync(wrapperDir, { recursive: true });
      mkdirSync(nativeDir, { recursive: true });
      const wrapper = join(wrapperDir, agent);
      writeFileSync(wrapper, '#!/bin/sh\nexec "$BIN/node" "$ROOT/scripts/psu.mjs" "--agent=$BACKEND" "$@"\n', { mode: 0o755 });
      const native = join(nativeDir, agent);
      writeFileSync(native, '#!/bin/sh\nprintf native-backend\n', { mode: 0o755 });
      const env = { PATH: [wrapperDir, nativeDir, DESKTOP_PATH].join(delimiter) };
      const resolved = resolveBackendLaunch(agent, { home: root, env });
      expect(resolved?.bin).toBe(native);
      expect(execFileSync(resolved!.bin, ['--version'], { env, encoding: 'utf8' })).toBe('native-backend');
      symlinkSync(wrapper, join(root, agent));
      expect(resolveOnPath(agent, { env: { PATH: [root, nativeDir].join(delimiter) } })).toBe(native);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips launcher wrappers in well-known install locations too', () => {
    const root = mkdtempSync(join(tmpdir(), 'backend-launcher-fallback-'));
    try {
      for (const dir of ['.local/bin', '.papercusp/bin']) mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, '.local/bin/codex'), '#!/bin/sh\nexec node psu-launcher.mjs --agent=codex "$@"\n');
      const native = join(root, '.papercusp/bin/codex');
      writeFileSync(native, '#!/bin/sh\nexit 0\n');
      expect(wellKnownBackendBin('codex', { home: root, env: { PATH: '' } })).toBe(native);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports no installed backend when Windows install candidates are only psu wrappers', () => {
    const root = mkdtempSync(join(tmpdir(), 'backend-launcher-only-'));
    try {
      mkdirSync(join(root, '.papercusp/bin'), { recursive: true });
      writeFileSync(join(root, '.papercusp/bin/codex.cmd'), '@echo off\r\nnode "%ROOT%\\scripts\\psu.mjs" --agent=codex %*\r\n');
      expect(resolveBackendLaunch('codex', { home: root, platform: 'win32', env: { PATH: '', USERPROFILE: root } })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readShebangInterpreter — the EXECUTION layer detection cannot see', () => {
  it.each([
    ['#!/usr/bin/env bun\n', 'bun'],
    ['#!/usr/bin/env -S bun run\n', 'bun'],
    ['#!/usr/bin/env NODE_ENV=production node\n', 'node'],
    ['#!/usr/local/bin/python3 -u\n', '/usr/local/bin/python3'],
    ['#!/bin/sh\n', '/bin/sh'],
  ])('parses %j → %s', (body, expected) => {
    const p = installBin(`shebang/${Math.random().toString(36).slice(2)}`, body);
    expect(readShebangInterpreter(p, { platform: 'linux' })).toBe(expected);
  });

  it('returns null for a binary with no shebang', () => {
    const p = installBin('shebang/elf', '\x7fELF\x02\x01\x01');
    expect(readShebangInterpreter(p, { platform: 'linux' })).toBeNull();
  });

  it('returns null on win32 — the Windows loader does not honor a shebang', () => {
    const p = installBin('shebang/win', '#!/usr/bin/env bun\n');
    expect(readShebangInterpreter(p, { platform: 'win32' })).toBeNull();
  });

  it('returns null for an unreadable path instead of throwing', () => {
    expect(readShebangInterpreter(join(home, 'nope/nothing'), { platform: 'linux' })).toBeNull();
  });
});

describe('resolveSpawnPathDirs — the dirs a spawned window needs (P-001)', () => {
  it("injects the INTERPRETER's dir too, not just the backend's", () => {
    const ihome = mkdtempSync(join(tmpdir(), 'backend-interp-'));
    try {
      // omp in ~/.bun/bin with a `#!/usr/bin/env bun` shebang — the measured shape.
      // bun deliberately lives ELSEWHERE, so a fix that only injects dirname(omp)
      // leaves the window unable to execute it.
      mkdirSync(join(ihome, '.bun/bin'), { recursive: true });
      mkdirSync(join(ihome, '.local/bin'), { recursive: true });
      writeFileSync(join(ihome, '.bun/bin/omp'), '#!/usr/bin/env bun\n', { mode: 0o755 });
      writeFileSync(join(ihome, '.local/bin/bun'), '#!/bin/sh\n', { mode: 0o755 });

      const r = resolveSpawnPathDirs({
        home: ihome,
        env: { PATH: DESKTOP_PATH },
        platform: 'linux',
        agents: ['omp'],
      });

      expect(r.dirs).toContain(join(ihome, '.bun/bin'));
      expect(
        r.dirs,
        "the shebang interpreter's dir must be injected too — `omp` is #!/usr/bin/env bun, " +
          'so a PATH that resolves omp but not bun produces a window that dies in `env`, ' +
          'with a green detection test.',
      ).toContain(join(ihome, '.local/bin'));
      expect(r.resolved[0].interpreterMissing).toBe(false);
    } finally {
      rmSync(ihome, { recursive: true, force: true });
    }
  });

  it('flags interpreterMissing when the shebang names something unresolvable', () => {
    const ihome = mkdtempSync(join(tmpdir(), 'backend-interp-missing-'));
    try {
      mkdirSync(join(ihome, '.bun/bin'), { recursive: true });
      writeFileSync(join(ihome, '.bun/bin/omp'), '#!/usr/bin/env definitely-not-installed\n', { mode: 0o755 });
      const r = resolveBackendLaunch('omp', { home: ihome, env: { PATH: '' }, platform: 'linux' });
      expect(r?.interpreter).toBe('definitely-not-installed');
      expect(r?.interpreterMissing).toBe(true);
    } finally {
      rmSync(ihome, { recursive: true, force: true });
    }
  });

  it('reports a backend it cannot find as missing rather than inventing a dir', () => {
    const empty = mkdtempSync(join(tmpdir(), 'backend-none-'));
    try {
      // win32 for the same reason as above: its search set is %USERPROFILE%-rooted,
      // so "nothing installed" is stageable. On linux the list ends in real
      // system-wide prefixes and this box genuinely has a brew-installed codex —
      // finding it is CORRECT behaviour, so asserting [] there would assert the
      // box's contents, not the resolver's.
      const r = resolveSpawnPathDirs({ home: empty, env: { USERPROFILE: empty }, platform: 'win32' });
      expect(r.dirs).toEqual([]);
      expect(r.missing).toEqual(['claude', 'codex', 'omp']);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('injects the dir even when the OPERATOR resolved the bin on ITS OWN PATH', () => {
    // The conflation that caused the bug: "it's on PATH" is a fact about the
    // OPERATOR's PATH, and says nothing about the window's. onPath must not
    // suppress the injection.
    const ihome = mkdtempSync(join(tmpdir(), 'backend-onpath-'));
    try {
      const dir = join(ihome, 'operator-only/bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'omp'), '#!/bin/sh\n', { mode: 0o755 });
      const r = resolveSpawnPathDirs({
        home: ihome,
        env: { PATH: dir }, // operator sees it…
        platform: 'linux',
        agents: ['omp'],
      });
      expect(r.resolved[0].onPath).toBe(true);
      expect(r.dirs, 'a bin on the OPERATOR PATH still needs its dir injected — the window has a different PATH').toContain(dir);
    } finally {
      rmSync(ihome, { recursive: true, force: true });
    }
  });
});

describe('resolveOnPath — pure node, no `which` subprocess (cross-platform contract)', () => {
  it('resolves against a PATH string using the platform delimiter', () => {
    const dir = join(home, 'onpath/bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'thing'), '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveOnPath('thing', { env: { PATH: `${DESKTOP_PATH}${delimiter}${dir}` }, platform: 'linux' })).toBe(
      join(dir, 'thing'),
    );
  });

  it('returns null for an empty PATH instead of falling back to cwd', () => {
    expect(resolveOnPath('thing', { env: { PATH: '' }, platform: 'linux' })).toBeNull();
  });
});

describe('encode/decodeSpawnPathDirs', () => {
  it('round-trips', () => {
    const dirs = ['/a/b', '/c/d'];
    expect(decodeSpawnPathDirs(encodeSpawnPathDirs(dirs))).toEqual(dirs);
  });

  it('does NOT shred a Windows absolute path (a `[:;]` split would)', () => {
    // The naive permissive split turns C:\Users\avi\.bun\bin into ['C', '\\Users…'] —
    // breaking exactly the platform it was written to accommodate.
    expect(decodeSpawnPathDirs('C:\\Users\\avi\\.bun\\bin', { pathDelimiter: ';' })).toEqual([
      'C:\\Users\\avi\\.bun\\bin',
    ]);
  });

  it('treats an absent value as no dirs', () => {
    expect(decodeSpawnPathDirs(undefined)).toEqual([]);
    expect(decodeSpawnPathDirs('')).toEqual([]);
  });
});

// ── P-002: the preflight, and the false-negative trap it exists to dodge ─────
describe('preflightBackendLaunch — check the env the WINDOW gets, not the operator\'s', () => {
  const envWith = (dirs: string[]) => ({ PAPERCUSP_BACKEND_PATH_DIRS: dirs.join(delimiter) });

  it('IGNORES the operator PATH — a probe that inherits it is the false negative', () => {
    // THE TRAP THIS CASE PINS. A check run from the operator (process.env.PATH, a
    // `which`, a capability:bash probe) inherits the environment that does NOT
    // have the defect, so it reports green while the window dies. Here the backend
    // sits on the OPERATOR's PATH and is injected NOWHERE — the preflight must
    // still fail, because the window would never see it.
    const ohome = mkdtempSync(join(tmpdir(), 'preflight-operator-path-'));
    try {
      const dir = join(ohome, 'operator-only/bin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'omp'), '#!/bin/sh\n', { mode: 0o755 });

      const pre = preflightBackendLaunch('omp', {}, { home: ohome, env: { PATH: dir }, platform: 'linux' });

      expect(pre.ok, 'a backend visible only on the OPERATOR PATH must NOT pass the preflight').toBe(false);
      if (pre.ok) return;
      expect(pre.reason).toBe('resolved-but-not-injected');
      expect(pre.diagnosis, 'a defect in OUR injection must not be reported to the user as a missing install').toMatch(
        /OUR bug|not a missing install/i,
      );
      expect(pre.foundOffPath).toBe(join(dir, 'omp'));
    } finally {
      rmSync(ohome, { recursive: true, force: true });
    }
  });

  it('passes when the injected dirs alone can resolve the backend AND its interpreter', () => {
    const ihome = mkdtempSync(join(tmpdir(), 'preflight-ok-'));
    try {
      const bunDir = join(ihome, '.bun/bin');
      const interpDir = join(ihome, 'interp');
      mkdirSync(bunDir, { recursive: true });
      mkdirSync(interpDir, { recursive: true });
      writeFileSync(join(bunDir, 'omp'), '#!/usr/bin/env bun\n', { mode: 0o755 });
      writeFileSync(join(interpDir, 'bun'), '#!/bin/sh\n', { mode: 0o755 });

      const pre = preflightBackendLaunch('omp', envWith([bunDir, interpDir]), {
        home: ihome,
        env: { PATH: '' },
        platform: 'linux',
      });
      expect(pre.ok).toBe(true);
      if (!pre.ok) return;
      expect(pre.interpreter).toBe('bun');
    } finally {
      rmSync(ihome, { recursive: true, force: true });
    }
  });

  it('FAILS when the bin resolves but its shebang interpreter does not', () => {
    // The half-fix that ships green: `omp` is findable, and the window still dies
    // inside `env`. A detection-only preflight calls this a pass.
    const ihome = mkdtempSync(join(tmpdir(), 'preflight-interp-'));
    try {
      const bunDir = join(ihome, '.bun/bin');
      mkdirSync(bunDir, { recursive: true });
      writeFileSync(join(bunDir, 'omp'), '#!/usr/bin/env nowhere-bun\n', { mode: 0o755 });

      const pre = preflightBackendLaunch('omp', envWith([bunDir]), {
        home: ihome,
        env: { PATH: '' },
        platform: 'linux',
      });
      expect(pre.ok).toBe(false);
      if (pre.ok) return;
      expect(pre.reason).toBe('interpreter-unreachable');
      expect(pre.diagnosis).toMatch(/interpreter/i);
      expect(pre.diagnosis, 'the diagnosis must say the failure happens in `env`, not at the command').toMatch(
        /inside `env`/,
      );
    } finally {
      rmSync(ihome, { recursive: true, force: true });
    }
  });

  it('reports a genuinely-absent backend as not-installed, with what it probed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'preflight-missing-'));
    try {
      const pre = preflightBackendLaunch('omp', {}, { home: empty, env: { USERPROFILE: empty }, platform: 'win32' });
      expect(pre.ok).toBe(false);
      if (pre.ok) return;
      expect(pre.reason).toBe('not-installed');
      expect(pre.diagnosis).toMatch(/papercusp setup/);
      expect(pre.diagnosis, 'the diagnosis must list what it searched so the answer is checkable').toMatch(
        /probed|guaranteed/i,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('explains WHY the spawned env differs, so the reader can act on it', () => {
    const empty = mkdtempSync(join(tmpdir(), 'preflight-why-'));
    try {
      const pre = preflightBackendLaunch('omp', {}, { home: empty, env: { USERPROFILE: empty }, platform: 'win32' });
      if (pre.ok) throw new Error('expected a failure');
      // The two mechanisms an operator has to know to act on this at all: the
      // desktop-session env swap, and the non-interactive rc-file early-return.
      expect(pre.diagnosis).toMatch(/does not inherit the operator's environment/);
      expect(pre.diagnosis).toMatch(/non-interactive/i);
      expect(pre.diagnosis).toMatch(/bashrc/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── The falsifier: EXECUTE the emitted PATH line ─────────────────────────────
//
// Every assertion above is about strings and stat() calls. The original defect
// survived a suite exactly like that, because the thing that was broken was
// whether the resulting environment could RUN the binary. This case builds the
// real prelude line and runs it under a stripped env with a shebang'd fake
// backend whose interpreter lives in a third directory.
describe.skipIf(process.platform === 'win32')(
  'the emitted PATH export actually EXECUTES a shebang-ed backend (WI-37920 falsifier)',
  () => {
    let root: string;
    let backendDir: string;
    let interpDir: string;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), 'spawn-path-exec-'));
      backendDir = join(root, 'bun-bin');
      interpDir = join(root, 'interp-bin');
      mkdirSync(backendDir, { recursive: true });
      mkdirSync(interpDir, { recursive: true });
      // `fakeomp` is a shebang script whose interpreter (`fakebun`) is in a
      // DIFFERENT directory — the exact shape of omp → /usr/bin/env bun.
      writeFileSync(join(backendDir, 'fakeomp'), '#!/usr/bin/env fakebun\n', { mode: 0o755 });
      writeFileSync(join(interpDir, 'fakebun'), '#!/bin/sh\necho FAKEBUN-RAN\n', { mode: 0o755 });
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** Run `<pathExport>; fakeomp` in a login-but-non-interactive shell with a
     *  desktop-shaped PATH — i.e. the env the window really gets. */
    function runUnderSpawnedEnv(pathExport: string | null): string {
      const script = `${pathExport ? `${pathExport}; ` : ''}fakeomp`;
      return execFileSync('/bin/sh', ['-c', script], {
        encoding: 'utf8',
        env: { PATH: DESKTOP_PATH },
        timeout: 30_000,
        killSignal: 'SIGKILL',
      }).trim();
    }

    it('CONTROL: without the injection the backend is unreachable', () => {
      // Falsifiability: if this ever passes, the case below proves nothing.
      expect(() => runUnderSpawnedEnv(null)).toThrow();
    });

    it('with the injection, the backend runs AND its interpreter resolves', () => {
      const resolved = resolveSpawnPathDirs({
        home: root,
        env: { PATH: DESKTOP_PATH },
        platform: 'linux',
        agents: ['fakeomp'],
        // The fake backend lives outside the well-known roots, so hand the
        // resolver a PATH that sees it — this asserts the INJECTION, which is the
        // subject; the well-known roots are covered by the table above.
      });
      // The resolver found nothing (fakeomp isn't a well-known layout), so build
      // the env the way buildConsoleEnvelope does, from the dirs we know.
      expect(resolved.missing).toContain('fakeomp');

      const pathExport = buildPathExport({
        PAPERCUSP_BACKEND_PATH_DIRS: [backendDir, interpDir].join(delimiter),
      });

      expect(runUnderSpawnedEnv(pathExport)).toBe('FAKEBUN-RAN');
    });

    it('injecting ONLY the backend dir is not enough — the shebang layer still fails', () => {
      // This is the half-fix that ships green: `fakeomp` is now findable, and the
      // window still dies, because /usr/bin/env cannot find `fakebun`.
      const halfFix = buildPathExport({ PAPERCUSP_BACKEND_PATH_DIRS: backendDir });
      expect(() => runUnderSpawnedEnv(halfFix)).toThrow();
    });
  },
);

describe('per-launch backend override (benchmark-coverage-frontierswe-v2 D-026)', () => {
  let root: string;
  let pathDir: string;
  let wrapper: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'backend-override-'));
    pathDir = join(root, 'path-bin');
    mkdirSync(pathDir, { recursive: true });
    writeFileSync(join(pathDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    wrapper = join(root, 'cexec', 'codex');
    mkdirSync(dirname(wrapper), { recursive: true });
    writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('names one key per agent', () => {
    expect(backendBinOverrideEnvKey('codex')).toBe('PAPERCUSP_BACKEND_BIN_CODEX');
    expect(backendBinOverrideEnvKey('claude')).toBe('PAPERCUSP_BACKEND_BIN_CLAUDE');
  });

  it('a set override wins over a codex that PATH would find', () => {
    const r = resolveBackendLaunch('codex', {
      home: root,
      platform: 'linux',
      env: { PATH: pathDir, [backendBinOverrideEnvKey('codex')]: wrapper },
    });
    expect(r?.bin).toBe(wrapper);
    expect(r?.override).toBe(true);
    expect(r?.onPath).toBe(false);
  });

  it('without the override the same env resolves the PATH codex', () => {
    const r = resolveBackendLaunch('codex', { home: root, platform: 'linux', env: { PATH: pathDir } });
    expect(r?.bin).toBe(join(pathDir, 'codex'));
    expect(r?.override).toBe(false);
  });

  it.each([
    ['a relative path', 'cexec/codex'],
    ['a missing file', '/nonexistent/papercusp/codex'],
    ['a directory', '__DIR__'],
    ['a non-executable file', '__NOEXEC__'],
  ])('fails closed on %s instead of falling back to the PATH codex', (_label, value) => {
    let v = value;
    if (value === '__DIR__') v = dirname(wrapper);
    if (value === '__NOEXEC__') {
      v = join(root, 'noexec-codex');
      writeFileSync(v, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    }
    const r = resolveBackendLaunch('codex', {
      home: root,
      platform: 'linux',
      env: { PATH: pathDir, [backendBinOverrideEnvKey('codex')]: v },
    });
    expect(r).toBeNull();
  });

  it('an override for another agent does not affect codex resolution', () => {
    const r = resolveBackendLaunch('codex', {
      home: root,
      platform: 'linux',
      env: { PATH: pathDir, [backendBinOverrideEnvKey('claude')]: '/nonexistent/claude' },
    });
    expect(r?.bin).toBe(join(pathDir, 'codex'));
  });
});
