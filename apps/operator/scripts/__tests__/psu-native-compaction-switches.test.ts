/**
 * client-native-features-adoption-2026-10-21 R-6 / P-006 (D-004): every psu
 * Claude launch, whether fresh, resumed or forked and on every account route,
 * starts with all three native context-compaction paths switched off, and the
 * owner's own user-level Claude settings stay unchanged.
 *
 *   - idle compaction        → `idleCompaction: false` in the per-session
 *                              `--settings` overlay (applyPsuClaudeSettingsArgs)
 *                              and the isolated settings.json
 *                              (persistPsuClaudeSessionSettings)
 *   - threshold auto-compact → DISABLE_AUTO_COMPACT=1 (nativeCompactionEnv)
 *   - manual /compact        → DISABLE_COMPACT=1 (nativeCompactionEnv)
 *
 * The route population is the launcher's own: no explicit route (a direct
 * user launch), plus EXPLICIT_CLAUDE_ACCOUNT_ROUTES (default, auto, pin).
 * Resume and tracked-fork env come from the launcher's pure builders
 * (buildResumeEnv, trackedForkEnvelopeEnv); the fresh launch composes its env
 * inline in launchFreshSu/roleFlow, so it is pinned structurally below, next to
 * the runWrapper seam every launch kind passes through.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_ROUTING_MODE_ENV,
  EXPLICIT_CLAUDE_ACCOUNT_ROUTES,
  PSU_CLAUDE_SESSION_SETTINGS,
  __setCacheProxyReachable,
  applyPsuClaudeSettingsArgs,
  buildResumeEnv,
  defaultAccountEnv,
  gatewayAutoEnv,
  gatewayPinEnv,
  nativeCompactionEnv,
  persistPsuClaudeSessionSettings,
  trackedForkEnvelopeEnv,
} from '../psu-launcher.mjs';
import { successorNativeCompactionEnv } from '../psu-pty-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = resolve(HERE, '../psu-launcher.mjs');
const PTY_HOST = resolve(HERE, '../psu-pty-host.mjs');

/** The installed Claude Code binary (the native installer's ~/.local/bin/claude
 * symlink into ~/.local/share/claude/versions/<version>), or null when absent. */
