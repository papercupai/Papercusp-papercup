/**
 * `scripts/mutation-probe.sh` — the sweep-race gate on `--in-tree`.
 *
 * WHY THIS FILE EXISTS (EI-18701398718982653): the probe script is the repo's
 * sanctioned way to prove a guard is falsifiable, and `--in-tree` is its one
 * mode that leaves a deliberately-wrong state in the SHARED tracked tree.
 * git-sync commits that tree on a short cadence, so a probe outliving one tick
 * gets its mutant committed — a committed RED test freezes every agent's
 * deploys. The script cannot take the lock itself (it lives in Postgres behind
 * an authed door), so the next best thing is that it refuses to proceed until
 * the caller has DECIDED what to do about the sweep. Before this gate the same
 * information was a log line printed while the mutation was already under way.
 *
 * Every case below drives the REAL script against a throwaway git repo under
 * os.tmpdir(), never against this checkout — the same copy-out discipline the
 * script itself prescribes (CLAUDE.md § "Proving a guard is falsifiable").
 *
 * FALSIFIABILITY: the subject path is overridable via MUTATION_PROBE_SCRIPT, so
 * this suite can be pointed at a mutated COPY of the script. Probe it by hand:
 *
 *   t="$(mktemp -d)" &&
 *   cp scripts/mutation-probe.sh scripts/mutation-probe-admission.sh "$t/" &&
 *   perl -pi -e 's/^if \[ "\$IN_TREE" -eq 1 \] && \[ -z "\$SWEEP_ACK" \]; then/if false; then/' "$t/mutation-probe.sh" &&
 *   ! cmp -s scripts/mutation-probe.sh "$t/mutation-probe.sh" &&
 *   MUTATION_PROBE_SCRIPT="$t/mutation-probe.sh" npm run test:file -- apps/operator/lib/mutation-probe-sweep-gate.test.ts
 *
 * The `cmp` step refuses a mutation that changed nothing. The tracked script is
 * never dirty. Copy mutation-probe-admission.sh too: the script sources it from
 * its own directory for every --in-tree run.
 *
 * Do NOT wrap this in `scripts/mutation-probe.sh --fake-destructive` (WI-10004181).
 * That guard makes rm/unlink log-only for its whole --test tree, so the in-tree
 * cases' own probes could not remove their admission manifests or scratch dirs.
 * The probe refuses --in-tree under that guard, so the BASELINE fails and no
 * verdict is possible. The hand recipe runs the mutant with real deletion,
 * confined to this suite's throwaway dirs under os.tmpdir(): check that your
 * mutation does not touch a cleanup (rm/unlink) line before you run it.
 *
 * READ WHICH TESTS FAIL, not just the verdict line. A genuine catch here fails
 * a PROPER SUBSET — mutating the sweep gate fails only the sweep cases,
 * mutating the parse gate fails only the two REFUSES cases. A mutant that
 * fails EVERY case usually means the mutation broke the script rather than the
 * behaviour under test, which is the exact false verdict the parse gate below
 * exists to prevent (EI-21430792829614962).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Walk up from this file to the checkout root (the dir holding `scripts/`). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'scripts', 'mutation-probe.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the checkout root from ' + import.meta.url);
}

const PROBE = process.env.MUTATION_PROBE_SCRIPT
  ? resolve(process.env.MUTATION_PROBE_SCRIPT)
  : join(repoRoot(), 'scripts', 'mutation-probe.sh');

function git(repo: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  return (result.stdout ?? '').trim();
}

let scratch: string;
let subject: string;
let fakeBin: string;
let lockLog: string;
let submoduleSource: string;

/**
 * Run the probe inside the scratch repo. `cwd` matters: the script resolves the
 * file-lock path from the repo root it is standing in, so running here also
 * proves that path is DERIVED rather than hardcoded to this checkout.
 */
// An `undefined` value REMOVES the variable from the child env (spawnSync skips
// undefined entries) — the only way a case can run the probe with TMPDIR unset.
function runProbe(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const r = spawnSync('bash', [PROBE, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 60_000,
    env: probeEnv(extraEnv),
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// The mutation-descriptor READER is not what this file measures. That binding
// has its own suite (packages/operator-core/lib/agent-tools/testing/
// mutation-probe-descriptor-export.test.ts). Without this pin the probe picks
// its reader from the route env: runLockedProbe's PAPERCUSP_OPERATOR_URL, or
// the gate host's PAPERCUSP_HONO_PORT. It then infers READER_REQUIRED=1 and
// dies at the descriptor preflight against the LIVE build, before any
// sweep-fence code runs. MEASURED (WI-6554700010018610): 15/52 cases red at
// staging tip and at the frozen gate head while :3070 served d740fc3802,
// whose libs/test-config predates the descriptor parser. The gate could not
// promote main while this test failed, and the test could not pass until main
// advanced. EXPORT=never returns before any reader is contacted, so every
// case stays hermetic; a case that needs a reader overrides it via extraEnv.
//
// NODE_OPTIONS has the same problem. `npm run test:file` exports
// --import=<root>/scripts/lib/committed-source-loader.mjs through it, and a
// guard such as `node {}` inherits it. The loader then judges the scratch
// subject against the scratch repo, which has no HEAD commit, and crashes
// before the subject runs (baseline_exit=1). The two .mjs unparseable-mutant
// cases were red under test:file only. The gate's test:affected passes the
// loader as execArgv, not NODE_OPTIONS. A scratch subject is not repo source,
// so the probe's children run without that loader.
function withoutCommittedSourceLoader(nodeOptions: string | undefined): string | undefined {
  if (!nodeOptions) return nodeOptions;
  const tokens = nodeOptions.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.includes('committed-source-loader')) continue; // --import=<path>
    if (/^--(import|loader|experimental-loader|require)$|^-r$/.test(token) && tokens[i + 1]?.includes('committed-source-loader')) {
      i += 1; // --import <path>
      continue;
    }
    kept.push(token);
  }
  return kept.length ? kept.join(' ') : undefined;
}

const HERMETIC_PROBE_ENV: Record<string, string | undefined> = {
  PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT: 'never',
  PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: undefined,
  PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: undefined,
  NODE_OPTIONS: withoutCommittedSourceLoader(process.env.NODE_OPTIONS),
};

function probeEnv(extraEnv: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
      ...process.env,
      ...HERMETIC_PROBE_ENV,
      TMPDIR: scratch,
      // Scrub the AMBIENT value so every case below measures what the PROBE
      // does, not who launched vitest. This is not hypothetical: the
      // green-checkpoint runs the suite as `npm run test:affected` THROUGH
      // pc-heavy, and pc-heavy exports PC_HEAVY_BYPASS=1 into its whole child
      // tree (its release-gate fast path does exactly that) — so in the gate
      // this process already carries the variable the ceiling cases assert on,
      // while an interactive shell does not. MEASURED 2026-09-20: without this
      // line the copy-out case is green locally and RED in the gate. Empty is
      // the right scrub rather than "0": pc-heavy tests `= "1"`, and the probe
      // reports via `${PC_HEAVY_BYPASS:-unset}`, which treats empty as unset.
      PC_HEAVY_BYPASS: '',
      // Same class (WI-10005002): the probe REFUSES --in-tree when this is "1",
      // so a suite launched from a foreground capability:bash call reported ~16
      // false reds. The cases that test that refusal set it via extraEnv.
      PAPERCUSP_CAPABILITY_BASH_FOREGROUND: '',
      ...extraEnv,
  };
}

