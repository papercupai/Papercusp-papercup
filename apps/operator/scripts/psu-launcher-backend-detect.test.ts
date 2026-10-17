/**
 * psu-launcher-backend-detect.test.ts (WI-37920) — recurrence guard for the class
 * "a backend CLI that IS installed is reported as `not installed`, but only inside a
 * desktop-spawned terminal".
 *
 * The failure this pins:
 *   - `omp` is installed by bun into ~/.bun/bin.
 *   - ~/.bun/bin reaches PATH via ~/.bashrc, BELOW the standard
 *     "If not running interactively, don't do anything" early-return.
 *   - EVERY desktop spawn runs `bash -lc` (login, NON-interactive), so that block
 *     never executes; and gnome-terminal additionally hands the command to a
 *     long-lived gnome-terminal-server over D-Bus, which runs it under the DESKTOP
 *     session's env rather than the operator's (measured: its PATH had zero `.bun`
 *     entries while the operator's carried ~/.bun/bin).
 *   - So the PATH leg of detectBackendBin() misses, and the ONLY thing standing
 *     between the user and `psu: the omp backend (`omp`) is not installed.` is
 *     wellKnownBackendBin()'s fallback list.
 *
 * This is why the bug read as door-specific ("fleets work, launch-agent doesn't")
 * when it is actually BACKEND-specific: claude/codex resolve on the desktop PATH,
 * omp did not. Every door shares one spawn path (console-spawn's spawnConsole).
 *
 * Run: cd apps/operator && npx vitest run scripts/psu-launcher-backend-detect.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { codexManagedDaemonArgs, detectBackendBin, ensureBackendInstalled, wellKnownBackendBin } from './psu-launcher.mjs';

/**
 * Install locations a backend can legitimately land in, that a desktop-spawned
 * (login, non-interactive) shell CANNOT be relied on to have on PATH. Adding a
 * backend or an installer means adding a row here — that is the point.
 */