const INSTALLED_CLAUDE: string | null = (() => {
  const link = join(homedir(), '.local', 'bin', 'claude');
  try {
    const target = realpathSync(link);
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
})();
const SDK_ENGINE = resolve(HERE, '../../../../packages/operator-core/lib/su-session-claude-engine.ts');

type Route = 'none' | 'default' | 'auto' | 'pin';
type Kind = 'fresh' | 'resume' | 'fork';

const ROUTES: Route[] = ['none', ...(EXPLICIT_CLAUDE_ACCOUNT_ROUTES as Route[])];
const KINDS: Kind[] = ['fresh', 'resume', 'fork'];

/** A launch env: the launcher's builders return objects whose optional keys are
 * typed `string | undefined`. */
type Env = Record<string, string | undefined>;

function routeEnv(route: Route): Env {
  switch (route) {
    case 'none':
      return {};
    case 'default':
      return defaultAccountEnv();
    case 'auto':
      return gatewayAutoEnv('claude', 'su-r6-owner');
    case 'pin':
      return gatewayPinEnv('acct-r6', 'claude', 'su-r6-owner');
  }
}

const session = { agent: 'claude', id: 42, coordOwnerId: 'su-r6-owner' };

/** The env and argv a launch of this kind on this route hands to runWrapper. */
function launchOf(kind: Kind, route: Route): { env: Env; argv: string[] } {
  // buildResumeEnv declares its accountEnv.env as Record<string, string>; every
  // route builder above only ever sets string values.
  const accountEnv = route === 'none' ? null : { mode: route, env: routeEnv(route) as Record<string, string> };
  if (kind === 'resume') {
    return { env: buildResumeEnv(session, { accountEnv }), argv: ['--resume', 'native-r6'] };
  }
  if (kind === 'fork') {
    return {
      env: trackedForkEnvelopeEnv({ PAPERCUSP_SID: 'su-r6-fork', ...routeEnv(route) }, 'claude'),
      argv: ['--resume', 'native-r6', '--fork-session'],
    };
  }
  // Fresh: launchFreshSu spreads nativeCompactionEnv(res.agent) and the route
  // env into the envelope (pinned structurally in the seam test below).
  return {
    env: { PAPERCUSP_AGENT: 'claude', ...nativeCompactionEnv('claude'), ...routeEnv(route) },
    argv: ['kickoff prompt'],
  };
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Offsets of every `{` still open at `end`, skipping comments, quoted strings
 * and template-literal text (a template's `${…}` braces still count). */
function enclosingOpeners(text: string, end: number): number[] {
  const stack: number[] = [];
  const templateDepths: number[] = [];
  let inTemplate = false;
  let i = 0;
  while (i < end) {
    const c = text[i];
    const n = text[i + 1];
    if (inTemplate) {
      if (c === '\\') i += 2;
      else if (c === '`') { inTemplate = false; i++; }
      else if (c === '$' && n === '{') { templateDepths.push(stack.length); stack.push(i + 1); inTemplate = false; i += 2; }
      else i++;
      continue;
    }
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); i = e < 0 ? end : e; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? end : e + 2; continue; }
    if (c === "'" || c === '"') {
      i++;
      while (i < end && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (c === '`') inTemplate = true;
    else if (c === '{') stack.push(i);
    else if (c === '}') {
      stack.pop();
      if (templateDepths.at(-1) === stack.length) { templateDepths.pop(); inTemplate = true; }
    }
    i++;
  }
  return stack;
}

/** What a block's `{` hangs off: back from it to the previous `;`, `{`, `}` or
 * `,` outside brackets, with comments removed (an `if (…)` condition however
 * many lines it spans, an arrow's parameter list, an object key). */
function blockHeader(text: string, open: number): string {
  let depth = 0;
  let i = open - 1;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') depth--;
    else if (depth <= 0 && ';{},'.includes(c!)) break;
  }
  return text.slice(i + 1, open).replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const SUCCESSOR_SWITCH_CALL = /successorNativeCompactionEnv\(env\.PAPERCUSP_AGENT\)/g;

/** Every successor-env call site whose compaction switches depend on the carry
 * prompt addendum: the call is not a bare spread or Object.assign operand, its
 * line or the code line before it reads the addendum (a brace-less `if`), or a
 * non-function block enclosing it has the addendum in its header. A function's
 * parameter list is not a gate: recycle destructures systemPromptAddendum. */
function addendumGatedSuccessorSites(src: string): string[] {
  const found: string[] = [];
  for (const site of src.matchAll(SUCCESSOR_SWITCH_CALL)) {
    const at = site.index!;
    const where = `line ${src.slice(0, at).split('\n').length}`;
    if (!/(?:\.\.\.|Object\.assign\(env, )$/.test(src.slice(Math.max(0, at - 20), at))) {
      found.push(`${where}: not a bare spread or Object.assign operand`);
    }
    const lineEnd = src.indexOf('\n', at);
    const codeLines = src
      .slice(0, lineEnd < 0 ? undefined : lineEnd)
      .split('\n')
      .filter((l) => l.trim() !== '' && !/^\s*(\/\/|\*|\/\*)/.test(l));
    if (codeLines.slice(-2).some((l) => l.includes('systemPromptAddendum'))) {
      found.push(`${where}: its line or the code line before it reads the addendum`);
    }
    for (const open of enclosingOpeners(src, at)) {
      const header = blockHeader(src, open);
      if (/=>\s*$/.test(header) || /\bfunction\b/.test(header)) continue;
      if (header.includes('systemPromptAddendum')) {
        found.push(`${where}: enclosed by a block gated on the addendum (${header.trim().slice(0, 60)})`);
      }
    }
  }
  return found;
}

/** Silent stand-in for persistPsuClaudeSessionSettings' default stderr logger,
 * whose declared type is `(m) => boolean` (process.stderr.write's return). */
const quiet = () => true;

/** Source text of one top-level function in a module (from its declaration to
 * the first column-0 closing brace). */
function functionSource(src: string, declaration: string): string {
  const start = src.indexOf(declaration);
  expect(start, `${declaration} not found`).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

describe('psu Claude launch native-compaction switches (R-6, D-004)', () => {
  beforeEach(() => __setCacheProxyReachable(false));
  afterEach(() => __setCacheProxyReachable(null));

  it('the route population is none plus default, auto and pin', () => {
    expect(ROUTES).toEqual(['none', 'default', 'auto', 'pin']);
    expect(PSU_CLAUDE_SESSION_SETTINGS).toEqual({ idleCompaction: false });
  });

  for (const route of ROUTES) {
    for (const kind of KINDS) {
      it(`route ${route} x ${kind} launch: all three compaction paths are off`, () => {
        const { env, argv } = launchOf(kind, route);
        // The route marker reached the launch env (or is absent for 'none').
        expect(env[ACCOUNT_ROUTING_MODE_ENV]).toBe(route === 'none' ? undefined : route);
        // Threshold auto-compact and the manual /compact command.
        expect(env.DISABLE_AUTO_COMPACT).toBe('1');
        expect(env.DISABLE_COMPACT).toBe('1');
        // Idle compaction: the per-session --settings overlay leads the argv.
        const applied = applyPsuClaudeSettingsArgs('claude', argv, env);
        expect(applied[0]).toBe('--settings');
        expect(applied.slice(2)).toEqual(argv);
        const settings = JSON.parse(applied[1]!);
        expect(settings.idleCompaction).toBe(false);
        // The default-account auth override rides along only on explicit routes.
        expect('apiKeyHelper' in settings).toBe(route !== 'none');
      });
    }
  }

  it('non-Claude backends get no overlay and no Claude compaction env', () => {
    const argv = ['--resume', 'x'];
    for (const bin of ['omp', 'codex', '/usr/bin/codex']) {
      expect(applyPsuClaudeSettingsArgs(bin, argv, defaultAccountEnv())).toBe(argv);
    }
    expect(nativeCompactionEnv('omp')).toEqual({});
    expect(nativeCompactionEnv('codex')).toEqual({});
    expect(applyPsuClaudeSettingsArgs('/home/u/.local/bin/claude', argv, {})[0]).toBe('--settings');
  });

  describe('per-session settings.json (re-exec durable)', () => {
    let root: string;
    let userClaudeDir: string;
    let ownerSettings: string;
    let sessionDir: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'psu-r6-'));
      userClaudeDir = join(root, 'home', '.claude');
      sessionDir = join(root, 'sessions', 'su-r6-owner');
      mkdirSync(userClaudeDir, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      ownerSettings = join(userClaudeDir, 'settings.json');
      writeFileSync(ownerSettings, JSON.stringify({ idleCompaction: true, model: 'opus' }, null, 2));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('writes idleCompaction false into the isolated settings.json and leaves the owner settings byte-identical', () => {
      writeFileSync(
        join(sessionDir, 'settings.json'),
        JSON.stringify({ permissions: { deny: ['Task'] }, model: 'opus[1m]', idleCompaction: true }),
      );
      const before = sha256(ownerSettings);
      const wrote = persistPsuClaudeSessionSettings({
        wrapperBin: 'claude',
        env: { CLAUDE_CONFIG_DIR: sessionDir },
        userClaudeDir,
        log: quiet,
      });
      expect(wrote).toBe(true);
      const written = JSON.parse(readFileSync(join(sessionDir, 'settings.json'), 'utf8'));
      expect(written).toEqual({ permissions: { deny: ['Task'] }, model: 'opus[1m]', idleCompaction: false });
      expect(sha256(ownerSettings)).toBe(before);
    });

    it('creates the isolated settings.json when the session dir has none', () => {
      expect(
        persistPsuClaudeSessionSettings({
          wrapperBin: 'claude-su',
          env: { CLAUDE_CONFIG_DIR: sessionDir },
          userClaudeDir,
          log: quiet,
        }),
      ).toBe(true);
      expect(JSON.parse(readFileSync(join(sessionDir, 'settings.json'), 'utf8'))).toEqual({
        idleCompaction: false,
      });
    });

    it("refuses the owner's user-level dir, an unset config dir and non-Claude backends", () => {
      const before = sha256(ownerSettings);
      const call = (wrapperBin: string, env: Record<string, string>) =>
        persistPsuClaudeSessionSettings({ wrapperBin, env, userClaudeDir, log: quiet });
      expect(call('claude', { CLAUDE_CONFIG_DIR: userClaudeDir })).toBe(false);
      expect(call('claude', { CLAUDE_CONFIG_DIR: `${userClaudeDir}/` })).toBe(false);
      expect(call('claude', {})).toBe(false);
      expect(call('omp', { CLAUDE_CONFIG_DIR: sessionDir })).toBe(false);
      expect(sha256(ownerSettings)).toBe(before);
      expect(existsSync(join(sessionDir, 'settings.json'))).toBe(false);
    });
  });

  it('every launch seam applies the overlay, the persist and the env switches', () => {
    const src = readFileSync(LAUNCHER, 'utf8');
    // runWrapper is the seam fresh, resume and fork launches share.
    const runWrapper = functionSource(src, 'export function runWrapper(options)');
    expect(runWrapper).toContain('applyPsuClaudeSettingsArgs(wrapperBin, args, env)');
    expect(runWrapper).toContain('persistPsuClaudeSessionSettings({ wrapperBin, env })');
    expect(functionSource(src, 'async function launchResume(')).toContain('runWrapper(');
    expect(functionSource(src, 'export async function launchTrackedFork(')).toContain('runWrapper(');
    // Fresh launches stamp the env switches inline.
    expect(functionSource(src, 'export async function launchFreshSu(')).toContain(
      '...nativeCompactionEnv(res.agent)',
    );
    // The background SDK engine builds its settings from the same overlay.
    const engine = readFileSync(SDK_ENGINE, 'utf8');
    expect(engine).toContain("applyPsuClaudeSettingsArgs('claude', [], env)");
    expect(engine).toContain("persistPsuClaudeSessionSettings({ wrapperBin: 'claude', env })");
  });

  // Critique 2 R-6(a): the carry-respawn successor psu-pty-host spawns builds its
  // own env, so the launch-time switches do not reach it on their own.
  it('a carry-respawn successor gets both compaction switches on every route, with or without a prompt addendum', () => {
    // The successor env for each launch's own backend, on every route including none.
    for (const route of ROUTES) {
      for (const kind of KINDS) {
        const { env } = launchOf(kind, route);
        const successor = { ...env, ...successorNativeCompactionEnv(env.PAPERCUSP_AGENT ?? 'claude') };
        expect(successor.DISABLE_AUTO_COMPACT, `${route} x ${kind}`).toBe('1');
        expect(successor.DISABLE_COMPACT, `${route} x ${kind}`).toBe('1');
      }
    }
    // A host env with no switches at all (pre-cutover) and no agent marker.
    expect(successorNativeCompactionEnv(undefined)).toEqual({ DISABLE_AUTO_COMPACT: '1', DISABLE_COMPACT: '1' });
    // Lockstep with the launcher for every backend psu launches.
    for (const agent of ['claude', 'codex', 'omp']) {
      expect(successorNativeCompactionEnv(agent), agent).toEqual(nativeCompactionEnv(agent));
    }
    // Both successor seams in recycleChild use it, and neither is gated on the addendum.
    const host = readFileSync(PTY_HOST, 'utf8');
    expect(host.match(SUCCESSOR_SWITCH_CALL)).toHaveLength(2);
    expect(host).not.toMatch(/systemPromptAddendum\s*\)?\s*[?{][\s\S]{0,120}DISABLE_AUTO_COMPACT/);
    expect(addendumGatedSuccessorSites(host)).toEqual([]);
  });

  // Positive controls for the scan above: each shape gates the successor
  // switches on the carry addendum and must be reported; a function that only
  // destructures the addendum as a parameter must not be.
  it('the successor-site scan reports every addendum-gated shape and accepts a parameter-only mention', () => {
    const call = 'successorNativeCompactionEnv(env.PAPERCUSP_AGENT)';
    const gated = {
      ternary: `const childEnv = {\n  a: 1,\n  ...(systemPromptAddendum ? ${call} : {}),\n};`,
      conjunction: `const childEnv = {\n  a: 1,\n  ...(systemPromptAddendum && ${call}),\n};`,
      inlineIf: `x();\nif (systemPromptAddendum) Object.assign(env, ${call});`,
      bracelessIf: `x();\nif (systemPromptAddendum)\n  Object.assign(env, ${call});`,
      multiLineIfBlock: `if (\n  systemPromptAddendum &&\n  ok\n) {\n  const h = write({\n    childEnv: {\n      a: 1,\n      ...${call},\n    },\n  });\n}`,
      outerIfBlock: `if (systemPromptAddendum) {\n  try {\n    x();\n    Object.assign(env, ${call});\n  } catch {}\n}`,
    };
    for (const [shape, src] of Object.entries(gated)) {
      expect(addendumGatedSuccessorSites(src), shape).not.toEqual([]);
    }
    const ungated = [
      `const recycle = async (data, {\n  systemPromptAddendum = '',\n}) => {\n  x();\n  Object.assign(env, ${call});\n};`,
      `function recycle({ systemPromptAddendum }) {\n  const label = \`{\${systemPromptAddendum}}\`;\n  const childEnv = {\n    a: 1,\n    ...${call},\n  };\n}`,
    ];
    for (const src of ungated) expect(addendumGatedSuccessorSites(src)).toEqual([]);
  });

  // Critique 2 R-6(b) / D-004: the switches psu sets must be names the installed
  // Claude Code binary actually reads, or a CLI update could silently turn them
  // into no-ops. Skipped where no Claude CLI is installed.
  it.skipIf(!INSTALLED_CLAUDE)('the installed Claude CLI reads idleCompaction, DISABLE_COMPACT and DISABLE_AUTO_COMPACT', () => {
    const binary = readFileSync(INSTALLED_CLAUDE!);
    for (const name of ['idleCompaction', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT']) {
      expect(binary.includes(name), `${name} in ${INSTALLED_CLAUDE}`).toBe(true);
    }
    // Positive control: a name the binary does not contain is reported absent.
    expect(binary.includes('papercusp-r6-absent-switch-name')).toBe(false);
  });
});