const GOOD = 'value = GOOD\n';

function runLockedProbe(
  args: string[],
  mode:
    | 'all'
    | 'no-file'
    | 'no-resource'
    | 'resource-short'
    | 'heartbeat-refused'
    | 'timeout-once'
    | 'heartbeat-timeout-once'
    | 'auth-failure'
    | 'input-failure' = 'all',
  extraEnv: Record<string, string | undefined> = {},
): { code: number; out: string } {
  writeFileSync(lockLog, '');
  const result = runProbe(args, {
    ...process.env,
    PATH: fakeBin + ':' + (process.env.PATH ?? ''),
    PAPERCUSP_SID: 'mutation-probe-test-session',
    PAPERCUSP_WORKSPACE_ID: '',
    PAPERCUSP_WORKSPACE: 'probe-workspace',
    PAPERCUSP_TEST_RUN_HARNESS: 'probe-harness',
    MUTATION_PROBE_WINDOW_MAX_SEC: '600',
    MUTATION_PROBE_LOCK_MODE: mode,
    MUTATION_PROBE_LOCK_LOG: lockLog,
    PAPERCUSP_OPERATOR_BASE: '',
    PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070',
    PAPERCUSP_HONO_PORT: '',
    PAPERCUSP_MCP_PROXY_BASE: '',
    PAPERCUSP_MCP_PROXY_TARGET_PORT: '3070',
    // ...process.env above re-adds the launcher's marker after runProbe's scrub (WI-10005002).
    PAPERCUSP_CAPABILITY_BASH_FOREGROUND: '',
    // ...process.env also re-adds any ambient descriptor setting, and the
    // PAPERCUSP_OPERATOR_URL above would select the live :3070 as the reader.
    ...HERMETIC_PROBE_ENV,
    ...extraEnv,
  });
  // spawnSync reports null when the child died on a signal; -1 keeps that distinct from every real exit code.
  return { code: result.status ?? -1, out: result.out };
}

let mjsSubject: string;
let shSubject: string;

/**
 * A subject shaped like the one that produced the false verdict in
 * EI-21430792829614962: a function whose DECLARATION and CALL SITE share the
 * exact text `isTunnelForward(addrs, port)`, so a natural-looking mutation of
 * "the call" silently rewrites the declaration too and yields `function false`.
 * It exits 0 as written, which is what the probe's baseline gate requires.
 */
const MJS_SUBJECT = [
  "import process from 'node:process';",
  "const addrs = ['127.0.0.10'];",
  "const port = '443';",
  'function isTunnelForward(addrs, port) {',
  "  return addrs.length > 0 && port === '443';",
  '}',
  'if (isTunnelForward(addrs, port)) {',
  '  process.exit(0);',
  '}',
  'process.exit(1);',
  '',
].join('\n');

const SH_SUBJECT = [
  '#!/usr/bin/env bash',
  'if [ "1" = "1" ]; then',
  '  exit 0',
  'fi',
  'exit 1',
  '',
].join('\n');

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'mutation-probe-gate-'));
  subject = join(scratch, 'subject.txt');
  writeFileSync(subject, GOOD);
  mjsSubject = join(scratch, 'subject.mjs');
  writeFileSync(mjsSubject, MJS_SUBJECT);
  shSubject = join(scratch, 'subject.sh');
  writeFileSync(shSubject, SH_SUBJECT);
  // `git hash-object` / `rev-parse --show-toplevel` need a real repo.
  const init = spawnSync('git', ['init', '-q'], { cwd: scratch, encoding: 'utf8' });
  expect(init.status, `git init failed: ${init.stderr}`).toBe(0);
});