const INSTALLER_LOCATIONS: ReadonlyArray<{ agent: string; installer: string; rel: string }> = [
  { agent: 'omp', installer: 'bun add -g', rel: '.bun/bin/omp' },
  { agent: 'omp', installer: 'papercusp setup', rel: '.papercusp/bin/omp' },
  { agent: 'claude', installer: 'native installer', rel: '.local/bin/claude' },
  { agent: 'codex', installer: 'npm -g', rel: '.npm-global/bin/codex' },
];

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'psu-backend-detect-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('wellKnownBackendBin — PATH-independent backend detection (WI-37920)', () => {
  it.each(INSTALLER_LOCATIONS)(
    'finds $agent installed by "$installer" at ~/$rel with NOTHING on PATH',
    ({ agent, rel }) => {
      const bin = join(home, rel);
      mkdirSync(dirname(bin), { recursive: true });
      writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });

      // env deliberately carries an EMPTY PATH: this asserts the fallback list alone
      // is sufficient, which is exactly the situation inside a desktop terminal.
      const found = wellKnownBackendBin(agent, { home, env: { NODE_ENV: 'test', PATH: '' } });

      expect(
        found,
        `${agent} installed at ~/${rel} must be detectable without PATH — otherwise psu ` +
          `aborts with "the ${agent} backend is not installed" inside every desktop-spawned ` +
          `terminal, while the same binary works fine in the user's interactive shell.`,
      ).toBe(bin);
    },
  );

  it('returns null for a backend that genuinely is not installed', () => {
    const empty = mkdtempSync(join(tmpdir(), 'psu-backend-detect-empty-'));
    try {
      expect(wellKnownBackendBin('omp', { home: empty, env: { NODE_ENV: 'test', PATH: '' } })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('packaged backend launchers cannot recursively launch psu', () => {
  it.each(['inherited', 'envelope'])(
    'keeps launcher inspector publication out of the native child (%s NODE_OPTIONS)', (source) => {
      const root = mkdtempSync(join(tmpdir(), 'psu-native-inspector-'));
      try {
        const nativeDir = join(root, 'native');
        mkdirSync(nativeDir);
        writeFileSync(join(nativeDir, 'claude'),
          '#!/bin/sh\nprintf "NATIVE_OPTIONS:%s\\n" "$NODE_OPTIONS"\n', { mode: 0o755 });
        const launcherUrl = process.env.PROBE_SUBJECT
          ? pathToFileURL(process.env.PROBE_SUBJECT).href
          : new URL('./psu-launcher.mjs', import.meta.url).href;
        const options = '--max-old-space-size=4096 --inspect-publish-uid=http --expose-gc';
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
          import { runWrapper } from ${JSON.stringify(launcherUrl)};
          process.stdout.write('LAUNCHER_OPTIONS:' + process.env.NODE_OPTIONS + '\\n');
          runWrapper({ wrapperBin: 'claude', args: [], cwd: ${JSON.stringify(root)}, preserveCwd: true,
            envelopeEnv: { PAPERCUSP_AGENT: 'claude', PAPERCUSP_PSU_NO_PTY: '1',
              ${source === 'envelope' ? `NODE_OPTIONS: ${JSON.stringify(options)},` : ''} },
            reportSessionEndedImpl: async () => {},
          });
        `], { encoding: 'utf8', timeout: 15_000,
          env: { HOME: root, NODE_ENV: 'test', PATH: [nativeDir, process.env.PATH].join(':'),
            NODE_OPTIONS: options, PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', PAPERCUSP_MCP_PROXY: '0' },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe(`LAUNCHER_OPTIONS:${options}\nNATIVE_OPTIONS:--max-old-space-size=4096 --expose-gc\n`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { args: ['--resume', '11111111-1111-4111-8111-111111111111', '--fork-session', '--session-id', '22222222-2222-4222-8222-222222222222'], expected: '22222222-2222-4222-8222-222222222222' },
    { args: ['--resume', '11111111-1111-4111-8111-111111111111', '--fork-session'], expected: '' },
  ])('derives the ordinary child MCP identity from argv without restoring Claude ancestry: $expected', ({ args, expected }) => {
    const root = mkdtempSync(join(tmpdir(), 'psu-native-carrier-'));
    try {
      const nativeDir = join(root, 'native');
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(nativeDir, 'claude'), '#!/bin/sh\nprintf "CARRIER:%s\\nANCESTRY:%s\\n" "$PAPERCUSP_NATIVE_SESSION_ID" "$CLAUDE_CODE_SESSION_ID"\n', { mode: 0o755 });
      const launcherUrl = process.env.PROBE_SUBJECT
        ? pathToFileURL(process.env.PROBE_SUBJECT).href
        : new URL('./psu-launcher.mjs', import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { runWrapper } from ${JSON.stringify(launcherUrl)};
        runWrapper({
          wrapperBin: 'claude', args: ${JSON.stringify(args)}, cwd: ${JSON.stringify(root)},
          preserveCwd: true,
          envelopeEnv: { PAPERCUSP_AGENT: 'claude', PAPERCUSP_PSU_NO_PTY: '1',
            PAPERCUSP_NATIVE_SESSION_ID: '11111111-1111-4111-8111-111111111111' },
          reportSessionEndedImpl: async () => {},
        });
      `], {
        encoding: 'utf8', timeout: 15_000,
        env: { HOME: root, NODE_ENV: 'test', PATH: [nativeDir, process.env.PATH].join(':'),
          PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', PAPERCUSP_MCP_PROXY: '0',
          CLAUDE_CODE_SESSION_ID: '11111111-1111-4111-8111-111111111111' },
      });
      expect(result.error, JSON.stringify({ status: result.status, signal: result.signal,
        stdout: result.stdout, stderr: result.stderr })).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(`CARRIER:${expected}\nANCESTRY:\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { operation: 'launch', args: ['--help'] },
    { operation: 'resume', args: ['resume', 'test-thread'] },
    { operation: 'owner-reported flags', args: [
      '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen',
    ] },
  ])('spawns the native executable for $operation without an earlier install check', ({ args }) => {
    const root = mkdtempSync(join(tmpdir(), 'psu-native-spawn-'));
    try {
      const wrapperDir = join(root, 'sidecar/bin');
      const nativeDir = join(root, 'native');
      mkdirSync(wrapperDir, { recursive: true });
      mkdirSync(nativeDir, { recursive: true });
      const packagedLauncher = join(root, 'psu.mjs');
      writeFileSync(packagedLauncher, "console.log('PACKAGED_LAUNCHER');\n");
      writeFileSync(
        join(wrapperDir, 'codex'),
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(packagedLauncher)} "$@"\n`,
        { mode: 0o755 },
      );
      writeFileSync(join(nativeDir, 'codex'), '#!/bin/sh\nprintf "NATIVE_ARG:%s\\n" "$@"\n', { mode: 0o755 });
      const launcherUrl = process.env.PROBE_SUBJECT
        ? pathToFileURL(process.env.PROBE_SUBJECT).href
        : new URL('./psu-launcher.mjs', import.meta.url).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { runWrapper } from ${JSON.stringify(launcherUrl)};
        runWrapper({
          wrapperBin: 'codex',
          args: ${JSON.stringify(args)},
          cwd: ${JSON.stringify(root)},
          preserveCwd: true,
          envelopeEnv: { PAPERCUSP_AGENT: 'codex', PAPERCUSP_PSU_NO_PTY: '1' },
          reportSessionEndedImpl: async () => {},
        });
      `], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { HOME: root, NODE_ENV: 'test', PATH: [wrapperDir, nativeDir, process.env.PATH].join(':') },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain('PACKAGED_LAUNCHER');
      expect(result.stdout).toBe(['--no-daemon', ...args].map(argument => `NATIVE_ARG:${argument}\n`).join(''));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates managed Codex feature settings from the shared background daemon on launch and resume', () => {
    expect(codexManagedDaemonArgs('codex', ['--no-alt-screen'])).toEqual(['--no-daemon', '--no-alt-screen']);
    expect(codexManagedDaemonArgs('/opt/bin/codex', ['resume', 'thread'])).toEqual(['--no-daemon', 'resume', 'thread']);
    expect(codexManagedDaemonArgs('codex', ['--no-daemon'])).toEqual(['--no-daemon']);
    expect(codexManagedDaemonArgs('claude', [])).toEqual([]);
  });
  it('detects and promotes the native backend even when its directory is already later on PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-native-backend-'));
    const originalPath = process.env.PATH;
    try {
      const wrapperDir = join(root, 'sidecar/bin');
      const nativeDir = join(root, 'native');
      mkdirSync(wrapperDir, { recursive: true });
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(wrapperDir, 'codex'), '#!/bin/sh\nexec node "$ROOT/scripts/psu.mjs" --agent=codex "$@"\n');
      const native = join(nativeDir, 'codex');
      writeFileSync(native, '#!/bin/sh\nexit 0\n');
      process.env.PATH = [wrapperDir, nativeDir, originalPath].join(':');
      expect(detectBackendBin('codex')).toEqual({ path: native, onPath: true });
      expect(await ensureBackendInstalled('codex', { interactive: false })).toBe(true);
      expect(process.env.PATH?.split(':')[0]).toBe(nativeDir);
      expect(detectBackendBin('codex')?.path).toBe(native);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * P-001: the list is now SHARED with the operator-side PATH injection
 * (`packages/operator-core/lib/backend-bin-resolve.mjs`, consumed by
 * console-launcher when it builds the spawn env).
 *
 * Why a structural guard and not just the behavioural ones above: two copies of
 * this list drift in the WORST direction. Detection keeps passing here — these
 * very tests stay green — while the operator injects a different (or no)
 * directory, so the window still cannot execute the backend. And it only
 * reproduces inside a desktop-spawned terminal, which is precisely the env a unit
 * test does not run in. Same one-definition reasoning as `su-tier-roles.mjs`
 * (guarded the same way in su-role-addendum.test.ts).
 */
describe('psu-launcher does not keep its own copy of the install-location list (P-001)', () => {
  const launcherSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'psu-launcher.mjs'),
    'utf8',
  );

  it('imports the shared resolver instead of declaring a second list', () => {
    // Quote-agnostic: formatting sweeps have flipped the launcher between quote styles
    // (single→double 2026-08-22) while the pinned property — ONE shared list — held.
    expect(launcherSrc).toMatch(
      /from ['"]\.\.\/\.\.\/\.\.\/packages\/operator-core\/lib\/backend-bin-resolve\.mjs['"]/,
    );
  });

  it('has no re-declared per-agent path table', () => {
    // The shape that WAS here: `const lists = { claude: [...], codex: [...] }`.
    expect(launcherSrc).not.toMatch(/const\s+lists\s*=\s*\{[\s\S]{0,200}claude\s*:/);
  });
});