beforeAll(() => {
  fakeBin = join(scratch, 'fake-bin');
  mkdirSync(fakeBin);
  lockLog = join(scratch, 'ptool.log');
  writeFileSync(lockLog, '');
  const fakePtool = join(fakeBin, 'ptool');
  writeFileSync(fakePtool, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "let input = '';",
    'process.stdin.on("data", (chunk) => input += chunk);',
    'process.stdin.on("end", () => {',
    '  const argv = process.argv.slice(2);',
    '  const workspace = argv.find((arg) => arg.startsWith("--workspace="))?.slice("--workspace=".length) ?? "";',
    '  const harness = argv.find((arg) => arg.startsWith("--harness="))?.slice("--harness=".length) ?? "";',
    '  const tool = argv.find((arg) => !arg.startsWith("--") && arg.includes(":"));',
    '  const args = input ? JSON.parse(input) : {};',
    '  const mode = process.env.MUTATION_PROBE_LOCK_MODE;',
    "  const projectionAt = argv.indexOf('--projection');",
    "  const projectionRaw = projectionAt >= 0 ? argv[projectionAt + 1] : undefined;",
    '  const explicitUrl = argv.find((arg) => arg.startsWith("--url="));',
    '  const targetUrl = explicitUrl ? explicitUrl.slice("--url=".length) : (process.env.PAPERCUSP_HONO_PORT ? "http://127.0.0.1:" + process.env.PAPERCUSP_HONO_PORT : (process.env.PAPERCUSP_OPERATOR_URL || "http://127.0.0.1:3070"));',
    '  if (process.env.MUTATION_PROBE_LOCK_LOG) {',
    '    fs.appendFileSync(process.env.MUTATION_PROBE_LOCK_LOG, JSON.stringify({ tool, args, projection: projectionRaw, targetUrl, workspace, harness }) + "\\n");',
    '  }',
    // Mirror the auth boundary: a fleet member must scope each call explicitly;
    // relying on a stale session claim can produce harness_scope_stale.
    '  const expectedWorkspace = process.env.PAPERCUSP_WORKSPACE_ID || process.env.PAPERCUSP_WORKSPACE || "";',
    '  const expectedHarness = process.env.PAPERCUSP_TEST_RUN_HARNESS || process.env.HARNESS_SLUG || process.env.PAPERCUSP_HARNESS_SLUG || "";',
    '  if (!workspace || !harness || workspace !== expectedWorkspace || harness !== expectedHarness) {',
    '    process.stderr.write("mcp_auth_failed: harness_scope_stale: ptool requires explicit matching --workspace and --harness");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    // Mirror the real dispatch contract (WI-10002758): a projection must name
    // pick or pipe. The fake used to ignore --projection, so a probe sending
    // '{}' passed here while every real in-tree run was refused.
    '  if (projectionRaw !== undefined) {',
    '    let projection;',
    '    try { projection = JSON.parse(projectionRaw); } catch { projection = null; }',
    '    const valid = projection && typeof projection === "object" && (Array.isArray(projection.pick) && projection.pick.length > 0 || Array.isArray(projection.pipe) && projection.pipe.length > 0);',
    '    if (!valid) {',
    '      process.stderr.write("projection_invalid: projection needs a non-empty pick or pipe");',
    '      process.exitCode = 1;',
    '      return;',
    '    }',
    '  }',
    '  const loggedCalls = process.env.MUTATION_PROBE_LOCK_LOG ? fs.readFileSync(process.env.MUTATION_PROBE_LOCK_LOG, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line)) : [];',
    '  if (mode === "timeout-once" && tool === "coord:presence" && targetUrl !== "http://127.0.0.1:3170" && loggedCalls.filter((call) => call.tool === "coord:presence" && call.targetUrl !== "http://127.0.0.1:3170").length === 1) {',
    '    process.stderr.write("ptool: tools/call coord:presence failed: MCP error -32001: Request timed out; the tool call may have executed — verify its state before retrying. Do not blindly retry a mutation.");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  if (mode === "heartbeat-timeout-once" && tool === "locks:heartbeat" && targetUrl !== "http://127.0.0.1:3170" && loggedCalls.filter((call) => call.tool === "locks:heartbeat" && call.targetUrl !== "http://127.0.0.1:3170").length === 1) {',
    '    process.stderr.write("ptool: tools/call locks:heartbeat failed: MCP error -32001: Request timed out; the tool call may have executed — verify its state before retrying. Do not blindly retry a mutation.");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  if (mode === "auth-failure" && tool === "coord:presence") {',
    '    process.stderr.write("ptool: tools/call coord:presence failed: HTTP 401 authorization_denied");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  if (mode === "input-failure" && tool === "coord:presence") {',
    '    process.stderr.write("ptool: tools/call coord:presence failed: HTTP 400 InputValidationError");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    "  if (mode === 'heartbeat-refused' && tool === 'locks:heartbeat') {",
    '    process.stderr.write("lock_not_owned: fake heartbeat refusal for the stderr-surfacing case");',
    '    process.exitCode = 1;',
    '    return;',
    '  }',
    '  const expires = new Date(Date.now() + 3600000).toISOString();',
    "  if (tool === 'coord:presence') {",
    "    process.stdout.write(JSON.stringify({ self: { ownerId: 'probe-owner' } }));",
    "  } else if (tool === 'locks:queue') {",
    "    const active = mode === 'no-file' ? [] : [{ path: args.paths[0], owner: 'probe-owner', intent: 'mutation probe', lock_id: '33333333-3333-4333-8333-333333333333' }];",
    '    process.stdout.write(JSON.stringify({ active_locks: active }));',
    "  } else if (tool === 'locks:heartbeat') {",
    "    const extended = mode !== 'file-heartbeat-fails';",
    '    process.stdout.write(JSON.stringify({ results: [{ lock_id: args.lock_id, extended, ok: extended }] }));',
    "  } else if (tool === 'locks:list') {",
    "    const resourceExpires = mode === 'resource-short' ? new Date(Date.now() + 280000).toISOString() : expires;",
    "    const holders = mode === 'no-resource' ? [] : [{ resource: args.resource, owner: 'probe-owner', mode: 'exclusive', status: 'held', expires_ts: resourceExpires }];",
    '    process.stdout.write(JSON.stringify({ holders }));',
    "  } else if (tool === 'locks:heartbeat_resource') {",
    '    process.stdout.write(JSON.stringify({ results: [{ lock_id: args.lock_id, extended: true, ok: true }] }));',
    '  } else {',
    '    process.stderr.write("unexpected fake ptool request: " + tool);',
    '    process.exitCode = 2;',
    '  }',
    '});',
    '',
  ].join('\n'));
  chmodSync(fakePtool, 0o755);

  submoduleSource = mkdtempSync(join(tmpdir(), 'mutation-probe-submodule-'));
  git(submoduleSource, ['init', '-q']);
  git(submoduleSource, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(submoduleSource, ['config', 'user.name', 'mutation-probe-test']);
  writeFileSync(join(submoduleSource, 'subject.txt'), GOOD);
  git(submoduleSource, ['add', 'subject.txt']);
  git(submoduleSource, ['commit', '-qm', 'subject baseline']);
  git(scratch, ['config', 'user.email', 'mutation-probe-test@example.invalid']);
  git(scratch, ['config', 'user.name', 'mutation-probe-test']);
  git(scratch, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleSource, 'nested']);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (submoduleSource) rmSync(submoduleSource, { recursive: true, force: true });
});

describe('mutation-probe.sh --in-tree sweep-race gate', () => {
  it('REFUSES --in-tree from a capability:bash foreground child before touching the tracked file', () => {
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      {
        PAPERCUSP_CAPABILITY_BASH_FOREGROUND: '1',
        PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS: '50000',
      },
    );

    // The foreground handler kills the whole child tree at its deadline, so
    // this refusal must happen before the probe creates scratch state or
    // applies the deliberately-wrong tracked-file mutation.
    expect(status).toBe(2);
    expect(out).toContain('REFUSING --in-tree from capability:bash foreground execution');
    expect(out).toContain('captured timeout: 50000ms');
    expect(out).toContain('run_in_background: true');
    expect(out).not.toContain('mutant applied:');
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it("REFUSES --in-tree inside an outer probe's --fake-destructive guard, before any admission state (WI-10004181)", () => {
    // An outer --fake-destructive probe exports MUTATION_PROBE_DESTRUCTIVE_LOG and log-only
    // rm/unlink shims to everything its --test runs. An in-tree run under them cannot delete
    // its own admission manifest or scratch dir, and orphan recovery deletes with rm too, so
    // nothing inside the guard could clean up. The probe must refuse before it creates any state.
    const admissionDir = join(
      '/tmp',
      `papercusp-mutation-probe-${process.getuid?.() ?? 0}-${createHash('sha256').update(realpathSync(scratch)).digest('hex')}`,
    );
    const probeDirs = () => readdirSync(scratch).filter((name) => name.startsWith('mutation-probe.')).length;
    const before = probeDirs();
    const { status, out } = runProbe(
      ['--file', subject, '--mutate', 's/GOOD/BAD/', '--test', 'grep -q GOOD {}', '--in-tree', '--accept-sweep-race'],
      {
        MUTATION_PROBE_DESTRUCTIVE_LOG: join(scratch, 'outer-destructive-calls.log'),
        PAPERCUSP_CAPABILITY_BASH_FOREGROUND: '',
      },
    );

    expect(status).toBe(2);
    expect(out).toContain("REFUSING --in-tree inside another probe's --fake-destructive guard");
    expect(out).not.toContain('mutant applied:');
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=');
    expect(existsSync(join(admissionDir, 'original.manifest'))).toBe(false);
    expect(probeDirs()).toBe(before);
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('REFUSES --in-tree with no acknowledgement, and hands over the exact lock incantation', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
    ]);

    // Exit 2 is the script's documented "misuse / could not run soundly" code.
    expect(status).toBe(2);
    expect(out).toContain('SWEEP race');
    // The refusal must be ACTIONABLE: the repo-relative file path is resolved
    // from the repo it is standing in, not copied from a doc that can drift.
    expect(out).toContain("paths: ['subject.txt']");
    expect(out).toContain('locks:acquire');
    // EI-24712906810240170: the file lock alone is the fence; the refusal must not send
    // agents to take the fleet-wide git-sync lease, which froze every commit.
    expect(out).not.toContain('locks:acquire_resource');
    expect(out).toContain('re-checks locks after staging');
    expect(out).toContain("intent: 'mutation probe'");
    expect(out).toContain('locks:heartbeat');
    expect(out).toContain('locks:release');
    // Both escapes must be named, or the gate is a dead end rather than a fork.
    expect(out).toContain('--sweep-lock-held');
    expect(out).toContain('--accept-sweep-race');

    // A refusal must refuse: the file is untouched and no probe ran. Assert on
    // the RESULT LINE and the mutation log, not on the bare token
    // "MUTATION_PROBE_RESULT" — the refusal text names it while explaining that
    // an accepted race gets recorded there, so the token alone cannot tell a
    // refusal apart from a completed run.
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=');
    expect(out).not.toContain('mutant applied:');
  });

  // One --in-tree --sweep-lock-held probe runs the sweep fence TWICE: once before
  // the (possibly expensive) baseline, so a missing lock fails fast, and again
  // immediately before mutation, to refresh the lease and catch a lock that
  // changed while the baseline ran (scripts/mutation-probe.sh; WI-10005000).
  const SWEEP_FENCE_CALLS = ['coord:presence', 'locks:queue', 'locks:heartbeat'];

  it.each(['3070', '9071'])('retries a local :%s transport timeout once through staging :3170', (port) => {
    const primaryUrl = 'http://127.0.0.1:' + port;
    const endpointEnv: Record<string, string> = port === '9071'
      ? { PAPERCUSP_HONO_PORT: port }
      : { PAPERCUSP_OPERATOR_URL: primaryUrl };
    const { code, out } = runLockedProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      'timeout-once',
      endpointEnv,
    );

    expect(code).toBe(0);
    expect(out).toContain('recovered once through staging :3170');
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // Only the first fence check meets the injected timeout and recovers through
    // staging. The fallback is per call, so the second check returns to the primary.
    expect(calls.filter((call) => call.tool === 'coord:presence').map((call) => call.targetUrl))
      .toEqual([primaryUrl, 'http://127.0.0.1:3170', primaryUrl]);
  });

  it('retries a timeout through staging when TMPDIR is UNSET (WI-10004679)', () => {
    // The fallback branch used to read a bare "$TMPDIR" under `set -u`; every
    // other case here sets TMPDIR, so that crash ('TMPDIR: unbound variable')
    // only ever surfaced on a real agent shell, where the probe then refused
    // with "could not read this session's Papercusp owner identity".
    const { code, out } = runLockedProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      'timeout-once',
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070', TMPDIR: undefined },
    );

    expect(out).not.toContain('unbound variable');
    expect(code).toBe(0);
    expect(out).toContain('recovered once through staging :3170');
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('retries a same-lock heartbeat timeout through staging and verifies the extension', () => {
    const { code, out } = runLockedProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      'heartbeat-timeout-once',
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:3070' },
    );

    expect(code).toBe(0);
    expect(out).toContain('recovered once through staging :3170');
    expect(out).toContain("verified this session's live file lock");
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // The first fence check's heartbeat times out and recovers through staging; the
    // second check's heartbeat goes back to the primary (per-call fallback).
    expect(calls.filter((call) => call.tool === 'locks:heartbeat').map((call) => call.targetUrl))
      .toEqual(['http://127.0.0.1:3070', 'http://127.0.0.1:3170', 'http://127.0.0.1:3070']);
  });

  it('does not reroute authentication or input failures to staging', () => {
    for (const mode of ['auth-failure', 'input-failure'] as const) {
      const { code, out } = runLockedProbe(
        [
          '--file', subject,
          '--mutate', 's/GOOD/BAD/',
          '--test', 'grep -q GOOD {}',
          '--in-tree',
          '--sweep-lock-held',
        ],
        mode,
      );

      expect(code).toBe(2);
      expect(out).toContain('could not read this session');
      const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(calls).toHaveLength(1);
      expect(calls[0].targetUrl).toBe('http://127.0.0.1:3070');
    }
  });

  it('does not route a timeout from an explicitly pinned remote operator to local staging', () => {
    const { code, out } = runLockedProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--sweep-lock-held',
      ],
      'timeout-once',
      { PAPERCUSP_OPERATOR_URL: 'https://pinned.example' },
    );

    expect(code).toBe(2);
    expect(out).toContain('could not read this session');
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toHaveLength(1);
    expect(calls[0].targetUrl).toBe('https://pinned.example');
  });

  it('runs under --accept-sweep-race, records the accepted race, and restores the file', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--accept-sweep-race',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    // The acceptance is auditable in the machine-readable line, not just in a
    // log the operator may never read back.
    expect(out).toContain('target=in-tree:race-accepted');
    expect(out).toContain('tree integrity: VERIFIED');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('requires a live caller-owned lock with the probe intent before --sweep-lock-held mutates', () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ], 'no-file');

    expect(code).toBe(2);
    expect(out).toContain("no live file lock for 'subject.txt'");
    // ORDER, not just call count (EI-24673276803601762): the fence must refuse BEFORE the
    // (possibly expensive) baseline guard runs. Until 25489f80b8 the only fence call sat
    // after the baseline, so a missing lock cost a full baseline run before refusing.
    expect(out).not.toContain('running baseline guard');
    expect(out).not.toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('verifies and extends the caller-owned file lock before mutation', () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ]);

    expect(code).toBe(0);
    expect(out).toContain("verified this session's live file lock for subject.txt");
    expect(out).toContain('target=in-tree:lock-held');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    // No locks:list: the git-sync lease is not consulted unless opted in (EI-24712906810240170).
    // Both fence checks (pre-baseline and pre-mutation) must verify AND extend the lock.
    expect(calls.map((call) => call.tool)).toEqual([...SWEEP_FENCE_CALLS, ...SWEEP_FENCE_CALLS]);
    for (const offset of [0, SWEEP_FENCE_CALLS.length]) {
      expect(calls[offset + 1].args).toMatchObject({ paths: ['subject.txt'], coordination_domain: scratch });
      expect(calls[offset + 2].args).toMatchObject({ ttl_sec: 1200, coordination_domain: scratch });
    }
    // Every call must send a projection the real dispatch accepts (WI-10002758).
    for (const call of calls) {
      const projection = JSON.parse(call.projection);
      expect(Array.isArray(projection.pick) && projection.pick.length > 0, `${call.tool} projection ${call.projection}`).toBe(true);
    }
  });

  it('passes explicit workspace and harness scope to every sweep-fence ptool call', () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ]);

    expect(code).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    const calls = readFileSync(lockLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(calls.map((call) => call.tool)).toEqual([...SWEEP_FENCE_CALLS, ...SWEEP_FENCE_CALLS]);
    for (const call of calls) {
      expect(call.workspace, call.tool).toBe('probe-workspace');
      expect(call.harness, call.tool).toBe('probe-harness');
    }
  });

  // WI-10004155: a git-sync lease that IS held but ends before the window plus
  // its 120s margin used to refuse with the same text as "not held", which read
  // as operator error. It must name the seconds left and the seconds required.
  it('refuses a held-but-short git-sync lease with the remaining and required seconds', () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ], 'resource-short', { MUTATION_PROBE_REQUIRE_GIT_SYNC_LEASE: '1' });

    expect(code).toBe(2);
    expect(out).toMatch(/lock is held but expires in 2[67]\ds/);
    expect(out).toContain('needs at least 720s (MUTATION_PROBE_WINDOW_MAX_SEC=600 plus a 120s margin)');
    expect(out).toContain('locks:heartbeat_resource');
    expect(out).not.toContain('none is held by');
    expect(out).not.toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it("surfaces the tool's own refusal text when a lock call fails", () => {
    const { code, out } = runLockedProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ], 'heartbeat-refused');

    expect(code).toBe(2);
    // The refusal reason reaches the operator; it used to be discarded, leaving
    // only the generic "could not extend" line.
    expect(out).toContain('ptool locks:heartbeat failed (exit 1)');
    expect(out).toContain('lock_not_owned: fake heartbeat refusal');
    expect(out).toContain('could not extend the verified file lock');
    expect(out).not.toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  // EI-24712906810240170: git-sync re-checks file locks after staging, so the file lock
  // alone fences the sweep in the superproject AND a submodule. The fleet-wide lease is
  // required only when explicitly opted back in.
  it.each(['superproject', 'submodule'] as const)('needs only the file lock for a %s probe; the git-sync lease is opt-in', (kind) => {
    const nestedSubject = kind === 'submodule' ? join(scratch, 'nested', 'subject.txt') : subject;
    const probeArgs = [
      '--file', nestedSubject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--in-tree',
      '--sweep-lock-held',
    ];

    // Default: no lease held anywhere, and the probe still runs on the file lock alone.
    const fileLockOnly = runLockedProbe(probeArgs, 'no-resource');
    expect(fileLockOnly.code).toBe(0);
    expect(fileLockOnly.out).not.toContain("must hold an exclusive 'git-sync:probe-harness' lock");
    expect(readFileSync(lockLog, 'utf8')).not.toContain('locks:list');
    expect(readFileSync(nestedSubject, 'utf8')).toBe(GOOD);

    // Opted in: the old double fence still refuses without the lease...
    const refused = runLockedProbe(probeArgs, 'no-resource', { MUTATION_PROBE_REQUIRE_GIT_SYNC_LEASE: '1' });
    expect(refused.code).toBe(2);
    expect(refused.out).toContain("must hold an exclusive 'git-sync:probe-harness' lock");
    expect(refused.out).toContain('none is held by probe-owner');
    expect(refused.out).not.toContain('mutant applied:');
    expect(readFileSync(nestedSubject, 'utf8')).toBe(GOOD);

    // ...and accepts with it.
    const withLease = runLockedProbe(probeArgs, 'all', { MUTATION_PROBE_REQUIRE_GIT_SYNC_LEASE: '1' });
    expect(withLease.code).toBe(0);
    expect(withLease.out).toContain("verified this session's exclusive git-sync:probe-harness lock");
    expect(readFileSync(nestedSubject, 'utf8')).toBe(GOOD);
  });

  it('leaves copy-out mode ungated and never dirties the tracked file', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('target=copy-out');
    expect(out).not.toContain('SWEEP race');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('pins its own descriptor reader, so an ambient operator route cannot fail a case (WI-6554700010018610)', () => {
    // Recurrence guard for HERMETIC_PROBE_ENV. Port 1 is a reader that
    // can never answer. Without the pin, this route makes the probe infer
    // READER_REQUIRED=1 and die at the descriptor preflight, exactly as the
    // live :3070 did. The other route variables are blanked so an ambient
    // gate-host PAPERCUSP_HONO_PORT cannot win the selection instead. The
    // reader override and requirement are cleared here as well (the pin
    // clears them too). MEASURED: when an outer mutation probe exported
    // READER_HEALTH_URL, the inherited override let the unpinned mutant pass
    // (verdict=survived, test_runs:21490908).
    const { status, out } = runProbe(
      ['--file', subject, '--mutate', 's/GOOD/BAD/', '--test', 'grep -q GOOD {}'],
      {
        PAPERCUSP_OPERATOR_BASE: '',
        PAPERCUSP_HONO_PORT: '',
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL: undefined,
        PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED: undefined,
      },
    );

    expect(out).not.toContain('reader preflight failed');
    expect(out).not.toContain('reason=reader-unavailable');
    expect(status).toBe(0);
    expect(out).toContain('target=copy-out');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it("strips only test:file's committed-source loader from the probe children's NODE_OPTIONS", () => {
    // The two .mjs unparseable-mutant cases depend on this under test:file;
    // under test:affected NODE_OPTIONS carries no loader, so pin the helper directly.
    expect(withoutCommittedSourceLoader('--import=/r/scripts/lib/committed-source-loader.mjs --max-old-space-size=4096'))
      .toBe('--max-old-space-size=4096');
    expect(withoutCommittedSourceLoader('--import /r/scripts/lib/committed-source-loader.mjs --enable-source-maps'))
      .toBe('--enable-source-maps');
    expect(withoutCommittedSourceLoader('--import=/r/scripts/lib/committed-source-loader.mjs')).toBeUndefined();
    expect(withoutCommittedSourceLoader('--import=tsx --max-old-space-size=4096')).toBe('--import=tsx --max-old-space-size=4096');
    expect(withoutCommittedSourceLoader(undefined)).toBeUndefined();
  });

  it('rejects a sweep acknowledgement passed WITHOUT --in-tree', () => {
    // A stray ack means the caller believes they are mutating the tree when
    // they are not — accepting it silently teaches a wrong mental model.
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
      '--sweep-lock-held',
    ]);

    expect(status).toBe(2);
    expect(out).toContain('only mean something with --in-tree');
  });
});

/**
 * `scripts/mutation-probe.sh` — the unparseable-mutant gate (EI-21430792829614962).
 *
 * The probe decided its verdict purely from the guard's exit code, so a
 * mutation that corrupted the subject's SYNTAX produced a confident
 * "MUTANT CAUGHT ... the guard is falsifiable" about assertions that were
 * never exercised — the guard failed only because the subject had stopped
 * being a loadable program. That is the same false-verdict class as the
 * pre-existing no-op refusal, inverted: a no-op mutation makes a guard look
 * WEAK, an unparseable one makes it look STRONG.
 *
 * It is the more dangerous half, because a probe's whole job is to certify
 * that a test suite can be trusted. A false "weak" verdict provokes
 * investigation; a false "strong" verdict ends it.
 *
 * Both directions are asserted throughout: a broken mutant must be REFUSED,
 * and a valid semantic mutant on the same subject must still reach a normal
 * verdict. Asserting only the refusal would pass equally against a script
 * that had started refusing everything.
 */
describe('mutation-probe.sh assertion-evidence gate', () => {
  const cargoPass = 'running 1 test\ntest guard ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n';
  const cargoFail = 'running 1 test\ntest guard ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\nerror: test failed, to rerun pass --lib\n';
  function cargoGuard(failure: string, exitCode = 101) {
    // JSON string literals here are arguments to node, never shell payloads.
    return `test -f "{}" && node -e 'process.stdout.write(process.env.PAPERCUSP_MUTATION_PHASE === "mutant" ? ${JSON.stringify(failure)} : ${JSON.stringify(cargoPass)}); process.exit(process.env.PAPERCUSP_MUTATION_PHASE === "mutant" ? ${exitCode} : 0)'`;
  }

  it('credits Cargo exit 101 only after named tests execute and fail', () => {
    const { status, out } = runProbe([
      '--file', subject, '--mutate', 's/GOOD/BAD/', '--test', cargoGuard(cargoFail),
    ]);
    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('guard_exit=101');
    expect(out).toContain('assertion_evidence=cargo-libtest-failed-tests');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it.each([
    ['compilation', 'error[E0308]: mismatched types\nerror: could not compile guard (lib test) due to 1 previous error\n'],
    ['setup', 'error: failed to run custom build command for guard\n'],
    ['empty selection', 'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n'],
    ['ignored tests', 'running 1 test\ntest guard ... ignored\ntest result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'],
    ['missing named failure', 'running 1 test\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'],
    ['different test binary', 'running 1 test\ntest guard ... FAILED\nrunning 0 tests\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'],
    ['later compile error', cargoFail + 'error: could not compile another crate\n'],
    ['unrecognized runner', 'guard command failed\n'],
    ['other runner evidence', 'Tests 1 failed (1)\n'],
  ])('refuses Cargo-style exit 101 from %s', (_label, failure) => {
    const { status, out } = runProbe([
      '--file', subject, '--mutate', 's/GOOD/BAD/', '--test', cargoGuard(failure),
    ]);
    expect(status).toBe(2);
    expect(out).toMatch(/MUTATION_PROBE_RESULT verdict=(harness-error|inconclusive)/);
    expect(out).toContain('guard_exit=101');
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('does not credit executed Cargo failures under an unrelated exit status', () => {
    const { status, out } = runProbe([
      '--file', subject, '--mutate', 's/GOOD/BAD/', '--test', cargoGuard(cargoFail, 2),
    ]);
    expect(status).toBe(2);
    expect(out).toContain('verdict=harness-error');
  });

  it('refuses a green Cargo baseline that selected no tests', () => {
    const { status, out } = runProbe([
      '--file', subject, '--mutate', 's/GOOD/BAD/',
      '--test', 'test -f "{}" && printf "running 0 tests\\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\\n"',
    ]);
    expect(status).toBe(2);
    expect(out).toContain('zero_selection=cargo-libtest-zero-passed');
    expect(out).not.toContain('mutant applied:');
  });

  it('accepts a Cargo baseline with empty binaries alongside a passing selected test', () => {
    const guard = cargoGuard(cargoFail) + '; rc=$?; printf "running 0 tests\\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\\n"; exit "$rc"';
    const { status, out } = runProbe([
      '--file', subject, '--mutate', 's/GOOD/BAD/', '--test', guard,
    ]);
    expect(status).toBe(0);
    expect(out).toContain('assertion_evidence=cargo-libtest-failed-tests');
  });

  function historicalCargoProbe(failure: string, emptyBaseline = false) {
    // Build a before-fix object in the suite's throwaway repo; no shared-tree
    // index, branch, commit or source is changed by this historical fixture.
    const snapshotRoot = mkdtempSync(join(scratch, 'cargo-history-'));
    git(snapshotRoot, ['init', '-q']);
    const snapshotName = 'cargo-history.txt';
    const snapshot = join(snapshotRoot, snapshotName);
    writeFileSync(snapshot, 'value = BAD\n');
    const blob = git(snapshotRoot, ['hash-object', '-w', snapshot]);
    const tree = spawnSync('git', ['mktree'], {
      cwd: snapshotRoot, encoding: 'utf8', input: `100644 blob ${blob}\t${snapshotName}\n`,
    });
    expect(tree.status, tree.stderr).toBe(0);
    const commit = spawnSync('git', ['-c', 'user.name=Probe fixture', '-c', 'user.email=probe@example.invalid', 'commit-tree', tree.stdout.trim()], {
      cwd: snapshotRoot, encoding: 'utf8', input: 'Historical Cargo fixture\n',
    });
    expect(commit.status, commit.stderr).toBe(0);
    git(snapshotRoot, ['update-ref', 'HEAD', commit.stdout.trim()]);
    // Historical mode requires a committed source at HEAD. Check the fixture
    // precondition before invoking the script, rather than accepting admission
    // refusals as evidence about the Cargo classifier.
    expect(git(snapshotRoot, ['show', `HEAD:${snapshotName}`])).toBe('value = BAD');
    writeFileSync(snapshot, GOOD);
    const pass = emptyBaseline ? 'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n' : cargoPass;
    const guard = `node -e 'const bad=require("node:fs").readFileSync(process.argv[1],"utf8").includes("BAD"); process.stdout.write(bad ? ${JSON.stringify(failure)} : ${JSON.stringify(pass)}); process.exit(bad ? 101 : 0)' "{}"`;
    return runProbe([
      '--file', snapshot, '--against-commit', commit.stdout.trim(),
      '--must-be-absent', 'GOOD', '--positive-control', 'value =',
      '--calibration', 'grep -q "value =" "{}"', '--test', guard,
    ]);
  }

  it('credits an executed Cargo exit-101 failure in historical mode', () => {
    const { status, out } = historicalCargoProbe(cargoFail);
    expect(status, out).toBe(0);
    expect(out).toContain('mode=historical verdict=caught');
    expect(out).toContain('historical_exit=101');
    expect(out).toContain('assertion_evidence=cargo-libtest-failed-tests');
  });

  it('refuses a Cargo compilation failure in historical mode', () => {
    const { status, out } = historicalCargoProbe('error: could not compile guard\n');
    expect(status, out).toBe(2);
    expect(out).toContain('mode=historical verdict=harness-error');
    expect(out).toContain('historical_exit=101');
  });

  it('refuses historical scoring when the current Cargo snapshot selected no tests', () => {
    const { status, out } = historicalCargoProbe(cargoFail, true);
    expect(status, out).toBe(2);
    expect(out).toContain('mode=historical verdict=harness-error');
    expect(out).toContain('zero_selection=cargo-libtest-zero-passed');
    expect(out).toContain('historical_exit=-1');
  });

  const setupFailure = [
    // The reporter count below includes the failed setup hook, though no assertion ran.
    'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then printf "FAIL setup hook: Hook timed out in 120000ms\\n"; printf "Tests 2 skipped (2)\\n"; printf "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed skippedTests=2\\n"; else printf "Tests 1 passed (1)\\n"; printf "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed skippedTests=0\\n"; fi',
    'test -f "{}" && [ "$PAPERCUSP_MUTATION_PHASE" != mutant ]',
  ].join('; ');

  it('does not report a setup-hook timeout with skipped tests as caught', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', setupFailure,
    ]);

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=inconclusive');
    expect(out).toContain('assertion_evidence=no-assertion-failure-evidence');
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('still reports a Papercusp test:file assertion failure as caught', () => {
    const assertionFailure = [
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then printf "TEST_FILE_ASSERTION_FAILURE file=\\\"guard.test.ts\\\" name=\\\"guard rejects mutation\\\" message=\\\"expected failure\\\"\\n"; printf "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed skippedTests=0\\n"; else printf "Tests 1 passed (1)\\n"; printf "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed skippedTests=0\\n"; fi',
      'test -f "{}" && [ "$PAPERCUSP_MUTATION_PHASE" != mutant ]',
    ].join('; ');
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', assertionFailure,
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('assertion_evidence=test-file-assertion-failure');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('still recognizes a direct Vitest failed-test summary', () => {
    const vitestFailure = [
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then printf "Tests 1 failed (1)\\n"; else printf "Tests 1 passed (1)\\n"; fi',
      'test -f "{}" && [ "$PAPERCUSP_MUTATION_PHASE" != mutant ]',
    ].join('; ');
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', vitestFailure,
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('assertion_evidence=vitest-failed-tests');
  });

  // WI-10004584: a suite that dies at IMPORT (e.g. a peer's mid-edit in a live-tree
  // dependency) prints `Tests  no tests` under a Failed Suites block. That is a
  // recognized Vitest run with ZERO assertions executed, never a caught mutant.
  it('does not report a Vitest collection failure ("Tests  no tests") as caught', () => {
    const collectionFailure = [
      'if [ "$PAPERCUSP_MUTATION_PHASE" = mutant ]; then printf " FAIL  guard.test.ts [ guard.test.ts ]\\nReferenceError: X is not defined\\n Test Files  1 failed (1)\\n      Tests  no tests\\n"; else printf "Tests 1 passed (1)\\n"; fi',
      'test -f "{}" && [ "$PAPERCUSP_MUTATION_PHASE" != mutant ]',
    ].join('; ');
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', collectionFailure,
    ]);

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=inconclusive');
    expect(out).toContain('assertion_evidence=vitest-no-tests-collected');
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });
});

describe('mutation-probe.sh unparseable-mutant gate', () => {
  it('REFUSES a mutant that no longer parses, instead of scoring it as caught', () => {
    // The exact shape from the field report: the pattern matches the function
    // DECLARATION as well as the call site, producing `function false {`.
    const { status, out } = runProbe([
      '--file', mjsSubject,
      '--mutate', 's/isTunnelForward\\(addrs, port\\)/false/',
      '--test', 'node {}',
    ]);

    // Exit 2 is the documented "misuse / could not be run soundly" code. It is
    // emphatically NOT 0: pre-fix this same invocation exited 0 with
    // verdict=caught, which is the bug.
    expect(status).toBe(2);
    expect(out).toContain('not a valid program');
    expect(out).toContain('mutant_parse=broken');

    // A refusal must refuse — no falsifiability verdict may be emitted.
    expect(out).not.toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).not.toContain('the guard is falsifiable');

    // And it must be ACTIONABLE: the fix is to anchor the pattern on text the
    // declaration cannot match, so the refusal hands over that exact pattern.
    expect(out).toContain('MORE THAN THE INTENDED SITE');
    expect(out).toContain('if \\(isTunnelForward');

    // The subject is restored regardless of which exit path was taken.
    expect(readFileSync(mjsSubject, 'utf8')).toBe(MJS_SUBJECT);
  });

  it('still scores a VALID semantic mutation on the same subject, stamped mutant_parse=ok', () => {
    // Calibration for the case above: same file, same guard, a mutation that
    // is correctly anchored. Without this, the refusal proves nothing — a
    // script that refused every mutation would pass the previous test.
    const { status, out } = runProbe([
      '--file', mjsSubject,
      '--mutate', 's/if \\(isTunnelForward/if (false \\&\\& isTunnelForward/',
      '--test', 'node {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('mutant_parse=ok');
    expect(readFileSync(mjsSubject, 'utf8')).toBe(MJS_SUBJECT);
  });

  it('REFUSES an unparseable shell mutant too (the bash -n path)', () => {
    // Shell subjects are the script's other common case, and a dropped `fi`
    // is the way a shell mutation most often stops being a program.
    const { status, out } = runProbe([
      '--file', shSubject,
      '--mutate', 's/^fi$//',
      '--test', 'bash {}',
    ]);

    expect(status).toBe(2);
    expect(out).toContain('not a valid program');
    expect(out).toContain('mutant_parse=broken');
    expect(readFileSync(shSubject, 'utf8')).toBe(SH_SUBJECT);
  });

  it('still scores a VALID shell mutation, stamped mutant_parse=ok', () => {
    const { status, out } = runProbe([
      '--file', shSubject,
      '--mutate', 's/exit 0/exit 1/',
      '--test', 'bash {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('mutant_parse=ok');
    expect(readFileSync(shSubject, 'utf8')).toBe(SH_SUBJECT);
  });

  it('degrades LOUDLY on a subject it cannot syntax-check, rather than implying it did', () => {
    // subject.txt has no checker. The run must still work — the gate may only
    // ever refuse on POSITIVE proof of breakage — but the result line has to
    // carry its own caveat, or an unchecked caught verdict reads identically
    // to a verified one.
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', 'grep -q GOOD {}',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).toContain('mutant_parse=unchecked');
    expect(out).not.toContain('mutant_parse=ok');
  });
});

/**
 * EI-23809205858633494 — the DIRTY-WINDOW ceiling.
 *
 * `--in-tree` holds the TRACKED file mutated for exactly as long as the guard
 * child runs, so time spent in that child that is not MEASUREMENT is pure
 * sweep-race risk. The documented `--test` command (`npm run test:file`) is
 * pc-heavy-wrapped, and pc-heavy is a host-wide counting semaphore that WAITS
 * for other agents' heavy runs to drain: measured 2026-09-20, it sat in that
 * queue 6+ minutes without starting a single test while a mutated
 * operator-core file sat in the shared tree (~25s through the direct router).
 * The window had inherited an unbounded wait from a queue that has nothing to
 * do with the probe.
 *
 * Two halves, each asserted below in both directions:
 *   - in-tree guard children export PC_HEAVY_BYPASS=1 (copy-out does NOT —
 *     it has no window, so it stays a well-behaved queued citizen);
 *   - the in-tree guard runs under a wall-clock ceiling, and tripping it is a
 *     harness-error, never a verdict.
 */
describe('mutation-probe.sh orphaned-snapshot recovery (EI-24673390474513566)', () => {
  // SIGKILL is the one signal the probe's EXIT/TERM/INT traps cannot answer, so it
  // is the faithful model of "the probe died mid-mutant": the subject stays
  // mutated and the admission manifest stays behind. The NEXT probe in the same
  // checkout must find the dead owner, restore the subject from the snapshot,
  // and then run normally — not refuse forever, and not test the mutant.
  it('restores a subject left mutated by a SIGKILLed in-tree probe, then runs normally', async () => {
    const marker = join(scratch, 'orphan-mutant-phase-reached');
    rmSync(marker, { force: true });
    const child = spawn(
      'bash',
      [
        PROBE,
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', `grep -q GOOD {} || { touch '${marker}'; sleep 30; }`,
        '--in-tree',
        '--accept-sweep-race',
      ],
      { cwd: scratch, detached: true, stdio: 'ignore', env: probeEnv() },
    );
    const exited = new Promise((done) => child.once('exit', done));
    try {
      const deadline = Date.now() + 45_000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error('probe never reached its mutant phase');
        await new Promise((tick) => setTimeout(tick, 100));
      }
      // The mutant is on disk and the probe is alive inside its guard.
      expect(readFileSync(subject, 'utf8')).not.toBe(GOOD);
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
      // No trap ran, so nothing restored it: this is the orphaned state.
      expect(readFileSync(subject, 'utf8')).not.toBe(GOOD);

      const { status, out } = runProbe([
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--accept-sweep-race',
      ]);

      expect(out).toContain('restoring subject from orphaned original snapshot');
      expect(out).not.toContain('active snapshot');
      expect(out).not.toContain('invalid snapshot manifest');
      // A verdict here proves the baseline ran on the RESTORED bytes: had the
      // subject still been mutated, `grep -q GOOD` would fail the baseline.
      expect(status).toBe(0);
      expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
      expect(readFileSync(subject, 'utf8')).toBe(GOOD);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      writeFileSync(subject, GOOD);
    }
  }, 120_000);
});

describe('mutation-probe.sh in-tree dirty-window ceiling', () => {
  // Echoes the inherited value so the assertion reads the CHILD's environment
  // rather than this test process's, then behaves like the ordinary subject
  // guard so the surrounding verdict logic is exercised unchanged.
  const REPORT_BYPASS = 'echo "BYPASS=[${PC_HEAVY_BYPASS:-unset}]"; grep -q GOOD {}';

  it('exports PC_HEAVY_BYPASS=1 into in-tree guard children, so the window cannot inherit an admission queue', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', REPORT_BYPASS,
      '--in-tree',
      '--accept-sweep-race',
    ]);

    expect(status).toBe(0);
    expect(out).toContain('BYPASS=[1]');
    expect(out).not.toContain('BYPASS=[unset]');
    // The bypass must not disturb the thing the probe exists to produce, and
    // the default 600s ceiling must not fire on an ordinary fast guard.
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).not.toContain('window_exceeded_sec=');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('leaves COPY-OUT mode queueing normally — no window means no reason to skip admission', () => {
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', REPORT_BYPASS,
    ]);

    expect(status).toBe(0);
    expect(out).toContain('BYPASS=[unset]');
    expect(out).not.toContain('BYPASS=[1]');
    expect(out).toContain('target=copy-out');
  });

  it('applies the bypass to the BASELINE too, so both phases share one invocation path', () => {
    // The baseline runs before the mutation. If only the mutant child were
    // bypassed, the verdict would compare two differently-scheduled runs — so
    // assert the marker appears for BOTH phases, not just once.
    const { status, out } = runProbe([
      '--file', subject,
      '--mutate', 's/GOOD/BAD/',
      '--test', REPORT_BYPASS,
      '--in-tree',
      '--accept-sweep-race',
    ]);

    expect(status).toBe(0);
    expect(out.match(/BYPASS=\[1\]/g) ?? []).toHaveLength(2);
  });

  it('kills a hung BASELINE at the ceiling — before anything is mutated — and reports no verdict', () => {
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'sleep 60',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: '2' },
    );

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=harness-error');
    expect(out).toContain('window_exceeded_sec=');
    expect(out).toContain('phase=baseline');
    expect(out).toContain('DIRTY-WINDOW ceiling');
    // This phase is where the diagnosis earns its keep. Without it the run
    // reports `BASELINE FAILED (guard exited 124) — refusing to score the
    // mutant`, which accuses the caller's guard of failing on the UNMUTATED
    // file when in fact the probe killed it — a wrong answer, not a vague one.
    expect(out).not.toContain('BASELINE FAILED');
    // Tripping in the baseline phase is the BEST outcome available: the tree
    // was never dirtied at all.
    expect(out).not.toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('refuses to score a KILLED mutant run as a verdict, and restores the file', () => {
    // The mutant path here would exit 0 if allowed to finish — the honest
    // verdict is SURVIVED — and `timeout` kills it at rc=124 instead.
    //
    // ⚠ MEASURED, against an earlier draft of this comment: rc=124 does NOT
    // become `caught`. The verdict ladder scores `caught` on TEST_RC -eq 1
    // ALONE and sends every other nonzero status to `harness-error`, so the
    // killed run was already refused a verdict before this block existed.
    // (A mutation probe that disabled the detection below printed exactly
    // that: `verdict=harness-error ... guard_exit=124`.) What this block adds
    // is the DIAGNOSIS — which phase, how long, and what to do — on top of a
    // bare "guard exited 124". The assertions therefore pin the diagnosis,
    // and keep the no-verdict property from silently regressing into one.
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {} || { sleep 60; exit 0; }',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: '2' },
    );

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=harness-error');
    expect(out).toContain('phase=mutant');
    expect(out).not.toContain('verdict=caught');
    expect(out).not.toContain('verdict=survived');
    // The baseline DID run here, so the mutation really was applied — which
    // makes the restore the load-bearing half of this case.
    expect(out).toContain('mutant applied:');
    expect(readFileSync(subject, 'utf8')).toBe(GOOD);
  });

  it('honours MUTATION_PROBE_WINDOW_MAX_SEC=0 as an explicit opt-out rather than a 0-second ceiling', () => {
    // A numeric-looking 0 must not be read as "kill immediately" — that would
    // turn the opt-out into the harshest possible setting.
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'sleep 2; grep -q GOOD {}',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: '0' },
    );

    expect(status).toBe(0);
    expect(out).toContain('MUTATION_PROBE_RESULT verdict=caught');
    expect(out).not.toContain('window_exceeded_sec=');
  });

  it('refuses a non-numeric ceiling instead of silently falling back to unbounded', () => {
    const { status, out } = runProbe(
      [
        '--file', subject,
        '--mutate', 's/GOOD/BAD/',
        '--test', 'grep -q GOOD {}',
        '--in-tree',
        '--accept-sweep-race',
      ],
      { MUTATION_PROBE_WINDOW_MAX_SEC: 'abc' },
    );

    expect(status).toBe(2);
    expect(out).toContain('MUTATION_PROBE_WINDOW_MAX_SEC must be a whole number');
    expect(out).not.toContain('mutant applied:');
  });
});
